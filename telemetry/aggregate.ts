import type {
  Budget,
  MessageRow,
  ModelUsage,
  PartRow,
  RawTokens,
  SessionRow,
  SourceSnapshot,
  TelemetryEnvelopeV1,
  TokenCounts,
  ToolUsage,
} from "./types.ts";

const UNKNOWN_MODEL = "unknown/unknown";
const statuses = new Set(["pending", "running", "completed", "error"]);

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function modelOf(message: MessageRow | undefined): string {
  const provider = message?.providerId ?? "unknown";
  const model = message?.modelId ?? "unknown";
  return `${provider || "unknown"}/${model || "unknown"}`;
}

function dateOf(value: number | null, fallback: number | null): string | null {
  const timestamp = value ?? fallback;
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function tokenCounts(values: RawTokens[]): { tokens: TokenCounts; missing: number } {
  const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;
  const totals: Record<(typeof fields)[number], number | null> = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
  };
  let missing = 0;
  for (const raw of values) {
    const current = {
      input: nonnegative(raw.input),
      output: nonnegative(raw.output),
      reasoning: nonnegative(raw.reasoning),
      cacheRead: nonnegative(raw.cache?.read),
      cacheWrite: nonnegative(raw.cache?.write),
    };
    for (const field of fields) {
      if (current[field] === null) {
        totals[field] = null;
        missing += 1;
      } else if (totals[field] !== null) {
        totals[field] += current[field]!;
      }
    }
  }
  const reported = values.map((raw) => nonnegative(raw.total));
  const total = reported.every((value) => value !== null)
    ? reported.reduce((sum, value) => sum + value!, 0)
    : fields.every((field) => totals[field] !== null)
      ? fields.reduce((sum, field) => sum + totals[field]!, 0)
      : null;
  return { tokens: { ...totals, total }, missing };
}

function budget(limit: number | null, actual: number | null): Budget {
  if (limit === null) return { limit: null, actual, remaining: null, status: "unconfigured" };
  if (actual === null) return { limit, actual: null, remaining: null, status: "unknown" };
  const remaining = limit - actual;
  return { limit, actual, remaining, status: remaining < 0 ? "exceeded" : "within" };
}

function toolUsage(parts: PartRow[], messageIds: Set<string>): ToolUsage {
  const latest = new Map<string, PartRow>();
  for (const part of parts) {
    if (part.type !== "tool" || !part.messageId || !messageIds.has(part.messageId)) continue;
    const key = `${part.messageId}\0${part.callId ?? part.id}`;
    const prior = latest.get(key);
    if (!prior || (part.updatedMs ?? part.createdMs ?? 0) >= (prior.updatedMs ?? prior.createdMs ?? 0)) latest.set(key, part);
  }
  const result: ToolUsage = { calls: latest.size, completed: 0, failed: 0, unknown: 0, byName: {} };
  for (const part of latest.values()) {
    const name = part.tool ?? "unknown";
    result.byName[name] = (result.byName[name] ?? 0) + 1;
    if (part.status === "completed") result.completed += 1;
    else if (part.status === "error") result.failed += 1;
    else if (!statuses.has(part.status ?? "")) result.unknown += 1;
  }
  return result;
}

function mergeTools(left: ToolUsage, right: ToolUsage): ToolUsage {
  const byName = { ...left.byName };
  for (const [name, count] of Object.entries(right.byName)) byName[name] = (byName[name] ?? 0) + count;
  return { calls: left.calls + right.calls, completed: left.completed + right.completed, failed: left.failed + right.failed, unknown: left.unknown + right.unknown, byName };
}

function mergeTokenCounts(values: TokenCounts[]): TokenCounts {
  const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const;
  return Object.fromEntries(fields.map((field) => [field, values.every((value) => value[field] !== null) ? values.reduce((sum, value) => sum + value[field]!, 0) : null])) as unknown as TokenCounts;
}

function modelUsage(model: string, tokenValues: RawTokens[], costs: Array<number | null>): ModelUsage {
  const normalized = tokenCounts(tokenValues);
  return {
    model,
    tokens: normalized.tokens,
    recordedCost: costs.length > 0 && costs.every((value) => value !== null) ? costs.reduce((sum, value) => sum + value!, 0) : null,
    currency: "USD",
    pricing: { status: "unknown", source: null, asOf: null },
  };
}

export interface AggregateOptions {
  sessionBudget?: number;
  accountBudget?: number;
}

