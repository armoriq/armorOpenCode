import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostFor } from "../../src/host.ts";
import { GuardDenied } from "../../src/runtime.ts";
import { withReach } from "../../src/reach/index.ts";
import { isPlanSuccess } from "../../src/reach/replies.ts";
import { fakeRuntime, planArgs } from "../support/intent-harness.ts";
import type { SessionID } from "../../src/types.ts";
import { countsDir, countsFile, home, origin, settings, today, until } from "./helpers.ts";

const sessionId = "session" as SessionID;
const call = { sessionId, messageId: "message", callId: "own" };
const options = { backend: origin };
async function host() {
  const rt = await fakeRuntime(null);
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  Object.assign(rt, Object.fromEntries(["before", "after", "failed", "userMessage", "sessionCreated", "sessionTitle", "idle", "deleted", "assistantModel", "stepFinished"].map(name => [name, record(name)])));
  return { rt, inner: hostFor(rt, rt.log), calls };
}

test("held and blocked decisions are counted and the exact GuardDenied is rethrown", async () => {
  const dir = home(); const { rt, inner } = await host();
  const h = withReach(inner, options, { home: dir, env: {}, now: () => today, readLogin: () => null });
  for (const decision of [{ kind: "hold", ruleId: null, reason: "approval" }, { kind: "deny", code: "policy_forbid", ruleId: null, reason: "denied" }] as const) {
    const error = new GuardDenied(decision);
    Object.assign(rt, { before: async () => { throw error; } });
    let caught: unknown;
    try { await h.toolBefore({ sessionId, callId: "blocked", tool: "planted-secret-tool", args: { path: "/private/planted" } }); } catch (e) { caught = e; }
    expect(caught).toBe(error);
  }
  await until(() => existsSync(countsFile(dir, "2026-11-14")) && readFileSync(countsFile(dir, "2026-11-14"), "utf8").split("\n").length === 3);
  expect(readFileSync(countsFile(dir, "2026-11-14"), "utf8")).toBe('{"t":"held"}\n{"t":"blocked"}\n');
});

test("registration and reanchor count once each, while revocation and refresh paths do not", async () => {
  const dir = home(); const { inner } = await host();
  const h = withReach(inner, options, { home: dir, env: {}, now: () => today, readLogin: () => null });
  const local = "Intent recorded locally: 1 steps. ArmorIQ is not logged in, so calls are monitored, not enforced.";
  expect(await h.ownTools.registerIntentPlan(call, planArgs("bash"), "")).toBe(local);
  expect(await h.ownTools.reanchor(call, planArgs("edit"), "change")).toBe(local);
  await h.ownTools.revoke(call, "done");
  h.toolAfter({ callId: "refresh", tool: "register_intent_plan" }, local);
  h.ownTools.answered(call);
  await until(() => existsSync(countsFile(dir, "2026-11-14")) && readFileSync(countsFile(dir, "2026-11-14"), "utf8").split("\n").length === 3);
  expect(readFileSync(countsFile(dir, "2026-11-14"), "utf8")).toBe('{"t":"plan"}\n{"t":"plan"}\n');
});

// Pin all current reply families in src/tools/intent.ts, including dynamic details.
const replies = [
  [true, "Intent recorded locally: 1 steps. ArmorIQ is not logged in, so calls are monitored, not enforced."],
  [true, "Intent registered: 1 steps. Token valid until 2100-01-01T00:00:00.000Z."],
  [true, "Intent revised (revision 2): 1 steps. Token valid until 2100-01-01T00:00:00.000Z. Denied by policy: bash. Requires approval: edit."],
  [false, "This is a subagent session. It inherits the plan registered by its parent session and cannot register its own. Continue within the parent plan."],
  [false, "A plan registration is already in progress for this session. Wait for it to finish."],
  [false, 'Plan revision rejected: a plan is already registered. Pass a "reason" explaining why the plan changed.'],
  [false, "Plan revision rejected: at most 2 revisions are allowed per user message. Continue with the current plan or ask the user how to proceed."],
  [false, "Plan rejected: goal: a one-line summary is required"],
  [false, "Plan rejected: step 1 uses bash, which the current policy forbids (rule deny-bash): bash is forbidden"],
  [false, "Plan not registered: ArmorIQ could not issue an intent token (HTTP 503: offline). No plan is active, so side-effecting calls stay blocked. Try again shortly."],
  [false, "Plan not registered: ArmorIQ could not issue an intent token (HTTP 503: offline). The previous plan is still in effect. Try again shortly."],
  [false, "Plan not registered: the ArmorIQ API key was revoked (account_revoked). Tool calls are blocked until the user logs in again."],
  [false, "Plan not registered: the ArmorIQ organization has no active subscription or is over quota (billing_blocked). Tool calls are blocked."],
  [false, "No registered plan to re-anchor. Call register_intent_plan first."],
  [false, "future unknown reply"],
] as const;
for (const [success, reply] of replies) {
  test(`reply is pinned and ${success ? "counted" : "excluded"}: ${reply}`, async () => {
    expect(isPlanSuccess(reply)).toBe(success);
    const dir = home(); const { inner } = await host();
    inner.ownTools.registerIntentPlan = async () => reply;
    inner.ownTools.reanchor = async () => reply;
    const h = withReach(inner, options, { home: dir, env: {}, now: () => today, readLogin: () => null });
    expect(await h.ownTools.registerIntentPlan(call, {}, "")).toBe(reply);
    expect(await h.ownTools.reanchor(call, {}, "")).toBe(reply);
    if (success) await until(() => existsSync(countsFile(dir, "2026-11-14")) && readFileSync(countsFile(dir, "2026-11-14"), "utf8").split("\n").length === 3);
    else { await Bun.sleep(15); expect(existsSync(countsDir(dir))).toBe(false); }
  });
}

