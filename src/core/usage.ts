import { createHash } from "node:crypto";
import type { SessionID, StepUsage, TokenUsageEntry } from "../types.ts";

// SDK 0.8.13 usage_sync limits, pinned here so this module never loads the SDK; test/core/usage.test.ts checks them.
export const MAX_BATCH_SNAPSHOTS = 100;
export const MAX_BATCH_ENTRIES = 500;
export const MAX_BATCH_BYTES = 256 * 1024;
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
  return { sessionId: part.sessionID as SessionID, messageId: part.messageID, partId: part.id, at, repo, entry };
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

export function bucketByHour(steps: readonly StepUsage[]): HourBucket[] {
  const hours = new Map<string, { key: HourKey; repo: string; models: Map<string, TokenUsageEntry> }>();
  for (const step of steps) {
    const iso = new Date(step.at).toISOString();
    const key: HourKey = { sessionId: step.sessionId, usageDate: iso.slice(0, 10), usageHour: Number(iso.slice(11, 13)) };
    const id = `${key.sessionId}\n${hourKey(key)}`;
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

export function packBatches(snapshots: readonly UsageSnapshot[], overheadBytes = 512): UsageSnapshot[][] {
  const batches: UsageSnapshot[][] = [];
  let current: UsageSnapshot[] = [];
  let entries = 0;
  let bytes = overheadBytes;
  for (const s of snapshots) {
    const size = Buffer.byteLength(JSON.stringify(s)) + 1;
    const full =
      current.length === MAX_BATCH_SNAPSHOTS || entries + s.entries.length > MAX_BATCH_ENTRIES || bytes + size > MAX_BATCH_BYTES;
    if (full && current.length) {
      batches.push(current);
      current = [];
      entries = 0;
      bytes = overheadBytes;
    }
    current.push(s);
    entries += s.entries.length;
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
