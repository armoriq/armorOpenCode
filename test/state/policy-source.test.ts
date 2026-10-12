import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compilePolicy, DEFAULT_POLICY_SOURCE } from "../../src/core/policy.ts";
import { createPolicySource, type PolicySource } from "../../src/state/policy-source.ts";
import type { Log, SessionID } from "../../src/types.ts";

type Entry = { level: string; message: string; extra?: Record<string, unknown> };

function recorder(): Log & { entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    info: (message, extra) => entries.push({ level: "info", message, extra }),
    warn: (message, extra) => entries.push({ level: "warn", message, extra }),
    error: (message, extra) => entries.push({ level: "error", message, extra }),
  };
}

const denyBash = {
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id: "no-bash", effect: "forbid", action: { type: "tool", eq: "Bash" } }],
};
const denyWrite = {
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id: "no-write", effect: "forbid", action: { type: "tool", eq: "Write" } }],
};

function hashOf(raw: unknown): string {
  const r = compilePolicy(raw);
  if (!r.ok) throw new Error(r.error);
  return r.policy.hash;
}

function effect(source: PolicySource, tool: string): string {
  return source.current().evaluate({ sessionId: "s" as SessionID, callId: "c", tool, args: {} }).effect;
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const open: PolicySource[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.stop();
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "aoc-policy-"));
  const file = path.join(dir, "policy.json");
  const log = recorder();
  return { dir, file, log, start: () => {
    const s = createPolicySource(file, log);
    open.push(s);
    return s;
  } };
}

describe("createPolicySource", () => {
  test("a missing file yields the default all-allow policy", () => {
    const { start, log } = setup();
    const source = start();
    expect(source.current().hash).toBe(hashOf(DEFAULT_POLICY_SOURCE));
    expect(log.entries).toEqual([]);
  });

  test("an existing file is loaded synchronously at creation", () => {
    const { file, start } = setup();
    writeFileSync(file, JSON.stringify(denyBash));
    const source = start();
    expect(source.current().hash).toBe(hashOf(denyBash));
    expect(effect(source, "bash")).toBe("forbid");
  });

  test("a file that never compiled denies every tool and says so", () => {
    const { file, start, log } = setup();
    writeFileSync(file, "{ not json");
    const source = start();
    expect(effect(source, "read")).toBe("forbid");
    expect(log.entries[0]?.level).toBe("error");
    expect(log.entries[0]?.message).toBe("policy rejected at startup; denying all tools until it is fixed");
  });

  test("an edit to the file swaps the policy in the background", async () => {
    const { file, start } = setup();
    writeFileSync(file, JSON.stringify(denyBash));
    const source = start();
    writeFileSync(file, JSON.stringify(denyWrite));
    await until(() => source.current().hash === hashOf(denyWrite));
    expect(effect(source, "bash")).toBe("permit");
    expect(effect(source, "write")).toBe("forbid");
  });

  test("an invalid edit keeps the last good policy and logs why", async () => {
    const { file, start, log } = setup();
    writeFileSync(file, JSON.stringify(denyBash));
    const source = start();
    writeFileSync(file, JSON.stringify({ ...denyBash, statements: [{ id: "x", effect: "forbid", conditions: [{ field: "bash.raw", op: "matches", value: "(a)\\1" }] }] }));
    await until(() => log.entries.some((e) => e.level === "warn"));
    expect(source.current().hash).toBe(hashOf(denyBash));
    expect(log.entries.find((e) => e.level === "warn")?.message).toBe("policy change rejected; keeping the last good policy");
  });

  test("an atomic replace is picked up, and deleting the file falls back to the default", async () => {
    const { dir, file, start } = setup();
    writeFileSync(file, JSON.stringify(denyBash));
    const source = start();
    const tmp = path.join(dir, "policy.json.tmp");
    writeFileSync(tmp, JSON.stringify(denyWrite));
    renameSync(tmp, file);
    await until(() => source.current().hash === hashOf(denyWrite));
    rmSync(file);
    await until(() => source.current().hash === hashOf(DEFAULT_POLICY_SOURCE));
  });

  test("a file created after startup is picked up", async () => {
    const { file, start } = setup();
    const source = start();
    writeFileSync(file, JSON.stringify(denyBash));
    await until(() => source.current().hash === hashOf(denyBash));
  });

  test("after stop, changes are ignored", async () => {
    const { file, start } = setup();
    writeFileSync(file, JSON.stringify(denyBash));
    const source = start();
    source.stop();
    writeFileSync(file, JSON.stringify(denyWrite));
    await new Promise((r) => setTimeout(r, 1500));
    expect(source.current().hash).toBe(hashOf(denyBash));
  });
});
