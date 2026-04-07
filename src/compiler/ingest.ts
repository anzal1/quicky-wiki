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
} from "../types.js";
import { scoreConfidence } from "./confidence.js";
import { computeKnowledgeDiff } from "./diff.js";
import { resolveKnowledge } from "./resolve.js";
import { parseLLMJson } from "../llm/parse-json.js";

export type IngestProgress = (step: string, detail?: string) => void;

export async function ingestSource(
  store: KnowledgeStore,
  llm: LLMAdapter,
  filePath: string,
  opts?: {
    type?: SourceType;
    qualityTier?: QualityTier;
    onProgress?: IngestProgress;
  },
): Promise<KnowledgeDiff> {
  const progress = opts?.onProgress ?? (() => {});
  const raw = await readFile(filePath, "utf-8");
  const contentHash = createHash("sha256").update(raw).digest("hex");

  // Check if already ingested with same hash
  const existing = store.getSourceByPath(filePath);
  if (existing && existing.contentHash === contentHash) {
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

  // Parse content — support markdown with YAML frontmatter
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
  const type = opts?.type || inferSourceType(filePath, frontmatter);
  const qualityTier = opts?.qualityTier || inferQuality(frontmatter);

  // Upsert source
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

  // Extract claims via LLM
  progress("extracting", `Extracting claims from "${title}"...`);
  const extractedClaims = await extractClaims(llm, content, title, source);
  progress("extracted", `Found ${extractedClaims.length} claims`);

  // Diff against existing knowledge
  progress("diffing", `Comparing against existing knowledge...`);
  const diff = await computeKnowledgeDiff(store, llm, source, extractedClaims);
  progress(
    "diffed",
    `${diff.newClaims.length} new, ${diff.reinforced.length} reinforced, ${diff.challenged.length} challenged`,
  );

  // Resolve: apply the diff to the store
  progress("resolving", `Resolving knowledge graph...`);
  await resolveKnowledge(store, llm, diff, source);
  progress("done", `Ingestion complete`);

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
): Promise<ExtractedClaim[]> {
  // Chunk large content for better extraction
  if (content.length > 12000) {
    return extractClaimsChunked(llm, content, title, source);
  }
  return extractClaimsSingle(llm, content, title, source);
}

async function extractClaimsChunked(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
): Promise<ExtractedClaim[]> {
  const chunkSize = 8000;
  const overlap = 500;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize - overlap) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  const allClaims: ExtractedClaim[] = [];
  for (const chunk of chunks) {
    const claims = await extractClaimsSingle(llm, chunk, title, source);
    allClaims.push(...claims);
  }

  // Deduplicate by normalized statement
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
): Promise<ExtractedClaim[]> {
  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You extract atomic, verifiable claims from source material.
Each claim should be a single factual statement. Be precise and specific.
Assign an initial confidence based on how well-supported the claim is by the source.
Tag each claim with relevant topic tags.
Identify related concepts (potential wiki page titles) for cross-linking.
If a claim logically depends on another claim you're extracting, note the dependency.

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
}`,
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
