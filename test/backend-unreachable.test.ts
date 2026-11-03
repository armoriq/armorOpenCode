import { afterEach, describe, expect, test } from "bun:test";
import { hostFor } from "../src/host.ts";
import { probeBackend } from "../src/io/backend-health.ts";
import { createAuditPump, type AuditPump } from "../src/pumps/audit.ts";
import { Runtime } from "../src/runtime.ts";
import { createBackendPosture, RECHECK_AFTER_MS } from "../src/state/backend-posture.ts";
import { OWN_TOOL_NAMES } from "../src/tools/intent.ts";
import type { AuditRow, CompiledPolicy, Login, SessionID } from "../src/types.ts";
import { accepted, memoryLog, scratch, until } from "./io/helpers/stub.ts";
import { fakeRuntime } from "./support/intent-harness.ts";

const allow: CompiledPolicy = { hash: "h", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const sid = "ses_ac11" as SessionID;

// A backend whose health check and audit batch both follow `mode`.
function backend() {
  const state = { mode: "hang" as "hang" | "503" | "up" | "401", batches: [] as AuditRow[][] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (state.mode === "hang") return new Promise<Response>(() => {});
      if (state.mode === "503") return new Response("unavailable", { status: 503 });
      if (state.mode === "401" && url.pathname !== "/auth/health") return Response.json({ message: "Unauthorized" }, { status: 401 });
      if (url.pathname === "/iap/audit/batch") {
        const { rows } = (await req.json()) as { rows: AuditRow[] };
        state.batches.push(rows);
        return accepted(rows);
      }
      return Response.json({ status: "ok" });
    },
  });
  const login: Login = { backend: `http://127.0.0.1:${server.port}`, apiKey: "ak_test_ac11", userId: "u", orgId: "o", email: "e@x", deviceId: "d", deviceName: "n" };
  return { state, login, stop: () => server.stop(true) };
}

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

// The real Runtime.before/after over the harness store, with a real posture and, when asked, a real audit pump.
async function runtime(b: ReturnType<typeof backend>, opts: { pump?: boolean; now?: () => number } = {}) {
  const rt: any = await fakeRuntime(b.login, allow);
  let signedIn = true;
  rt.credentials.markSignedOut = () => {
    signedIn = false;
    rt.setLogin(null);
  };
  let pump: AuditPump | undefined;
  rt.posture = createBackendPosture({
    probe: probeBackend,
    log: memoryLog().log,
    onUnauthorized: (reason) => rt.credentials.markSignedOut(reason),
    onRecovered: () => pump?.retryNow(),
    now: opts.now,
  });
  if (opts.pump) {
    pump = createAuditPump({
      dataDir: scratch(),
      login: () => rt.login(),
      log: memoryLog().log,
      report: rt.posture.report,
      timing: { intervalMs: 60_000, minBackoffMs: 60_000, maxBackoffMs: 60_000 },
    });
    rt.audit = pump;
    cleanup.push(() => pump!.stop());
  }
  Object.setPrototypeOf(rt, Runtime.prototype);
  Object.assign(rt, {
    pending: new Map(),
    messageModel: new Map(),
    traces: { record() {} },
    builtin: { armoriqDir: "/home/u/.armoriq", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools },
  });
  return { rt, host: hostFor(rt, rt.log), pump, rows: rt.auditRows as AuditRow[], signedIn: () => signedIn };
}

async function attempt(host: ReturnType<typeof hostFor>, tool: string, callId: string, args: Record<string, unknown> = {}) {
  const start = Date.now();
  try {
    await host.toolBefore({ sessionId: sid, callId, tool, args });
    return { outcome: "allow", ms: Date.now() - start };
  } catch (error) {
    return { outcome: String((error as Error).message), ms: Date.now() - start };
  }
}

