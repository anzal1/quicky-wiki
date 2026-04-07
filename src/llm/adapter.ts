import type {
  LLMAdapter,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMProvider,
} from "../types.js";

export interface AdapterConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export function createLLMAdapter(config: AdapterConfig): LLMAdapter;
export function createLLMAdapter(
  provider: LLMProvider,
  model: string,
  apiKey?: string,
  baseUrl?: string,
  apiKeyEnv?: string,
): LLMAdapter;
export function createLLMAdapter(
  providerOrConfig: LLMProvider | AdapterConfig,
  model?: string,
  apiKey?: string,
  baseUrl?: string,
  apiKeyEnv?: string,
): LLMAdapter {
  const cfg: AdapterConfig =
    typeof providerOrConfig === "string"
      ? {
          provider: providerOrConfig,
          model: model!,
          apiKey,
          baseUrl,
          apiKeyEnv,
        }
      : providerOrConfig;

  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicAdapter(cfg);
    case "openai":
      return createOpenAIAdapter(cfg);
    case "gemini":
      return createOpenAICompatibleAdapter({
        ...cfg,
        baseUrl:
          cfg.baseUrl ||
          "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKeyEnv: cfg.apiKeyEnv || "GEMINI_API_KEY",
      });
    case "ollama":
      return createOpenAICompatibleAdapter({
        ...cfg,
        baseUrl: cfg.baseUrl || "http://localhost:11434/v1",
        // Ollama doesn't need an API key
      });
    case "openai-compatible":
      return createOpenAICompatibleAdapter(cfg);
    default:
      // Treat any unknown provider as openai-compatible (covers Groq, Together, Fireworks, etc.)
      return createOpenAICompatibleAdapter(cfg);
  }
}

function resolveApiKey(
  cfg: AdapterConfig,
  defaultEnvVar: string,
): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  const envVar = cfg.apiKeyEnv || defaultEnvVar;
  return process.env[envVar];
}

// ─── Anthropic ─────────────────────────────────────────

function createAnthropicAdapter(cfg: AdapterConfig): LLMAdapter {
  const key = resolveApiKey(cfg, "ANTHROPIC_API_KEY");
  if (!key)
    throw new Error("ANTHROPIC_API_KEY not set. Set it via env or config.");

  let client: any = null;

  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({
        apiKey: key,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      });
    }
    return client;
  }

  return {
    name: `anthropic/${cfg.model}`,
    async chat(
      messages: LLMMessage[],
      options?: LLMOptions,
    ): Promise<LLMResponse> {
      const anthropic = await getClient();

      const systemMsg = messages.find((m) => m.role === "system");
      const nonSystem = messages.filter((m) => m.role !== "system");

      const response = await anthropic.messages.create({
        model: cfg.model,
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(systemMsg ? { system: systemMsg.content } : {}),
        messages: nonSystem.map((m: LLMMessage) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      });

      const textBlock = response.content.find((b: any) => b.type === "text");
      return {
        content: textBlock?.text ?? "",
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}

// ─── OpenAI ────────────────────────────────────────────

function createOpenAIAdapter(cfg: AdapterConfig): LLMAdapter {
  const key = resolveApiKey(cfg, "OPENAI_API_KEY");
  if (!key)
    throw new Error("OPENAI_API_KEY not set. Set it via env or config.");

  let client: any = null;

  async function getClient() {
    if (!client) {
      const { default: OpenAI } = await import("openai");
      client = new OpenAI({
        apiKey: key,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      });
    }
    return client;
  }

  return {
    name: `openai/${cfg.model}`,
    async chat(
      messages: LLMMessage[],
      options?: LLMOptions,
    ): Promise<LLMResponse> {
      const openai = await getClient();

      const response = await openai.chat.completions.create({
        model: cfg.model,
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.json ? { response_format: { type: "json_object" } } : {}),
        messages: messages.map((m: LLMMessage) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const choice = response.choices[0];
      return {
        content: choice?.message?.content ?? "",
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens ?? 0,
            }
          : undefined,
      };
    },
  };
}

// ─── OpenAI-Compatible (Ollama, Gemini, Groq, Together, vLLM, LM Studio, etc.) ───

function createOpenAICompatibleAdapter(cfg: AdapterConfig): LLMAdapter {
  if (!cfg.baseUrl) {
    throw new Error(
      `baseUrl is required for provider "${cfg.provider}". Set it in .quicky/config.yaml or pass --base-url.`,
    );
  }

  // API key is optional for local providers like Ollama
  const key = resolveApiKey(
    cfg,
    cfg.apiKeyEnv || `${cfg.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
  );

  let client: any = null;

  async function getClient() {
    if (!client) {
      const { default: OpenAI } = await import("openai");
      client = new OpenAI({
        apiKey: key || "not-needed",
        baseURL: cfg.baseUrl,
      });
    }
    return client;
  }

  return {
    name: `${cfg.provider}/${cfg.model}`,
    async chat(
      messages: LLMMessage[],
      options?: LLMOptions,
    ): Promise<LLMResponse> {
      const openai = await getClient();

      const response = await openai.chat.completions.create({
        model: cfg.model,
        max_tokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.json ? { response_format: { type: "json_object" } } : {}),
        messages: messages.map((m: LLMMessage) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const choice = response.choices[0];
      return {
        content: choice?.message?.content ?? "",
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens ?? 0,
            }
          : undefined,
      };
    },
  };
}
