import type { CompiledPolicy, Decision, Session, ToolCall } from "../types.ts";
import type { BuiltinContext } from "./builtin-rules.ts";

export type DecideInput = {
  policy: CompiledPolicy;
  session: Session;
  root: Session;
  call: ToolCall;
  now: number;
  builtin: BuiltinContext;
};

// Order: builtin rules, policy, then plan and token (memory checks only). Pure.
export function decide(input: DecideInput): Decision {
  throw new Error("not implemented");
}
