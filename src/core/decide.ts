import type { CompiledPolicy, Decision, DecidingPolicy, Session, ToolCall } from "../types.ts";
import { checkBuiltin, type BuiltinContext } from "./builtin-rules.ts";
import { checkCall, READ_ONLY_TOOLS } from "./intent.ts";
import { compilePolicy, DEFAULT_POLICY_SOURCE } from "./policy.ts";
import type { V2Outcome } from "./policy-v2.ts";

export type DecideInput = {
  policy: CompiledPolicy;
  session: Session;
  root: Session;
  call: ToolCall;
  now: number;
  builtin: BuiltinContext;
  // The workspace's v2 bundle verdict, or null when the plugin is signed out or has no bundle yet.
  v2?: V2Outcome | null;
};

const RECOVER =
  "Call register_intent_plan with the full updated plan, including this step, and a reason, then retry.";

function deny(code: Extract<Decision, { kind: "deny" }>["code"], reason: string, ruleId: string | null = null): Decision {
  return { kind: "deny", code, reason, ruleId };
}

// The built-in policy that applies when there is no policy.json counts as "default", not a local rule.
const builtinDefault = compilePolicy(DEFAULT_POLICY_SOURCE);
const DEFAULT_HASH = builtinDefault.ok ? builtinDefault.policy.hash : null;

const NO_PROMPT_HINT =
  "OpenCode has no approval prompt, so the call was blocked. Ask a workspace admin to allow it in the ArmorIQ console, then retry.";

// Order: builtin rules, policy, then plan and token (memory checks only). Pure.
// A child session is checked against its root's plan and token. `token.expiresAt`
// and `now` are epoch milliseconds. Every decision carries the policy layer that decided it.
export function decide(input: DecideInput): Decision {
  const builtinDecision = checkBuiltin(input.call, input.builtin);
  if (builtinDecision) return { ...builtinDecision, policy: { source: "builtin" } };
  if (input.builtin.ownTools.has(input.call.tool)) {
    return { kind: "allow", stepIndex: null, paramMismatch: false, policy: { source: "builtin" } };
  }
  const v1 = input.policy.evaluate(input.call);
  const isDefault = input.policy.hash === DEFAULT_HASH;
  const local: DecidingPolicy = isDefault ? { source: "default" } : { source: "local", ...(v1.ruleId ? { rule_id: v1.ruleId } : {}) };
  const v2 = input.v2?.enforced ?? null;
  const shadow = input.v2?.shadow.length ? { shadow: input.v2.shadow } : {};
  const v2Policy: DecidingPolicy | null = v2
    ? {
        source: "v2",
        ...(v2.policy ? { policy_id: v2.policy.policyId, policy_name: v2.policy.name } : {}),
        ...(v2.policy?.policyHash ? { policy_hash: v2.policy.policyHash } : {}),
        rule_id: v2.rule,
      }
    : null;
  const named = v2?.policy ? `ArmorIQ policy "${v2.policy.name}"` : "ArmorIQ policy";

  // Strictest wins across v2 and the local policy: a block from either, then a hold, then allow.
  // A v2 hold becomes a block because OpenCode cannot ask the user to approve a call.
  let decision: Decision;
  let by: DecidingPolicy;
  if (v2?.verdict === "block" && v2Policy) {
    decision = deny("policy_v2_block", `${named} blocks ${input.call.tool} (${v2.rule})`, v2.rule);
    by = v2Policy;
  } else if (v1.effect === "forbid") {
    decision = deny("policy_forbid", v1.reason, v1.ruleId);
    by = local;
  } else if (v2?.verdict === "hold" && v2Policy) {
    decision = deny("policy_v2_hold", `${named} requires approval for ${input.call.tool} (${v2.rule}). ${NO_PROMPT_HINT}`, v2.rule);
    by = v2Policy;
  } else {
    decision = afterPolicy(input, v1.effect === "require_approval" ? { kind: "hold", ruleId: v1.ruleId, reason: v1.reason } : null);
    // v2 is credited only with what it decided: an allow. Plan and token denials are not policy verdicts.
    by = decision.kind === "allow" && v2Policy ? v2Policy : local;
  }
  return { ...decision, policy: { ...by, ...shadow } };
}

function afterPolicy(input: DecideInput, policyHold: Decision | null): Decision {
  const { session, root, call, now } = input;

  if (session.mode === "monitor" || !input.policy.intentRequired) {
    return policyHold ?? { kind: "allow", stepIndex: null, paramMismatch: false };
  }

  const token = root.token;
  // Read-only tools need no plan, but the backend's veto on a live token still applies.
  if (READ_ONLY_TOOLS.has(call.tool)) {
    if (token?.status === "active" && now < token.expiresAt) {
      if (token.deniedTools.has(call.tool)) return deny("backend_denied_tool", `ArmorIQ denied ${call.tool} for this plan`);
      if (token.heldTools.has(call.tool)) return { kind: "hold", ruleId: null, reason: `ArmorIQ holds ${call.tool} for approval` };
    }
    return policyHold ?? { kind: "allow", stepIndex: null, paramMismatch: false };
  }

  if (token?.status === "refused") {
    return token.code === "account_revoked"
      ? deny("account_revoked", "the ArmorIQ API key was revoked; run `armoriq login` again")
      : deny("billing_blocked", "the ArmorIQ subscription is inactive or over quota");
  }

  const plan = root.plan;
  if (!plan) {
    return deny(
      "intent_plan_missing",
      `no intent plan is registered for this session. Call register_intent_plan with your goal and the tools you will use (including ${call.tool}), then retry.`,
    );
  }
  if (!token) {
    return deny("intent_plan_missing", `the intent plan has no token. ${RECOVER}`);
  }
  if (now >= token.expiresAt) {
    return deny("intent_token_expired", `the intent token expired. ${RECOVER}`);
  }

  const check = checkCall(plan, call, root.stepCursor);
  if (!check.inPlan) return deny("intent_drift", `${call.tool} not in plan. ${RECOVER}`);

  const step = check.stepIndex === null ? undefined : plan.steps[check.stepIndex];
  const named = (set: ReadonlySet<string>) => set.has(call.tool) || (step !== undefined && set.has(step.action));
  if (named(token.deniedTools)) {
    return deny("backend_denied_tool", `ArmorIQ denied ${call.tool} for this plan`);
  }
  if (named(token.heldTools)) return { kind: "hold", ruleId: null, reason: `ArmorIQ holds ${call.tool} for approval` };
  if (policyHold) return policyHold;

  return { kind: "allow", stepIndex: check.stepIndex, paramMismatch: check.paramMismatch };
}
