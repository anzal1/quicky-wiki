import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { DEFAULT_CONFIG } from "../types.js";
import type { LLMProvider, QuickyConfig } from "../types.js";
import {
  detectBestProvider,
  getFallbackModel,
  fetchBestModel,
} from "../llm/detect.js";

export async function createQuickyWiki(opts: {
  name?: string;
  dir?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}): Promise<void> {
  const dir = opts.dir || process.cwd();
  const name = opts.name || "My Wiki";

  console.log(chalk.bold("\n  ⚡ Quicky Wiki — Setup\n"));

  let provider: LLMProvider;
  let model: string;
  let apiKeyEnv: string | undefined;
  let baseUrl: string | undefined;

  if (opts.provider) {
    // User specified a provider explicitly
    provider = opts.provider as LLMProvider;
    const envMap: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      ollama: [],
      "openai-compatible": [],
    };
    apiKeyEnv = (envMap[provider] || []).find((v) => process.env[v]);
    if (opts.apiKeyEnv) apiKeyEnv = opts.apiKeyEnv;

    if (!opts.model && apiKeyEnv) {
      // Auto-fetch the best model from the API
      console.log(chalk.dim(`  Fetching available ${provider} models...`));
      const fetched = await fetchBestModel(provider, process.env[apiKeyEnv]!);
      model = fetched || getFallbackModel(provider);
    } else {
      model = opts.model || getFallbackModel(provider);
    }
    console.log(chalk.green(`  ✓ Using ${provider}/${model}`));
  } else {
    // Auto-detect: find API keys, fetch available models from the API
    console.log(chalk.dim("  Detecting API keys and fetching models..."));
    const detected = await detectBestProvider();
    provider = detected.provider;
    model = opts.model || detected.model;
    apiKeyEnv = detected.apiKeyEnv || undefined;
    baseUrl = detected.baseUrl;

    if (detected.apiKeyEnv) {
      console.log(
        chalk.green(
          `  ✓ Auto-detected ${detected.provider} via ${detected.apiKeyEnv}`,
        ),
      );
      console.log(
        chalk.green(`  ✓ Best available model: ${chalk.bold(model)}`),
      );
    } else if (detected.provider === "ollama") {
      console.log(
        chalk.yellow(`  ⚠ No cloud API key found — using Ollama (local)`),
      );
      console.log(
        chalk.dim(
          `    Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY to use a cloud provider`,
        ),
      );
    }
  }

  // CLI --base-url takes priority
  if (opts.baseUrl) baseUrl = opts.baseUrl;

  if (!baseUrl) {
    if (provider === "gemini") {
      baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    } else if (provider === "ollama") {
      baseUrl = "http://localhost:11434/v1";
    } else if (provider === "anthropic" && process.env.ANTHROPIC_BASE_URL) {
      baseUrl = process.env.ANTHROPIC_BASE_URL;
    } else if (provider === "openai" && process.env.OPENAI_BASE_URL) {
      baseUrl = process.env.OPENAI_BASE_URL;
    }
  }

  const config: QuickyConfig = {
    ...DEFAULT_CONFIG,
    name,
    llm: {
      ...DEFAULT_CONFIG.llm,
      provider,
      model,
      apiKeyEnv,
      baseUrl,
    },
  };

  // Create directory structure
  await mkdir(join(dir, "raw"), { recursive: true });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await mkdir(join(dir, ".quicky"), { recursive: true });

  // Write config
  await writeFile(
    join(dir, ".quicky", "config.yaml"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );

  // Write .gitignore
  await writeFile(
    join(dir, ".gitignore"),
    `.quicky/graph.sqlite\n.quicky/graph.sqlite-wal\n.quicky/graph.sqlite-shm\nnode_modules/\n`,
    "utf-8",
  );

  // Write starter README
  await writeFile(
    join(dir, "README.md"),
    `# ${name}\n\nA knowledge wiki powered by [Quicky Wiki](https://github.com/user/quicky-wiki).\n\n## Quick Start\n\n\`\`\`bash\n# Drop sources into raw/\ncp my-article.md raw/\n\n# Ingest\nqw ingest raw/my-article.md\n\n# Ask questions\nqw query "What are the key concepts?"\n\n# Launch dashboard\nqw serve\n\`\`\`\n`,
    "utf-8",
  );

  console.log(chalk.green(`\n  ✓ Wiki initialized at ${dir}`));
  console.log(`    Provider: ${chalk.bold(provider)}/${chalk.bold(model)}`);
  console.log(`    Raw sources: raw/`);
  console.log(`    Wiki output: wiki/`);
  console.log(`\n  ${chalk.dim("Next steps:")}`);
  console.log(`    1. Drop source files into raw/`);
  console.log(
    `    2. Run ${chalk.cyan("qw ingest raw/<file>")} to compile knowledge`,
  );
  console.log(
    `    3. Run ${chalk.cyan("qw serve")} to explore in the dashboard\n`,
  );
}
