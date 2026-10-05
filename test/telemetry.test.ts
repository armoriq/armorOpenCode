import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelopes } from "../telemetry/aggregate.ts";
import { run } from "../telemetry/cli.ts";
import { readSqliteSnapshot, readSqliteSnapshots } from "../telemetry/source.ts";
import { LocalState, pendingRecords, validatePrivacy } from "../telemetry/state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; db: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "armoropencode-telemetry-"));
  roots.push(root);
  const db = join(root, "opencode.db");
  const state = join(root, "telemetry.ndjson");
  const database = new Database(db);
  database.run("CREATE TABLE session (id TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)");
  database.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  database.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  database.run("INSERT INTO session VALUES (?, ?, ?, ?)", ["s1", null, 1000, 2000] as any[]);
  database.close();
  return { root, db, state };
}

function insert(dbPath: string, message: Record<string, unknown>, parts: Array<Record<string, unknown>> = []): void {
  const db = new Database(dbPath);
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [message.id, "s1", message.created ?? 2000, message.updated ?? 2000, JSON.stringify(message)] as any[]);
  for (const part of parts) db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [part.id, message.id, "s1", part.created ?? 2100, part.updated ?? 2100, JSON.stringify(part)] as any[]);
  db.close();
}

describe("OpenCode read-only source adapter", () => {
  test("reads SQLite metadata without mutating the database", () => {
    const { db } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } });
    const before = readFileSync(db);
    const snapshot = readSqliteSnapshot(db);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.messages).toHaveLength(1);
    expect(readFileSync(db)).toEqual(before);
    const check = new Database(db, { readonly: true });
    expect(() => check.run("CREATE TABLE should_not_exist (id INTEGER)")).toThrow();
    check.close();
  });
});

describe("historical aggregation", () => {
  test("preserves model switches in one session/day envelope", () => {
    const { db } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "first", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } });
    insert(db, { id: "m2", role: "assistant", providerID: "p", modelID: "second", time: { created: 4000 }, tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 8 } });
    const [payload] = buildEnvelopes(readSqliteSnapshot(db));
    expect(payload?.models.map((model) => model.model)).toEqual(["p/first", "p/second"]);
    expect(payload?.budgets.session.actual).toBe(13);
  });

  test("counts tool calls from part rows without leaking tool arguments", () => {
    const { db } = fixture();
    insert(db,
      { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } },
      [
        { id: "tool-1", type: "tool", tool: "shell", callID: "call-1", state: { status: "completed" }, input: "secret" },
        { id: "tool-2", type: "tool", tool: "shell", callID: "call-2", state: { status: "error" }, output: "secret" },
      ],
    );
    const [payload] = buildEnvelopes(readSqliteSnapshot(db));
    expect(payload?.tools).toEqual({ calls: 2, completed: 1, failed: 1, unknown: 0, byName: { shell: 2 } });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("keeps missing counters unknown instead of turning them into zero", () => {
    const { db } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2 } });
    const [payload] = buildEnvelopes(readSqliteSnapshot(db));
    expect(payload?.models[0]?.tokens.total).toBeNull();
    expect(payload?.budgets.session.status).toBe("unconfigured");
    expect(payload?.coverage.missingTokenFields).toBeGreaterThan(0);
  });

  test("excludes fork-inherited history and reports the coverage warning", () => {
    const { db } = fixture();
    insert(db, { id: "old", role: "assistant", providerID: "p", modelID: "m", time: { created: 500 }, tokens: { input: 9, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 9 } });
    insert(db, { id: "new", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 1 } });
    const [payload] = buildEnvelopes(readSqliteSnapshot(db));
    expect(payload?.budgets.session.actual).toBe(1);
    expect(payload?.coverage.warnings).toContain("inherited_history_excluded");
  });

  test("deduplicates an explicitly repeated database path", () => {
    const { db } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } });
    const snapshot = readSqliteSnapshots([db, db]);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(1);
  });

  test("rejects colliding row IDs across different source files", () => {
    const first = fixture();
    const second = fixture();
    roots.push(second.root);
    insert(first.db, { id: "same", role: "assistant", providerID: "p", modelID: "one", time: { created: 3000 }, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 1 } });
    insert(second.db, { id: "same", role: "assistant", providerID: "p", modelID: "two", time: { created: 3000 }, tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 } });
    const snapshot = readSqliteSnapshots([first.db, second.db]);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.diagnostics.find((item) => item.code === "row_id_collision")?.count).toBeGreaterThan(0);
  });
});

describe("idempotent local state", () => {
  test("replaying a payload does not append a second event", () => {
    const { db, state: path } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } });
    const records = pendingRecords(buildEnvelopes(readSqliteSnapshot(db)));
    const store = new LocalState(path);
    expect(store.reconcile(records).added).toBe(1);
    expect(store.reconcile(records).unchanged).toBe(1);
    expect(store.pending()).toHaveLength(1);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    store.acknowledge(records[0]!);
    expect(store.pending()).toHaveLength(0);
    store.compact();
    expect(store.reconcile(records).unchanged).toBe(1);
    expect(store.pending()).toHaveLength(0);
  });

  test("rejects prompt and tool payloads before they reach the WAL", () => {
    const { state: path } = fixture();
    const unsafe = {
      schemaVersion: "telemetry.v1", product: "armoropencode", sessionId: "s1", usageDate: "2026-10-05",
      models: [], tools: { calls: 0, completed: 0, failed: 0, unknown: 0, byName: {} },
      budgets: { session: { limit: null, actual: 0, remaining: null, status: "unconfigured" }, account: { limit: null, actual: 0, remaining: null, status: "unconfigured" } },
      coverage: { source: "opencode.sqlite", sessionsScanned: 0, turnsScanned: 0, modelsObserved: 0, unknownModels: 0, missingTokenFields: 0, historyComplete: true, warnings: [], toolInput: "secret" },
    } as any;
    expect(() => validatePrivacy(unsafe)).toThrow("toolInput");
    expect(() => readFileSync(path)).toThrow();
  });
});

describe("opt-in CLI", () => {
  test("disabled sync never reads or creates local state", () => {
    const { db, state } = fixture();
    expect(run(["sync", "--source", join(db, "missing") , "--state", state])).toBe(0);
    expect(() => readFileSync(state)).toThrow();
  });

  test("credential-less enabled sync is rejected before source access", () => {
    const { db, state } = fixture();
    expect(run(["sync", "--source", join(db, "missing"), "--state", state, "--enable"], {})).toBe(2);
    expect(() => readFileSync(state)).toThrow();
  });

  test("enabled sync queues metadata with a user credential signal", () => {
    const { db, state } = fixture();
    insert(db, { id: "m1", role: "assistant", providerID: "p", modelID: "m", time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 5 } });
    expect(run(["sync", "--source", db, "--state", state, "--enable"], { ARMORIQ_API_KEY: "user-secret" })).toBe(0);
    const queued = readFileSync(state, "utf8");
    expect(queued).toContain("telemetry.v1");
    expect(queued).not.toContain("user-secret");
  });
});
