import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, createLLM, loadConfig } from "./context.js";
import { generateHealthReport } from "../metabolism/health.js";
import { runDecayCycle } from "../metabolism/decay.js";
import { resurface } from "../metabolism/resurface.js";
import { redteamClaims } from "../metabolism/redteam.js";

export async function metabolismCommand(opts: {
  report?: boolean;
  decay?: boolean;
  resurface?: boolean;
  redteam?: boolean;
}): Promise<void> {
  requireInit();
  const store = openStore();
  const config = await loadConfig();

  try {
    if (opts.decay) {
      const result = runDecayCycle(store);
      console.log(
        chalk.bold(`\nDecay cycle complete: ${result.updated} claims updated`),
      );
      for (const d of result.details.slice(0, 10)) {
        console.log(
          `  ${(d.before * 100).toFixed(0)}% → ${(d.after * 100).toFixed(0)}%`,
        );
      }
      return;
    }

    if (opts.resurface) {
      const spinner = ora("Finding claims to review...").start();
      const llm = await createLLM(config);
      const reviews = await resurface(store, llm);
      spinner.stop();

      console.log(chalk.bold(`\n📋 Claims to review (${reviews.length}):\n`));
      for (const r of reviews) {
        console.log(`  ${chalk.yellow("?")} ${r.question}`);
        console.log(chalk.dim(`    → ${r.suggestion}`));
        console.log(
          chalk.dim(
            `    Claim: "${r.claim.statement.slice(0, 70)}..." (${(r.claim.confidence * 100).toFixed(0)}%)\n`,
          ),
        );
      }
      return;
    }

    if (opts.redteam) {
      const spinner = ora("Red-teaming your knowledge...").start();
      const llm = await createLLM(config);
      const critiques = await redteamClaims(store, llm);
      spinner.stop();

      console.log(
        chalk.bold(`\n🔴 Red Team Review (${critiques.length} claims):\n`),
      );
      for (const c of critiques) {
        console.log(`  ${chalk.red("⚡")} ${c.statement.slice(0, 70)}...`);
        console.log(`    ${c.critique}`);
        if (c.suggestedConfidenceAdjustment !== 0) {
          console.log(
            chalk.dim(
              `    Suggested adjustment: ${c.suggestedConfidenceAdjustment > 0 ? "+" : ""}${(c.suggestedConfidenceAdjustment * 100).toFixed(0)}%`,
            ),
          );
        }
        console.log();
      }
      return;
    }

    // Default: health report
    const report = generateHealthReport(
      store,
      config.metabolism.staleThresholdDays,
    );

    console.log(chalk.bold("\n📊 Knowledge Health Report\n"));
    console.log(`  Total claims: ${report.totalClaims}`);
    console.log(`  🟢 High confidence (>80%): ${report.highConfidence}`);
    console.log(`  🟡 Medium confidence (40-80%): ${report.mediumConfidence}`);
    console.log(`  🔴 Low confidence (<40%): ${report.lowConfidence}`);

    if (report.staleClaims.length > 0) {
      console.log(
        chalk.yellow(
          `\n  ⏰ ${report.staleClaims.length} stale claims (not reinforced in ${config.metabolism.staleThresholdDays}+ days)`,
        ),
      );
      for (const s of report.staleClaims.slice(0, 5)) {
        console.log(
          chalk.dim(
            `     "${s.statement.slice(0, 60)}..." — ${s.daysSince} days`,
          ),
        );
      }
    }

    if (report.contestedClaims.length > 0) {
      console.log(
        chalk.red(`\n  ⚠️  ${report.contestedClaims.length} contested claims`),
      );
      for (const c of report.contestedClaims.slice(0, 5)) {
        console.log(
          chalk.dim(
            `     "${c.statement.slice(0, 60)}..." — ${c.contradictions} contradictions`,
          ),
        );
      }
    }

    if (report.cascadeRisks.length > 0) {
      console.log(
        chalk.magenta(`\n  🏗️  ${report.cascadeRisks.length} cascade risks`),
      );
      for (const r of report.cascadeRisks.slice(0, 5)) {
        console.log(
          chalk.dim(
            `     "${r.statement.slice(0, 60)}..." — ${r.dependents} dependents, ${(r.confidence * 100).toFixed(0)}% confidence`,
          ),
        );
      }
    }

    if (report.suggestedActions.length > 0) {
      console.log(chalk.bold("\n  💡 Suggested actions:"));
      for (const a of report.suggestedActions) {
        console.log(`     • ${a}`);
      }
    }
  } finally {
    store.close();
  }
}
