import { sha256 } from "./state.ts";
import type { Budget, ModelUsage, TelemetryEnvelopeV1, TokenCounts, ToolUsage } from "./types.ts";

export type LiveEventKind =
  | "turn.started"
  | "model.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "turn.completed";

/** The live boundary intentionally has no prompt, argument, result, or path fields. */
export interface LiveEvent {
  kind: LiveEventKind;
  eventId?: string;
  sessionId: string;
  turnId: string;
  callId?: string;
  model?: string;
  toolName?: string;
  status?: string;
  atMs?: number;
  tokens?: Partial<TokenCounts>;
  recordedCost?: number | null;
}

export interface LiveDiagnostic {
  code: string;
  message: string;
}

export type LiveCoverage = Omit<TelemetryEnvelopeV1["coverage"], "source"> & { source: "opencode.live" };
export type LiveTelemetryRecord = Omit<TelemetryEnvelopeV1, "coverage"> & { coverage: LiveCoverage };

export interface LiveAdapterOptions {
  sessionBudget?: number;
  accountBudget?: number;
  clock?: () => number;
}

interface TurnState {
  sessionId: string;
  turnId: string;
  model: string;
  date: string;
}

interface ModelState {
  model: string;
  date: string;
  tokenValues: TokenCounts[];
  costs: Array<number | null>;
  turns: Set<string>;
}

interface ToolState {
  key: string;
  sessionId: string;
  date: string;
  name: string;
  model: string;
  status: "pending" | "running" | "completed" | "error" | "unknown";
}

const VALID_KINDS = new Set<LiveEventKind>([
  "turn.started", "model.completed", "tool.started", "tool.completed", "tool.failed", "turn.completed",
]);
const KNOWN_STATUSES = new Set(["pending", "running", "completed", "error"]);
const UNKNOWN_MODEL = "unknown/unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function dateOf(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function modelOf(value: unknown): string {
  return text(value) ?? UNKNOWN_MODEL;
}

function tokenValue(value: unknown): number | null {
  return integer(value);
}

function normalizeTokens(value: unknown): TokenCounts {
  const raw = isRecord(value) ? value : {};
  const cache = isRecord(raw.cache) ? raw.cache : {};
  const normalized: TokenCounts = {
    input: tokenValue(raw.input),
    output: tokenValue(raw.output),
    reasoning: tokenValue(raw.reasoning),
    cacheRead: tokenValue(raw.cacheRead ?? cache.read),
    cacheWrite: tokenValue(raw.cacheWrite ?? cache.write),
    total: tokenValue(raw.total),
  };
  if (normalized.total === null && [normalized.input, normalized.output, normalized.reasoning, normalized.cacheRead, normalized.cacheWrite].every((part) => part !== null)) {
    normalized.total = normalized.input! + normalized.output! + normalized.reasoning! + normalized.cacheRead! + normalized.cacheWrite!;
  }
  return normalized;
}

function budget(limit: number | undefined, actual: number | null): Budget {
  if (limit === undefined) return { limit: null, actual, remaining: null, status: "unconfigured" };
  if (actual === null) return { limit, actual: null, remaining: null, status: "unknown" };
  const remaining = limit - actual;
  return { limit, actual, remaining, status: remaining < 0 ? "exceeded" : "within" };
}

function blankTools(): ToolUsage {
  return { calls: 0, completed: 0, failed: 0, unknown: 0, byName: {} };
}

function eventFrom(value: unknown): LiveEvent | null {
  if (!isRecord(value) || !VALID_KINDS.has(value.kind as LiveEventKind)) return null;
  const sessionId = text(value.sessionId);
  const turnId = text(value.turnId);
  if (!sessionId || !turnId) return null;
  const event: LiveEvent = {
    kind: value.kind as LiveEventKind,
    sessionId,
    turnId,
  };
  const eventId = text(value.eventId);
  const callId = text(value.callId);
  const model = text(value.model);
  const toolName = text(value.toolName);
  const status = text(value.status);
  const atMs = integer(value.atMs);
  if (eventId) event.eventId = eventId;
  if (callId) event.callId = callId;
  if (model) event.model = model;
  if (toolName) event.toolName = toolName;
  if (status) event.status = status;
  if (atMs !== null) event.atMs = atMs;
  if (value.tokens !== undefined) event.tokens = value.tokens as Partial<TokenCounts>;
  if (typeof value.recordedCost === "number" && Number.isFinite(value.recordedCost) && value.recordedCost >= 0) event.recordedCost = value.recordedCost;
  else if (value.recordedCost === null) event.recordedCost = null;
  return event;
}

export class LiveTelemetryAdapter {
  private readonly turns = new Map<string, TurnState>();
  private readonly models = new Map<string, ModelState>();
  private readonly tools = new Map<string, ToolState>();
  private readonly seen = new Set<string>();
  private readonly diagnostics: LiveDiagnostic[] = [];
  private readonly options: LiveAdapterOptions;

  constructor(options: LiveAdapterOptions = {}) {
    this.options = options;
  }

