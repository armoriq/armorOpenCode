import { createLiveTelemetryAdapter, type LiveEvent, type LiveTelemetryAdapter } from "./live.ts";
import { LocalState, defaultStatePath, pendingRecords } from "./state.ts";
import { createHttpTelemetryTransport, type HttpTelemetryTransport } from "./http.ts";

type JsonRecord = Record<string, unknown>;
type PluginInput = { directory?: string };
type OpenCodePlugin = (input: PluginInput) => Promise<{ event: (input: { event: unknown }) => Promise<void> }>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function modelName(info: JsonRecord | undefined): string | undefined {
  const provider = text(info?.providerID) ?? "unknown";
  const model = text(info?.modelID) ?? "unknown";
  return `${provider}/${model}`;
}

function eventId(event: JsonRecord, suffix: string): string | undefined {
  const id = text(event.id);
  return id ? `${id}:${suffix}` : undefined;
}

function statePath(env: Record<string, string | undefined>): string {
  return env.ARMORIQ_OPENCODE_STATE ?? defaultStatePath(env);
}

function budget(env: Record<string, string | undefined>, key: string): number | undefined {
  const value = env[key];
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

export function liveEvents(event: JsonRecord): LiveEvent[] {
  const properties = record(event.properties) ?? {};
  const type = text(event.type);
  if (!type) return [];
  const sessionId = text(properties.sessionID);
  if (!sessionId) return [];
  const atMs = number(properties.time) ?? number(properties.atMs);
  if (type === "message.updated") {
    const info = record(properties.info);
    if (text(info?.role) !== "assistant") return [];
    const turnId = text(info?.id);
    if (!turnId) return [];
    const time = record(info?.time);
    const created = number(time?.created);
    const completed = number(time?.completed);
    const result: LiveEvent[] = [];
    if (created !== undefined) result.push({ kind: "turn.started", eventId: eventId(event, `${turnId}:start`), sessionId, turnId, model: modelName(info ?? undefined), atMs: created });
    if (completed !== undefined) {
      result.push({
        kind: "model.completed",
        eventId: eventId(event, `${turnId}:model`),
        sessionId,
        turnId,
        model: modelName(info ?? undefined),
        atMs: completed,
        tokens: record(info?.tokens) as LiveEvent["tokens"],
        recordedCost: typeof info?.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : null,
      });
      result.push({ kind: "turn.completed", eventId: eventId(event, `${turnId}:end`), sessionId, turnId, model: modelName(info ?? undefined), atMs: completed });
    }
    return result;
  }
  if (type === "message.part.updated") {
    const part = record(properties.part);
    if (text(part?.type) !== "tool") return [];
    const state = record(part?.state);
    const status = text(state?.status);
    const turnId = text(part?.messageID) ?? text(properties.messageID);
    const callId = text(part?.callID);
    if (!turnId || !callId) return [];
    const toolName = text(part?.tool) ?? "unknown";
    if (status === "pending" || status === "running") return [{ kind: "tool.started", eventId: eventId(event, `${callId}:start`), sessionId, turnId, callId, toolName, status, atMs }];
    if (status === "completed") return [{ kind: "tool.completed", eventId: eventId(event, `${callId}:complete`), sessionId, turnId, callId, toolName, status, atMs }];
    if (status === "error") return [{ kind: "tool.failed", eventId: eventId(event, `${callId}:error`), sessionId, turnId, callId, toolName, status, atMs }];
  }
  return [];
}

export const ArmorOpenCodeTelemetryPlugin: OpenCodePlugin = async () => {
  const env = process.env;
  const state = new LocalState(statePath(env));
  const adapters = new Map<string, LiveTelemetryAdapter>();
  const transport: HttpTelemetryTransport | null = env.ARMORIQ_OPENCODE_UPLOAD === "1" && env.ARMORIQ_API_KEY
    ? createHttpTelemetryTransport({ endpoint: env.ARMORIQ_TELEMETRY_URL, apiKey: env.ARMORIQ_API_KEY })
    : null;
  const adapterFor = (sessionId: string): LiveTelemetryAdapter => {
    const existing = adapters.get(sessionId);
    if (existing) return existing;
    const adapter = createLiveTelemetryAdapter({ sessionBudget: budget(env, "ARMORIQ_SESSION_BUDGET"), accountBudget: budget(env, "ARMORIQ_TOTAL_BUDGET") });
    adapters.set(sessionId, adapter);
    return adapter;
  };
  const flush = async (sessionId: string): Promise<void> => {
    const adapter = adapters.get(sessionId);
    if (!adapter) return;
    const records = pendingRecords(adapter.records());
    if (records.length === 0) return;
    state.reconcile(records);
    if (!transport) return;
    const pending = state.pending();
    const result = await transport.send(pending);
    if (result.ok) for (const item of pending.slice(0, result.accepted)) state.acknowledge(item);
  };
  return {
    event: async ({ event }: { event: unknown }) => {
      const raw = record(event);
      if (!raw) return;
      const properties = record(raw.properties);
      const sessionId = text(properties?.sessionID);
      if (!sessionId) return;
      const adapter = adapterFor(sessionId);
      for (const item of liveEvents(raw)) adapter.accept(item);
      if (text(raw.type) === "session.idle" || (text(raw.type) === "session.status" && text(record(properties?.status)?.type) === "idle")) await flush(sessionId);
    },
  };
};

export default ArmorOpenCodeTelemetryPlugin;
