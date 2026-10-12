import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allowAllPolicy, decide, fakeRuntime, planArgs, startStubBackend, type FakeRuntime } from "../support/intent-harness.ts";
import type { SessionID } from "../../src/types.ts";

const { registerPlan, intentTools } = await import("../../src/tools/intent.ts");

const sid = (s: string) => s as SessionID;
let stub: ReturnType<typeof startStubBackend>;
let rt: FakeRuntime;

const ctx = (sessionID: string, messageID = "m1") => ({ sessionID, messageID });
const open = (id: string, parent: string | null = null) => rt.sessions.open(sid(id), parent ? sid(parent) : null, rt.mode());
const callDecision = (id: string, tool: string) => decide(rt.sessions.get(sid(id)), rt.sessions.root(sid(id)), { tool, args: {} });

beforeAll(async () => {
  stub = startStubBackend();
  rt = await fakeRuntime(stub.login());
});

afterAll(() => stub.stop());

describe("intent scenario against a logging stub backend", () => {
  test("register [bash]: in-plan bash allowed, write is intent_drift", async () => {
    open("A");
    const reply = await registerPlan(rt, ctx("A"), planArgs("bash"), "");
    expect(reply).toStartWith("Intent registered: 1 steps.");
    expect(stub.paths()).toEqual(["/iap/sdk/token"]);
    const sent = stub.requests[0]!.body;
    expect(sent.agent_id).toBe("opencode");
    expect(sent.user_id).toBe("user-1");
    expect(sent.expires_in).toBe(3600);
    expect(sent.plan.steps.map((s: any) => s.tool)).toEqual(["bash"]);

    expect(callDecision("A", "bash")).toEqual({ kind: "allow", stepIndex: 0, paramMismatch: false });
    expect(callDecision("A", "write")).toMatchObject({ kind: "deny", code: "intent_drift" });
    expect(rt.sessions.get(sid("A")).plan?.id).toBe("plan-1");
  });

  test("a revision without a reason is refused and sends nothing", async () => {
    const before = stub.requests.length;
    const reply = await registerPlan(rt, ctx("A", "m2"), planArgs("bash", "write"), "  ");
    expect(reply).toContain('Pass a "reason"');
    expect(stub.requests.length).toBe(before);
  });

  test("revision with reason mints, reanchors from the old plan id, and audits a held row", async () => {
    rt.sessions.beginMessage(sid("A"), "m2");
    const before = stub.requests.length;
    const oldHash = rt.sessions.get(sid("A")).plan!.hash;
    const reply = await registerPlan(rt, ctx("A", "m2"), planArgs("bash", "write"), "need to write the report");
    expect(reply).toStartWith("Intent revised (revision 2): 2 steps.");
    const sent = stub.requests.slice(before);
    expect(sent.map((r) => r.path)).toEqual(["/iap/sdk/token", "/iap/trust/reanchor"]);
    expect(sent[1]!.body).toMatchObject({ planId: "plan-1", reason: "need to write the report" });
    expect(sent[1]!.body.newPlan.steps.map((s: any) => s.tool)).toEqual(["bash", "write"]);

    const plan = rt.sessions.get(sid("A")).plan!;
    expect(rt.auditRows).toEqual([
      expect.objectContaining({
        status: "held",
        session_id: "A",
        step_index: -1,
        tool: "register_intent_plan",
        input: expect.objectContaining({ old_plan_id: "plan-1", old_plan_hash: oldHash, new_plan_hash: plan.hash, trust_id: "trust-reanchor" }),
      }),
    ]);
    expect(callDecision("A", "write")).toEqual({ kind: "allow", stepIndex: 1, paramMismatch: false });
  });

  test("third revision in the same user message is refused; a new message resets the limit", async () => {
    const second = await registerPlan(rt, ctx("A", "m2"), planArgs("bash", "write", "edit"), "also edit");
    expect(second).toStartWith("Intent revised (revision 3)");
    const before = stub.requests.length;
    const third = await registerPlan(rt, ctx("A", "m2"), planArgs("bash"), "loop");
    expect(third).toContain("at most 2 revisions");
    expect(stub.requests.length).toBe(before);
    expect(rt.sessions.get(sid("A")).plan!.revision).toBe(3);

    rt.sessions.beginMessage(sid("A"), "m3");
    expect(await registerPlan(rt, ctx("A", "m3"), planArgs("bash", "write", "edit", "task"), "user asked for more")).toStartWith("Intent revised (revision 4)");
  });

  test("a planless second session is intent_plan_missing, not the first session's plan", () => {
    open("B");
    expect(callDecision("B", "bash")).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
  });

  test("slow backend (1.5 s): register waits then succeeds, and nothing is allowed off-plan meanwhile", async () => {
    open("C");
    stub.queue("/iap/sdk/token", { delayMs: 1500 });
    const before = stub.requests.length;
    const started = Date.now();
    const pending = registerPlan(rt, ctx("C"), planArgs("bash"), "");
    const during: string[] = [];
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(250);
      for (const tool of ["bash", "write"]) {
        const d = callDecision("C", tool);
        during.push(d.kind === "deny" ? d.code : d.kind);
      }
    }
    expect(new Set(during)).toEqual(new Set(["intent_plan_missing"]));
    const reply = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(reply).toStartWith("Intent registered");
    expect(stub.requests.slice(before).map((r) => r.path)).toEqual(["/iap/sdk/token"]);
    expect(callDecision("C", "bash").kind).toBe("allow");
    expect(callDecision("C", "write")).toMatchObject({ kind: "deny", code: "intent_drift" });
  }, 10_000);

  test("401 marks the session account_revoked", async () => {
    open("D");
    stub.queue("/iap/sdk/token", { status: 401, body: { message: "Invalid or expired API key" } });
    const before = stub.requests.length;
    const reply = await registerPlan(rt, ctx("D"), planArgs("bash"), "");
    expect(reply).toContain("account_revoked");
    expect(stub.requests.length - before).toBe(1);
    expect(rt.sessions.get(sid("D")).token).toEqual({ status: "refused", code: "account_revoked" });
    expect(callDecision("D", "bash")).toMatchObject({ kind: "deny", code: "account_revoked" });
  });

  test("402 marks the session billing_blocked", async () => {
    open("E");
    stub.queue("/iap/sdk/token", { status: 402, body: { message: "quota exceeded" } });
    const reply = await registerPlan(rt, ctx("E"), planArgs("bash"), "");
    expect(reply).toContain("billing_blocked");
    expect(rt.sessions.get(sid("E")).token).toEqual({ status: "refused", code: "billing_blocked" });
    expect(callDecision("E", "bash")).toMatchObject({ kind: "deny", code: "billing_blocked" });
  });

  test("subagent session cannot register and is checked against the parent plan", async () => {
    open("A.child", "A");
    const before = stub.requests.length;
    const reply = await registerPlan(rt, ctx("A.child"), planArgs("webfetch", "bash"), "");
    expect(reply).toContain("inherits the plan");
    expect(stub.requests.length).toBe(before);
    expect(rt.sessions.get(sid("A.child")).plan).toBeNull();
    expect(callDecision("A.child", "write").kind).toBe("allow");
    expect(callDecision("A.child", "apply_patch")).toMatchObject({ kind: "deny", code: "intent_drift" });
  });

  test("5xx twice is an error after one retry and keeps the previous plan", async () => {
    const prior = rt.sessions.get(sid("A")).plan;
    rt.sessions.beginMessage(sid("A"), "m5");
    stub.queue("/iap/sdk/token", { status: 503 }, { status: 503 });
    const before = stub.requests.length;
    const reply = await registerPlan(rt, ctx("A", "m5"), planArgs("bash"), "shrink");
    expect(reply).toContain("could not issue an intent token (HTTP 503");
    expect(reply).toContain("previous plan is still in effect");
    expect(stub.requests.slice(before).map((r) => r.path)).toEqual(["/iap/sdk/token", "/iap/sdk/token"]);
    expect(rt.sessions.get(sid("A")).plan).toBe(prior);
  });

  test("a backend that never answers times out at 5 s, retries once, and keeps no plan", async () => {
    open("F");
    stub.queue("/iap/sdk/token", { delayMs: 7000 }, { delayMs: 7000 });
    const started = Date.now();
    const reply = await registerPlan(rt, ctx("F"), planArgs("bash"), "");
    const took = Date.now() - started;
    expect(reply).toContain("timed out after 5000 ms");
    expect(took).toBeGreaterThanOrEqual(9900);
    expect(took).toBeLessThan(11_500);
    expect(rt.sessions.get(sid("F")).plan).toBeNull();
    expect(callDecision("F", "bash")).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
  }, 15_000);

  test("a plan naming a tool the policy forbids is rejected before any request", async () => {
    open("G");
    rt.setPolicy(allowAllPolicy(["bash"]));
    const before = stub.requests.length;
    const reply = await registerPlan(rt, ctx("G"), planArgs("read", "bash"), "");
    rt.setPolicy(allowAllPolicy());
    expect(reply).toContain("step 2 uses bash, which the current policy forbids (rule deny-bash)");
    expect(stub.requests.length).toBe(before);
    expect(rt.sessions.get(sid("G")).plan).toBeNull();
  });

  test("policy_validation denied_tools and held_tools from the token are kept on the session", async () => {
    open("J");
    const exp = Date.now() / 1000 + 3600;
    stub.queue("/iap/sdk/token", {
      body: {
        success: true,
        plan_id: "plan-j",
        token: { signature: "s", issued_at: exp - 3600, expires_at: exp },
        policy_validation: { allowed_tools: ["read"], denied_tools: ["bash"], held_tools: ["write"] },
      },
    });
    const reply = await registerPlan(rt, ctx("J"), planArgs("bash", "write"), "");
    expect(reply).toContain("Denied by policy: bash.");
    expect(reply).toContain("Requires approval: write.");
    const t = rt.sessions.get(sid("J")).token;
    expect(t?.status === "active" && [[...t.deniedTools], [...t.heldTools], t.expiresAt]).toEqual([["bash"], ["write"], Math.round(exp * 1000)]);
    expect(callDecision("J", "bash")).toMatchObject({ kind: "deny", code: "backend_denied_tool" });
  });

  test("lenient arguments: stringified steps and a wrapped plan both register", async () => {
    open("H");
    open("I");
    const tools = intentTools(rt);
    const toolCtx = (id: string) => ({ ...ctx(id), agent: "build", directory: "/", worktree: "/", abort: new AbortController().signal, metadata() {}, ask: async () => {} });
    const a = await tools.register_intent_plan!.execute({ goal: "g", steps: JSON.stringify(planArgs("bash").steps) } as any, toolCtx("H"));
    const b = await tools.register_intent_plan!.execute({ plan: JSON.stringify(planArgs("edit")) } as any, toolCtx("I"));
    expect(a).toStartWith("Intent registered: 1 steps.");
    expect(b).toStartWith("Intent registered: 1 steps.");
    expect(rt.sessions.get(sid("I")).plan!.steps[0]!.tool).toBe("edit");
  });

  test("trust_revoke sends the plan id and clears the plan", async () => {
    const tools = intentTools(rt);
    const toolCtx = { ...ctx("H"), agent: "build", directory: "/", worktree: "/", abort: new AbortController().signal, metadata() {}, ask: async () => {} };
    const planId = rt.sessions.get(sid("H")).plan!.id;
    const before = stub.requests.length;
    const reply = await tools.trust_revoke!.execute({ reason: "user said stop" } as any, toolCtx);
    expect(reply).toContain("revoked");
    expect(stub.requests.slice(before)).toEqual([expect.objectContaining({ path: "/iap/trust/revoke", body: expect.objectContaining({ planId, reason: "user said stop" }) })]);
    expect(callDecision("H", "bash")).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
  });

  test("a revision whose mint fails does not use up one of the message's revisions", async () => {
    open("R");
    rt.sessions.beginMessage(sid("R"), "r1");
    expect(await registerPlan(rt, ctx("R", "r1"), planArgs("bash"), "")).toStartWith("Intent registered");
    stub.queue("/iap/sdk/token", { status: 503 }, { status: 503 });
    expect(await registerPlan(rt, ctx("R", "r1"), planArgs("bash", "write"), "first try")).toContain("could not issue an intent token");
    expect(await registerPlan(rt, ctx("R", "r1"), planArgs("bash", "write"), "retry")).toStartWith("Intent revised (revision 2)");
    expect(await registerPlan(rt, ctx("R", "r1"), planArgs("bash", "write", "edit"), "more")).toStartWith("Intent revised (revision 3)");
  });

  test("trust_reanchor in a subagent says the parent's plan applies instead of asking it to register one", async () => {
    open("P");
    open("P-child", "P");
    const reply = await intentTools(rt).trust_reanchor!.execute({ updatedPlan: planArgs("bash"), reason: "x" } as any, { ...ctx("P-child"), callID: "c" } as any);
    expect(reply).toContain("subagent");
    expect(reply).not.toContain("register_intent_plan");
  });
});
