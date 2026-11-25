import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { hostFor } from "../../src/host.ts";
import { promptMessage } from "../../src/hosts/v1/prompts.ts";
import { toHostEvent as v1Event } from "../../src/hosts/v1/events.ts";
import { toHostEvent as v2Event } from "../../src/hosts/v2/events.ts";
import { registerIntent } from "../../src/hosts/v2/intent.ts";
import { registerGuard } from "../../src/hosts/v2/guard.ts";
import { createRunsPump } from "../../src/pumps/runs.ts";
import { createSessionStore } from "../../src/state/sessions.ts";
import { handleArmorCommand } from "../../src/commands/armor.ts";
import { registerPlan, reanchorPlan } from "../../src/tools/intent.ts";
import type { Login, SessionID } from "../../src/types.ts";
import { runtimeHooks } from "../support/runtime-hooks.ts";
import { planArgs } from "../support/intent-harness.ts";
import { intentTransport } from "../support/intent-transport.ts";
import { scratch } from "../io/helpers/stub.ts";
import contract from "../fixtures/runs-v1.json";

const auth = { backend: "http://localhost:1", apiKey: "ak_test_run", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
const id = "root" as SessionID;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function adapter(major: 1 | 2, login: Login | null = auth, enabled = true) {
  const rt = await runtimeHooks(login);
  Object.assign(rt, { sessions: createSessionStore(rt.sessionDir, () => rt.mode(), () => rt.login()) });
  const dir = scratch("armor-adapter-runs-");
  const runs = createRunsPump({ dataDir: dir, login: () => rt.login(), enabled, log: rt.log, post: async () => ({ ok: false, deferred: true }) });
  Object.assign(rt.audit, { kick() {} });
  Object.assign(rt, { runs, usage: { kick() {} }, traces: { record() {}, kick() {} }, tokens: { revoke() {} } });
  const host = hostFor(rt, rt.log);
  const wire = intentTransport();
  cleanup.push(async () => { await runs.stop(); await rt.sessions.flush(); wire.restore(); rmSync(dir, { recursive: true, force: true }); });
  let prompt: (sessionID: string, messageID: string) => Promise<void>;
  let before: (tool: string, callID: string, sessionID?: string) => Promise<void>;
  const end = (type?: string) => {
    const event = major === 1
      ? v1Event({ type: type === "delete" ? "session.deleted" : "session.status", properties: type === "delete" ? { info: { id } } : { sessionID: id, status: { type: "idle" } } }, "")
      : v2Event({ type: type === "delete" ? "session.deleted" : type ?? "session.execution.succeeded", data: { sessionID: id } }, "");
    if (event) host.event(event);
  };
  if (major === 1) {
    prompt = async (sessionID, messageID) => promptMessage(host, { sessionID, messageID }, { message: { id: messageID }, parts: [{ type: "text", text: "work" }] });
    before = (tool, callID, sessionID = id) => host.toolBefore({ sessionId: sessionID as SessionID, callId: callID, tool, args: {} });
  } else {
    const hooks = new Map<string, (e: any) => any>();
    const ctx: any = {
      session: { get: async ({ sessionID }: any) => ({ id: sessionID, ...(sessionID === "child" ? { parentID: id } : {}) }), hook: async (name: string, cb: any) => { hooks.set(name, cb); } },
      tool: { transform: async () => {}, hook: async (name: string, cb: any) => { hooks.set(name, cb); } },
    };
    await registerIntent(ctx, host);
    await registerGuard(ctx, host);
    prompt = (sessionID, messageID) => hooks.get("prompt")!({ sessionID, messageID, prompt: { text: "work" } });
    before = (tool, callID, sessionID = id) => hooks.get("execute.before")!({ sessionID, id: callID, tool, input: {} });
  }
  return { rt, host, runs, prompt, before, end, wire, reports: () => runs.outbox.readPending().map(p => p.row) };
}

for (const major of [1, 2] as const) {
  test(`V${major} counts root attempts including blocks and holds once and excludes own tools and child prompts`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    const runId = a.rt.sessions.get(id).promptId;
    expect(a.reports()[0]).toMatchObject({ run_id: runId, session_id: id, report_seq: 1, started_at: new Date(a.rt.sessions.get(id).promptOpenSince!).toISOString() });
    await a.prompt(id, "m1");
    expect(a.reports()).toHaveLength(1);
    a.rt.sessionCreated("child" as SessionID, id);
    await a.prompt("child", "c1");
    await a.before("read", "child-read", "child");
    await a.before("read", "read-1");
    await a.before("read", "read-1");
    await a.before("policy_read", "own");
    for (let n = 0; n < 2; n++) await expect(a.before(major === 1 ? "bash" : "shell", "blocked")).rejects.toThrow();
    a.rt.setPolicy({ hash: "hold", intentRequired: false, evaluate: () => ({ effect: "require_approval", ruleId: "hold", reason: "approval" }) });
    await expect(a.before("edit", "held")).rejects.toThrow();
    a.end();
    expect(a.reports()).toHaveLength(2);
    expect(a.reports()[1]).toMatchObject({ run_id: runId, report_seq: 2, tool_calls: major === 2 ? 4 : 3, gated_tool_calls: 2, end_reason: "stop", no_plan_reason: "not_registered" });
  });

  test(`V${major} next prompt and session end close the right run and ignore late results`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    await a.before("read", "late");
    const old = a.rt.sessions.get(id).promptId;
    await a.prompt(id, "m2");
    a.rt.after("late", "result");
    a.end("delete");
    expect(a.reports().filter(r => r.report_seq === 2)).toEqual([
      expect.objectContaining({ run_id: old, tool_calls: 1, end_reason: "next_prompt", no_plan_reason: "read_only" }),
      expect.objectContaining({ tool_calls: 0, end_reason: "session_end", no_plan_reason: "no_tool_use" }),
    ]);
  });

  test(`V${major} registrations and trust reanchor settle before the final report`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    const ctx = { sessionID: id, messageID: "assistant" };
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    a.wire.queue.push({ run: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
    const request = registerPlan(a.rt, ctx, planArgs("read"), "");
    await Promise.race([ready, request.then(reply => { throw new Error(`request finished before entering transport: ${reply}`); })]);
    a.end();
    expect(a.reports()).toHaveLength(1);
    release();
    await request;
    expect(a.reports()[1]?.plan_ids).toHaveLength(1);
    expect(a.reports()[1]?.no_plan_reason).toBeUndefined();
    await a.prompt(id, "m2");
    await registerPlan(a.rt, ctx, planArgs("read"), "");
    await reanchorPlan(a.rt, ctx, planArgs("read", "bash"), "add bash");
    a.end();
    expect(a.reports().at(-1)?.plan_ids).toHaveLength(2);
  });

  test(`V${major} a registration callback stays attached to its original prompt`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    const old = a.rt.sessions.get(id).promptId;
    a.wire.queue.push({ run: async () => { await a.prompt(id, "m2"); } });
    await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, planArgs("bash"), "");
    expect(a.rt.sessions.get(id).plan).toBeNull();
    a.end();
    const finals = a.reports().filter(r => r.report_seq === 2);
    expect(finals[0]).toMatchObject({ run_id: old, end_reason: "next_prompt", plan_ids: [expect.any(String)] });
    expect(finals[1]).toMatchObject({ plan_ids: [], tool_calls: 0, no_plan_reason: "no_tool_use" });
  });

  test(`V${major} an untrusted own tool name counts once when shadowing is discovered`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    await a.before("policy_read", "shadow");
    a.host.toolAfter({ callId: "shadow", tool: "policy_read" }, "MCP output");
    a.end();
    expect(a.reports().at(-1)).toMatchObject({ tool_calls: 1, gated_tool_calls: 1, no_plan_reason: "not_registered" });
  });

  test(`V${major} reports each no plan reason from runtime facts`, async () => {
    for (const reason of ["monitor_mode", "no_tool_use", "read_only", "backend_unreachable", "request_failed", "plan_rejected", "not_registered"] as const) {
      const a = await adapter(major);
      if (reason === "monitor_mode") Object.assign(a.rt, { mode: () => "monitor" });
      await a.prompt(id, "m1");
      if (reason === "read_only") await a.before("read", "read");
      else if (reason !== "no_tool_use") {
        if (reason === "backend_unreachable") a.rt.posture.check = async () => "unreachable";
        await a.before(major === 1 ? "bash" : "shell", "gated").catch(() => {});
      }
      if (reason === "plan_rejected") await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, {}, "");
      if (reason === "request_failed") {
        a.wire.queue.push({ status: 422, body: { message: "invalid" } });
        await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, planArgs("bash"), "");
      }
      a.end();
      expect(a.reports().at(-1)?.no_plan_reason).toBe(reason);
    }
  });

  test(`V${major} a Monitor run reports the plan it registered`, async () => {
    const a = await adapter(major);
    Object.assign(a.rt, { mode: () => "monitor" });
    await a.prompt(id, "m1");
    expect(await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, planArgs("bash"), "")).toStartWith("Intent registered: plan counted-1 (new)");
    await a.before(major === 1 ? "bash" : "shell", "gated");
    a.end();
    expect(a.reports().at(-1)).toMatchObject({ tool_calls: 1, plan_ids: ["counted-1"] });
    expect(a.reports().at(-1)?.no_plan_reason).toBeUndefined();
  });

  test(`V${major} logout pauses the original login and logged out prompts stay local`, async () => {
    const a = await adapter(major);
    await a.prompt(id, "m1");
    a.rt.setLogin(null);
    a.end();
    expect(a.runs.status()).toMatchObject({ pending: 2, undeliverable: 2 });
    await a.prompt(id, "m2");
    a.rt.setLogin(auth);
    a.end();
    expect(a.reports()).toHaveLength(2);
  });

  test(`V${major} the rollout switch queues no reports when off`, async () => {
    const a = await adapter(major, auth, false);
    await a.prompt(id, "m1");
    await a.before("read", "read");
    a.end();
    expect(a.reports()).toEqual([]);
  });

  // regression: #0013
  test(`V${major} run storage faults cannot retain an old plan or fail allowed tools and session changes`, async () => {
    const a = await adapter(major);
    await a.runs.ready;
    await a.prompt(id, "m1");
    await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, planArgs("read"), "");
    const previous = a.rt.sessions.get(id).promptId;
    await a.runs.outbox.persist();
    await a.prompt(id, "m2");
    expect(a.rt.sessions.get(id).promptId).not.toBe(previous);
    expect(a.rt.sessions.get(id).plan).toBeNull();
    await expect(a.before("read", "allowed")).resolves.toBeUndefined();
    expect(await registerPlan(a.rt, { sessionID: id, messageID: "assistant" }, planArgs("read"), "")).toStartWith("Intent registered:");
    a.end();
    expect(a.rt.sessions.get(id).promptOpenSince).toBeNull();
    await a.prompt(id, "m3");
    a.end("delete");
    expect(a.rt.sessions.has(id)).toBe(false);
    expect(a.runs.status().captureFailures).toBeGreaterThan(0);
  });
}

test("every V2 end event in the shared contract closes a run as stop", async () => {
  const a = await adapter(2);
  for (const [index, event] of contract.adapterHooks.armoropencode.v2.end.entries()) {
    await a.prompt(id, `m${index}`);
    a.end(event);
    expect(a.reports().at(-1)?.end_reason).toBe("stop");
  }
});

test("local status includes pending and paused runs", async () => {
  const a = await adapter(1);
  await a.prompt(id, "m1");
  expect(handleArmorCommand("/armor status", id, a.rt)).toContain("Runs: 1 pending");
});

// regression: #0013
test("disabled reporting has no Runs status line", async () => {
  const a = await adapter(1, auth, false);
  expect(handleArmorCommand("/armor status", id, a.rt)).not.toContain("Runs:");
});

// regression: #0013
test("identical nested V2 calls are separate attempts under the same outer id", async () => {
  const a = await adapter(2);
  await a.prompt(id, "m1");
  await a.before("read", "outer");
  await a.before("read", "outer");
  a.end();
  expect(a.reports().at(-1)).toMatchObject({ tool_calls: 2, gated_tool_calls: 0 });
});
