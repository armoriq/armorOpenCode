import type { CallResult } from "../io/backend-audit.ts";
import type { Log, Login } from "../types.ts";

export const PROBE_TIMEOUT_MS = 2_000;
export const RECHECK_AFTER_MS = 30_000;

export type Reachability = "reachable" | "unreachable";
export type Seen = { state: Reachability; at: number; reason: string };

export interface BackendPosture {
  // What a backend call saw in the last 30 s, else a fresh probe with a 2 s timeout. Concurrent callers share one probe.
  check(login: Login): Promise<Reachability>;
  // Starts a probe when the last answer is stale, without waiting for it.
  warm(login: Login): void;
  // Every backend call reports here: a timeout, network error or 5xx marks the backend unreachable,
  // any other answer marks it reachable, and a 401 signs the developer out instead.
  report(result: CallResult<unknown>): void;
  seen(): Seen | null;
}

export function createBackendPosture(deps: {
  probe: (login: Login, timeoutMs: number) => Promise<CallResult<void>>;
  log: Log;
  onUnauthorized: (reason: string) => void;
  onRecovered: () => void;
  now?: () => number;
}): BackendPosture {
  const now = deps.now ?? Date.now;
  let last: Seen | null = null;
  let probing: Promise<Reachability> | null = null;

  function mark(state: Reachability, reason: string): void {
    const was = last?.state;
    last = { state, at: now(), reason };
    if (state === "unreachable" && was !== "unreachable") deps.log.warn("ArmorIQ backend unreachable", { reason });
    if (state === "reachable" && was === "unreachable") {
      deps.log.info("ArmorIQ backend reachable again");
      deps.onRecovered();
    }
  }

  function report(result: CallResult<unknown>): void {
    if (result.ok) return mark("reachable", "");
    if (result.unauthorized) return deps.onUnauthorized(result.reason);
    if (result.unreachable) return mark("unreachable", result.reason);
    if (result.status !== undefined) mark("reachable", "");
  }

  const fresh = () => (last && now() - last.at < RECHECK_AFTER_MS ? last.state : null);

  function probe(login: Login): Promise<Reachability> {
    probing ??= deps
      .probe(login, PROBE_TIMEOUT_MS)
      .catch((error): CallResult<void> => ({ ok: false, retryable: true, unreachable: true, reason: String(error) }))
      .then((result) => {
        report(result);
        return last?.state ?? "reachable";
      })
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  return {
    check: async (login) => fresh() ?? probe(login),
    warm(login) {
      if (!fresh()) void probe(login);
    },
    report,
    seen: () => last,
  };
}
