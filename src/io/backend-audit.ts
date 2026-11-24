import { clientHeaders } from "@armoriq/sdk-dev/dist/client_identity.js";
import { isReloginRequired } from "@armoriq/sdk-dev/dist/credentials.js";
import { CLIENT } from "./credentials.ts";
import type { AuditRow, BatchAck, Login } from "../types.ts";
import { AUDIT_SIZE_LIMITS } from "./audit-size.ts";

export type CallResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      retryable: boolean;
      unconfirmed?: boolean;
      retryAfterMs?: number;
      relogin?: boolean;
      // The HTTP status, when the backend answered at all.
      status?: number;
      // A timeout, network error or 5xx: the AC-11 signals that the backend is down.
      unreachable?: boolean;
      // A 401: the key is no longer accepted, which means signed out rather than unreachable.
      unauthorized?: boolean;
      legacyRefusal?: boolean;
      nonTransient?: boolean;
      tooLarge?: boolean;
      reason: string;
    };

// The backend can spend 15 s on a batch (10 s budget plus a 5 s row timeout). Abandoning
// sooner makes the client resend batches the server already committed.
export const BATCH_TIMEOUT_MS = 20_000;
export const MAX_BATCH_ROWS = AUDIT_SIZE_LIMITS.maxBatchRows;

const CLIENT_HEADERS = clientHeaders(CLIENT);

// Monitor-Aware tells the backend this build runs Monitor itself: it gets the real policy and mode, and its
// audit rows keep the would_be verdict they carry.
export function authHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey, ...CLIENT_HEADERS, "X-ArmorIQ-Monitor-Aware": "1" };
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
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
  return valid && new Set(failures.map(f => f.index)).size === failures.length ? failures : null;
}

// New results are authoritative even on a refusal status. The whole list is checked before settlement.
export function parseAuditReply(status: number, body: unknown, headers: Headers, rows: readonly AuditRow[], now = Date.now()): CallResult<BatchAck> {
  const delay = retryAfterMs(headers.get("retry-after"), now);
  const failed = (reason: string): CallResult<BatchAck> => ({ ok: false, retryable: true, status, reason, ...(delay === undefined ? {} : { retryAfterMs: delay }) });
  if (status === 401) return { ok: false, retryable: false, unauthorized: true, status, reason: "audit batch returned 401" };
  if (body && typeof body === "object" && Object.hasOwn(body, "results")) {
    const results = (body as { results: unknown }).results;
    const sent = new Set(rows.map(row => row.client_row_id));
    const seen = new Set<string>();
    if (!Array.isArray(results) || !results.every(result => {
      if (!result || typeof result !== "object" || typeof result.client_row_id !== "string" || !sent.has(result.client_row_id) || seen.has(result.client_row_id) ||
          !["accepted", "duplicate", "retryable", "rejected"].includes(result.outcome) || (result.error !== undefined && typeof result.error !== "string")) return false;
      seen.add(result.client_row_id);
      return true;
    })) return failed("audit batch returned an invalid results list");
    return { ok: true, value: { written: results.filter(r => r.outcome === "accepted" || r.outcome === "duplicate").length, failures: [], results, ...(delay === undefined ? {} : { retryAfterMs: delay }) } };
  }
  if (isReloginRequired(status, body)) return { ok: false, retryable: false, relogin: true, status, reason: "relogin_required" };
  if (status < 200 || status >= 300) {
    const jsonRefusal = body !== null && typeof body === "object" && !Array.isArray(body);
    const refusal = body as { statusCode?: unknown; message?: unknown; error?: unknown } | null;
    const legacyRefusal = (status === 400 || status === 422) && jsonRefusal && refusal?.statusCode === status &&
      typeof refusal.error === "string" && (typeof refusal.message === "string" || (Array.isArray(refusal.message) && refusal.message.every(message => typeof message === "string")));
    const inProgress = status === 409 && jsonRefusal && (body as { error?: unknown }).error === "request_in_progress";
    const nonTransient = status >= 400 && status < 500 && ![400, 401, 403, 408, 422, 429].includes(status) && !inProgress;
    return { ok: false, retryable: true, status, unreachable: status >= 500, legacyRefusal, nonTransient, tooLarge: status === 413,
      ...(delay === undefined ? {} : { retryAfterMs: delay }), reason: `audit batch returned ${status}` };
  }
  const failures = parseFailures(body, rows.length);
  if (!failures) return failed(`audit batch returned ${status} without a valid failures list`);
  const written = typeof (body as { written?: unknown }).written === "number" ? (body as { written: number }).written : rows.length - failures.length;
  return { ok: true, value: { written, failures, ...(delay === undefined ? {} : { retryAfterMs: delay }) } };
}

// POST /iap/audit/batch. A readable per row reply is the proof required to acknowledge delivery.
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
    return { ok: false, retryable: true, unreachable: true, reason: `audit batch request failed: ${String(error)}` };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return parseAuditReply(response.status, body, response.headers, rows);
}
