import type { KnowledgeStore } from "../graph/store.js";

export function renderAnkiDeck(store: KnowledgeStore): string {
  const claims = store.listClaims({ minConfidence: 0.5 });
  const lines: string[] = ["#separator:tab", "#html:false", "#tags column:3"];

  for (const claim of claims) {
    const page = store.getPage(claim.pageId);
    const front = claim.statement;
    const back = [
      `Confidence: ${(claim.confidence * 100).toFixed(0)}%`,
      `Sources: ${claim.sources.length}`,
      `First stated: ${claim.firstStated.split("T")[0]}`,
      page ? `Topic: ${page.title}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    const tags = claim.tags.join(" ");
    lines.push(`${front}\t${back}\t${tags}`);
  }

  return lines.join("\n");
}
