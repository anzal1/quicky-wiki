import type { KnowledgeStore } from "./store.js";

export function applyDecay(
  store: KnowledgeStore,
  claims: ReturnType<KnowledgeStore["listClaims"]>,
): Array<{ claimId: string; before: number; after: number }> {
  const results: Array<{ claimId: string; before: number; after: number }> = [];
  const now = Date.now();

  for (const claim of claims) {
    const lastReinforced = new Date(claim.lastReinforced).getTime();
    const daysSince = (now - lastReinforced) / 86400000;
    const decayed = claim.confidence * Math.exp(-claim.decayRate * daysSince);
    const clamped = Math.max(0.01, Math.min(1.0, decayed));

    if (Math.abs(clamped - claim.confidence) > 0.001) {
      store.updateClaimConfidence(claim.id, clamped);
      results.push({
        claimId: claim.id,
        before: claim.confidence,
        after: clamped,
      });
    }
  }

  return results;
}

export function findStaleConcepts(
  store: KnowledgeStore,
  thresholdDays: number,
): Array<{ claimId: string; statement: string; daysSince: number }> {
  const staleClaims = store.getStaleClaims(thresholdDays);
  const now = Date.now();

  return staleClaims.map((c) => ({
    claimId: c.id,
    statement: c.statement,
    daysSince: Math.floor(
      (now - new Date(c.lastReinforced).getTime()) / 86400000,
    ),
  }));
}
