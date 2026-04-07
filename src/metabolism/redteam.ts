import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";

export async function redteamClaims(
  store: KnowledgeStore,
  llm: LLMAdapter,
  count: number = 5,
): Promise<
  Array<{
    claimId: string;
    statement: string;
    critique: string;
    suggestedConfidenceAdjustment: number;
  }>
> {
  const highConf = store.listClaims({ minConfidence: 0.7 });
  const candidates = highConf
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, count);

  if (candidates.length === 0) return [];

  const claimList = candidates
    .map(
      (c, i) =>
        `${i}. "${c.statement}" (confidence: ${(c.confidence * 100).toFixed(0)}%, sources: ${c.sources.length})`,
    )
    .join("\n");

  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You are an adversarial reviewer. Your job is to find weaknesses in high-confidence claims.
For each claim, try to identify:
- Potential logical fallacies
- Missing context or nuance
- Cases where the claim might not hold
- Whether the confidence is justified given the source count

Be constructive but rigorous. If a claim is solid, say so.

Respond in JSON:
{
  "critiques": [
    {
      "index": 0,
      "critique": "This claim assumes X but doesn't account for Y",
      "isValid": true,
      "suggestedConfidenceAdjustment": -0.1
    }
  ]
}`,
      },
      {
        role: "user",
        content: `Claims to review:\n${claimList}`,
      },
    ],
    { temperature: 0.5 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    return (parsed.critiques ?? [])
      .map((c: any) => {
        const claim = candidates[c.index];
        if (!claim) return null;
        return {
          claimId: claim.id,
          statement: claim.statement,
          critique: c.critique,
          suggestedConfidenceAdjustment: c.suggestedConfidenceAdjustment ?? 0,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
