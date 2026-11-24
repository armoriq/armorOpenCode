import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { postAuditBatch, type CallResult } from "../io/backend-audit.ts";
import { createOutbox, type JournalCheckpoint, type OutboxStatus, type QueueLogin, type SendResult } from "../io/outbox.ts";
import type { AuditRow, BatchAck, Log, Login, Pump } from "../types.ts";
import type { HealthPump } from "./health.ts";

export type AuditPump = Omit<Pump, "kick"> & {
  kick(): Promise<void>;
  enqueue(row: AuditRow, login?: Login | null, checkpoint?: JournalCheckpoint): void;
  runCheckpoints(): JournalCheckpoint[];
  retireRunCheckpoints(ids: readonly string[]): Promise<void>;
  captureFailure(): void;
  status(): OutboxStatus;
  loginChanged(revalidated?: boolean): Promise<void>;
  authenticationSucceeded(login: Login): Promise<void>;
  // Wakes delivery when the backend is back. Persisted retry deadlines still apply.
  retryNow(): Promise<void>;
};

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number; authProbeMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 2_000, authProbeMs: 120_000 };

export function auditLogin(login: Login | null): QueueLogin | null {
  return login?.apiKey && login.backend ? { backend: login.backend, keyId: createHash("sha256").update(login.apiKey).digest("hex") } : null;
}

// Preserve the distinction between a row refusal, a retry and a legacy batch refusal.
export function auditSendResult(rows: readonly AuditRow[], result: CallResult<BatchAck>): SendResult<AuditRow> {
  if (!result.ok) return { ok: false, relogin: result.relogin || result.unauthorized, legacyRefusal: result.legacyRefusal, nonTransient: result.nonTransient, tooLarge: result.tooLarge, reason: result.reason, retryAfterMs: result.retryAfterMs,
    stallReason: result.relogin || result.unauthorized ? "auth_paused" : result.status === 429 ? "rate_limited" : result.status && result.status >= 500 ? "server_error" : "backend_unreachable" };
  if (result.value.results) {
    const outcomes = new Map(result.value.results.map(outcome => [outcome.client_row_id, outcome]));
    return { ok: true, retryAfterMs: result.value.retryAfterMs, rejected: rows.flatMap(item => {
      const outcome = outcomes.get(item.client_row_id!);
      return outcome?.outcome === "accepted" || outcome?.outcome === "duplicate" ? [] : [{ item, error: outcome?.error ?? (outcome ? outcome.outcome : "missing row outcome"), permanent: outcome?.outcome === "rejected", transient: outcome?.outcome !== "rejected" }];
    }) };
  }
  // The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
  return { ok: true, retryAfterMs: result.value.retryAfterMs, rejected: result.value.failures.map(({ index, error }) => ({ item: rows[index]!, error, permanent: error.startsWith("invalid row:"), transient: !error.startsWith("invalid row:") })) };
}

// Every 5 s and on kick(): the bound queue sends stored rows. Outcomes are settled per row,
// and transient failures use the queue's persisted schedule without spending refusal attempts.
export function createAuditPump(deps: {
  dataDir: string;
  login: () => Login | null;
  probeLogin?: () => Login | null;
  authenticationSucceeded?: (login: Login) => void;
  log: Log;
  relogin?: (reason: string) => void;
  report?: (result: CallResult<BatchAck>) => void;
  timing?: Partial<PumpTiming>;
  clock?: { now: () => number; random: () => number };
  post?: typeof postAuditBatch;
  health?: HealthPump;
}): AuditPump {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postAuditBatch;
  const outbox = createOutbox<AuditRow>(deps.dataDir, "audit", deps.log, {
    login: () => auditLogin(deps.login()),
    probeLogin: () => auditLogin(deps.probeLogin ? deps.probeLogin() : deps.login()),
    clock: deps.clock,
    timing: { baseMs: timing.minBackoffMs, maxMs: timing.maxBackoffMs, lockTtlMs: 60_000, authProbeMs: timing.authProbeMs },
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  async function cycle(): Promise<void> {
    do {
      again = false;
      outbox.prepare();
      await outbox.drain(async (rows, binding) => {
        const current = deps.login();
        const identity = auditLogin(current);
        if (!current || !identity || identity.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
        const result = await post(current, rows);
        deps.report?.(result);
        if (!result.ok && result.relogin) deps.relogin?.(result.reason);
        return auditSendResult(rows, result);
      }, undefined, { probe: async binding => {
        const current = deps.probeLogin ? deps.probeLogin() : deps.login();
        const identity = auditLogin(current);
        if (!current || !identity || identity.backend !== binding.backend || identity.keyId !== binding.keyId) return false;
        // An empty audit request uses the same authenticated endpoint and cannot create an audit row.
        const result = await post(current, []);
        deps.report?.(result);
        if (result.ok) deps.authenticationSucceeded?.(current);
        return result.ok;
      } });
      if (deps.health) {
        await outbox.reportHealth(deps.health.outbox);
        await deps.health.kick();
      }
    } while (again && !stopped);
  }

  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = cycle().catch(() => deps.log.error("audit pump failed")).finally(() => { running = null; });
    return running;
  }

  return {
    enqueue: (row, login = deps.login(), checkpoint) => outbox.enqueue(row, { binding: auditLogin(login), ...(checkpoint ? { checkpoint } : {}) }),
    runCheckpoints: () => outbox.readCheckpoints(),
    retireRunCheckpoints: ids => outbox.retireCheckpoints(ids),
    captureFailure: () => outbox.captureFailure(),
    status: () => outbox.status(),
    async authenticationSucceeded(login) {
      try { await outbox.authenticationSucceeded(auditLogin(login)); }
      catch { deps.log.error("audit authentication recovery failed"); }
    },
    async loginChanged(revalidated = true) {
      try {
        outbox.prepare();
        if (revalidated) await outbox.restoreLogin(auditLogin(deps.login()));
        await kick();
      } catch { deps.log.error("audit login restore failed"); }
    },
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      kick();
    },
    kick,
    retryNow: kick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      await Promise.race([outbox.persist(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
