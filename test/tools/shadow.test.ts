import { describe, expect, test } from "bun:test";
import { fakeRuntime } from "../support/intent-harness.ts";

const { intentTools, noteToolAfter, noteToolBefore } = await import("../../src/tools/intent.ts");

const ctx = (sessionID: string) => ({ sessionID, messageID: "m", agent: "build", directory: "/", worktree: "/", abort: new AbortController().signal, metadata() {}, ask: async () => {} });

describe("own-tool shadow detection", () => {
  test("our own tool running between before and after is not a shadow", async () => {
    const rt = await fakeRuntime(null);
    const tools = intentTools(rt);
    noteToolBefore(rt, "s", "policy_read");
    await tools.policy_read!.execute({} as any, ctx("s"));
    noteToolAfter(rt, "s", "policy_read");
    expect([...rt.shadowedTools]).toEqual([]);
  });

  test("a call to an own tool name that completes without our execute marks it shadowed", async () => {
    const rt = await fakeRuntime(null);
    noteToolBefore(rt, "s", "trust_revoke");
    noteToolAfter(rt, "s", "trust_revoke");
    expect([...rt.shadowedTools]).toEqual(["trust_revoke"]);
    expect(rt.warnings).toHaveLength(1);
    noteToolBefore(rt, "s", "trust_revoke");
    noteToolAfter(rt, "s", "trust_revoke");
    expect(rt.warnings).toHaveLength(1);
  });

  test("other tools are ignored", async () => {
    const rt = await fakeRuntime(null);
    noteToolBefore(rt, "s", "bash");
    noteToolAfter(rt, "s", "bash");
    expect(rt.shadowedTools.size).toBe(0);
  });

  test("monitor mode records the plan locally without any backend call", async () => {
    const rt = await fakeRuntime(null);
    const tools = intentTools(rt);
    const out = await tools.register_intent_plan!.execute({ goal: "g", steps: [{ action: "bash" }] } as any, ctx("m"));
    expect(out).toContain("not logged in");
    expect(rt.sessions.get("m" as any).plan?.steps[0]?.tool).toBe("bash");
  });
});
