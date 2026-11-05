// ArmorOpenCode config resolver.
//
// Resolves the plugin's runtime configuration from (in precedence order)
// environment variables, ~/.armoriq/credentials.json, and built-in defaults.
//
// Behavior is FAIL-CLOSED when the plugin isn't configured with an ArmorIQ
// API key: `isConfigured` goes false and the engine denies rather than
// allows. Everything else is a tested-good default; the env vars are dev/CI
// escape hatches, not end-user surface.
//
// Credential resolution precedence matches ArmorClaude / ArmorCodex /
// ArmorGemini; the `||` chain in loadConfig states the order declaratively.
//
// Naming note: the shared `ARMORIQ_*` vars are cross-product and keep their
// names; the product-specific ones are `ARMOROPENCODE_*` (ArmorGemini's were
// `ARMORGEMINI_*`).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A NAMED import, not a default one: `import pkg from ...` inlines the whole
// package.json object into a bundle (property access isn't tree-shaken),
// which by Phase 4 would ship devDependencies and any private script names
// or registry URLs in the published artifact. This tree-shakes to one string.
import { version } from "../package.json" with { type: "json" };

// ---- Types ----

export type CredentialSource = "env" | "credentials.json" | "none";

/**
 * The environment as this module reads it. Structurally identical to
 * `NodeJS.ProcessEnv` for these purposes and accepts `process.env` directly,
 * but doesn't require an ambient global in a module that otherwise imports
 * everything explicitly.
 */
export type Env = Record<string, string | undefined>;

export interface ArmorConfig {
  /** "" when unresolved — never undefined. See isConfigured. */
  apiKey: string;
  /** Trailing slashes stripped. */
  backendEndpoint: string;
  timeoutMs: number;
  /**
   * Genuinely `undefined` when unset, NOT "". Callers omit the org header
   * entirely rather than sending an empty one, so the distinction matters.
   */
  orgId: string | undefined;
  dataDir: string;
  intentRequired: boolean;
  planTtlSeconds: number;
  credentialSource: CredentialSource;
  /** `Boolean(apiKey && backendEndpoint)` — the fail-closed gate. */
  isConfigured: boolean;
}

export interface AuthHeaders {
  "Content-Type": string;
  Accept: string;
  Authorization: string;
  "X-ArmorIQ-Client": string;
}

/**
 * The fields this module reads out of ~/.armoriq/credentials.json. Every one
 * is `unknown` because the file is external, hand-editable data: the
 * `typeof === "string"` guards below are what turn it into usable values, and
 * a non-string is IGNORED rather than coerced.
 */
interface CredentialsFile {
  apiKey?: unknown;
  backendEndpoint?: unknown;
  orgId?: unknown;
}

// ---- Defaults ----

export const DEFAULT_BACKEND_ENDPOINT = "https://api.armoriq.ai";
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * `~/.armoriq/armoropencode` — a deliberate divergence from ArmorGemini's
 * `~/.gemini/armorgemini`. ArmorIQ state groups alongside the existing
 * `~/.armoriq/credentials.json` rather than living inside opencode's own
 * config directories.
 */
export const DEFAULT_DATA_DIR = join(homedir(), ".armoriq", "armoropencode");

/**
 * A plan older than this is treated as stale; the next tool call is denied
 * with "plan expired, re-plan required." Keeps the token semantics
 * consistent with ArmorClaude's default.
 */
export const DEFAULT_PLAN_TTL_SECONDS = 600;

/**
 * Value of the X-ArmorIQ-Client header. The version is read from
 * package.json rather than hardcoded on purpose: ArmorGemini hardcoded
 * "armorgemini/0.3.0" and it drifted out of sync with its own package.json
 * (0.3.3). Don't reproduce that.
 */
export const CLIENT_HEADER = `armoropencode/${version}`;

export function defaultCredentialsFilePath(): string {
  return join(homedir(), ".armoriq", "credentials.json");
}

// ---- Resolution ----

