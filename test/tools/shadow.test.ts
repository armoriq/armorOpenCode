import { describe, expect, test } from "bun:test";
import { fakeRuntime, type FakeRuntime } from "../support/intent-harness.ts";

const { noteToolAfter, noteToolBefore } = await import("../../src/tools/intent.ts");
const { hostFor } = await import("../../src/host.ts");
const { intentTools: v1Tools } = await import("../../src/hosts/v1/tools.ts");
const intentTools = (rt: FakeRuntime) => v1Tools(hostFor(rt, rt.log));

const ctx = (sessionID: string, callID = "c1") => ({ sessionID, callID, messageID: "m", agent: "build", directory: "/", worktree: "/", abort: new AbortController().signal, metadata() {}, ask: async () => {} });

describe("own-tool shadow detection", () => {
  test("our own tool running between before and after is not a shadow", async () => {
    const rt = await fakeRuntime(null);
    const tools = intentTools(rt);
    noteToolBefore(rt, "policy_read", "c1");
    await tools.policy_read!.execute({} as any, ctx("s", "c1"));
    noteToolAfter(rt, "policy_read", "c1");
    expect([...rt.shadowedTools]).toEqual([]);
  });

  test("a call to an own tool name that completes without our execute marks it shadowed", async () => {
    const rt = await fakeRuntime(null);
    noteToolBefore(rt, "trust_revoke", "c1");
    noteToolAfter(rt, "trust_revoke", "c1");
    expect([...rt.shadowedTools]).toEqual(["trust_revoke"]);
    expect(rt.warnings).toHaveLength(1);
    noteToolBefore(rt, "trust_revoke", "c2");
    noteToolAfter(rt, "trust_revoke", "c2");
    expect(rt.warnings).toHaveLength(1);
  });

  test("other tools are ignored", async () => {
    const rt = await fakeRuntime(null);
    noteToolBefore(rt, "bash", "c1");
    noteToolAfter(rt, "bash", "c1");
    expect(rt.shadowedTools.size).toBe(0);
  });

  test("a call stopped between our before hook and our execute does not mark the tool shadowed", async () => {
    const rt = await fakeRuntime(null);
    const tools = intentTools(rt);
    noteToolBefore(rt, "register_intent_plan", "stopped");
    noteToolBefore(rt, "register_intent_plan", "c2");
    await tools.register_intent_plan!.execute({ goal: "g", steps: [{ action: "bash" }] } as any, ctx("s", "c2"));
    noteToolAfter(rt, "register_intent_plan", "c2");
    noteToolBefore(rt, "register_intent_plan", "c3");
    await tools.register_intent_plan!.execute({ goal: "g", steps: [{ action: "bash" }] } as any, ctx("s", "c3"));
    noteToolAfter(rt, "register_intent_plan", "c3");
    expect(rt.shadowedTools.size).toBe(0);
    expect(rt.warnings).toEqual([]);
  });

  test("monitor mode records the plan locally without any backend call", async () => {
    const rt = await fakeRuntime(null);
    const tools = intentTools(rt);
    const out = await tools.register_intent_plan!.execute({ goal: "g", steps: [{ action: "bash" }] } as any, ctx("m"));
    expect(out).toContain("not logged in");
    expect(rt.sessions.get("m" as any).plan?.steps[0]?.tool).toBe("bash");
  });
});
