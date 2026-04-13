import { createServer } from "node:http";
import { resolve } from "node:path";
import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter, QuickyConfig } from "../types.js";
import { queryKnowledge } from "../graph/query.js";
import { ingestSource } from "../compiler/ingest.js";
import { generatePageSummaries } from "../compiler/resolve.js";
import { renderAllPages } from "../render/markdown.js";
import { generateHealthReport } from "../metabolism/health.js";

/**
 * MCP-compatible JSON-RPC server that exposes the wiki as tools.
 * Implements the Model Context Protocol (MCP) specification.
 *
 * Tools exposed:
 * - query_wiki: Ask a question against the knowledge base
 * - list_pages: List wiki pages (optional kind filter)
 * - list_entities: List pages by entity kind with metadata filters
 * - get_page: Get detailed page content
 * - search_wiki: FTS search pages and claims
 * - list_claims: List claims with optional confidence filter
 * - health_report: Get knowledge health report
 * - ingest_file: Ingest a source file (optional kind/metadata overrides)
 * - update_entity_metadata: Merge fields into page metadata_json
 */
export function startMCPServer(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
  mode: "stdio" | "http",
  port?: number,
): Promise<string | void> {
  if (mode === "stdio") {
    return startStdioMCP(store, config, llm);
  }
  return startHttpMCP(store, config, llm, port ?? 3838);
}

