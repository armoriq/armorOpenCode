import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArmor } from "../src/armor.ts";
import type { AuditRow } from "../src/audit-queue.ts";
import type { ArmorConfig } from "../src/config.ts";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "armor-core-"));

const row: AuditRow = {
  token: "",
  step_index: 0,
  action: "bash",
  tool: "bash",
  input: {},
  output: "ok",
  status: "success",
  executed_at: "2026-10-11T00:00:00.000Z",
  duration_ms: 1,
};

describe("createArmor audit rows", () => {
  function config(dataDir: string, apiKey?: string): ArmorConfig {
    return {
      mode: "enforce",
      apiKey,
      backendEndpoint: "http://unused",
      dataDir,
      policyFile: path.join(dataDir, "policy.json"),
      flushIntervalMs: 5000,
      timeoutMs: 1000,
    };
  }

  test("a successful call queues one redacted, truncated row with its duration", async () => {
    const dir = tempDir();
    let clock = 1_000;
    const armor = createArmor({ config: config(dir), log: () => {}, ship: async () => {}, now: () => clock });
    const call = { tool: "bash", sessionID: "ses_1", callID: "call_1" };
    await armor.beforeTool(call, { command: "echo token=abcdefghijklmnop" });
    clock = 1_250;
    await armor.afterTool(call, { command: "echo token=abcdefghijklmnop" }, "z".repeat(3000));
    const rows = readFileSync(armor.queue.paths.currentPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([
      {
        token: "",
        step_index: 0,
        action: "bash",
        tool: "bash",
        input: { command: "echo token=<redacted>" },
        output: `${"z".repeat(2000)}...`,
        status: "success",
        executed_at: "1970-01-01T00:00:01.000Z",
        duration_ms: 250,
      },
    ]);
  });

  test("a blocked call throws the reason and its error event queues a failed row once", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ rules: [{ id: "no-task", action: "deny", tool: "task" }] }));
    const armor = createArmor({ config: config(dir), log: () => {}, ship: async () => {} });
    const call = { tool: "task", sessionID: "ses_1", callID: "call_2" };
    await expect(armor.beforeTool(call, { prompt: "p" })).rejects.toThrow("ArmorOpenCode policy deny: no-task");
    const time = { start: 5_000, end: 5_004 };
    await armor.failedTool(call, { prompt: "p" }, "ArmorOpenCode policy deny: no-task", time);
    await armor.failedTool(call, { prompt: "p" }, "ArmorOpenCode policy deny: no-task", time);
    const rows = readFileSync(armor.queue.paths.currentPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([
      {
        token: "",
        step_index: 0,
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
    const armor = createArmor({ config: config(dir), log: () => {}, ship: async () => void shipped++ });
    await armor.queue.append(row);
    expect(await armor.flush()).toEqual({ kind: "idle" });
    expect(shipped).toBe(0);
  });
});
