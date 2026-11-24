import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Login, Mode, PendingPlanRequest, Plan, Session, SessionGeneration, SessionID, Token } from "../types.ts";

export interface SessionStore {
  has(id: SessionID): boolean;
  open(id: SessionID, parentId: SessionID | null, mode: Mode): Session;
  get(id: SessionID): Session;
  root(id: SessionID): Session;
  setPlan(id: SessionID, plan: Plan, token: Token | null, generation?: SessionGeneration): boolean;
  setToken(id: SessionID, token: Token, generation?: SessionGeneration, tokenPlanId?: string): boolean;
  isCurrent(id: SessionID, generation: SessionGeneration): boolean;
  serialize<T>(id: SessionID, run: () => Promise<T>): Promise<T>;
  persistRequest(id: SessionID, request: PendingPlanRequest | null, generation: SessionGeneration): Promise<boolean>;
  syncAuth(): void;
  clearPlan(id: SessionID): void;
  noteRevision(id: SessionID): void;
  beginMessage(id: SessionID, messageId: string): boolean;
  noteMessage(id: SessionID, messageId: string): boolean;
  retirePrompt(id: SessionID): void;
  endPrompt(id: SessionID): void;
  noteActivity(id: SessionID, at?: number, toolCompleted?: boolean): void;
  advance(id: SessionID, stepIndex: number): void;
  close(id: SessionID): void;
  all(): Iterable<Session>;
  flush(): Promise<void>;
}

const WRITE_DELAY_MS = 100;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60_000;

type Snapshot = Omit<Session, "mode" | "id" | "parentId" | "token"> & {
  v: 1;
  id: string;
  parentId: string | null;
  token: SnapshotToken | null;
  authBinding: string | null;
};

type SnapshotToken =
  | { status: "active"; jwt: string; expiresAt: number; deniedTools: string[]; heldTools: string[] }
  | { status: "refused"; code: "account_revoked" | "billing_blocked" };

