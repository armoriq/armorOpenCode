import { countRunAttempt, runReport, settleRunRequest, type RunBinding, type RunEndReason, type RunReport, type RunRequestOutcome, type RunState } from "../core/runs.ts";
import { postRunsBatch } from "../io/backend-runs.ts";
import { postAuditBatch } from "../io/backend-audit.ts";
import { CaptureError, createOutbox, type JournalCheckpoint, type Outbox, type OutboxStatus } from "../io/outbox.ts";
import { withLock } from "../io/shared-lock.ts";
import type { Log, Login } from "../types.ts";
import { auditLogin, DEFAULT_TIMING, type PumpTiming } from "./audit.ts";
import type { HealthPump } from "./health.ts";
import { RUN_CAPABILITIES } from "./runs-capabilities.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// On by default. Exactly "false" turns it off; any other value except "true" stays off, as before.
export const runReportingEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.ARMORIQ_RUN_REPORTING_ENABLED === undefined || env.ARMORIQ_RUN_REPORTING_ENABLED === "true";
const LOCAL: RunBinding = { backend: "local:logged-out", keyId: "unreported" };
const owners = new Set<string>();

function ownerIsLive(owner: RunState["owner"]): boolean {
  if (owner.pid === process.pid) return owners.has(owner.id);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
type Capture = (checkpoint: JournalCheckpoint) => void;
export type RunsPump = {
  enabled: boolean;
  ready: Promise<void>;
  outbox: Outbox<RunReport>;
  commit(checkpoint: JournalCheckpoint | undefined, capture?: Capture, unreachable?: boolean): void;
  end(runId: string | null, reason: RunEndReason, at: number): void;
  kick(): Promise<void>;
  status(): OutboxStatus;
  begin(runId: string, sessionId: string, at: number, enforcing: boolean): void;
  attempt(runId: string | null, callId: string, tool: string, enforcing: boolean, options?: { trusted?: boolean; persist?: boolean }): JournalCheckpoint | undefined;
  registration(runId: string | null): () => void;
  request(runId: string | null, key: string, outcome: RunRequestOutcome, planId?: string, unreachable?: boolean): void;
  reject(runId: string | null): void;
  loginChanged(revalidated?: boolean): Promise<void>;
  authenticationSucceeded(login: Login): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

const emptyStatus = (): OutboxStatus => ({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 0 });
const noop = () => {};
const resolved = async () => {};
const disabledOutbox: Outbox<RunReport> = {
  enqueue: noop, checkpoint: noop, readCheckpoints: () => [], closedCheckpoints: () => [], retireCheckpoints: resolved,
  drain: async () => "empty", prepare: noop, flush: resolved, reportHealth: resolved, cancelScheduled: resolved,
  updateScheduled: async () => false, restoreLogin: resolved, authenticationSucceeded: resolved, captureFailure: noop,
  readPending: () => [], readDeadLetters: () => [], status: emptyStatus, diagnostics: () => ({ replays: 0, leases: 0 }), persist: resolved,
};

// State changes and reports share the outbox journal. A closure and its final report are one append.
export function createRunsPump(deps: {
  dataDir: string;
  login: () => Login | null;
  probeLogin?: () => Login | null;
  log: Log;
  enabled: boolean;
  checkpoints?: () => JournalCheckpoint[];
  retireCheckpoints?: (ids: readonly string[]) => Promise<void>;
  health?: HealthPump;
  post?: typeof postRunsBatch;
  clock?: { now: () => number; random: () => number };
  timing?: Partial<PumpTiming>;
}): RunsPump {
  if (!deps.enabled) return {
    enabled: false, ready: Promise.resolve(), outbox: disabledOutbox, commit: noop, end: noop, kick: resolved, status: emptyStatus,
    begin: noop, attempt: () => undefined, registration: () => noop, request: noop, reject: noop, loginChanged: resolved, authenticationSucceeded: resolved, start: noop, stop: resolved,
  };
  let logged = false;
  const logOnce = () => { if (!logged) { logged = true; deps.log.error("run storage capture failed"); } };
  const outbox: Outbox<RunReport> = createOutbox(deps.dataDir, "runs", { ...deps.log, error: logOnce }, {
    login: () => auditLogin(deps.login()), probeLogin: () => auditLogin(deps.probeLogin ? deps.probeLogin() : deps.login()),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  function failed(error: unknown): void {
    logOnce();
    if (!(error instanceof CaptureError)) outbox.captureFailure();
  }
  function bestEffort<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (error) { failed(error); return undefined; }
  }
  const runs = new Map<string, RunState>();
  const active = new Map<string, number>();
  const now = deps.clock?.now ?? Date.now;
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postRunsBatch;
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;
  const owner = { id: randomUUID(), pid: process.pid };
  // Local storage cannot disable the guard during host setup.
  bestEffort(() => outbox.prepare(LOCAL));

  function save(run: RunState, report?: RunReport): JournalCheckpoint {
    run.updatedAt = Math.max(run.updatedAt ?? run.startedAt, now());
    const checkpoint = { id: run.runId, sequence: run.version, value: structuredClone({ ...run, callIds: [] }) };
    outbox.checkpoint(checkpoint, run.binding ?? LOCAL, report);
    return checkpoint;
  }

  function finalize(run: RunState): void {
    if (!run.end || run.closed || active.get(run.runId)) return;
    const next = { ...run, requests: { ...run.requests }, closed: true, version: run.version + 1, reportSeq: run.reportSeq + 1 };
    for (const key of Object.keys(next.requests)) if (next.requests[key] === "pending") next.requests[key] = "failed";
    save(next, next.binding ? runReport(next) : undefined);
    runs.delete(run.runId);
  }

  function end(runId: string | null, reason: RunEndReason, at: number): void {
    bestEffort(() => {
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.closed || run.end) return;
      run.end = { reason, at: Math.max(at, run.startedAt) };
      run.version++;
      if (active.get(run.runId)) save(run);
      else finalize(run);
    });
  }

  owners.add(owner.id);
  const ready = withLock(join(deps.dataDir, "outbox", "runs-v2", "recovery.guard"), async () => {
    const closed = new Set(outbox.closedCheckpoints());
    const restored = new Map<string, RunState>();
    const checkpoints = [...outbox.readCheckpoints(), ...deps.checkpoints?.() ?? []].sort((a, b) => (a.sequence ?? (a.value as RunState)?.version ?? 0) - (b.sequence ?? (b.value as RunState)?.version ?? 0));
    for (const checkpoint of checkpoints) {
      if (closed.has(checkpoint.id)) continue;
      const previous = restored.get(checkpoint.id);
      const run = (checkpoint.delta ? { ...previous, ...checkpoint.value as object } : checkpoint.value) as RunState;
      if (!run || run.runId !== checkpoint.id || !Number.isSafeInteger(run.version) || typeof run.sessionId !== "string" || !run.owner || !Array.isArray(run.callIds)) {
        if (checkpoint.delta && !previous) continue;
        failed(new Error("invalid run checkpoint"));
        continue;
      }
      if ((previous?.version ?? -1) < run.version) restored.set(run.runId, run);
    }
    for (const run of restored.values()) {
      if (run.closed || ownerIsLive(run.owner)) continue;
      bestEffort(() => {
        outbox.prepare(run.binding ?? LOCAL);
        runs.set(run.runId, run);
        if (run.end) finalize(run);
        else end(run.runId, "recovered", run.updatedAt ?? run.startedAt);
      });
    }
    await outbox.flush();
    await deps.retireCheckpoints?.(outbox.closedCheckpoints());
  }).catch(failed);

  function commit(checkpoint: JournalCheckpoint | undefined, capture?: Capture, unreachable = false): void {
    if (!checkpoint) return;
    const run = runs.get(checkpoint.id);
    if (!run || run.closed) return;
    if (unreachable && !run.unreachable) { run.unreachable = true; run.version++; }
    const value: JournalCheckpoint = { ...checkpoint, sequence: run.version, value: {
      ...checkpoint.value as object, version: run.version, updatedAt: run.updatedAt,
      toolCalls: run.toolCalls, gatedToolCalls: run.gatedToolCalls, enforcementNeeded: run.enforcementNeeded, unreachable: run.unreachable,
    } };
    if (capture) capture(value);
    else bestEffort(() => outbox.checkpoint(value, run.binding ?? LOCAL));
  }

  async function kick(): Promise<void> {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      await ready;
      for (const run of runs.values()) if (run.end && !active.has(run.runId)) bestEffort(() => finalize(run));
      await outbox.flush();
      await deps.retireCheckpoints?.(outbox.closedCheckpoints());
      await outbox.drain(async (reports, binding) => {
        const login = deps.login();
        const identity = auditLogin(login);
        if (!login || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
        return post(login, reports);
      }, undefined, { probe: async binding => {
        const auth = deps.probeLogin ? deps.probeLogin() : deps.login();
        const identity = auditLogin(auth);
        if (!auth || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return false;
        return (await postAuditBatch(auth, [])).ok;
      } });
      if (deps.health) { await outbox.reportHealth(deps.health.outbox); await deps.health.kick(); }
    })().catch(failed).finally(() => { running = null; });
    return running;
  }

  return {
    enabled: true, ready, outbox, commit, end, kick,
    async authenticationSucceeded(auth) {
      try { await outbox.authenticationSucceeded(auditLogin(auth)); }
      catch (error) { failed(error); }
    },
    status: () => bestEffort(() => outbox.status()) ?? emptyStatus(),
    begin(runId, sessionId, at, enforcing) {
      bestEffort(() => {
        if (runs.has(runId)) return;
        const binding = auditLogin(deps.login());
        outbox.prepare(binding ?? LOCAL);
        const run: RunState = {
          runId, sessionId, startedAt: at, updatedAt: at, binding, owner, version: 1, reportSeq: 1,
          enforcing, enforcementNeeded: false, toolCalls: 0, gatedToolCalls: 0, callIds: [], planIds: [], requests: {},
          rejected: false, unreachable: false, end: null, closed: false,
        };
        save(run, binding ? runReport(run) : undefined);
        runs.set(runId, run);
      });
    },
    attempt(runId, callId, tool, enforcing, options = {}) {
      return bestEffort(() => {
        const run = runId ? runs.get(runId) : undefined;
        if (!run) return;
        const next = countRunAttempt(run, callId, tool, enforcing, RUN_CAPABILITIES, options.trusted ?? true);
        if (!next) return;
        next.updatedAt = now();
        runs.set(next.runId, next);
        const checkpoint: JournalCheckpoint = { id: next.runId, sequence: next.version, delta: true, value: {
          runId: next.runId, version: next.version, updatedAt: next.updatedAt, toolCalls: next.toolCalls,
          gatedToolCalls: next.gatedToolCalls, enforcementNeeded: next.enforcementNeeded,
        } };
        if (options.persist !== false) commit(checkpoint);
        return checkpoint;
      });
    },
    registration(runId) {
      if (!runId || !runs.has(runId)) return noop;
      active.set(runId, (active.get(runId) ?? 0) + 1);
      let settled = false;
      return () => bestEffort(() => {
        if (settled) return;
        settled = true;
        const count = (active.get(runId) ?? 1) - 1;
        if (count) active.set(runId, count); else active.delete(runId);
        const run = runs.get(runId);
        if (run) finalize(run);
      });
    },
    request(runId, key, outcome, planId, unreachable = false) {
      bestEffort(() => {
        const run = runId ? runs.get(runId) : undefined;
        if (!run || run.closed) return;
        const next = settleRunRequest(run, key, outcome, planId, unreachable);
        runs.set(next.runId, next);
        save(next);
      });
    },
    reject(runId) {
      bestEffort(() => {
        const run = runId ? runs.get(runId) : undefined;
        if (!run || run.closed || run.rejected) return;
        run.rejected = true; run.version++; save(run);
      });
    },
    async loginChanged(revalidated = true) {
      try {
        outbox.prepare();
        if (revalidated) await outbox.restoreLogin(auditLogin(deps.login()));
        await kick();
      } catch (error) { failed(error); }
    },
    start() {
      if (interval || stopped) return;
      interval = setInterval(() => { void kick(); }, timing.intervalMs);
      interval.unref?.(); void kick();
    },
    async stop() {
      if (stopped) return;
      stopped = true; clearInterval(interval);
      const closing = (async () => { await ready; await running; await outbox.persist(); })().catch(failed).finally(() => owners.delete(owner.id));
      await Promise.race([closing, sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