test("pinned reply families match the real intent tools", async () => {
  const proc = Bun.spawn([process.execPath, `${import.meta.dir}/reply-child.ts`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  const observed = JSON.parse(out);
  const keys = ["local", "minted", "revised", "child", "concurrent", "reason", "limit", "parse", "policy", "failure", "kept", "account_revoked", "billing_blocked", "empty"];
  for (const [i, key] of keys.entries()) expect(observed[key]).toBe(replies[i]![1]);
});

test("signed in, opted out and non contract backends never count", async () => {
  for (const kind of ["signed-in", "env", "settings", "plugin", "origin"]) {
    const dir = home(); const { inner } = await host();
    inner.ownTools.registerIntentPlan = async () => replies[0][1];
    inner.ownTools.reanchor = async () => replies[0][1];
    const error = new GuardDenied({ kind: "hold", reason: "approval", ruleId: null });
    inner.toolBefore = async () => { throw error; };
    if (kind === "settings") settings(dir, { usagePing: false });
    const h = withReach(inner, { backend: kind === "origin" ? "http://localhost" : origin, pluginOptions: { usagePing: kind !== "plugin" } }, { home: dir, env: kind === "env" ? { DO_NOT_TRACK: "1" } : {}, now: () => today, readLogin: () => kind === "signed-in" ? { backend: origin, apiKey: "x", userId: "", orgId: "", email: "", deviceId: "", deviceName: "" } : null });
    await h.ownTools.registerIntentPlan(call, {}, "");
    await h.ownTools.reanchor(call, {}, "");
    expect(await h.toolBefore({ sessionId, callId: "held", tool: "bash", args: {} }).catch(e => e)).toBe(error);
    await Bun.sleep(15);
    expect(existsSync(countsDir(dir))).toBe(false);
  }
});

test("delegation preserves all members, errors and receiver binding", async () => {
  const { inner, calls } = await host();
  const h = withReach(inner, options, { env: { DO_NOT_TRACK: "1" } });
  expect(h.log).toBe(inner.log);
  h.toolAfter({ callId: "a", tool: "bash" }, "output"); h.toolFailed({ callId: "b", tool: "bash" }, "error");
  h.userPrompt({ sessionId, messageId: "message", text: "hello" });
  h.event({ kind: "session_title", sessionId, title: "title" });
  expect(h.systemDirective(sessionId)).toBe(inner.systemDirective(sessionId));
  expect(h.armorCommand(sessionId, "status")).toBe(inner.armorCommand(sessionId, "status"));
  expect(h.hasSession(sessionId)).toBe(inner.hasSession(sessionId));
  expect(h.ownTools.policyRead(call, "bash")).toBe(inner.ownTools.policyRead(call, "bash"));
  await h.release();
  expect(calls).toEqual([["after", "a", "output"], ["failed", "b", "failed", "error"], ["userMessage", sessionId, "message", "hello"], ["sessionTitle", sessionId, "title"]]);
  const error = new Error("inner");
  inner.toolBefore = async () => { throw error; };
  expect(await h.toolBefore({ sessionId, callId: "c", tool: "bash", args: {} }).catch(e => e)).toBe(error);
});

test("session and prompt schedule one UTC attempt, rollover uses one captured date", async () => {
  const dir = home(); const { inner } = await host(); let clock = today; let calls = 0;
  const h = withReach(inner, options, { home: dir, env: {}, now: () => clock, readLogin: () => null, fetch: async () => { calls++; return new Response(null, { status: 204 }); } });
  h.event({ kind: "session_created", sessionId, parentId: null });
  h.userPrompt({ sessionId, messageId: "m1", text: "/private/planted hostname secret-tool" });
  expect(calls).toBe(0);
  await until(() => calls === 1);
  await Bun.sleep(15);
  h.userPrompt({ sessionId, messageId: "m2", text: "same day" });
  await Bun.sleep(20); expect(calls).toBe(1);
  clock += 1;
  h.userPrompt({ sessionId, messageId: "m3", text: "next day" });
  await until(() => calls === 2);
  clock = today;
  h.userPrompt({ sessionId, messageId: "m4", text: "clock back" });
  await Bun.sleep(20); expect(calls).toBe(2);
});

test("reach failures cannot change successful or refused host replies", async () => {
  const dir = home(); writeFileSync(`${dir}/.armoriq`, "not a directory");
  const { inner } = await host();
  const h = withReach(inner, options, { home: dir, env: {}, now: () => today, readLogin: () => { throw new Error("unavailable"); } });
  expect(await h.ownTools.registerIntentPlan(call, planArgs("bash"), "")).toBe(replies[0][1]);
  h.userPrompt({ sessionId, messageId: "m", text: "hi" });
  await Bun.sleep(20);
  expect(await h.toolBefore({ sessionId, callId: "c", tool: "bash", args: {} })).toBeUndefined();
});
