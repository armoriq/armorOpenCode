import { describe, expect, test } from "bun:test";
import { allowAllPolicy, fakeRuntime, type FakeRuntime } from "./support/intent-harness.ts";
import type { Login, SessionID } from "../src/types.ts";

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
    expect(() => host.toolBefore({ sessionId: sid("s"), callId: "c1", tool: "policy_read", args: {} })).toThrow("denied");
    host.toolAfter({ callId: "c1", tool: "policy_read" }, "");
    expect(rt.shadowedTools.size).toBe(0);
  });
});
