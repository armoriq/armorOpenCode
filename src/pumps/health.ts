import { setTimeout as sleep } from "node:timers/promises";
import { clientRowId } from "../core/audit.ts";
import { clientEvent, type ClientEvent, type PlanFailureReason } from "../core/client-events.ts";
import { postClientEvents } from "../io/backend-client-events.ts";
import { postAuditBatch } from "../io/backend-audit.ts";
import { CaptureError, createOutbox, type Outbox, type OutboxStatus } from "../io/outbox.ts";
import type { Log, Login, Pump } from "../types.ts";
import { auditLogin, DEFAULT_TIMING, type PumpTiming } from "./audit.ts";

export type HealthPump = Omit<Pump, "kick"> & {
  readonly outbox: Outbox<ClientEvent>;
  kick(): Promise<void>;
  status(): OutboxStatus;
  loginChanged(revalidated?: boolean): Promise<void>;
  authenticationSucceeded(login: Login): Promise<void>;
  planRequestFailed(login: Login, key: string, reason: PlanFailureReason, notBefore?: number): Promise<void>;
  planRequestSucceeded(login: Login, key: string): Promise<void>;
};

export function createHealthPump(deps: {
  dataDir: string;
  login: () => Login | null;
  probeLogin?: () => Login | null;
  log: Log;
  post?: typeof postClientEvents;
  clock?: { now: () => number; random: () => number };
  timing?: Partial<PumpTiming>;
}): HealthPump {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  let logged = false;
  const logOnce = () => { if (!logged) { logged = true; deps.log.error("health event capture failed"); } };
  const outbox = createOutbox<ClientEvent>(deps.dataDir, "health", { ...deps.log, error: logOnce }, {
    login: () => auditLogin(deps.login()), probeLogin: () => auditLogin(deps.probeLogin ? deps.probeLogin() : deps.login()), clock: deps.clock,
    timing: { baseMs: timing.minBackoffMs, maxMs: timing.maxBackoffMs, lockTtlMs: 60_000, authProbeMs: timing.authProbeMs },
  });
  const post = deps.post ?? postClientEvents;
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;
  const scheduled = new Set<string>();
  function failed(error: unknown): void {
    logOnce();
    if (!(error instanceof CaptureError)) outbox.captureFailure();
  }
  try { for (const entry of outbox.readPending()) if (entry.notBefore !== undefined) scheduled.add(entry.id); }
  catch (error) { failed(error); }

  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = outbox.drain(async (events, binding) => {
      const auth = deps.login();
      const identity = auditLogin(auth);
      if (!auth || !identity || identity.backend !== binding.backend || identity.keyId !== binding.keyId) return { ok: false, deferred: true };
      return post(auth, events);
    }, undefined, { probe: async binding => {
      const auth = deps.probeLogin ? deps.probeLogin() : deps.login();
      const identity = auditLogin(auth);
      if (!auth || identity?.backend !== binding.backend || identity.keyId !== binding.keyId) return false;
      return (await postAuditBatch(auth, [])).ok;
    } }).then(() => {
      scheduled.clear();
      for (const entry of outbox.readPending()) if (entry.notBefore !== undefined) scheduled.add(entry.id);
    }).catch(failed).finally(() => { running = null; });
    return running;
  }

  return {
    outbox, kick, status: () => outbox.status(),
    async authenticationSucceeded(auth) {
      try { await outbox.authenticationSucceeded(auditLogin(auth)); }
      catch (error) { failed(error); }
    },
    async planRequestFailed(auth, key, reason, notBefore) {
      try {
        const binding = auditLogin(auth);
        outbox.prepare(binding);
        const event = clientEvent("plan_request_failed", "health", 1, reason, notBefore ?? deps.clock?.now() ?? Date.now(), clientRowId("plan_request_failed", key, "decision"));
        if (!await outbox.updateScheduled(event, binding, notBefore)) outbox.enqueue(event, { binding, ...(notBefore !== undefined ? { notBefore } : {}) });
        if (notBefore !== undefined) scheduled.add(event.event_id);
        else scheduled.delete(event.event_id);
      } catch (error) { failed(error); }
    },
    async planRequestSucceeded(auth, key) {
      const id = clientRowId("plan_request_failed", key, "decision");
      if (!scheduled.has(id)) return;
      try { await outbox.cancelScheduled(id, auditLogin(auth)); scheduled.delete(id); }
      catch (error) { failed(error); }
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
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      void kick();
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      await Promise.race([outbox.persist().catch(failed), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
