import type { KnowledgeStore } from "../graph/store.js";
import { applyDecay } from "../graph/temporal.js";

export function runDecayCycle(store: KnowledgeStore): {
  updated: number;
  details: Array<{ claimId: string; before: number; after: number }>;
} {
  const allClaims = store.listClaims();
  const results = applyDecay(store, allClaims);
  return { updated: results.length, details: results };
}
