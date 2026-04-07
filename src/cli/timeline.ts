import chalk from "chalk";
import { requireInit, openStore } from "./context.js";
import { renderTimeline } from "../render/timeline.js";

export async function timelineCommand(concept?: string): Promise<void> {
  requireInit();
  const store = openStore();

  try {
    const output = renderTimeline(store, concept);
    console.log(output);
  } finally {
    store.close();
  }
}
