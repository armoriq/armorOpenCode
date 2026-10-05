import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveActivePolicy } from "../src/local-policy.ts";
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
});
