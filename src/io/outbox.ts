import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Log } from "../types.ts";
import { fallbackAuditRow } from "../core/audit.ts";
import { AUDIT_SIZE_LIMITS, fitRow, jsonBytes, validateSizeLimits, type SizeLimits } from "./audit-size.ts";
import { isAlive, withLock } from "./shared-lock.ts";

export type SendResult<T> =
  | { ok: true; rejected: readonly { item: T; error: string; permanent?: boolean }[] }
  | { ok: false; retryAfterMs?: number; relogin?: boolean };

export interface Outbox<T> {
  enqueue(item: T): void;
  drain(send: (batch: readonly T[]) => Promise<SendResult<T>>, maxBatch: number): Promise<"empty" | "more" | "blocked">;
  // Final write at shutdown. The outbox stops draining and its file becomes adoptable by a
  // later outbox in this same process, once any in-flight drain has settled.
  persist(): Promise<void>;
}

export const MAX_ATTEMPTS = 10;
export const ROTATE_BYTES = 10 * 1024 * 1024;
const COALESCE_MS = 100;
const ADOPT_EVERY_MS = 60_000;
const FILE_NAME = /^(\d+)-[0-9a-f]+\.jsonl$/;

// Files of outboxes this process created, so a later outbox (after a plugin reload) adopts one
// only after it was retired and its last drain finished, never while it is live.
const local = new Map<string, { retired: boolean; settled: () => Promise<void> }>();

type Entry<T> = { id: string; attempts: number; item: T };
type Line<T> = { t: "a"; id: string; n: number; v: T } | { t: "k"; ids: string[] };

function replay<T>(text: string): Entry<T>[] {
  const entries = new Map<string, Entry<T>>();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: Line<T>;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.t === "a") {
      entries.delete(line.id);
      entries.set(line.id, { id: line.id, attempts: line.n, item: line.v });
    } else if (line.t === "k") {
      for (const id of line.ids) entries.delete(id);
    }
  }
  return [...entries.values()];
}

