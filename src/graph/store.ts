import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Source,
  Claim,
  WikiPage,
  EpistemicEvent,
  EpistemicEventType,
  SourceType,
  QualityTier,
} from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  quality_tier TEXT NOT NULL DEFAULT 'unknown',
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'topic',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  confidence REAL NOT NULL DEFAULT 0.5,
  first_stated TEXT NOT NULL,
  last_reinforced TEXT NOT NULL,
  decay_rate REAL NOT NULL DEFAULT 0.002,
  tags_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS claim_sources (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (claim_id, source_id)
);

CREATE TABLE IF NOT EXISTS claim_dependencies (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  depends_on_claim_id TEXT NOT NULL REFERENCES claims(id),
  PRIMARY KEY (claim_id, depends_on_claim_id)
);

CREATE TABLE IF NOT EXISTS claim_contradictions (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  contradicted_by_claim_id TEXT NOT NULL REFERENCES claims(id),
  PRIMARY KEY (claim_id, contradicted_by_claim_id)
);

CREATE TABLE IF NOT EXISTS epistemic_events (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  trigger_source_id TEXT REFERENCES sources(id),
  confidence_before REAL NOT NULL,
  confidence_after REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS page_links (
  from_page_id TEXT NOT NULL REFERENCES pages(id),
  to_page_id TEXT NOT NULL REFERENCES pages(id),
  PRIMARY KEY (from_page_id, to_page_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_page ON claims(page_id);
CREATE INDEX IF NOT EXISTS idx_claims_confidence ON claims(confidence);
CREATE INDEX IF NOT EXISTS idx_events_claim ON epistemic_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON epistemic_events(date);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_source ON epistemic_events(trigger_source_id);
CREATE INDEX IF NOT EXISTS idx_claims_last_reinforced ON claims(last_reinforced);
CREATE INDEX IF NOT EXISTS idx_page_links_to ON page_links(to_page_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  statement,
  content=claims,
  content_rowid=rowid
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  summary,
  content=pages,
  content_rowid=rowid
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, statement) VALUES (NEW.rowid, NEW.statement);
END;
CREATE TRIGGER IF NOT EXISTS claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement) VALUES('delete', OLD.rowid, OLD.statement);
END;
CREATE TRIGGER IF NOT EXISTS claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement) VALUES('delete', OLD.rowid, OLD.statement);
  INSERT INTO claims_fts(rowid, statement) VALUES (NEW.rowid, NEW.statement);
END;

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, summary) VALUES (NEW.rowid, NEW.title, NEW.summary);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary) VALUES('delete', OLD.rowid, OLD.title, OLD.summary);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary) VALUES('delete', OLD.rowid, OLD.title, OLD.summary);
  INSERT INTO pages_fts(rowid, title, summary) VALUES (NEW.rowid, NEW.title, NEW.summary);
