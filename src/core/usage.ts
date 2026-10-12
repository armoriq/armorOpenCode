import { createHash } from "node:crypto";
import type { SessionID, StepUsage, TokenUsageEntry } from "../types.ts";

// SDK 0.8.16 usage_sync limits, pinned here so this module never loads the SDK; test/core/usage.test.ts checks them.
export const MAX_BATCH_SNAPSHOTS = 100;
export const MAX_BATCH_ENTRIES = 500;
export const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_CALL_SESSIONS = 100;
const MAX_REPO_CHARS = 200;

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// A step-finish part carries that step's tokens; message.tokens holds only the last step.
// OpenCode reports reasoning separately from output; ArmorCodex counts reasoning inside outputTokens, so it is added back.
export function stepUsageFromPart(
  part: unknown,
  modelOf: (messageId: string) => string | null,
  repo: string,
  at: number = Date.now(),
): StepUsage | null {
  if (!isStepFinish(part)) return null;
  const t = part.tokens ?? {};
  const entry: TokenUsageEntry = {
    model: modelOf(part.messageID) ?? "unknown",
    inputTokens: count(t.input),
    outputTokens: count(t.output) + count(t.reasoning),
    cacheReadTokens: count(t.cache?.read),
    cacheWriteTokens: count(t.cache?.write),
  };
  if (entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens === 0) return null;
  const reasoningTokens = count(t.reasoning);
  return { sessionId: part.sessionID as SessionID, messageId: part.messageID, partId: part.id, at, repo, entry, reasoningTokens };
}

type StepFinish = { id: string; sessionID: string; messageID: string; tokens?: Record<string, any> };

function isStepFinish(part: unknown): part is StepFinish {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return p.type === "step-finish" && typeof p.id === "string" && typeof p.sessionID === "string" && typeof p.messageID === "string";
}

export type HourKey = { sessionId: SessionID; usageDate: string; usageHour: number };

export type HourBucket = HourKey & { repo: string; entries: TokenUsageEntry[]; digest: string };

export type UsageSnapshot = {
  sessionId: string;
  usageDate: string;
  usageHour: number;
  revision: number;
  armored: true;
  repo?: string;
  entries: TokenUsageEntry[];
};

export const hourKey = (h: { usageDate: string; usageHour: number }) =>
  `${h.usageDate}T${String(h.usageHour).padStart(2, "0")}`;