function readCredentialsFile(filePath: string): CredentialsFile | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as CredentialsFile;
  } catch {
    return null;
  }
}

function envBoolean(env: Env, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Resolve a positive-integer setting from an env var, falling back to `def`.
 *
 * `Number.parseInt` (base 10) rather than `Number()` is load-bearing:
 * parseInt tolerates a trailing unit, so "8000ms" resolves to 8000 instead
 * of NaN.
 */
function envPositiveInt(env: Env, name: string, def: number): number {
  const parsed = Number.parseInt(env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : def;
}

/**
 * Read a string field off the credentials file, or "" if it is absent or not
 * a string. The `typeof` guard is why a number/object in credentials.json is
 * ignored rather than coerced into a bogus key or URL.
 */
function credString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolve the full config.
 *
 * `env` and `credentialsFilePath` are injectable for testability, exactly as
 * scripts/install.ts's checkCredentials does it. The defaults are the real
 * `process.env` and `~/.armoriq/credentials.json`, so production behavior is
 * identical to reading them directly.
 */
export function loadConfig(
  env: Env = process.env,
  credentialsFilePath: string = defaultCredentialsFilePath(),
): ArmorConfig {
  const creds = readCredentialsFile(credentialsFilePath);

  const apiKey =
    env.ARMORIQ_API_KEY ||
    env.ARMOROPENCODE_API_KEY ||
    credString(creds?.apiKey) ||
    "";

  const backendEndpoint = (
    env.ARMORIQ_BACKEND_ENDPOINT ||
    env.ARMOROPENCODE_BACKEND_ENDPOINT ||
    credString(creds?.backendEndpoint) ||
    DEFAULT_BACKEND_ENDPOINT
  ).replace(/\/+$/, "");

  // NOTE: no product-specific env var here. orgId has exactly two sources —
  // the shared ARMORIQ_ORG_ID and the credentials file — and falls through to
  // `undefined` (not "") so callers can tell "unset" from "set to empty".
  const orgId =
    env.ARMORIQ_ORG_ID || credString(creds?.orgId) || undefined;

  const dataDir = env.ARMOROPENCODE_DATA_DIR || DEFAULT_DATA_DIR;

  // Intent-plan enforcement is ON by default (fail-closed). Set
  // ARMOROPENCODE_INTENT_REQUIRED=false to fall back to policy-only mode
  // while an operator is migrating.
  const intentRequired = envBoolean(env, "ARMOROPENCODE_INTENT_REQUIRED", true);

  // Recomputed from the env vars rather than tracked from where the key
  // actually came from. That's a QUIRK carried over deliberately: it reports
  // "env" whenever either API-key env var is set, so the value describes the
  // env, not the resolution path. Preserved as-is because downstream
  // diagnostics already read it this way.
  const credentialSource: CredentialSource = apiKey
    ? env.ARMORIQ_API_KEY || env.ARMOROPENCODE_API_KEY
      ? "env"
      : "credentials.json"
    : "none";

  return {
    apiKey,
    backendEndpoint,
    timeoutMs: envPositiveInt(
      env,
      "ARMOROPENCODE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
    orgId,
    dataDir,
    intentRequired,
    planTtlSeconds: envPositiveInt(
      env,
      "ARMOROPENCODE_PLAN_TTL_SECONDS",
      DEFAULT_PLAN_TTL_SECONDS,
    ),
    credentialSource,
    // Fail-closed. `Boolean(...)` on the two strings, NOT a `!= null` check:
    // an empty string is falsy and must count as unconfigured.
    isConfigured: Boolean(apiKey && backendEndpoint),
  };
}

/**
 * Build the headers for a backend request. Takes only what it reads, so a
 * caller can pass a full ArmorConfig or a bare `{ apiKey }`.
 */
export function authHeaders(config: Pick<ArmorConfig, "apiKey">): AuthHeaders {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-ArmorIQ-Client": CLIENT_HEADER,
  };
}
