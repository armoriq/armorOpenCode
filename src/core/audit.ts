import type { AuditRow, AuditStatus, Decision, Session, ToolCall } from "../types.ts";

export type AuditInput = {
  call: ToolCall;
  session: Session;
  root: Session;
  status: AuditStatus;
  decision: Decision | null;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  at: number;
  userId?: string;
};

// Drift and plan-missing rows omit plan_id so the backend does not fail the plan (design Q2).
export function toAuditRow(input: AuditInput): AuditRow {
  throw new Error("not implemented");
}
