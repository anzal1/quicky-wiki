import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeStore } from "../graph/store.js";
import type { Claim, WikiPage } from "../types.js";

/**
 * Export the entire wiki as an Obsidian-compatible vault.
 * - YAML frontmatter with tags, dates, confidence
 * - [[wikilinks]] instead of relative markdown links
 * - Dataview-compatible frontmatter fields
 * - Graph-friendly structure (backlinks via wikilinks)
 */
export async function exportObsidian(
  store: KnowledgeStore,
  outDir: string,
): Promise<{ pages: number; claims: number }> {
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "pages"), { recursive: true });
  await mkdir(join(outDir, "sources"), { recursive: true });

  const pages = store.listPages();
  const allClaims = store.listClaims();
  const sources = store.listSources();

  // Export pages
  for (const page of pages) {
    const claims = allClaims.filter((c) => c.pageId === page.id);
    const content = renderObsidianPage(store, page, claims);
    const safeName = page.title.replace(/[/\\:*?"<>|]/g, "-");
    await writeFile(join(outDir, "pages", `${safeName}.md`), content, "utf-8");
  }

  // Export sources
  for (const source of sources) {
    const content = [
      "---",
      `title: "${source.title.replace(/"/g, '\\"')}"`,
      `type: source`,
      `source_type: ${source.type}`,
      `quality: ${source.qualityTier}`,
      `ingested: ${source.ingestedAt.split("T")[0]}`,
      `content_hash: "${source.contentHash.slice(0, 12)}"`,
      "---",
      "",
      `# ${source.title}`,
      "",
      `**Type:** ${source.type}  `,
      `**Quality:** ${source.qualityTier}  `,
      `**Ingested:** ${source.ingestedAt.split("T")[0]}  `,
      `**Hash:** \`${source.contentHash.slice(0, 12)}\``,
      "",
      "## Claims from this source",
      "",
      ...allClaims
        .filter((c) => c.sources.includes(source.id))
        .map(
          (c) =>
            `- ${confidenceIcon(c.confidence)} **${(c.confidence * 100).toFixed(0)}%** ${c.statement}`,
        ),
      "",
    ].join("\n");
    const safeName = source.title.replace(/[/\\:*?"<>|]/g, "-");
    await writeFile(
      join(outDir, "sources", `${safeName}.md`),
      content,
      "utf-8",
    );
  }

  // Write index / MOC (Map of Content)
  const indexContent = [
    "---",
    "title: Wiki Index",
    "type: index",
    `generated: ${new Date().toISOString().split("T")[0]}`,
    "---",
    "",
    "# Wiki Index",
    "",
    `**${pages.length}** pages · **${allClaims.length}** claims · **${sources.length}** sources`,
    "",
    "## Pages",
    "",
    ...pages
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => {
        const claims = allClaims.filter((c) => c.pageId === p.id);
        const avgConf = claims.length
          ? claims.reduce((s, c) => s + c.confidence, 0) / claims.length
          : 0;
        return `- [[${p.title}]] — ${claims.length} claims, avg ${(avgConf * 100).toFixed(0)}%`;
      }),
    "",
    "## Sources",
    "",
    ...sources.map((s) => `- [[${s.title}]] (${s.qualityTier})`),
    "",
  ].join("\n");
  await writeFile(join(outDir, "Index.md"), indexContent, "utf-8");

  // Write Dataview dashboard
  const dashContent = [
    "---",
    "title: Dashboard",
    "type: dashboard",
    "---",
    "",
    "# Knowledge Dashboard",
    "",
    "## High Confidence Claims",
    "```dataview",
    'TABLE confidence, tags FROM "pages"',
    "WHERE confidence >= 0.8",
    "SORT confidence DESC",
    "```",
    "",
    "## Recent Pages",
    "```dataview",
    'TABLE claims, updated FROM "pages"',
    "SORT updated DESC",
    "LIMIT 20",
    "```",
    "",
    "## Sources by Quality",
    "```dataview",
    'TABLE quality, source_type, ingested FROM "sources"',
    "SORT ingested DESC",
    "```",
    "",
  ].join("\n");
  await writeFile(join(outDir, "Dashboard.md"), dashContent, "utf-8");

  return { pages: pages.length, claims: allClaims.length };
}

function renderObsidianPage(
  store: KnowledgeStore,
  page: WikiPage,
  claims: Claim[],
): string {
  const avgConf = claims.length
    ? claims.reduce((s, c) => s + c.confidence, 0) / claims.length
    : 0;

  // Collect all tags from claims
  const allTags = [...new Set(claims.flatMap((c) => c.tags))];

  // Get linked pages
  const linkedPages = [...new Set([...page.linksTo, ...page.linkedFrom])]
    .map((id) => store.getPage(id))
    .filter(Boolean)
    .map((p) => p!.title);

  // Get sources
  const sourceSet = new Set<string>();
  for (const c of claims) {
    for (const sid of c.sources) {
      const src = store.getSource(sid);
      if (src) sourceSet.add(src.title);
    }
  }

  const frontmatter = [
    "---",
    `title: "${page.title.replace(/"/g, '\\"')}"`,
    `created: ${page.createdAt.split("T")[0]}`,
    `updated: ${page.updatedAt.split("T")[0]}`,
    `claims: ${claims.length}`,
    `avg_confidence: ${(avgConf * 100).toFixed(0)}`,
    allTags.length > 0
      ? `tags: [${allTags.map((t) => `"${t}"`).join(", ")}]`
      : `tags: []`,
    `sources: ${sourceSet.size}`,
    "---",
  ].join("\n");

  const body = [
    `# ${page.title}`,
    "",
    page.summary || "_No summary yet._",
    "",
    "## Claims",
    "",
    ...claims.map((c) => {
      const conf = (c.confidence * 100).toFixed(0);
      const icon = confidenceIcon(c.confidence);
      const tags = c.tags.length > 0 ? ` \`${c.tags.join("` `")}\`` : "";
      return `- ${icon} **${conf}%** ${c.statement}${tags}`;
    }),
  ];

  if (linkedPages.length > 0) {
    body.push("", "## Related Pages", "");
    for (const title of linkedPages) {
      body.push(`- [[${title}]]`);
    }
  }

  if (sourceSet.size > 0) {
    body.push("", "## Sources", "");
    for (const title of sourceSet) {
      body.push(`- [[${title}]]`);
    }
  }

  return frontmatter + "\n\n" + body.join("\n") + "\n";
}

function confidenceIcon(confidence: number): string {
  if (confidence >= 0.8) return "🟢";
  if (confidence >= 0.5) return "🟡";
  return "🔴";
}
