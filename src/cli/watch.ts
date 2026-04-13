import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, loadConfig, createLLM } from "./context.js";
import { ingestSource } from "../compiler/ingest.js";
import { generatePageSummaries } from "../compiler/resolve.js";
import { renderAllPages } from "../render/markdown.js";

export async function watchCommand(opts: { debounce?: string }): Promise<void> {
  requireInit();
  const config = await loadConfig();
  const rawDir = resolve(config.paths.raw);
  const debounceMs = parseInt(opts.debounce ?? "2000", 10);

  console.log(chalk.bold(`\n  ⚡ Watching ${rawDir} for changes...\n`));
  console.log(
    chalk.dim(`  Drop files into raw/ to auto-ingest. Press Ctrl+C to stop.\n`),
  );

  // Track recently processed files to debounce
  const pending = new Map<string, NodeJS.Timeout>();
  const processing = new Set<string>();

  async function processFile(filePath: string) {
    if (processing.has(filePath)) return;
    processing.add(filePath);

    const store = openStore();
    try {
      const llm = await createLLM(config);
      const spinner = ora(`Ingesting ${filePath}...`).start();

      const diff = await ingestSource(store, llm, filePath, { config });
      spinner.succeed(`Ingested ${diff.sourceTitle}`);

      // Quick summary
      const parts: string[] = [];
      if (diff.newClaims.length)
        parts.push(`${diff.newClaims.length} new claims`);
      if (diff.reinforced.length)
        parts.push(`${diff.reinforced.length} reinforced`);
      if (diff.challenged.length)
        parts.push(`${diff.challenged.length} challenged`);
      if (diff.newConcepts.length)
        parts.push(`${diff.newConcepts.length} new pages`);
      if (parts.length) console.log(chalk.dim(`    ${parts.join(", ")}`));

      // Generate summaries
      const needSummary = store
        .listPages()
        .filter((p) => !p.summary)
        .map((p) => p.id);
      if (needSummary.length > 0) {
        await generatePageSummaries(store, llm, needSummary);
      }

      // Re-render wiki
      await renderAllPages(store, config.paths.wiki);
      console.log(chalk.dim(`    Wiki updated.\n`));
    } catch (err: any) {
      console.error(chalk.red(`  ✗ Failed: ${err.message}\n`));
    } finally {
      store.close();
      processing.delete(filePath);
    }
  }

  // Initial scan — ingest any un-ingested files (recursive)
  try {
    const files = (await readdir(rawDir, { recursive: true })) as string[];
    for (const rel of files) {
      if (rel.split("/").some((seg: string) => seg.startsWith("."))) continue;
      const full = join(rawDir, rel);
      const s = await stat(full);
      if (s.isFile()) {
        const store = openStore();
        const existing = store.getSourceByPath(full);
        store.close();
        if (!existing) {
          await processFile(full);
        }
      }
    }
  } catch {
    // raw/ might not exist yet
  }

  // Watch for changes
  watch(rawDir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith(".")) return;
    const filePath = join(rawDir, filename);

    // Debounce: wait for file writes to finish
    if (pending.has(filePath)) {
      clearTimeout(pending.get(filePath)!);
    }
    pending.set(
      filePath,
      setTimeout(async () => {
        pending.delete(filePath);
        try {
          const s = await stat(filePath);
          if (s.isFile()) {
            await processFile(filePath);
          }
        } catch {
          // File was deleted, ignore
        }
      }, debounceMs),
    );
  });

  // Keep alive
  await new Promise(() => {});
}
