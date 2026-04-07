import { Command } from "commander";
import { initCommand } from "./cli/init.js";
import { ingestCommand } from "./cli/ingest.js";
import { queryCommand } from "./cli/query.js";
import { claimsCommand } from "./cli/claims.js";
import { timelineCommand } from "./cli/timeline.js";
import { metabolismCommand } from "./cli/metabolism.js";
import { compileCommand } from "./cli/compile.js";
import { discoverCommand } from "./cli/discover.js";
import { lintCommand } from "./cli/lint.js";
import { startDashboard } from "./cli/serve.js";
import { watchCommand } from "./cli/watch.js";
import { createQuickyWiki } from "./cli/create.js";
import { startMCPServer } from "./mcp/server.js";
import {
  requireInit,
  openStore,
  loadConfig,
  createLLM,
} from "./cli/context.js";

const program = new Command();

program
  .name("qw")
  .description(
    "Quicky Wiki — LLM-powered knowledge compiler with temporal tracking",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new Quicky Wiki project (auto-detects API keys)")
  .option("-n, --name <name>", "Wiki name")
  .option(
    "-p, --provider <provider>",
    "LLM provider (anthropic|openai|gemini|ollama|openai-compatible)",
  )
  .option("-m, --model <model>", "LLM model name")
  .option(
    "--base-url <url>",
    "Base URL for openai-compatible providers (Groq, Together, vLLM, LM Studio, etc.)",
  )
  .option(
    "--api-key-env <var>",
    "Environment variable name for API key (e.g. GROQ_API_KEY)",
  )
  .action(async (opts) => {
    // Use the new zero-config create if no provider specified
    await createQuickyWiki(opts);
  });

program
  .command("ingest <source>")
  .description("Ingest a source document or URL into knowledge base")
  .option(
    "-t, --type <type>",
    "Source type (article|paper|repo|book|note|other)",
  )
  .option(
    "-q, --quality <quality>",
    "Quality tier (peer-reviewed|official-docs|book|blog|social)",
  )
  .action(ingestCommand);

program
  .command("query <question>")
  .description("Ask a question against your knowledge base")
  .option("--save", "Save the answer back as a wiki source for compounding")
  .option(
    "--consensus",
    "Use multi-model consensus (requires multiple API keys)",
  )
  .action(queryCommand);

program
  .command("claims")
  .description("List and filter claims")
  .option("--contested", "Show contested claims")
  .option("--weakest", "Show weakest claims")
  .option("--strongest", "Show strongest claims")
  .option("-l, --limit <n>", "Max results", "20")
  .action(claimsCommand);

program
  .command("timeline [concept]")
  .description("Show knowledge evolution timeline")
  .action(timelineCommand);

program
  .command("metabolism")
  .description("Knowledge health and maintenance")
  .option("--report", "Show health report (default)")
  .option("--decay", "Run confidence decay cycle")
  .option("--resurface", "Get claims to review")
  .option("--redteam", "Adversarial review of high-confidence claims")
  .action(metabolismCommand);

program
  .command("compile <target>")
  .description(
    "Compile wiki to different formats (markdown|slides|anki|graph|timeline)",
  )
  .option("--topic <topic>", "Focus on a specific topic")
  .action(compileCommand);

program
  .command("discover")
  .description(
    "Discover knowledge gaps, frontiers, bridges, and contradictions",
  )
  .option(
    "--mode <mode>",
    "Discovery mode (gaps|horizon|bridges|contradictions)",
    "gaps",
  )
  .action(discoverCommand);

program
  .command("lint")
  .description("Check knowledge base for issues")
  .option("--prune", "Delete empty pages with no claims")
  .action(lintCommand);

program
  .command("watch")
  .description("Watch raw/ directory and auto-ingest new or changed files")
  .option("--debounce <ms>", "Debounce interval in milliseconds", "2000")
  .action(watchCommand);

program
  .command("export")
  .description("Export wiki to different formats")
  .option("--obsidian <dir>", "Export as Obsidian vault to directory")
  .action(async (opts: { obsidian?: string }) => {
    requireInit();
    if (opts.obsidian) {
      const { exportObsidian } = await import("./render/obsidian.js");
      const store = openStore();
      try {
        const result = await exportObsidian(store, opts.obsidian);
        console.log(
          `\n  ✓ Exported ${result.pages} pages, ${result.claims} claims to ${opts.obsidian}/`,
        );
        console.log(
          `    Open in Obsidian: File → Open Vault → ${opts.obsidian}\n`,
        );
      } finally {
        store.close();
      }
    } else {
      console.log("Specify export format: --obsidian <dir>");
    }
  });

program
  .command("mcp")
  .description(
    "Start MCP (Model Context Protocol) server for agent integration",
  )
  .option("--stdio", "Use stdio transport (for Claude Code, Cursor, etc.)")
  .option("--http", "Use HTTP transport")
  .option("-p, --port <port>", "HTTP port (default: 3838)", "3838")
  .action(async (opts: { stdio?: boolean; http?: boolean; port: string }) => {
    requireInit();
    const store = openStore();
    const config = await loadConfig();
    const llm = await createLLM(config);

    if (opts.stdio) {
      await startMCPServer(store, config, llm, "stdio");
    } else {
      const port = parseInt(opts.port, 10);
      const url = await startMCPServer(store, config, llm, "http", port);
      console.log(`\n  ⚡ Quicky Wiki MCP Server\n  ${url}\n`);
      console.log(
        `  Tools: query_wiki, list_pages, get_page, search_wiki, list_claims, health_report, ingest_file\n`,
      );
    }
  });

program
  .command("serve")
  .description("Launch visual dashboard to explore your knowledge base")
  .option("-p, --port <port>", "Port number", "3737")
  .action(async (opts: { port: string }) => {
    requireInit();
    const store = openStore();
    const config = await loadConfig();
    const llm = await createLLM(config);
    const port = parseInt(opts.port, 10);
    const url = await startDashboard(store, config, llm, port);
    console.log(`\n  ⚡ Quicky Wiki Dashboard\n  ${url}\n`);
  });

program.parse();