export function buildEnvelopes(snapshot: SourceSnapshot, options: AggregateOptions = {}): TelemetryEnvelopeV1[] {
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
  const finishIds = new Set(snapshot.parts.filter((part) => part.type === "step-finish" && part.messageId).map((part) => part.messageId!));
  const steps: Array<{ sessionId: string; model: string; date: string; message: MessageRow; source: RawTokens | null; cost: number | null; inherited: boolean }> = [];
  for (const message of snapshot.messages) {
    if (message.role !== "assistant") continue;
    const session = sessions.get(message.sessionId);
    const inherited = session?.createdMs !== null && session?.createdMs !== undefined && message.createdMs !== null && message.createdMs < session.createdMs;
    if (finishIds.has(message.id)) continue;
    const date = dateOf(message.completedMs ?? message.createdMs, session?.createdMs ?? null);
    if (!date) { snapshot.diagnostics.push({ code: "unknown_usage_date", message: "Usage row has no valid timestamp." }); continue; }
    steps.push({ sessionId: message.sessionId, model: modelOf(message), date, message, source: message.tokens, cost: message.cost, inherited: Boolean(inherited) });
  }
  for (const part of snapshot.parts.filter((part) => part.type === "step-finish" && part.messageId)) {
    const message = messages.get(part.messageId!);
    if (!message) continue;
    const session = sessions.get(message.sessionId);
    const inherited = session?.createdMs !== null && session?.createdMs !== undefined && message.createdMs !== null && message.createdMs < session.createdMs;
    const date = dateOf(part.createdMs ?? message.completedMs ?? message.createdMs, session?.createdMs ?? null);
    if (!date) { snapshot.diagnostics.push({ code: "unknown_usage_date", message: "Usage row has no valid timestamp." }); continue; }
    steps.push({ sessionId: message.sessionId, model: modelOf(message), date, message, source: part.tokens, cost: part.cost, inherited: Boolean(inherited) });
  }
  const groups = new Map<string, typeof steps>();
  const inheritedSessions = new Set(steps.filter((step) => step.inherited).map((step) => step.sessionId));
  for (const step of steps) {
    if (step.inherited) continue;
    const key = `${step.sessionId}\0${step.date}`;
    const group = groups.get(key) ?? [];
    group.push(step);
    groups.set(key, group);
  }
  const envelopes: TelemetryEnvelopeV1[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const modelNames = [...new Set(group.map((step) => step.model))].sort();
    const models = modelNames.map((model) => {
      const selected = group.filter((step) => step.model === model && step.source !== null);
      const missingSteps = group.filter((step) => step.model === model && step.source === null);
      const usage = selected.length > 0
        ? modelUsage(model, selected.map((step) => step.source!), selected.map((step) => step.cost))
        : modelUsage(model, missingSteps.map((step) => step.message.tokens ?? {}), missingSteps.map((step) => step.cost));
      if (missingSteps.length > 0) usage.tokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
      return usage;
    });
    const messageIds = new Set(group.map((step) => step.message.id));
    const tools = toolUsage(snapshot.parts, messageIds);
    const actualValues = models.map((model) => model.tokens.total);
    const actual = actualValues.every((value) => value !== null) ? actualValues.reduce((sum, value) => sum + value!, 0) : null;
    const warnings = snapshot.diagnostics.map((item) => item.code);
    if (group.some((step) => step.model === UNKNOWN_MODEL)) warnings.push("unknown_model");
    if (inheritedSessions.has(first.sessionId)) warnings.push("inherited_history_excluded");
    const missingTokenFields = models.reduce((sum, model) => sum + Object.values(model.tokens).filter((value) => value === null).length, 0);
    envelopes.push({
      schemaVersion: "telemetry.v1",
      product: "armoropencode",
      sessionId: first.sessionId,
      usageDate: first.date,
      models,
      tools,
      budgets: {
        session: budget(options.sessionBudget ?? null, actual),
        account: budget(options.accountBudget ?? null, null),
      },
      coverage: {
        source: "opencode.sqlite",
        sessionsScanned: 1,
        turnsScanned: group.length,
        modelsObserved: models.length,
        unknownModels: models.filter((model) => model.model === UNKNOWN_MODEL).length,
        missingTokenFields,
        historyComplete: snapshot.complete && !warnings.includes("inherited_history_excluded"),
        warnings: [...new Set(warnings)],
      },
    });
  }
  return envelopes.sort((left, right) => `${left.sessionId}\0${left.usageDate}`.localeCompare(`${right.sessionId}\0${right.usageDate}`));
}

export function mergeTokenValues(models: ModelUsage[]): TokenCounts {
  return mergeTokenCounts(models.map((model) => model.tokens));
}
