import {
  bucketByHour,
  callKey,
  changedBuckets,
  entriesDigest,
  hourKey,
  packBatches,
  splitParts,
  toParts,
  toSnapshots,
  type SessionTitle,
  type UsageSnapshot,
} from "../core/usage.ts";
import {
  acknowledge,
  acknowledgedIn,
  allocateRevision,
  clearQueue,
  createUsageClient,
  enqueueBatches,
  isFenced,
  mergeSteps,
  noteTitle,
  newBatchId,
  queuedBatches,
  queueLockPath,
  refuse,
  scopeDir,
  sentCallsIn,
  sentTitleIn,
  setAside,
  setGeneration,
  settle,
  storedGeneration,
  storedSessionIds,
  updateSession,
  type QueuedBatch,
  type SessionState,
  type UsageBatch,
  type UsageClient,
  type UsageResult,
} from "../io/backend-usage.ts";
import { tryLock } from "../io/shared-lock.ts";
import type { Log, Login, Pump, StepUsage } from "../types.ts";

export type UsagePump = Pump & { observe(step: StepUsage): void; observeTitle(title: SessionTitle): void };

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

type Pending = { login: Login; bySession: Map<string, StepUsage[]>; titles: Map<string, SessionTitle> };

function unsentTitle(state: SessionState, generation: string, queued: ReadonlySet<string>): SessionTitle | null {
  const title = state.title;
  if (!title || queued.has(title.title)) return null;
  return title.title === sentTitleIn(state, generation) || title.title === state.refusedTitle ? null : title;
}

async function queuedFor(dir: string, generation: string, sessionId: string) {
  const known: Record<string, string> = {};
  const calls = new Set<string>();
  const titles = new Set<string>();
  for (const { batch } of await queuedBatches(dir)) {
    if (batch.generation !== generation) continue;
    for (const s of batch.snapshots) if (s.sessionId === sessionId) known[hourKey(s)] = entriesDigest(s.entries);
    for (const c of batch.calls) if (c.sessionId === sessionId) for (const r of c.records) calls.add(r.key);
    for (const t of batch.sessions) if (t.sessionId === sessionId) titles.add(t.title);
  }
  return { known, calls, titles };
}

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
  let pending = new Map<string, Pending>();
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

  const scopeFor = (dir: string, login: Login) => {
    let scope = pending.get(dir);
    if (!scope) pending.set(dir, (scope = { login, bySession: new Map(), titles: new Map() }));
    return scope;
  };

  function requeue(dir: string, login: Login, sessionId: string, steps: StepUsage[], title: SessionTitle | undefined): void {
    const back = scopeFor(dir, login);
    back.bySession.set(sessionId, [...steps, ...(back.bySession.get(sessionId) ?? [])]);
    if (title && !back.titles.has(sessionId)) back.titles.set(sessionId, title);
  }

  async function persistNow(): Promise<void> {
    const taken = pending;
    pending = new Map();
    for (const [dir, { login, bySession, titles }] of taken) {
      for (const sessionId of new Set([...bySession.keys(), ...titles.keys()])) {
        const steps = bySession.get(sessionId) ?? [];
        const title = titles.get(sessionId);
        try {
          await updateSession(dir, sessionId, async (state) => {
            const merged = mergeSteps(state, steps);
            return [title ? noteTitle(merged, title) : merged, undefined];
          });
          markDirty(dir, sessionId);
        } catch (e) {
          deps.log.warn("usage: could not save steps", { error: String(e) });
          requeue(dir, login, sessionId, steps, title);
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
      const queued = await queuedFor(dir, generation, sessionId);
      const known: Record<string, string> = { ...state.refused, ...acknowledgedIn(state, generation), ...queued.known };
      const knownCalls = new Set([...(state.refusedCalls ?? []), ...sentCallsIn(state, generation), ...queued.calls]);
      const changed = changedBuckets(bucketByHour(state.steps), known);
      const fresh = state.steps.filter((s) => !knownCalls.has(callKey(s)));
      const title = unsentTitle(state, generation, queued.titles);
      if (changed.length || fresh.length || title) {
        const snapshots = changed.length ? toSnapshots(changed, await allocateRevision(dir)) : [];
        const batches: UsageBatch[] = packBatches(toParts(snapshots, fresh, title ? [title] : [])).map((parts) => ({
          generation,
          batchId: newBatchId(),
          ...(deviceName ? { deviceName } : {}),
          ...parts,
        }));
        await enqueueBatches(dir, batches);
      }
      return [state, undefined];
    });
  }

  async function recordAcks(dir: string, batch: UsageBatch, change: "ack" | "refuse"): Promise<void> {
    const bySession = new Map<string, { snapshots: UsageSnapshot[]; callKeys: string[]; title?: string }>();
    const own = (id: string) => bySession.get(id) ?? bySession.set(id, { snapshots: [], callKeys: [] }).get(id)!;
    for (const s of batch.snapshots) own(s.sessionId).snapshots.push(s);
    for (const c of batch.calls) own(c.sessionId).callKeys.push(...c.records.map((r) => r.key));
    for (const t of batch.sessions) own(t.sessionId).title = t.title;
    for (const [sessionId, sent] of bySession)
      await updateSession(dir, sessionId, async (state) => [
        change === "refuse" ? refuse(state, sent) : acknowledge(state, batch.generation, sent),
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
          const parts = splitParts(item.batch);
          if (parts.length > 1) {
            // Split so one bad session-hour does not hold back the rest; the outer loop re-reads the queue.
            await enqueueBatches(
              dir,
              parts.map((p) => ({ ...item.batch, batchId: newBatchId(), ...p })),
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
    observeTitle(title) {
      const login = deps.login();
      if (!login || stopped) return;
      const scope = scopeFor(dirFor(login), login);
      if (scope.titles.get(title.sessionId)?.title !== title.title) scope.titles.set(title.sessionId, title);
      schedulePersist();
    },
    observe(step) {
      const login = deps.login();
      if (!login || stopped) return;
      const scope = scopeFor(dirFor(login), login);
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
