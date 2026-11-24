import type { RunReport } from "../core/runs.ts";
import { runTransportId } from "../core/runs.ts";
import type { Login } from "../types.ts";
import { authHeaders, BATCH_TIMEOUT_MS } from "./backend-audit.ts";
import { parseRetryAfter } from "./backend-intent.ts";
import type { SendResult } from "./outbox.ts";

// A malformed list acknowledges nothing. Missing entries retry independently of accepted entries.
export function parseRunsReply(status: number, body: unknown, headers: Headers, reports: readonly RunReport[], now = Date.now()): SendResult<RunReport> {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after") ?? undefined, now);
  const failed = (reason: string): Extract<SendResult<RunReport>, { ok: false }> => ({ ok: false, endpointStatus: status, retryAfterMs, reason,
    stallReason: status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "backend_unreachable" });
  if (status === 404) return failed("runs endpoint unavailable");
  if (status === 403 && (body as { error?: unknown } | null)?.error === "org_required") return { ok: false, endpointStatus: status, hold: "org_required", reason: "org_required" };
  const unauthorized = (): SendResult<RunReport> => ({ ok: false, endpointStatus: status, relogin: true, reason: "runs authentication refused", stallReason: "auth_paused" });
  if (status === 401) return unauthorized();
  if (!body || typeof body !== "object" || !Object.hasOwn(body, "results")) {
    if (status === 403) return unauthorized();
    if (status === 400 || status === 422) return { ...failed(`runs returned ${status}`), legacyRefusal: true };
    const inProgress = status === 409 && (body as { error?: unknown } | null)?.error === "request_in_progress";
    return { ...failed(`runs returned ${status} without a valid results list`),
      nonTransient: status >= 400 && status < 500 && ![408, 429].includes(status) && !inProgress, tooLarge: status === 413 };
  }
  const results = body && typeof body === "object" ? (body as { results?: unknown }).results : null;
  const sent = new Set(reports.map(runTransportId));
  const seen = new Set<string>();
  if (!Array.isArray(results) || !results.every((result: unknown) => {
    if (!result || typeof result !== "object") return false;
    const r = result as Record<string, unknown>;
    if (typeof r.run_id !== "string" || !Number.isSafeInteger(r.report_seq) ||
        !["accepted", "stale", "duplicate", "rejected", "retryable"].includes(String(r.outcome)) || (r.error !== undefined && typeof r.error !== "string")) return false;
    const id = runTransportId(r as unknown as RunReport);
    if (!sent.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  })) return status === 403 ? unauthorized() : failed("runs returned an invalid results list");
  const outcomes = new Map(results.map((result: { run_id: string; report_seq: number; outcome: string; error?: string }) => [runTransportId(result), result]));
  return { ok: true, endpointStatus: status, retryAfterMs, rejected: reports.flatMap(item => {
    const result = outcomes.get(runTransportId(item));
    return result && ["accepted", "stale", "duplicate"].includes(result.outcome) ? [] : [{ item, error: result?.error ?? "missing run outcome", permanent: result?.outcome === "rejected", transient: result?.outcome !== "rejected" }];
  }) };
}

export async function postRunsBatch(login: Login, reports: readonly RunReport[], timeoutMs = BATCH_TIMEOUT_MS): Promise<SendResult<RunReport>> {
  try {
    const response = await fetch(`${login.backend}/iap/runs/batch`, {
      method: "POST", headers: authHeaders(login.apiKey), body: JSON.stringify({ reports }), signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try { body = await response.json(); } catch {}
    return parseRunsReply(response.status, body, response.headers, reports);
  } catch {
    return { ok: false, reason: "runs request failed", stallReason: "backend_unreachable" };
  }
}
