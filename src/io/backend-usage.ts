import type { UsageCallResult } from "@armoriq/sdk-dev";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { entriesDigest, hourKey, type UsageSnapshot } from "../core/usage.ts";
import type { Login, StepUsage } from "../types.ts";
import { PRODUCT } from "./credentials.ts";
import { withLock } from "./shared-lock.ts";

export type UsageBatch = {
  generation: string;
  batchId: string;
  deviceName?: string;
  snapshots: UsageSnapshot[];
};

export type UsageResult<T> =
  | { ok: true; value: T }
  | { ok: false; status?: number; retryable: boolean; retryAfterMs?: number; reason: string; relogin?: boolean };

export interface UsageClient {
  initialize(): Promise<UsageResult<{ generation: string }>>;
  send(batch: UsageBatch): Promise<UsageResult<unknown>>;
}

export const isFenced = (r: UsageResult<unknown>) => !r.ok && r.status === 409 && /generation/i.test(r.reason);

// The SDK import costs 130-175 ms, so it is loaded only here, from a pump, never from a hook.
export async function createUsageClient(login: Login): Promise<UsageClient> {
  const sdk = await import("@armoriq/sdk-dev");
  const client = new sdk.ArmorIQClient({ apiKey: login.apiKey, backendEndpoint: login.backend, product: PRODUCT });
  const result = <T>(r: UsageCallResult<T>): UsageResult<T> =>
    r.ok
      ? { ok: true, value: r.value }
      : {
          ok: false,
          ...(r.status === undefined ? {} : { status: r.status }),
          retryable: r.retryable,
          ...(r.retryAfterMs === undefined ? {} : { retryAfterMs: r.retryAfterMs }),
          reason: r.reason,
          ...(r.reloginRequired ? { relogin: true } : {}),
        };
  return {
    initialize: async () => result(await client.initializeUsageStream()),
    send: async (batch) => result(await client.recordTokenUsageBatch(batch)),
  };
}

export const newBatchId = () => randomUUID();

// One directory per backend, product, user and device, as ArmorClaude live-usage liveDir.
export function scopeDir(dataDir: string, login: Login): string {
  const id = createHash("sha256")
    .update(JSON.stringify([login.backend, PRODUCT, login.userId, login.deviceId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(dataDir, "usage", id);
}

const PRIVATE = 0o600;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: PRIVATE });
  await rename(tmp, file);
}

type Stream = { generation?: string; revision?: number };

export function allocateRevision(dir: string): Promise<number> {
  const file = path.join(dir, "stream.json");
  return withLock(path.join(dir, "stream.lock"), async () => {
    const stream = await readJson<Stream>(file, {});
    const revision = (Number.isSafeInteger(stream.revision) ? stream.revision! : 0) + 1;
    await writeJson(file, { ...stream, revision });
    return revision;
  });
}

export async function storedGeneration(dir: string): Promise<string | null> {
  return (await readJson<Stream>(path.join(dir, "stream.json"), {})).generation ?? null;
}

export function setGeneration(dir: string, generation: string): Promise<void> {
  const file = path.join(dir, "stream.json");
  return withLock(path.join(dir, "stream.lock"), async () => {
    await writeJson(file, { ...(await readJson<Stream>(file, {})), generation });
  });
}

export type SessionState = {
  steps: StepUsage[];
  generation?: string;
  acknowledged?: Record<string, string>;
  refused?: Record<string, string>;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const sessionName = (id: string) => (SAFE_ID.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 40));
const sessionsDir = (dir: string) => path.join(dir, "sessions");
const sessionFile = (dir: string, id: string) => path.join(sessionsDir(dir), `${sessionName(id)}.json`);

export async function readSession(dir: string, id: string): Promise<SessionState> {
  const state = await readJson<SessionState>(sessionFile(dir, id), { steps: [] });
  return Array.isArray(state.steps) ? state : { ...state, steps: [] };
}

