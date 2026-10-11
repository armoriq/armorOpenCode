import type { AuditRow, AuditStatus, Decision, Session, ToolCall } from "../types.ts";
import { MAX_PARAM_CHARS, redactText, sanitizeParams } from "./sanitize.ts";

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
  userEmail?: string;
};

export const AGENT_ID = "opencode";
export const CLIENT_ID = "armoropencode";
export const CHILD_SESSION_KEY = "_opencode_session";

const PLANLESS_CODES = new Set(["intent_drift", "intent_plan_missing"]);

const clip = (text: string) => redactText(text.length > MAX_PARAM_CHARS ? text.slice(0, MAX_PARAM_CHARS) : text);

function denialText(decision: Decision): string | undefined {
  if (decision.kind === "deny") return clip(`${decision.code}: ${decision.reason}`);
  if (decision.kind === "hold") return clip(`approval_required: ${decision.reason}`);
  return undefined;
}

// Drift and plan-missing rows omit plan_id so the backend does not fail the plan (design Q2).
export function toAuditRow(input: AuditInput): AuditRow {
  const { call, session, root, status, decision } = input;
  const plan = root.plan;
  const matched = status !== "blocked" && status !== "held" && decision?.kind === "allow" ? decision.stepIndex : null;
  const step = matched !== null && plan ? plan.steps[matched] : undefined;
  const planless = decision?.kind === "deny" && PLANLESS_CODES.has(decision.code);

  const params = sanitizeParams(call.args);
  // A subagent's rows carry the root session id; the child id rides along so the run stays traceable.
  const args = session.id === root.id ? params : { ...params, [CHILD_SESSION_KEY]: session.id };

  const row: AuditRow = {
    session_id: root.id,
    agent_id: AGENT_ID,
    client_id: CLIENT_ID,
    step_index: step && matched !== null ? matched : -1,
    action: step?.action ?? call.tool,
    tool: call.tool,
    input: args,
    status,
    executed_at: new Date(input.at - (input.durationMs ?? 0)).toISOString(),
  };
  if (plan && !planless) row.plan_id = plan.id;
  if (input.userId) row.user_id = input.userId;
  if (input.userEmail) row.user_email = input.userEmail;
  if (status === "success") row.output = { title: call.tool, output: clip(input.output ?? "") };
  const errorText = input.error !== null ? clip(input.error) : decision ? denialText(decision) : undefined;
  if (status !== "success" && errorText) row.error_message = errorText;
  if (input.durationMs !== null) row.duration_ms = input.durationMs;
  return row;
}
