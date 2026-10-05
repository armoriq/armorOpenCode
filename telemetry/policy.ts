import { loadActivePolicy, evaluateLocalPolicy } from "../src/local-policy.ts";
import { loadPlan, planAgeSeconds } from "../src/planner.ts";
import { planContainsTool } from "../src/intent-schema.ts";
import { isAlwaysAllowedNativeTool, isArmorPolicyTool } from "../src/tool-name-map.ts";

export interface PolicyGateOptions {
  dataDir: string;
  intentRequired?: boolean;
  planTtlSeconds?: number;
}

export interface PolicyGateResult {
  allowed: boolean;
  reason: string;
}

/** Evaluate one OpenCode tool call without ever throwing. */
export function evaluateToolCall(
  options: PolicyGateOptions,
  sessionId: string,
  toolName: string,
): PolicyGateResult {
  if (isArmorPolicyTool(toolName) || isAlwaysAllowedNativeTool(toolName)) {
    return { allowed: true, reason: "ArmorOpenCode management/native tool" };
  }

  const active = loadActivePolicy(options.dataDir);
  if (active.status === "invalid") {
    return { allowed: false, reason: `Local policy is invalid: ${active.error}` };
  }
  if (active.status === "ok") {
    const verdict = evaluateLocalPolicy(active.policy, toolName);
    if (verdict.decision === "deny") return { allowed: false, reason: verdict.reason };
  }

  if (options.intentRequired !== false) {
    const plan = loadPlan(options.dataDir, sessionId);
    const ttl = options.planTtlSeconds ?? 600;
    if (!plan) return { allowed: false, reason: "Intent plan missing. Call armor-opencode-policy_register_intent_plan first." };
    if (planAgeSeconds(options.dataDir, sessionId) > ttl) return { allowed: false, reason: "Intent plan expired. Register a new plan before calling tools." };
    if (!planContainsTool(plan, toolName)) return { allowed: false, reason: `Tool ${toolName} is not in the registered intent plan.` };
  }

  return { allowed: true, reason: "ArmorOpenCode policy allows the tool" };
}
