import { compile, parseYaml, type PolicyDocument } from "@armoriq/policy-ir";
import type { BundleAgent, BundlePolicyEntry } from "../../src/core/policy-v2.ts";

// Compiles armor.io/v2 YAML the way the backend does, so tests evaluate real documents.
export function v2Doc(policyId: string, target: "org" | "agent", rules: Record<string, "allow" | "hold" | "block">): PolicyDocument {
  const lines = Object.entries(rules).map(([tool, action]) => `      ${tool}: ${action}`);
  const yaml = [
    "apiVersion: armor.io/v2",
    "kind: Policy",
    "metadata:",
    `  name: ${policyId}`,
    "target:",
    target === "org" ? '  org: "*"' : "  agent: armoropencode",
    "spec:",
    "  approvalDefaults:",
    "    approvers: 1",
    "    anyMember: true",
    "  tools:",
    "    default: allow",
    "    rules:",
    ...lines,
  ].join("\n");
  const parsed = parseYaml(yaml) as { source?: unknown };
  const result = compile(parsed.source as never, [], { policyId });
  if (!result.document) throw new Error(JSON.stringify(result.diagnostics));
  return result.document;
}

export function entry(
  name: string,
  targetType: "org" | "agent",
  status: "active" | "shadow",
  rules: Record<string, "allow" | "hold" | "block">,
): BundlePolicyEntry {
  return { policyId: `id-${name}`, name, policyHash: `hash-${name}`, document: v2Doc(`id-${name}`, targetType, rules), targetType, status };
}

export function agentWith(policies: BundlePolicyEntry[], over: Partial<BundleAgent> = {}): BundleAgent {
  return { agentId: "armoropencode", name: "armoropencode", inactive: false, policy: null, policies, tools: [], members: [], ...over };
}
