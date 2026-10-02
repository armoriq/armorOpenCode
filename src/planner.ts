// Per-session plan storage for ArmorOpenCode.
//
// A plan lives in ${dataDir}/plans/<session_id>.json. The MCP policy server
// writes it via register_intent_plan; the policy engine reads it at
// `tool.execute.before` to enforce drift. File-based on purpose, so there is
// no daemon and no in-memory coupling between the plugin process and the MCP
// server process.
//
// File format (snake_case ON DISK — deliberately not camelCase, because
// other ArmorIQ processes read these files; do not "normalize" it):
//   {
//     "session_id": "...",
//     "registered_at": "2026-08-14T...",
//     "goal": "...",
//     "steps": [{ "action": "read", "description": "...", "metadata": {} }]
//   }

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { IntentPlan, PlanStep } from "./intent-schema.ts";

// ---- Types ----

/**
 * The on-disk plan record. snake_case field names are the wire format, not a
 * style choice — see the header comment.
 */
export interface PlanRecord {
  session_id: string;
  registered_at: string;
  goal: string;
  steps: PlanStep[];
}

/**
 * What callers may pass as a session id. The hook payload is external data,
 * so `null`/`undefined` are genuinely reachable and safeSessionId handles
 * them.
 */
export type SessionIdInput = string | null | undefined;

// ---- Path safety ----

/**
 * Sanitize a session id into a safe filename component.
 *
 * Written as replace → truncate → fallback to mirror the JS original.
 * VERIFIED BY MUTATION TESTING: swapping the replace and truncate steps is
 * actually behaviorally equivalent, because the replacement is 1:1 in UTF-16
 * code units and so cannot change the string's length. Only the FALLBACK's
 * presence is load-bearing (its position isn't either). Recorded here so
 * nobody adds a test claiming to pin an order that isn't observable — and so
 * nobody "optimizes" the replacement into something length-changing, which
 * WOULD make the order matter.
 *
 * This is the PATH-TRAVERSAL DEFENSE for everything below — the whitelist is
 * alnum + `-` + `_`, so `.` and `/` and `\` all become `_` and a hostile
 * session id from a hook payload cannot escape the plans directory. It also
 * keeps the filename portable across every OS opencode ships on.
 *
 * `null`, `undefined`, `""` and `0` all collapse to "unknown" via the `||`
 * chain, which is why the parameter is `unknown` rather than `string`.
 */
export function safeSessionId(sessionId: unknown): string {
  return (
    String(sessionId || "")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 128) || "unknown"
  );
}

/**
 * Absolute path of a session's plan file. Re-sanitizes independently of
 * savePlan, so a caller may pass a raw (unsanitized) session id to ANY
 * function in this module and still land on the same, safe file.
 */
export function planFilePath(dataDir: string, sessionId: unknown): string {
  return join(dataDir, "plans", `${safeSessionId(sessionId)}.json`);
}

// ---- Read / write ----

/**
 * Store a validated plan for the given session id. Overwrites any existing
 * plan (later plans supersede earlier ones within a session; the last one the
 * model produced is authoritative).
 *
 * The record stores the SANITIZED id, so what's on disk always matches the
 * filename.
 */
export function savePlan(
  dataDir: string,
  sessionId: SessionIdInput,
  plan: IntentPlan,
): PlanRecord {
  const dir = join(dataDir, "plans");
  mkdirSync(dir, { recursive: true });
  const record: PlanRecord = {
    session_id: safeSessionId(sessionId),
    registered_at: new Date().toISOString(),
    goal: plan.goal,
    steps: plan.steps,
  };
  writeFileSync(
    planFilePath(dataDir, sessionId),
    JSON.stringify(record, null, 2) + "\n",
  );
  return record;
}

/**
 * Read the current plan for a session. Returns null if there is none, or if
 * the file exists but is corrupt (fail-closed at the caller's discretion).
 *
 * TYPE CAVEAT: the shape is NOT re-validated — whatever JSON was on disk is
 * returned as-is, so the PlanRecord return type is an assertion about the
 * happy path, not a guarantee. That mirrors the JS original exactly, and the
 * consumers (planToolNames / planContainsTool) all accept `unknown` and
 * degrade safely on garbage.
 */
export function loadPlan(
  dataDir: string,
  sessionId: SessionIdInput,
): PlanRecord | null {
  const file = planFilePath(dataDir, sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PlanRecord;
  } catch {
    return null;
  }
}

/** Explicit forget — used at session end to keep the plan directory bounded. */
export function clearPlan(dataDir: string, sessionId: SessionIdInput): void {
  const file = planFilePath(dataDir, sessionId);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

export function hasPlan(dataDir: string, sessionId: SessionIdInput): boolean {
  return existsSync(planFilePath(dataDir, sessionId));
}

/**
 * How old (in seconds) is the currently-stored plan? Callers use this to
 * expire stale plans without having to encode a TTL into the file itself.
 *
 * Age comes from the FILESYSTEM mtime, deliberately NOT from the record's
 * `registered_at` field. Reading the field instead would change behavior on
 * any copy/touch of the file, and would also mean trusting a value the plan
 * writer controls.
 *
 * Returns `Number.POSITIVE_INFINITY` when there is no plan, or when statSync
 * throws. That is what makes the naive caller-side `age > ttl` comparison
 * DENY BY CONSTRUCTION — hence the return type is `number`, never
 * `number | null`: a nullable return would push the fail-closed decision onto
 * every caller, and one forgotten null check would silently fail open.
 *
 * `Math.max(0, ...)` guards a clock skew (or a future mtime) from producing a
 * negative age that would read as "brand new forever".
 *
 * A single `statSync` in a try/catch handles BOTH the missing-plan case
 * (ENOENT) and any other stat failure, so there is no existsSync/statSync
 * window for the plan file to vanish through. One syscall, race-free.
 */
export function planAgeSeconds(
  dataDir: string,
  sessionId: SessionIdInput,
): number {
  try {
    const st = statSync(planFilePath(dataDir, sessionId));
    return Math.max(0, (Date.now() - st.mtimeMs) / 1000);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
