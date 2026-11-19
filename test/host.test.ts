import { describe, expect, test } from "bun:test";
import { allowAllPolicy, fakeRuntime, type FakeRuntime } from "./support/intent-harness.ts";
import type { Login, SessionID } from "../src/types.ts";
import { Runtime } from "../src/runtime.ts";
import { toHostEvent as v1Event } from "../src/hosts/v1/events.ts";
import { toHostEvent as v2Event } from "../src/hosts/v2/events.ts";

const { hostFor } = await import("../src/host.ts");
const { INTENT_DIRECTIVE } = await import("../src/tools/intent.ts");

const sid = (s: string) => s as SessionID;
const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_x", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };

// fakeRuntime covers the state the host reads; the lifecycle methods are recorded here.
async function recordingRuntime(l: Login | null) {
  const rt = await fakeRuntime(l, allowAllPolicy());
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  Object.assign(rt, {
    before: record("before"),
    after: record("after"),
    failed: record("failed"),
    userMessage: record("userMessage"),
    sessionCreated: record("sessionCreated"),
    sessionTitle: record("sessionTitle"),
    idle: record("idle"),
    deleted: record("deleted"),
    assistantModel: record("assistantModel"),
    stepFinished: record("stepFinished"),
  });
  const infos: string[] = [];
  const log = { info: (m: string) => void infos.push(m), warn() {}, error() {} };
  return { rt: rt as FakeRuntime, host: hostFor(rt, log), calls, infos };
}