  accept(value: unknown): void {
    const event = eventFrom(value);
    if (!event) {
      this.diagnostics.push({ code: "invalid_event", message: "Live telemetry event is missing a supported kind, session ID, or turn ID." });
      return;
    }
    const eventKey = event.eventId
      ? `event:${event.eventId}`
      : sha256({ kind: event.kind, sessionId: event.sessionId, turnId: event.turnId, callId: event.callId, model: event.model, toolName: event.toolName, status: event.status, atMs: event.atMs, tokens: event.tokens, recordedCost: event.recordedCost });
    if (this.seen.has(eventKey)) return;
    this.seen.add(eventKey);
    const atMs = event.atMs ?? this.options.clock?.() ?? Date.now();
    if (event.atMs === undefined) this.diagnostics.push({ code: "missing_timestamp", message: "Live event has no timestamp; receipt time was used for its UTC date." });
    const date = dateOf(atMs);
    const turnKey = `${event.sessionId}\0${event.turnId}`;
    const priorTurn = this.turns.get(turnKey);
    const turn: TurnState = priorTurn ?? { sessionId: event.sessionId, turnId: event.turnId, model: modelOf(event.model), date };
    if (event.model) turn.model = modelOf(event.model);
    this.turns.set(turnKey, turn);

    if (event.kind === "model.completed") {
      const model = modelOf(event.model ?? turn.model);
      turn.model = model;
      const key = `${event.sessionId}\0${date}\0${model}`;
      const state = this.models.get(key) ?? { model, date, tokenValues: [], costs: [], turns: new Set<string>() };
      state.tokenValues.push(normalizeTokens(event.tokens));
      state.costs.push(event.recordedCost ?? null);
      state.turns.add(turnKey);
      this.models.set(key, state);
      return;
    }

    if (event.kind === "tool.started" || event.kind === "tool.completed" || event.kind === "tool.failed") {
      const callId = event.callId ?? sha256({ sessionId: event.sessionId, turnId: event.turnId, kind: event.kind, atMs, toolName: event.toolName });
      const key = `${event.sessionId}\0${event.turnId}\0${callId}`;
      const priorTool = this.tools.get(key);
      const status = event.kind === "tool.failed" ? "error" : event.kind === "tool.completed" ? "completed" : "running";
      this.tools.set(key, {
        key,
        sessionId: event.sessionId,
        date: priorTool?.date ?? date,
        name: event.toolName ?? priorTool?.name ?? "unknown",
        model: modelOf(event.model ?? turn.model),
        status: priorTool?.status === "error" ? "error" : status,
      });
    }
  }

  diagnosticsSnapshot(): LiveDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  records(): LiveTelemetryRecord[] {
    const groups = new Map<string, { sessionId: string; date: string }>();
    for (const turn of this.turns.values()) groups.set(`${turn.sessionId}\0${turn.date}`, { sessionId: turn.sessionId, date: turn.date });
    for (const model of this.models.values()) {
      const turn = [...model.turns][0];
      const sessionId = turn ? this.turns.get(turn)?.sessionId : undefined;
      if (sessionId) groups.set(`${sessionId}\0${model.date}`, { sessionId, date: model.date });
    }
    for (const tool of this.tools.values()) groups.set(`${tool.sessionId}\0${tool.date}`, { sessionId: tool.sessionId, date: tool.date });

    const records: LiveTelemetryRecord[] = [];
    for (const group of groups.values()) {
      const turnKeys = [...this.turns.values()].filter((turn) => turn.sessionId === group.sessionId && turn.date === group.date).map((turn) => `${turn.sessionId}\0${turn.turnId}`);
      const models = [...this.models.values()].filter((model) => {
        const turn = [...model.turns][0];
        return model.date === group.date && turnKeys.includes(turn ?? "");
      }).map((model): ModelUsage => {
        const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const;
        const tokens = Object.fromEntries(fields.map((field) => [field, model.tokenValues.every((value) => value[field] !== null) ? model.tokenValues.reduce((sum, value) => sum + value[field]!, 0) : null])) as unknown as TokenCounts;
        const recordedCost = model.costs.length > 0 && model.costs.every((cost) => cost !== null) ? model.costs.reduce((sum, cost) => sum + cost!, 0) : null;
        return { model: model.model, tokens, recordedCost, currency: "USD", pricing: { status: "unknown", source: null, asOf: null } };
      });
      const selectedTools = [...this.tools.values()].filter((tool) => tool.sessionId === group.sessionId && tool.date === group.date);
      const tools = blankTools();
      for (const tool of selectedTools) {
        tools.calls += 1;
        tools.byName[tool.name] = (tools.byName[tool.name] ?? 0) + 1;
        if (tool.status === "completed") tools.completed += 1;
        else if (tool.status === "error") tools.failed += 1;
        else tools.unknown += 1;
      }
      const totals = models.map((model) => model.tokens.total);
      const actual = totals.length > 0 && totals.every((total) => total !== null) ? totals.reduce((sum, total) => sum + total!, 0) : null;
      const warnings = this.diagnostics.map((item) => item.code);
      if (models.some((model) => model.model === UNKNOWN_MODEL)) warnings.push("unknown_model");
      if (selectedTools.some((tool) => tool.name === "unknown" || tool.status === "unknown")) warnings.push("unknown_tool");
      records.push({
        schemaVersion: "telemetry.v1",
        product: "armoropencode",
        sessionId: group.sessionId,
        usageDate: group.date,
        models,
        tools,
        budgets: { session: budget(this.options.sessionBudget, actual), account: budget(this.options.accountBudget, null) },
        coverage: {
          source: "opencode.live",
          sessionsScanned: 1,
          turnsScanned: turnKeys.length,
          modelsObserved: models.length,
          unknownModels: models.filter((model) => model.model === UNKNOWN_MODEL).length,
          missingTokenFields: models.reduce((sum, model) => sum + Object.values(model.tokens).filter((value) => value === null).length, 0),
          historyComplete: this.diagnostics.length === 0,
          warnings: [...new Set(warnings)],
        },
      });
    }
    return records.sort((left, right) => `${left.sessionId}\0${left.usageDate}`.localeCompare(`${right.sessionId}\0${right.usageDate}`));
  }
}

export function createLiveTelemetryAdapter(options: LiveAdapterOptions = {}): LiveTelemetryAdapter {
  return new LiveTelemetryAdapter(options);
}
