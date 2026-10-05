// Local active policy for ArmorOpenCode.
//
// Design: /armor/yes writes the confirmed policy to ${dataDir}/policy.json.
// The engine reads it at `tool.execute.before` and evaluates the tool call
// against the statements before calling the backend. Local is authoritative
// for enforcement; the backend adds org-wide policy and audit. This is the
// only way to get "/armor/yes is the only confirmation", because the
// backend's confirm endpoint is JWT-only.
//
// Fail closed: anything that cannot positively establish "allowed" is a deny.
// A corrupt policy file is `invalid` (never `none`), a malformed policy
// object denies, and a statement with an unknown effect denies.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { safeString, toBackendToolName } from "./tool-name-map.ts";

// ---- Types ----

export type PolicyEffect = "permit" | "forbid";
export type PolicyDecision = "allow" | "deny";
export type ConflictResolution = "deny_overrides" | "permit_overrides";

export interface PolicyStatement {
  id: string;
  effect: PolicyEffect;
  principal: { type: string; id: string };
  action: { type: string; eq: string };
  resource: { type: string; scope: string };
  conditions: unknown[];
}

/** The armor.policy.v1 PolicyProfile document. */
export interface PolicyProfile {
  schemaVersion: string;
  kind: "PolicyProfile";
  metadata: { name: string; description: string };
  defaults: { decision: PolicyDecision; conflictResolution: ConflictResolution };
  statements: PolicyStatement[];
}

/** On disk: `${dataDir}/policy.json`. */
export interface ActivePolicyRecord {
  savedAt: string;
  policy: PolicyProfile;
}

export type ValidatePolicyResult =
  | { ok: true; policy: PolicyProfile }
  | { ok: false; error: string };

export type LoadPolicyResult =
  | { status: "none" }
  | { status: "ok"; policy: PolicyProfile }
  | { status: "invalid"; error: string };

export interface LocalPolicyVerdict {
  decision: PolicyDecision;
  /** The statement that decided it; null when a default applied. */
  matched: PolicyStatement | null;
  reason: string;
}

// ---- Validation ----

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate only the fields the evaluator reads. principal, resource,
 * conditions, metadata and schemaVersion belong to the backend, so extra or
 * missing values there are not our business. Returns the SAME object, typed.
 */
export function validatePolicyProfile(raw: unknown): ValidatePolicyResult {
  const fail = (error: string): ValidatePolicyResult => ({ ok: false, error });

  if (!isObject(raw)) return fail("policy must be an object");
  if (!Array.isArray(raw.statements)) {
    return fail("policy.statements must be an array");
  }

  for (let i = 0; i < raw.statements.length; i++) {
    const s: unknown = raw.statements[i];
    const at = `policy.statements[${i}]`;
    if (!isObject(s)) return fail(`${at} must be an object`);
    if (typeof s.id !== "string" || s.id === "") {
      return fail(`${at}.id must be a non-empty string`);
    }
    if (s.effect !== "permit" && s.effect !== "forbid") {
      return fail(`${at}.effect must be "permit" or "forbid"`);
    }
    if (!isObject(s.action)) return fail(`${at}.action must be an object`);
    if (typeof s.action.eq !== "string" || s.action.eq === "") {
      return fail(`${at}.action.eq must be a non-empty string`);
    }
  }

  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) return fail("policy.defaults must be an object");
    const { decision, conflictResolution } = raw.defaults;
    if (decision !== undefined && decision !== "allow" && decision !== "deny") {
      return fail('policy.defaults.decision must be "allow" or "deny"');
    }
    if (
      conflictResolution !== undefined &&
      conflictResolution !== "deny_overrides" &&
      conflictResolution !== "permit_overrides"
    ) {
      return fail(
        'policy.defaults.conflictResolution must be "deny_overrides" or "permit_overrides"',
      );
    }
  }

  return { ok: true, policy: raw as unknown as PolicyProfile };
}

// ---- Storage ----

export function activePolicyPath(dataDir: string): string {
  return join(dataDir, "policy.json");
}

