import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { getDataDir, saveConfig, isInitialized } from "./context.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { LLMProvider } from "../types.js";

const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl?: string }> = {
  anthropic: { model: "claude-sonnet-4-20250514" },
  openai: { model: "gpt-4o" },
  gemini: { model: "gemini-2.5-flash" },
  ollama: { model: "llama3.1", baseUrl: "http://localhost:11434/v1" },
  "openai-compatible": { model: "default" },
};

export async function initCommand(opts: {
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}): Promise<void> {
  if (isInitialized()) {
    console.log(chalk.yellow("Already initialized. Config at .quicky/"));
    return;
  }

  const config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm } };
  if (opts.name) config.name = opts.name;

  const provider = (opts.provider || "anthropic") as LLMProvider;
  const defaults =
    PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS["openai-compatible"];

  config.llm.provider = provider;
  config.llm.model = opts.model || defaults.model;
  config.llm.baseUrl = opts.baseUrl || defaults.baseUrl;
  config.llm.apiKeyEnv = opts.apiKeyEnv;

  const cwd = process.cwd();
  await mkdir(join(cwd, config.paths.raw), { recursive: true });
  await mkdir(join(cwd, config.paths.wiki), { recursive: true });
  await mkdir(getDataDir(), { recursive: true });
  await saveConfig(config);

  console.log(chalk.green("✓ Quicky Wiki initialized"));
  console.log(`  Name: ${config.name}`);
  console.log(`  LLM: ${config.llm.provider}/${config.llm.model}`);
  if (config.llm.baseUrl) console.log(`  Base URL: ${config.llm.baseUrl}`);
  console.log(`  Raw sources: ${config.paths.raw}/`);
  console.log(`  Wiki output: ${config.paths.wiki}/`);
  console.log(`  Database: .quicky/graph.sqlite`);
}
