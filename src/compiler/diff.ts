import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter, Source, KnowledgeDiff } from "../types.js";
import { mergeConfidence } from "./confidence.js";
import { parseLLMJson } from "../llm/parse-json.js";

interface ExtractedClaim {
  statement: string;
  confidence: number;
  tags: string[];
  relatedConcepts: string[];
  dependsOnStatements: string[];
}

export async function computeKnowledgeDiff(
  store: KnowledgeStore,
  llm: LLMAdapter,
  source: Source,
  extractedClaims: ExtractedClaim[],
): Promise<KnowledgeDiff> {
  const existingClaims = store.listClaims();
  const existingPages = store.listPages();

  const diff: KnowledgeDiff = {
    sourceId: source.id,
    sourceTitle: source.title,
    reinforced: [],
    challenged: [],
    newConcepts: [],
    newClaims: [],
    gapsIdentified: [],
  };

  if (existingClaims.length === 0) {
    // No existing knowledge — everything is new
    for (const claim of extractedClaims) {
      diff.newClaims.push({
        claimId: "", // assigned during resolution
        statement: claim.statement,
        confidence: claim.confidence,
      });
    }

    const existingTitles = new Set(existingPages.map((p) => p.title));
    for (const claim of extractedClaims) {
      for (const concept of claim.relatedConcepts) {
        if (
          !existingTitles.has(concept) &&
          !diff.newConcepts.some((c) => c.title === concept)
        ) {
          diff.newConcepts.push({
            pageId: "",
            title: concept,
            linkedTo: [],
          });
        }
      }
    }

    return diff;
  }

  // Compare new claims against existing
  const existingStatements = existingClaims.map((c) => c.statement);
  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You compare new claims against an existing knowledge base to produce a knowledge diff.
For each new claim, determine if it:
1. REINFORCES an existing claim (same meaning, adds evidence)
2. CHALLENGES an existing claim (contradicts or updates it)
3. Is entirely NEW (no existing claim covers this)

Also identify knowledge gaps — areas referenced but not covered.

Respond in JSON:
{
  "matches": [
    {
      "newClaimIndex": 0,
      "action": "reinforces" | "challenges" | "new",
      "existingClaimIndex": null | 3,
      "reason": "brief explanation"
    }
  ],
  "gaps": [
    { "concept": "topic name", "reason": "why it's a gap" }
  ]
}`,
      },
      {
        role: "user",
        content: `Existing claims:\n${existingStatements.map((s, i) => `${i}. ${s}`).join("\n")}\n\nNew claims from "${source.title}":\n${extractedClaims.map((c, i) => `${i}. ${c.statement}`).join("\n")}`,
      },
    ],
    { temperature: 0.1, maxTokens: 8192 },
  );

  try {
    const parsed = parseLLMJson(response.content);

    for (const match of parsed.matches ?? []) {
      const newClaim = extractedClaims[match.newClaimIndex];
      if (!newClaim) continue;

      if (match.action === "reinforces" && match.existingClaimIndex != null) {
        const existing = existingClaims[match.existingClaimIndex];
        if (!existing) continue;
        const newConf = mergeConfidence(
          existing.confidence,
          newClaim.confidence,
          existing.sources.length,
        );
        diff.reinforced.push({
          claimId: existing.id,
          statement: existing.statement,
          confidenceBefore: existing.confidence,
          confidenceAfter: newConf,
        });
      } else if (
        match.action === "challenges" &&
        match.existingClaimIndex != null
      ) {
        const existing = existingClaims[match.existingClaimIndex];
        if (!existing) continue;
        const store_deps = store.getDependents(existing.id);
        diff.challenged.push({
          claimId: existing.id,
          statement: existing.statement,
          confidenceBefore: existing.confidence,
          confidenceAfter: Math.max(0.01, existing.confidence * 0.6),
          reason: match.reason || "Contradicted by new evidence",
          downstreamAffected: store_deps.length,
        });
      } else {
        diff.newClaims.push({
          claimId: "",
          statement: newClaim.statement,
          confidence: newClaim.confidence,
        });
      }
    }

    // Gaps
    for (const gap of parsed.gaps ?? []) {
      diff.gapsIdentified.push({
        concept: gap.concept,
        reason: gap.reason,
        suggestedSources: [],
      });
    }
  } catch {
    // Fallback: treat all as new
    for (const claim of extractedClaims) {
      diff.newClaims.push({
        claimId: "",
        statement: claim.statement,
        confidence: claim.confidence,
      });
    }
  }

  // New concepts from related concepts
  const existingTitles = new Set(existingPages.map((p) => p.title));
  for (const claim of extractedClaims) {
    for (const concept of claim.relatedConcepts) {
      if (
        !existingTitles.has(concept) &&
        !diff.newConcepts.some((c) => c.title === concept)
      ) {
        diff.newConcepts.push({
          pageId: "",
          title: concept,
          linkedTo: [],
        });
      }
    }
  }

  return diff;
}
