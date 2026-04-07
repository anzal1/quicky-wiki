import type { KnowledgeStore } from "../graph/store.js";

export function renderTimeline(
  store: KnowledgeStore,
  concept?: string,
): string {
  let claims = store.listClaims();
  if (concept) {
    const page = store.getPageByTitle(concept);
    if (page) {
      claims = store.getClaimsByPage(page.id);
    } else {
      claims = claims.filter((c) =>
        c.tags.some((t) => t.toLowerCase().includes(concept.toLowerCase())),
      );
    }
  }

  const events: Array<{ date: string; type: string; description: string }> = [];

  for (const claim of claims) {
    for (const event of claim.timeline) {
      events.push({
        date: event.date.split("T")[0],
        type: event.type,
        description: `[${event.type}] "${claim.statement.slice(0, 80)}" (${(event.confidenceBefore * 100).toFixed(0)}% → ${(event.confidenceAfter * 100).toFixed(0)}%)`,
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  const lines = ["# Knowledge Timeline", ""];
  if (concept) lines.push(`## ${concept}`, "");

  let currentDate = "";
  for (const event of events) {
    if (event.date !== currentDate) {
      currentDate = event.date;
      lines.push(`### ${currentDate}`, "");
    }
    const icon = eventIcon(event.type);
    lines.push(`- ${icon} ${event.description}`);
  }

  return lines.join("\n");
}

function eventIcon(type: string): string {
  switch (type) {
    case "created":
      return "🆕";
    case "reinforced":
      return "💪";
    case "challenged":
      return "⚡";
    case "weakened":
      return "📉";
    case "superseded":
      return "🔄";
    case "resolved":
      return "✅";
    default:
      return "•";
  }
}
