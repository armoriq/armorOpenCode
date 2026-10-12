import type { ToolDefinition } from "@opencode-ai/plugin";
import type { Runtime } from "../runtime.ts";

export const OWN_TOOL_NAMES: readonly string[] = ["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"];

export function intentTools(rt: Runtime): Record<string, ToolDefinition> {
  throw new Error("not implemented");
}

export const INTENT_DIRECTIVE = "";
