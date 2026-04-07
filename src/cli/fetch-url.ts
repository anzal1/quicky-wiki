import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fetch a URL and convert to markdown source file for ingestion.
 * Uses only Node.js built-in fetch (Node 18+).
 */
export async function fetchUrlToMarkdown(
  url: string,
  rawDir: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const html = await response.text();

  // Extract a reasonable title from the URL or HTML
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const rawTitle =
    titleMatch?.[1]?.trim() ||
    new URL(url).pathname.split("/").pop() ||
    "untitled";
  const title = decodeHTMLEntities(rawTitle).slice(0, 120);

  // Convert HTML to readable markdown
  const markdown = htmlToMarkdown(html, title, url);

  // Make a safe filename
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const filename = `${slug}.md`;

  await mkdir(rawDir, { recursive: true });
  const outPath = join(rawDir, filename);
  await writeFile(outPath, markdown, "utf-8");

  return outPath;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function htmlToMarkdown(html: string, title: string, url: string): string {
  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source_url: "${url}"`,
    `fetched_at: "${new Date().toISOString()}"`,
    `type: article`,
    "---",
  ].join("\n");

  // Strip script, style, nav, footer, header tags
  let content = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // Try to extract main/article content
  const mainMatch = content.match(
    /<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i,
  );
  if (mainMatch) {
    content = mainMatch[1];
  }

  // Convert common HTML to markdown
  content = content
    // Headings
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, "\n###### $1\n")
    // Bold / italic
    .replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, "**$1**")
    .replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, "*$1*")
    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    // Lists
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?[uo]l[^>]*>/gi, "\n")
    // Paragraphs
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n")
    // Line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Code blocks
    .replace(
      /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
      "\n```\n$1\n```\n",
    )
    .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
    // Blockquotes
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, "\n> $1\n")
    // Images
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "![$1]()")
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…");

  content = decodeHTMLEntities(content);

  // Clean up: collapse multiple newlines, trim whitespace
  content = content
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

  return `${frontmatter}\n\n# ${title}\n\nSource: ${url}\n\n${content}\n`;
}
