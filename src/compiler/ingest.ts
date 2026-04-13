import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import matter from "gray-matter";
import type { KnowledgeStore } from "../graph/store.js";
import type {
  LLMAdapter,
  Source,
  SourceType,
  QualityTier,
  KnowledgeDiff,
  QuickyConfig,
} from "../types.js";
import { scoreConfidence } from "./confidence.js";
import { computeKnowledgeDiff } from "./diff.js";
import { resolveKnowledge } from "./resolve.js";
import { parseLLMJson } from "../llm/parse-json.js";

export type IngestProgress = (step: string, detail?: string) => void;

export type IngestSourceOptions = {
  type?: SourceType;
  qualityTier?: QualityTier;
  onProgress?: IngestProgress;
  /** Project config: kind rules, entity extraction prompts */
  config?: QuickyConfig;
  /** Force page kind (e.g. MCP override) */
  kind?: string;
  /** Merge into page metadata_json (e.g. MCP override) */
  metadata?: Record<string, unknown>;
};

/**
 * First matching kindRules entry wins. Rules use path substring match, or
 * `type:value` matched against frontmatter `type`. If no rule matches but
 * `frontmatter.type` is set, that string becomes the kind. Default: `topic`.
 */
export function inferPageKind(
  filePath: string,
  frontmatter: Record<string, unknown>,
  kindRules?: Array<{ pattern: string; kind: string }>,
): string {
  const rules = kindRules ?? [];
  const pathNorm = filePath.replace(/\\/g, "/");
  const fmType = frontmatter.type;

  for (const { pattern, kind } of rules) {
    if (pattern.startsWith("type:")) {
      const want = pattern.slice(5);
      if (fmType != null && String(fmType) === want) return kind;
    } else if (pathNorm.includes(pattern)) {
      return kind;
    }
  }

  if (fmType != null && String(fmType).length > 0) {
    return String(fmType);
  }
  return "topic";
}

function titleToWikiPath(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") + ".md"
  );
}

function cloneMetadata(
  frontmatter: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(frontmatter)) as Record<
    string,
    unknown
  >;
  return { ...base, ...(override ?? {}) };
}

/** Ensure the primary wiki page for this source has kind + metadata (frontmatter authoritative). */
function syncPrimaryPageEntity(
  store: KnowledgeStore,
  pageTitle: string,
  kind: string,
  metadata: Record<string, unknown>,
): void {
  let page = store.getPageByTitle(pageTitle);
  if (!page) {
    const path = titleToWikiPath(pageTitle);
    try {
      store.addPage(pageTitle, path, "", kind, metadata);
    } catch {
      const byPath = store.listPages().find((p) => p.path === path);
      if (byPath) {
        store.updatePageKind(byPath.id, kind);
        store.updatePageMetadata(byPath.id, metadata);
      } else {
        store.addPage(
          pageTitle,
          path.replace(".md", `-${Date.now()}.md`),
          "",
          kind,
          metadata,
        );
      }
    }
    return;
  }
  store.updatePageKind(page.id, kind);
  store.updatePageMetadata(page.id, metadata);
}

export async function ingestSource(
  store: KnowledgeStore,
  llm: LLMAdapter,
  filePath: string,
  opts?: IngestSourceOptions,
): Promise<KnowledgeDiff> {
  const progress = opts?.onProgress ?? (() => {});
  const raw = await readFile(filePath, "utf-8");
  const contentHash = createHash("sha256").update(raw).digest("hex");

  const ext = extname(filePath).toLowerCase();
  let content = raw;
  let frontmatter: Record<string, unknown> = {};
  if (ext === ".md" || ext === ".mdx") {
    const parsed = matter(raw);
    content = parsed.content;
    frontmatter = parsed.data;
  }

  const title =
    (frontmatter.title as string) || basename(filePath, extname(filePath));

  const resolvedKind =
    opts?.kind ??
    inferPageKind(filePath, frontmatter, opts?.config?.kindRules);
  const pageMetadata = cloneMetadata(frontmatter, opts?.metadata);

  const existing = store.getSourceByPath(filePath);
  if (existing && existing.contentHash === contentHash) {
    syncPrimaryPageEntity(store, title, resolvedKind, pageMetadata);
    return {
      sourceId: existing.id,
      sourceTitle: existing.title,
      reinforced: [],
      challenged: [],
      newConcepts: [],
      newClaims: [],
      gapsIdentified: [],
    };
  }

  const type = opts?.type || inferSourceType(filePath, frontmatter);
  const qualityTier = opts?.qualityTier || inferQuality(frontmatter);

  let source: Source;
  if (existing) {
    store.updateSourceHash(existing.id, contentHash);
    source = { ...existing, contentHash };
  } else {
    source = store.addSource({
      path: filePath,
      title,
      type,
      qualityTier,
      contentHash,
      ingestedAt: new Date().toISOString(),
      metadata: frontmatter,
    });
  }

  const extractCtx = {
    pageKind: resolvedKind,
    entityPrompts: opts?.config?.entityPrompts,
  };

  progress("extracting", `Extracting claims from "${title}"...`);
  const extractedClaims = await extractClaims(
    llm,
    content,
    title,
    source,
    extractCtx,
  );
  progress("extracted", `Found ${extractedClaims.length} claims`);

  progress("diffing", `Comparing against existing knowledge...`);
  const diff = await computeKnowledgeDiff(store, llm, source, extractedClaims);
  progress(
    "diffed",
    `${diff.newClaims.length} new, ${diff.reinforced.length} reinforced, ${diff.challenged.length} challenged`,
  );

  progress("resolving", `Resolving knowledge graph...`);
  await resolveKnowledge(store, llm, diff, source);
  progress("done", `Ingestion complete`);

  syncPrimaryPageEntity(store, title, resolvedKind, pageMetadata);

  return diff;
}