// One file per process (pid + nonce); appends coalesced within 100 ms; orphans adopted under a lock.
// Memory is authoritative while the process lives; the file only exists so another process can adopt it.
export function createOutbox<T>(dir: string, name: string, log: Log): Outbox<T> {
  const root = join(dir, "outbox", name);
  const self = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const file = join(root, `${self}.jsonl`);
  const deadFile = join(root, "dead", `${self}.jsonl`);
  const entries = new Map<string, Entry<T>>();
  let seq = 0;
  let bytes = 0;
  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let draining = false;
  let retired = false;
  let inflight: Promise<unknown> = Promise.resolve();
  let compactAt = ROTATE_BYTES;
  let rewrite = false;
  let lastAdopt = Date.now();
  local.set(`${self}.jsonl`, { retired: false, settled: async () => (await inflight.catch(() => {}), await flush()) });
  let ready = adopt();

  function write(line: Line<T>): void {
    buffer.push(`${JSON.stringify(line)}\n`);
    if (timer) return;
    timer = setTimeout(() => void flush().catch(() => {}), COALESCE_MS);
    timer.unref?.();
  }

  function serial(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task);
    chain = run.catch((error) => log.error("outbox write failed", { outbox: name, error: String(error) }));
    return run;
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (buffer.length === 0 && !rewrite) return chain;
    const data = buffer.join("");
    const size = Buffer.byteLength(data);
    buffer = [];
    return serial(async () => {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (!rewrite && bytes + size <= compactAt) {
          await appendFile(file, data, { mode: 0o600 });
          bytes += size;
          return;
        }
        // Memory already reflects every buffered line, so a snapshot of it replaces the whole log.
        const snapshot = [...entries.values()].map((e) => `${JSON.stringify({ t: "a", id: e.id, n: e.attempts, v: e.item })}\n`).join("");
        await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        rewrite = false;
        bytes = Buffer.byteLength(snapshot);
        // A backlog that alone exceeds the limit would otherwise be rewritten on every flush.
        compactAt = Math.max(ROTATE_BYTES, bytes * 2);
      } catch (error) {
        // The failed lines may be missing or torn on disk; the next flush rewrites the file from memory.
        rewrite = true;
        throw error;
      }
    });
  }

  function isOrphan(fileName: string): boolean {
    const match = FILE_NAME.exec(fileName);
    if (!match || fileName === `${self}.jsonl`) return false;
    const pid = Number(match[1]);
    if (pid !== process.pid) return !isAlive(pid);
    return local.get(fileName)?.retired ?? true;
  }

  async function adopt(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    const orphans = names.filter(isOrphan);
    if (orphans.length === 0) return;
    try {
      await withLock(join(root, ".adopt.lock"), async () => {
        for (const orphan of orphans) {
          const path = join(root, orphan);
          await local.get(orphan)?.settled();
          local.delete(orphan);
          let text: string;
          try {
            text = await readFile(path, "utf8");
          } catch {
            continue;
          }
          for (const entry of replay<T>(text)) {
            if (entries.has(entry.id)) continue;
            entries.set(entry.id, entry);
            write({ t: "a", id: entry.id, n: entry.attempts, v: entry.item });
          }
          await flush();
          await unlink(path).catch(() => {});
          log.info("outbox adopted", { outbox: name, from: orphan });
        }
      });
    } catch (error) {
      log.warn("outbox adoption failed", { outbox: name, error: String(error) });
    }
  }

  function deadLetter(entry: Entry<T>, error: string): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), attempts: entry.attempts, error, item: entry.item })}\n`;
    void serial(async () => {
      await mkdir(join(root, "dead"), { recursive: true, mode: 0o700 });
      await appendFile(deadFile, line, { mode: 0o600 });
    }).catch(() => {});
    log.warn("outbox row dead-lettered", { outbox: name, file: deadFile, error, attempts: entry.attempts });
  }

  return {
    enqueue(item) {
      const id = `${self}.${seq++}`;
      entries.set(id, { id, attempts: 0, item });
      write({ t: "a", id, n: 0, v: item });
    },

    drain(send, maxBatch) {
      if (draining || retired) return Promise.resolve("empty");
      draining = true;
      const run = drainOnce(send, maxBatch).finally(() => {
        draining = false;
      });
      inflight = run;
      return run;
    },

    persist() {
      retired = true;
      const entry = local.get(`${self}.jsonl`);
      if (entry) entry.retired = true;
      // A send in flight may already be stored by the backend; without its ack on disk the next
      // process adopts this file and uploads those rows again.
      return flush()
        .then(() => inflight.catch(() => {}))
        .then(() => flush())
        .catch(() => {});
    },
  };

  async function drainOnce(
    send: (batch: readonly T[]) => Promise<SendResult<T>>,
    maxBatch: number,
  ): Promise<"empty" | "more" | "blocked"> {
    await ready;
    if (Date.now() - lastAdopt > ADOPT_EVERY_MS) {
      lastAdopt = Date.now();
      ready = adopt();
      await ready;
    }
    const batch = oldest(maxBatch);
    if (batch.length === 0) return "empty";
    const hadMore = entries.size > batch.length;
    const result = await send(batch.map((e) => e.item));
    if (!result.ok) return "blocked";
    settle(batch, result.rejected);
    if (retired) await flush();
    return hadMore ? "more" : "empty";
  }

  function oldest(max: number): Entry<T>[] {
    const batch: Entry<T>[] = [];
    for (const entry of entries.values()) {
      if (batch.length >= max) break;
      batch.push(entry);
    }
    return batch;
  }

  function settle(batch: Entry<T>[], rejected: Extract<SendResult<T>, { ok: true }>["rejected"]): void {
    const byItem = new Map(batch.map((e) => [e.item, e]));
    const retried = new Set<string>();
    for (const { item, error, permanent } of rejected) {
      const entry = byItem.get(item);
      if (entry && retry(entry, error, permanent === true)) retried.add(entry.id);
    }
    const acked = batch.filter((e) => !retried.has(e.id)).map((e) => e.id);
    for (const id of acked) entries.delete(id);
    if (acked.length > 0) write({ t: "k", ids: acked });
  }

  // Returns false when the entry was dead-lettered instead, which acks it like a sent row.
  function retry(entry: Entry<T>, error: string, permanent: boolean): boolean {
    entry.attempts += 1;
    if (permanent || entry.attempts >= MAX_ATTEMPTS) {
      deadLetter(entry, error);
      return false;
    }
    entries.delete(entry.id);
    entries.set(entry.id, entry);
    write({ t: "a", id: entry.id, n: entry.attempts, v: entry.item });
    return true;
  }
}

// Durable outbox v1.1. It lands beside the released queue first; the pumps move over in the next change.
export type QueueLogin = { backend: string; keyId: string; available?: boolean };
export type CaptureOptions = { fallback?: boolean; loggedOut?: boolean; binding?: QueueLogin | null };
export type SendResultV1<T> =
  | { ok: true; rejected: readonly { item: T; error: string; permanent?: boolean; transient?: boolean }[]; retryAfterMs?: number }
  | { ok: false; retryAfterMs?: number; relogin?: boolean; legacyRefusal?: boolean; deferred?: boolean; nonTransient?: boolean; tooLarge?: boolean; reason?: string };

export type PendingRow<T> = { id: string; row: T; attempts: number; nextAttemptAt: number; retries?: number };
export type DeadLetter<T> = { row: T; attempts: number; reason: string };
export type OutboxStatus = { pending: number; undeliverable: number; deadLetters: number; captureFailures: number; legacyPending?: number; corruptRecords?: number };
type Sender<T> = (batch: readonly T[], login: QueueLogin) => Promise<SendResultV1<T>>;
type DrainOptions = { probe?: ((login: QueueLogin) => Promise<boolean>) | undefined };
export interface OutboxV1<T> {
  enqueue(item: T, options?: CaptureOptions): void;
  drain(send: Sender<T>, maxBatch?: number, options?: DrainOptions): Promise<"empty" | "more" | "blocked">;
  prepare(): void;
  restoreLogin(login: QueueLogin | null): Promise<void>;
  authenticationSucceeded(login: QueueLogin | null): Promise<void>;
  captureFailure(): void;
  readPending(): PendingRow<T>[];
  readDeadLetters(): DeadLetter<T>[];
  status(): OutboxStatus;
  diagnostics(): { replays: number; leases: number };
  // Final write at shutdown. The outbox stops draining and its file becomes adoptable by a
  // later outbox in this same process, once any in-flight drain has settled.
  persist(): Promise<void>;
}

export class CaptureError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : "audit capture failed", { cause }); }
}

export const MAX_ATTEMPTS_V1 = 10;
export const ROTATE_BYTES_V1 = 10 * 1024 * 1024;
const COALESCE_MS_V1 = 100;
const FILE_NAME_V1 = /^queue-(\d+)-[0-9a-f]+\.jsonl$/;
const RELEASED_FILE = /^\d+-[0-9a-f]+\.jsonl$/;
// An open descriptor must never be archived, including one owned by another handle in this process.
const localWriters = new Set<string>();
type CommitPoint = "append" | "ack" | "deadLetter";
type Options = {
  login: () => QueueLogin | null;
  probeLogin?: () => QueueLogin | null;
  clock?: { now: () => number; random: () => number };
  timing?: { baseMs: number; maxMs: number; lockTtlMs: number; authProbeMs?: number };
  sizeLimits?: SizeLimits;
  beforeCommit?: (point: CommitPoint) => void;
};
type EntryV1<T> = PendingRow<T>;
type Settlement<T> = { t: "s"; ack: string[]; retry: EntryV1<T>[]; dead: (DeadLetter<T> & { id: string })[]; batchLimit?: number };
type LineV1<T> = { t: "b"; login: QueueLogin } | { t: "a"; entry: EntryV1<T> } | Settlement<T> | { t: "d"; id: string; value: DeadLetter<T> };
type State<T> = { binding: QueueLogin | null; pending: Map<string, EntryV1<T>>; dead: Map<string, DeadLetter<T>>; known: Set<string>; batchLimit: number };
type Writer = { file: string; fd: number; known: Set<string>; dirty: boolean; compactAt: number; tainted: boolean };
type Lease = { generation: string; expiresAt: number };
type Auth = { paused: boolean; nextProbeAt: number };
const bindingKey = (login: QueueLogin) => JSON.stringify([login.backend, login.keyId]);
const identified = (login: QueueLogin | null): login is QueueLogin => !!login && typeof login.backend === "string" && !!login.backend && typeof login.keyId === "string" && !!login.keyId;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const entryValid = (value: any) => object(value) && typeof value.id === "string" && !!value.id && object(value.row) &&
  Number.isSafeInteger(value.attempts) && value.attempts >= 0 && Number.isFinite(value.nextAttemptAt) &&
  (value.retries === undefined || (Number.isSafeInteger(value.retries) && value.retries >= 0));
const deadValid = (value: any) => object(value) && object(value.row) && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && typeof value.reason === "string";

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Replacements publish a complete file. A partial last append is quarantined on replay.
function replaceFile(file: string, data: string | Buffer, directory: string): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(directory);
}

// Each process appends to its open file. Delivery keeps that file and its immutable login binding.
// A settlement is one journal transaction containing both pending removal and any dead letters.
export function createOutboxV1<T>(dir: string, name: string, log: Log, options: Options): OutboxV1<T> {
  // Released readers scan outbox/<name>. Neither this directory nor its file names match them.
  const root = join(dir, "outbox", `${name}-v2`);
  const releasedRoot = join(dir, "outbox", name);
  const deadRoot = join(root, "dead");
  const archiveRoot = join(root, "archive");
  const corruptRoot = join(root, "corrupt");
  const historyRoot = join(root, "history");
  const instance = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const failureFile = join(root, `failures-${instance}.json`);
  const clock = options.clock ?? { now: Date.now, random: Math.random };
  const timing = { baseMs: 5_000, maxMs: 600_000, lockTtlMs: 60_000, authProbeMs: 120_000, ...options.timing };
  const limits = validateSizeLimits(options.sizeLimits ?? AUDIT_SIZE_LIMITS);
  const writers = new Map<string, Writer>();
  const cache = new Map<string, { stamp: string; state: State<T> }>();
  const smallCache = new Map<string, { stamp: string; value: any }>();
  const sidecars = new Map<string, { stamp: string; ids: Set<string> }>();
  const unsavedCorrupt = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<unknown> | null = null;
  let retired = false;
  let failureDirty = false;
  let failures = 0;
  let closed = false;
  let syncParents = true;
  let syncFailures = 0;
  let compacting: Promise<void> = Promise.resolve();
  const metrics = { replays: 0, leases: 0 };

  function ensureDirectories(): void {
    for (const folder of [deadRoot, archiveRoot, corruptRoot, historyRoot]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  }

  function names(folder: string): string[] {
    try { return readdirSync(folder).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error("audit directory could not be read"); return []; }
  }
  const files = (folder = root) => names(folder).filter(file => FILE_NAME_V1.test(file)).map(file => join(folder, file));
  const stamp = (file: string) => { const info = statSync(file); return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; };

  function quarantine(file: string, offset: number, raw: Buffer): void {
    const id = digest(Buffer.concat([Buffer.from(`${basename(file)}:${offset}:`), raw]));
    const target = join(corruptRoot, `${id}.raw`);
    try {
      mkdirSync(corruptRoot, { recursive: true, mode: 0o700 });
      if (!names(corruptRoot).includes(`${id}.raw`)) {
        replaceFile(target, raw, corruptRoot);
      }
      unsavedCorrupt.delete(id);
    } catch (error) {
      if (!unsavedCorrupt.has(id)) log.error("audit corruption could not be saved");
      unsavedCorrupt.add(id);
    }
  }

  function replay(file: string): State<T> {
    const empty = (): State<T> => ({ binding: null, pending: new Map(), dead: new Map(), known: new Set(), batchLimit: limits.maxBatchRows });
    let key: string;
    let bytes: Buffer;
    try {
      key = stamp(file);
      const previous = cache.get(file);
      if (previous?.stamp === key) return previous.state;
      bytes = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        quarantine(file, -1, Buffer.from(JSON.stringify({ file: basename(file), error: (error as NodeJS.ErrnoException).code ?? "unreadable" })));
        log.error("audit queue could not be read");
      }
      return empty();
    }
    metrics.replays++;
    const state = empty();
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const raw = bytes.subarray(offset, end < 0 ? bytes.length : end);
      try {
        if (end < 0) throw new Error("partial audit queue line");
        if (raw.length) {
          const line = JSON.parse(raw.toString("utf8"));
          if (!object(line)) throw new Error("invalid audit queue record");
          if (line.t === "b" && !state.binding && identified(line.login)) {
            state.binding = { backend: line.login.backend, keyId: line.login.keyId };
          } else if (line.t === "a" && entryValid(line.entry)) {
            if (!state.known.has(line.entry.id)) state.pending.set(line.entry.id, line.entry);
            state.known.add(line.entry.id);
          } else if (line.t === "d" && typeof line.id === "string" && deadValid(line.value)) {
            state.known.add(line.id); state.pending.delete(line.id); state.dead.set(line.id, line.value);
          } else if (line.t === "s" && Array.isArray(line.ack) && line.ack.every((id: any) => typeof id === "string") &&
              Array.isArray(line.retry) && line.retry.every(entryValid) && Array.isArray(line.dead) &&
              line.dead.every((letter: any) => typeof letter?.id === "string" && deadValid(letter)) &&
              (line.batchLimit === undefined || (Number.isSafeInteger(line.batchLimit) && line.batchLimit > 0))) {
            for (const entry of line.retry) if (state.pending.has(entry.id)) state.pending.set(entry.id, entry);
            for (const id of line.ack) state.pending.delete(id);
            for (const { id, ...letter } of line.dead) { state.pending.delete(id); state.dead.set(id, letter as DeadLetter<T>); }
            if (line.batchLimit !== undefined) state.batchLimit = line.batchLimit;
          } else throw new Error("invalid audit queue record");
        }
      } catch { quarantine(file, offset, raw); }
      if (end < 0) break;
      offset = end + 1;
    }
    cache.set(file, { stamp: key, state });
    return state;
  }

  function readSmall(file: string, missing: any): any {
    try {
      const key = stamp(file);
      const cached = smallCache.get(file);
      if (cached?.stamp === key) return cached.value;
      const raw = readFileSync(file);
      let value;
      try { value = JSON.parse(raw.toString("utf8")); }
      catch { quarantine(file, 0, raw); value = missing; }
      smallCache.set(file, { stamp: key, value });
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error("audit metadata could not be read"); return missing; }
  }

  const authFile = (login: QueueLogin) => join(root, `auth-${digest(bindingKey(login))}.json`);
  const auth = (login: QueueLogin): Auth => {
    const file = authFile(login);
    const value = readSmall(file, { paused: false, nextProbeAt: 0 });
    if (object(value) && typeof value.paused === "boolean" && Number.isFinite(value.nextProbeAt)) return value as Auth;
    try { quarantine(file, 0, readFileSync(file)); } catch { log.error("audit authentication state could not be read"); }
    return { paused: true, nextProbeAt: 0 };
  };
  const available = (binding: QueueLogin | null) => {
    const login = options.login();
    return identified(login) && login.available !== false && binding !== null && bindingKey(login) === bindingKey(binding);
  };
  const canSend = (state: State<T>) => available(state.binding) && !auth(state.binding!).paused;

  async function authenticationSucceeded(login: QueueLogin | null): Promise<void> {
    if (!identified(login) || !auth(login).paused) return;
    const target = authFile(login);
    await withLock(`${target}.guard`, async () => {
      replaceFile(target, JSON.stringify({ paused: false, nextProbeAt: 0 }), root);
      smallCache.delete(target);
    });
  }

  async function pause(login: QueueLogin): Promise<void> {
    const target = authFile(login);
    await withLock(`${target}.guard`, async () => {
      replaceFile(target, JSON.stringify({ paused: true, nextProbeAt: clock.now() + timing.authProbeMs }), root);
      smallCache.delete(target);
    });
  }

  async function probePaused(probe: DrainOptions["probe"]): Promise<void> {
    const login = options.probeLogin ? options.probeLogin() : options.login();
    if (!probe || !identified(login) || login.available === false || !auth(login).paused || auth(login).nextProbeAt > clock.now()) return;
    const target = authFile(login);
    const eligible = await withLock(`${target}.guard`, async () => {
      if (!auth(login).paused || auth(login).nextProbeAt > clock.now()) return false;
      // Publish the next probe before network work so crashes and competing drainers cannot probe in a loop.
      replaceFile(target, JSON.stringify({ paused: true, nextProbeAt: clock.now() + timing.authProbeMs }), root);
      smallCache.delete(target);
      return true;
    });
    if (!eligible) return;
    try { if (await probe(login)) await authenticationSucceeded(login); } catch { /* The persisted pause and probe deadline stand. */ }
  }

  function scheduleSync(delay = COALESCE_MS_V1): void {
    if (timer || closed || retired) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        sync();
        compacting = compacting.then(compact).then(() => { syncFailures = 0; }).catch(retrySync);
      } catch { retrySync(); }
    }, delay);
    timer.unref?.();
  }
  function retrySync(): void {
    log.error("audit storage sync failed");
    syncFailures++;
    scheduleSync(Math.min(60_000, COALESCE_MS_V1 * 2 ** Math.min(syncFailures, 10)));
  }

  function writeLine(fd: number, line: unknown): void {
    const data = `${JSON.stringify(line)}\n`;
    if (writeSync(fd, data, undefined, "utf8") !== Buffer.byteLength(data)) throw new Error("incomplete audit queue append");
  }

  function separateAppend(file: string, fd: number): void {
    const size = statSync(file).size;
    if (!size) return;
    const reader = openSync(file, "r");
    const last = Buffer.alloc(1);
    try { readSync(reader, last, 0, 1, size - 1); } finally { closeSync(reader); }
    if (last[0] !== 10 && writeSync(fd, "\n") !== 1) throw new Error("incomplete audit queue separator");
  }

  function newWriter(login: QueueLogin): Writer {
    ensureDirectories();
    const file = join(root, `queue-${process.pid}-${randomBytes(6).toString("hex")}.jsonl`);
    const fd = openSync(file, "ax", 0o600);
    try { writeLine(fd, { t: "b", login: { backend: login.backend, keyId: login.keyId } }); }
    catch (error) { closeSync(fd); throw error; }
    const writer = { file, fd, known: new Set<string>(), dirty: true, compactAt: ROTATE_BYTES_V1, tainted: false };
    writers.set(bindingKey(login), writer);
    localWriters.add(file);
    scheduleSync();
    return writer;
  }

  function prepare(): void {
    const login = options.login();
    if (retired || !identified(login)) return;
    if (!writers.has(bindingKey(login))) newWriter(login);
  }

  function materializeDead(file: string, state: State<T>): void {
    if (!state.dead.size) return;
    mkdirSync(deadRoot, { recursive: true, mode: 0o700 });
    const target = join(deadRoot, basename(file));
    let key = "";
    try { key = stamp(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cached = sidecars.get(target);
    let known = cached?.stamp === key ? cached.ids : undefined;
    if (!known) {
      known = new Set();
      try {
        for (const raw of readFileSync(target, "utf8").split("\n")) {
          try { const line = JSON.parse(raw); if (typeof line.id === "string") known.add(line.id); } catch {}
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const missing = [...state.dead].filter(([id]) => !known!.has(id));
    if (!missing.length) return;
    const fd = openSync(target, "a", 0o600);
    try {
      // A separator also keeps an interrupted sidecar append from swallowing the next complete row.
      separateAppend(target, fd);
      for (const [id, letter] of missing) writeLine(fd, { id, ...letter });
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(deadRoot);
    for (const [id] of missing) known.add(id);
    sidecars.set(target, { stamp: stamp(target), ids: known });
  }

  function sync(): void {
    ensureDirectories();
    for (const writer of writers.values()) {
      if (!writer.dirty) continue;
      fsyncSync(writer.fd);
      materializeDead(writer.file, replay(writer.file));
      writer.dirty = false;
    }
    if (failureDirty) {
      replaceFile(failureFile, JSON.stringify({ count: failures }), root);
      failureDirty = false;
    }
    syncDirectory(root);
    if (syncParents) {
      syncDirectory(join(dir, "outbox"));
      syncDirectory(dir);
      syncDirectory(dirname(dir));
      syncParents = false;
    }
  }

  function captureFailure(): void {
    failures++;
    failureDirty = true;
    try {
      ensureDirectories();
      replaceFile(failureFile, JSON.stringify({ count: failures }), root);
      failureDirty = false;
    } catch { log.error("audit capture failure count could not be saved"); }
    scheduleSync();
  }

  async function compact(): Promise<void> {
    for (const writer of writers.values()) {
      if (closed || writer.tainted || statSync(writer.file).size <= writer.compactAt) continue;
      await withLock(`${writer.file}.guard`, async () => {
        if (closed) return;
        const state = replay(writer.file);
        const lines: LineV1<T>[] = [{ t: "b", login: state.binding! }];
        for (const entry of state.pending.values()) lines.push({ t: "a", entry });
        for (const [id, value] of state.dead) lines.push({ t: "d", id, value });
        if (state.batchLimit !== limits.maxBatchRows) lines.push({ t: "s", ack: [], retry: [], dead: [], batchLimit: state.batchLimit });
        const data = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
        // Preserve the complete earlier journal, including settled envelopes, before replacing it.
        const history = join(historyRoot, `${basename(writer.file)}.${randomBytes(6).toString("hex")}.jsonl`);
        copyFileSync(writer.file, history);
        const historyFd = openSync(history, "r");
        try { fsyncSync(historyFd); } finally { closeSync(historyFd); }
        syncDirectory(historyRoot);
        // The writer and its descriptor change in one synchronous turn under the settlement guard.
        // A concurrent append cannot land between this snapshot and the replacement.
        replaceFile(writer.file, data, root);
        const next = openSync(writer.file, "a");
        closeSync(writer.fd);
        writer.fd = next;
        writer.dirty = false;
        cache.delete(writer.file);
        // A backlog that alone exceeds the limit would otherwise be rewritten on every flush.
        writer.compactAt = Math.max(ROTATE_BYTES_V1, Buffer.byteLength(data) * 2);
      });
    }
  }

  function enqueue(item: T, capture: CaptureOptions = {}): void {
    if (capture.loggedOut) return;
    try {
      if (retired) throw new Error("audit queue is closed");
      const login = capture.binding === undefined ? options.login() : capture.binding;
      if (!identified(login)) { captureFailure(); return; }
      let writer = writers.get(bindingKey(login));
      if (!writer) throw new Error("audit queue login is not prepared");
      if (writer.tainted) {
        fsyncSync(writer.fd);
        closeSync(writer.fd);
        localWriters.delete(writer.file);
        const known = writer.known;
        writer = newWriter(login);
        writer.known = known;
      }
      const value = item as Record<string, unknown>;
      const id = typeof value.client_row_id === "string" ? value.client_row_id : typeof value.id === "string" ? value.id : "";
      if (!id) throw new Error("audit row has no action identity");
      if (writer.known.has(id)) return;
      const original = capture.fallback ? fallbackAuditRow(id, typeof value.session_id === "string" ? value.session_id : undefined, Date.parse(String(value.executed_at)), value.decision_code as never) as T : item;
      const fitted = fitRow(original, limits);
      const line: LineV1<T> = fitted.oversize
        ? { t: "d", id, value: { row: fitted.item, attempts: 0, reason: "oversize" } }
        : { t: "a", entry: { id, row: fitted.item, attempts: 0, nextAttemptAt: 0, retries: 0 } };
      try {
        options.beforeCommit?.("append");
        writeLine(writer.fd, line);
      } catch (error) { writer.tainted = true; writer.dirty = true; cache.delete(writer.file); throw error; }
      cache.delete(writer.file);
      writer.known.add(id);
      writer.dirty = true;
      scheduleSync();
    } catch (error) { captureFailure(); throw new CaptureError(error); }
  }

  async function lease(file: string): Promise<Lease | null> {
    return withLock(`${file}.guard`, async () => {
      const previous = readLease(file);
      if (previous && previous.expiresAt > clock.now()) return null;
      const next = { generation: randomBytes(16).toString("hex"), expiresAt: clock.now() + timing.lockTtlMs };
      replaceFile(`${file}.lease`, JSON.stringify(next), root);
      metrics.leases++;
      return next;
    });
  }

  function readLease(file: string): Lease | null {
    return readSmall(`${file}.lease`, null);
  }
  const owned = (file: string, owner: Lease) => {
    const current = readLease(file);
    return current?.generation === owner.generation && current.expiresAt > clock.now();
  };

  async function renew(file: string, owner: Lease): Promise<boolean> {
    return withLock(`${file}.guard`, async () => {
      if (!owned(file, owner)) return false;
      owner.expiresAt = clock.now() + timing.lockTtlMs;
      replaceFile(`${file}.lease`, JSON.stringify(owner), root);
      smallCache.delete(`${file}.lease`);
      return true;
    });
  }

  async function release(file: string, owner: Lease): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (readLease(file)?.generation === owner.generation) {
        unlinkSync(`${file}.lease`); smallCache.delete(`${file}.lease`); syncDirectory(root);
      }
    });
  }

  async function settle(file: string, owner: Lease, batch: EntryV1<T>[], result: SendResultV1<T>): Promise<void> {
    await withLock(`${file}.guard`, async () => {
      if (!owned(file, owner)) return;
      const change: Settlement<T> = { t: "s", ack: [], retry: [], dead: [] };
      if (!result.ok && result.relogin) await pause(replay(file).binding!);
      else {
        const rejects = result.ok ? new Map(result.rejected.map(r => [r.item, r])) : null;
        for (const entry of batch) {
          const rejected = rejects?.get(entry.row);
          if (result.ok && !rejected) { change.ack.push(entry.id); continue; }
          const charged = rejected ? rejected.permanent || !rejected.transient : !result.ok && result.nonTransient;
          const attempts = entry.attempts + (charged ? 1 : 0);
          const retries = (entry.retries ?? 0) + 1;
          const reason = rejected?.error ?? (!result.ok ? result.reason : undefined) ?? "audit delivery not confirmed";
          if (rejected?.permanent || attempts >= MAX_ATTEMPTS_V1) {
            change.dead.push({ id: entry.id, row: entry.row, attempts, reason });
          } else {
            const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** Math.min(retries - 1, 30));
            const delay = ceiling / 2 + clock.random() * ceiling / 2;
            change.retry.push({ ...entry, attempts, retries, nextAttemptAt: clock.now() + Math.max(delay, result.retryAfterMs ?? 0) });
          }
        }
        // 413 is not a bisection probe. Reduce the following request while retaining R9's refusal count.
        if (!result.ok && result.tooLarge && batch.length > 1) change.batchLimit = Math.max(1, Math.floor(batch.length / 2));
      }
      options.beforeCommit?.(change.dead.length ? "deadLetter" : "ack");
      // The sidecar is prepared first; only the journal commits its visibility and pending removal.
      // A crash before the journal commit replays pending, and the uncommitted sidecar is ignored.
      if (change.dead.length) {
        const current = replay(file);
        const state = { ...current, dead: new Map(current.dead) };
        for (const { id, ...letter } of change.dead) state.dead.set(id, letter);
        materializeDead(file, state);
      }
      const fd = openSync(file, "a", 0o600);
      try {
        separateAppend(file, fd);
        writeLine(fd, change); fsyncSync(fd);
      } finally { closeSync(fd); cache.delete(file); }
      for (const letter of change.dead) log.warn("outbox row dead-lettered", { outbox: name, attempts: letter.attempts, reason: letter.reason });
    });
  }

  async function deliver(file: string, owner: Lease, batch: EntryV1<T>[], send: Sender<T>, binding: QueueLogin): Promise<void> {
    if (!canSend(replay(file)) || !await renew(file, owner)) return;
    const outbound = batch.map(entry => structuredClone(entry.row));
    let result: SendResultV1<T>;
    try { result = await send(outbound, binding); }
    catch { result = { ok: false, reason: "audit network failure" }; }
    if (!owned(file, owner)) return;
    if (!result.ok && result.deferred) return;
    if (!result.ok && result.legacyRefusal && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      await deliver(file, owner, batch.slice(0, middle), send, binding);
      await deliver(file, owner, batch.slice(middle), send, binding);
      return;
    }
    if (!result.ok && result.legacyRefusal) result = { ok: true, rejected: [{ item: outbound[0]!, error: result.reason ?? "legacy row rejected", permanent: true }] };
    // The sender receives copies. Settlement uses the stored envelope even if it mutates those copies.
    if (result.ok) {
      if (result.rejected.some(rejected => !outbound.includes(rejected.item))) result = { ok: false, reason: "invalid audit sender outcome" };
      else {
        result = { ...result, rejected: result.rejected.map(rejected => ({ ...rejected, item: batch[outbound.indexOf(rejected.item)]!.row })) };
        await authenticationSucceeded(binding);
      }
    }
    await settle(file, owner, batch, result);
  }

  async function archive(file: string): Promise<void> {
    try { statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const pid = Number(FILE_NAME_V1.exec(basename(file))?.[1]);
    if (localWriters.has(file) || (pid !== process.pid && isAlive(pid))) return;
    if (replay(file).pending.size) return;
    await withLock(`${file}.guard`, async () => {
      try { statSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const owner = readLease(file);
      if ((owner && owner.expiresAt > clock.now()) || replay(file).pending.size) return;
      const target = join(archiveRoot, basename(file));
      renameSync(file, target);
      const cached = cache.get(file);
      if (cached) cache.set(target, { stamp: stamp(target), state: cached.state });
      cache.delete(file);
      syncDirectory(archiveRoot);
      syncDirectory(root);
    });
  }

  async function drainOnce(send: Sender<T>, maxBatch: number, singleBatch: boolean, controls: DrainOptions): Promise<"empty" | "more" | "blocked"> {
    await probePaused(controls.probe);
    let blocked = false;
    queues: for (const file of files()) {
      let state = replay(file);
      if (!state.pending.size) { await archive(file); continue; }
      if (!canSend(state) || ![...state.pending.values()].some(entry => entry.nextAttemptAt <= clock.now())) continue;
      const owner = await lease(file);
      if (!owner) continue;
      try {
        state = replay(file);
        if (!canSend(state)) continue;
        const eligible = [...state.pending.values()].filter(entry => entry.nextAttemptAt <= clock.now());
        for (let offset = 0; offset < eligible.length;) {
          const batch: EntryV1<T>[] = [];
          let bytes = 11; // The complete {"rows":[]} envelope, plus commas between rows.
          while (offset < eligible.length && batch.length < Math.min(maxBatch, limits.maxBatchRows, state.batchLimit)) {
            const entry = eligible[offset]!;
            const next = jsonBytes(entry.row) + (batch.length ? 1 : 0);
            if (bytes + next > limits.maxBatchBytes) break;
            batch.push(entry); bytes += next; offset++;
          }
          if (!batch.length || !owned(file, owner)) break;
          await deliver(file, owner, batch, send, state.binding!);
          state = replay(file);
          if (batch.some(entry => state.pending.has(entry.id))) blocked = true;
          if (singleBatch) break queues;
          if (!canSend(state)) break;
        }
      } finally { await release(file, owner); }
      await archive(file);
    }
    const states = files().map(replay);
    if (blocked && states.some(state => state.pending.size)) return "blocked";
    if (states.some(state => canSend(state) && [...state.pending.values()].some(entry => entry.nextAttemptAt <= clock.now()))) return "more";
    return states.some(state => state.pending.size) ? "blocked" : "empty";
  }

  function readPending(): PendingRow<T>[] { return files().flatMap(file => [...replay(file).pending.values()]); }
  function readDeadLetters(): DeadLetter<T>[] { return [...files(), ...files(archiveRoot)].flatMap(file => [...replay(file).dead.values()]); }

  function releasedStatus(): { pending: number; dead: number } {
    // Released rows have no provable login binding. These reads are for counts only, never delivery.
    const pending = new Set<string>();
    for (const name of names(releasedRoot).filter(file => RELEASED_FILE.test(file))) {
      const file = join(releasedRoot, name);
      try {
        const rows = new Set<string>();
        for (const raw of readFileSync(file, "utf8").split("\n")) {
          try {
            const line = JSON.parse(raw);
            if (line.t === "a" && typeof line.id === "string") rows.add(line.id);
            else if (line.t === "k" && Array.isArray(line.ids)) for (const id of line.ids) rows.delete(id);
          } catch {}
        }
        for (const id of rows) pending.add(id);
      } catch { log.error("released audit queue could not be counted"); }
    }
    let dead = 0;
    const oldDead = join(releasedRoot, "dead");
    for (const name of names(oldDead).filter(file => RELEASED_FILE.test(file))) {
      try { for (const raw of readFileSync(join(oldDead, name), "utf8").split("\n")) { try { if (object(JSON.parse(raw))) dead++; } catch {} } }
      catch { log.error("released audit dead letters could not be counted"); }
    }
    return { pending: pending.size, dead };
  }

  // Local storage cannot disable the guard during host setup. Capture still reports its own failure.
  try { prepare(); } catch { log.error("audit storage initialization failed"); }
  return {
    enqueue, prepare, captureFailure, readPending, readDeadLetters, authenticationSucceeded,
    restoreLogin: authenticationSucceeded,
    diagnostics: () => ({ ...metrics }),
    status() {
      const states = files().map(replay);
      const legacy = releasedStatus();
      let captureFailures = failures;
      for (const name of names(root).filter(file => /^failures-.*\.json$/.test(file))) {
        if (join(root, name) === failureFile) continue;
        const value = readSmall(join(root, name), { count: 0 });
        if (object(value) && Number.isSafeInteger(value.count) && value.count > 0) captureFailures += value.count;
      }
      return {
        pending: legacy.pending + states.reduce((n, s) => n + s.pending.size, 0),
        undeliverable: legacy.pending + states.reduce((n, s) => n + (canSend(s) ? 0 : s.pending.size), 0),
        deadLetters: legacy.dead + readDeadLetters().length, captureFailures, legacyPending: legacy.pending,
        corruptRecords: names(corruptRoot).filter(file => file.endsWith(".raw")).length + unsavedCorrupt.size,
      };
    },
    drain(send, maxBatch, controls = {}) {
      if (retired || inflight) return Promise.resolve("empty");
      const run = Promise.resolve().then(() => {
        prepare();
        return drainOnce(send, maxBatch ?? limits.maxBatchRows, maxBatch !== undefined, controls);
      }).finally(() => { inflight = null; });
      inflight = run;
      return run;
    },
    async persist() {
      if (closed) return;
      retired = true;
      clearTimeout(timer); timer = undefined;
      try {
        // A send in flight may already be stored by the backend; without its ack on disk the next
        // process adopts this file and uploads those rows again.
        await inflight;
        sync();
        await compacting;
        await compact();
      } finally {
        await compacting;
        for (const writer of writers.values()) {
          try { closeSync(writer.fd); } catch { log.error("audit queue descriptor could not be closed"); }
          finally { localWriters.delete(writer.file); }
        }
        closed = true;
      }
    },
  };
}
