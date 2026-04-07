import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, createLLM, loadConfig } from "./context.js";
import { renderAllPages } from "../render/markdown.js";
import { renderSlides } from "../render/marp.js";
import { renderAnkiDeck } from "../render/anki.js";
import { renderGraphHTML } from "../render/graph-viz.js";
import { renderTimeline } from "../render/timeline.js";
import type { RenderTarget } from "../types.js";

export async function compileCommand(
  target: RenderTarget,
  opts: { topic?: string },
): Promise<void> {
  requireInit();
  const store = openStore();
  const config = await loadConfig();

  try {
    const spinner = ora(`Compiling ${target}...`).start();

    switch (target) {
      case "markdown": {
        const paths = await renderAllPages(store, config.paths.wiki);
        spinner.succeed(
          `Rendered ${paths.length} wiki pages to ${config.paths.wiki}/`,
        );
        break;
      }
      case "slides": {
        const llm = await createLLM(config);
        const slides = await renderSlides(store, llm, opts.topic);
        const outPath = join(config.paths.wiki, "_slides.md");
        await writeFile(outPath, slides, "utf-8");
        spinner.succeed(`Slides written to ${outPath}`);
        break;
      }
      case "anki": {
        const deck = renderAnkiDeck(store);
        const outPath = join(config.paths.wiki, "_anki.txt");
        await writeFile(outPath, deck, "utf-8");
        spinner.succeed(`Anki deck written to ${outPath}`);
        break;
      }
      case "graph": {
        const html = renderGraphHTML(store);
        const outPath = join(config.paths.wiki, "_graph.html");
        await writeFile(outPath, html, "utf-8");
        spinner.succeed(`Graph visualization written to ${outPath}`);
        break;
      }
      case "timeline": {
        const tl = renderTimeline(store, opts.topic);
        const outPath = join(config.paths.wiki, "_timeline.md");
        await writeFile(outPath, tl, "utf-8");
        spinner.succeed(`Timeline written to ${outPath}`);
        break;
      }
      default:
        spinner.fail(
          `Unknown target: ${target}. Options: markdown, slides, anki, graph, timeline`,
        );
    }
  } finally {
    store.close();
  }
}
