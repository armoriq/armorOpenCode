import { mintToken, revoke as revokePlan } from "../io/backend-intent.ts";
import type { SessionStore } from "../state/sessions.ts";
import type { Log, Login, Plan, Pump, Session, SessionID } from "../types.ts";

export const REFRESH_BEFORE_MS = 60_000;
const CHECK_EVERY_MS = 15_000;
const STOP_WAIT_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

export type TokenPump = Pump & { revoke(sessionId: string): void };

// Refresh 60 s before expiry, backing off per session after a failure; revoke on close. Never on the tool-call path.
export function createTokenPump(deps: {
  sessions: SessionStore;
  login: () => Login | null;
  log: Log;
  now?: () => number;
  checkEveryMs?: number;
}): TokenPump {
  const { sessions, login, log } = deps;
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
    s.plan !== null &&
    s.token?.status === "active" &&
    s.token.expiresAt - now() <= REFRESH_BEFORE_MS &&
    now() >= (failing.get(s.id)?.retryAt ?? 0);

  const refreshDue = async () => {
    const auth = login();
    if (!auth) return;
    for (const id of failing.keys()) if (!sessions.has(id)) failing.delete(id);
    for (const s of [...sessions.all()]) {
      if (stopped) return;
      if (due(s)) await refresh(auth, s, s.plan!);
    }
  };

  async function refresh(auth: Login, s: Session, plan: Plan): Promise<void> {
    const { id: _id, ...unminted } = plan;
    const result = await mintToken(auth, unminted, s.id);
    if (!result.ok) return failed(s.id, result.reason);
    failing.delete(s.id);
    const { planId, token } = result.value;
    if (!sessions.has(s.id) || sessions.get(s.id).plan !== plan) return discard(auth, s.id, planId, plan.id);
    if (token.status === "refused" || planId === plan.id) return sessions.setToken(s.id, token);
    const cursor = s.stepCursor;
    sessions.setPlan(s.id, { ...plan, id: planId }, token);
    sessions.advance(s.id, cursor - 1);
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

    revoke(sessionId) {
      const id = sessionId as SessionID;
      if (!sessions.has(id)) return;
      const s = sessions.get(id);
      const auth = login();
      if (!auth || s.parentId !== null || !s.plan?.id || s.token?.status !== "active") return;
      const planId = s.plan.id;
      track(
        revokePlan(auth, planId, "opencode session deleted").then((r) => {
          if (!r.ok) log.warn("intent token revoke failed", { sessionID: id, planId, reason: r.reason });
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
