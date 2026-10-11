import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionStore } from "../../src/state/sessions.ts";
import type { Mode, Plan, SessionID, Token } from "../../src/types.ts";

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
    first.setPlan(sid("ses_1"), plan(["bash", "write"]), active());
    first.advance(sid("ses_1"), 0);
    first.beginMessage(sid("ses_1"), "m9");
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
});
