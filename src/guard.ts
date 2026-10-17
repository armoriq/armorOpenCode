import { evaluatePolicy, type PolicyLoad } from "./policy.ts";

export type Mode = "enforce" | "watch";

export type Verdict =
  | { kind: "allow"; ruleId?: string }
  | { kind: "block"; reason: string }
  | { kind: "observe"; reason: string };

function unevaluable(mode: Mode, reason: string): Verdict {
  return mode === "enforce" ? { kind: "block", reason } : { kind: "observe", reason };
}

// Watch mode never blocks: it reports what enforce mode would have done.
export function decide(input: { mode: Mode; load: PolicyLoad; tool: string; args: unknown }): Verdict {
  const { mode, load, tool, args } = input;
  switch (load.kind) {
    case "none":
      return { kind: "allow" };
    case "invalid":
      return unevaluable(mode, `ArmorOpenCode blocked ${tool}: policy is configured but cannot be evaluated (${load.error})`);
    case "loaded": {
      let decision;
      try {
        decision = evaluatePolicy(load.policy, tool, args);
      } catch (error) {
        return unevaluable(mode, `ArmorOpenCode blocked ${tool}: policy evaluation failed (${String(error)})`);
      }
      if (decision.kind === "allow") return { kind: "allow", ruleId: decision.ruleId };
      return mode === "enforce" ? { kind: "block", reason: decision.reason } : { kind: "observe", reason: decision.reason };
    }
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}
