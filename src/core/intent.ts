import type { Plan, ToolCall } from "../types.ts";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "list", "webfetch", "websearch", "todoread", "todowrite",
]);

export type ParsePlanResult = { ok: true; plan: Omit<Plan, "id"> } | { ok: false; error: string };

// ArmorClaude dev policy-mcp.mjs register_intent_plan argument handling.
export function parsePlan(raw: unknown, revision: number, messageId: string): ParsePlanResult {
  throw new Error("not implemented");
}

export type PlanCheck = { inPlan: boolean; stepIndex: number | null; paramMismatch: boolean };

export function checkCall(plan: Plan, call: ToolCall, cursor: number): PlanCheck {
  throw new Error("not implemented");
}