END;
`;

export class KnowledgeStore {
  private db: Database.Database;

  // Pre-prepared hot statements
  private stmts!: ReturnType<KnowledgeStore["prepareStatements"]>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // Turbo PRAGMAs
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("cache_size = -64000"); // 64MB page cache
    this.db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
    this.db.pragma("synchronous = NORMAL"); // safe with WAL, faster than FULL
    this.db.pragma("temp_store = MEMORY"); // temp tables in RAM
    this.db.exec(SCHEMA);
    this.ensurePageEntityColumns();
    this.db.exec(FTS_SCHEMA);
    this.db.exec(FTS_TRIGGERS);
    this.rebuildFtsIfEmpty();
    this.stmts = this.prepareStatements();
  }

  /** Add kind + metadata_json to existing DBs created before entity typing. */
  private ensurePageEntityColumns(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as {
      name: string;
    }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("kind")) {
      this.db.exec(
        "ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic'",
      );
    }
    if (!names.has("metadata_json")) {
      this.db.exec(
        "ALTER TABLE pages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
      );
    }
  }

  private rebuildFtsIfEmpty(): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) as c FROM claims").get() as any
    ).c;
    if (count === 0) return;
    try {
      const ftsCount = (
        this.db.prepare("SELECT COUNT(*) as c FROM claims_fts").get() as any
      ).c;
      if (ftsCount === 0) {
        this.db.exec(
          "INSERT INTO claims_fts(rowid, statement) SELECT rowid, statement FROM claims",
        );
        this.db.exec(
          "INSERT INTO pages_fts(rowid, title, summary) SELECT rowid, title, summary FROM pages",
        );
      }
    } catch {
      // FTS index corrupted — drop and recreate
      this.db.exec("DROP TABLE IF EXISTS claims_fts");
      this.db.exec("DROP TABLE IF EXISTS pages_fts");
      this.db.exec("DROP TRIGGER IF EXISTS claims_ai");
      this.db.exec("DROP TRIGGER IF EXISTS claims_ad");
      this.db.exec("DROP TRIGGER IF EXISTS claims_au");
      this.db.exec("DROP TRIGGER IF EXISTS pages_ai");
      this.db.exec("DROP TRIGGER IF EXISTS pages_ad");
      this.db.exec("DROP TRIGGER IF EXISTS pages_au");
      this.db.exec(FTS_SCHEMA);
      this.db.exec(FTS_TRIGGERS);
      this.db.exec(
        "INSERT INTO claims_fts(rowid, statement) SELECT rowid, statement FROM claims",
      );
      this.db.exec(
        "INSERT INTO pages_fts(rowid, title, summary) SELECT rowid, title, summary FROM pages",
      );
    }
  }

  private prepareStatements() {
    return {
      getSourceByPath: this.db.prepare("SELECT * FROM sources WHERE path = ?"),
      getSource: this.db.prepare("SELECT * FROM sources WHERE id = ?"),
      getPageById: this.db.prepare("SELECT * FROM pages WHERE id = ?"),
      getPageByTitle: this.db.prepare("SELECT * FROM pages WHERE title = ?"),
      getClaimById: this.db.prepare("SELECT * FROM claims WHERE id = ?"),
      claimsByPage: this.db.prepare(
        "SELECT * FROM claims WHERE page_id = ? ORDER BY confidence DESC",
      ),
      claimSourceIds: this.db.prepare(
        "SELECT source_id FROM claim_sources WHERE claim_id = ?",
      ),
      claimContradictions: this.db.prepare(
        "SELECT contradicted_by_claim_id FROM claim_contradictions WHERE claim_id = ?",
      ),
      claimDependsOn: this.db.prepare(
        "SELECT depends_on_claim_id FROM claim_dependencies WHERE claim_id = ?",
      ),
      claimDerived: this.db.prepare(
        "SELECT claim_id FROM claim_dependencies WHERE depends_on_claim_id = ?",
      ),
      claimTimeline: this.db.prepare(
        "SELECT * FROM epistemic_events WHERE claim_id = ? ORDER BY date ASC",
      ),
      pageClaimIds: this.db.prepare("SELECT id FROM claims WHERE page_id = ?"),
      pageLinksTo: this.db.prepare(
        "SELECT to_page_id FROM page_links WHERE from_page_id = ?",
      ),
      pageLinkedFrom: this.db.prepare(
        "SELECT from_page_id FROM page_links WHERE to_page_id = ?",
      ),
      allPages: this.db.prepare("SELECT * FROM pages ORDER BY updated_at DESC"),
      allSources: this.db.prepare(
        "SELECT * FROM sources ORDER BY ingested_at DESC",
      ),
      stats: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sources) as sources,
          (SELECT COUNT(*) FROM pages) as pages,
          (SELECT COUNT(*) FROM claims) as claims,
          (SELECT COUNT(*) FROM epistemic_events) as events
      `),
      // Flat listing queries — no N+1
      listClaimsFlat: this.db.prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM claim_sources cs WHERE cs.claim_id = c.id) as source_count,
          (SELECT COUNT(*) FROM claim_contradictions cc WHERE cc.claim_id = c.id) as contradiction_count,
          (SELECT COUNT(*) FROM claim_dependencies cd WHERE cd.claim_id = c.id) as dependency_count
        FROM claims c ORDER BY c.confidence DESC
      `),
      listPagesFlat: this.db.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM claims c WHERE c.page_id = p.id) as claim_count,
          (SELECT COUNT(*) FROM page_links pl WHERE pl.from_page_id = p.id) + 
          (SELECT COUNT(*) FROM page_links pl2 WHERE pl2.to_page_id = p.id) as link_count
        FROM pages p ORDER BY p.updated_at DESC
      `),
      // Events with claim statement — no N+1
      listEventsRecent: this.db.prepare(`
        SELECT e.*, c.statement as claim_statement
        FROM epistemic_events e
        JOIN claims c ON e.claim_id = c.id
        ORDER BY e.date DESC
        LIMIT ?
      `),
      // FTS5 search
      searchClaims: this.db.prepare(`
        SELECT c.id, c.statement, c.page_id, c.confidence, c.first_stated, c.last_reinforced, c.tags_json
        FROM claims_fts fts
        JOIN claims c ON c.rowid = fts.rowid
        WHERE claims_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      searchPages: this.db.prepare(`
        SELECT p.id, p.title, p.summary
        FROM pages_fts fts
        JOIN pages p ON p.rowid = fts.rowid
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      // Page detail with claims in one go
      pageClaimsFull: this.db.prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM claim_sources cs WHERE cs.claim_id = c.id) as source_count
        FROM claims c WHERE c.page_id = ? ORDER BY c.confidence DESC
      `),
      getClaimPageId: this.db.prepare(
        "SELECT page_id FROM claims WHERE id = ?",
      ),
      pagesWithoutSummary: this.db.prepare(
        "SELECT id FROM pages WHERE summary = ''",
      ),
      pageTitles: this.db.prepare("SELECT id, title FROM pages ORDER BY title"),
      staleClaims: this.db.prepare(
        "SELECT * FROM claims WHERE last_reinforced < ? ORDER BY last_reinforced ASC",
      ),
      contestedClaims: this.db.prepare(`
        SELECT c.* FROM claims c
        WHERE EXISTS (SELECT 1 FROM claim_contradictions cc WHERE cc.claim_id = c.id)
        ORDER BY c.confidence ASC
      `),
      dependentsOf: this.db.prepare(`
        SELECT c.* FROM claims c
        JOIN claim_dependencies cd ON cd.claim_id = c.id
        WHERE cd.depends_on_claim_id = ?
      `),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- Sources ----

  addSource(source: Omit<Source, "id">): Source {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO sources (id, path, title, type, quality_tier, content_hash, ingested_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        source.path,
        source.title,
        source.type,
        source.qualityTier,
        source.contentHash,
        source.ingestedAt,
        JSON.stringify(source.metadata),
      );
    return { id, ...source };
  }

  getSourceByPath(path: string): Source | null {
    const row = this.stmts.getSourceByPath.get(path) as any;
    return row ? this.rowToSource(row) : null;
  }

  getSource(id: string): Source | null {
    const row = this.stmts.getSource.get(id) as any;
    return row ? this.rowToSource(row) : null;
  }

  updateSourceHash(id: string, contentHash: string): void {
    this.db
      .prepare(
        "UPDATE sources SET content_hash = ?, ingested_at = ? WHERE id = ?",
      )
      .run(contentHash, new Date().toISOString(), id);
  }

  listSources(): Source[] {
    return (this.stmts.allSources.all() as any[]).map((r) =>
      this.rowToSource(r),
    );
  }

  // ---- Pages ----

  addPage(
    title: string,
    path: string,
    summary: string = "",
    kind: string = "topic",
    metadata: Record<string, unknown> = {},
  ): WikiPage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO pages (id, title, path, summary, kind, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        title,
        path,
        summary,
        kind,
        JSON.stringify(metadata),
        now,
        now,
      );
    return {
      id,
      title,
      path,
      summary,
      kind,
      metadata: { ...metadata },
      claims: [],
      linksTo: [],
      linkedFrom: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  getPageByTitle(title: string): WikiPage | null {
    const row = this.stmts.getPageByTitle.get(title) as any;
    return row ? this.rowToPage(row) : null;
  }

  getPage(id: string): WikiPage | null {
    const row = this.stmts.getPageById.get(id) as any;
    return row ? this.rowToPage(row) : null;
  }

  updatePageSummary(id: string, summary: string): void {
    this.db
      .prepare("UPDATE pages SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, new Date().toISOString(), id);
  }

  updatePageKind(id: string, kind: string): void {
    this.db
      .prepare("UPDATE pages SET kind = ?, updated_at = ? WHERE id = ?")
      .run(kind, new Date().toISOString(), id);
  }

  updatePageMetadata(id: string, patch: Record<string, unknown>): void {
    const row = this.stmts.getPageById.get(id) as any;
    if (!row) return;
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(row.metadata_json || "{}");
    } catch {
      current = {};
    }
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "UPDATE pages SET metadata_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(next), new Date().toISOString(), id);
  }

  listPages(): WikiPage[] {
    return (this.stmts.allPages.all() as any[]).map((r) => this.rowToPage(r));
  }

  addPageLink(fromId: string, toId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO page_links (from_page_id, to_page_id) VALUES (?, ?)",
      )
      .run(fromId, toId);
  }

  // ---- Claims ----

  addClaim(opts: {
    statement: string;
    pageId: string;
    confidence: number;
    sourceIds: string[];
    decayRate?: number;
    tags?: string[];
  }): Claim {
    const id = randomUUID();
    const now = new Date().toISOString();
    const decayRate = opts.decayRate ?? 0.002;
    const tags = opts.tags ?? [];

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO claims (id, statement, page_id, confidence, first_stated, last_reinforced, decay_rate, tags_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          opts.statement,
          opts.pageId,
          opts.confidence,
          now,
          now,
          decayRate,
          JSON.stringify(tags),
        );

      for (const sid of opts.sourceIds) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO claim_sources (claim_id, source_id) VALUES (?, ?)",
          )
          .run(id, sid);
      }

      // Record creation event
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'created', ?, 0, ?, 'Claim first extracted')
      `,
        )
        .run(randomUUID(), id, now, opts.sourceIds[0] ?? null, opts.confidence);
    });

    insert();

    return {
      id,
      statement: opts.statement,
      pageId: opts.pageId,
      confidence: opts.confidence,
      sources: opts.sourceIds,
      firstStated: now,
      lastReinforced: now,
      contradictedBy: [],
      dependsOn: [],
      derivedClaims: [],
      decayRate,
      tags,
      timeline: [],
    };
  }

  getClaim(id: string): Claim | null {
    const row = this.stmts.getClaimById.get(id) as any;
    if (!row) return null;
    return this.rowToClaim(row);
  }

  getClaimsByPage(pageId: string): Claim[] {
    return (this.stmts.claimsByPage.all(pageId) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  updateClaimConfidence(id: string, confidence: number): void {
    this.db
      .prepare(
        "UPDATE claims SET confidence = ?, last_reinforced = ? WHERE id = ?",
      )
      .run(confidence, new Date().toISOString(), id);
  }

  reinforceClaim(
    claimId: string,
    sourceId: string,
    newConfidence: number,
    note: string = "",
  ): void {
    const claim = this.getClaim(claimId);
    if (!claim) return;

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE claims SET confidence = ?, last_reinforced = ? WHERE id = ?",
        )
        .run(newConfidence, now, claimId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO claim_sources (claim_id, source_id) VALUES (?, ?)",
        )
        .run(claimId, sourceId);
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'reinforced', ?, ?, ?, ?)
      `,
        )
        .run(
          randomUUID(),
          claimId,
          now,
          sourceId,
          claim.confidence,
          newConfidence,
          note,
        );
    })();
  }

  challengeClaim(
    claimId: string,
    sourceId: string,
    newConfidence: number,
    note: string,
  ): void {
    const claim = this.getClaim(claimId);
    if (!claim) return;

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE claims SET confidence = ? WHERE id = ?")
        .run(newConfidence, claimId);
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'challenged', ?, ?, ?, ?)
      `,
        )
        .run(
          randomUUID(),
          claimId,
          now,
          sourceId,
          claim.confidence,
          newConfidence,
          note,
        );
    })();
  }

  addClaimDependency(claimId: string, dependsOnId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO claim_dependencies (claim_id, depends_on_claim_id) VALUES (?, ?)",
      )
      .run(claimId, dependsOnId);
  }

  addClaimContradiction(claimId: string, contradictedById: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO claim_contradictions (claim_id, contradicted_by_claim_id) VALUES (?, ?)",
      )
      .run(claimId, contradictedById);
  }

  listClaims(opts?: {
    minConfidence?: number;
    maxConfidence?: number;
    pageId?: string;
  }): Claim[] {
    let sql = "SELECT * FROM claims WHERE 1=1";
    const params: any[] = [];
    if (opts?.minConfidence !== undefined) {
      sql += " AND confidence >= ?";
      params.push(opts.minConfidence);
    }
    if (opts?.maxConfidence !== undefined) {
      sql += " AND confidence <= ?";
      params.push(opts.maxConfidence);
    }
    if (opts?.pageId) {
      sql += " AND page_id = ?";
      params.push(opts.pageId);
    }
    sql += " ORDER BY confidence DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getStaleClaims(thresholdDays: number): Claim[] {
    const cutoff = new Date(
      Date.now() - thresholdDays * 86400000,
    ).toISOString();
    return (this.stmts.staleClaims.all(cutoff) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getContestedClaims(): Claim[] {
    return (this.stmts.contestedClaims.all() as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getDependents(claimId: string): Claim[] {
    return (this.stmts.dependentsOf.all(claimId) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  // ---- Epistemic Events ----

  getClaimTimeline(claimId: string): EpistemicEvent[] {
    return (this.stmts.claimTimeline.all(claimId) as any[]).map((r) =>
      this.rowToEvent(r),
    );
  }

  addEvent(event: Omit<EpistemicEvent, "id">): EpistemicEvent {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        event.claimId,
        event.date,
        event.type,
        event.triggerSourceId,
        event.confidenceBefore,
        event.confidenceAfter,
        event.note,
      );
    return { id, ...event };
  }

  // ---- Stats ----

  stats(): { sources: number; pages: number; claims: number; events: number } {
    return this.stmts.stats.get() as any;
  }

  // ---- Fast flat methods (no N+1) ----

  listClaimsFlat(): any[] {
    return (this.stmts.listClaimsFlat.all() as any[]).map((r) => ({
      id: r.id,
      statement: r.statement,
      pageId: r.page_id,
      confidence: r.confidence,
      sourceCount: r.source_count,
      contradictionCount: r.contradiction_count,
      dependencyCount: r.dependency_count,
      firstStated: r.first_stated,
      lastReinforced: r.last_reinforced,
      tags: JSON.parse(r.tags_json),
    }));
  }

  listPagesFlat(): any[] {
    return (this.stmts.listPagesFlat.all() as any[]).map((r) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(r.metadata_json || "{}");
      } catch {
        metadata = {};
      }
      return {
        id: r.id,
        title: r.title,
        path: r.path,
        summary: r.summary,
        kind: r.kind ?? "topic",
        metadata,
        claimCount: r.claim_count,
        linkCount: r.link_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  listEventsFlat(limit: number = 200): any[] {
    return (this.stmts.listEventsRecent.all(limit) as any[]).map((r) => ({
      id: r.id,
      claimId: r.claim_id,
      date: r.date,
      type: r.type,
      triggerSourceId: r.trigger_source_id,
      confidenceBefore: r.confidence_before,
      confidenceAfter: r.confidence_after,
      note: r.note,
      claimStatement: r.claim_statement,
    }));
  }

  search(query: string, limit: number = 20): { pages: any[]; claims: any[] } {
    const safeQ = query.replace(/[^a-zA-Z0-9\s]/g, "").trim();
    if (!safeQ) return { pages: [], claims: [] };
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "shall",
      "should",
      "may",
      "might",
      "must",
      "can",
      "could",
      "of",
      "in",
      "to",
      "for",
      "with",
      "on",
      "at",
      "from",
      "by",
      "about",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "out",
      "off",
      "over",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "both",
      "each",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "what",
      "which",
      "who",
      "whom",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "i",
      "me",
      "my",
      "we",
      "our",
      "you",
      "your",
      "he",
      "him",
      "his",
      "she",
      "her",
    ]);
    const words = safeQ
      .split(/\s+/)
      .filter((w) => !stopWords.has(w.toLowerCase()) && w.length > 1);
    if (words.length === 0) return { pages: [], claims: [] };
    const ftsQuery = words.map((w) => `${w}*`).join(" OR ");
    try {
      const pages = (this.stmts.searchPages.all(ftsQuery, limit) as any[]).map(
        (r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          type: "page" as const,
        }),
      );
      const claims = (
        this.stmts.searchClaims.all(ftsQuery, limit) as any[]
      ).map((r) => ({
        id: r.id,
        statement: r.statement,
        pageId: r.page_id,
        confidence: r.confidence,
        type: "claim" as const,
      }));
      return { pages, claims };
    } catch (e) {
      // FTS5 query syntax error — fall back to LIKE with individual words
      const likeConditions = words
        .map(() => "(title LIKE ? OR summary LIKE ?)")
        .join(" OR ");
      const likeParams = words.flatMap((w) => {
        const l = `%${w}%`;
        return [l, l];
      });
      const pages = (
        this.db
          .prepare(
            `SELECT id, title, summary FROM pages WHERE ${likeConditions} LIMIT ?`,
          )
          .all(...likeParams, limit) as any[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        type: "page" as const,
      }));
      const claimConditions = words.map(() => "statement LIKE ?").join(" OR ");
      const claimParams = words.map((w) => `%${w}%`);
      const claims = (
        this.db
          .prepare(
            `SELECT id, statement, page_id, confidence FROM claims WHERE ${claimConditions} LIMIT ?`,
          )
          .all(...claimParams, limit) as any[]
      ).map((r) => ({
        id: r.id,
        statement: r.statement,
        pageId: r.page_id,
        confidence: r.confidence,
        type: "claim" as const,
      }));
      return { pages, claims };
    }
  }

  getPageFull(id: string): { page: WikiPage; claims: any[] } | null {
    const page = this.getPage(id);
    if (!page) return null;
    const claims = (this.stmts.pageClaimsFull.all(id) as any[]).map((r) => ({
      id: r.id,
      statement: r.statement,
      confidence: r.confidence,
      sourceCount: r.source_count,
      firstStated: r.first_stated,
      lastReinforced: r.last_reinforced,
      tags: JSON.parse(r.tags_json),
    }));
    return { page, claims };
  }

  getClaimPageId(claimId: string): string | null {
    const row = this.stmts.getClaimPageId.get(claimId) as any;
    return row ? row.page_id : null;
  }

  listPageTitles(): { id: string; title: string }[] {
    return this.stmts.pageTitles.all() as any[];
  }

  listPagesWithoutSummary(): string[] {
    return (this.stmts.pagesWithoutSummary.all() as any[]).map((r) => r.id);
  }

  // ---- Mutations for dashboard editing ----

  deletePage(id: string): void {
    this.db.transaction(() => {
      // Delete claims on this page + their events, sources, deps, contradictions
      const claimIds = (
        this.db
          .prepare("SELECT id FROM claims WHERE page_id = ?")
          .all(id) as any[]
      ).map((r) => r.id);
      for (const cid of claimIds) {
        this.db
          .prepare("DELETE FROM epistemic_events WHERE claim_id = ?")
          .run(cid);
        this.db
          .prepare("DELETE FROM claim_sources WHERE claim_id = ?")
          .run(cid);
        this.db
          .prepare(
            "DELETE FROM claim_dependencies WHERE claim_id = ? OR depends_on_claim_id = ?",
          )
          .run(cid, cid);
        this.db
          .prepare(
            "DELETE FROM claim_contradictions WHERE claim_id = ? OR contradicted_by_claim_id = ?",
          )
          .run(cid, cid);
      }
      this.db.prepare("DELETE FROM claims WHERE page_id = ?").run(id);
      this.db
        .prepare(
          "DELETE FROM page_links WHERE from_page_id = ? OR to_page_id = ?",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
    })();
  }

  deleteClaim(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM epistemic_events WHERE claim_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM claim_sources WHERE claim_id = ?").run(id);
      this.db
        .prepare(
          "DELETE FROM claim_dependencies WHERE claim_id = ? OR depends_on_claim_id = ?",
        )
        .run(id, id);
      this.db
        .prepare(
          "DELETE FROM claim_contradictions WHERE claim_id = ? OR contradicted_by_claim_id = ?",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM claims WHERE id = ?").run(id);
    })();
  }

  updateClaimStatement(id: string, statement: string): void {
    this.db
      .prepare("UPDATE claims SET statement = ? WHERE id = ?")
      .run(statement, id);
  }

  deleteEmptyPages(): number {
    const emptyPages = this.db
      .prepare(
        "SELECT p.id FROM pages p LEFT JOIN claims c ON c.page_id = p.id GROUP BY p.id HAVING COUNT(c.id) = 0",
      )
      .all() as any[];
    for (const row of emptyPages) {
      this.db
        .prepare(
          "DELETE FROM page_links WHERE from_page_id = ? OR to_page_id = ?",
        )
        .run(row.id, row.id);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
    }
    return emptyPages.length;
  }

  // ---- Row mappers ----

  private rowToSource(row: any): Source {
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      type: row.type as SourceType,
      qualityTier: row.quality_tier as QualityTier,
      contentHash: row.content_hash,
      ingestedAt: row.ingested_at,
      metadata: JSON.parse(row.metadata_json),
    };
  }

  private rowToPage(row: any): WikiPage {
    const id = row.id;
    const claims = (this.stmts.pageClaimIds.all(id) as any[]).map((r) => r.id);
    const linksTo = (this.stmts.pageLinksTo.all(id) as any[]).map(
      (r) => r.to_page_id,
    );
    const linkedFrom = (this.stmts.pageLinkedFrom.all(id) as any[]).map(
      (r) => r.from_page_id,
    );
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
      metadata = {};
    }
    return {
      id,
      title: row.title,
      path: row.path,
      summary: row.summary,
      kind: row.kind ?? "topic",
      metadata,
      claims,
      linksTo,
      linkedFrom,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToClaim(row: any): Claim {
    const id = row.id;
    const sources = (this.stmts.claimSourceIds.all(id) as any[]).map(
      (r) => r.source_id,
    );
    const contradictedBy = (
      this.stmts.claimContradictions.all(id) as any[]
    ).map((r) => r.contradicted_by_claim_id);
    const dependsOn = (this.stmts.claimDependsOn.all(id) as any[]).map(
      (r) => r.depends_on_claim_id,
    );
    const derivedClaims = (this.stmts.claimDerived.all(id) as any[]).map(
      (r) => r.claim_id,
    );
    const timeline = this.getClaimTimeline(id);
    return {
      id,
      statement: row.statement,
      pageId: row.page_id,
      confidence: row.confidence,
      sources,
      firstStated: row.first_stated,
      lastReinforced: row.last_reinforced,
      contradictedBy,
      dependsOn,
      derivedClaims,
      decayRate: row.decay_rate,
      tags: JSON.parse(row.tags_json),
      timeline,
    };
  }

  private rowToEvent(row: any): EpistemicEvent {
    return {
      id: row.id,
      claimId: row.claim_id,
      date: row.date,
      type: row.type as EpistemicEventType,
      triggerSourceId: row.trigger_source_id,
      confidenceBefore: row.confidence_before,
      confidenceAfter: row.confidence_after,
      note: row.note,
    };
  }
}
