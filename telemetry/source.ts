import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  MessageRow,
  PartRow,
  RawTokens,
  SessionRow,
  SourceDiagnostic,
  SourceSnapshot,
} from "./types.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rawTokens(value: unknown): RawTokens | null {
  const row = object(value);
  if (Object.keys(row).length === 0) return null;
  const cache = object(row.cache);
  return {
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    total: row.total,
    cache: { read: cache.read, write: cache.write },
  };
}

function parsedData(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function jsonPath(data: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = data;
  for (const key of path) current = object(current)[key];
  return current;
}

function diagnostic(diagnostics: SourceDiagnostic[], code: string, message: string, count?: number): void {
  diagnostics.push(count === undefined ? { code, message } : { code, message, count });
}

function columns(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => text(row.name)).filter((name): name is string => name !== null));
}

function rows(db: Database, table: string, hasUpdated: boolean): Array<Record<string, unknown>> {
  const updated = hasUpdated ? "time_updated AS updated" : "time_created AS updated";
  const message = table === "part" ? ", message_id AS messageId" : "";
  return db.query(`SELECT id, session_id AS sessionId${message}, time_created AS created, ${updated}, data FROM ${table}`).all() as Array<Record<string, unknown>>;
}

export function defaultSourcePath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.OPENCODE_DATA_DIR?.split(",").map((value) => value.trim()).find(Boolean);
  if (configured) return configured;
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db");
}

export function readSqliteSnapshot(path: string): SourceSnapshot {
  const diagnostics: SourceDiagnostic[] = [];
  const sessions: SessionRow[] = [];
  const messages: MessageRow[] = [];
  const parts: PartRow[] = [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA query_only = ON");
    const queryOnly = db.query("PRAGMA query_only").get() as { query_only?: unknown };
    if (queryOnly.query_only !== 1) {
      diagnostic(diagnostics, "source_unreadable", "SQLite query-only mode could not be enabled.");
      return { source: "opencode.sqlite", sessions, messages, parts, diagnostics, complete: false };
    }
    db.run("BEGIN");
    const sessionColumns = columns(db, "session");
    const messageColumns = columns(db, "message");
    const partColumns = columns(db, "part");
    const required = [
      [sessionColumns, ["id", "time_created", "time_updated"]],
      [messageColumns, ["id", "session_id", "time_created", "data"]],
      [partColumns, ["id", "message_id", "session_id", "time_created", "data"]],
    ] as const;
    if (required.some(([available, expected]) => expected.some((name) => !available.has(name)))) {
      diagnostic(diagnostics, "unsupported_schema", "SQLite source lacks supported OpenCode tables or columns.");
      return { source: "opencode.sqlite", sessions, messages, parts, diagnostics, complete: false };
    }

    for (const row of db.query(`SELECT id, ${sessionColumns.has("parent_id") ? "parent_id" : "NULL AS parent_id"}, time_created, time_updated FROM session`).all() as Array<Record<string, unknown>>) {
      const id = text(row.id);
      if (!id) { diagnostic(diagnostics, "invalid_metadata", "Session row has no valid ID."); continue; }
      sessions.push({ id, parentId: text(row.parent_id), createdMs: integer(row.time_created), updatedMs: integer(row.time_updated) });
    }

    for (const row of rows(db, "message", messageColumns.has("time_updated"))) {
      const id = text(row.id);
      const sessionId = text(row.sessionId);
      const data = parsedData(row.data);
      if (!id || !sessionId || !data) { diagnostic(diagnostics, "malformed_json", "Invalid message rows were skipped."); continue; }
      messages.push({
        id,
        sessionId,
        role: text(data.role),
        providerId: text(data.providerID),
        modelId: text(data.modelID),
        createdMs: integer(jsonPath(data, ["time", "created"])) ?? integer(row.created),
        completedMs: integer(jsonPath(data, ["time", "completed"])),
        tokens: rawTokens(data.tokens),
        cost: typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 ? data.cost : null,
      });
    }

    for (const row of rows(db, "part", partColumns.has("time_updated"))) {
      const id = text(row.id);
      const sessionId = text(row.sessionId);
      const messageId = text(row.messageId);
      const data = parsedData(row.data);
      if (!id || !data) { diagnostic(diagnostics, "malformed_json", "Invalid part rows were skipped."); continue; }
      const state = object(data.state);
      const stateTime = object(state.time);
      parts.push({
        id,
        sessionId,
        messageId,
        type: text(data.type),
        tool: text(data.tool),
        callId: text(data.callID),
        status: text(state.status),
        createdMs: integer(row.created),
        updatedMs: integer(row.updated),
        startedMs: integer(stateTime.start),
        completedMs: integer(stateTime.end),
        tokens: rawTokens(data.tokens),
        cost: typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 ? data.cost : null,
      });
      if (!sessionId || !messageId) diagnostic(diagnostics, "orphan_part", "Part row is missing a session or message ID.");
    }
  } catch (error) {
    diagnostic(diagnostics, "source_unreadable", error instanceof Error ? error.message : "Could not read SQLite telemetry source.");
  } finally {
    try { db?.run("ROLLBACK"); } catch { /* read-only transaction may already be closed */ }
    db?.close();
  }
  const fatal = new Set(["source_unreadable", "unsupported_schema", "malformed_json", "invalid_metadata"]);
  return { source: "opencode.sqlite", sessions, messages, parts, diagnostics, complete: !diagnostics.some((item) => fatal.has(item.code)) };
}

/** Read multiple user-selected databases and deduplicate by OpenCode row ID. */
export function readSqliteSnapshots(paths: string[]): SourceSnapshot {
  const snapshots = [...new Set(paths)].map(readSqliteSnapshot);
  const merge = <T extends { id: string; updatedMs?: number | null; createdMs?: number | null }>(lists: T[][]): { rows: T[]; collisions: number } => {
    const byId = new Map<string, T>();
    const collisions = new Set<string>();
    for (const rows of lists) for (const row of rows) {
      const prior = byId.get(row.id);
      const currentTime = row.updatedMs ?? row.createdMs ?? 0;
      const priorTime = prior?.updatedMs ?? prior?.createdMs ?? 0;
      if (prior) {
        collisions.add(row.id);
        continue;
      }
      if (!prior || currentTime >= priorTime) byId.set(row.id, row);
    }
    for (const id of collisions) byId.delete(id);
    return { rows: [...byId.values()], collisions: collisions.size };
  };
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const sessionRows = merge(snapshots.map((snapshot) => snapshot.sessions));
  const messageRows = merge(snapshots.map((snapshot) => snapshot.messages));
  const partRows = merge(snapshots.map((snapshot) => snapshot.parts));
  const collisions = sessionRows.collisions + messageRows.collisions + partRows.collisions;
  if (collisions > 0) diagnostic(diagnostics, "row_id_collision", "The selected SQLite sources contain colliding row IDs; colliding rows were excluded.", collisions);
  return {
    source: "opencode.sqlite",
    sessions: sessionRows.rows,
    messages: messageRows.rows,
    parts: partRows.rows,
    diagnostics,
    complete: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.complete) && collisions === 0,
  };
}
