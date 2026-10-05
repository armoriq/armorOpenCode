export type Product = "armorclaude" | "armorcodex" | "armoropencode";

export interface TokenCounts {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
}

export type BudgetStatus = "within" | "exceeded" | "unconfigured" | "unknown";

export interface Budget {
  limit: number | null;
  actual: number | null;
  remaining: number | null;
  status: BudgetStatus;
}

export interface ModelUsage {
  model: string;
  tokens: TokenCounts;
  recordedCost: number | null;
  currency: "USD";
  pricing: { status: "unknown"; source: null; asOf: null };
}

export interface ToolUsage {
  calls: number;
  completed: number;
  failed: number;
  unknown: number;
  byName: Record<string, number>;
}

export interface Coverage {
  source: "opencode.sqlite";
  sessionsScanned: number;
  turnsScanned: number;
  modelsObserved: number;
  unknownModels: number;
  missingTokenFields: number;
  historyComplete: boolean;
  warnings: string[];
}

export interface TelemetryEnvelopeV1 {
  schemaVersion: "telemetry.v1";
  product: "armoropencode";
  sessionId: string;
  usageDate: string;
  models: ModelUsage[];
  tools: ToolUsage;
  budgets: { session: Budget; account: Budget };
  coverage: Coverage;
}

export interface SessionRow {
  id: string;
  parentId: string | null;
  createdMs: number | null;
  updatedMs: number | null;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: string | null;
  providerId: string | null;
  modelId: string | null;
  createdMs: number | null;
  completedMs: number | null;
  tokens: RawTokens | null;
  cost: number | null;
}

export interface RawTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  total?: unknown;
  cache?: { read?: unknown; write?: unknown };
}

export interface PartRow {
  id: string;
  sessionId: string | null;
  messageId: string | null;
  type: string | null;
  tool: string | null;
  callId: string | null;
  status: string | null;
  createdMs: number | null;
  updatedMs: number | null;
  startedMs: number | null;
  completedMs: number | null;
  tokens: RawTokens | null;
  cost: number | null;
}

export interface SourceDiagnostic {
  code: string;
  message: string;
  count?: number;
}

export interface SourceSnapshot {
  source: "opencode.sqlite";
  sessions: SessionRow[];
  messages: MessageRow[];
  parts: PartRow[];
  diagnostics: SourceDiagnostic[];
  complete: boolean;
}

export interface PendingRecord {
  key: string;
  modelKeys: string[];
  payloadHash: string;
  payload: TelemetryEnvelopeV1;
}
