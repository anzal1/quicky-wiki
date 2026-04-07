import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter, Claim } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";

export async function resurface(
  store: KnowledgeStore,
  llm: LLMAdapter,
  count: number = 5,
): Promise<Array<{ claim: Claim; question: string; suggestion: string }>> {
  const stale = store.getStaleClaims(14);
  const lowConf = store.listClaims({ maxConfidence: 0.5 });

  // Combine and prioritize
  const candidates = [...stale, ...lowConf]
    .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i) // dedupe
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, count);

  if (candidates.length === 0) return [];

  const claimList = candidates
    .map(
      (c) =>
        `- "${c.statement}" (confidence: ${(c.confidence * 100).toFixed(0)}%)`,
    )
    .join("\n");

  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You help maintain knowledge health. Given claims that are stale or low-confidence,
generate a review question and a suggestion for each. The question should prompt the user to
verify or update the claim. The suggestion should recommend a specific action.

Respond in JSON:
{
  "reviews": [
    { "index": 0, "question": "Is this still accurate?", "suggestion": "Check latest docs" }
  ]
}`,
      },
      {
        role: "user",
        content: `Claims to review:\n${claimList}`,
      },
    ],
    { temperature: 0.4 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    return (parsed.reviews ?? [])
      .map((r: any) => ({
        claim: candidates[r.index],
        question: r.question,
        suggestion: r.suggestion,
      }))
      .filter((r: any) => r.claim);
  } catch {
    return candidates.map((c) => ({
      claim: c,
      question: `Is this still accurate: "${c.statement}"?`,
      suggestion: "Review and reinforce or remove this claim.",
    }));
  }
}