describe("backend unreachable while signed in (AC-11)", () => {
  test("read runs; write and bash wait 2 s then are blocked backend_unreachable; MCP tools are blocked too", async () => {
    const b = backend();
    cleanup.push(b.stop);
    const { host, rows } = await runtime(b);

    const read = await attempt(host, "read", "c-read", { filePath: "/repo/a.ts" });
    expect(read.outcome).toBe("allow");
    expect(read.ms).toBeLessThan(100);
    host.toolAfter({ callId: "c-read", tool: "read" }, "contents");

    const write = await attempt(host, "write", "c-write", { filePath: "/repo/a.ts", content: "x" });
    expect(write.outcome).toContain("[backend_unreachable]");
    expect(write.outcome).toContain("/armor status");
    expect(write.ms).toBeGreaterThanOrEqual(1_900);
    expect(write.ms).toBeLessThan(2_600);

    // Within the 30 s window the cached answer blocks at once.
    for (const [tool, args] of [["bash", { command: "ls" }], ["github_get_issue", { number: 1 }], ["webfetch", { url: "https://x" }], ["task", {}]] as const) {
      const r = await attempt(host, tool, `c-${tool}`, args);
      expect(r.outcome).toContain("[backend_unreachable]");
      expect(r.ms).toBeLessThan(100);
    }

    expect(rows.map((r) => [r.tool, r.status, r.capability, r.error_message?.split(":")[0]])).toEqual([
      ["read", "success", "read", undefined],
      ["write", "blocked", "write", "backend_unreachable"],
      ["bash", "blocked", "shell", "backend_unreachable"],
      ["github_get_issue", "blocked", "mcp", "backend_unreachable"],
      ["webfetch", "blocked", "web", "backend_unreachable"],
      ["task", "blocked", "other", "backend_unreachable"],
    ]);
  }, 10_000);

  test("a rule's own block keeps its reason instead of backend_unreachable", async () => {
    const b = backend();
    cleanup.push(b.stop);
    const { host, rt } = await runtime(b);
    rt.setPolicy({ ...allow, evaluate: () => ({ effect: "forbid", ruleId: "no-bash", reason: "bash is forbid" }) });
    const r = await attempt(host, "bash", "c1", { command: "ls" });
    expect(r.outcome).toContain("[policy_forbid]");
    expect(r.ms).toBeLessThan(100);
  });

  test("with intent required, a call with no plan is blocked backend_unreachable, not intent_plan_missing", async () => {
    const b = backend();
    cleanup.push(b.stop);
    const { host, rt } = await runtime(b);
    rt.setPolicy({ ...allow, intentRequired: true });
    expect((await attempt(host, "write", "c1", { filePath: "/repo/a.ts" })).outcome).toContain("[backend_unreachable]");
    expect((await attempt(host, "read", "c2", { filePath: "/repo/a.ts" })).outcome).toBe("allow");
  }, 10_000);

  test("rows queue while the backend returns 503 and upload once it is back", async () => {
    let clock = Date.now();
    const b = backend();
    b.state.mode = "503";
    cleanup.push(b.stop);
    const { host, pump } = await runtime(b, { pump: true, now: () => clock });

    expect((await attempt(host, "edit", "c1", { filePath: "/repo/a.ts" })).outcome).toContain("[backend_unreachable]");
    expect((await attempt(host, "bash", "c2", { command: "ls" })).outcome).toContain("[backend_unreachable]");
    pump!.kick();
    await Bun.sleep(200);
    expect(b.state.batches).toEqual([]);

    b.state.mode = "up";
    clock += RECHECK_AFTER_MS;
    expect((await attempt(host, "write", "c3", { filePath: "/repo/b.ts" })).outcome).toBe("allow");
    await until(() => b.state.batches.flat().length >= 2);
    expect(b.state.batches.flat().map((r) => [r.tool, r.status, r.capability, r.error_message?.split(":")[0]])).toEqual([
      ["edit", "blocked", "write", "backend_unreachable"],
      ["bash", "blocked", "shell", "backend_unreachable"],
    ]);
  }, 10_000);

  test("a 401 switches to local-only mode, not unreachable", async () => {
    const b = backend();
    b.state.mode = "401";
    cleanup.push(b.stop);
    const { host, pump, rt, signedIn } = await runtime(b, { pump: true });
    expect((await attempt(host, "read", "c1")).outcome).toBe("allow");
    host.toolAfter({ callId: "c1", tool: "read" }, "ok");
    pump!.kick();
    await until(() => !signedIn());
    expect(rt.posture.seen()?.state).not.toBe("unreachable");
    expect(rt.mode()).toBe("monitor");
    // Signed out, nothing waits on the backend and no posture block applies.
    const w = await attempt(host, "write", "c2", { filePath: "/repo/a.ts" });
    expect(w.outcome).toBe("allow");
    expect(w.ms).toBeLessThan(100);
  });
});
