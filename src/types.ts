// ============================================================
// Quicky Wiki — Core Types
// ============================================================

// --- Source ---
export type SourceType =
  | "article"
  | "paper"
  | "repo"
  | "dataset"
  | "image"
  | "note"
  | "book"
  | "video"
  | "other";
export type QualityTier =
  | "peer-reviewed"
  | "official-docs"
  | "book"
  | "blog"
  | "social"
  | "unknown";

export interface Source {
  id: string;
  path: string;
  title: string;
  type: SourceType;
  qualityTier: QualityTier;
  contentHash: string;
  ingestedAt: string; // ISO date
  metadata: Record<string, unknown>;
}

// --- Claim ---
export type EpistemicEventType =
  | "created"
  | "reinforced"
  | "challenged"
  | "weakened"
  | "superseded"
  | "resolved";

export interface EpistemicEvent {
  id: string;
  claimId: string;
  date: string; // ISO date
  type: EpistemicEventType;
  triggerSourceId: string | null;
  confidenceBefore: number;
  confidenceAfter: number;
  note: string;
}

export interface Claim {
  id: string;
  statement: string;
  pageId: string;
  confidence: number; // 0.0 - 1.0
  sources: string[]; // source IDs
  firstStated: string; // ISO date
  lastReinforced: string; // ISO date
  contradictedBy: string[]; // claim IDs
  dependsOn: string[]; // claim IDs
  derivedClaims: string[]; // claim IDs
  decayRate: number; // confidence loss per day without reinforcement
  tags: string[];
  timeline: EpistemicEvent[];
}

// --- Wiki Page ---
export interface WikiPage {
  id: string;
  title: string;
  path: string; // relative path within wiki/
  summary: string;
  claims: string[]; // claim IDs
  linksTo: string[]; // page IDs
  linkedFrom: string[]; // page IDs
  createdAt: string;
  updatedAt: string;
}

// --- Knowledge Diff ---
export interface KnowledgeDiff {
  sourceId: string;
  sourceTitle: string;
  reinforced: Array<{
    claimId: string;
    statement: string;
    confidenceBefore: number;
    confidenceAfter: number;
  }>;
  challenged: Array<{
    claimId: string;
    statement: string;
    confidenceBefore: number;
    confidenceAfter: number;
    reason: string;
    downstreamAffected: number;
  }>;
  newConcepts: Array<{
    pageId: string;
    title: string;
    linkedTo: string[];
  }>;
  newClaims: Array<{
    claimId: string;
    statement: string;
    confidence: number;
  }>;
  gapsIdentified: Array<{
    concept: string;
    reason: string;
    suggestedSources: string[];
  }>;
}

// --- Health Report ---
export interface HealthReport {
  totalClaims: number;
  highConfidence: number; // > 0.8
  mediumConfidence: number; // 0.4 - 0.8
  lowConfidence: number; // < 0.4
  staleClaims: Array<{
    claimId: string;
    statement: string;
    lastReinforced: string;
    daysSince: number;
  }>;
  contestedClaims: Array<{
    claimId: string;
    statement: string;
    contradictions: number;
  }>;
  cascadeRisks: Array<{
    claimId: string;
    statement: string;
    dependents: number;
    confidence: number;
  }>;
  gaps: Array<{ concept: string; references: number }>;
  suggestedActions: string[];
}

// --- LLM ---
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMAdapter {
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  name: string;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}

// --- Config ---
export type LLMProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "openai-compatible";

export interface QuickyConfig {
  name: string;
  llm: {
    provider: LLMProvider;
    model: string;
    apiKey?: string; // resolved from env if not set
    baseUrl?: string; // for openai-compatible, ollama, or custom endpoints
    apiKeyEnv?: string; // env var name to read API key from (e.g. 'GROQ_API_KEY')
  };
  paths: {
    raw: string;
    wiki: string;
    data: string; // .quicky/
  };
  metabolism: {
    decayRateDefault: number; // confidence loss per day
    staleThresholdDays: number;
    resurfaceIntervalDays: number;
  };
  qualityWeights: Record<QualityTier, number>;
}

export const DEFAULT_CONFIG: QuickyConfig = {
  name: "My Wiki",
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    baseUrl: undefined,
    apiKeyEnv: undefined,
  },
  paths: {
    raw: "raw",
    wiki: "wiki",
    data: ".quicky",
  },
  metabolism: {
    decayRateDefault: 0.002, // ~0.2% per day ≈ loses ~50% in a year without reinforcement
    staleThresholdDays: 30,
    resurfaceIntervalDays: 14,
  },
  qualityWeights: {
    "peer-reviewed": 1.0,
    "official-docs": 0.9,
    book: 0.85,
    blog: 0.5,
    social: 0.3,
    unknown: 0.4,
  },
};

// --- Render Targets ---
export type RenderTarget =
  | "markdown"
  | "slides"
  | "anki"
  | "graph"
  | "timeline"
  | "article"
  | "training-data";
