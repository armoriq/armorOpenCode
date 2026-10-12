import { bucketByHour, changedBuckets, entriesDigest, hourKey, packBatches, toSnapshots, type UsageSnapshot } from "../core/usage.ts";
import {
  acknowledge,
  acknowledgedIn,
  allocateRevision,
  clearQueue,
  createUsageClient,
  enqueueBatches,
  isFenced,
  mergeSteps,
  newBatchId,
  queuedBatches,
  queueLockPath,
  refuse,
  scopeDir,
  setAside,
  setGeneration,
  settle,
  storedGeneration,
  storedSessionIds,
  updateSession,
  type QueuedBatch,
  type UsageBatch,
  type UsageClient,
  type UsageResult,
} from "../io/backend-usage.ts";
import { tryLock } from "../io/shared-lock.ts";
import type { Log, Login, Pump, StepUsage } from "../types.ts";

export type UsagePump = Pump & { observe(step: StepUsage): void };

export type UsagePumpOptions = {
  intervalMs?: number;
  persistDelayMs?: number;
  client?: (login: Login) => Promise<UsageClient>;
};

const INTERVAL_MS = 60_000;
const PERSIST_DELAY_MS = 1_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const SESSION_MAX_AGE_MS = 30 * 24 * 3600_000;
// One-shot `opencode run` exits right after the turn ends; let an in-flight send finish instead of waiting for the next session.
const STOP_WAIT_MS = 2_000;

const loginKey = (l: Login) => JSON.stringify([l.backend, l.apiKey, l.userId, l.deviceId]);

type Outcome =
  | { kind: "drained" }
  | { kind: "busy" }
  | { kind: "fenced" }
  | { kind: "kept"; retryAfterMs?: number; reason: string }
  | { kind: "relogin"; reason: string };

function failureOutcome(r: Extract<UsageResult<unknown>, { ok: false }>): Outcome {
  if (r.relogin) return { kind: "relogin", reason: r.reason };
  return { kind: "kept", reason: r.reason, ...(r.retryAfterMs === undefined ? {} : { retryAfterMs: r.retryAfterMs }) };
}

