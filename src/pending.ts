// Local staging store for /armor/add and /armor/template.
//
// Matches ArmorClaude's convention: a policy change is first STAGED to a file
// inside dataDir, previewed to the user as YAML (see policy-yaml.ts), and
// only pushed to the ArmorIQ backend when the user runs /armor/yes.
// /armor/no discards.
//
// SINGLE SLOT: one pending proposal per workspace at a time, living at
// ${dataDir}/policy-pending.json. Staging again overwrites, and the proposal
// id changes every time.
//
// Field names on disk are camelCase here — deliberately NOT the snake_case
// planner.ts uses. Both formats are read by other ArmorIQ processes; do not
// normalize either one.
//
// The policy payload is carried as a type parameter rather than typed against
// the real PolicyProfile shape: this module reads no field of it (it only
// round-trips it through JSON), and PolicyProfile belongs to the Phase 3
// backend client.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// ---- Types ----

/** The on-disk staged-proposal record. camelCase is the wire format. */
export interface PendingRecord<TPolicy = unknown> {
  proposalId: string;
  stagedAt: string;
  expiresAt: string;
  reason: string;
  source: string;
  policy: TPolicy;
}

export interface StagePendingInput<TPolicy = unknown> {
  policy: TPolicy;
  reason?: string;
  source?: string;
}

/**
 * `record` is null both when nothing is staged AND when the staged file is
 * corrupt — those two cases are deliberately indistinguishable to callers.
 * `expired` is only ever true alongside a non-null record.
 */
export interface ReadPendingResult<TPolicy = unknown> {
  record: PendingRecord<TPolicy> | null;
  expired: boolean;
}

// ---- Constants ----

/** 30 minutes. Stamped into `expiresAt` at stage time, not computed on read. */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_STAGE_REASON = "Staged via ArmorOpenCode /armor";
export const DEFAULT_STAGE_SOURCE = "cli";

export function pendingPath(dataDir: string): string {
  return join(dataDir, "policy-pending.json");
}

// ---- Read / write ----

/**
 * Write a staged proposal. Overwrites whatever was staged before; that
 * matches the ArmorClaude UX where re-running /armor/add supersedes any
 * unconfirmed prior stage.
 *
 * Creates `dataDir` itself (unlike planner.ts, which creates a `plans/`
 * subdirectory under it).
 *
 * Note the TTL is STORED, not computed: `expiresAt` is stamped here, once, so
 * readPending only has to compare it against the clock.
 */
export function stagePending<TPolicy>(
  dataDir: string,
  { policy, reason, source }: StagePendingInput<TPolicy>,
): PendingRecord<TPolicy> {
  mkdirSync(dataDir, { recursive: true });
  const record: PendingRecord<TPolicy> = {
    proposalId: `prop_${randomUUID().slice(0, 8)}`,
    stagedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    reason: reason || DEFAULT_STAGE_REASON,
    source: source || DEFAULT_STAGE_SOURCE,
    policy,
  };
  writeFileSync(pendingPath(dataDir), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * Read the current staged proposal. Returns `{ record, expired }`, where
 * `expired` means the proposal is past its stored TTL and the caller should
 * treat it as "nothing staged" and clear the file.
 *
 * Three behaviors here are subtle and intentional:
 *
 * 1. A record with NO `expiresAt` is reported as NOT expired. A legacy or
 *    hand-written record therefore never expires. Flipping this to
 *    fail-closed would silently discard such proposals, which is worse than
 *    keeping one alive: staging is a user-initiated, user-confirmed action,
 *    and the confirmation step is the real gate.
 * 2. A MALFORMED `expiresAt` parses to NaN, and `Date.now() > NaN` is false,
 *    so it lands in the same not-expired bucket. Same rationale.
 * 3. This function does NOT delete an expired (or corrupt) file. Clearing is
 *    the caller's job via clearPending — do not add auto-clear here, or a
 *    read turns into a destructive operation.
 *
 * Corrupt JSON yields `{ record: null, expired: false }`, deliberately
 * indistinguishable from "nothing staged".
 */
export function readPending<TPolicy = unknown>(
  dataDir: string,
): ReadPendingResult<TPolicy> {
  const p = pendingPath(dataDir);
  if (!existsSync(p)) return { record: null, expired: false };
  try {
    // Not shape-validated, exactly as in the JS original — see the same
    // caveat on planner.ts's loadPlan.
    const record = JSON.parse(
      readFileSync(p, "utf-8"),
    ) as PendingRecord<TPolicy>;
    const expired = record.expiresAt
      ? Date.now() > Date.parse(record.expiresAt)
      : false;
    return { record, expired };
  } catch {
    return { record: null, expired: false };
  }
}

/** Used by /armor/yes after successful confirmation, and by /armor/no. */
export function clearPending(dataDir: string): void {
  const p = pendingPath(dataDir);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

/**
 * True iff a pending file exists. Checks EXISTENCE ONLY and ignores expiry,
 * so `hasPending(d) === true` alongside `readPending(d).expired === true` is a
 * reachable (and expected) state — callers that care about validity must use
 * readPending.
 */
export function hasPending(dataDir: string): boolean {
  return existsSync(pendingPath(dataDir));
}
