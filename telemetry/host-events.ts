import type { LiveEvent } from "./live.ts";

type JsonRecord = Record<string, unknown>;

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

export function liveEvents(event: JsonRecord): LiveEvent[] {
  const properties = record(event.properties) ?? {};
  const type = text(event.type);
  if (!type) return [];
  const sessionId = sessionOf(event);
  if (!sessionId) return [];
  let atMs = number(properties.time) ?? number(properties.atMs);
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
        eventId: `${turnId}:model`,
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
    const time = record(state?.time);
    const status = text(state?.status);
    atMs ??= number(time?.end) ?? number(time?.start);
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

export function sessionOf(event: JsonRecord): string | null {
  const properties = record(event.properties);
  return text(record(properties?.info)?.sessionID)
    ?? text(record(properties?.part)?.sessionID)
    ?? text(properties?.sessionID);
}
