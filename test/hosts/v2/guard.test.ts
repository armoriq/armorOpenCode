import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostFor, type ArmorHost } from "../../../src/host.ts";
import type { ToolAfter, ToolBefore, V2Context } from "../../../src/hosts/v2/context.ts";
import { registerGuard } from "../../../src/hosts/v2/guard.ts";
import { setup } from "../../../src/hosts/v2/index.ts";
import { Runtime } from "../../../src/runtime.ts";
import { OWN_TOOL_NAMES } from "../../../src/tools/intent.ts";
import type { CompiledPolicy, Login, PolicyEffect, SessionID } from "../../../src/types.ts";
import { fakeRuntime } from "../../support/intent-harness.ts";

// Real captures: V2 from the spike runs (origin/spike/v2-plugin-contract payloads), V1 from an OpenCode 1.19 run
// with the same prompts. Sandbox paths are rewritten to /private$SB in both.
const lines = (file: string) =>
  readFileSync(path.join(import.meta.dir, "fixtures", file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const V2 = lines("v2-calls.jsonl") as { run: string; hook: "before" | "after"; event: any }[];
const V1 = lines("v1-calls.jsonl") as { hook: "before" | "after"; tool: string; sessionID: string; callID: string; args?: any; output?: string }[];
const SANDBOX_PROJECT = "/private$SB/proj";

const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_x", userId: "u", orgId: "o", email: "e@x", deviceId: "d", deviceName: "n" };

function policy(intentRequired: boolean, effects: Record<string, PolicyEffect> = {}): CompiledPolicy {
  return {
    hash: "h",
    intentRequired,
    evaluate: (call) => {
      const effect = effects[call.tool] ?? "permit";
      return { effect, ruleId: effect === "permit" ? null : `rule-${call.tool}`, reason: `${call.tool} is ${effect}` };
    },
  };
}

// The real Runtime.before/after/failed over the harness's in-memory session store and audit sink.
async function realRuntime(l: Login | null, p: CompiledPolicy, armoriqDir = "/home/u/.armoriq") {
  const rt: any = await fakeRuntime(l, p);
  Object.setPrototypeOf(rt, Runtime.prototype);
  Object.assign(rt, {
    pending: new Map(),
    messageModel: new Map(),
    traces: { record() {} },
    builtin: { armoriqDir, ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools },
  });
  return { rt, host: hostFor(rt, rt.log) as ArmorHost, rows: rt.auditRows as Record<string, any>[] };
}

async function v2Guard(host: ArmorHost) {
  let before: ((e: ToolBefore) => Promise<void> | void) | undefined;
  let after: ((e: ToolAfter) => Promise<void> | void) | undefined;
  const ctx: V2Context = {
    tool: {
      hook: async (name: string, cb: any) => {
        if (name === "execute.before") before = cb;
        else after = cb;
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: async function* () {} },
  };
  await registerGuard(ctx, host);
  // Copies, as V2 hands each hook a fresh event; the guard freezes the input it allowed.
  return {
    before: (e: ToolBefore) => before!(structuredClone(e)),
    after: (e: ToolAfter) => after!(structuredClone(e)),
    rawBefore: (e: ToolBefore) => before!(e),
  };
}

const outcome = (fn: () => unknown): string => {
  try {
    fn();
    return "allow";
  } catch (error) {
    return String((error as Error).message);
  }
};

// Shape of a row without the values a different run naturally changes.
const shape = (row: Record<string, any>) => ({
  ...row,
  session_id: typeof row.session_id,
  executed_at: typeof row.executed_at,
  duration_ms: typeof row.duration_ms,
  input: Object.keys(row.input).sort(),
  output: row.output && { title: row.output.title },
});

const PAIRS = ["read", "write", "edit", "bash", "task"].map((tool) => {
  const v1 = V1.find((c) => c.hook === "before" && c.tool === tool)!;
  const v2Tool = { bash: "shell", task: "subagent" }[tool] ?? tool;
  const v2 = V2.find((c) => c.hook === "before" && c.event.tool === v2Tool)!;
  return { tool, v1, v2: v2.event as ToolBefore };
});

const POLICIES: Record<string, CompiledPolicy> = {
  "allow, no intent": policy(false),
  "intent required": policy(true),
  "forbid the tool": policy(false, { read: "forbid", write: "forbid", edit: "forbid", bash: "forbid", task: "forbid" }),
  "hold the tool": policy(false, { read: "require_approval", write: "require_approval", edit: "require_approval", bash: "require_approval", task: "require_approval" }),
};

describe("V2 guard decides recorded calls exactly as V1", () => {
  for (const [name, p] of Object.entries(POLICIES)) {
    for (const { tool, v1, v2 } of PAIRS) {
      test(`${name}: ${tool}`, async () => {
        const one = await realRuntime(login, p);
        const two = await realRuntime(login, p);
        const g = await v2Guard(two.host);
        const v1Outcome = outcome(() =>
          one.host.toolBefore({ sessionId: v1.sessionID as SessionID, callId: v1.callID, tool: v1.tool, args: v1.args }),
        );
        const v2Outcome = outcome(() => g.before(v2));
        expect(v2Outcome).toBe(v1Outcome);
        expect(two.rows.map(shape)).toEqual(one.rows.map(shape));
      });
    }
  }

  // Points the protected directory at the recorded project, so the recorded read is a read inside it.
  test("the built-in ~/.armoriq rule blocks the same recorded read on both", async () => {
    const one = await realRuntime(login, policy(false), SANDBOX_PROJECT);
    const two = await realRuntime(login, policy(false), SANDBOX_PROJECT);
    const g = await v2Guard(two.host);
    const read = PAIRS[0]!;
    const v1Outcome = outcome(() => one.host.toolBefore({ sessionId: read.v1.sessionID as SessionID, callId: read.v1.callID, tool: "read", args: read.v1.args }));
    expect(v1Outcome).toContain("[builtin_protected]");
    expect(outcome(() => g.before(read.v2))).toBe(v1Outcome);
    expect(two.rows.map(shape)).toEqual(one.rows.map(shape));
    expect(two.rows[0]).toMatchObject({ tool: "read", status: "blocked", input: { filePath: "/private$SB/proj/notes.txt" } });
  });
});

describe("V2 guard audit rows", () => {
  test("allowed calls write V1-shaped success rows with the text the model saw", async () => {
    const { host, rows } = await realRuntime(login, policy(false));
    const g = await v2Guard(host);
    for (const c of V2.filter((c) => c.run === "01-read" || c.run === "03-shell")) await g[c.hook](c.event);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tool: "read", action: "read", status: "success", input: { filePath: "/private$SB/proj/notes.txt" } });
    expect(rows[0]!.output.output).toContain("2: line two");
    expect(rows[1]).toMatchObject({ tool: "bash", status: "success", input: { command: "echo spike-shell-ok" }, output: { title: "bash", output: "spike-shell-ok\n" } });
  });

  test("a failed call writes a failed row with V2's error message", async () => {
    const { host, rows } = await realRuntime(login, policy(false));
    const g = await v2Guard(host);
    for (const c of V2.filter((c) => c.run === "19-read-missing-file")) await g[c.hook](c.event);
    expect(rows).toEqual([expect.objectContaining({ tool: "read", status: "failed", error_message: "File not found: does-not-exist.txt" })]);
  });

  test("code-mode calls sharing one call id each get their own row and output", async () => {
    const { host, rows } = await realRuntime(login, policy(false));
    const g = await v2Guard(host);
    for (const c of V2.filter((c) => c.run === "04-mcp")) await g[c.hook](c.event);
    expect(rows.map((r) => [r.tool, r.status, r.output.output])).toEqual([
      ["opencode_list_mcp_resources", "success", '{"resources":[],"templates":[]}'],
      ["execute", "success", '{"resources":[],"templates":[]}'],
      ["spike_echo", "success", "spike-echo: ping"],
      ["execute", "success", '"spike-echo: ping"'],
    ]);
  });

  test("a blocked inner call does not take the outer call's pairing", async () => {
    const { host, rows } = await realRuntime(login, policy(false, { spike_echo: "forbid" }));
    const g = await v2Guard(host);
    const run = V2.filter((c) => c.run === "04-mcp").slice(4);
    await g.before(run[0]!.event);
    expect(outcome(() => g.before(run[1]!.event))).toBe("ArmorIQ blocked this call [policy_forbid]: spike_echo is forbid");
    await g.after(run[3]!.event);
    expect(rows.map((r) => [r.tool, r.status])).toEqual([["spike_echo", "blocked"], ["execute", "success"]]);
  });

  test("without a login the guard watches only: nothing blocks, nothing is sent", async () => {
    const { host, rows } = await realRuntime(null, policy(false, { shell: "forbid", bash: "forbid" }));
    const g = await v2Guard(host);
    for (const c of V2.filter((c) => c.run === "03-shell")) expect(outcome(() => g[c.hook](c.event))).toBe("allow");
    expect(rows).toEqual([]);
  });

  test("an allowed call's input is frozen so a later hook cannot change what was checked", async () => {
    const { host } = await realRuntime(login, policy(false));
    const g = await v2Guard(host);
    const event = structuredClone(PAIRS[3]!.v2);
    await g.rawBefore(event);
    expect(Object.isFrozen(event.input)).toBe(true);
  });
});

describe("V2 setup entry", () => {
  test("OpenCode 1's partial setup context is ignored without touching the runtime", async () => {
    expect(await setup({ options: {} })).toBeUndefined();
  });
});