export function updateSession<T>(dir: string, id: string, fn: (state: SessionState) => Promise<[SessionState, T]>): Promise<T> {
  return withLock(path.join(sessionsDir(dir), `${sessionName(id)}.lock`), async () => {
    const [next, out] = await fn(await readSession(dir, id));
    await writeJson(sessionFile(dir, id), next);
    return out;
  });
}

export function mergeSteps(state: SessionState, steps: readonly StepUsage[]): SessionState {
  const seen = new Set(state.steps.map((s) => s.partId));
  const added: StepUsage[] = [];
  for (const s of steps) {
    if (seen.has(s.partId)) continue;
    seen.add(s.partId);
    added.push(s);
  }
  return added.length ? { ...state, steps: [...state.steps, ...added] } : state;
}

export const acknowledgedIn = (state: SessionState, generation: string) =>
  state.generation === generation ? (state.acknowledged ?? {}) : {};

export function acknowledge(state: SessionState, generation: string, snapshots: readonly UsageSnapshot[]): SessionState {
  const acknowledged = { ...acknowledgedIn(state, generation) };
  for (const s of snapshots) acknowledged[hourKey(s)] = entriesDigest(s.entries);
  return { ...state, generation, acknowledged };
}

export function refuse(state: SessionState, snapshots: readonly UsageSnapshot[]): SessionState {
  const refused = { ...state.refused };
  for (const s of snapshots) refused[hourKey(s)] = entriesDigest(s.entries);
  return { ...state, refused };
}

export async function storedSessionIds(dir: string, maxAgeMs: number): Promise<string[]> {
  const ids: string[] = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const name of await readdir(sessionsDir(dir)).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(sessionsDir(dir), name);
    const st = await stat(file).catch(() => null);
    if (!st) continue;
    if (st.mtimeMs < cutoff) {
      await unlink(file).catch(() => {});
      continue;
    }
    const state = await readJson<SessionState>(file, { steps: [] });
    const id = state.steps?.[0]?.sessionId;
    if (id) ids.push(id);
  }
  return ids;
}

const QUEUED = /^\d{16}-[0-9a-f-]{36}\.json$/;
const queueDir = (dir: string) => path.join(dir, "queue");
let lastOrder = 0;

export type QueuedBatch = { batch: UsageBatch; file: string };

export async function enqueueBatches(dir: string, batches: readonly UsageBatch[]): Promise<void> {
  for (const batch of batches) {
    lastOrder = Math.max(lastOrder + 1, Date.now() * 1000);
    await writeJson(path.join(queueDir(dir), `${String(lastOrder).padStart(16, "0")}-${batch.batchId}.json`), { batch });
  }
}

export async function queuedBatches(dir: string): Promise<QueuedBatch[]> {
  const names = (await readdir(queueDir(dir)).catch(() => [] as string[])).filter((n) => QUEUED.test(n)).sort();
  const items: QueuedBatch[] = [];
  for (const name of names) {
    const file = path.join(queueDir(dir), name);
    // A read error (EMFILE, EIO, or another process already settled it) leaves the file for a later pass;
    // only content that does not parse is dropped, since writeJson never leaves a partial file.
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const batch = parseQueued(text);
    if (batch) items.push({ batch, file });
    else await unlink(file).catch(() => {});
  }
  return items;
}

function parseQueued(text: string): UsageBatch | null {
  try {
    const { batch } = JSON.parse(text) as { batch?: UsageBatch };
    return batch?.batchId && Array.isArray(batch.snapshots) ? batch : null;
  } catch {
    return null;
  }
}

export const settle = (file: string) => unlink(file).catch(() => {});

export async function clearQueue(dir: string): Promise<void> {
  for (const { file } of await queuedBatches(dir)) await settle(file);
}

export const queueLockPath = (dir: string) => path.join(dir, "queue.lock");

export async function setAside(dir: string, item: QueuedBatch, reason: string): Promise<void> {
  await writeJson(path.join(queueDir(dir), "refused", path.basename(item.file)), { ...item, refused: reason });
  await settle(item.file);
}
