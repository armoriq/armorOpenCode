import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSessionStore } from "../../src/state/sessions.ts";
import { hostFor } from "../../src/host.ts";
import { intentTools } from "../../src/hosts/v1/tools.ts";
import { registerIntent } from "../../src/hosts/v2/intent.ts";
import type { OwnToolInfo } from "../../src/hosts/v2/plugin-api.ts";
import { registerPlan, reanchorPlan, revokeCurrent } from "../../src/tools/intent.ts";
import type { Login, SessionID } from "../../src/types.ts";
import { fakeRuntime, planArgs, type FakeRuntime } from "../support/intent-harness.ts";
import { intentTransport } from "../support/intent-transport.ts";
import { Runtime } from "../../src/runtime.ts";
import type { SessionHooks } from "../../src/hosts/v2/plugin-api.ts";

const login: Login = { backend: "http://localhost:1", apiKey: "ak_test_contract", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
let wire: ReturnType<typeof intentTransport>;
let rt: FakeRuntime;
const id = "contract" as SessionID;
const ctx = { sessionID: id, messageID: "assistant" };
beforeEach(async () => {
  wire = intentTransport();
  rt = await fakeRuntime(login);
  rt.sessions.open(id, null, "enforce");
  rt.sessions.beginMessage(id, "user-1");
});
afterEach(async () => { await rt.sessions.flush(); wire.restore(); });

for (const retirement of ["revoke", "logout", "clear"]) test(`same prompt registration after ${retirement} cannot replay a retired plan`, async () => {
  wire.restore();
  wire = intentTransport({ replayByKey: true });
  await registerPlan(rt, ctx, planArgs("bash"), "");
  const s = rt.sessions.get(id);
  const prompt = s.promptId;
  const retired = s.countedPlanId;
  if (retirement === "revoke") await revokeCurrent(rt, id, "retire");
  if (retirement === "logout") { rt.setLogin(null); rt.setLogin(login); }
  if (retirement === "clear") rt.sessions.clearPlan(id);
  await registerPlan(rt, ctx, planArgs("bash"), "");
  const sends = wire.requests.filter(r => r.url.endsWith("/token"));
  expect(s.promptId).toBe(prompt);
  expect(s.countedPlanId).not.toBe(retired);
  expect(sends[1]!.headers["Idempotency-Key"]).not.toBe(sends[0]!.headers["Idempotency-Key"]);
});

test("a changed plan first resolves the uncertain descriptor then registers a revision", async () => {
  wire.queue.push({ body: { success: true, plan_id: "uncertain", kind: "new", token: { signature: "s" } } });
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toStartWith("Plan registration not confirmed:");
  const pending = structuredClone(rt.sessions.get(id).pendingRequest)!;
  expect(await registerPlan(rt, ctx, planArgs("write"), "write instead")).toContain("(revision)");
  expect(wire.requests[1]!.headers["Idempotency-Key"]).toBe(pending.key);
  expect(wire.requests[1]!.body).toEqual(pending.body);
  expect(wire.requests[2]!.headers["X-ArmorIQ-Plan-Kind"]).toBe("revision");
  expect(wire.requests[2]!.headers["X-ArmorIQ-Parent-Plan-Id"]).toBe("counted-1");
  expect(rt.sessions.get(id).plan?.steps[0]?.tool).toBe("write");
});

test("a late revoke cannot clear a plan registered in the next prompt", async () => {
  await registerPlan(rt, ctx, planArgs("bash"), "");
  wire.queue.push({ run: async () => {
    rt.sessions.beginMessage(id, "user-2");
    const parsed = (await import("../../src/core/intent.ts")).parsePlan(planArgs("write"), 1, "new-assistant");
    if (!parsed.ok) throw new Error(parsed.error);
    rt.sessions.setPlan(id, { ...parsed.plan, id: "next-plan" }, null);
  } });
  await revokeCurrent(rt, id, "retire old plan");
  expect(rt.sessions.get(id).countedPlanId).toBe("next-plan");
});

test("successful registration keeps the policy guidance after the contract prefix", async () => {
  wire.queue.push({ body: { success: true, plan_id: "restricted", kind: "new", token: { signature: "s", expires_at: Date.now() / 1000 + 3600 }, policy_validation: { denied_tools: ["write"], held_tools: ["bash"] } } });
  const reply = await registerPlan(rt, ctx, planArgs("bash", "write"), "");
  expect(reply).toStartWith("Intent registered: plan restricted (new), 2 steps. Token valid until ");
  expect(reply).toContain("Denied by policy: write");
  expect(reply).toContain("Requires approval: bash");
});

test("a failed V2 parent lookup retires a restored plan before any tool can use it", async () => {
  await registerPlan(rt, ctx, planArgs("bash"), "");
  const restored = createSessionStore(rt.sessionDir, () => "enforce", () => login);
  Object.assign(rt, { sessions: restored, sessionCreated: Runtime.prototype.sessionCreated });
  restored.open(id, null, "enforce");
  let prompt: ((event: SessionHooks["prompt"]) => Promise<void> | void) | undefined;
  await registerIntent({
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: {
      get: async () => { throw new Error("lookup unavailable"); },
      hook: async (name, cb) => { if (name === "prompt") prompt = cb as typeof prompt; return { dispose: async () => {} }; },
    },
  }, hostFor(rt, rt.log));
  await prompt!({ sessionID: id, messageID: "new-user", prompt: { text: "a new task" } });
  expect(restored.get(id).plan).toBeNull();
  expect(restored.get(id).promptId).toBeNull();
  expect(await registerPlan(rt, ctx, planArgs("write"), "")).toBe("Plan not registered: no current user prompt.");
});

test("new and revision carry fixture headers, wire plan hash, parent and a durable descriptor", async () => {
  let persisted: unknown;
  wire.queue.push({ run: async () => {
    expect(rt.sessions.get(id).pendingRequest).not.toBeNull();
    persisted = JSON.parse(readFileSync(`${rt.sessionDir}/${id}.json`, "utf8")).pendingRequest;
  } });
  const reply = await registerPlan(rt, ctx, planArgs("bash"), "");
  const s = rt.sessions.get(id);
  const first = wire.requests[0]!;
  expect(first.headers["X-ArmorIQ-Plan-Kind"]).toBe("new");
  expect(first.headers["X-ArmorIQ-Prompt-Id"]).toBe(s.promptId!);
  expect(first.headers["X-ArmorIQ-Parent-Plan-Id"]).toBeUndefined();
  const { planHash, requestKey } = await import("../../src/core/plan-request.ts");
  expect(s.planHash).toBe(planHash(first.body.plan));
  expect(first.headers["Idempotency-Key"]).toBe(requestKey({ kind: "new", promptId: s.promptId!, planHash: s.planHash! }));
  expect(persisted).toEqual({ key: first.headers["Idempotency-Key"], headers: expect.objectContaining({ "Idempotency-Key": first.headers["Idempotency-Key"] }), body: first.body, deadlineAt: expect.any(Number) });
  expect(reply).toBe(`Intent registered: plan ${s.countedPlanId} (new), 1 steps. Token valid until ${new Date(s.tokenExpiresAt!).toISOString()}.`);
  const parent = s.countedPlanId;
  await registerPlan(rt, ctx, planArgs("bash", "write"), "need to write");
  expect(wire.requests[1]!.headers).toMatchObject({ "X-ArmorIQ-Plan-Kind": "revision", "X-ArmorIQ-Parent-Plan-Id": parent, "X-ArmorIQ-Prompt-Id": s.promptId });
  expect(rt.auditRows).toEqual([]);
});

test("identical plans are a no op only with a confirmed usable token, even at the revision limit", async () => {
  const first = await registerPlan(rt, ctx, planArgs("bash"), "");
  rt.sessions.get(id).revisionsThisMessage = 2;
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toBe(first);
  expect(wire.requests).toHaveLength(1);
  rt.sessions.get(id).revisionsThisMessage = 0;
  const token = rt.sessions.get(id).token!;
  if (token.status === "active") token.expiresAt = Date.now() - 1;
  await registerPlan(rt, ctx, planArgs("bash"), "token expired");
  expect(wire.requests.filter(r => r.url.endsWith("/token"))).toHaveLength(2);
});

test("different plans require a reason and only two confirmed revisions fit in a prompt", async () => {
  await registerPlan(rt, ctx, planArgs("bash"), "");
  expect(await registerPlan(rt, ctx, planArgs("write"), "")).toContain('Pass a "reason"');
  expect(wire.requests).toHaveLength(1);
  await registerPlan(rt, ctx, planArgs("write"), "write instead");
  await registerPlan(rt, ctx, planArgs("edit"), "edit instead");
  const before = wire.requests.length;
  expect(await registerPlan(rt, ctx, planArgs("bash"), "again")).toBe("Plan not registered: at most 2 revisions are allowed per user message.");
  expect(wire.requests).toHaveLength(before);
  rt.sessions.beginMessage(id, "user-2");
  await registerPlan(rt, ctx, planArgs("bash"), "");
  expect(wire.requests.at(-1)!.headers["X-ArmorIQ-Plan-Kind"]).toBe("new");
});

test("trust_reanchor sends a revision even for an identical plan and logs a failed reanchor", async () => {
  await registerPlan(rt, ctx, planArgs("bash"), "");
  wire.queue.push({}, { status: 422, body: { message: "cannot reanchor" } });
  expect(await reanchorPlan(rt, ctx, planArgs("bash"), "recheck trust")).toContain("(revision)");
  expect(wire.requests[1]!.headers["X-ArmorIQ-Plan-Kind"]).toBe("revision");
  expect(rt.sessions.get(id).countedPlanId).toBe("counted-2");
  expect(rt.warnings).toContain("reanchor failed");
});

test("retries resend the identical descriptor and Idempotency-Key", async () => {
  wire.queue.push({ status: 503, body: { message: "unavailable" }, headers: { "retry-after": "0" } });
  await registerPlan(rt, ctx, planArgs("bash"), "");
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[0]).toEqual(wire.requests[1]);
});

