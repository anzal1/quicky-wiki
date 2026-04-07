import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, createLLM, loadConfig } from "./context.js";
import { renderAllPages } from "../render/markdown.js";

export async function lintCommand(opts: { prune?: boolean }): Promise<void> {
  requireInit();
  const store = openStore();
  const config = await loadConfig();

  try {
    const spinner = ora("Linting knowledge base...").start();
    const issues: Array<{
      severity: "error" | "warning" | "info";
      message: string;
    }> = [];

    const pages = store.listPages();
    const claims = store.listClaims();
    const sources = store.listSources();

    // Check for orphan pages (no claims)
    for (const page of pages) {
      const pageClaims = claims.filter((c) => c.pageId === page.id);
      if (pageClaims.length === 0) {
        issues.push({
          severity: "warning",
          message: `Page "${page.title}" has no claims`,
        });
      }
    }

    // Check for unsourced claims
    for (const claim of claims) {
      if (claim.sources.length === 0) {
        issues.push({
          severity: "error",
          message: `Claim "${claim.statement.slice(0, 60)}..." has no sources`,
        });
      }
    }

    // Check for very low confidence claims
    for (const claim of claims) {
      if (claim.confidence < 0.1) {
        issues.push({
          severity: "warning",
          message: `Claim "${claim.statement.slice(0, 60)}..." has very low confidence (${(claim.confidence * 100).toFixed(0)}%)`,
        });
      }
    }

    // Check for circular dependencies
    for (const claim of claims) {
      if (claim.dependsOn.includes(claim.id)) {
        issues.push({
          severity: "error",
          message: `Claim "${claim.statement.slice(0, 60)}..." has self-dependency`,
        });
      }
    }

    // Check for contradictions without resolution
    const contested = store.getContestedClaims();
    for (const claim of contested) {
      issues.push({
        severity: "warning",
        message: `Claim "${claim.statement.slice(0, 60)}..." has unresolved contradictions`,
      });
    }

    spinner.stop();

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    const infos = issues.filter((i) => i.severity === "info");

    if (issues.length === 0) {
      console.log(chalk.green("\n✓ No issues found"));
    } else {
      console.log(
        chalk.bold(
          `\nLint results: ${errors.length} errors, ${warnings.length} warnings\n`,
        ),
      );

      for (const e of errors) {
        console.log(`  ${chalk.red("✗")} ${e.message}`);
      }
      for (const w of warnings) {
        console.log(`  ${chalk.yellow("⚠")} ${w.message}`);
      }
      for (const i of infos) {
        console.log(`  ${chalk.blue("ℹ")} ${i.message}`);
      }
    }

    if (opts.prune) {
      const pruned = store.deleteEmptyPages();
      if (pruned > 0) {
        console.log(chalk.green(`\n  🧹 Pruned ${pruned} empty pages`));
      } else {
        console.log(chalk.dim(`\n  No empty pages to prune`));
      }
    }

    console.log(
      chalk.dim(
        `\n  ${sources.length} sources, ${pages.length} pages, ${claims.length} claims checked`,
      ),
    );
  } finally {
    store.close();
  }
}