// On kick() (session idle) and every 60 s: changed session-hours -> batch. 409 generation -> reinitialize and recapture.
export function createUsagePump(deps: { dataDir: string; login: () => Login | null; log: Log }, options: UsagePumpOptions = {}): UsagePump {
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const persistDelayMs = options.persistDelayMs ?? PERSIST_DELAY_MS;
  const makeClient = options.client ?? createUsageClient;

  // Steps observed but not yet merged into their session file, grouped by the login scope they were observed under.
  let pending = new Map<string, { login: Login; bySession: Map<string, StepUsage[]> }>();
  const dirty = new Map<string, Set<string>>();
  const restored = new Set<string>();
  let client: { key: string; value: UsageClient } | null = null;
  let scopeCache: { login: Login; dir: string } | null = null;
  let stoppedForLogin: string | null = null;
  let failures = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let started = false;
  let stopped = false;
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const dirFor = (login: Login) => {
    if (scopeCache?.login !== login) scopeCache = { login, dir: scopeDir(deps.dataDir, login) };
    return scopeCache.dir;
  };

  const markDirty = (dir: string, sessionId: string) => {
    let set = dirty.get(dir);
    if (!set) dirty.set(dir, (set = new Set()));
    set.add(sessionId);
  };

  // Serialized so stop() can wait for a save that already took the pending steps.
  let persisting: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    persisting = persisting.then(persistNow, persistNow);
    return persisting;
  }

  async function persistNow(): Promise<void> {
    const taken = pending;
    pending = new Map();
    for (const [dir, { bySession }] of taken) {
      for (const [sessionId, steps] of bySession) {
        try {
          await updateSession(dir, sessionId, async (state) => [mergeSteps(state, steps), undefined]);
          markDirty(dir, sessionId);
        } catch (e) {
          deps.log.warn("usage: could not save steps", { error: String(e) });
          const back = pending.get(dir) ?? { login: taken.get(dir)!.login, bySession: new Map() };
          back.bySession.set(sessionId, [...steps, ...(back.bySession.get(sessionId) ?? [])]);
          pending.set(dir, back);
        }
      }
    }
  }

  function schedulePersist(): void {
    if (persistTimer || stopped) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch(() => {});
    }, persistDelayMs);
    persistTimer.unref?.();
  }

  async function generationFor(dir: string, c: UsageClient, refresh: boolean): Promise<UsageResult<string>> {
    const stored = refresh ? null : await storedGeneration(dir);
    if (stored) return { ok: true, value: stored };
    const res = await c.initialize();
    if (!res.ok) return res;
    await setGeneration(dir, res.value.generation);
    return { ok: true, value: res.value.generation };
  }

  async function capture(dir: string, sessionId: string, generation: string, deviceName: string): Promise<void> {
    await updateSession(dir, sessionId, async (state) => {
      const known: Record<string, string> = { ...state.refused, ...acknowledgedIn(state, generation) };
      for (const { batch } of await queuedBatches(dir))
        if (batch.generation === generation)
          for (const s of batch.snapshots) if (s.sessionId === sessionId) known[hourKey(s)] = entriesDigest(s.entries);
      const changed = changedBuckets(bucketByHour(state.steps), known);
      if (changed.length) {
        const revision = await allocateRevision(dir);
        const batches: UsageBatch[] = packBatches(toSnapshots(changed, revision)).map((snapshots) => ({
          generation,
          batchId: newBatchId(),
          ...(deviceName ? { deviceName } : {}),
          snapshots,
        }));
        await enqueueBatches(dir, batches);
      }
      return [state, undefined];
    });
  }

  async function recordAcks(dir: string, batch: UsageBatch, change: "ack" | "refuse"): Promise<void> {
    const bySession = new Map<string, UsageSnapshot[]>();
    for (const s of batch.snapshots) bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]);
    for (const [sessionId, own] of bySession)
      await updateSession(dir, sessionId, async (state) => [
        change === "refuse" ? refuse(state, own) : acknowledge(state, batch.generation, own),
        undefined,
      ]);
  }

  async function drain(dir: string, c: UsageClient): Promise<Outcome> {
    const release = await tryLock(queueLockPath(dir));
    if (!release) return { kind: "busy" };
    try {
      let items: QueuedBatch[];
      while ((items = await queuedBatches(dir)).length) {
        for (const item of items) {
          if (abandoned) return { kind: "kept", reason: "stopping" };
          const res = await c.send(item.batch);
          if (isFenced(res)) return { kind: "fenced" };
          if (res.ok) {
            await recordAcks(dir, item.batch, "ack");
            await settle(item.file);
            continue;
          }
          if (res.relogin || res.retryable) return failureOutcome(res);
          if (item.batch.snapshots.length > 1) {
            // Split so one bad snapshot does not hold back the rest; the outer loop re-reads the queue.
            await enqueueBatches(
              dir,
              item.batch.snapshots.map((s) => ({ ...item.batch, batchId: newBatchId(), snapshots: [s] })),
            );
            await settle(item.file);
            break;
          }
          deps.log.warn("usage: backend refused a snapshot", { reason: res.reason, status: res.status });
          await recordAcks(dir, item.batch, "refuse");
          await setAside(dir, item, res.reason);
        }
      }
      return { kind: "drained" };
    } finally {
      await release();
    }
  }

  async function pass(): Promise<number> {
    const login = deps.login();
    if (!login) return intervalMs;
    const key = loginKey(login);
    if (stoppedForLogin === key) return intervalMs;
    stoppedForLogin = null;
    await persist();
    const dir = dirFor(login);
    if (!restored.has(dir)) {
      for (const id of await storedSessionIds(dir, SESSION_MAX_AGE_MS)) markDirty(dir, id);
      restored.add(dir);
    }
    // Loading the SDK stalls the shared thread, so wait until there is something to send.
    if (!dirty.get(dir)?.size && !(await queuedBatches(dir)).length) return intervalMs;
    if (client?.key !== key) client = { key, value: await makeClient(login) };
    const c = client.value;

    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = await generationFor(dir, c, attempt > 0);
      if (!gen.ok) return settleFailure(failureOutcome(gen), key);
      const todo = [...(dirty.get(dir) ?? [])];
      dirty.set(dir, new Set());
      for (const [i, id] of todo.entries()) {
        try {
          await capture(dir, id, gen.value, login.deviceName);
        } catch (e) {
          for (const left of todo.slice(i)) markDirty(dir, left);
          throw e;
        }
      }
      const outcome = await drain(dir, c);
      if (outcome.kind !== "fenced") return settleFailure(outcome, key);
      deps.log.info("usage: the stream has a new generation, capturing again");
      await clearQueue(dir);
      for (const id of await storedSessionIds(dir, SESSION_MAX_AGE_MS)) markDirty(dir, id);
    }
    return settleFailure({ kind: "kept", reason: "the stream generation kept changing" }, key);
  }

  function settleFailure(outcome: Outcome, key: string): number {
    if (outcome.kind === "drained" || outcome.kind === "busy") {
      failures = 0;
      return intervalMs;
    }
    if (outcome.kind === "relogin") {
      deps.log.warn("usage: relogin required, paused until the login changes", { reason: outcome.reason });
      stoppedForLogin = key;
      return intervalMs;
    }
    failures += 1;
    if (outcome.kind === "kept" && outcome.retryAfterMs !== undefined) return outcome.retryAfterMs;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    return Math.round(base * (0.5 + Math.random() / 2));
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
    timer.unref?.();
  }

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let delay = intervalMs;
      do {
        again = false;
        try {
          delay = await pass();
        } catch (e) {
          deps.log.warn("usage: pass failed", { error: String(e) });
          delay = settleFailure({ kind: "kept", reason: String(e) }, "");
        }
      } while (again && !stopped && failures === 0);
      schedule(delay);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(0);
    },
    kick() {
      if (started && !stopped && failures === 0) void run();
    },
    observe(step) {
      const login = deps.login();
      if (!login || stopped) return;
      const dir = dirFor(login);
      let scope = pending.get(dir);
      if (!scope) pending.set(dir, (scope = { login, bySession: new Map() }));
      const list = scope.bySession.get(step.sessionId);
      if (list) list.push(step);
      else scope.bySession.set(step.sessionId, [step]);
      schedulePersist();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (persistTimer) clearTimeout(persistTimer);
      timer = persistTimer = null;
      if (running) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([running, new Promise<void>((resolve) => (deadline = setTimeout(resolve, STOP_WAIT_MS)))]);
        clearTimeout(deadline);
      }
      abandoned = true;
      await persist();
    },
  };
}
