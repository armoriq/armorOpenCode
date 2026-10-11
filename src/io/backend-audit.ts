import type { AuditRow, BatchAck, Login } from "../types.ts";

export type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; retryable: boolean; retryAfterMs?: number; relogin?: boolean; reason: string };

// POST /iap/audit/batch, 5 s timeout. 200 carries per-row failures.
export async function postAuditBatch(login: Login, rows: readonly AuditRow[]): Promise<CallResult<BatchAck>> {
  throw new Error("not implemented");
}
