import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { QuickyConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import { KnowledgeStore } from "../graph/store.js";
import { createLLMAdapter } from "../llm/adapter.js";
import type { LLMAdapter } from "../types.js";

const CONFIG_FILE = "config.yaml";

export function getDataDir(): string {
  return join(process.cwd(), ".quicky");
}

export function getDbPath(): string {
  return join(getDataDir(), "graph.sqlite");
}

export function getConfigPath(): string {
  return join(getDataDir(), CONFIG_FILE);
}

export async function loadConfig(): Promise<QuickyConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  const raw = await readFile(configPath, "utf-8");
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: QuickyConfig): Promise<void> {
  const dataDir = getDataDir();
  await mkdir(dataDir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function openStore(): KnowledgeStore {
  return new KnowledgeStore(getDbPath());
}

export async function createLLM(config?: QuickyConfig): Promise<LLMAdapter> {
  const cfg = config ?? (await loadConfig());
  return createLLMAdapter({
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl,
    apiKeyEnv: cfg.llm.apiKeyEnv,
  });
}

export function isInitialized(): boolean {
  return existsSync(getDataDir());
}

export function requireInit(): void {
  if (!isInitialized()) {
    console.error("Not a Quicky Wiki project. Run `qw init` first.");
    process.exit(1);
  }
}
