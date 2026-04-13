import { resolve, join } from "node:path";
import { readdir, stat as fsStat } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, createLLM, loadConfig } from "./context.js";
import { ingestSource } from "../compiler/ingest.js";
import type { KnowledgeDiff } from "../types.js";
import { generatePageSummaries } from "../compiler/resolve.js";
import { renderAllPages } from "../render/markdown.js";
import { fetchUrlToMarkdown } from "./fetch-url.js";

function printDiff(diff: KnowledgeDiff): void {
  if (diff.reinforced.length > 0) {
    console.log(
      chalk.green(`\n  💪 ${diff.reinforced.length} claims reinforced`),
    );
    for (const r of diff.reinforced.slice(0, 5)) {
      console.log(
        `     ${r.statement.slice(0, 70)}... ${(r.confidenceBefore * 100).toFixed(0)}% → ${(r.confidenceAfter * 100).toFixed(0)}%`,
      );
    }
  }

  if (diff.challenged.length > 0) {
    console.log(
      chalk.red(`\n  ⚡ ${diff.challenged.length} claims challenged`),
    );
    for (const c of diff.challenged.slice(0, 5)) {
      console.log(
        `     ${c.statement.slice(0, 70)}... ${(c.confidenceBefore * 100).toFixed(0)}% → ${(c.confidenceAfter * 100).toFixed(0)}%`,
      );
      if (c.downstreamAffected > 0) {
        console.log(
          chalk.yellow(
            `     ↳ ${c.downstreamAffected} downstream claims affected`,
          ),
        );
      }
    }
  }

  if (diff.newClaims.length > 0) {
    console.log(chalk.blue(`\n  🆕 ${diff.newClaims.length} new claims`));
    for (const c of diff.newClaims.slice(0, 5)) {
      console.log(
        `     ${c.statement.slice(0, 80)}... (${(c.confidence * 100).toFixed(0)}%)`,
      );
    }
  }

  if (diff.newConcepts.length > 0) {
    console.log(
      chalk.cyan(`\n  📄 ${diff.newConcepts.length} new wiki pages created`),
    );
    for (const p of diff.newConcepts) {
      console.log(`     ${p.title}`);
    }
  }

  if (diff.gapsIdentified.length > 0) {
    console.log(
      chalk.yellow(
        `\n  🕳️  ${diff.gapsIdentified.length} knowledge gaps identified`,
      ),
    );
    for (const g of diff.gapsIdentified) {
      console.log(`     ${g.concept}: ${g.reason}`);
    }
  }
}

export async function ingestCommand(
  sourcePath: string,
  opts: { type?: string; quality?: string },
): Promise<void> {
  requireInit();

  const store = openStore();
  const config = await loadConfig();
  let spinner: ReturnType<typeof ora> | undefined;

  try {
    const llm = await createLLM(config);

    // Detect directory → batch ingest
    const isDir = await fsStat(resolve(sourcePath))
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (isDir) {
      const dir = resolve(sourcePath);
      const entries = await readdir(dir);
      const files = entries.filter((f) => /\.(md|mdx|txt)$/i.test(f)).sort();
      if (files.length === 0) {
        console.error(chalk.red("No .md/.txt files found in directory"));
        process.exit(1);
      }

      console.log(
        chalk.bold(
          `\n  📂 Batch ingesting ${files.length} files from ${dir}\n`,
        ),
      );
      let totalNew = 0,
        totalReinforced = 0,
        totalChallenged = 0;

      for (let i = 0; i < files.length; i++) {
        const fp = join(dir, files[i]);
        const s = ora(
          `[${i + 1}/${files.length}] Ingesting ${files[i]}...`,
        ).start();
        try {
          const diff = await ingestSource(store, llm, fp, {
            type: opts.type as any,
            qualityTier: opts.quality as any,
            config,
            onProgress(_step, detail) {
              if (detail) s.text = `[${i + 1}/${files.length}] ${detail}`;
            },
          });
          s.succeed(
            `[${i + 1}/${files.length}] ${diff.sourceTitle} — ${diff.newClaims.length} new, ${diff.reinforced.length} reinforced`,
          );
          totalNew += diff.newClaims.length;
          totalReinforced += diff.reinforced.length;
          totalChallenged += diff.challenged.length;
        } catch (err: any) {
          s.fail(`[${i + 1}/${files.length}] Failed: ${err.message}`);
        }
      }

      console.log(
        chalk.bold(
          `\n  ✔ Batch complete: ${totalNew} new, ${totalReinforced} reinforced, ${totalChallenged} challenged`,
        ),
      );
    } else {
      // Single source: URL or file
      let fullPath: string;

      if (
        sourcePath.startsWith("http://") ||
        sourcePath.startsWith("https://")
      ) {
        const fetchSpinner = ora(`Fetching ${sourcePath}...`).start();
        try {
          fullPath = await fetchUrlToMarkdown(
            sourcePath,
            resolve(config.paths.raw),
          );
          fetchSpinner.succeed(`Fetched → ${fullPath}`);
        } catch (err: any) {
          fetchSpinner.fail(`Failed to fetch URL: ${err.message}`);
          process.exit(1);
        }
      } else {
        fullPath = resolve(sourcePath);
      }

      spinner = ora(`Ingesting ${fullPath}...`).start();
      const diff = await ingestSource(store, llm, fullPath, {
        type: opts.type as any,
        qualityTier: opts.quality as any,
        config,
        onProgress(step, detail) {
          if (detail) spinner!.text = detail;
        },
      });

      spinner.succeed(`Ingested ${diff.sourceTitle}`);
      printDiff(diff);
    }

    // Generate summaries for pages that lack one
    const pagesNeedingSummary = store
      .listPages()
      .filter((p) => !p.summary)
      .map((p) => p.id);
    if (pagesNeedingSummary.length > 0) {
      const sumSpinner = ora(
        `Generating summaries for ${pagesNeedingSummary.length} pages...`,
      ).start();
      await generatePageSummaries(store, llm, pagesNeedingSummary);
      const generated = store.listPages().filter((p) => p.summary).length;
      sumSpinner.succeed(`Generated ${generated} page summaries`);
    }

    // Re-render wiki
    const wikiSpinner = ora("Updating wiki pages...").start();
    const rendered = await renderAllPages(store, config.paths.wiki);
    wikiSpinner.succeed(`Updated ${rendered.length} wiki pages`);

    const stats = store.stats();
    console.log(
      chalk.dim(
        `\n  Total: ${stats.sources} sources, ${stats.pages} pages, ${stats.claims} claims`,
      ),
    );
  } catch (err: any) {
    if (spinner) spinner.fail(err.message);
    else console.error(err.message);
    process.exit(1);
  } finally {
    store.close();
  }
}
