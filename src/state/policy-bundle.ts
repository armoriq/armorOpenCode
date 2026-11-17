import { authHeaders } from "../io/backend-audit.ts";
import type { BundleAgent } from "../core/policy-v2.ts";
import type { Log, Login } from "../types.ts";

export const BUNDLE_AGENT = "armoropencode";
export const REVALIDATE_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

export type BundleState =
  | { status: "unavailable" }
  | { status: "current"; agent: BundleAgent | undefined; checkedAt: number }
  // The backend has not confirmed the bundle within REVALIDATE_MS, so the last one is kept.
  | { status: "stale"; agent: BundleAgent | undefined; checkedAt: number };

export interface PolicyBundle {
  // Revalidates when the last answer is older than maxAgeMs. Concurrent callers share one request.
  // A timer also revalidates every REVALIDATE_MS, so a console edit lands within that window.
  refresh(login: Login, maxAgeMs?: number): Promise<void>;
  state(login: Login): BundleState;
  stop(): void;
}

type Cached = { key: string; etag: string; agent: BundleAgent | undefined; hash: string; confirmedAt: number };

// GET /policy/bundles/current with ETag revalidation, the same contract as the SDK's PolicyBundleCache.
// Written here because the SDK's cache reports failures on console.warn, which lands in the host's terminal.
export function createPolicyBundle(deps: {
  log: Log;
  login: () => Login | null;
  fetch?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
}): PolicyBundle {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  let cached: Cached | null = null;
  // Set after every attempt, failed ones included, so an unreachable backend is not retried on every call.
  let tried: { key: string; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  let failing = false;

  const keyOf = (login: Login) => `${login.backend} ${login.orgId} ${login.apiKey.slice(-8)}`;

  async function load(login: Login, key: string): Promise<void> {
    const prior = cached?.key === key ? cached : null;
    const url = new URL(`${login.backend}/policy/bundles/current`);
    url.searchParams.set("agent", BUNDLE_AGENT);
    const headers: Record<string, string> = { ...authHeaders(login.apiKey) };
    if (prior?.etag) headers["If-None-Match"] = prior.etag;
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status === 304 && prior) {
        await res.body?.cancel();
        prior.confirmedAt = now();
      } else if (res.status === 200) {
        const body = (await res.json()) as { agents?: BundleAgent[] };
        const agent = body.agents?.find((a) => a.agentId === BUNDLE_AGENT || a.name === BUNDLE_AGENT);
        const etag = res.headers.get("etag") ?? "";
        const hash = describe(agent);
        if (hash !== prior?.hash) deps.log.info("policy v2 bundle loaded", { agent: BUNDLE_AGENT, policies: hash });
        cached = { key, etag, agent, hash, confirmedAt: now() };
      } else {
        await res.body?.cancel();
        throw new Error(`policy bundle answered ${res.status}`);
      }
      if (failing) deps.log.info("policy v2 bundle reachable again");
      failing = false;
    } catch (error) {
      if (!failing) deps.log.warn("policy v2 bundle fetch failed; keeping the last bundle", { error: String(error) });
      failing = true;
    } finally {
      tried = { key, at: now() };
    }
  }

  function refresh(login: Login, maxAgeMs = 0): Promise<void> {
    const key = keyOf(login);
    if (tried?.key === key && now() - tried.at < maxAgeMs) return Promise.resolve();
    inflight ??= load(login, key).finally(() => (inflight = null));
    return inflight;
  }

  const timer = setInterval(() => {
    const login = deps.login();
    if (login) void refresh(login);
  }, deps.intervalMs ?? REVALIDATE_MS);
  timer.unref?.();

  return {
    refresh,
    state(login) {
      if (!cached || cached.key !== keyOf(login)) return { status: "unavailable" };
      const status = now() - cached.confirmedAt < REVALIDATE_MS * 2 ? "current" : "stale";
      return { status, agent: cached.agent, checkedAt: cached.confirmedAt };
    },
    stop: () => clearInterval(timer),
  };
}

function describe(agent: BundleAgent | undefined): string {
  if (!agent) return "none";
  const entries = agent.policies ?? (agent.policy ? [{ ...agent.policy, targetType: "agent", status: "active" }] : []);
  return entries.map((p) => `${p.targetType}:${p.status}:${p.name}:${p.policyHash ?? "?"}`).join(",") || "none";
}
