import type { KnowledgeStore } from "./store.js";
import type { Claim } from "../types.js";

export interface CascadeResult {
  rootClaimId: string;
  affected: Array<{
    claimId: string;
    statement: string;
    confidenceBefore: number;
    confidenceAfter: number;
    depth: number;
  }>;
}

export function propagateCascade(
  store: KnowledgeStore,
  rootClaimId: string,
  confidenceChange: number,
  dampingFactor: number = 0.5,
): CascadeResult {
  const affected: CascadeResult["affected"] = [];
  const visited = new Set<string>();

  function walk(claimId: string, delta: number, depth: number) {
    if (visited.has(claimId) || Math.abs(delta) < 0.01 || depth > 10) return;
    visited.add(claimId);

    const dependents = store.getDependents(claimId);
    for (const dep of dependents) {
      const newConfidence = Math.max(
        0.01,
        Math.min(1.0, dep.confidence + delta),
      );
      store.updateClaimConfidence(dep.id, newConfidence);
      affected.push({
        claimId: dep.id,
        statement: dep.statement,
        confidenceBefore: dep.confidence,
        confidenceAfter: newConfidence,
        depth,
      });
      walk(dep.id, delta * dampingFactor, depth + 1);
    }
  }

  walk(rootClaimId, confidenceChange * dampingFactor, 1);
  return { rootClaimId, affected };
}

export function findCascadeRisks(
  store: KnowledgeStore,
): Array<{ claim: Claim; dependentCount: number }> {
  const allClaims = store.listClaims();
  const risks: Array<{ claim: Claim; dependentCount: number }> = [];

  for (const claim of allClaims) {
    const dependents = store.getDependents(claim.id);
    if (dependents.length > 0) {
      risks.push({ claim, dependentCount: dependents.length });
    }
  }

  return risks.sort((a, b) => b.dependentCount - a.dependentCount);
}
