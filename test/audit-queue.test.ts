import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAuditQueue, flushOnce, MAX_ATTEMPTS, type AuditRow, type FlushResult, type RowFailure, type Ship } from "../src/audit-queue.ts";

function row(tool: string): AuditRow {
  return {
    session_id: "ses_1",
    agent_id: "opencode",
    client_id: "armoropencode",
    step_index: -1,
    action: tool,
    tool,
    input: {},
    output: { output: "ok" },
    status: "success",
    executed_at: "2026-10-11T00:00:00.000Z",
    duration_ms: 1,
  };
}

const shipped = (rows: number): FlushResult => ({ kind: "shipped", written: rows, retried: 0, deadLettered: [] });

const recorder = (tools: string[], failures: (rows: AuditRow[]) => RowFailure[] = () => []): Ship =>
  async (rows) => {
    tools.push(...rows.map((r) => r.tool));
    return { failures: failures(rows) };
  };

const tempDir = () => mkdtempSync(path.join(tmpdir(), "armor-queue-"));

describe("flushOnce", () => {
  test("keeps rows queued after a failed ship and resends the same rows next time", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    await queue.append(row("edit"));
    const attempts: string[][] = [];
    let fail = true;
    const ship: Ship = async (rows) => {
      attempts.push(rows.map((r) => r.tool));
      if (fail) throw new Error("503 from backend");
      return { failures: [] };
    };

    expect(await flushOnce(queue, ship)).toEqual({ kind: "failed", error: "503 from backend" });
    fail = false;
    expect(await flushOnce(queue, ship)).toEqual(shipped(2));
    expect(await flushOnce(queue, ship)).toEqual({ kind: "idle" });
    expect(attempts).toEqual([
      ["bash", "edit"],
      ["bash", "edit"],
    ]);
  });

  test("ships only rows appended after the last acknowledged batch", async () => {
    const queue = createAuditQueue(tempDir());
    const sent: string[] = [];
    await queue.append(row("bash"));
    await flushOnce(queue, recorder(sent));
    await queue.append(row("write"));
    await flushOnce(queue, recorder(sent));
    expect(sent).toEqual(["bash", "write"]);
  });

  test("skips a torn line instead of wedging the queue", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    appendFileSync(queue.paths.currentPath, '{"tool":"tor\n');
    await queue.append(row("read"));
    const sent: string[] = [];
    await flushOnce(queue, recorder(sent));
    expect(sent).toEqual(["bash", "read"]);
  });

  test("a bare row queued before attempt counts existed is still sent, and dead-lettered whole if rejected", async () => {
    const queue = createAuditQueue(tempDir());
    const legacy = { token: "", step_index: 0, action: "bash", tool: "bash", input: {}, output: "ok" };
    await queue.append(row("read"));
    appendFileSync(queue.paths.currentPath, `${JSON.stringify(legacy)}\n`);
    const sent: unknown[] = [];
    const ship: Ship = async (rows) => {
      sent.push(...rows);
      return { failures: [{ index: 1, error: "invalid row: output must be an object" }] };
    };
    await flushOnce(queue, ship);
    expect(sent).toEqual([row("read"), legacy]);
    const dead = JSON.parse(readFileSync(queue.paths.deadLetterPath, "utf8"));
    expect(dead).toEqual({ attempts: 1, row: legacy, error: "invalid row: output must be an object" });
  });

  test("a fresh lock held by another process defers the flush", async () => {
    const dir = tempDir();
    const queue = createAuditQueue(dir);
    await queue.append(row("bash"));
    writeFileSync(path.join(dir, "audit", "flush.lock"), "");
    expect(await flushOnce(queue, recorder([]))).toEqual({ kind: "locked" });
  });

  test("dead-letters a row the backend rejects as invalid and resends a row that timed out", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    await queue.append(row("edit"));
    await queue.append(row("read"));
    const sent: string[] = [];
    const first = recorder(sent, () => [
      { index: 1, error: "invalid row: output must be an object" },
      { index: 2, error: "audit row 2 timed out after 5000ms" },
    ]);

    expect(await flushOnce(queue, first)).toEqual({
      kind: "shipped",
      written: 1,
      retried: 1,
      deadLettered: [{ tool: "edit", error: "invalid row: output must be an object" }],
    });
    expect(await flushOnce(queue, recorder(sent))).toEqual(shipped(1));
    expect(await flushOnce(queue, recorder(sent))).toEqual({ kind: "idle" });
    expect(sent).toEqual(["bash", "edit", "read", "read"]);
    const dead = readFileSync(queue.paths.deadLetterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(dead).toEqual([{ attempts: 1, row: row("edit"), error: "invalid row: output must be an object" }]);
  });

  test("dead-letters a row that keeps failing once it reaches the attempt limit", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    const failing = recorder([], () => [{ index: 0, error: "connection reset" }]);
    for (let n = 1; n < MAX_ATTEMPTS; n += 1) {
      expect(await flushOnce(queue, failing)).toEqual({ kind: "shipped", written: 0, retried: 1, deadLettered: [] });
    }
    expect(await flushOnce(queue, failing)).toEqual({
      kind: "shipped",
      written: 0,
      retried: 0,
      deadLettered: [{ tool: "bash", error: "connection reset" }],
    });
    expect(await flushOnce(queue, failing)).toEqual({ kind: "idle" });
    const dead = JSON.parse(readFileSync(queue.paths.deadLetterPath, "utf8"));
    expect(dead.attempts).toBe(MAX_ATTEMPTS);
  });
});