/**
 * Write the confirmed active policy. Validates first and throws on an invalid
 * one, leaving any existing file untouched. Writes a temp file then renames
 * it over policy.json, so a crash never leaves a half-written policy.
 */
export function saveActivePolicy(
  dataDir: string,
  policy: PolicyProfile,
): ActivePolicyRecord {
  const checked = validatePolicyProfile(policy);
  if (!checked.ok) {
    throw new Error(`Refusing to save invalid policy: ${checked.error}`);
  }

  mkdirSync(dataDir, { recursive: true });
  const record: ActivePolicyRecord = {
    savedAt: new Date().toISOString(),
    policy,
  };
  const target = activePolicyPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort; the original error matters more
    }
    throw err;
  }
  return record;
}

/**
 * Read the active policy. `none` only when the file does not exist; every
 * other problem is `invalid` so the caller can deny instead of silently
 * running without a policy. No existsSync guard: it only creates a race.
 */
export function loadActivePolicy(dataDir: string): LoadPolicyResult {
  const path = activePolicyPath(dataDir);

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "none" };
    }
    return {
      status: "invalid",
      error: `Cannot read ${path}: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      status: "invalid",
      error: `${path} is not valid JSON: ${(err as Error).message}`,
    };
  }

  if (!isObject(parsed) || !("policy" in parsed)) {
    return { status: "invalid", error: `${path} is missing "policy"` };
  }

  const checked = validatePolicyProfile(parsed.policy);
  if (!checked.ok) {
    return { status: "invalid", error: `${path}: ${checked.error}` };
  }
  return { status: "ok", policy: checked.policy };
}

/**
 * Existence only. A corrupt file still counts; callers that need validity
 * must use loadActivePolicy.
 */
export function hasActivePolicy(dataDir: string): boolean {
  return existsSync(activePolicyPath(dataDir));
}

// ---- Evaluation ----

/**
 * Evaluate a tool call against the local policy. Never throws.
 *
 * - a statement matches when its action.eq (trimmed, lowercased) is "*", the
 *   backend name of the tool, or the raw tool name
 * - deny_overrides (default, and for any unknown value): forbid beats permit;
 *   permit_overrides: permit beats forbid
 * - any effect other than "permit" counts as forbid
 * - no match: defaults.decision, allow unless it is exactly "deny"
 */
export function evaluateLocalPolicy(
  policy: PolicyProfile | null | undefined,
  toolName: string,
): LocalPolicyVerdict {
  if (policy === null || policy === undefined) {
    return { decision: "allow", matched: null, reason: "no local policy" };
  }
  if (typeof policy !== "object") {
    return { decision: "deny", matched: null, reason: "Local policy is malformed" };
  }

  const raw = safeString(toolName);
  const names = new Set([
    toBackendToolName(raw).trim().toLowerCase(),
    raw.trim().toLowerCase(),
  ]);
  const statements: unknown[] = Array.isArray(policy.statements)
    ? policy.statements
    : [];

  let matchedPermit: PolicyStatement | null = null;
  let matchedForbid: PolicyStatement | null = null;

  for (const entry of statements) {
    const s = entry as PolicyStatement | null | undefined;
    const eq = String(s?.action?.eq ?? "").trim().toLowerCase();
    if (eq === "") continue;
    if (eq !== "*" && !names.has(eq)) continue;
    if (s?.effect === "permit") {
      matchedPermit ??= s;
    } else {
      matchedForbid ??= s as PolicyStatement;
    }
  }

  const permitFirst = policy.defaults?.conflictResolution === "permit_overrides";
  const winner = permitFirst
    ? (matchedPermit ?? matchedForbid)
    : (matchedForbid ?? matchedPermit);

  if (winner) {
    const permits = winner === matchedPermit && winner.effect === "permit";
    return {
      decision: permits ? "allow" : "deny",
      matched: winner,
      reason: `Local policy statement ${winner.id} ${permits ? "permits" : "denies"} ${raw}`,
    };
  }

  const decision: PolicyDecision =
    policy.defaults?.decision === "deny" ? "deny" : "allow";
  return { decision, matched: null, reason: `Local policy default (${decision})` };
}
