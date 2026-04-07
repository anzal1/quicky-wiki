import type { LLMProvider } from "../types.js";

export interface DetectedModel {
  provider: LLMProvider;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
}

// Fallback model names if API listing fails
const FALLBACK_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  ollama: "llama3.1",
};

// Preferred model patterns, in priority order (best first)
const PREFERRED_PATTERNS: Record<string, RegExp[]> = {
  anthropic: [
    /claude-sonnet-4/,
    /claude-3-5-sonnet/,
    /claude-3-opus/,
    /claude-3-sonnet/,
    /claude/,
  ],
  openai: [
    /gpt-4o(?!-mini)/,
    /gpt-4o-mini/,
    /gpt-4-turbo/,
    /gpt-4/,
    /gpt-3\.5-turbo/,
  ],
  gemini: [
    /gemini-2\.0-flash/,
    /gemini-1\.5-pro/,
    /gemini-1\.5-flash/,
    /gemini/,
  ],
  ollama: [/llama3/, /mistral/, /mixtral/],
};

/**
 * Fetch the list of available models from a provider's API and pick the best one.
 */
export async function fetchBestModel(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<string | null> {
  try {
    let modelsUrl: string;
    let headers: Record<string, string> = {};

    switch (provider) {
      case "anthropic": {
        // Anthropic doesn't have a public models list endpoint — use fallback
        return null;
      }
      case "openai": {
        modelsUrl = `${baseUrl || "https://api.openai.com"}/v1/models`;
        headers = { Authorization: `Bearer ${apiKey}` };
        break;
      }
      case "gemini": {
        modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        break;
      }
      case "ollama": {
        modelsUrl = `${baseUrl || "http://localhost:11434"}/api/tags`;
        break;
      }
      default:
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(modelsUrl, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;

    const data = await resp.json();
    let modelIds: string[] = [];

    if (provider === "openai") {
      modelIds = (data.data || []).map((m: any) => m.id);
    } else if (provider === "gemini") {
      modelIds = (data.models || [])
        .filter((m: any) => {
          // Only include models that support generateContent
          const methods = m.supportedGenerationMethods || [];
          return methods.includes("generateContent");
        })
        .map((m: any) => (m.name || "").replace("models/", ""));
    } else if (provider === "ollama") {
      modelIds = (data.models || []).map((m: any) => m.name);
    }

    if (modelIds.length === 0) return null;

    // Pick the best model using preferred patterns
    const patterns = PREFERRED_PATTERNS[provider] || [];
    for (const pattern of patterns) {
      const match = modelIds.find((id) => pattern.test(id));
      if (match) return match;
    }

    // If no preferred pattern matched, return the first model
    return modelIds[0];
  } catch {
    return null;
  }
}

/**
 * Detect all available providers and auto-fetch the best model for each.
 * Returns providers in priority order.
 */
export async function detectAllProviders(): Promise<DetectedModel[]> {
  const detected: DetectedModel[] = [];

  const checks: Array<{
    provider: LLMProvider;
    envVars: string[];
    baseUrl?: string;
    baseUrlEnv?: string;
  }> = [
    {
      provider: "anthropic",
      envVars: ["ANTHROPIC_API_KEY"],
      baseUrlEnv: "ANTHROPIC_BASE_URL",
    },
    {
      provider: "openai",
      envVars: ["OPENAI_API_KEY"],
      baseUrlEnv: "OPENAI_BASE_URL",
    },
    {
      provider: "gemini",
      envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    { provider: "ollama", envVars: [] },
  ];

  // Run all detections in parallel
  const promises = checks.map(async (check) => {
    for (const envVar of check.envVars) {
      const key = process.env[envVar];
      if (key) {
        const envBaseUrl = check.baseUrlEnv
          ? process.env[check.baseUrlEnv]
          : undefined;
        const baseUrl = envBaseUrl || check.baseUrl;
        const model = await fetchBestModel(check.provider, key, baseUrl);
        return {
          provider: check.provider,
          model: model || FALLBACK_MODELS[check.provider],
          apiKeyEnv: envVar,
          baseUrl,
        } as DetectedModel;
      }
    }

    // Check Ollama (no key needed)
    if (check.provider === "ollama" && check.envVars.length === 0) {
      const model = await fetchBestModel(
        "ollama",
        "",
        "http://localhost:11434",
      );
      if (model) {
        return {
          provider: "ollama" as LLMProvider,
          model,
          apiKeyEnv: "",
          baseUrl: "http://localhost:11434/v1",
        } as DetectedModel;
      }
    }

    return null;
  });

  const results = await Promise.all(promises);
  for (const r of results) {
    if (r) detected.push(r);
  }

  return detected;
}

/**
 * Detect the single best provider + model from environment.
 * Returns the first (highest priority) provider found.
 */
export async function detectBestProvider(): Promise<DetectedModel> {
  const all = await detectAllProviders();
  if (all.length > 0) return all[0];

  // Ultimate fallback
  return {
    provider: "ollama",
    model: "llama3.1",
    apiKeyEnv: "",
    baseUrl: "http://localhost:11434/v1",
  };
}

/**
 * Get the fallback model name for a provider (no API call).
 */
export function getFallbackModel(provider: string): string {
  return FALLBACK_MODELS[provider] || "default";
}
