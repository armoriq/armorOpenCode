import { describe, expect, test } from "bun:test";
import * as audit from "../../src/core/audit.ts";
import contract from "../../src/contracts/block-capture-v1.json";
import type { AuditInput } from "../../src/core/audit.ts";
import type { Decision } from "../../src/types.ts";
import { runtimeHooks } from "../support/runtime-hooks.ts";
import { login } from "../io/helpers/stub.ts";
import type { FakeRuntime } from "../support/intent-harness.ts";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("block capture contract", () => {
  // regression: #0010
  test("R13: real captured tool content keeps the released input and output limits", async () => {
    const source = spawnSync("git", ["show", "29c836e9a10f43ebefd5092f993b3c541d9abd48:src/core/audit.ts"], { cwd: join(import.meta.dir, "../.."), encoding: "utf8" });
    expect(source.status).toBe(0);
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.stdout.replace('"./sanitize.ts"', JSON.stringify(join(import.meta.dir, "../../src/core/sanitize.ts"))));
    const released = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
    const rt = await runtimeHooks(login("https://capture.invalid"));
    const root = rt.sessions.open("root" as any, null, "enforce");
    for (const length of [2000, 2001, 20_000]) {
      const input: AuditInput = { call: { sessionId: root.id, callId: `limit-${length}`, tool: "read", args: { text: "x".repeat(length) } }, root, session: root, decision: null, status: "success", at: 1, durationMs: 0, error: null, output: "y".repeat(length) };
      const current = audit.toAuditRow(input);
      const previous = released.toAuditRow(input);
      expect(current.input).toEqual(previous.input);
      expect(current.output).toEqual(previous.output);
    }
  });
  const cases: { code: string; expected: string; configure?: (rt: FakeRuntime) => void; tool?: string; args?: Record<string, unknown> }[] = [
    { code: "policy_forbid", expected: "policy_deny", configure: rt => rt.setPolicy({ hash: "h", intentRequired: false, evaluate: () => ({ effect: "forbid", ruleId: "r", reason: "no" }) }) },
    { code: "builtin_protected", expected: "protected_resource", tool: "write", args: { filePath: "/home/test/.armoriq/policy.json" } },
    { code: "own_tool_shadowed", expected: "protected_resource", tool: "register_intent_plan", configure: rt => rt.shadowedTools.add("register_intent_plan") },
    { code: "intent_plan_missing", expected: "missing_plan", configure: rt => rt.sessions.clearPlan("root" as any) },
    { code: "intent_drift", expected: "out_of_scope", tool: "write" },
    { code: "intent_token_expired", expected: "token_expired", configure: rt => { const token = rt.sessions.get("root" as any).token!; if (token.status === "active") token.expiresAt = 1; } },
    { code: "backend_denied_tool", expected: "policy_deny", configure: rt => { const token = rt.sessions.get("root" as any).token!; if (token.status === "active") (token.deniedTools as Set<string>).add("bash"); } },
    { code: "account_revoked", expected: "account", configure: rt => { rt.sessions.setToken("root" as any, { status: "refused", code: "account_revoked" }); } },
    { code: "billing_blocked", expected: "account", configure: rt => { rt.sessions.setToken("root" as any, { status: "refused", code: "billing_blocked" }); } },
    { code: "hold", expected: "approval_required", configure: rt => rt.setPolicy({ hash: "h", intentRequired: false, evaluate: () => ({ effect: "require_approval", ruleId: "r", reason: "ask" }) }) },
    { code: "backend_hold", expected: "approval_required", configure: rt => { const token = rt.sessions.get("root" as any).token!; if (token.status === "active") (token.heldTools as Set<string>).add("bash"); } },
    { code: "backend_unreachable", expected: "outage", configure: rt => { rt.posture.check = async () => "unreachable"; } },
    { code: "internal_error", expected: "internal_error", configure: rt => rt.setPolicy({ hash: "h", intentRequired: false, evaluate: () => { throw new Error("private data"); } }) },
  ];

  for (const item of cases) test(`the real before hook reports ${item.code} once`, async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"));
    const id = "root" as any;
    rt.sessions.open(id, null, "enforce");
    rt.sessions.beginMessage(id, "prompt");
    rt.sessions.setPlan(id, { id: "plan", hash: "h", goal: "g", steps: [{ tool: "bash", action: "bash" }], revision: 1, registeredInMessage: "prompt" }, { status: "active", jwt: "test", expiresAt: Date.now() + 60_000, deniedTools: new Set(), heldTools: new Set() });
    item.configure?.(rt);
    await expect(rt.before({ sessionId: id, callId: item.code, tool: item.tool ?? "bash", args: item.args ?? {} })).rejects.toThrow();
    rt.failed(item.code, "failed", "duplicate terminal event");
    rt.after(item.code, "duplicate after hook");
    expect(rt.auditRows).toHaveLength(1);
    expect(rt.auditRows[0]).toMatchObject({ client_row_id: audit.clientRowId(id, item.code, "decision"), decision_code: item.expected, status: item.expected === "approval_required" ? "held" : "blocked" });
  });

  // regression: #0010
  test("a failed token refresh preserves the expired-token block and captures it once", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"));
    const id = "root" as any;
    rt.sessions.open(id, null, "enforce");
    rt.sessions.beginMessage(id, "prompt");
    rt.sessions.setPlan(id, { id: "plan", hash: "h", goal: "g", steps: [{ tool: "bash", action: "bash" }], revision: 1, registeredInMessage: "prompt" }, { status: "active", jwt: "test", expiresAt: 1, deniedTools: new Set(), heldTools: new Set() });
    Object.assign(rt, { tokens: { refreshExpired: async () => { throw new Error("refresh storage unavailable"); } } });
    await expect(rt.before({ sessionId: id, callId: "refresh-error", tool: "bash", args: {} })).rejects.toThrow("intent_token_expired");
    rt.failed("refresh-error", "failed", "duplicate terminal event");
    rt.after("refresh-error", "duplicate after hook");
    expect(rt.auditRows).toHaveLength(1);
    expect(rt.auditRows[0]).toMatchObject({ client_row_id: audit.clientRowId(id, "refresh-error", "decision"), decision_code: "token_expired", status: "blocked", plan_id: "plan" });
    expect(rt.warnings).toContain("intent token refresh failed");
    expect(rt.warnings).not.toContain("decide failed");
  });

  test("every producer code agrees with the unchanged shared fixture", () => {
    const expected = Object.fromEntries(contract.reasonCodes.flatMap(({ decisionCode, producers }) => producers.armoropencode.map((code) => [code, decisionCode])));
    expect((audit as any).DECISION_CODES).toEqual(expected);
  });

  test("action identity agrees with every shared UUID v5 vector", () => {
    for (const v of contract.clientRowId.vectors) {
      expect((audit as any).clientRowId(v.rootSessionId, v.toolCallId, v.phase)).toBe(v.clientRowId);
    }
  });

  test("every stop carries a code and only approval is held", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"));
    const root = rt.sessions.open("root" as any, null, "enforce");
    for (const { decisionCode, producers } of contract.reasonCodes) {
      for (const code of producers.armoropencode) {
        const decision: Decision = code === "hold" ? { kind: "hold", reason: "approval", ruleId: null } : { kind: "deny", code: code as any, reason: "stopped", ruleId: null };
        const row = audit.toAuditRow({ call: { sessionId: root.id, callId: code, tool: "bash", args: {} }, session: root, root, decision, status: code === "hold" ? "held" : "blocked", at: 1, durationMs: 0, error: null, output: null });
        expect(row).toMatchObject({ decision_code: decisionCode, status: code === "hold" ? "held" : "blocked", client_row_id: expect.any(String) });
        expect(row.error_message).toBe(`${code === "hold" ? "approval_required" : code}: ${decision.reason}`);
      }
    }
  });

  test("hold and deny share a decision id and result has its own id", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"));
    const root = rt.sessions.open("root" as any, null, "enforce");
    const input: AuditInput = { call: { sessionId: root.id, callId: "one-action", tool: "bash", args: {} }, root, session: root, decision: { kind: "hold", reason: "ask", ruleId: null }, status: "held", at: 1, durationMs: 0, error: null, output: null };
    const held = audit.toAuditRow(input);
    const denied = audit.toAuditRow({ ...input, status: "blocked", decision: { kind: "deny", code: "policy_forbid", reason: "no", ruleId: null } });
    const result = audit.toAuditRow({ ...input, status: "success", decision: null });
    expect(held.client_row_id).toBeDefined();
    expect(held.client_row_id).toBe(denied.client_row_id);
    expect(held.client_row_id).not.toBe(result.client_row_id);
  });

  test("result keeps the root plan and prompt evaluated before asynchronous posture work", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) });
    const id = "root" as any;
    const root = rt.sessions.open(id, null, "enforce");
    rt.sessions.beginMessage(id, "first");
    root.plan = { id: "counted", hash: "h", goal: "g", revision: 1, registeredInMessage: "first", steps: [] };
    root.countedPlanId = "counted";
    root.tokenPlanId = "token-plan";
    const prompt = root.promptId;
    rt.posture.check = async () => { rt.sessions.beginMessage(id, "later"); return "reachable"; };
    await rt.before({ sessionId: id, callId: "c", tool: "write", args: {} });
    rt.after("c", "ok");
    rt.failed("c", "failed", "terminal duplicate");
    expect(rt.auditRows).toHaveLength(1);
    expect(rt.auditRows[0]).toMatchObject({ plan_id: "token-plan", context_plan_id: "counted", prompt_id: prompt });
  });

  test("an internal guard error keeps known context and omits the tool payload", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: true, evaluate: () => { throw new Error("private crash data"); } });
    await expect(rt.before({ sessionId: "root" as any, callId: "fallback", tool: "bash", args: { secret: "private" } })).rejects.toThrow("internal_error");
    expect(rt.auditRows).toHaveLength(1);
    expect(rt.auditRows[0]).toMatchObject({ client_row_id: expect.any(String), session_id: "root", tool: "bash", action: "bash", input: {}, executed_at: expect.any(String), decision_code: "internal_error", status: "blocked" });
  });

  test("capture failure is visible to a denied caller and keeps the policy veto", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: false, evaluate: () => ({ effect: "forbid", ruleId: "r", reason: "no" }) });
    const failure = new Error("local storage unavailable");
    rt.audit.enqueue = () => { throw failure; };
    const error = await rt.before({ sessionId: "root" as any, callId: "failed-capture", tool: "bash", args: {} }).catch(error => error);
    expect(error.decision.code).toBe("policy_forbid");
    expect(error.message).toContain("Audit capture failed in local storage");
    expect(error.cause).toBe(failure);
  });

  // regression: #0010
  test("result capture failures never replace a completed tool result and are counted", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) });
    let failures = 0;
    rt.audit.captureFailure = () => { failures++; };
    rt.audit.enqueue = () => { throw new Error("disk full"); };
    await rt.before({ sessionId: "root" as any, callId: "success", tool: "read", args: {} });
    expect(() => rt.after("success", "real output")).not.toThrow();
    await rt.before({ sessionId: "root" as any, callId: "failure", tool: "read", args: {} });
    expect(() => rt.failed("failure", "failed", "real error")).not.toThrow();
    expect(failures).toBe(2);
    expect(rt.warnings.filter(line => line === "audit enqueue failed")).toHaveLength(2);
  });

  // regression: #0010
  test("a serialization failure on a result keeps its result identity, status and captured context", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) });
    const session = rt.sessions.open("root" as any, null, "enforce");
    rt.sessions.beginMessage(session.id, "prompt");
    session.tokenPlanId = "token-plan";
    session.countedPlanId = "context-plan";
    const args = { get unsafe() { throw new Error("cannot serialize"); } };
    const call = { sessionId: session.id, callId: "result-fallback", tool: "read", args };
    Object.freeze(args);
    await rt.before(call);
    rt.after(call.callId, "finished");
    expect(rt.auditRows[0]).toMatchObject({ client_row_id: audit.clientRowId(session.id, call.callId, "result"), status: "success", tool: "read", input: {}, plan_id: "token-plan", context_plan_id: "context-plan", prompt_id: session.promptId });
    expect((rt.auditRows[0] as any).decision_code).toBeUndefined();
  });

  // regression: #0010
  test("a sanitizer failure preserves the approval classification of a held call", async () => {
    const rt = await runtimeHooks(login("https://capture.invalid"), { hash: "h", intentRequired: false, evaluate: () => ({ effect: "require_approval", ruleId: "r", reason: "ask" }) });
    await expect(rt.before({ sessionId: "root" as any, callId: "held-fallback", tool: "bash", args: { get unsafe() { throw new Error("cannot serialize"); } } })).rejects.toThrow("approval required");
    expect(rt.auditRows[0]).toMatchObject({ status: "held", decision_code: "approval_required", input: {} });
  });
});
