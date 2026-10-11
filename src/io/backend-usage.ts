import type { UsageCallResult } from "@armoriq/sdk-dev";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { entriesDigest, hourKey, type UsageSnapshot } from "../core/usage.ts";
import type { Login, StepUsage } from "../types.ts";
import { PRODUCT } from "./credentials.ts";

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
    .update(JSON.stringify([login.backend.replace(/\/+$/, ""), PRODUCT, login.userId, login.deviceId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(dataDir, "usage", id);
}

const PRIVATE = 0o600;
const LOCK_WAIT_MS = 5_000;

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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// TODO(lane B): replace tryLock/withLock with src/io/shared-lock.ts once it lands.
// The pid is written before link() publishes the lock, so a reader never sees an empty owner and mistakes a live lock for a stale one.
export async function tryLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const tmp = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, String(process.pid), { mode: PRIVATE });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(tmp, lockPath);
        return () => unlink(lockPath).catch(() => {});
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const owner = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
        if (!owner || isAlive(owner)) return null;
        await takeStale(lockPath, owner);
      }
    }
    return null;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Move the lock aside, then delete it only if it still names the dead owner; otherwise put it back.
async function takeStale(lockPath: string, deadOwner: number): Promise<void> {
  const aside = `${lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.stale`;
  if (!(await rename(lockPath, aside).then(() => true, () => false))) return;
  const owner = Number((await readFile(aside, "utf8").catch(() => "")).trim());
  if (owner !== deadOwner) await link(aside, lockPath).catch(() => {});
  await unlink(aside).catch(() => {});
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const until = Date.now() + LOCK_WAIT_MS;
  let release = await tryLock(lockPath);
  while (!release) {
    if (Date.now() > until) throw new Error(`${lockPath} is held by another process`);
    await sleep(10);
    release = await tryLock(lockPath);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
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
    const item = await readJson<{ batch?: UsageBatch } | null>(file, null);
    if (item?.batch?.batchId && Array.isArray(item.batch.snapshots)) items.push({ batch: item.batch, file });
    else await unlink(file).catch(() => {});
  }
  return items;
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
