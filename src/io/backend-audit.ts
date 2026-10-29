import { clientHeaders } from "@armoriq/sdk/dist/client_identity.js";
import { isReloginRequired } from "@armoriq/sdk/dist/credentials.js";
import { CLIENT } from "./credentials.ts";
import type { AuditRow, BatchAck, Login } from "../types.ts";

export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; retryable: boolean; retryAfterMs?: number; relogin?: boolean; reason: string };

// The backend can spend 15 s on a batch (10 s budget plus a 5 s row timeout). Abandoning
// sooner makes the client resend batches the server already committed.
export const BATCH_TIMEOUT_MS = 20_000;
export const MAX_BATCH_ROWS = 200;
const PAYLOAD_TOO_LARGE = 413;

const CLIENT_HEADERS = clientHeaders(CLIENT);

export function authHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey, ...CLIENT_HEADERS };
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// An index outside the batch means the ack does not describe these rows, so none counts as written.
function parseFailures(body: unknown, rowCount: number): BatchAck["failures"] | null {
  if (typeof body !== "object" || body === null) return null;
  const failures = (body as { failures?: unknown }).failures;
  if (!Array.isArray(failures)) return null;
  const valid = failures.every(
    (f) =>
      typeof f === "object" && f !== null && Number.isInteger(f.index) && f.index >= 0 && f.index < rowCount && typeof f.error === "string",
  );
  return valid ? failures : null;
}

// POST /iap/audit/batch. 200 carries per-row failures; a 2xx without them is a failed send.
export async function postAuditBatch(
  login: Login,
  rows: readonly AuditRow[],
  timeoutMs = BATCH_TIMEOUT_MS,
): Promise<CallResult<BatchAck>> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${login.backend}/iap/audit/batch`, {
      method: "POST",
      headers: authHeaders(login.apiKey),
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, retryable: true, reason: `audit batch request failed: ${String(error)}` };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const status = response.status;
  if (isReloginRequired(status, body)) return { ok: false, retryable: false, relogin: true, reason: "relogin_required" };
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      // Only 413 is about this batch, and a smaller one can pass. A whole-request 400 or 422 comes
      // from the envelope, a proxy or a DTO mismatch, so it is retried unchanged like a 5xx.
      retryable: status !== PAYLOAD_TOO_LARGE,
      retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      reason: `audit batch returned ${status}: ${text.slice(0, 200)}`,
    };
  }
  const failures = parseFailures(body, rows.length);
  if (!failures) return { ok: false, retryable: true, reason: `audit batch returned ${status} without a valid failures list: ${text.slice(0, 200)}` };
  const written = typeof (body as { written?: unknown }).written === "number" ? (body as { written: number }).written : rows.length - failures.length;
  return { ok: true, value: { written, failures } };
}
