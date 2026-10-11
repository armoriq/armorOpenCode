import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainObject } from "./matcher.ts";

// One row of POST /iap/audit/batch, in the token-less shape armorClaude uses
// before an intent plan exists. conmap-auto's CreateAuditLogDto requires
// `input` and a non-null `output` to be objects.
export interface AuditRow {
  session_id: string;
  agent_id: string;
  client_id: string;
  user_id?: string;
  user_email?: string;
  step_index: number;
  action: string;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: "success" | "failed";
  error_message?: string;
  executed_at: string;
  duration_ms: number;
}

export interface QueueEntry {
  attempts: number;
  row: AuditRow;
}

export interface AuditBatch {
  entries: QueueEntry[];
  startOffset: number;
  endOffset: number;
}

export interface RowFailure {
  index: number;
  error: string;
}

export type Ship = (rows: AuditRow[]) => Promise<{ failures: RowFailure[] }>;

export const ROTATE_BYTES = 1024 * 1024;
const KEEP_ARCHIVES = 3;
const STALE_LOCK_MS = 60_000;
export const MAX_ATTEMPTS = 10;

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
  const deadLetterPath = path.join(dir, "dead-letter.jsonl");
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

  function appendLines(file: string, lines: unknown[]): Promise<void> {
    const next = appendChain.then(async () => {
      if (lines.length === 0) return;
      await mkdir(dir, { recursive: true });
      await appendFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
    });
    appendChain = next.catch(() => {});
    return next;
  }

  const append = (row: AuditRow) => appendLines(currentPath, [{ attempts: 0, row }]);
  const requeue = (entries: QueueEntry[]) => appendLines(currentPath, entries);
  const deadLetter = (entries: Array<QueueEntry & { error: string }>) => appendLines(deadLetterPath, entries);

  async function readBatch(maxRows = 100): Promise<AuditBatch> {
    let offset = await readOffset();
    let buffer: Buffer;
    try {
      buffer = await readFile(currentPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { entries: [], startOffset: offset, endOffset: offset };
      throw error;
    }
    // An offset past the end means the file was rotated under a stale offset.
    if (offset > buffer.length) offset = 0;
    const entries: QueueEntry[] = [];
    let position = offset;
    while (entries.length < maxRows) {
      const lineEnd = buffer.indexOf(0x0a, position);
      if (lineEnd === -1) break;
      const line = buffer.subarray(position, lineEnd).toString("utf8");
      position = lineEnd + 1;
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A torn line would otherwise wedge the queue forever.
      }
    }
    return { entries, startOffset: offset, endOffset: position };
  }

  async function rotate(): Promise<void> {
    await mkdir(archiveDir, { recursive: true });
    await rename(currentPath, path.join(archiveDir, `${Date.now()}.jsonl`));
    await writeOffset(0);
    const archives = (await readdir(archiveDir)).filter((name) => name.endsWith(".jsonl")).sort();
    for (const name of archives.slice(0, -KEEP_ARCHIVES)) await unlink(path.join(archiveDir, name)).catch(() => {});
  }

  async function currentSize(): Promise<number> {
    try {
      return (await stat(currentPath)).size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
  }

  async function rotateIfShipped(): Promise<void> {
    const size = await currentSize();
    if (size >= ROTATE_BYTES && (await readOffset()) >= size) await rotate();
  }

  // Without an API key nothing ever ships, so the local record is bounded
  // by size instead of by acknowledgement.
  async function rotateIfFull(): Promise<void> {
    if ((await currentSize()) >= ROTATE_BYTES) await rotate();
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

  return {
    append,
    requeue,
    deadLetter,
    readBatch,
    advance,
    rotateIfFull,
    withFlushLock,
    paths: { currentPath, offsetPath, archiveDir, deadLetterPath },
  };
}

export type AuditQueue = ReturnType<typeof createAuditQueue>;

export type FlushResult =
  | { kind: "idle" }
  | { kind: "locked" }
  | { kind: "shipped"; written: number; retried: number; deadLettered: Array<{ tool: string; error: string }> }
  | { kind: "failed"; error: string };

// The backend rejects a row that fails CreateAuditLogDto validation with this
// prefix; resending it can never succeed. Any other per-row failure (a row or
// batch timeout, a DB error) is retried until MAX_ATTEMPTS.
const isPermanent = (error: string) => error.startsWith("invalid row:");

export async function flushOnce(queue: AuditQueue, ship: Ship): Promise<FlushResult> {
  const result = await queue.withFlushLock(async (): Promise<FlushResult> => {
    const batch = await queue.readBatch();
    if (batch.entries.length === 0) {
      if (batch.endOffset > batch.startOffset) await queue.advance(batch.endOffset);
      return { kind: "idle" };
    }
    let failures: RowFailure[];
    try {
      ({ failures } = await ship(batch.entries.map((entry) => entry.row)));
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    const retry: QueueEntry[] = [];
    const dead: Array<QueueEntry & { error: string }> = [];
    for (const { index, error } of failures) {
      const entry = batch.entries[index];
      if (!entry) continue;
      const attempts = entry.attempts + 1;
      if (isPermanent(error) || attempts >= MAX_ATTEMPTS) dead.push({ attempts, row: entry.row, error });
      else retry.push({ attempts, row: entry.row });
    }
    // Both writes land before the offset moves, so a crash here can resend a
    // failed row but never lose one.
    await queue.requeue(retry);
    await queue.deadLetter(dead);
    await queue.advance(batch.endOffset);
    return {
      kind: "shipped",
      written: batch.entries.length - retry.length - dead.length,
      retried: retry.length,
      deadLettered: dead.map((entry) => ({ tool: entry.row.tool, error: entry.error })),
    };
  });
  return result ?? { kind: "locked" };
}
