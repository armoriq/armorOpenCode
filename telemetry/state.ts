import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PendingRecord, TelemetryEnvelopeV1 } from "./types.ts";

type WalEvent =
  | { kind: "upsert"; key: string; modelKeys: string[]; payloadHash: string; payload: TelemetryEnvelopeV1; at: string }
  | { kind: "ack"; key: string; payloadHash: string; at: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

export function modelRecordKey(sessionId: string, usageDate: string, model: string): string {
  return sha256(`telemetry.v1\0armoropencode\0${sessionId}\0${usageDate}\0${model}`);
}

export function batchKey(payload: TelemetryEnvelopeV1): string {
  return sha256(`telemetry.v1\0armoropencode\0${payload.sessionId}\0${payload.usageDate}`);
}

function privacyErrors(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => privacyErrors(child, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const forbidden = new Set(["prompt", "promptText", "reasoningText", "toolInput", "toolOutput", "arguments", "result", "repositoryPath", "apiKey", "ownerId", "email", "hostname", "machineId"]);
  const errors: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) errors.push(`${path}.${key}`);
    errors.push(...privacyErrors(child, `${path}.${key}`));
  }
  return errors;
}

export function validatePrivacy(payload: TelemetryEnvelopeV1): void {
  const errors = privacyErrors(payload);
  if (errors.length > 0) throw new Error(`Telemetry payload contains private fields: ${errors.join(", ")}`);
}

export function pendingRecords(payloads: TelemetryEnvelopeV1[]): PendingRecord[] {
  return payloads.map((payload) => {
    validatePrivacy(payload);
    return {
      key: batchKey(payload),
      modelKeys: payload.models.map((model) => modelRecordKey(payload.sessionId, payload.usageDate, model.model)),
      payloadHash: sha256(payload),
      payload,
    };
  });
}

function readEvents(path: string): { events: WalEvent[]; malformed: number } {
  if (!existsSync(path)) return { events: [], malformed: 0 };
  let malformed = 0;
  const events: WalEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && ((value as WalEvent).kind === "upsert" || (value as WalEvent).kind === "ack")) events.push(value as WalEvent);
      else malformed += 1;
    } catch { malformed += 1; }
  }
  return { events, malformed };
}

export class LocalState {
  readonly path: string;
  constructor(path = defaultStatePath()) { this.path = path; }

  private append(event: WalEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  reconcile(records: PendingRecord[]): { added: number; unchanged: number; malformed: number } {
    const current = new Map<string, { hash: string; acked: boolean }>();
    const parsed = readEvents(this.path);
    for (const event of parsed.events) {
      if (event.kind === "upsert") current.set(event.key, { hash: event.payloadHash, acked: false });
      else if (current.get(event.key)?.hash === event.payloadHash) current.set(event.key, { hash: event.payloadHash, acked: true });
    }
    let added = 0;
    let unchanged = 0;
    for (const record of records) {
      const known = current.get(record.key);
      if (known?.hash === record.payloadHash) { unchanged += 1; continue; }
      this.append({ kind: "upsert", ...record, at: new Date().toISOString() });
      current.set(record.key, { hash: record.payloadHash, acked: false });
      added += 1;
    }
    return { added, unchanged, malformed: parsed.malformed };
  }

  pending(): PendingRecord[] {
    const current = new Map<string, PendingRecord>();
    const acknowledged = new Set<string>();
    for (const event of readEvents(this.path).events) {
      if (event.kind === "upsert") { current.set(event.key, { key: event.key, modelKeys: event.modelKeys, payloadHash: event.payloadHash, payload: event.payload }); acknowledged.delete(event.key); }
      else if (current.get(event.key)?.payloadHash === event.payloadHash) acknowledged.add(event.key);
    }
    return [...current.values()].filter((record) => !acknowledged.has(record.key));
  }

  acknowledge(record: PendingRecord): void {
    this.append({ kind: "ack", key: record.key, payloadHash: record.payloadHash, at: new Date().toISOString() });
  }

  compact(): void {
    const temp = `${this.path}.tmp-${process.pid}`;
    const parsed = readEvents(this.path);
    const latest = new Map<string, WalEvent & { kind: "upsert" }>();
    const acknowledged = new Set<string>();
    for (const event of parsed.events) {
      if (event.kind === "upsert") {
        latest.set(event.key, event);
        acknowledged.delete(event.key);
      } else if (latest.get(event.key)?.payloadHash === event.payloadHash) {
        acknowledged.add(event.key);
      }
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const lines: string[] = [];
    for (const event of latest.values()) {
      lines.push(JSON.stringify({ ...event, at: new Date().toISOString() }));
      if (acknowledged.has(event.key)) lines.push(JSON.stringify({ kind: "ack", key: event.key, payloadHash: event.payloadHash, at: new Date().toISOString() }));
    }
    writeFileSync(temp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    renameSync(temp, this.path);
  }
}

export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "armoropencode", "telemetry.ndjson");
}