test("unconfirmed requests keep their descriptor across later tool calls", async () => {
  for (let i = 0; i < 2; i++) wire.queue.push({ run: async () => { throw new Error("network lost"); } });
  const reply = await registerPlan(rt, ctx, planArgs("bash"), "");
  expect(reply).toMatch(/^Plan registration not confirmed: .+\. It will be retried with the same request id\.$/);
  const pending = structuredClone(rt.sessions.get(id).pendingRequest);
  await registerPlan(rt, ctx, planArgs("bash"), "");
  expect(wire.requests[2]!.headers["Idempotency-Key"]).toBe(pending!.key);
  expect(wire.requests[2]!.body).toEqual(pending!.body);
});

test("confirmed failure, logged out and malformed plan reply text", async () => {
  wire.queue.push({ status: 422, body: { message: "parent_not_active" } });
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toBe("Plan not registered: HTTP 422: parent_not_active.");
  expect(rt.sessions.get(id).pendingRequest).toBeNull();
  expect(await registerPlan(rt, ctx, {}, "")).toBe("Plan not registered: goal: a one-line summary is required.");
  rt.setLogin(null);
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toBe("Plan recorded locally, not registered (logged_out).");
  expect(wire.requests).toHaveLength(1);
  expect(rt.sessions.get(id).unregisteredLocalPlan).not.toBeNull();
});