interface ExtractedClaim {
  statement: string;
  confidence: number;
  tags: string[];
  relatedConcepts: string[];
  dependsOnStatements: string[];
}

async function extractClaims(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: { pageKind: string; entityPrompts?: Record<string, string> },
): Promise<ExtractedClaim[]> {
  if (content.length > 12000) {
    return extractClaimsChunked(llm, content, title, source, ctx);
  }
  return extractClaimsSingle(llm, content, title, source, ctx);
}

async function extractClaimsChunked(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: { pageKind: string; entityPrompts?: Record<string, string> },
): Promise<ExtractedClaim[]> {
  const chunkSize = 8000;
  const overlap = 500;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize - overlap) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  const allClaims: ExtractedClaim[] = [];
  for (const chunk of chunks) {
    const claims = await extractClaimsSingle(llm, chunk, title, source, ctx);
    allClaims.push(...claims);
  }

  const seen = new Set<string>();
  return allClaims.filter((c) => {
    const key = c.statement
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractClaimsSingle(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: { pageKind: string; entityPrompts?: Record<string, string> },
): Promise<ExtractedClaim[]> {
  const entityExtra = ctx.entityPrompts?.[ctx.pageKind]?.trim();
  const extra = entityExtra
    ? `\n\nAdditional instructions for this entity kind (${ctx.pageKind}):\n${entityExtra}`
    : "";

  const systemPrompt = `You extract atomic, verifiable claims from source material.
Each claim should be a single factual statement. Be precise and specific.
Assign an initial confidence based on how well-supported the claim is by the source.
Tag each claim with relevant topic tags.
Identify related concepts (potential wiki page titles) for cross-linking.
If a claim logically depends on another claim you're extracting, note the dependency.${extra}

Respond in JSON format:
{
  "claims": [
    {
      "statement": "Precise factual claim",
      "confidence": 0.85,
      "tags": ["topic1", "topic2"],
      "relatedConcepts": ["Concept A", "Concept B"],
      "dependsOnStatements": []
    }
  ]
}`;

  const response = await llm.chat(
    [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: `Source: "${title}" (type: ${source.type}, quality: ${source.qualityTier})\n\n${content}`,
      },
    ],
    { temperature: 0.2, maxTokens: 8192 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    return (parsed.claims ?? []).map((c: any) => ({
      statement: c.statement,
      confidence: scoreConfidence(c.confidence, source.qualityTier),
      tags: c.tags ?? [],
      relatedConcepts: c.relatedConcepts ?? [],
      dependsOnStatements: c.dependsOnStatements ?? [],
    }));
  } catch (err) {
    console.error(
      `[extractClaims] JSON parse failed: ${err}`,
      response.content.slice(0, 300),
    );
    return [];
  }
}

function inferSourceType(
  filePath: string,
  frontmatter: Record<string, unknown>,
): SourceType {
  if (frontmatter.type) return frontmatter.type as SourceType;
  const ext = extname(filePath).toLowerCase();
  if ([".pdf"].includes(ext)) return "paper";
  if ([".md", ".mdx", ".txt"].includes(ext)) return "note";
  return "other";
}

function inferQuality(frontmatter: Record<string, unknown>): QualityTier {
  if (frontmatter.quality) return frontmatter.quality as QualityTier;
  if (frontmatter.doi || frontmatter.arxiv) return "peer-reviewed";
  if (frontmatter.publisher) return "book";
  return "unknown";
}
