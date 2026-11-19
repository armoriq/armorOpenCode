import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTokenPump } from "../../src/pumps/token.ts";
import { OWN_TOOL_NAMES, registerPlan, reanchorPlan, revokeCurrent } from "../../src/tools/intent.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Login, SessionID } from "../../src/types.ts";
import { fakeRuntime, planArgs, type FakeRuntime } from "../support/intent-harness.ts";
import { intentTransport } from "../support/intent-transport.ts";

const login: Login = { backend: "http://localhost:1", apiKey: "ak_test_contract", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
let wire: ReturnType<typeof intentTransport>;
let rt: FakeRuntime;
const id = "refresh" as SessionID;
let clock: number;
let validity: string | undefined;
beforeEach(async () => {
  wire = intentTransport();
  validity = process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
  delete process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
  clock = Date.now();
  rt = await fakeRuntime(login);
  rt.sessions.open(id, null, "enforce");
  rt.sessions.beginMessage(id, "user");
  await registerPlan(rt, { sessionID: id, messageID: "assistant" }, planArgs("bash"), "");
});
afterEach(async () => {
  if (validity === undefined) delete process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
  else process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = validity;
  wire.restore();
  await rt.sessions.flush();
});

function nearExpiry(ms: number) {
  const s = rt.sessions.get(id);
  if (s.token?.status === "active") s.token.expiresAt = clock + ms;
  s.tokenExpiresAt = clock + ms;
  return s;
}

function pump() {
  return createTokenPump({ sessions: rt.sessions, login: () => rt.login(), log: rt.log, now: () => clock });
}

function runtimeGuard(p = pump()) {
  Object.setPrototypeOf(rt, Runtime.prototype);
  Object.assign(rt, {
    tokens: p, pending: new Map(), messageModel: new Map(), traces: { record() {} },
    builtin: { armoriqDir: "/nonexistent", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools },
  });
  return rt;
}

// regression: #0012
test("refresh retries after an expired descriptor and a throwing health callback cannot skip backoff", async () => {
  const s = nearExpiry(-1);
  let failures = 0;
  Object.assign(rt.health, {
    outbox: { captureFailure: () => { failures++; } },
    planRequestFailed: async () => { throw new Error("health disk full"); },
    planRequestSucceeded: async () => { throw new Error("health disk full"); },
  });
  const p = createTokenPump({ sessions: rt.sessions, login: () => rt.login(), log: rt.log, now: () => clock, health: rt.health });
  wire.queue.push({ status: 503 }, { status: 503 });
  await p.refreshExpired(id);
  const pending = s.pendingRequest!;
  Object.assign(pending, { deadlineAt: Date.now() - 45_000 });
  await p.refreshExpired(id);
  expect(wire.requests).toHaveLength(3);
  clock += 45_001;
  await p.refreshExpired(id);
  await p.stop();
  expect(wire.requests).toHaveLength(4);
  expect(wire.requests[3]!.headers["Idempotency-Key"]).toBe(pending.key);
  expect(s.tokenPlanId).toBe("counted-4");
  expect(failures).toBe(2);
});

test("a tool running past the idle cutoff keeps its prompt open and the next tool refreshes", async () => {
  const p = pump();
  const runtime = runtimeGuard(p);
  await runtime.before({ sessionId: id, callId: "long-build", tool: "bash", args: {} });
  const s = nearExpiry(-1);
  s.lastActivityAt = Date.now() - 31 * 60_000;
  runtime.after("long-build", "build finished");
  expect(s.promptOpenSince).not.toBeNull();
  await runtime.before({ sessionId: id, callId: "next-tool", tool: "bash", args: {} });
  await p.stop();
  expect(wire.requests.filter(r => r.url.endsWith("/token")).map(r => r.headers["X-ArmorIQ-Plan-Kind"])).toEqual(["new", "refresh"]);
  expect(s.countedPlanId).toBe("counted-1");
  expect(s.revisionsThisMessage).toBe(0);
});

test("concurrent gated tools share one expired token refresh", async () => {
  nearExpiry(-1);
  const p = pump();
  const runtime = runtimeGuard(p);
  await Promise.all(["a", "b"].map(callId => runtime.before({ sessionId: id, callId, tool: "bash", args: {} })));
  await p.stop();
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[1]!.headers["X-ArmorIQ-Plan-Kind"]).toBe("refresh");
});

test("a gated tool joins a refresh already in progress", async () => {
  nearExpiry(-1);
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  wire.queue.push({ run: async () => { started(); await released; } });
  const p = pump();
  const runtime = runtimeGuard(p);
  p.kick();
  await entered;
  const call = runtime.before({ sessionId: id, callId: "join", tool: "bash", args: {} });
  finish();
  await call;
  await p.stop();
  expect(wire.requests).toHaveLength(2);
});

test("a failed guard refresh stays uncounted and respects backoff on the next call", async () => {
  nearExpiry(-1);
  wire.queue.push({ status: 503 }, { status: 503 });
  const p = pump();
  const runtime = runtimeGuard(p);
  for (const callId of ["first", "backoff"]) {
    await expect(runtime.before({ sessionId: id, callId, tool: "bash", args: {} })).rejects.toThrow("intent_token_expired");
  }
  await p.stop();
  expect(wire.requests.map(r => r.headers["X-ArmorIQ-Plan-Kind"])).toEqual(["new", "refresh", "refresh"]);
  expect(rt.sessions.get(id).revisionsThisMessage).toBe(0);
});

