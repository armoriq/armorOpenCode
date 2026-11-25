import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostFor, type ArmorHost } from "../src/host.ts";
import { GuardDenied, Runtime } from "../src/runtime.ts";
import { createOrgMode, type OrgMode } from "../src/state/org-mode.ts";
import { createSessionStore } from "../src/state/sessions.ts";
import { MONITOR_INTENT_DIRECTIVE, OWN_TOOL_NAMES, registerPlan, revokeCurrent } from "../src/tools/intent.ts";
import type { CompiledPolicy, SessionID } from "../src/types.ts";
import { fakeRuntime, planArgs, startStubBackend, type FakeRuntime } from "./support/intent-harness.ts";
import { intentTransport } from "./support/intent-transport.ts";
import { agentWith, entry } from "./support/v2-docs.ts";

const permit: CompiledPolicy = { hash: "h", intentRequired: true, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const stub = startStubBackend();
afterAll(() => stub.stop());

const sid = "ses_monitor" as SessionID;
let rt: FakeRuntime;
let host: ArmorHost;
let org: OrgMode;
let postureChecks: number;
const notices: string[] = [];

beforeEach(async () => {
  stub.requests.length = 0;
  notices.length = 0;
  postureChecks = 0;
  org = { mode: "shadow", notices: false };
  const r: any = await fakeRuntime(stub.login(), permit);
  Object.setPrototypeOf(r, Runtime.prototype);
  Object.assign(r, {
    pending: new Map(),
    messageModel: new Map(),
    noticeListeners: new Set(),
    traces: { record() {} },
    org: { current: () => org, refresh() {} },
    posture: { check: async () => (postureChecks++, "unreachable"), warm() {}, report() {}, seen: () => null },
    builtin: { armoriqDir: "/home/u/.armoriq", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: r.shadowedTools },
  });
  delete r.mode;
  delete r.onNotice;
  r.sessions = createSessionStore(mkdtempSync(path.join(tmpdir(), "aoc-monitor-")), () => r.mode());
  rt = r;
  rt.setBundle(agentWith([entry("Floor", "org", "active", { bash: "block" }), entry("No writes", "agent", "active", { write: "hold" })]));
  host = hostFor(rt, rt.log);
  host.onNotice((_, text) => void notices.push(text));
});

async function run(tool: string, callId: string, args: Record<string, unknown> = {}) {
  await host.toolBefore({ sessionId: sid, callId, tool, args });
  host.toolAfter({ callId, tool }, "done");
}

const rows = () => rt.auditRows as Record<string, any>[];

describe("workspace Monitor on OpenCode", () => {
  test("Quiet runs a blocked and a held call, records what Enforce would do, and shows nothing", async () => {
    rt.sessions.open(sid, null, rt.mode());
    await run("bash", "c1", { command: "ls" });
    await run("write", "c2", { filePath: "/w/a.txt", content: "x" });

    expect(rows().map((r) => [r.tool, r.status, r.would_be, r.would_be_code])).toEqual([
      ["bash", "success", "block", "policy_v2_block"],
      ["write", "success", "hold", "approval_required"],
    ]);
    expect(rows()[0]!.would_be_reason).toContain('"Floor" blocks bash');
    expect(stub.paths()).toEqual([]);
    expect(postureChecks).toBe(0);
    expect(notices).toEqual([]);
  });

  test("Show in chat tells the user once per stopped call and still runs it", async () => {
    org = { mode: "shadow", notices: true };
    rt.sessions.open(sid, null, rt.mode());
    await run("bash", "c1", { command: "ls" });
    await run("read", "c2", { filePath: "/w/a.txt" });

    expect(notices).toEqual(['ArmorIQ would block this call in Enforce (ArmorIQ policy "Floor" blocks bash (bash#0)). Monitor let it run.']);
    expect(rows().map((r) => [r.tool, r.status, r.would_be])).toEqual([
      ["bash", "success", "block"],
      ["read", "success", undefined],
    ]);
  });

  test("Block stops the call and writes no would_be", async () => {
    org = { mode: "enforce", notices: false };
    rt.sessions.open(sid, null, rt.mode());
    await expect(host.toolBefore({ sessionId: sid, callId: "c1", tool: "bash", args: { command: "ls" } })).rejects.toBeInstanceOf(GuardDenied);
    expect(rows()).toEqual([expect.objectContaining({ tool: "bash", status: "blocked" })]);
    expect(rows()[0]!.would_be).toBeUndefined();
  });

  test("the mode follows the workspace when signed in, and is monitor when signed out", () => {
    org = { mode: "enforce", notices: false };
    expect(rt.mode()).toBe("enforce");
    org = { mode: "shadow", notices: true };
    expect(rt.mode()).toBe("monitor");
    process.env.ARMORIQ_ORG_MODE = "enforce";
    try {
      expect(rt.mode()).toBe("enforce");
    } finally {
      delete process.env.ARMORIQ_ORG_MODE;
    }
    rt.setLogin(null);
    expect(rt.mode()).toBe("monitor");
  });
});

// Owner decision 2026-11-24: Monitor sends plans exactly as Enforce does; only the guard differs.
describe("plans in workspace Monitor", () => {
  const ctx = { sessionID: sid, messageID: "assistant" };
  let wire: ReturnType<typeof intentTransport>;
  beforeEach(() => {
    wire = intentTransport();
    host.userPrompt({ sessionId: sid, messageId: "u1", text: "list the files" });
  });
  afterEach(() => wire.restore());

  test("the model is asked for a plan without being told calls are blocked, and the plan is registered as in Enforce", async () => {
    expect(host.systemDirective(sid)).toBe(MONITOR_INTENT_DIRECTIVE);
    expect(MONITOR_INTENT_DIRECTIVE).toContain("call register_intent_plan once");
    expect(MONITOR_INTENT_DIRECTIVE).toStartWith("ArmorIQ intent capture is active for this session.");
    expect(MONITOR_INTENT_DIRECTIVE).not.toMatch(/enforcement|blocked|held|approval|retry/i);
    expect(await registerPlan(rt, ctx, planArgs("bash"), "")).toStartWith("Intent registered: plan counted-1 (new), 1 steps. Token valid until ");
    const s = rt.sessions.get(sid);
    expect(wire.requests.map((r) => [r.url.split("/").at(-1), r.headers["X-ArmorIQ-Plan-Kind"], r.headers["X-ArmorIQ-Prompt-Id"]])).toEqual([["token", "new", s.promptId!]]);
    expect(wire.requests[0]!.headers["Idempotency-Key"]).toStartWith("pcc1:");
    expect([s.countedPlanId, s.tokenPlanId, s.token?.status]).toEqual(["counted-1", "counted-1", "active"]);
  });

  test("a would-be row carries the live plan's ids until the next prompt retires the plan", async () => {
    await registerPlan(rt, ctx, planArgs("bash"), "");
    const prompt = rt.sessions.get(sid).promptId;
    await run("bash", "c1", { command: "ls" });
    host.userPrompt({ sessionId: sid, messageId: "u2", text: "again" });
    await run("bash", "c2", { command: "ls" });
    expect(rows().map((r) => [r.status, r.would_be, r.would_be_code, r.plan_id ?? null, r.prompt_id === prompt])).toEqual([
      ["success", "block", "policy_v2_block", "counted-1", true],
      ["success", "block", "policy_v2_block", null, false],
    ]);
  });

  test("trust_revoke revokes the registered plan as in Enforce", async () => {
    await registerPlan(rt, ctx, planArgs("bash"), "");
    expect(await revokeCurrent(rt, sid, "done")).toStartWith("Intent token revoked.");
    expect(wire.requests.map((r) => r.url.split("/").at(-1))).toEqual(["token", "revoke"]);
    expect(rt.sessions.get(sid).plan).toBeNull();
  });

  test("a failed plan request is recorded and never stops a call", async () => {
    const failures: string[] = [];
    Object.assign(rt.health, { planRequestFailed: (_login: unknown, _key: string, reason: string) => void failures.push(reason) });
    wire.queue.push({ status: 422, body: { message: "invalid plan" } });
    expect(await registerPlan(rt, ctx, planArgs("edit"), "")).toStartWith("Plan not registered: ");
    expect(failures).toEqual(["rejected"]);
    await run("edit", "c1", { filePath: "/w/a.txt", oldString: "a", newString: "b" });
    await run("bash", "c2", { command: "ls" });
    expect(rows().map((r) => [r.tool, r.status, r.would_be ?? null, r.plan_id ?? null])).toEqual([
      ["edit", "success", null, null],
      ["bash", "success", "block", null],
    ]);
    expect(postureChecks).toBe(0);
  });
});

describe("the workspace mode source", () => {
  test("starts in Monitor, asks as a Monitor-aware client, keeps the answer on disk", async () => {
    const seen: Record<string, string | null>[] = [];
    let reply: unknown = { version: 3, policy: null, enforcementMode: "shadow", monitorNotices: true };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push({ path: new URL(req.url).pathname, aware: req.headers.get("x-armoriq-monitor-aware"), client: req.headers.get("x-armoriq-client") });
        return Response.json(reply);
      },
    });
    try {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json");
      const log = { info() {}, warn() {}, error() {} };
      const login = { ...stub.login(), backend: `http://127.0.0.1:${server.port}` };
      const source = createOrgMode(file, log);
      expect(source.current()).toEqual({ mode: "shadow", notices: false });

      source.refresh(login);
      await Bun.sleep(100);
      expect(source.current()).toEqual({ mode: "shadow", notices: true });
      expect(seen[0]).toMatchObject({ path: "/policies/profiles/active", aware: "1" });
      expect(seen[0]!.client).toStartWith("armoropencode");

      reply = { enforcementMode: "enforce" };
      source.refresh(login);
      await Bun.sleep(100);
      expect(createOrgMode(file, log).current()).toEqual({ mode: "enforce", notices: false });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ mode: "enforce", notices: false });

      reply = { message: "nope" };
      source.refresh(login);
      await Bun.sleep(100);
      expect(source.current().mode).toBe("enforce");
    } finally {
      server.stop(true);
    }
  });
});
