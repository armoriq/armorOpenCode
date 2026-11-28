import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostFor, type ArmorHost } from "../src/host.ts";
import { probeBackend } from "../src/io/backend-health.ts";
import { Runtime } from "../src/runtime.ts";
import { createBackendPosture } from "../src/state/backend-posture.ts";
import { createPolicyBundle } from "../src/state/policy-bundle.ts";
import { createSessionStore } from "../src/state/sessions.ts";
import { OWN_TOOL_NAMES } from "../src/tools/intent.ts";
import type { CompiledPolicy, Login, SessionID } from "../src/types.ts";
import { memoryLog } from "./io/helpers/stub.ts";
import { fakeRuntime } from "./support/intent-harness.ts";

const allow: CompiledPolicy = { hash: "h", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) };
const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_bundle", userId: "u", orgId: "o", email: "e@x", deviceId: "d", deviceName: "n" };
const sid = "ses_bundle" as SessionID;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

async function runtime(l: Login) {
  const rt: any = await fakeRuntime(l, allow);
  Object.setPrototypeOf(rt, Runtime.prototype);
  Object.assign(rt, {
    pending: new Map(),
    messageModel: new Map(),
    traces: { record() {} },
    builtin: { armoriqDir: "/home/u/.armoriq", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools },
  });
  return { rt, host: hostFor(rt, rt.log) as ArmorHost, rows: rt.auditRows as Record<string, any>[] };
}

async function outcome(host: ArmorHost, tool: string, args: Record<string, unknown> = {}, callId = `c-${tool}`) {
  try {
    await host.toolBefore({ sessionId: sid, callId, tool, args });
    return "allow";
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("signed in without a usable workspace bundle", () => {
  test("no bundle blocks every non-read call and lets reads and policy_read run", async () => {
    const { rt, host, rows } = await runtime(login);
    rt.setBundle(null);
    expect(await outcome(host, "read", { filePath: "/repo/a.ts" })).toBe("allow");
    expect(await outcome(host, "policy_read")).toBe("allow");
    for (const [tool, args] of [["write", { filePath: "/repo/a.ts", content: "x" }], ["bash", { command: "ls" }], ["github_get_issue", {}], ["webfetch", { url: "https://x" }], ["task", { prompt: "go" }]] as const) {
      expect(await outcome(host, tool, args)).toContain("[policy_bundle_unavailable]");
    }
    expect(rows.filter((r) => r.status === "blocked")).toHaveLength(5);
  });

  test("a stale bundle blocks non-read calls too", async () => {
    const { rt, host } = await runtime(login);
    rt.bundle = { state: () => ({ status: "stale", agent: undefined, checkedAt: 0 }), refresh: async () => {}, stop() {} };
    expect(await outcome(host, "bash", { command: "ls" })).toContain("[policy_bundle_unavailable]");
    expect(await outcome(host, "read", { filePath: "/repo/a.ts" })).toBe("allow");
  });

  test("a loaded bundle with no entry for this agent leaves the decision to the local policy", async () => {
    const { rt, host } = await runtime(login);
    rt.setBundle(undefined);
    expect(await outcome(host, "bash", { command: "ls" })).toBe("allow");
  });

  test("bundle 5xx while the open health route is green: write and bash do not run", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/auth/health") return Response.json({ status: "ok" });
        return new Response("down", { status: 500 });
      },
    });
    cleanup.push(() => server.stop(true));
    const live: Login = { ...login, backend: `http://127.0.0.1:${server.port}` };
    const { rt, host } = await runtime(live);
    rt.posture = createBackendPosture({ probe: probeBackend, log: memoryLog().log, onUnauthorized() {}, onRecovered() {} });
    rt.bundle = createPolicyBundle({ log: memoryLog().log, login: () => live, report: rt.posture.report, intervalMs: 3_600_000 });
    cleanup.push(() => rt.bundle.stop());
    expect(await outcome(host, "read", { filePath: "/repo/a.ts" })).toBe("allow");
    expect(await outcome(host, "write", { filePath: "/repo/a.ts", content: "x" })).toMatch(/\[(policy_bundle_unavailable|backend_unreachable)\]/);
    expect(await outcome(host, "bash", { command: "ls" })).toMatch(/\[(policy_bundle_unavailable|backend_unreachable)\]/);
  });
});

test("/armor status says only reads run while the bundle is not loaded", async () => {
  const { handleArmorCommand } = await import("../src/commands/armor.ts");
  const { rt } = await runtime(login);
  rt.setBundle(null);
  expect(handleArmorCommand("/armor status", sid, rt)).toContain("Workspace policy (v2): not loaded, so only read calls run");
});

test("a bundle 401 keeps the developer signed in and blocks non-read calls", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 401 }) });
  cleanup.push(() => server.stop(true));
  const live: Login = { ...login, backend: `http://127.0.0.1:${server.port}` };
  const { rt, host } = await runtime(live);
  const signedOut: string[] = [];
  rt.posture = createBackendPosture({ probe: probeBackend, log: memoryLog().log, onUnauthorized: (r) => void signedOut.push(r), onRecovered() {} });
  rt.bundle = createPolicyBundle({ log: memoryLog().log, login: () => live, report: rt.posture.report, intervalMs: 3_600_000 });
  cleanup.push(() => rt.bundle.stop());
  expect(await outcome(host, "bash", { command: "ls" })).toContain("[policy_bundle_unavailable]");
  expect(signedOut).toEqual([]);
  expect(rt.login()).toEqual(live);
});

test("in a confirmed workspace Monitor an unavailable bundle stops nothing and shows no notice", async () => {
  const { rt, host } = await runtime(login);
  rt.setBundle(null);
  rt.org = { current: () => ({ mode: "shadow", notices: true }), async refresh() {} };
  const notes: string[] = [];
  rt.notice = (_: string, text: string) => void notes.push(text);
  delete rt.mode;
  rt.sessions = createSessionStore(mkdtempSync(path.join(tmpdir(), "aoc-bundle-")), () => rt.mode());
  expect(rt.mode()).toBe("monitor");
  expect(await outcome(host, "write", { filePath: "/repo/a.ts", content: "x" })).toBe("allow");
  expect(notes).toEqual([]);
});
