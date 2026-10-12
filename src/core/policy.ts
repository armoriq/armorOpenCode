import type { CompiledPolicy } from "../types.ts";

export type CompileResult = { ok: true; policy: CompiledPolicy } | { ok: false; error: string };

// armor.policy.v1 IR as ArmorClaude dev scripts/lib/policy-ir.mjs; hash = canonicalPolicyHash.
// Patterns must be validated linear at compile time; matching reads only declared fields.
export function compilePolicy(raw: unknown): CompileResult {
  throw new Error("not implemented");
}

export const DEFAULT_POLICY_SOURCE: unknown = { version: "armor.policy.v1", rules: [] };
