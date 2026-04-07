import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, createLLM } from "./context.js";
import { discover, type DiscoveryMode } from "../discovery/discover.js";

export async function discoverCommand(opts: { mode?: string }): Promise<void> {
  requireInit();
  const store = openStore();

  try {
    const mode = (opts.mode || "gaps") as DiscoveryMode;
    const spinner = ora(`Discovering (${mode})...`).start();
    const llm = await createLLM();
    const discoveries = await discover(store, llm, mode);
    spinner.stop();

    const modeLabels: Record<string, string> = {
      gaps: "🕳️  Knowledge Gaps",
      horizon: "🔭 Frontier Topics",
      bridges: "🌉 Bridge Connections",
      contradictions: "⚡ Contradictions & Tensions",
    };

    console.log(
      chalk.bold(`\n${modeLabels[mode] || mode} (${discoveries.length}):\n`),
    );

    for (const d of discoveries) {
      const icon =
        d.priority === "high" ? "🔴" : d.priority === "medium" ? "🟡" : "🟢";
      console.log(`  ${icon} ${chalk.bold(d.title)}`);
      console.log(`    ${d.description}`);
      if (d.suggestedQueries.length > 0) {
        console.log(chalk.dim(`    Search: ${d.suggestedQueries.join(" | ")}`));
      }
      console.log();
    }
  } finally {
    store.close();
  }
}
