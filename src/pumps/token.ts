import { mintToken, revoke as revokePlan } from "../io/backend-intent.ts";
import type { SessionStore } from "../state/sessions.ts";
import type { Log, Login, Pump, SessionID } from "../types.ts";

export const REFRESH_BEFORE_MS = 60_000;
const CHECK_EVERY_MS = 15_000;
const STOP_WAIT_MS = 2_000;

export type TokenPump = Pump & { revoke(sessionId: string): void };

// Refresh 60 s before expiry; revoke on close. Never on the tool-call path.
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

  const track = (p: Promise<void>) => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const refreshDue = async () => {
    const auth = login();
    if (!auth) return;
    for (const s of [...sessions.all()]) {
      if (stopped) return;
      if (s.parentId !== null || !s.plan || s.token?.status !== "active") continue;
      if (s.token.expiresAt - now() > REFRESH_BEFORE_MS) continue;
      const plan = s.plan;
      const { id: _id, ...unminted } = plan;
      const result = await mintToken(auth, unminted, s.id);
      if (!sessions.has(s.id) || sessions.get(s.id).plan !== plan) continue;
      if (!result.ok) {
        log.warn("intent token refresh failed", { sessionID: s.id, reason: result.reason });
        continue;
      }
      if (result.value.token.status === "refused") {
        sessions.setToken(s.id, result.value.token);
        continue;
      }
      const planId = result.value.planId || plan.id;
      if (planId === plan.id) {
        sessions.setToken(s.id, result.value.token);
        continue;
      }
      const cursor = s.stepCursor;
      sessions.setPlan(s.id, { ...plan, id: planId }, result.value.token);
      sessions.advance(s.id, cursor - 1);
    }
  };

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