// In-memory owner of all session state; per-session snapshot files written in the background.
export function createSessionStore(dir: string, defaultMode: () => Mode, login: () => Login | null = () => null): SessionStore {
  const sessions = new Map<SessionID, Session>();
  const restored = loadSnapshots(dir);
  const dirty = new Set<SessionID>();
  const removed = new Set<SessionID>();
  const locks = new Map<SessionID, Promise<unknown>>();
  const writeErrors = new Map<SessionID, unknown>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const readBinding = () => {
    const auth = login();
    return createHash("sha256").update(JSON.stringify([defaultMode(), auth?.backend, auth?.apiKey, auth?.userId, auth?.orgId])).digest("hex");
  };
  let authBinding = readBinding();

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
          await writeFile(tmp, JSON.stringify(toSnapshot(s, authBinding)), { mode: 0o600 });
          await rename(tmp, file);
          writeErrors.delete(id);
        } catch (error) {
          writeErrors.set(id, error);
          await unlink(tmp).catch(() => {});
        }
      }
      for (const id of gone) await unlink(snapshotPath(dir, id)).catch(() => {});
    });
    return writing;
  };

  const syncAuth = () => {
    const next = readBinding();
    if (next === authBinding) return;
    authBinding = next;
    for (const s of sessions.values()) {
      s.authGeneration += 1;
      retirePlan(s);
      s.mode = defaultMode();
      touch(s.id);
    }
  };

  const isCurrent = (id: SessionID, generation: SessionGeneration): boolean => {
    syncAuth();
    const s = sessions.get(id);
    return s !== undefined && s.parentId === null && s.promptId === generation.promptId && s.promptGeneration === generation.promptGeneration && s.authGeneration === generation.authGeneration;
  };

  const must = (id: SessionID): Session => {
    syncAuth();
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.mode = defaultMode();
    return s;
  };

  return {
    syncAuth,
    isCurrent,
    serialize(id, run) {
      const running = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
      locks.set(id, running);
      void running.finally(() => { if (locks.get(id) === running) locks.delete(id); }).catch(() => {});
      return running;
    },
    async persistRequest(id, request, generation) {
      if (!isCurrent(id, generation)) return false;
      must(id).pendingRequest = request;
      touch(id);
      await this.flush();
      if (writeErrors.has(id)) throw new Error("could not persist the plan request");
      return isCurrent(id, generation);
    },
    has: (id) => sessions.has(id),

    open(id, parentId, mode) {
      syncAuth();
      const existing = sessions.get(id);
      if (existing) {
        if (parentId !== null && existing.parentId !== parentId) {
          existing.parentId = parentId;
          retirePlan(existing);
          existing.promptId = null;
          existing.promptOpenSince = null;
          touch(id);
        }
        return existing;
      }
      const snap = restored.get(id);
      restored.delete(id);
      const s: Session = { ...blankSession(id, mode), ...(snap ? fromSnapshot(snap) : {}) };
      if (snap && snap.authBinding !== authBinding) {
        s.authGeneration += 1;
        retirePlan(s);
      }
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

    setPlan(id, plan, token, generation) {
      if (generation && !isCurrent(id, generation)) return false;
      const s = must(id);
      s.plan = plan;
      s.token = token;
      s.stepCursor = 0;
      s.countedPlanId = plan.id || null;
      s.tokenPlanId = token?.status === "active" ? plan.id || null : null;
      s.planHash = plan.hash;
      s.kind = plan.id ? (plan.revision === 1 ? "new" : "revision") : null;
      s.tokenExpiresAt = token?.status === "active" ? token.expiresAt : null;
      s.pendingRequest = null;
      s.unregisteredLocalPlan = plan.id ? null : plan;
      touch(id);
      return true;
    },

    setToken(id, token, generation, tokenPlanId) {
      if (generation && !isCurrent(id, generation)) return false;
      const s = must(id);
      s.token = token;
      s.tokenExpiresAt = token.status === "active" ? token.expiresAt : null;
      s.tokenPlanId = token.status === "active" ? tokenPlanId ?? s.plan?.id ?? null : null;
      touch(id);
      return true;
    },

    clearPlan(id) {
      const s = must(id);
      retirePlan(s);
      s.promptGeneration += 1;
      touch(id);
    },

    noteRevision(id) {
      must(id).revisionsThisMessage += 1;
      touch(id);
    },

    beginMessage(id, messageId) {
      const s = must(id);
      if (s.parentId !== null || s.seenMessageIds.includes(messageId)) return false;
      retirePlan(s);
      s.currentMessageId = messageId;
      s.seenMessageIds.push(messageId);
      s.promptId = randomUUID();
      s.promptGeneration += 1;
      s.retirementEpoch = 0;
      s.promptOpenSince = Date.now();
      s.lastActivityAt = s.promptOpenSince;
      s.revisionsThisMessage = 0;
      touch(id);
      return true;
    },

    noteMessage(id, messageId) {
      const s = must(id);
      if (s.seenMessageIds.includes(messageId)) return false;
      s.seenMessageIds.push(messageId);
      touch(id);
      return true;
    },

    retirePrompt(id) {
      const s = must(id);
      if (s.promptId !== null) s.promptGeneration += 1;
      retirePlan(s);
      s.promptId = null;
      s.promptOpenSince = null;
      touch(id);
    },

    endPrompt(id) {
      if (!sessions.has(id)) return;
      const s = must(id);
      if (s.parentId !== null) return;
      s.promptOpenSince = null;
      s.lastActivityAt = Date.now();
      touch(id);
    },

    noteActivity(id, at = Date.now(), toolCompleted = false) {
      const s = this.root(id);
      if (!toolCompleted && s.lastActivityAt !== null && at - s.lastActivityAt >= 30 * 60_000) s.promptOpenSince = null;
      s.lastActivityAt = at;
      touch(s.id);
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

    all: () => {
      syncAuth();
      return sessions.values();
    },

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

function toSnapshot(s: Session, authBinding: string): Snapshot {
  const t = s.token;
  const { mode: _mode, token: _token, ...state } = s;
  return {
    ...state,
    v: 1,
    authBinding,
    token:
      t === null
        ? null
        : t.status === "active"
          ? { status: "active", jwt: t.jwt, expiresAt: t.expiresAt, deniedTools: [...t.deniedTools], heldTools: [...t.heldTools] }
          : t,
  };
}

function blankSession(id: SessionID, mode: Mode): Session {
  return {
    id, parentId: null, mode, plan: null, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: null,
    promptId: null, promptGeneration: 0, retirementEpoch: 0, promptOpenSince: null, lastActivityAt: null,
    countedPlanId: null, tokenPlanId: null, planHash: null, kind: null, tokenExpiresAt: null,
    authGeneration: 0, pendingRequest: null, unregisteredLocalPlan: null, seenMessageIds: [],
  };
}

function fromSnapshot(snap: Snapshot): Omit<Session, "id" | "mode"> {
  const { v: _v, id: _id, authBinding: _auth, token, ...state } = snap;
  return {
    ...state,
    parentId: snap.parentId as SessionID | null,
    token: token ? fromSnapshotToken(token) : null,
  };
}

function retirePlan(s: Session): void {
  if (s.promptId !== null) s.retirementEpoch += 1;
  s.plan = null;
  s.token = null;
  s.stepCursor = 0;
  s.countedPlanId = null;
  s.tokenPlanId = null;
  s.planHash = null;
  s.kind = null;
  s.tokenExpiresAt = null;
  s.pendingRequest = null;
  s.unregisteredLocalPlan = null;
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
    authBinding: stringOrNull(r.authBinding),
    promptId: stringOrNull(r.promptId),
    promptGeneration: intOrZero(r.promptGeneration),
    retirementEpoch: intOrZero(r.retirementEpoch),
    promptOpenSince: numberOrNull(r.promptOpenSince),
    lastActivityAt: numberOrNull(r.lastActivityAt),
    countedPlanId: stringOrNull(r.countedPlanId),
    tokenPlanId: stringOrNull(r.tokenPlanId),
    planHash: stringOrNull(r.planHash),
    kind: r.kind === "new" || r.kind === "revision" || r.kind === "refresh" ? r.kind : null,
    tokenExpiresAt: numberOrNull(r.tokenExpiresAt),
    authGeneration: intOrZero(r.authGeneration),
    pendingRequest: isPendingRequest(r.pendingRequest) ? r.pendingRequest : null,
    unregisteredLocalPlan: isPlan({ ...r.unregisteredLocalPlan, id: "" }) ? r.unregisteredLocalPlan! : null,
    seenMessageIds: Array.isArray(r.seenMessageIds) ? r.seenMessageIds.filter((id) => typeof id === "string") : [],
  };
}

const stringOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const intOrZero = (v: unknown) => (Number.isInteger(v) ? (v as number) : 0);
const numberOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function isPendingRequest(p: unknown): p is PendingPlanRequest {
  if (!p || typeof p !== "object") return false;
  const x = p as PendingPlanRequest;
  return typeof x.key === "string" && !!x.headers && typeof x.headers === "object" &&
    Object.values(x.headers).every((value) => typeof value === "string") && !!x.body && typeof x.body === "object";
}

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
