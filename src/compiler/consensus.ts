import type { LLMAdapter, LLMMessage, Claim } from "../types.js";
import type { KnowledgeStore } from "../graph/store.js";
import { createLLMAdapter } from "../llm/adapter.js";
import type { AdapterConfig } from "../llm/adapter.js";
import { parseLLMJson } from "../llm/parse-json.js";
import { detectAllProviders } from "../llm/detect.js";
import type { DetectedModel } from "../llm/detect.js";

export interface ConsensusResult {
  question: string;
  models: string[];
  agreed: Array<{ statement: string; confidence: number }>;
  disputed: Array<{
    statement: string;
    positions: Array<{ model: string; position: string; confidence: number }>;
  }>;
  uncertain: Array<{ statement: string; reason: string }>;
  synthesis: string;
  overallConfidence: number;
}

interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

/**
 * Run a multi-model consensus process for a given question.
 *
 * 1. Query N models independently
 * 2. Cross-compare responses to find agreement/disagreement
 * 3. Produce structured consensus: agreed, disputed, uncertain
 */
export async function multiModelConsensus(
  store: KnowledgeStore,
  primaryLlm: LLMAdapter,
  question: string,
  modelConfigs: ModelConfig[],
): Promise<ConsensusResult> {
  // Build knowledge context
  const pages = store.listPages();
  const allClaims = store.listClaims();
  const context = pages
    .map((page) => {
      const pageClaims = allClaims.filter((c) => c.pageId === page.id);
      if (pageClaims.length === 0) return "";
      const claimLines = pageClaims
        .map((c) => `  - [${(c.confidence * 100).toFixed(0)}%] ${c.statement}`)
        .join("\n");
      return `## ${page.title}\n${claimLines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const systemPrompt = `You are analyzing a personal knowledge base to answer a question.
Each claim has a confidence score. Be epistemically honest.
Respond in JSON:
{
  "claims": [
    {"statement": "specific claim", "confidence": 0.85, "reasoning": "why you believe this"}
  ],
  "answer": "your synthesized answer",
  "caveats": ["any important qualifiers"]
}`;

  const userPrompt = `Knowledge base:\n\n${context}\n\nQuestion: ${question}`;

  // Create adapters for each model
  const adapters: LLMAdapter[] = [];
  for (const mc of modelConfigs) {
    try {
      const adapter = createLLMAdapter({
        provider: mc.provider as any,
        model: mc.model,
        apiKeyEnv: mc.apiKeyEnv,
        baseUrl: mc.baseUrl,
      });
      adapters.push(adapter);
    } catch {
      // Skip models that can't be initialized (missing API keys etc.)
    }
  }

  // Always include primary LLM
  if (adapters.length === 0) {
    adapters.push(primaryLlm);
  }

  // Phase 1: Independent queries
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const responses = await Promise.allSettled(
    adapters.map((adapter) => adapter.chat(messages, { temperature: 0.3 })),
  );

  const modelResponses: Array<{
    model: string;
    claims: Array<{ statement: string; confidence: number; reasoning: string }>;
    answer: string;
  }> = [];

  for (let i = 0; i < responses.length; i++) {
    const result = responses[i];
    if (result.status === "fulfilled") {
      try {
        const parsed = parseLLMJson(result.value.content);
        modelResponses.push({
          model: adapters[i].name,
          claims: parsed.claims || [],
          answer: parsed.answer || "",
        });
      } catch {
        // Skip unparseable responses
      }
    }
  }

  if (modelResponses.length === 0) {
    return {
      question,
      models: [],
      agreed: [],
      disputed: [],
      uncertain: [],
      synthesis: "No model responses were obtained.",
      overallConfidence: 0,
    };
  }

  // If only one model responded, return its response as-is
  if (modelResponses.length === 1) {
    const r = modelResponses[0];
    return {
      question,
      models: [r.model],
      agreed: r.claims.map((c) => ({
        statement: c.statement,
        confidence: c.confidence,
      })),
      disputed: [],
      uncertain: [],
      synthesis: r.answer,
      overallConfidence: r.claims.length
        ? r.claims.reduce((s, c) => s + c.confidence, 0) / r.claims.length
        : 0.5,
    };
  }

  // Phase 2: Cross-compare via primary LLM
  const comparePrompt = `You are comparing responses from ${modelResponses.length} different AI models to find consensus.

Question asked: "${question}"

${modelResponses.map((r, i) => `--- Model ${i + 1}: ${r.model} ---\nClaims:\n${r.claims.map((c) => `- [${(c.confidence * 100).toFixed(0)}%] ${c.statement} (reason: ${c.reasoning})`).join("\n")}\n\nAnswer: ${r.answer}`).join("\n\n")}

Analyze these responses and categorize each claim into:
- "agreed": All models converge on this claim
- "disputed": Models disagree (include each model's position)
- "uncertain": No model could resolve confidently

Respond in JSON:
{
  "agreed": [{"statement": "claim text", "confidence": 0.9}],
  "disputed": [{"statement": "claim text", "positions": [{"model": "model name", "position": "agrees/disagrees/nuances", "confidence": 0.7}]}],
  "uncertain": [{"statement": "claim text", "reason": "why uncertain"}],
  "synthesis": "A balanced summary incorporating all perspectives",
  "overallConfidence": 0.75
}`;

  try {
    const compareResponse = await primaryLlm.chat(
      [
        {
          role: "system",
          content:
            "You objectively compare AI model responses to find consensus and disagreement. Respond in JSON only.",
        },
        { role: "user", content: comparePrompt },
      ],
      { temperature: 0.1 },
    );

    const parsed = parseLLMJson(compareResponse.content);
    return {
      question,
      models: modelResponses.map((r) => r.model),
      agreed: parsed.agreed || [],
      disputed: parsed.disputed || [],
      uncertain: parsed.uncertain || [],
      synthesis: parsed.synthesis || modelResponses[0].answer,
      overallConfidence: parsed.overallConfidence ?? 0.5,
    };
  } catch {
    // If consensus comparison fails, return best-effort
    return {
      question,
      models: modelResponses.map((r) => r.model),
      agreed: modelResponses[0].claims.map((c) => ({
        statement: c.statement,
        confidence: c.confidence,
      })),
      disputed: [],
      uncertain: [],
      synthesis: modelResponses[0].answer,
      overallConfidence: 0.5,
    };
  }
}

/**
 * Auto-detect available models from environment variables, fetching best model from each API.
 */
export async function detectAvailableModels(): Promise<ModelConfig[]> {
  const providers = await detectAllProviders();
  return providers.map((p) => ({
    provider: p.provider,
    model: p.model,
    apiKeyEnv: p.apiKeyEnv,
    baseUrl: p.baseUrl,
  }));
}
