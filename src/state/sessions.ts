import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Mode, Plan, Session, SessionID, Token } from "../types.ts";

export interface SessionStore {
  has(id: SessionID): boolean;
  open(id: SessionID, parentId: SessionID | null, mode: Mode): Session;
  get(id: SessionID): Session;
  root(id: SessionID): Session;
  setPlan(id: SessionID, plan: Plan, token: Token | null): void;
  setToken(id: SessionID, token: Token): void;
  clearPlan(id: SessionID): void;
  noteRevision(id: SessionID): void;
  beginMessage(id: SessionID, messageId: string): void;
  advance(id: SessionID, stepIndex: number): void;
  close(id: SessionID): void;
  all(): Iterable<Session>;
  flush(): Promise<void>;
}

const WRITE_DELAY_MS = 100;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60_000;

type Snapshot = {
  v: 1;
  id: string;
  parentId: string | null;
  plan: Plan | null;
  token: SnapshotToken | null;
  stepCursor: number;
  revisionsThisMessage: number;
  currentMessageId: string | null;
};

type SnapshotToken =
  | { status: "active"; jwt: string; expiresAt: number; deniedTools: string[]; heldTools: string[] }
  | { status: "refused"; code: "account_revoked" | "billing_blocked" };

// In-memory owner of all session state; per-session snapshot files written in the background.
export function createSessionStore(dir: string, defaultMode: () => Mode): SessionStore {
  const sessions = new Map<SessionID, Session>();
  const restored = loadSnapshots(dir);
  const dirty = new Set<SessionID>();
  const removed = new Set<SessionID>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, WRITE_DELAY_MS);
    timer.unref?.();
  };

  const touch = (id: SessionID) => {
    dirty.add(id);
    schedule();
  };

  const write = (): Promise<void> => {
    const ids = [...dirty];
    const gone = [...removed];
    dirty.clear();
    removed.clear();
    writing = writing.then(async () => {
      if (ids.length + gone.length === 0) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {}
      for (const id of ids) {
        const s = sessions.get(id);
        if (!s) continue;
        const file = snapshotPath(dir, id);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(toSnapshot(s)), { mode: 0o600 });
          await rename(tmp, file);
        } catch {
          await unlink(tmp).catch(() => {});
        }
      }
      for (const id of gone) await unlink(snapshotPath(dir, id)).catch(() => {});
    });
    return writing;
  };

  const must = (id: SessionID): Session => {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.mode = defaultMode();
    return s;
  };

  return {
    has: (id) => sessions.has(id),

    open(id, parentId, mode) {
      const existing = sessions.get(id);
      if (existing) return existing;
      const snap = restored.get(id);
      restored.delete(id);
      const s: Session = { ...blankSession(id, mode), ...(snap ? fromSnapshot(snap) : {}) };
      if (parentId !== null) s.parentId = parentId;
      sessions.set(id, s);
      touch(id);
      return s;
    },

    get: must,

    root(id) {
      let s = must(id);
      const seen = new Set<SessionID>([s.id]);
      while (s.parentId !== null) {
        const parent = sessions.get(s.parentId);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        s = parent;
      }
      s.mode = defaultMode();
      return s;
    },

    setPlan(id, plan, token) {
      const s = must(id);
      s.plan = plan;
      s.token = token;
      s.stepCursor = 0;
      touch(id);
    },

    setToken(id, token) {
      must(id).token = token;
      touch(id);
    },

    clearPlan(id) {
      const s = must(id);
      s.plan = null;
      s.token = null;
      s.stepCursor = 0;
      touch(id);
    },

    noteRevision(id) {
      must(id).revisionsThisMessage += 1;
      touch(id);
    },

    beginMessage(id, messageId) {
      const s = must(id);
      if (s.currentMessageId === messageId) return;
      s.currentMessageId = messageId;
      s.revisionsThisMessage = 0;
      touch(id);
    },

    advance(id, stepIndex) {
      const s = must(id);
      const next = stepIndex + 1;
      if (next <= s.stepCursor) return;
      s.stepCursor = next;
      touch(id);
    },

    close(id) {
      if (!sessions.delete(id)) return;
      dirty.delete(id);
      removed.add(id);
      schedule();
    },

    all: () => sessions.values(),

    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return write();
    },
  };
}

