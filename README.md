# ⚡ Quicky Wiki

**Turn any collection of documents into a living, confidence-scored knowledge base — powered by LLMs.**

Quicky Wiki extracts claims from your sources, tracks how confident each claim is, watches for contradictions, and gives you a visual dashboard to explore everything. Think of it as a personal Wikipedia that actually tells you what it's unsure about.

[![npm version](https://img.shields.io/npm/v/quicky-wiki)](https://www.npmjs.com/package/quicky-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

---

## 30-Second Demo

```bash
npx quicky-wiki init --name "My Research"   # auto-detects your API keys
qw ingest paper.pdf                          # extract claims from a paper
qw ingest https://arxiv.org/abs/2401.12345   # or a URL
qw serve                                     # open the dashboard
```

That's it. Open `http://localhost:3737` and you've got:

- A **knowledge graph** you can zoom into, hover over, and click through
- **Ask Wiki** — chat with your knowledge base, get answers with confidence scores and citations
- Claims, pages, timeline, and health views

## What Makes It Different

| Feature | Traditional Wiki | Quicky Wiki |
|---------|-----------------|-------------|
| Who writes it? | You | LLM extracts claims from your sources |
| Confidence? | ❌ Everything looks equally true | ✅ Every claim has a confidence score |
| Contradictions? | Hidden in edit history | Surfaced automatically |
| Temporal tracking? | ❌ | ✅ Claims strengthen, weaken, and decay over time |
| Knowledge gaps? | Unknown unknowns | Discovered and suggested |
| Multi-format output? | Just a wiki | Wiki, slides, flashcards, graph, timeline |

## Install

```bash
npm install -g quicky-wiki
```

The package exposes three equivalent commands: **`quicky-wiki`**, **`qw`**, and **`create-quicky-wiki`** (all run the same CLI). Use whichever fits your muscle memory or tooling.

Or use directly with npx:

```bash
npx quicky-wiki init
```

From a git clone of this repo, run **`npm run build`** before `npx quicky-wiki …`, `node dist/cli.js …`, or `npm start`, because the published CLI is the compiled `dist/` bundle.

### Requirements

- **Node.js >= 20**
- An API key from **one** of these providers:

| Provider | Env Variable | Example Model |
|----------|-------------|---------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| Ollama | _(local, no key)_ | `llama3` |
| Any OpenAI-compatible | Custom env var + `--base-url` | Groq, Together, vLLM, LM Studio |

`qw init` **auto-detects** whichever API key you have set — no config needed.

## Usage

### Initialize

```bash
mkdir my-wiki && cd my-wiki
qw init --name "My Research"

# Or specify a provider explicitly
qw init --provider gemini --model gemini-2.0-flash
qw init --provider openai --model gpt-4o

# OpenAI-compatible (Groq, Together, etc.)
qw init --provider openai-compatible \
  --base-url https://api.groq.com/openai/v1 \
  --api-key-env GROQ_API_KEY
```

### Ingest Sources

```bash
# Local files (markdown, text, PDF)
qw ingest paper.md --type paper --quality peer-reviewed
qw ingest notes.md --type note

# URLs (fetches and extracts automatically)
qw ingest https://example.com/article

# Batch ingest a directory
qw ingest raw/
```

### Query Your Knowledge

```bash
qw query "What are the key approaches to reinforcement learning?"
qw query "How do transformers compare to RNNs?"
```

### Explore with the Dashboard

```bash
qw serve                 # http://localhost:3737
qw serve --port 8080     # custom port
```

The dashboard includes:
- **Overview** — Stats at a glance
- **Knowledge Graph** — Interactive canvas visualization (Obsidian-inspired dark theme, hover to unfold connections)
- **Claims** — Browse all extracted claims with confidence scores
- **Pages** — Wiki pages compiled from your claims (optional **entity kind** and metadata when configured)
- **Timeline** — Temporal view of knowledge events
- **Health** — Knowledge integrity: stale claims, contradictions, gaps
- **Ask Wiki** — Chat with your knowledge base

When you open a page, the slideout shows **Linked pages** (graph neighbors) and the **rendered wiki markdown** from `wiki/`. Inline **Obsidian-style wikilinks** work in that preview: `[[Page Title]]` and `[[label|Page Title]]` open the matching page by title. The dashboard script is embedded in the built CLI, so after changing TypeScript sources, run **`npm run build`** and restart `serve` to see UI updates.

### Knowledge Health

```bash
qw lint                        # check for issues
qw metabolism --report         # full health report
qw metabolism --decay          # apply confidence decay over time
qw metabolism --resurface      # find stale claims worth revisiting
qw metabolism --redteam        # challenge high-confidence claims
```

### Compile to Other Formats

```bash
qw compile markdown            # Obsidian-compatible wiki pages
qw compile slides --topic X    # Marp slide deck
qw compile anki                # flashcards
qw compile graph               # D3 knowledge graph
qw compile timeline            # temporal visualization
```

### Discover New Directions

```bash
qw discover --mode gaps          # what's missing?
qw discover --mode horizon       # frontier topics
qw discover --mode bridges       # connections between distant concepts
qw discover --mode contradictions # conflicting claims
```

## How It Works

```
Source Document
     ↓
LLM Extraction → Claims (with confidence scores)
     ↓                        ↓
Knowledge Graph (SQLite)    Epistemic Events (temporal log)
     ↓
Compiled Outputs: Wiki pages, slides, flashcards, graph, timeline
     ↓
Dashboard (interactive visualization + chat)
```

### Key Concepts

- **Claim** — An atomic, verifiable statement extracted from a source. Has a confidence score, provenance, and dependency chain.
- **Epistemic Event** — A change in belief: created, reinforced, challenged, weakened, superseded, or resolved.
- **Knowledge Diff** — When you ingest a new source, you see what's new, reinforced, challenged, and what gaps were found.
- **Cascade** — When a foundational claim is challenged, confidence changes propagate through dependent claims.
- **Metabolism** — Active maintenance: decay, resurfacing, red-teaming.

## MCP Server

Quicky Wiki includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server for integration with AI agents:

```bash
qw mcp                          # stdio mode (for Claude Desktop, etc.)
qw mcp --http --port 3000       # HTTP mode
```

Tools include querying, search (full-text on the graph), listing pages and claims, ingestion, and health reporting. Pages can carry an **entity kind** and **metadata** (see config / compiled wiki frontmatter). MCP adds **`list_entities`** (filter by kind and metadata) and **`update_entity_metadata`** for merging metadata without re-ingesting; **`list_pages`** and **`ingest_file`** accept optional kind-related parameters. Use each tool’s schema in your MCP client for full argument lists.

## Project Structure

```
my-wiki/
├── .quicky/
│   ├── config.yaml          # LLM provider, model, wiki name
│   └── graph.sqlite         # knowledge graph (claims, sources, events)
├── raw/                     # your source documents (immutable)
└── wiki/                    # compiled output (Obsidian-compatible markdown)
```

## Development

```bash
git clone <repo-url> quicky-wiki && cd quicky-wiki
npm install
npm run build # required before serve / dist-based CLI picks up TS changes
npm run typecheck      # optional
```

## License

MIT
