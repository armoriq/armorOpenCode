import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostFor, type ArmorHost } from "../src/host.ts";
import { GuardDenied, Runtime } from "../src/runtime.ts";
import { createOrgMode, type OrgMode } from "../src/state/org-mode.ts";
import { createSessionStore } from "../src/state/sessions.ts";
import { OWN_TOOL_NAMES } from "../src/tools/intent.ts";
import type { CompiledPolicy, Login, SessionID } from "../src/types.ts";
import { fakeRuntime, startStubBackend, type FakeRuntime } from "./support/intent-harness.ts";
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
    org: { current: () => org, known: () => true, refresh: async () => {} },
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

  test("a notice goes only to the plugin instance whose session made the call", async () => {
    org = { mode: "shadow", notices: true };
    const other = hostFor(rt, rt.log);
    const otherNotices: string[] = [];
    other.onNotice((_, text) => void otherNotices.push(text));
    rt.sessions.open(sid, null, rt.mode());
    await run("bash", "c1", { command: "ls" });

    expect(notices).toHaveLength(1);
    expect(otherNotices).toEqual([]);
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

describe("the workspace mode source", () => {
  test("starts in Block until the workspace answers, asks as a Monitor-aware client, keeps the answer on disk", async () => {
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
      expect(source.current(login)).toEqual({ mode: "enforce", notices: false });
      expect(source.known(login)).toBe(false);

      source.refresh(login);
      await Bun.sleep(100);
      expect(source.current(login)).toEqual({ mode: "shadow", notices: true });
      expect(seen[0]).toMatchObject({ path: "/policies/profiles/active", aware: "1" });
      expect(seen[0]!.client).toStartWith("armoropencode");

      reply = { enforcementMode: "enforce" };
      source.refresh(login);
      await Bun.sleep(100);
      expect(createOrgMode(file, log).current(login)).toEqual({ mode: "enforce", notices: false });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ mode: "enforce", notices: false });

      reply = { message: "nope" };
      source.refresh(login);
      await Bun.sleep(100);
      expect(source.current(login).mode).toBe("enforce");
    } finally {
      server.stop(true);
    }
  });
});

describe("the workspace mode source, edge cases", () => {
  const log = { info() {}, warn() {}, error() {} };
  const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json");
  const loginFor = (orgId: string): Login => ({ ...stub.login(), orgId });

  test("refresh resolves once the answer is in", async () => {
    const source = createOrgMode(tmpFile(), log, async () => {
      await Bun.sleep(30);
      return { mode: "enforce", notices: false };
    });
    await source.refresh(loginFor("org-1"));
    expect(source.current(loginFor("org-1")).mode).toBe("enforce");
  });

  test("a cache saved for another workspace does not count", async () => {
    const file = tmpFile();
    await createOrgMode(file, log, async () => ({ mode: "enforce", notices: false })).refresh(loginFor("org-1"));
    const reread = createOrgMode(file, log, async () => null);
    expect(reread.current(loginFor("org-1")).mode).toBe("enforce");
    expect(reread.current(loginFor("org-2"))).toEqual({ mode: "enforce", notices: false });
    expect(reread.known(loginFor("org-2"))).toBe(false);
  });

  test("the same answer for a new workspace is saved under that workspace", async () => {
    const file = tmpFile();
    await createOrgMode(file, log, async () => ({ mode: "enforce", notices: false })).refresh(loginFor("org-1"));
    await createOrgMode(file, log, async () => ({ mode: "enforce", notices: false })).refresh(loginFor("org-2"));
    expect(createOrgMode(file, log).current(loginFor("org-2")).mode).toBe("enforce");
  });

  test("a refresh for another workspace does not reuse the one in flight", async () => {
    const source = createOrgMode(tmpFile(), log, async (login) => {
      await Bun.sleep(20);
      return login.orgId === "org-b" ? { mode: "enforce", notices: false } : { mode: "shadow", notices: false };
    });
    const first = source.refresh(loginFor("org-a"));
    await source.refresh(loginFor("org-b"));
    await first;
    expect(source.current(loginFor("org-b")).mode).toBe("enforce");
  });

  test("a slow answer for the previous workspace does not replace the current one's", async () => {
    const source = createOrgMode(tmpFile(), log, async (login) => {
      if (login.orgId === "org-a") {
        await Bun.sleep(40);
        return { mode: "shadow", notices: false };
      }
      return { mode: "enforce", notices: false };
    });
    const first = source.refresh(loginFor("org-a"));
    await source.refresh(loginFor("org-b"));
    await first;
    expect(source.current(loginFor("org-b")).mode).toBe("enforce");
  });

  test("the live reply must use enforcementMode; bare mode is only read from the cache file", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ mode: "enforce", notices: true }) });
    try {
      const file = tmpFile();
      const login = { ...loginFor("org-1"), backend: `http://127.0.0.1:${server.port}` };
      const source = createOrgMode(file, log);
      await source.refresh(login);
      expect(source.current(login)).toEqual({ mode: "enforce", notices: false });

      writeFileSync(file, JSON.stringify({ mode: "enforce", notices: true }));
      expect(createOrgMode(file, log).current(login)).toEqual({ mode: "enforce", notices: true });
    } finally {
      server.stop(true);
    }
  });

  test("a failed save leaves no temp file behind and is logged", async () => {
    const file = tmpFile();
    mkdirSync(path.join(file, "blocker"), { recursive: true });
    const warnings: string[] = [];
    const source = createOrgMode(file, { ...log, warn: (msg: string) => void warnings.push(msg) }, async () => ({ mode: "enforce", notices: false }));
    await source.refresh(loginFor("org-1"));
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(warnings).toContain("org mode not saved");
  });
});