export const entriesDigest = (entries: readonly TokenUsageEntry[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");

const hourOf = (at: number) => {
  const iso = new Date(at).toISOString();
  return { usageDate: iso.slice(0, 10), usageHour: Number(iso.slice(11, 13)) };
};

const sessionHour = (sessionId: string, h: { usageDate: string; usageHour: number }) => `${sessionId}\n${hourKey(h)}`;

export function bucketByHour(steps: readonly StepUsage[]): HourBucket[] {
  const hours = new Map<string, { key: HourKey; repo: string; models: Map<string, TokenUsageEntry> }>();
  for (const step of steps) {
    const key: HourKey = { sessionId: step.sessionId, ...hourOf(step.at) };
    const id = sessionHour(key.sessionId, key);
    let hour = hours.get(id);
    if (!hour) hours.set(id, (hour = { key, repo: step.repo, models: new Map() }));
    const sum = hour.models.get(step.entry.model);
    if (!sum) hour.models.set(step.entry.model, { ...step.entry });
    else {
      sum.inputTokens += step.entry.inputTokens;
      sum.outputTokens += step.entry.outputTokens;
      sum.cacheReadTokens += step.entry.cacheReadTokens;
      sum.cacheWriteTokens += step.entry.cacheWriteTokens;
    }
  }
  return [...hours.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { key, repo, models }]) => {
      const entries = [...models.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
      return { ...key, repo, entries, digest: entriesDigest(entries) };
    });
}

export function changedBuckets(buckets: readonly HourBucket[], known: Readonly<Record<string, string>>): HourBucket[] {
  return buckets.filter((b) => known[hourKey(b)] !== b.digest);
}

export function toSnapshots(buckets: readonly HourBucket[], revision: number): UsageSnapshot[] {
  return buckets.map((b) => ({
    sessionId: b.sessionId,
    usageDate: b.usageDate,
    usageHour: b.usageHour,
    revision,
    armored: true,
    ...(b.repo ? { repo: clipRepo(b.repo) } : {}),
    entries: b.entries,
  }));
}

function clipRepo(repo: string): string {
  const cut = repo.slice(0, MAX_REPO_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type UsageCallRecord = TokenUsageEntry & { key: string; reasoningOutputTokens: number; occurredAt: string };

export type UsageCallSession = { sessionId: string; armored: true; repo?: string; records: UsageCallRecord[] };

export type UsageParts = { snapshots: UsageSnapshot[]; calls: UsageCallSession[] };

export const callKey = (step: Pick<StepUsage, "messageId" | "partId">) => `${step.messageId}:${step.partId}`;

const recordCount = (calls: readonly UsageCallSession[]) => calls.reduce((n, c) => n + c.records.length, 0);

function callSessions(steps: readonly StepUsage[]): UsageCallSession[] {
  const [first] = steps;
  if (!first) return [];
  const records = steps.map((s) => ({
    key: callKey(s),
    ...s.entry,
    reasoningOutputTokens: s.reasoningTokens,
    occurredAt: new Date(s.at).toISOString(),
  }));
  return [{ sessionId: first.sessionId, armored: true, ...(first.repo ? { repo: clipRepo(first.repo) } : {}), records }];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Each changed session-hour's snapshot travels with that hour's new call records; records of an
// unchanged hour, and an hour's records beyond one batch, travel without a snapshot.
export function toParts(snapshots: readonly UsageSnapshot[], steps: readonly StepUsage[]): UsageParts[] {
  const byHour = new Map<string, StepUsage[]>();
  for (const s of steps) {
    const id = sessionHour(s.sessionId, hourOf(s.at));
    const list = byHour.get(id);
    if (list) list.push(s);
    else byHour.set(id, [s]);
  }
  const parts: UsageParts[] = [];
  for (const snapshot of snapshots) {
    const id = sessionHour(snapshot.sessionId, snapshot);
    const [first = [], ...rest] = chunks(byHour.get(id) ?? [], MAX_BATCH_ENTRIES);
    byHour.delete(id);
    parts.push({ snapshots: [snapshot], calls: callSessions(first) });
    for (const c of rest) parts.push({ snapshots: [], calls: callSessions(c) });
  }
  for (const left of byHour.values()) for (const c of chunks(left, MAX_BATCH_ENTRIES)) parts.push({ snapshots: [], calls: callSessions(c) });
  return parts;
}

// A refused batch is resent one session-hour at a time, each snapshot with its own hour's records.
export function splitParts(batch: UsageParts): UsageParts[] {
  let left = batch.calls;
  const inHour = (r: UsageCallRecord, s: UsageSnapshot) => hourKey(hourOf(Date.parse(r.occurredAt))) === hourKey(s);
  const parts = batch.snapshots.map((snapshot) => {
    const own = left.filter((c) => c.sessionId === snapshot.sessionId);
    const calls = own.map((c) => ({ ...c, records: c.records.filter((r) => inHour(r, snapshot)) })).filter((c) => c.records.length);
    left = left.map((c) => (c.sessionId === snapshot.sessionId ? { ...c, records: c.records.filter((r) => !inHour(r, snapshot)) } : c));
    return { snapshots: [snapshot], calls };
  });
  return [...parts, ...left.filter((c) => c.records.length).map((c) => ({ snapshots: [], calls: [c] }))];
}

export function packBatches(parts: readonly UsageParts[], overheadBytes = 512): UsageParts[] {
  const batches: UsageParts[] = [];
  let current: UsageParts = { snapshots: [], calls: [] };
  let entries = 0;
  let records = 0;
  let bytes = overheadBytes;
  for (const p of parts) {
    const size = Buffer.byteLength(JSON.stringify(p)) + 1;
    const partEntries = p.snapshots.reduce((n, s) => n + s.entries.length, 0);
    const partRecords = recordCount(p.calls);
    const full =
      current.snapshots.length + p.snapshots.length > MAX_BATCH_SNAPSHOTS ||
      current.calls.length + p.calls.length > MAX_BATCH_CALL_SESSIONS ||
      entries + partEntries > MAX_BATCH_ENTRIES ||
      records + partRecords > MAX_BATCH_ENTRIES ||
      bytes + size > MAX_BATCH_BYTES;
    if (full && (current.snapshots.length || current.calls.length)) {
      batches.push(current);
      current = { snapshots: [], calls: [] };
      entries = records = 0;
      bytes = overheadBytes;
    }
    current.snapshots.push(...p.snapshots);
    current.calls.push(...p.calls);
    entries += partEntries;
    records += partRecords;
    bytes += size;
  }
  if (current.snapshots.length || current.calls.length) batches.push(current);
  return batches;
}