describe("ArmorHost over the runtime", () => {
  test("each lifecycle event reaches its runtime method", async () => {
    const { host, calls } = await recordingRuntime(login);
    const step = { sessionId: sid("s"), messageId: "m", partId: "p", repo: "/r", input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    host.event({ kind: "session_created", sessionId: sid("s"), parentId: null });
    host.event({ kind: "session_title", sessionId: sid("s"), title: "t" });
    host.event({ kind: "assistant_model", messageId: "m", model: "a/b" });
    host.event({ kind: "tool_failed", callId: "c", error: "boom" });
    host.event({ kind: "step_finished", step });
    host.event({ kind: "session_idle", sessionId: sid("s") });
    host.event({ kind: "session_deleted", sessionId: sid("s") });
    expect(calls).toEqual([
      ["sessionCreated", "s", null],
      ["sessionTitle", "s", "t"],
      ["assistantModel", "m", "a/b"],
      ["failed", "c", "failed", "boom"],
      ["stepFinished", step],
      ["idle", "s"],
      ["deleted", "s"],
    ]);
  });

  test("the intent directive is offered only when enforcing", async () => {
    expect((await recordingRuntime(login)).host.systemDirective(sid("s"))).toBe(INTENT_DIRECTIVE);
    expect((await recordingRuntime(null)).host.systemDirective(sid("s"))).toBeNull();
  });

  test("subagent prompts are traced once without opening a counted prompt", async () => {
    const rt = await fakeRuntime(login);
    const traces: unknown[] = [];
    Object.assign(rt, {
      userMessage: Runtime.prototype.userMessage,
      ensureSession: Runtime.prototype["ensureSession"],
      traces: { record: (e: unknown) => void traces.push(e) },
    });
    rt.sessions.open(sid("root"), null, "enforce");
    rt.sessions.beginMessage(sid("root"), "root-message");
    rt.sessions.open(sid("child"), sid("root"), "enforce");
    const host = hostFor(rt, rt.log);
    const prompt = { sessionId: sid("child"), messageId: "child-message", text: "read the notes" };
    host.userPrompt(prompt);
    host.userPrompt(prompt);
    expect(traces).toEqual([expect.objectContaining({ kind: "prompt", sessionId: "child", text: "read the notes" })]);
    expect(rt.sessions.get(sid("child")).promptId).toBeNull();
    expect(rt.sessions.get(sid("root")).promptGeneration).toBe(1);
  });

  test("the directive is offered on every prompt, including while a plan exists", async () => {
    const rt = await fakeRuntime(login);
    const traces: unknown[] = [];
    Object.assign(rt, {
      userMessage: Runtime.prototype.userMessage,
      ensureSession: Runtime.prototype["ensureSession"],
      traces: { record: (e: unknown) => void traces.push(e) },
    });
    const host = hostFor(rt, rt.log);
    const prompt = { sessionId: sid("root"), messageId: "m1", text: "write" };
    host.userPrompt(prompt);
    const root = rt.sessions.get(prompt.sessionId);
    rt.sessions.setPlan(root.id, { id: "p", hash: "h", goal: "write", steps: [{ action: "write", tool: "write" }], revision: 1, registeredInMessage: "m1" }, null);
    expect(host.systemDirective(root.id)).toBe(INTENT_DIRECTIVE);
    host.userPrompt(prompt);
    expect(traces).toHaveLength(1);
    host.userPrompt({ ...prompt, messageId: "m2" });
    expect(host.systemDirective(root.id)).toBe(INTENT_DIRECTIVE);
    expect(INTENT_DIRECTIVE).toContain("before the first tool that needs a plan");
    expect(root.plan).toBeNull();
  });

  for (const end of ["v1", "succeeded", "failed", "interrupted"] as const) {
    test(`${end} turn end closes only the root prompt`, async () => {
      const rt = await fakeRuntime(login);
      Object.assign(rt, {
        userMessage: Runtime.prototype.userMessage,
        ensureSession: Runtime.prototype["ensureSession"],
        idle: Runtime.prototype.idle,
        traces: { record() {}, kick() {} },
        usage: { kick() {} },
      });
      Object.assign(rt.audit, { kick() {} });
      const host = hostFor(rt, rt.log);
      host.userPrompt({ sessionId: sid("root"), messageId: "m1", text: "work" });
      const root = rt.sessions.get(sid("root"));
      const openedAt = root.promptOpenSince;
      rt.sessions.open(sid("child"), root.id, "enforce");
      host.userPrompt({ sessionId: sid("child"), messageId: "child-prompt", text: "work" });
      expect(rt.sessions.get(sid("child")).promptId).toBeNull();
      host.event({ kind: "session_idle", sessionId: sid("child") });
      expect(root.promptOpenSince).toBe(openedAt);
      const event = end === "v1"
        ? v1Event({ type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } as any, "/repo")
        : v2Event({ type: `session.execution.${end}`, data: { sessionID: "root" } }, "/repo");
      expect(event).not.toBeNull();
      host.event(event!);
      expect(root.promptOpenSince).toBeNull();
      host.userPrompt({ sessionId: root.id, messageId: "m1", text: "duplicate" });
      expect(root.promptOpenSince).toBeNull();
    });
  }

  test("a prompt is recorded, and an /armor prompt is also logged", async () => {
    const { host, calls, infos } = await recordingRuntime(login);
    host.userPrompt({ sessionId: sid("s"), messageId: "m1", text: "run the tests" });
    host.userPrompt({ sessionId: sid("s"), messageId: "m2", text: "/armor status" });
    expect(calls).toEqual([
      ["userMessage", "s", "m1", "run the tests"],
      ["userMessage", "s", "m2", "/armor status"],
    ]);
    expect(infos).toEqual(["armor command"]);
  });

  test("armorCommand answers status and policy locally", async () => {
    const { host } = await recordingRuntime(login);
    expect(host.armorCommand(sid("s"), "")).toContain("ArmorIQ mode: enforce");
    expect(host.armorCommand(sid("s"), "policy bash")).toContain("bash: permit");
  });

  test("a denied call stops before the own-tool bookkeeping, so it is never taken for a shadowed tool", async () => {
    const { rt, host } = await recordingRuntime(null);
    Object.assign(rt, {
      before: () => {
        throw new Error("denied");
      },
    });
    await expect(host.toolBefore({ sessionId: sid("s"), callId: "c1", tool: "policy_read", args: {} })).rejects.toThrow("denied");
    host.toolAfter({ callId: "c1", tool: "policy_read" }, "");
    expect(rt.shadowedTools.size).toBe(0);
  });
});
