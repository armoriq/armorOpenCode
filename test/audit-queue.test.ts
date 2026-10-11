import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAuditQueue, flushOnce, type AuditRow } from "../src/audit-queue.ts";

function row(tool: string): AuditRow {
  return {
    token: "",
    step_index: 0,
    action: tool,
    tool,
    input: {},
    output: "ok",
    status: "success",
    executed_at: "2026-10-11T00:00:00.000Z",
    duration_ms: 1,
  };
}

const tempDir = () => mkdtempSync(path.join(tmpdir(), "armor-queue-"));

describe("flushOnce", () => {
  test("keeps rows queued after a failed ship and resends the same rows next time", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    await queue.append(row("edit"));
    const attempts: string[][] = [];
    let fail = true;
    const ship = async (rows: AuditRow[]) => {
      attempts.push(rows.map((r) => r.tool));
      if (fail) throw new Error("503 from backend");
    };

    expect(await flushOnce(queue, ship)).toEqual({ kind: "failed", error: "503 from backend" });
    fail = false;
    expect(await flushOnce(queue, ship)).toEqual({ kind: "shipped", rows: 2 });
    expect(await flushOnce(queue, ship)).toEqual({ kind: "idle" });
    expect(attempts).toEqual([
      ["bash", "edit"],
      ["bash", "edit"],
    ]);
  });

  test("ships only rows appended after the last acknowledged batch", async () => {
    const queue = createAuditQueue(tempDir());
    const shipped: string[] = [];
    const ship = async (rows: AuditRow[]) => void shipped.push(...rows.map((r) => r.tool));
    await queue.append(row("bash"));
    await flushOnce(queue, ship);
    await queue.append(row("write"));
    await flushOnce(queue, ship);
    expect(shipped).toEqual(["bash", "write"]);
  });

  test("skips a torn line instead of wedging the queue", async () => {
    const queue = createAuditQueue(tempDir());
    await queue.append(row("bash"));
    appendFileSync(queue.paths.currentPath, '{"tool":"tor\n');
    await queue.append(row("read"));
    const shipped: string[] = [];
    await flushOnce(queue, async (rows) => void shipped.push(...rows.map((r) => r.tool)));
    expect(shipped).toEqual(["bash", "read"]);
  });

  test("a fresh lock held by another process defers the flush", async () => {
    const dir = tempDir();
    const queue = createAuditQueue(dir);
    await queue.append(row("bash"));
    writeFileSync(path.join(dir, "audit", "flush.lock"), "");
    expect(await flushOnce(queue, async () => {})).toEqual({ kind: "locked" });
  });
});
