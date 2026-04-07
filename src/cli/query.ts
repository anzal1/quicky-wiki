import chalk from "chalk";
import ora from "ora";
import { resolve } from "node:path";
import { requireInit, openStore, createLLM, loadConfig } from "./context.js";
import { queryKnowledge } from "../graph/query.js";
import { saveAnswerAsSource } from "./save-answer.js";
import {
  multiModelConsensus,
  detectAvailableModels,
} from "../compiler/consensus.js";

export async function queryCommand(
  question: string,
  opts: { save?: boolean; consensus?: boolean },
): Promise<void> {
  requireInit();

  const spinner = ora("Thinking...").start();
  const store = openStore();
  const config = await loadConfig();

  try {
    const llm = await createLLM(config);

    if (opts.consensus) {
      // Multi-model consensus mode
      spinner.text = "Detecting available models...";
      const models = await detectAvailableModels();
      if (models.length < 2) {
        spinner.info(
          "Only one provider detected — need 2+ API keys for consensus. Running single model.",
        );
      }
      spinner.text = `Querying ${models.length} model(s) for consensus...`;
      const result = await multiModelConsensus(store, llm, question, models);
      spinner.stop();

      console.log(
        chalk.bold(
          `\nConsensus from ${result.models.length} models: ${result.models.join(", ")}`,
        ),
      );
      console.log(chalk.bold("\nSynthesis:"));
      console.log(result.synthesis);

      if (result.agreed.length > 0) {
        console.log(
          chalk.green(`\n  ✓ ${result.agreed.length} agreed claims:`),
        );
        for (const c of result.agreed.slice(0, 10)) {
          console.log(`    ${(c.confidence * 100).toFixed(0)}% ${c.statement}`);
        }
      }
      if (result.disputed.length > 0) {
        console.log(
          chalk.yellow(`\n  ⚡ ${result.disputed.length} disputed claims:`),
        );
        for (const d of result.disputed.slice(0, 5)) {
          console.log(`    ${d.statement}`);
          for (const p of d.positions) {
            console.log(
              chalk.dim(
                `      ${p.model}: ${p.position} (${(p.confidence * 100).toFixed(0)}%)`,
              ),
            );
          }
        }
      }
      if (result.uncertain.length > 0) {
        console.log(
          chalk.dim(`\n  ? ${result.uncertain.length} uncertain claims`),
        );
      }
      console.log(
        chalk.dim(
          `\nOverall confidence: ${(result.overallConfidence * 100).toFixed(0)}%`,
        ),
      );
    } else {
      // Standard single-model query
      const result = await queryKnowledge(store, llm, question);
      spinner.stop();

      console.log(chalk.bold("\nAnswer:"));
      console.log(result.answer);
      console.log(
        chalk.dim(
          `\nOverall confidence: ${(result.confidence * 100).toFixed(0)}%`,
        ),
      );
      if (result.claimIds.length > 0) {
        console.log(chalk.dim(`Based on ${result.claimIds.length} claims`));
      }

      // Save answer as source for compounding
      if (opts.save) {
        const rawDir = resolve(config.paths.raw);
        const filePath = await saveAnswerAsSource(
          store,
          question,
          result.answer,
          result.claimIds,
          result.confidence,
          rawDir,
        );
        console.log(chalk.green(`\n  ✓ Answer saved as source: ${filePath}`));
        console.log(
          chalk.dim(
            `    Run 'qw ingest ${filePath}' to compile it into knowledge`,
          ),
        );
      }
    }
  } catch (err: any) {
    spinner.fail(err.message);
    process.exit(1);
  } finally {
    store.close();
  }
}