describe("the first calls of a session", () => {
  const blockAfterFetch = () => {
    (rt as any).org = {
      current: () => org,
      refresh: async () => {
        await Bun.sleep(30);
        org = { mode: "enforce", notices: false };
      },
    };
  };

  test("wait for the workspace answer, so a workspace in Block blocks the first one", async () => {
    blockAfterFetch();
    await expect(host.toolBefore({ sessionId: "ses_fresh" as SessionID, callId: "c1", tool: "bash", args: { command: "ls" } })).rejects.toBeInstanceOf(GuardDenied);
  });

  test("made at once, all wait", async () => {
    blockAfterFetch();
    const call = (callId: string) => host.toolBefore({ sessionId: "ses_pair" as SessionID, callId, tool: "bash", args: { command: "ls" } });
    const results = await Promise.allSettled([call("c1"), call("c2")]);
    expect(results.map((r) => r.status === "rejected" && r.reason instanceof GuardDenied)).toEqual([true, true]);
  });
});

describe("an unknown workspace mode", () => {
  const log = { info() {}, warn() {}, error() {} };
  const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json");
  const login = (): Login => ({ ...stub.login(), orgId: "org-u" });

  test("no saved answer, a missing file or a corrupt one resolves to Block", () => {
    const corrupt = tmpFile();
    writeFileSync(corrupt, "{not json");
    const wrong = tmpFile();
    writeFileSync(wrong, JSON.stringify({ mode: "quiet" }));
    for (const file of [tmpFile(), corrupt, wrong]) {
      const source = createOrgMode(file, log, async () => null);
      expect(source.current(login())).toEqual({ mode: "enforce", notices: false });
      expect(source.known(login())).toBe(false);
    }
  });

  test("a failed fetch with nothing confirmed stays Block; with a confirmed Monitor it keeps Monitor", async () => {
    const file = tmpFile();
    const failing = createOrgMode(file, log, async () => {
      throw new Error("503");
    });
    await failing.refresh(login());
    expect(failing.current(login()).mode).toBe("enforce");

    await createOrgMode(file, log, async () => ({ mode: "shadow", notices: true })).refresh(login());
    const after = createOrgMode(file, log, async () => {
      throw new Error("503");
    });
    await after.refresh(login());
    expect(after.current(login())).toEqual({ mode: "shadow", notices: true });
    expect(after.known(login())).toBe(true);
  });
});

describe("an unknown workspace mode through Runtime.before", () => {
  test("with no confirmed answer and the mode endpoint failing, the workspace floor blocks bash", async () => {
    const source = createOrgMode(path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json"), { info() {}, warn() {}, error() {} }, async () => null);
    (rt as any).org = source;
    expect(rt.mode()).toBe("enforce");
    const { handleArmorCommand } = await import("../src/commands/armor.ts");
    expect(handleArmorCommand("/armor status", sid, rt)).toContain("Workspace mode: not confirmed yet, so Block applies");
    rt.sessions.open(sid, null, rt.mode());
    let message = "";
    try {
      await run("bash", "c1", { command: "ls" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("[policy_v2_block]");
    expect(rows().map((r) => [r.tool, r.status])).toEqual([["bash", "blocked"]]);
  });
});

test("a 401 from the workspace mode request is reported so the developer is asked to sign in", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ message: "Unauthorized" }, { status: 401 }) });
  try {
    const reasons: string[] = [];
    const login = { ...stub.login(), backend: `http://127.0.0.1:${server.port}` };
    const source = createOrgMode(path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json"), { info() {}, warn() {}, error() {} }, undefined, (reason) => void reasons.push(reason));
    await source.refresh(login);
    expect(reasons).toEqual(["workspace mode request returned 401"]);
    expect(source.current(login).mode).toBe("enforce");
  } finally {
    server.stop(true);
  }
});

test("a 401 for a login that is no longer current is not reported", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reasons: string[] = [];
  const source = createOrgMode(
    path.join(mkdtempSync(path.join(tmpdir(), "aoc-org-")), "org-mode.json"),
    { info() {}, warn() {}, error() {} },
    async (login) => {
      if (login.orgId === "org-old") {
        await gate;
        return "unauthorized";
      }
      return { mode: "enforce", notices: false };
    },
    (reason) => void reasons.push(reason),
  );
  const old = source.refresh({ ...stub.login(), orgId: "org-old" });
  await source.refresh({ ...stub.login(), orgId: "org-new" });
  release();
  await old;
  expect(reasons).toEqual([]);
});
