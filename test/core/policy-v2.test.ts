import { describe, expect, test } from "bun:test";
import { toAuditRow } from "../../src/core/audit.ts";
import type { BuiltinContext } from "../../src/core/builtin-rules.ts";
import { decide } from "../../src/core/decide.ts";
import { compilePolicy, DEFAULT_POLICY_SOURCE } from "../../src/core/policy.ts";
import { evaluateV2, type BundleAgent } from "../../src/core/policy-v2.ts";
import type { CompiledPolicy, Session, SessionID } from "../../src/types.ts";
import { agentWith, entry } from "../support/v2-docs.ts";

const NOW = 1_800_000_000_000;
const builtin: BuiltinContext = { armoriqDir: "/home/dev/.armoriq", ownTools: new Set(["register_intent_plan"]), shadowedTools: new Set() };

function compile(raw: unknown): CompiledPolicy {
  const r = compilePolicy(raw);
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

const allowAll = compile(DEFAULT_POLICY_SOURCE);
const localNoWebfetch = compile({
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id: "no-webfetch", effect: "forbid", action: { type: "tool", eq: "webfetch" } }],
});

const session: Session = {
  id: "root" as SessionID,
  parentId: null,
  mode: "enforce",
  plan: null,
  token: null,
  stepCursor: 0,
  revisionsThisMessage: 0,
  currentMessageId: null,
};

const call = (tool: string) => ({ sessionId: session.id, callId: "c1", tool, args: { command: "ls" } });

function run(tool: string, agent: BundleAgent | null, policy: CompiledPolicy = allowAll) {
  const v2 = agent ? evaluateV2(agent, { tool, arguments: { command: "ls" } }, NOW) : null;
  return decide({ policy: { ...policy, intentRequired: false }, session, root: session, call: call(tool), now: NOW, builtin, v2 });
}

describe("evaluateV2", () => {
  test("no active document means v2 does not apply, so the local policy decides", () => {
    expect(evaluateV2(agentWith([]), { tool: "bash", arguments: {} }, NOW).enforced).toBeNull();
  });

  test("the org-wide document is a floor an agent document cannot loosen", () => {
    const agent = agentWith([entry("workspace", "org", "active", { bash: "block" }), entry("opencode", "agent", "active", { bash: "allow" })]);
    const out = evaluateV2(agent, { tool: "bash", arguments: {} }, NOW).enforced;
    expect(out).toMatchObject({ verdict: "block", policy: { name: "workspace" } });
  });

  test("an agent document tightens the floor and is named as the decider", () => {
    const agent = agentWith([entry("workspace", "org", "active", { read: "allow" }), entry("opencode", "agent", "active", { bash: "block" })]);
    expect(evaluateV2(agent, { tool: "bash", arguments: {} }, NOW).enforced).toMatchObject({ verdict: "block", policy: { name: "opencode" } });
  });

  test("a shadow document is reported but never enforced", () => {
    const agent = agentWith([entry("trial", "agent", "shadow", { bash: "block" })]);
    const out = evaluateV2(agent, { tool: "bash", arguments: {} }, NOW);
    expect(out.enforced).toBeNull();
    expect(out.shadow).toEqual([{ policy_id: "id-trial", policy_name: "trial", verdict: "block" }]);
  });

  test("a backend without policies[] falls back to the legacy agent policy", () => {
    const legacy = entry("legacy", "agent", "active", { bash: "block" });
    const agent = agentWith([], { policies: undefined, policy: { policyId: legacy.policyId, name: legacy.name, policyHash: legacy.policyHash, document: legacy.document } });
    expect(evaluateV2(agent, { tool: "bash", arguments: {} }, NOW).enforced).toMatchObject({ verdict: "block", policy: { name: "legacy" } });
  });
});

describe("decide with a v2 bundle", () => {
  test("a v2 block denies with the policy name and records v2 as the source", () => {
    const d = run("bash", agentWith([entry("No shell", "agent", "active", { bash: "block" })]));
    expect(d).toMatchObject({ kind: "deny", code: "policy_v2_block", policy: { source: "v2", policy_name: "No shell", policy_id: "id-No shell" } });
    expect(d.kind === "deny" && d.reason).toContain('ArmorIQ policy "No shell" blocks bash');
  });

  test("a v2 hold becomes a block with a hint, since OpenCode has no approval prompt", () => {
    const d = run("bash", agentWith([entry("Ask first", "agent", "active", { bash: "hold" })]));
    expect(d).toMatchObject({ kind: "deny", code: "policy_v2_hold", policy: { source: "v2", policy_name: "Ask first" } });
    expect(d.kind === "deny" && d.reason).toContain("OpenCode has no approval prompt");
  });

  test("strictest wins: a local forbid still blocks a call v2 allows", () => {
    const d = run("webfetch", agentWith([entry("Open", "agent", "active", { webfetch: "allow" })]), localNoWebfetch);
    expect(d).toMatchObject({ kind: "deny", code: "policy_forbid", policy: { source: "local", rule_id: "no-webfetch" } });
  });

  test("a call v2 allows is attributed to v2", () => {
    expect(run("read", agentWith([entry("Open", "agent", "active", { read: "allow" })]))).toMatchObject({ kind: "allow", policy: { source: "v2", policy_name: "Open" } });
  });

  test("without a bundle the local policy decides as before", () => {
    expect(run("bash", null)).toMatchObject({ kind: "allow", policy: { source: "default" } });
    expect(run("webfetch", null, localNoWebfetch)).toMatchObject({ kind: "deny", code: "policy_forbid", policy: { source: "local" } });
  });

  test("shadow verdicts ride along on an allowed call", () => {
    const d = run("bash", agentWith([entry("trial", "agent", "shadow", { bash: "block" })]));
    expect(d).toMatchObject({ kind: "allow", policy: { source: "default", shadow: [{ policy_name: "trial", verdict: "block" }] } });
  });
});

describe("audit rows", () => {
  test("record the deciding source in input.armoriq_policy and matchedPolicy on a v2 block", () => {
    const decision = run("bash", agentWith([entry("No shell", "agent", "active", { bash: "block" })]));
    const row = toAuditRow({ call: call("bash"), session, root: session, status: "blocked", decision, output: null, error: null, durationMs: 0, at: NOW });
    expect(row.input.armoriq_policy).toMatchObject({ source: "v2", policy_id: "id-No shell", policy_name: "No shell", policy_hash: "hash-No shell" });
    expect(row.output).toMatchObject({ matchedPolicy: { policyId: "id-No shell", name: "No shell", policyVersion: "hash-No shell" } });
    expect(String(row.output?.reason)).toContain("No shell");
  });

  test("an allowed call records its source too", () => {
    const decision = run("bash", null);
    const row = toAuditRow({ call: call("bash"), session, root: session, status: "success", decision, output: "ok", error: null, durationMs: 1, at: NOW });
    expect(row.input.armoriq_policy).toEqual({ source: "default" });
  });
});
