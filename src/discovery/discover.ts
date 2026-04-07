import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";

export type DiscoveryMode = "gaps" | "horizon" | "bridges" | "contradictions";

export interface Discovery {
  mode: DiscoveryMode;
  title: string;
  description: string;
  suggestedQueries: string[];
  relatedClaims: string[];
  priority: "high" | "medium" | "low";
}

export async function discover(
  store: KnowledgeStore,
  llm: LLMAdapter,
  mode: DiscoveryMode,
): Promise<Discovery[]> {
  const pages = store.listPages();
  const claims = store.listClaims();

  const context = pages
    .map((page) => {
      const pageClaims = claims.filter((c) => c.pageId === page.id);
      return `${page.title}: ${pageClaims.map((c) => c.statement).join("; ")}`;
    })
    .join("\n");

  const modePrompts: Record<DiscoveryMode, string> = {
    gaps: `Identify knowledge gaps — topics referenced but not well covered, or areas where claims exist but evidence is thin. Look for concepts that are mentioned in claims but don't have their own wiki pages.`,
    horizon: `Identify frontier topics — areas at the edge of the current knowledge that could be expanded into. Look for emerging concepts, recent developments, or adjacent fields that would complement the existing knowledge.`,
    bridges: `Identify potential connections between seemingly unrelated topics. Look for shared concepts, analogies, or patterns across different wiki pages that aren't currently linked.`,
    contradictions: `Identify contradictions, tensions, and unresolved debates within the knowledge base. Look for claims that implicitly or explicitly conflict with each other, or areas where the evidence is mixed.`,
  };

  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You are a knowledge discovery engine. ${modePrompts[mode]}

Respond in JSON:
{
  "discoveries": [
    {
      "title": "Brief title",
      "description": "Detailed explanation of what was found",
      "suggestedQueries": ["search query 1", "search query 2"],
      "relatedClaimIndices": [0, 5],
      "priority": "high" | "medium" | "low"
    }
  ]
}`,
      },
      {
        role: "user",
        content: `Current knowledge base:\n${context}`,
      },
    ],
    { temperature: 0.5 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    return (parsed.discoveries ?? []).map((d: any) => ({
      mode,
      title: d.title,
      description: d.description,
      suggestedQueries: d.suggestedQueries ?? [],
      relatedClaims: (d.relatedClaimIndices ?? [])
        .map((i: number) => claims[i]?.id)
        .filter(Boolean),
      priority: d.priority ?? "medium",
    }));
  } catch {
    return [];
  }
}