test("a closed prompt refuses an expired token without starting a refresh", async () => {
  nearExpiry(-1);
  rt.sessions.endPrompt(id);
  const p = pump();
  const runtime = runtimeGuard(p);
  await expect(runtime.before({ sessionId: id, callId: "closed", tool: "bash", args: {} })).rejects.toThrow("intent_token_expired");
  await p.stop();
  expect(wire.requests).toHaveLength(1);
});

for (const path of ["trust_revoke", "session delete"]) test(`${path} revokes the live refresh plan and the counted plan`, async () => {
  nearExpiry(1);
  const p = pump();
  p.kick();
  await p.stop();
  expect(rt.sessions.get(id).tokenPlanId).toBe("counted-2");
  if (path === "trust_revoke") await revokeCurrent(rt, id, "done");
  else { p.revoke(id); rt.sessions.close(id); await p.stop(); }
  const revoked = wire.requests.filter(r => r.url.endsWith("/revoke")).map(r => r.body.planId);
  expect(revoked).toEqual(["counted-2", "counted-1"]);
});

test("reanchor after a refresh uses the live token plan but keeps the counted revision parent", async () => {
  nearExpiry(1);
  const p = pump();
  p.kick();
  await p.stop();
  await reanchorPlan(rt, { sessionID: id, messageID: "assistant" }, planArgs("write"), "write instead");
  expect(wire.requests[2]!.headers).toMatchObject({ "X-ArmorIQ-Plan-Kind": "revision", "X-ArmorIQ-Parent-Plan-Id": "counted-1" });
  expect(wire.requests.find(r => r.url.endsWith("/reanchor"))!.body.planId).toBe("counted-2");
});

test("refresh uses the counted parent and expiry key without replacing the plan or cursor", async () => {
  const s = nearExpiry(120_000);
  rt.sessions.advance(id, 0);
  const oldPlan = s.plan;
  const oldExpiry = s.tokenExpiresAt;
  const p = pump();
  p.kick();
  await p.stop();
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[1]!.headers).toMatchObject({ "X-ArmorIQ-Plan-Kind": "refresh", "X-ArmorIQ-Parent-Plan-Id": "counted-1", "X-ArmorIQ-Prompt-Id": s.promptId });
  const { requestKey } = await import("../../src/core/plan-request.ts");
  expect(wire.requests[1]!.headers["Idempotency-Key"]).toBe(requestKey({ kind: "refresh", countedPlanId: "counted-1", tokenExpiresAt: new Date(oldExpiry!).toISOString() }));
  expect(wire.requests[1]!.body.plan).toEqual(wire.requests[0]!.body.plan);
  expect(s.countedPlanId).toBe("counted-1");
  expect(s.plan).toBe(oldPlan);
  expect(s.tokenPlanId).toBe("counted-2");
  expect(s.stepCursor).toBe(1);
});

for (const end of ["turn", "idle", "logout", "no prompt"]) test(`refresh sends nothing after ${end}`, async () => {
  const s = nearExpiry(10_000);
  if (end === "turn") rt.sessions.endPrompt(id);
  if (end === "idle") s.lastActivityAt = clock - 30 * 60_000;
  if (end === "logout") rt.setLogin(null);
  if (end === "no prompt") s.promptOpenSince = null;
  const p = pump();
  p.kick();
  await p.stop();
  expect(wire.requests).toHaveLength(1);
});

test("short validity refreshes only within one third of its life", async () => {
  process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = "180";
  const s = nearExpiry(60_001);
  const p = pump();
  p.kick();
  await Bun.sleep(10);
  expect(wire.requests).toHaveLength(1);
  nearExpiry(60_000);
  p.kick();
  await p.stop();
  expect(wire.requests).toHaveLength(2);
  expect(s.countedPlanId).toBe("counted-1");
});

test("late refresh after a new prompt installs nothing", async () => {
  const s = nearExpiry(10_000);
  wire.queue.push({ run: async () => { rt.sessions.beginMessage(id, "next-user"); } });
  const p = pump();
  p.kick();
  await p.stop();
  expect(s.plan).toBeNull();
  expect(s.token).toBeNull();
  expect(s.countedPlanId).toBeNull();
});

test("activity after the idle cutoff cannot reopen the prompt for refresh", async () => {
  const s = nearExpiry(10_000);
  s.lastActivityAt = clock - 30 * 60_000;
  rt.sessions.noteActivity(id, clock);
  const p = pump();
  p.kick();
  await p.stop();
  expect(wire.requests).toHaveLength(1);
  expect(s.promptOpenSince).toBeNull();
});

test("an unconfirmed refresh can be superseded by a counted revision", async () => {
  const s = nearExpiry(10_000);
  wire.queue.push({ status: 503, body: { message: "unavailable" } }, { status: 503, body: { message: "unavailable" } });
  const p = pump();
  p.kick();
  await p.stop();
  expect(s.pendingRequest!.headers["X-ArmorIQ-Plan-Kind"]).toBe("refresh");
  const reply = await registerPlan(rt, { sessionID: id, messageID: "assistant" }, planArgs("write"), "write instead");
  expect(reply).toContain("(revision), 1 steps.");
  expect(wire.requests.at(-2)!.headers).toMatchObject({ "X-ArmorIQ-Plan-Kind": "revision", "X-ArmorIQ-Parent-Plan-Id": "counted-1" });
  expect(s.countedPlanId).toBe("counted-2");
});
