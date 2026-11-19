import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionStore } from "../../src/state/sessions.ts";
import type { Login, Mode, Plan, SessionID, Token } from "../../src/types.ts";
import { decide } from "../support/intent-harness.ts";

const sid = (s: string) => s as SessionID;
const dir = () => mkdtempSync(path.join(tmpdir(), "aoc-store-"));
const plan = (tools: string[], revision = 1): Plan => ({
  id: `plan-${revision}`,
  hash: `hash-${revision}`,
  goal: "goal",
  steps: tools.map((t) => ({ action: t, tool: t })),
  revision,
  registeredInMessage: "m1",
});
const active = (): Token => ({ status: "active", jwt: "jwt", expiresAt: Date.now() + 3_600_000, deniedTools: new Set(["rm"]), heldTools: new Set(["deploy"]) });

describe("session store", () => {
  test("root follows parentId through nested subagents", () => {
    const s = createSessionStore(dir(), () => "enforce");
    s.open(sid("root"), null, "enforce");
    s.open(sid("child"), sid("root"), "enforce");
    s.open(sid("grandchild"), sid("child"), "enforce");
    s.setPlan(sid("root"), plan(["bash"]), active());
    expect(s.root(sid("grandchild")).id).toBe(sid("root"));
    expect(s.root(sid("grandchild")).plan?.steps[0]?.tool).toBe("bash");
    expect(s.get(sid("grandchild")).plan).toBeNull();
  });

  test("a parent that is not in the store ends the walk at the child", () => {
    const s = createSessionStore(dir(), () => "enforce");
    s.open(sid("orphan"), sid("gone"), "enforce");
    expect(s.root(sid("orphan")).id).toBe(sid("orphan"));
  });

  test("beginMessage resets the revision counter only for a new message", () => {
    const s = createSessionStore(dir(), () => "enforce");
    s.open(sid("a"), null, "enforce");
    s.beginMessage(sid("a"), "m1");
    s.noteRevision(sid("a"));
    s.noteRevision(sid("a"));
    s.beginMessage(sid("a"), "m1");
    expect(s.get(sid("a")).revisionsThisMessage).toBe(2);
    s.beginMessage(sid("a"), "m2");
    expect(s.get(sid("a")).revisionsThisMessage).toBe(0);
  });

  test("root prompts get one UUID per message and retire the preceding plan", () => {
    const store = createSessionStore(dir(), () => "enforce");
    const s = store.open(sid("a"), null, "enforce");
    store.beginMessage(s.id, "m1");
    const first = s.promptId;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s.promptGeneration).toBe(1);
    expect(s.promptOpenSince).toBeNumber();
    expect(s.lastActivityAt).toBeGreaterThanOrEqual(s.promptOpenSince!);
    store.setPlan(s.id, plan(["bash"]), active());
    expect(decide(s, s, { tool: "bash", args: {} }).kind).toBe("allow");
    store.beginMessage(s.id, "m1");
    expect(s.promptId).toBe(first);
    expect(s.plan).not.toBeNull();
    store.beginMessage(s.id, "m2");
    expect(s.promptId).not.toBe(first);
    expect(s.promptGeneration).toBe(2);
    expect(decide(s, s, { tool: "bash", args: {} })).toMatchObject({ kind: "deny", code: "intent_plan_missing" });
    expect([s.plan, s.token, s.countedPlanId, s.tokenPlanId, s.planHash, s.kind, s.tokenExpiresAt, s.pendingRequest, s.unregisteredLocalPlan]).toEqual(Array(9).fill(null));
    const second = s.promptId;
    store.beginMessage(s.id, "m1");
    expect(s.promptId).toBe(second);
    expect(s.promptGeneration).toBe(2);
  });

  test("subagent messages never create a prompt or retire the root plan", () => {
    const store = createSessionStore(dir(), () => "enforce");
    const root = store.open(sid("root"), null, "enforce");
    const child = store.open(sid("child"), root.id, "enforce");
    store.beginMessage(root.id, "m1");
    store.setPlan(root.id, plan(["bash"]), active());
    store.beginMessage(child.id, "child-message");
    expect(child.promptId).toBeNull();
    expect(child.promptGeneration).toBe(0);
    expect(root.promptGeneration).toBe(1);
    expect(root.plan).not.toBeNull();
  });

  test("results install only for the current prompt and authentication generations", () => {
    const initial: Login = { backend: "http://localhost", apiKey: "test-key", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };
    let login: Login | null = initial;
    const store = createSessionStore(dir(), () => login ? "enforce" : "monitor", () => login);
    const s = store.open(sid("a"), null, "enforce");
    store.beginMessage(s.id, "m1");
    const first = { promptId: s.promptId, promptGeneration: s.promptGeneration, authGeneration: s.authGeneration };
    store.beginMessage(s.id, "m2");
    expect(store.setPlan(s.id, plan(["bash"]), active(), first)).toBe(false);
    expect(s.plan).toBeNull();
    const second = { promptId: s.promptId, promptGeneration: s.promptGeneration, authGeneration: s.authGeneration };
    expect(store.setPlan(s.id, plan(["bash"]), active(), second)).toBe(true);
    expect(s.kind).toBe("new");
    expect([s.countedPlanId, s.tokenPlanId, s.planHash]).toEqual(["plan-1", "plan-1", "hash-1"]);
    login = null;
    store.syncAuth();
    expect(s.plan).toBeNull();
    expect(s.token).toBeNull();
    expect(s.authGeneration).toBe(second.authGeneration + 1);
    expect(store.setPlan(s.id, plan(["write"]), active(), second)).toBe(false);
    login = { ...initial, apiKey: "changed-key" };
    store.syncAuth();
    expect(s.authGeneration).toBe(second.authGeneration + 2);
    expect(store.setToken(s.id, active(), second)).toBe(false);
  });

  test("closing a prompt keeps it closed on a duplicate event and records activity", () => {
    const store = createSessionStore(dir(), () => "enforce");
    const s = store.open(sid("a"), null, "enforce");
    store.beginMessage(s.id, "m1");
    const prompt = s.promptId;
    store.endPrompt(s.id);
    expect(s.promptOpenSince).toBeNull();
    store.beginMessage(s.id, "m1");
    expect(s.promptId).toBe(prompt);
    expect(s.promptOpenSince).toBeNull();
    store.noteActivity(s.id, 12345);
    expect(s.lastActivityAt).toBe(12345);
  });

  test("pending requests and local plans survive a snapshot and retire on the next prompt", async () => {
    const d = dir();
    const store = createSessionStore(d, () => "monitor");
    const s = store.open(sid("local"), null, "monitor");
    store.beginMessage(s.id, "m1");
    const local = { ...plan(["bash"]), id: "" };
    store.setPlan(s.id, local, null);
    s.pendingRequest = { key: "pcc1:test", headers: { "X-ArmorIQ-Plan-Kind": "new" }, body: { context_id: s.id } };
    await store.flush();
    const restarted = createSessionStore(d, () => "monitor");
    const restored = restarted.open(s.id, null, "monitor");
    expect(restored.unregisteredLocalPlan).toEqual(local);
    expect(restored.pendingRequest).toEqual(s.pendingRequest);
    restarted.beginMessage(s.id, "m2");
    expect(restored.unregisteredLocalPlan).toBeNull();
    expect(restored.pendingRequest).toBeNull();
  });

  test("a snapshot from another authentication binding cannot restore an active plan", async () => {
    const d = dir();
    const initial: Login = { backend: "http://localhost", apiKey: "test-key", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };
    const first = createSessionStore(d, () => "enforce", () => initial);
    const s = first.open(sid("a"), null, "enforce");
    first.beginMessage(s.id, "m1");
    first.setPlan(s.id, plan(["bash"]), active());
    await first.flush();
    const second = createSessionStore(d, () => "enforce", () => ({ ...initial, orgId: "another-org" }));
    const restored = second.open(s.id, null, "enforce");
    expect(restored.plan).toBeNull();
    expect(restored.token).toBeNull();
    expect(restored.authGeneration).toBe(s.authGeneration + 1);
  });

  test("advance only moves the cursor forward", () => {
    const s = createSessionStore(dir(), () => "enforce");
    s.open(sid("a"), null, "enforce");
    s.advance(sid("a"), 2);
    s.advance(sid("a"), 0);
    expect(s.get(sid("a")).stepCursor).toBe(3);
  });

  test("mode follows the login state on every read", () => {
    let mode: Mode = "monitor";
    const s = createSessionStore(dir(), () => mode);
    s.open(sid("a"), null, "monitor");
    mode = "enforce";
    expect(s.get(sid("a")).mode).toBe("enforce");
  });

  test("state survives a restart through the snapshot written in the background", async () => {
    const d = dir();
    const first = createSessionStore(d, () => "enforce");
    first.open(sid("ses_1"), null, "enforce");
    first.beginMessage(sid("ses_1"), "m9");
    first.setPlan(sid("ses_1"), plan(["bash", "write"]), active());
    first.advance(sid("ses_1"), 0);
    first.noteRevision(sid("ses_1"));
    await Bun.sleep(250);
    expect(readdirSync(d)).toEqual(["ses_1.json"]);

    const second = createSessionStore(d, () => "enforce");
    expect(second.has(sid("ses_1"))).toBe(false);
    const s = second.open(sid("ses_1"), null, "enforce");
    expect(s.plan).toEqual(plan(["bash", "write"]));
    expect(s.stepCursor).toBe(1);
    expect(s.revisionsThisMessage).toBe(1);
    expect(s.currentMessageId).toBe("m9");
    const original = first.get(sid("ses_1"));
    for (const field of ["promptId", "promptGeneration", "promptOpenSince", "lastActivityAt", "countedPlanId", "tokenPlanId", "planHash", "kind", "tokenExpiresAt", "authGeneration", "pendingRequest", "unregisteredLocalPlan"] as const) {
      expect(s[field]).toEqual(original[field]);
    }
    second.beginMessage(s.id, "m9");
    expect(s.promptId).toBe(original.promptId);
    const t = s.token;
    expect(t?.status).toBe("active");
    if (t?.status === "active") {
      expect(t.deniedTools.has("rm")).toBe(true);
      expect(t.heldTools.has("deploy")).toBe(true);
    }
  });

  test("snapshot writes are coalesced and do not block the caller", async () => {
    const d = dir();
    const s = createSessionStore(d, () => "enforce");
    s.open(sid("a"), null, "enforce");
    for (let i = 0; i < 50; i++) s.advance(sid("a"), i);
    expect(readdirSync(d)).toEqual([]);
    await s.flush();
    expect(readdirSync(d)).toEqual(["a.json"]);
  });

  test("close forgets the session and deletes its snapshot", async () => {
    const d = dir();
    const s = createSessionStore(d, () => "enforce");
    s.open(sid("a"), null, "enforce");
    await s.flush();
    s.close(sid("a"));
    await s.flush();
    expect(s.has(sid("a"))).toBe(false);
    expect(existsSync(path.join(d, "a.json"))).toBe(false);
  });

  test("corrupt or foreign snapshot files are ignored", () => {
    const d = dir();
    writeFileSync(path.join(d, "bad.json"), "{not json");
    writeFileSync(path.join(d, "other.json"), JSON.stringify({ v: 1, id: "other", plan: { id: 1 } }));
    const s = createSessionStore(d, () => "enforce");
    expect(s.open(sid("bad"), null, "enforce").plan).toBeNull();
    expect(s.open(sid("other"), null, "enforce").plan).toBeNull();
  });

  test("leftover temp files from an interrupted write are removed at load, a fresh one is kept", () => {
    const d = dir();
    const stale = path.join(d, "ses_a.json.4242.tmp");
    const fresh = path.join(d, "ses_b.json.4243.tmp");
    writeFileSync(stale, "{");
    writeFileSync(fresh, "{");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(stale, old, old);
    createSessionStore(d, () => "enforce");
    expect([existsSync(stale), existsSync(fresh)]).toEqual([false, true]);
  });
});
