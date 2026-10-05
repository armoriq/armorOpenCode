import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveActivePolicy, savePendingPolicy, loadPendingPolicy, clearPendingPolicy } from "../src/local-policy.ts";
import { savePlan } from "../src/planner.ts";
import { evaluateToolCall } from "../telemetry/policy.ts";

const plan = { goal: "inspect", steps: [{ action: "read" }] };

describe("ArmorOpenCode policy gate", () => {
  test("denies without a plan and allows a declared tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "armoropencode-policy-"));
    expect(evaluateToolCall({ dataDir: dir }, "session-1", "read").allowed).toBe(false);
    savePlan(dir, "session-1", { goal: plan.goal, steps: [{ action: "read", description: "", metadata: {} }] });
    expect(evaluateToolCall({ dataDir: dir }, "session-1", "read")).toEqual({ allowed: true, reason: "ArmorOpenCode policy allows the tool" });
    expect(evaluateToolCall({ dataDir: dir }, "session-1", "bash").allowed).toBe(false);
  });

  test("denies an invalid or expired plan and exempts Armor tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "armoropencode-policy-"));
    savePlan(dir, "s", { goal: plan.goal, steps: [{ action: "read", description: "", metadata: {} }] });
    utimesSync(join(dir, "plans", "s.json"), new Date(0), new Date(0));
    expect(evaluateToolCall({ dataDir: dir, planTtlSeconds: 1 }, "s", "read").reason).toContain("expired");
    expect(evaluateToolCall({ dataDir: dir }, "s", "armor-opencode-policy_register_intent_plan").allowed).toBe(true);
  });

  test("applies the active local policy before intent checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "armoropencode-policy-"));
    saveActivePolicy(dir, { schemaVersion: "armor.policy.v1", kind: "PolicyProfile", metadata: { name: "x", description: "" }, defaults: { decision: "allow", conflictResolution: "deny_overrides" }, statements: [{ id: "deny-read", effect: "forbid", principal: { type: "agent", id: "opencode" }, action: { type: "tool", eq: "Read" }, resource: { type: "workspace", scope: "current" }, conditions: [] }] });
    savePlan(dir, "s", { goal: plan.goal, steps: [{ action: "read", description: "", metadata: {} }] });
    expect(evaluateToolCall({ dataDir: dir }, "s", "read").reason).toContain("denies");
  });

  test("requires remote policy only when explicitly enabled", async () => {
    const prior = process.env.ARMOROPENCODE_REMOTE_POLICY_REQUIRED;
    delete process.env.ARMOROPENCODE_REMOTE_POLICY_REQUIRED;
    const { default: plugin } = await import("../telemetry/plugin.ts");
    const hooks = await plugin();
    await expect(hooks["tool.execute.before"]?.({ tool: "read", sessionID: "missing", callID: "call" }, { args: {} })).rejects.toThrow("Intent plan missing");
    if (prior === undefined) delete process.env.ARMOROPENCODE_REMOTE_POLICY_REQUIRED; else process.env.ARMOROPENCODE_REMOTE_POLICY_REQUIRED = prior;
  });

  test("staging never changes the active policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "armoropencode-policy-stage-"));
    const policy = { schemaVersion: "armor.policy.v1", kind: "PolicyProfile", metadata: { name: "staged", description: "" }, defaults: { decision: "deny", conflictResolution: "deny_overrides" }, statements: [] };
    expect(savePendingPolicy(dir, policy).ok).toBe(true);
    expect(loadPendingPolicy(dir).ok).toBe(true);
    expect(evaluateToolCall({ dataDir: dir, intentRequired: false }, "s", "read").allowed).toBe(true);
    clearPendingPolicy(dir);
    expect(loadPendingPolicy(dir)).toEqual({ ok: false, error: "none" });
  });
});
