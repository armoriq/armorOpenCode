import { evaluate, VERDICT_RANK, type CallInput, type Evaluation, type PolicyDocument, type Verdict } from "@armoriq/policy-ir";

import { mcpToolName, sanitizeMcpPart } from "./tools.ts";

export type { Verdict };

export type BundlePolicy = { policyId: string; name: string; policyHash: string | null; document: PolicyDocument };
export type BundlePolicyEntry = BundlePolicy & { targetType: "org" | "agent"; status: "active" | "shadow" };
export type BundleTool = { name: string; qualifiedName?: string; server?: string; reviewRequired?: boolean; schemaHash: string | null; capabilities: string[] };
export type BundleMember = { membershipId: string; email: string };

export type BundleAgent = {
  agentId: string;
  name: string;
  inactive: boolean;
  policy: BundlePolicy | null;
  // Absent on backends that predate org-wide policies; `policy` is then the only document.
  policies?: BundlePolicyEntry[];
  tools: BundleTool[];
  members: BundleMember[];
};

export type V2Call = { tool: string; arguments: Record<string, unknown>; userEmail?: string };

export type PolicyRef = { policyId: string; name: string; policyHash: string | null };
export type ShadowVerdict = { policy_id: string; policy_name: string; verdict: Verdict };

export const MCP_REVIEW_RULE = "mcp_server.review_required";

export type V2Outcome = {
  // Null when no active v2 document applies, so the caller falls back to the local policy.
  enforced: { verdict: Verdict; rule: string; policy: PolicyRef | null; reviewTool?: { name: string; server: string } } | null;
  shadow: ShadowVerdict[];
};

type Layers = { floor?: BundlePolicyEntry; agent?: BundlePolicyEntry };

function entriesOf(agent: BundleAgent): BundlePolicyEntry[] {
  if (Array.isArray(agent.policies)) return agent.policies;
  return agent.policy ? [{ ...agent.policy, targetType: "agent", status: "active" }] : [];
}

const layerOf = (entry: BundlePolicyEntry): keyof Layers => (entry.targetType === "org" ? "floor" : "agent");

function bind(layers: Layers): { floor?: PolicyDocument; agent?: PolicyDocument } {
  const bound: { floor?: PolicyDocument; agent?: PolicyDocument } = {};
  if (layers.floor) bound.floor = layers.floor.document;
  if (layers.agent) bound.agent = layers.agent.document;
  return bound;
}

// Mirrors the SDK's decideLocally: one input per inventory tool the call could be, strictest wins.
function callInputs(agent: BundleAgent, call: V2Call, now: number, known: BundleTool[]): CallInput[] {
  const base: CallInput = { tool: call.tool, arguments: call.arguments, schemaHash: null, capabilities: [], timestamp: new Date(now).toISOString() };
  if (call.userEmail) {
    const email = call.userEmail.trim().toLowerCase();
    const known = (agent.members ?? []).find((m) => m.email.trim().toLowerCase() === email);
    base.member = { email: call.userEmail, ...(known ? { membershipId: known.membershipId } : {}) };
  }
  if (!known.length) return [base];
  return known.map((t) => ({ ...base, schemaHash: t.schemaHash, capabilities: t.capabilities }));
}

function strictest(inputs: CallInput[], layers: Layers): Evaluation {
  const bound = bind(layers);
  return inputs
    .map((input) => evaluate(input, bound))
    .reduce((best, next) => (VERDICT_RANK[next.verdict] > VERDICT_RANK[best.verdict] ? next : best));
}

const ruleOf = (e: Evaluation) => (e.provenance.statementId ? `${e.provenance.ruleKey}#${e.provenance.variant}` : "tools.default");

const refOf = (entry: BundlePolicyEntry): PolicyRef => ({ policyId: entry.policyId, name: entry.name, policyHash: entry.policyHash });

// Same layering as the backend's /iap/sdk/enforce: the org-wide document is the floor, so an
// agent document can only tighten it. Shadow documents replace their layer and are only reported.
export function evaluateV2(agent: BundleAgent, call: V2Call, now: number): V2Outcome {
  const entries = entriesOf(agent);
  const active: Layers = {};
  for (const entry of entries) if (entry.status === "active") active[layerOf(entry)] ??= entry;
  const owned = (agent.tools ?? []).filter((tool) => {
    if (!tool.server) return false;
    const nativeName = `${sanitizeMcpPart(tool.server)}_${sanitizeMcpPart(tool.name)}`.toLowerCase();
    return tool.qualifiedName === call.tool || nativeName === call.tool.toLowerCase() ||
      (tool.qualifiedName && mcpToolName(tool.qualifiedName) === call.tool.toLowerCase());
  });
  const known = owned.length ? owned : (agent.tools ?? []).filter((tool) => tool.name === call.tool || tool.qualifiedName === call.tool);
  const inputs = callInputs(agent, call, now, known);
  const reviewRequired = owned.some((tool) => tool.reviewRequired === true);
  const candidate = owned.length === 1 ? owned[0] : undefined;
  const reviewHold = {
    verdict: "hold",
    rule: MCP_REVIEW_RULE,
    policy: null,
    ...(candidate?.server ? { reviewTool: { name: candidate.name, server: candidate.server } } : {}),
  } as const;

  // A shadow document only reports, so one that fails to evaluate is dropped rather than blocking the call.
  const shadow = entries
    .filter((entry) => entry.status === "shadow")
    .flatMap((entry) => {
      try {
        const decision = strictest(inputs, { ...active, [layerOf(entry)]: entry }).verdict;
        const verdict = reviewRequired && decision === "allow" ? "hold" : decision;
        return [{ policy_id: entry.policyId, policy_name: entry.name, verdict }];
      } catch {
        return [];
      }
    });

  if (!active.floor && !active.agent) {
    return { enforced: agent.inactive ? { verdict: "block", rule: "agent_inactive", policy: null } : reviewRequired ? reviewHold : null, shadow };
  }
  let evaluation: Evaluation;
  try {
    evaluation = strictest(inputs, active);
  } catch (error) {
    // An active document that cannot be evaluated fails closed, but as a verdict, so decide still runs
    // the builtin rules and lets the plugin's own tools through first.
    return { enforced: { verdict: "block", rule: `bundle_invalid: ${String(error).slice(0, 120)}`, policy: null }, shadow };
  }
  const decidedBy = evaluation.provenance.layer === "floor" ? active.floor : active.agent;
  const owner = decidedBy ?? active.agent ?? active.floor;
  const policy = owner ? refOf(owner) : null;
  if (reviewRequired && evaluation.verdict !== "block") {
    return { enforced: { ...reviewHold, policy: evaluation.verdict === "hold" ? policy : null }, shadow };
  }
  return { enforced: { verdict: evaluation.verdict, rule: ruleOf(evaluation), policy }, shadow };
}
