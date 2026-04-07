import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter } from "../types.js";

export async function renderSlides(
  store: KnowledgeStore,
  llm: LLMAdapter,
  topic?: string,
): Promise<string> {
  let claims = store.listClaims({ minConfidence: 0.5 });
  let pageTitle = "Knowledge Overview";

  if (topic) {
    const page = store.getPageByTitle(topic);
    if (page) {
      claims = store.getClaimsByPage(page.id);
      pageTitle = page.title;
    }
  }

  if (claims.length === 0)
    return "---\nmarp: true\n---\n\n# No claims to present\n";

  const claimList = claims
    .map((c) => `- ${c.statement} (${(c.confidence * 100).toFixed(0)}%)`)
    .join("\n");

  const response = await llm.chat(
    [
      {
        role: "system",
        content: `Create a Marp-compatible slide deck from these knowledge claims. Use "---" to separate slides.
Include a title slide, organize claims into logical groups of 3-5 per slide, and add a summary slide.
Use markdown formatting. Keep each slide concise.
Start with the Marp frontmatter: ---\nmarp: true\ntheme: default\npaginate: true\n---`,
      },
      {
        role: "user",
        content: `Topic: ${pageTitle}\n\nClaims:\n${claimList}`,
      },
    ],
    { temperature: 0.4 },
  );

  return response.content;
}
