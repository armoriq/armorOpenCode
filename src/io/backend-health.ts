import type { Login } from "../types.ts";
import { authHeaders, type CallResult } from "./backend-audit.ts";

export const BUNDLE_AGENT = "armoropencode";

export async function probeBackend(login: Login, timeoutMs: number): Promise<CallResult<void>> {
  try {
    const url = new URL(`${login.backend}/policy/bundles/current`);
    url.searchParams.set("agent", BUNDLE_AGENT);
    const response = await fetch(url, { headers: authHeaders(login.apiKey), signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (response.status === 401) return { ok: false, retryable: false, unauthorized: true, status: 401, reason: "policy bundle returned 401" };
    if (response.status >= 500) return { ok: false, retryable: true, unreachable: true, reason: `policy bundle returned ${response.status}` };
    return { ok: true, value: undefined };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, retryable: true, unreachable: true, reason: timedOut ? `no answer within ${timeoutMs} ms` : `network error: ${String(error)}` };
  }
}
