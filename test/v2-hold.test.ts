import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { hostFor, type ArmorHost } from "../src/host.ts";
import { GuardDenied, Runtime } from "../src/runtime.ts";
import { OWN_TOOL_NAMES } from "../src/tools/intent.ts";
import type { CompiledPolicy, SessionID } from "../src/types.ts";
import { fakeRuntime, startStubBackend, type FakeRuntime } from "./support/intent-harness.ts";
import { agentWith, entry } from "./support/v2-docs.ts";

const permit: CompiledPolicy = { hash: "h", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const stub = startStubBackend();
afterAll(() => stub.stop());

const sid = "ses_hold" as SessionID;
const args = { filePath: "/w/hello.txt", content: "hi" };
// Only the payload is read by the plugin; the backend verifies the signature.
const jwt = `e30.${Buffer.from(JSON.stringify({ type: "iap_token", plan_id: "plan-7", agent_id: "agent-uuid-1" })).toString("base64url")}.sig`;

let rt: FakeRuntime;
let host: ArmorHost;

beforeEach(async () => {
  stub.requests.length = 0;
  const r: any = await fakeRuntime(stub.login(), permit);
  Object.setPrototypeOf(r, Runtime.prototype);
  Object.assign(r, {
    pending: new Map(),
    messageModel: new Map(),
    traces: { record() {} },
    builtin: { armoriqDir: "/home/u/.armoriq", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: r.shadowedTools },
  });
  rt = r;
  rt.setBundle(agentWith([entry("Floor", "org", "active", { bash: "block" }), entry("No writes", "agent", "active", { write: "hold" })]));
  host = hostFor(rt, rt.log);
  rt.sessions.open(sid, null, "enforce");
  rt.sessions.setPlan(
    sid,
    { id: "plan-7", hash: "ph", goal: "write hello", steps: [{ action: "read", tool: "read" }, { action: "write", tool: "write" }], revision: 1, registeredInMessage: "m1" },
    { status: "active", jwt, expiresAt: Date.now() + 3_600_000, deniedTools: new Set(), heldTools: new Set() },
  );
});

async function attempt(tool: string, callId: string) {
  try {
    await host.toolBefore({ sessionId: sid, callId, tool, args });
    return null;
  } catch (error) {
    if (!(error instanceof GuardDenied)) throw error;
    return error;
  }
}

const rows = () => rt.auditRows as Record<string, any>[];
const held = { allowed: false, enforcementAction: "hold", reason: "hold:write#0", message: "held" };

describe("a v2 hold on OpenCode", () => {
  test("is checked with the token's own agent, filed for approval, and stopped with the request id", async () => {
    stub.queue("/iap/sdk/enforce", { body: held });
    stub.queue("/delegation/my-role", { body: { role: "member", limit: 5 } });
    stub.queue("/delegation/request", { body: { delegationId: "req-42", status: "pending" } });

    const denied = await attempt("write", "c1");
    expect(denied?.message).toBe(
      'ArmorIQ: ArmorIQ policy "No writes" holds write for approval (write#0). Approval request req-42 is waiting for another workspace member. ' +
        "This call was not run; retry it with the same arguments after the request is approved.",
    );
    expect(stub.paths()).toEqual(["/iap/sdk/enforce", "/delegation/my-role", "/delegation/request"]);
    expect(stub.requests[0]!.body).toEqual({
      tool: "write",
      mcp: "opencode",
      arguments: args,
      intent_token: { jwt_token: jwt, plan_id: "plan-7" },
      agent_id: "agent-uuid-1",
      user_email: "dev@example.com",
    });
    expect(stub.requests[2]!.body).toEqual({
      tool: "write",
      action: "execute",
      arguments: args,
      requesterEmail: "dev@example.com",
      requesterRole: "member",
      requesterLimit: 5,
      domain: "opencode",
      planId: "plan-7",
      reason: "hold:write#0",
    });
    // Held, not blocked, and with the plan id, so the backend keeps the plan open for the retry.
    expect(rows()).toEqual([expect.objectContaining({ status: "held", plan_id: "plan-7", tool: "write" })]);
    expect(rows()[0]!.error_message).toContain("approval request req-42");
  });

  test("runs the retry once the backend spends the approval, and advances the plan", async () => {
    stub.queue("/iap/sdk/enforce", { body: { allowed: true, enforcementAction: "allow", reason: "approved_delegation" } });
    expect(await attempt("write", "c2")).toBeNull();
    expect(stub.paths()).toEqual(["/iap/sdk/enforce"]);
    expect(rt.sessions.get(sid).stepCursor).toBe(2);
    host.toolAfter({ callId: "c2", tool: "write" }, "Wrote file successfully.");
    expect(rows()).toEqual([expect.objectContaining({ status: "success", plan_id: "plan-7", step_index: 1 })]);
  });

  test("a backend block, such as a rejected request, blocks the call", async () => {
    stub.queue("/iap/sdk/enforce", { body: { allowed: false, enforcementAction: "block", reason: "delegation_rejected", message: "Approval was rejected (delegation req-42)" } });
    const denied = await attempt("write", "c3");
    expect(denied?.decision).toMatchObject({ kind: "deny", code: "policy_v2_block" });
    expect(denied?.message).toContain("Approval was rejected (delegation req-42) (delegation_rejected)");
    expect(stub.paths()).toEqual(["/iap/sdk/enforce"]);
  });

  test("fails closed as a hold when the backend check errors, and files nothing", async () => {
    stub.queue("/iap/sdk/enforce", { status: 500, body: { message: "boom" } });
    const denied = await attempt("write", "c4");
    expect(denied?.decision.kind).toBe("hold");
    expect(denied?.message).toContain("the approval request could not be filed (/iap/sdk/enforce answered 500: boom)");
    expect(stub.paths()).toEqual(["/iap/sdk/enforce"]);
    expect(rows()).toEqual([expect.objectContaining({ status: "held" })]);
  });

  test("fails closed when the request cannot be filed", async () => {
    stub.queue("/iap/sdk/enforce", { body: held });
    stub.queue("/delegation/request", { status: 403, body: { message: "no" } });
    const denied = await attempt("write", "c5");
    expect(denied?.decision).toMatchObject({ kind: "hold" });
    expect(denied?.decision.kind === "hold" && denied.decision.requestId).toBeUndefined();
    expect(denied?.message).toContain("/delegation/request answered 403: no");
  });

  test("without a token there is nothing to file under, so the model is told to register a plan", async () => {
    rt.sessions.setPlan(sid, rt.sessions.get(sid).plan!, null);
    const denied = await attempt("write", "c6");
    expect(denied?.decision).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
    expect(stub.paths()).toEqual([]);
  });

  test("a v2 block never reaches the backend", async () => {
    const denied = await attempt("bash", "c7");
    expect(denied?.decision).toMatchObject({ kind: "deny", code: "policy_v2_block", policy: { policy_name: "Floor" } });
    expect(stub.paths()).toEqual([]);
  });
});

test("an MCP review hold checks the registered server and requires explicit approval", async () => {
  const tool = "team_notes_read_note";
  rt.setBundle(agentWith([], {
    tools: [{ name: "read_note", server: "team_notes", schemaHash: null, capabilities: [], reviewRequired: true }],
  }));
  rt.sessions.setPlan(
    sid,
    { id: "plan-7", hash: "ph", goal: "read a note", steps: [{ action: "read", tool }], revision: 1, registeredInMessage: "m1" },
    { status: "active", jwt, expiresAt: Date.now() + 3_600_000, deniedTools: new Set(), heldTools: new Set() },
  );
  stub.queue("/iap/sdk/enforce", { body: { allowed: true, enforcementAction: "allow", reason: "allowed" } });
  expect((await attempt(tool, "review-1"))?.message).toContain("did not confirm workspace approval");
  expect(stub.requests[0]?.body).toMatchObject({ tool: "read_note", mcp: "team_notes" });
  stub.queue("/iap/sdk/enforce", { body: { allowed: true, enforcementAction: "allow", reason: "approved_delegation" } });
  expect(await attempt(tool, "review-2")).toBeNull();
});
