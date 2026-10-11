import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainObject } from "./matcher.ts";

// Payload for POST /iap/audit/batch, field for field what armorCodex sends.
export interface AuditRow {
  token: string;
  step_index: number;
  action: string;
  tool: string;
  input: unknown;
  output: unknown;
  status: "success" | "failed";
  error_message?: string;
  executed_at: string;
  duration_ms: number;
}

export interface AuditBatch {
  rows: AuditRow[];
  startOffset: number;
  endOffset: number;
}

const ROTATE_BYTES = 1024 * 1024;
const KEEP_ARCHIVES = 3;
const STALE_LOCK_MS = 60_000;

function errorCode(error: unknown): unknown {
  return isPlainObject(error) ? error.code : undefined;
}

// Append-only JSONL plus a shipped-byte offset. Rows survive a crash between
// the append and the backend ack because the offset only moves after a 2xx.
export function createAuditQueue(dataDir: string) {
  const dir = path.join(dataDir, "audit");
  const currentPath = path.join(dir, "current.jsonl");
  const offsetPath = path.join(dir, "shipped.offset");
  const lockPath = path.join(dir, "flush.lock");
  const archiveDir = path.join(dir, "archive");
  let appendChain: Promise<void> = Promise.resolve();

  async function readOffset(): Promise<number> {
    try {
      const value = Number.parseInt((await readFile(offsetPath, "utf8")).trim(), 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
  }

  async function writeOffset(offset: number): Promise<void> {
    const tmp = `${offsetPath}.tmp.${process.pid}`;
    await writeFile(tmp, String(offset), "utf8");
    await rename(tmp, offsetPath);
  }

  function append(row: AuditRow): Promise<void> {
    const next = appendChain.then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(currentPath, `${JSON.stringify(row)}\n`, "utf8");
    });
    appendChain = next.catch(() => {});
    return next;
  }

  async function readBatch(maxRows = 100): Promise<AuditBatch> {
    let offset = await readOffset();
    let buffer: Buffer;
    try {
      buffer = await readFile(currentPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { rows: [], startOffset: offset, endOffset: offset };
      throw error;
    }
    // An offset past the end means the file was rotated under a stale offset.
    if (offset > buffer.length) offset = 0;
    const rows: AuditRow[] = [];
    let position = offset;
    while (rows.length < maxRows) {
      const lineEnd = buffer.indexOf(0x0a, position);
      if (lineEnd === -1) break;
      const line = buffer.subarray(position, lineEnd).toString("utf8");
      position = lineEnd + 1;
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A torn line would otherwise wedge the queue forever.
      }
    }
    return { rows, startOffset: offset, endOffset: position };
  }

  async function rotateIfShipped(): Promise<void> {
    const size = (await stat(currentPath)).size;
    if (size < ROTATE_BYTES || (await readOffset()) < size) return;
    await mkdir(archiveDir, { recursive: true });
    await rename(currentPath, path.join(archiveDir, `${Date.now()}.jsonl`));
    await writeOffset(0);
    const archives = (await readdir(archiveDir)).filter((name) => name.endsWith(".jsonl")).sort();
    for (const name of archives.slice(0, -KEEP_ARCHIVES)) await unlink(path.join(archiveDir, name)).catch(() => {});
  }

  async function advance(endOffset: number): Promise<void> {
    await writeOffset(endOffset);
    await rotateIfShipped();
  }

  // Several OpenCode processes can share one data dir; only the lock holder
  // ships, so the same rows are never posted twice concurrently.
  async function withFlushLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
    await mkdir(dir, { recursive: true });
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < STALE_LOCK_MS) return undefined;
      await unlink(lockPath).catch(() => {});
      return withFlushLock(fn);
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  return { append, readBatch, advance, withFlushLock, paths: { currentPath, offsetPath } };
}

export type AuditQueue = ReturnType<typeof createAuditQueue>;

export type FlushResult =
  | { kind: "idle" }
  | { kind: "locked" }
  | { kind: "shipped"; rows: number }
  | { kind: "failed"; error: string };

export async function flushOnce(queue: AuditQueue, ship: (rows: AuditRow[]) => Promise<void>): Promise<FlushResult> {
  const result = await queue.withFlushLock(async (): Promise<FlushResult> => {
    const batch = await queue.readBatch();
    if (batch.rows.length === 0) {
      if (batch.endOffset > batch.startOffset) await queue.advance(batch.endOffset);
      return { kind: "idle" };
    }
    try {
      await ship(batch.rows);
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    await queue.advance(batch.endOffset);
    return { kind: "shipped", rows: batch.rows.length };
  });
  return result ?? { kind: "locked" };
}
