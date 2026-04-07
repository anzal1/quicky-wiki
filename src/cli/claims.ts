import chalk from "chalk";
import { requireInit, openStore } from "./context.js";

export async function claimsCommand(opts: {
  contested?: boolean;
  weakest?: boolean;
  strongest?: boolean;
  limit?: string;
}): Promise<void> {
  requireInit();
  const store = openStore();
  const limit = parseInt(opts.limit || "20", 10);

  try {
    let claims;
    let title: string;

    if (opts.contested) {
      claims = store.getContestedClaims().slice(0, limit);
      title = "Contested Claims";
    } else if (opts.weakest) {
      claims = store
        .listClaims()
        .sort((a, b) => a.confidence - b.confidence)
        .slice(0, limit);
      title = "Weakest Claims";
    } else if (opts.strongest) {
      claims = store
        .listClaims()
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, limit);
      title = "Strongest Claims";
    } else {
      claims = store.listClaims().slice(0, limit);
      title = "All Claims";
    }

    console.log(chalk.bold(`\n${title} (${claims.length}):\n`));

    for (const claim of claims) {
      const page = store.getPage(claim.pageId);
      const conf = (claim.confidence * 100).toFixed(0);
      const bar =
        claim.confidence >= 0.8 ? "🟢" : claim.confidence >= 0.5 ? "🟡" : "🔴";
      const contested = claim.contradictedBy.length > 0 ? chalk.red(" ⚠️") : "";
      console.log(
        `  ${bar} ${chalk.bold(conf + "%")} ${claim.statement}${contested}`,
      );
      console.log(
        chalk.dim(
          `     Page: ${page?.title ?? "unknown"} | Sources: ${claim.sources.length} | Tags: ${claim.tags.join(", ") || "none"}`,
        ),
      );
    }

    const stats = store.stats();
    console.log(
      chalk.dim(
        `\n  Total: ${stats.claims} claims across ${stats.pages} pages`,
      ),
    );
  } finally {
    store.close();
  }
}
