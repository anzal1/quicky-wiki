import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { KnowledgeStore } from "../graph/store.js";
import type { WikiPage, Claim } from "../types.js";

export async function renderWikiPage(
  store: KnowledgeStore,
  page: WikiPage,
  wikiDir: string,
): Promise<string> {
  const claims = store.getClaimsByPage(page.id);
  const linkedPages = page.linksTo
    .map((id) => store.getPage(id))
    .filter(Boolean);

  const frontmatter = [
    "---",
    `title: "${page.title}"`,
    `created: ${page.createdAt}`,
    `updated: ${page.updatedAt}`,
    `claims: ${claims.length}`,
    `avg_confidence: ${claims.length ? ((claims.reduce((s, c) => s + c.confidence, 0) / claims.length) * 100).toFixed(0) : 0}%`,
    "---",
  ].join("\n");

  const body = [
    `# ${page.title}`,
    "",
    page.summary || "_No summary yet._",
    "",
    "## Claims",
    "",
    ...claims.map((c) => formatClaim(c)),
    "",
  ];

  if (linkedPages.length > 0) {
    body.push("## Related Pages", "");
    for (const lp of linkedPages) {
      if (lp) body.push(`- [[${lp.title}]]`);
    }
    body.push("");
  }

  const sources = new Set<string>();
  for (const c of claims) {
    for (const sid of c.sources) {
      const src = store.getSource(sid);
      if (src) sources.add(`- ${src.title} (${src.qualityTier})`);
    }
  }

  if (sources.size > 0) {
    body.push("## Sources", "", ...sources, "");
  }

  const content = frontmatter + "\n\n" + body.join("\n");
  const outPath = join(wikiDir, page.path);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, content, "utf-8");
  return outPath;
}

function formatClaim(claim: Claim): string {
  const conf = (claim.confidence * 100).toFixed(0);
  const bar = confidenceBar(claim.confidence);
  const contested = claim.contradictedBy.length > 0 ? " ⚠️" : "";
  return `- ${bar} **${conf}%** ${claim.statement}${contested} ^${claim.id.slice(0, 8)}`;
}

function confidenceBar(confidence: number): string {
  if (confidence >= 0.8) return "🟢";
  if (confidence >= 0.5) return "🟡";
  return "🔴";
}

export async function renderAllPages(
  store: KnowledgeStore,
  wikiDir: string,
): Promise<string[]> {
  const pages = store.listPages();
  const paths: string[] = [];
  for (const page of pages) {
    // Skip pages with no claims — don't clutter wiki with empty stubs
    const claims = store.getClaimsByPage(page.id);
    if (claims.length === 0) continue;
    const p = await renderWikiPage(store, page, wikiDir);
    paths.push(p);
  }
  return paths;
}