test("late results do not install or send again after a prompt or auth change", async () => {
  for (const change of ["prompt", "auth"]) {
    wire.queue.push({ run: async () => {
      if (change === "prompt") rt.sessions.beginMessage(id, "user-2");
      else rt.setLogin({ ...login, orgId: "new-org" });
    } });
    expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toStartWith("Plan dropped:");
    expect(rt.sessions.get(id).plan).toBeNull();
    expect(rt.sessions.get(id).pendingRequest).toBeNull();
  }
});

test("a legacy backend logs compatibility only once", async () => {
  const legacy = { success: true, plan_id: "legacy", token: { signature: "s", expires_at: Date.now() / 1000 + 3600 } };
  wire.queue.push({ body: legacy }, { body: legacy });
  await registerPlan(rt, ctx, planArgs("bash"), "");
  rt.sessions.beginMessage(id, "user-2");
  await registerPlan(rt, ctx, planArgs("write"), "");
  expect(rt.warnings.filter(w => w.includes("plan capture contract"))).toHaveLength(1);
});

test("an uncertain request survives restoring the session snapshot", async () => {
  for (let i = 0; i < 2; i++) wire.queue.push({ run: async () => { throw new Error("connection lost"); } });
  await registerPlan(rt, ctx, planArgs("bash"), "");
  const descriptor = structuredClone(rt.sessions.get(id).pendingRequest);
  const restored = createSessionStore(rt.sessionDir, () => "enforce", () => login);
  Object.assign(rt, { sessions: restored });
  restored.open(id, null, "enforce");
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toStartWith("Intent registered:");
  expect(wire.requests[2]!.body).toEqual(descriptor!.body);
  expect(wire.requests[2]!.headers["Idempotency-Key"]).toBe(descriptor!.key);
});

