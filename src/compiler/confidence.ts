import type { QualityTier } from "../types.js";

const QUALITY_MULTIPLIERS: Record<QualityTier, number> = {
  "peer-reviewed": 1.0,
  "official-docs": 0.95,
  book: 0.85,
  blog: 0.6,
  social: 0.35,
  unknown: 0.45,
};

export function scoreConfidence(
  rawConfidence: number,
  qualityTier: QualityTier,
): number {
  const multiplier = QUALITY_MULTIPLIERS[qualityTier] ?? 0.45;
  const adjusted = rawConfidence * multiplier;
  return Math.max(0.01, Math.min(1.0, adjusted));
}

export function mergeConfidence(
  existing: number,
  newEvidence: number,
  sourceCount: number,
): number {
  // Bayesian-inspired: more sources → higher ceiling, diminishing returns
  const weight = 1 / (1 + sourceCount * 0.1);
  const merged = existing * (1 - weight) + newEvidence * weight;
  return Math.max(0.01, Math.min(1.0, merged));
}
