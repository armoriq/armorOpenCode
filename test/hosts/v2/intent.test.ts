import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide, fakeRuntime, startStubBackend, type FakeRuntime } from "../../support/intent-harness.ts";
import type { ContextEvent, IntentContext, OwnToolInfo, SessionHooks } from "../../../src/hosts/v2/plugin-api.ts";
import { Runtime } from "../../../src/runtime.ts";
import type { SessionID } from "../../../src/types.ts";

const { hostFor } = await import("../../../src/host.ts");
const { registerIntent, V2_INTENT_DIRECTIVE } = await import("../../../src/hosts/v2/intent.ts");
const { renamePlanTools } = await import("../../../src/core/intent.ts");

// Ids recorded from a real OpenCode 2.0.29 subagent run (probe plugin, 2026-10-14).
const PARENT = "ses_ec3eab1f9ffeCAPgo89ohW7P4j";
const CHILD = "ses_ec3ea9a80ffeSXM9gmb1XqwM77";
const PARENT_PROMPT = "msg_13c154f9d001FuzP5NUbHp3S0b";
const CHILD_PROMPT = "msg_13c1565c60026oNk9BWjEgG7pf";
const sid = (s: string) => s as SessionID;

function fakeContext(records: Record<string, { parentID?: string }>) {
  const tools = new Map<string, OwnToolInfo>();
  const hooks: { [N in keyof SessionHooks]: Array<(e: SessionHooks[N]) => Promise<void> | void> } = { prompt: [], context: [] };
  const lookups: string[] = [];
  const registration = { dispose: async () => {} };
  const ctx: IntentContext = {
    tool: {
      transform: async (cb) => {
        cb({ add: (tool) => void tools.set(tool.name, tool) });
        return registration;
      },
    },
    session: {
      hook: async <N extends keyof SessionHooks>(name: N, cb: (e: SessionHooks[N]) => Promise<void> | void) => {
        hooks[name].push(cb);
        return registration;
      },
      get: async ({ sessionID }) => {
        lookups.push(sessionID);
        const record = records[sessionID];
        if (!record) throw new Error(`session ${sessionID} not found`);
        return { id: sessionID, ...record };
      },
    },
  };
  return {
    ctx,
    tools,
    lookups,
    prompt: (sessionID: string, messageID: string, text: string) => hooks.prompt[0]!({ sessionID, messageID, prompt: { text } }),
    context: (sessionID: string) => {
      const e: ContextEvent = { sessionID, system: [{ type: "text", text: "base" }], messages: [] };
      void hooks.context[0]!(e);
      return e.system.map((p) => p.text);
    },
    run: (tool: string, input: unknown, sessionID: string, id: string) =>
      tools.get(tool)!.execute(input, { sessionID, messageID: `msg_assistant_${id}`, id }).then((r) => r.content),
  };
}

let stub: ReturnType<typeof startStubBackend>;
let rt: FakeRuntime;
let oc: ReturnType<typeof fakeContext>;

beforeAll(async () => {
  stub = startStubBackend();
  rt = await fakeRuntime(stub.login());
  // The real session lifecycle methods, so linking and prompt capture run through the runtime's own code.
  Object.assign(rt, {
    sessionCreated: Runtime.prototype.sessionCreated,
    userMessage: Runtime.prototype.userMessage,
    ensureSession: Runtime.prototype["ensureSession"],
    traces: { record() {} },
  });
  oc = fakeContext({ [PARENT]: {}, [CHILD]: { parentID: PARENT } });
  await registerIntent(oc.ctx, hostFor(rt, rt.log));
});

afterAll(() => stub.stop());

const callDecision = (id: string, tool: string) => decide(rt.sessions.get(sid(id)), rt.sessions.root(sid(id)), { tool, args: {} });

describe("V2 intent module", () => {
  test("adds the four plan tools as direct tools, not code-mode ones", () => {
    expect([...oc.tools.keys()]).toEqual(["register_intent_plan", "trust_reanchor", "trust_revoke", "policy_read"]);
    for (const tool of oc.tools.values()) expect(tool.options).toEqual({ codemode: false });
  });

  test("a prompt opens the session as a root and the directive is added while enforcing", async () => {
    await oc.prompt(PARENT, PARENT_PROMPT, "Use the subagent tool to read notes.txt");
    expect(rt.sessions.get(sid(PARENT)).parentId).toBeNull();
    expect(oc.context(PARENT)).toEqual(["base", V2_INTENT_DIRECTIVE]);
  });

  test("a plan written with V2 tool names mints a token and checks against translated calls", async () => {
    const reply = await oc.run("register_intent_plan", { goal: "run a command", steps: [{ action: "shell", description: "echo" }] }, PARENT, "call_00_plan");
    expect(reply).toStartWith("Intent registered: 1 steps.");
    expect(stub.requests.at(-1)!.body.plan.steps.map((s: { tool: string }) => s.tool)).toEqual(["bash"]);
    expect(callDecision(PARENT, "bash")).toEqual({ kind: "allow", stepIndex: 0, paramMismatch: false });
    expect(callDecision(PARENT, "write")).toMatchObject({ kind: "deny", code: "intent_drift" });
  });

  test("a subagent prompt that arrives before session.created is linked to its parent", async () => {
    await oc.prompt(CHILD, CHILD_PROMPT, "You are a subagent spawned by another session.");
    expect(rt.sessions.get(sid(CHILD)).parentId).toBe(sid(PARENT));
    expect(callDecision(CHILD, "bash")).toMatchObject({ kind: "allow" });
    const reply = await oc.run("register_intent_plan", { goal: "own plan", steps: [{ action: "write" }] }, CHILD, "call_00_child");
    expect(reply).toStartWith("This is a subagent session.");
    expect(oc.lookups.filter((s) => s === CHILD)).toEqual([CHILD]);
  });

  test("policy_read translates a V2 tool name", async () => {
    expect(await oc.run("policy_read", { tool: "shell" }, PARENT, "call_00_read")).toContain("bash: permit");
  });

  test("a failed session lookup is logged, the prompt is still recorded, and the next prompt retries", async () => {
    await oc.prompt("ses_missing", "msg_missing", "hello");
    expect(rt.warnings).toContain("session lookup failed");
    expect(rt.sessions.has(sid("ses_missing"))).toBe(true);
    await oc.prompt("ses_missing", "msg_missing_2", "again");
    expect(oc.lookups.filter((s) => s === "ses_missing")).toEqual(["ses_missing", "ses_missing"]);
  });

  test("no directive while monitoring", async () => {
    rt.setLogin(null);
    try {
      expect(oc.context(PARENT)).toEqual(["base"]);
    } finally {
      rt.setLogin(stub.login());
    }
  });
});

describe("renamePlanTools", () => {
  const rename = (n: string) => (n === "shell" ? "bash" : n);

  test("renames known step tools and keeps every other action as written", () => {
    expect(renamePlanTools({ goal: "g", steps: [{ action: "Shell" }, { action: "Read the file", tool: "read" }] }, rename)).toEqual({
      goal: "g",
      steps: [{ action: "bash" }, { action: "Read the file", tool: "read" }],
    });
  });

  test("unwraps a plan passed as a JSON string before renaming", () => {
    expect(renamePlanTools({ plan: JSON.stringify({ goal: "g", steps: [{ action: "shell" }] }) }, rename)).toEqual({ goal: "g", steps: [{ action: "bash" }] });
  });
});