test("concurrent identical registrations are serialized into one send", async () => {
  wire.queue.push({ run: async () => { await Bun.sleep(10); } });
  const replies = await Promise.all([registerPlan(rt, ctx, planArgs("bash"), ""), registerPlan(rt, ctx, planArgs("bash"), "")]);
  expect(replies[0]).toBe(replies[1]);
  expect(wire.requests).toHaveLength(1);
});

test("no request is sent if its descriptor cannot be written", async () => {
  rmSync(rt.sessionDir, { recursive: true });
  writeFileSync(rt.sessionDir, "not a directory");
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toBe("Plan not registered: could not persist the plan request.");
  expect(wire.requests).toHaveLength(0);
});

test("a response without a backend expiry is unconfirmed and retains its request", async () => {
  wire.queue.push({ body: { success: true, plan_id: "bad-expiry", kind: "new", token: { signature: "s" } } });
  expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toStartWith("Plan registration not confirmed:");
  expect(rt.sessions.get(id).pendingRequest).not.toBeNull();
  expect(rt.sessions.get(id).plan).toBeNull();
});

for (const major of [1, 2]) test(`host ${major} marks registration failures as tool errors`, async () => {
  const host = hostFor(rt, rt.log);
  let run: (args: Record<string, unknown>) => Promise<unknown>;
  if (major === 1) {
    const tools = intentTools(host);
    run = args => tools.register_intent_plan!.execute(args as any, { ...ctx, callID: "c" } as any);
  } else {
    Object.assign(rt, { sessionCreated: (sessionId: SessionID, parentId: SessionID | null) => rt.sessions.open(sessionId, parentId, rt.mode()) });
    const tools: OwnToolInfo[] = [];
    await registerIntent({ tool: { transform: async cb => { cb({ add: t => { tools.push(t); } }); return { dispose: async () => {} }; } }, session: { get: async () => ({}), hook: async () => ({ dispose: async () => {} }) } }, host);
    run = args => tools[0]!.execute(args, { sessionID: id, messageID: "assistant", id: "c" });
  }
  wire.queue.push({ status: 422, body: { message: "invalid_plan" } });
  await expect(run(planArgs("bash"))).rejects.toThrow("Plan not registered: HTTP 422: invalid_plan.");
  const success = await run(planArgs("bash"));
  const text = major === 1 ? success : (success as { content: string }).content;
  expect(text).toMatch(/^Intent registered: plan .+ \(new\), 1 steps\. Token valid until .+\.$/);
  rt.sessions.beginMessage(id, "user-2");
  for (let i = 0; i < 2; i++) wire.queue.push({ run: async () => { throw new Error("network lost"); } });
  await expect(run(planArgs("bash"))).rejects.toThrow("Plan registration not confirmed: Failed to get intent token: network lost. It will be retried with the same request id.");
  rt.setLogin(null);
  const local = await run(planArgs("bash"));
  expect(major === 1 ? local : (local as { content: string }).content).toBe("Plan recorded locally, not registered (logged_out).");
});
