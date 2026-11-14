import { clientHeaders } from "@armoriq/sdk-dev/dist/client_identity.js";
import type { Login } from "../types.ts";
import type { CallResult } from "./backend-audit.ts";
import { CLIENT } from "./credentials.ts";

const CLIENT_HEADERS = clientHeaders(CLIENT);

// GET /auth/health, which needs no key. Any answer below 500 means the backend is up.
export async function probeBackend(login: Login, timeoutMs: number): Promise<CallResult<void>> {
  try {
    const response = await fetch(`${login.backend}/auth/health`, { headers: CLIENT_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (response.status >= 500) return { ok: false, retryable: true, unreachable: true, reason: `health check returned ${response.status}` };
    return { ok: true, value: undefined };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, retryable: true, unreachable: true, reason: timedOut ? `no answer within ${timeoutMs} ms` : `network error: ${String(error)}` };
  }
}
