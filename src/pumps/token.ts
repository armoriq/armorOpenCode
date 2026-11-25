import type { CallResult } from "../io/backend-audit.ts";
import { AGENT_ID, logLegacyBackend, mintToken, revoke as revokePlan } from "../io/backend-intent.ts";
import { intentValiditySeconds, planRequest, toSdkPlan } from "../core/plan-request.ts";
import type { SessionStore } from "../state/sessions.ts";
import type { Log, Login, Plan, Pump, Session, SessionID } from "../types.ts";
import type { HealthPump } from "./health.ts";

const PROMPT_IDLE_MS = 30 * 60_000;
const CHECK_EVERY_MS = 15_000;
const STOP_WAIT_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

export type TokenPump = Pump & { revoke(sessionId: string): void; refreshExpired(sessionId: SessionID): Promise<void> };

// Refresh only open prompts, in Enforce and Monitor alike, with backoff after a failure. The tool guard shares this serialized path.
export function createTokenPump(deps: {
  sessions: SessionStore;
  login: () => Login | null;
  log: Log;
  report?: (result: CallResult<unknown>, login?: Login) => void;
  now?: () => number;
  checkEveryMs?: number;
  health?: HealthPump;
}): TokenPump {
  const { sessions, login, log } = deps;
  const validity = intentValiditySeconds(process.env);
  const refreshBeforeMs = Math.min(120, validity / 3) * 1000;
  const now = deps.now ?? Date.now;
  const inflight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let refreshing: Promise<void> | null = null;
  let stopped = false;
  const failing = new Map<SessionID, { count: number; retryAt: number }>();

  const track = (p: Promise<void>) => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const due = (s: Session) =>
    s.parentId === null &&
    s.promptId !== null && s.promptOpenSince !== null &&
    s.lastActivityAt !== null && now() - s.lastActivityAt < PROMPT_IDLE_MS &&
    s.countedPlanId !== null &&
    s.plan !== null &&
    s.token?.status === "active" &&
    s.token.expiresAt - now() <= refreshBeforeMs &&
    now() >= (failing.get(s.id)?.retryAt ?? 0);

  const refreshDue = async () => {
    const auth = login();
    if (!auth) return;
    for (const id of failing.keys()) if (!sessions.has(id)) failing.delete(id);
    for (const s of [...sessions.all()]) {
      if (stopped) return;
      if (due(s)) {
        const generation = { promptId: s.promptId, promptGeneration: s.promptGeneration, authGeneration: s.authGeneration };
        await sessions.serialize(s.id, async () => {
          if (!sessions.isCurrent(s.id, generation) || !due(s)) return;
          const currentAuth = login();
          if (currentAuth) await refresh(currentAuth, s, s.plan!);
        });
      }
    }
  };

  async function refresh(auth: Login, s: Session, plan: Plan): Promise<void> {
    const generation = { promptId: s.promptId, promptGeneration: s.promptGeneration, authGeneration: s.authGeneration };
    const countedPlanId = s.countedPlanId!;
    const request = planRequest({ kind: "refresh", promptId: s.promptId!, countedPlanId, tokenExpiresAt: new Date(s.tokenExpiresAt!).toISOString() }, {
      user_id: auth.userId, agent_id: AGENT_ID, context_id: s.id, plan: toSdkPlan(plan), expires_in: validity,
    });
    if (s.pendingRequest && s.pendingRequest.key !== request.key) return;
    const saved = s.pendingRequest ?? request;
    const descriptor = { key: saved.key, headers: saved.headers, body: saved.body };
    try {
      if (!await sessions.persistRequest(s.id, descriptor, generation)) return;
    } catch {
      return failed(s.id, "could not persist the plan request");
    }
    const result = await mintToken(auth, descriptor, {
      log, captureFailure: () => deps.health?.outbox?.captureFailure(),
      cancelled: () => !sessions.isCurrent(s.id, generation) || s.promptOpenSince === null || now() - s.lastActivityAt! >= PROMPT_IDLE_MS,
      onFailure: (reason, notBefore) => deps.health?.planRequestFailed(auth, descriptor.key, reason, notBefore),
      onSuccess: async () => { await deps.health?.planRequestSucceeded(auth, descriptor.key); },
    });
    if (!sessions.isCurrent(s.id, generation)) {
      if (result.ok) discard(auth, s.id, result.value.planId, plan.id);
      return;
    }
    deps.report?.(result, auth);
    if (!result.ok) {
      if (!result.retryable && !result.unconfirmed) await sessions.persistRequest(s.id, null, generation);
      return failed(s.id, result.reason);
    }
    failing.delete(s.id);
    const { planId, token } = result.value;
    if (result.value.legacy) logLegacyBackend(log);
    if (!sessions.has(s.id) || sessions.get(s.id).plan !== plan) return discard(auth, s.id, planId, plan.id);
    sessions.setToken(s.id, token, generation, planId);
    await sessions.persistRequest(s.id, null, generation);
  }

  function failed(id: SessionID, reason: string): void {
    const count = (failing.get(id)?.count ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, CHECK_EVERY_MS * 2 ** (count - 1));
    failing.set(id, { count, retryAt: now() + delay });
    log.warn("intent token refresh failed", { sessionID: id, reason, retryInMs: delay });
  }

  // The session was deleted or re-registered while the mint ran, so nothing will ever use or revoke this plan.
  function discard(auth: Login, id: SessionID, planId: string, previousPlanId: string): void {
    if (!planId || planId === previousPlanId) return;
    const reason = sessions.has(id) ? "plan replaced during token refresh" : "opencode session deleted";
    track(
      revokePlan(auth, planId, reason).then((r) => {
        if (!r.ok) log.warn("intent token revoke failed", { sessionID: id, planId, reason: r.reason });
      }),
    );
  }

  const kick = () => {
    if (stopped || refreshing) return;
    refreshing = refreshDue()
      .catch((error) => log.error("token pump failed", { error: String(error) }))
      .finally(() => {
        refreshing = null;
      });
    track(refreshing);
  };

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(kick, deps.checkEveryMs ?? CHECK_EVERY_MS);
      timer.unref?.();
    },

    kick,

    async refreshExpired(id) {
      if (stopped || !sessions.has(id)) return;
      const s = sessions.get(id);
      const generation = { promptId: s.promptId, promptGeneration: s.promptGeneration, authGeneration: s.authGeneration };
      await sessions.serialize(id, async () => {
        if (stopped || !sessions.isCurrent(id, generation) || !due(s) || s.token?.status !== "active" || s.token.expiresAt > now()) return;
        const auth = login();
        if (auth) await refresh(auth, s, s.plan!);
      });
    },

    revoke(sessionId) {
      const id = sessionId as SessionID;
      if (!sessions.has(id)) return;
      const s = sessions.get(id);
      const auth = login();
      if (!auth || s.parentId !== null || !s.plan?.id || s.token?.status !== "active") return;
      const planIds = [...new Set([s.tokenPlanId, s.countedPlanId ?? s.plan.id].filter((value): value is string => !!value))];
      track(
        sessions.serialize(id, async () => {
          for (const planId of planIds) {
            const r = await revokePlan(auth, planId, "opencode session deleted");
            if (!r.ok) log.warn("intent token revoke failed", { sessionID: id, planId, reason: r.reason });
          }
        }),
      );
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (inflight.size === 0) return;
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((r) => {
          wait = setTimeout(r, STOP_WAIT_MS);
        }),
      ]);
      clearTimeout(wait);
    },
  };
}