function snapshotPath(dir: string, id: string): string {
  return path.join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function toSnapshot(s: Session): Snapshot {
  const t = s.token;
  return {
    v: 1,
    id: s.id,
    parentId: s.parentId,
    plan: s.plan,
    token:
      t === null
        ? null
        : t.status === "active"
          ? { status: "active", jwt: t.jwt, expiresAt: t.expiresAt, deniedTools: [...t.deniedTools], heldTools: [...t.heldTools] }
          : t,
    stepCursor: s.stepCursor,
    revisionsThisMessage: s.revisionsThisMessage,
    currentMessageId: s.currentMessageId,
  };
}

function blankSession(id: SessionID, mode: Mode): Session {
  return { id, parentId: null, mode, plan: null, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: null };
}

function fromSnapshot(snap: Snapshot): Omit<Session, "id" | "mode"> {
  return {
    parentId: snap.parentId as SessionID | null,
    plan: snap.plan,
    token: snap.token ? fromSnapshotToken(snap.token) : null,
    stepCursor: snap.stepCursor,
    revisionsThisMessage: snap.revisionsThisMessage,
    currentMessageId: snap.currentMessageId,
  };
}

function fromSnapshotToken(t: SnapshotToken): Token {
  if (t.status === "refused") return t;
  return { ...t, deniedTools: new Set(t.deniedTools), heldTools: new Set(t.heldTools) };
}

// Runs once at setup, so synchronous reads stay off the tool-call path.
function loadSnapshots(dir: string): Map<SessionID, Snapshot> {
  const out = new Map<SessionID, Snapshot>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".tmp")) removeAbandoned(file);
    if (!name.endsWith(".json")) continue;
    try {
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
        continue;
      }
      const snap = parseSnapshot(JSON.parse(readFileSync(file, "utf8")));
      if (snap) out.set(snap.id as SessionID, snap);
    } catch {}
  }
  return out;
}

// A write renames its temp file within milliseconds, so one this old was left by a crashed process.
function removeAbandoned(tmp: string): void {
  try {
    if (statSync(tmp).mtimeMs < Date.now() - TMP_MAX_AGE_MS) unlinkSync(tmp);
  } catch {}
}

function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Snapshot>;
  if (r.v !== 1 || typeof r.id !== "string") return null;
  const plan = isPlan(r.plan) ? r.plan : null;
  const token = isSnapshotToken(r.token) ? r.token : null;
  return {
    v: 1,
    id: r.id,
    parentId: stringOrNull(r.parentId),
    plan,
    token: plan ? token : null,
    stepCursor: intOrZero(r.stepCursor),
    revisionsThisMessage: intOrZero(r.revisionsThisMessage),
    currentMessageId: stringOrNull(r.currentMessageId),
  };
}

const stringOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const intOrZero = (v: unknown) => (Number.isInteger(v) ? (v as number) : 0);

function isPlan(p: unknown): p is Plan {
  if (!p || typeof p !== "object") return false;
  const x = p as Plan;
  return (
    typeof x.id === "string" &&
    typeof x.hash === "string" &&
    typeof x.goal === "string" &&
    Array.isArray(x.steps) &&
    x.steps.every((s) => s && typeof s.tool === "string" && typeof s.action === "string") &&
    Number.isInteger(x.revision) &&
    typeof x.registeredInMessage === "string"
  );
}

function isSnapshotToken(t: unknown): t is SnapshotToken {
  if (!t || typeof t !== "object") return false;
  const x = t as SnapshotToken;
  if (x.status === "refused") return x.code === "account_revoked" || x.code === "billing_blocked";
  return (
    x.status === "active" &&
    typeof x.jwt === "string" &&
    typeof x.expiresAt === "number" &&
    Array.isArray(x.deniedTools) &&
    Array.isArray(x.heldTools)
  );
}
