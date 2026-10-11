import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArmor } from "../src/armor.ts";
import { ROTATE_BYTES, type AuditRow, type Ship } from "../src/audit-queue.ts";
import type { ArmorConfig } from "../src/config.ts";

const queuedRows = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).row);

const tempDir = () => mkdtempSync(path.join(tmpdir(), "armor-core-"));

const shipNothing: Ship = async () => ({ failures: [] });

const row: AuditRow = {
  session_id: "ses_1",
  agent_id: "opencode",
  client_id: "armoropencode",
  step_index: -1,
  action: "bash",
  tool: "bash",
  input: {},
  output: { output: "ok" },
  status: "success",
  executed_at: "2026-10-11T00:00:00.000Z",
  duration_ms: 1,
};

describe("createArmor audit rows", () => {
  function config(dataDir: string, apiKey?: string): ArmorConfig {
    return {
      mode: "enforce",
      apiKey,
      userId: apiKey ? "user-1" : undefined,
      userEmail: apiKey ? "dev@example.com" : undefined,
      backendEndpoint: "http://unused",
      dataDir,
      policyFile: path.join(dataDir, "policy.json"),
      flushIntervalMs: 5000,
      timeoutMs: 1000,
    };
  }

  test("a successful call queues one attributed, redacted, truncated row with its duration", async () => {
    const dir = tempDir();
    let clock = 1_000;
    const armor = createArmor({ config: config(dir, "ak_test"), log: () => {}, ship: shipNothing, now: () => clock });
    const call = { tool: "bash", sessionID: "ses_1", callID: "call_1" };
    await armor.beforeTool(call, { command: "echo token=abcdefghijklmnop" });
    clock = 1_250;
    await armor.afterTool(call, { command: "echo token=abcdefghijklmnop" }, { title: "echo", output: "z".repeat(3000) });
    const rows = queuedRows(armor.queue.paths.currentPath);
    expect(rows).toEqual([
      {
        session_id: "ses_1",
        agent_id: "opencode",
        client_id: "armoropencode",
        user_id: "user-1",
        user_email: "dev@example.com",
        step_index: -1,
        action: "bash",
        tool: "bash",
        input: { command: "echo token=<redacted>" },
        output: { title: "echo", output: `${"z".repeat(2000)}...` },
        status: "success",
        executed_at: "1970-01-01T00:00:01.000Z",
        duration_ms: 250,
      },
    ]);
  });

  test("a blocked call throws the reason and its error event queues a failed row once", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ rules: [{ id: "no-task", action: "deny", tool: "task" }] }));
    const armor = createArmor({ config: config(dir), log: () => {}, ship: shipNothing });
    const call = { tool: "task", sessionID: "ses_1", callID: "call_2" };
    await expect(armor.beforeTool(call, { prompt: "p" })).rejects.toThrow("ArmorOpenCode policy deny: no-task");
    const time = { start: 5_000, end: 5_004 };
    await armor.failedTool(call, { prompt: "p" }, "ArmorOpenCode policy deny: no-task", time);
    await armor.failedTool(call, { prompt: "p" }, "ArmorOpenCode policy deny: no-task", time);
    const rows = queuedRows(armor.queue.paths.currentPath);
    expect(rows).toEqual([
      {
        session_id: "ses_1",
        agent_id: "opencode",
        client_id: "armoropencode",
        step_index: -1,
        action: "task",
        tool: "task",
        input: { prompt: "p" },
        output: null,
        status: "failed",
        error_message: "ArmorOpenCode policy deny: no-task",
        executed_at: "1970-01-01T00:00:05.000Z",
        duration_ms: 4,
      },
    ]);
  });

  test("without an API key queued rows are never shipped", async () => {
    const dir = tempDir();
    let shipped = 0;
    const armor = createArmor({ config: config(dir), log: () => {}, ship: async () => (shipped++, { failures: [] }) });
    await armor.queue.append(row);
    expect(await armor.flush()).toEqual({ kind: "idle" });
    expect(shipped).toBe(0);
  });

  test("without an API key the local queue is capped by rotating into a bounded archive", async () => {
    const dir = tempDir();
    const armor = createArmor({ config: config(dir), log: () => {}, ship: shipNothing });
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "q".repeat(2000)]));
    const call = (n: number) => ({ tool: "bash", sessionID: "s", callID: `c${n}` });
    for (let n = 0; n < 60; n += 1) {
      await armor.beforeTool(call(n), {});
      await armor.afterTool(call(n), wide, { title: "", output: "out" });
    }
    expect(statSync(armor.queue.paths.currentPath).size).toBeLessThan(ROTATE_BYTES);
    expect(readdirSync(armor.queue.paths.archiveDir).length).toBe(3);
  });
});