const TOOLS = [
  {
    name: "query_wiki",
    description:
      "Ask a question against the Quicky Wiki knowledge base. Returns answer with confidence score and cited claims.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
      },
      required: ["question"],
    },
  },
  {
    name: "list_pages",
    description:
      "List all wiki pages with titles, summaries, claim counts, and confidence averages.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description:
            "Optional: only pages with this entity kind (e.g. person, project, topic)",
        },
      },
    },
  },
  {
    name: "list_entities",
    description:
      "List wiki pages of a specific entity kind with structured metadata. Use for typed inventories (people, projects, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Entity kind to filter by (e.g. person, project, topic)",
        },
        filter: {
          type: "object",
          description:
            "Optional key-value filters on metadata (e.g. { status: 'active' })",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_page",
    description: "Get detailed wiki page including claims, links, and content.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title to retrieve" },
      },
      required: ["title"],
    },
  },
  {
    name: "search_wiki",
    description: "Search wiki pages and claims by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_claims",
    description:
      "List knowledge claims with confidence scores, optionally filtered.",
    inputSchema: {
      type: "object",
      properties: {
        min_confidence: {
          type: "number",
          description: "Minimum confidence (0-1)",
        },
        max_confidence: {
          type: "number",
          description: "Maximum confidence (0-1)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "health_report",
    description:
      "Get the knowledge base health report: confidence distribution, stale claims, contested claims, gaps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ingest_file",
    description:
      "Ingest a source file into the wiki. File must exist in the raw/ directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the source file to ingest",
        },
        kind: {
          type: "string",
          description: "Override entity kind for the primary page from this file",
        },
        metadata: {
          type: "object",
          description: "Extra fields merged into the primary page metadata_json",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "update_entity_metadata",
    description:
      "Merge key-value pairs into a page's metadata_json. Does not change claims.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Wiki page title" },
        metadata: {
          type: "object",
          description: "Fields to merge into existing metadata",
        },
      },
      required: ["title", "metadata"],
    },
  },
];

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (toolName) {
    case "query_wiki": {
      const result = await queryKnowledge(store, llm, args.question as string);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                answer: result.answer,
                confidence: result.confidence,
                claimsReferenced: result.claimIds.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "list_pages": {
      const kindFilter = args.kind as string | undefined;
      let pages = store.listPages();
      if (kindFilter) {
        pages = pages.filter((p) => p.kind === kindFilter);
      }
      const claims = store.listClaims();
      const result = pages.map((p) => {
        const pageClaims = claims.filter((c) => c.pageId === p.id);
        const avgConf = pageClaims.length
          ? pageClaims.reduce((s, c) => s + c.confidence, 0) / pageClaims.length
          : 0;
        return {
          title: p.title,
          kind: p.kind,
          summary: p.summary || "(no summary)",
          claims: pageClaims.length,
          avgConfidence: Math.round(avgConf * 100) + "%",
          links: p.linksTo.length,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "list_entities": {
      const kind = args.kind as string;
      const filter = args.filter as Record<string, unknown> | undefined;
      const pages = store.listPages().filter((p) => p.kind === kind);
      const matches = pages.filter((p) => {
        if (!filter) return true;
        return Object.entries(filter).every(([k, v]) => p.metadata[k] === v);
      });
      const result = matches.map((p) => ({
        title: p.title,
        kind: p.kind,
        metadata: p.metadata,
        summary: p.summary,
        claimCount: store.getClaimsByPage(p.id).length,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_page": {
      const page = store.getPageByTitle(args.title as string);
      if (!page) {
        return {
          content: [{ type: "text", text: `Page "${args.title}" not found.` }],
        };
      }
      const pageClaims = store.getClaimsByPage(page.id);
      const linkedPages = [...page.linksTo, ...page.linkedFrom]
        .map((id) => store.getPage(id))
        .filter(Boolean)
        .map((p) => p!.title);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                title: page.title,
                kind: page.kind,
                metadata: page.metadata,
                summary: page.summary,
                claims: pageClaims.map((c) => ({
                  statement: c.statement,
                  confidence: Math.round(c.confidence * 100) + "%",
                  sources: c.sources.length,
                  tags: c.tags,
                })),
                relatedPages: linkedPages,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "search_wiki": {
      const results = store.search(args.query as string, 20);
      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
        ],
      };
    }

    case "list_claims": {
      const all = store.listClaims({
        minConfidence: args.min_confidence as number | undefined,
        maxConfidence: args.max_confidence as number | undefined,
      });
      const limit = (args.limit as number) || 50;
      const result = all.slice(0, limit).map((c) => ({
        statement: c.statement,
        confidence: Math.round(c.confidence * 100) + "%",
        sources: c.sources.length,
        tags: c.tags,
        lastReinforced: c.lastReinforced,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "health_report": {
      const report = generateHealthReport(
        store,
        config.metabolism.staleThresholdDays,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "ingest_file": {
      const filePath = resolve(args.path as string);
      const kindOverride = args.kind as string | undefined;
      const metadataOverride = args.metadata as
        | Record<string, unknown>
        | undefined;
      const diff = await ingestSource(store, llm, filePath, {
        config,
        ...(kindOverride ? { kind: kindOverride } : {}),
        ...(metadataOverride ? { metadata: metadataOverride } : {}),
      });

      // Generate summaries
      const needSummary = store
        .listPages()
        .filter((p) => !p.summary)
        .map((p) => p.id);
      if (needSummary.length > 0) {
        await generatePageSummaries(store, llm, needSummary);
      }
      await renderAllPages(store, config.paths.wiki);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: diff.sourceTitle,
                newClaims: diff.newClaims.length,
                reinforced: diff.reinforced.length,
                challenged: diff.challenged.length,
                newPages: diff.newConcepts.length,
                gaps: diff.gapsIdentified.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "update_entity_metadata": {
      const page = store.getPageByTitle(args.title as string);
      if (!page) {
        return {
          content: [
            {
              type: "text",
              text: "Page \"" + String(args.title) + "\" not found.",
            },
          ],
        };
      }
      store.updatePageMetadata(
        page.id,
        args.metadata as Record<string, unknown>,
      );
      const updated = store.getPage(page.id)!;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                title: updated.title,
                kind: updated.kind,
                metadata: updated.metadata,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    default:
      return {
        content: [
          { type: "text", text: "Unknown tool: " + String(toolName) },
        ],
      };
  }
}

// ─── stdio MCP transport ────────────────────────────────

async function startStdioMCP(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<void> {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    // JSON-RPC messages are delimited by newlines
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const response = await handleJsonRpc(msg, store, config, llm);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch {
        // Skip malformed messages
      }
    }
  });

  // Send server info on start
  process.stderr.write("Quicky Wiki MCP server started (stdio mode)\n");
  await new Promise(() => {}); // Keep alive
}

// ─── HTTP MCP transport ─────────────────────────────────

async function startHttpMCP(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
  port: number,
): Promise<string> {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body);
          const response = await handleJsonRpc(msg, store, config, llm);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(response));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
    });

    server.listen(port, () => {
      resolvePromise(`http://localhost:${port}`);
    });
  });
}

// ─── JSON-RPC handler ───────────────────────────────────

async function handleJsonRpc(
  msg: any,
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<any> {
  const id = msg.id;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "quicky-wiki",
            version: "0.1.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = msg.params;
      try {
        const result = await handleToolCall(
          name,
          args || {},
          store,
          config,
          llm,
        );
        return { jsonrpc: "2.0", id, result };
      } catch (e: any) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          },
        };
      }
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // No response for notifications

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}
