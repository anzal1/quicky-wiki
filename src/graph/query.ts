import type { KnowledgeStore } from "./store.js";
import type { LLMAdapter } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";

export async function queryKnowledge(
  store: KnowledgeStore,
  llm: LLMAdapter,
  question: string,
): Promise<{ answer: string; claimIds: string[]; confidence: number }> {
  // Use FTS5 search to find relevant content instead of loading everything
  const { pages: relevantPages, claims: relevantClaims } = store.search(
    question,
    50,
  );

  // Build context from search results, grouped by page
  const pageMap = new Map<
    string,
    { title: string; claims: typeof relevantClaims }
  >();
  for (const c of relevantClaims) {
    const key = c.pageId ?? "__orphan__";
    if (!pageMap.has(key)) {
      const p = relevantPages.find((p) => p.id === key);
      pageMap.set(key, { title: p?.title ?? "Uncategorized", claims: [] });
    }
    pageMap.get(key)!.claims.push(c);
  }
  // Also add pages with no matching claims but matching titles/summaries
  for (const p of relevantPages) {
    if (!pageMap.has(p.id)) {
      const full = store.getPageFull(p.id);
      if (full) {
        pageMap.set(p.id, {
          title: p.title,
          claims: full.claims.slice(0, 10).map((c: any) => ({
            id: c.id,
            statement: c.statement,
            confidence: c.confidence,
            pageId: p.id,
            type: "claim" as const,
          })),
        });
      }
    }
  }

  const context = [...pageMap.entries()]
    .map(([, { title, claims }]) => {
      if (claims.length === 0) return "";
      const claimLines = claims
        .map(
          (c) =>
            `  - [${((c.confidence ?? 0) * 100).toFixed(0)}%] ${c.statement}`,
        )
        .join("\n");
      return `## ${title}\n${claimLines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You are a knowledge assistant answering questions from a personal knowledge base. 
Each claim has a confidence score. Cite specific claims and their confidence levels.
If the knowledge base doesn't contain enough information, say so clearly.
Always be epistemically honest about uncertainty.

Respond in JSON format:
{
  "answer": "Your detailed answer here",
  "relevantClaimIds": ["claim-id-1", "claim-id-2"],
  "overallConfidence": 0.85,
  "caveats": ["any important caveats"]
}`,
      },
      {
        role: "user",
        content: `Knowledge base contents:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
    { temperature: 0.3 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    return {
      answer:
        parsed.answer +
        (parsed.caveats?.length
          ? "\n\nCaveats:\n" +
            parsed.caveats.map((c: string) => `- ${c}`).join("\n")
          : ""),
      claimIds: parsed.relevantClaimIds ?? [],
      confidence: parsed.overallConfidence ?? 0.5,
    };
  } catch {
    return {
      answer: response.content,
      claimIds: [],
      confidence: 0.5,
    };
  }
}
