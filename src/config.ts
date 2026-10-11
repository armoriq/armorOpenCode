import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { backendOrigin, getCredentialsPath, loadLoginContext } from "@armoriq/sdk-dev/dist/credentials.js";
import type { Mode } from "./guard.ts";
import { isPlainObject } from "./matcher.ts";

export interface ArmorConfig {
  mode: Mode;
  apiKey: string | undefined;
  userId: string | undefined;
  userEmail: string | undefined;
  backendEndpoint: string;
  dataDir: string;
  policyFile: string;
  flushIntervalMs: number;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

function readEnv(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readMode(env: Env, apiKey: string | undefined): Mode {
  const value = readEnv(env, "ARMOROPENCODE_MODE")?.toLowerCase();
  if (value === "enforce" || value === "watch") return value;
  return apiKey ? "enforce" : "watch";
}

function readPositiveInt(env: Env, key: string, fallback: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const PRODUCT = "armoropencode";

interface Login {
  apiKey: string;
  userId?: string;
  email?: string;
}

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined);

// SDK 0.8 writes a version-2 file of profiles keyed `product@host`; the SDK
// reader ignores anything else, so a pre-0.8 single-key file is read here.
function readLegacyLogin(backend: string): Login | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCredentialsPath(), "utf8"));
    if (!isPlainObject(parsed) || parsed.version !== undefined) return undefined;
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey.startsWith("ak_")) return undefined;
    if (typeof parsed.backend === "string" && backendOrigin(parsed.backend) !== backendOrigin(backend)) return undefined;
    if (typeof parsed.product === "string" && parsed.product && parsed.product !== PRODUCT) return undefined;
    return { apiKey: parsed.apiKey, userId: optionalString(parsed.userId), email: optionalString(parsed.email) };
  } catch {
    return undefined;
  }
}

function readSavedLogin(backend: string): Login | undefined {
  try {
    const profile = loadLoginContext({ backend, product: PRODUCT })?.profile;
    if (profile) return { apiKey: profile.apiKey, userId: optionalString(profile.userId), email: optionalString(profile.email) };
  } catch {}
  return readLegacyLogin(backend);
}

export function loadConfig(env: Env = process.env, home: string = homedir()): ArmorConfig {
  const production = (readEnv(env, "ARMORIQ_ENV") ?? "production").toLowerCase() === "production";
  const backendEndpoint =
    readEnv(env, "ARMOROPENCODE_BACKEND_ENDPOINT") ??
    readEnv(env, "BACKEND_ENDPOINT") ??
    (production ? "https://api.armoriq.ai" : "http://127.0.0.1:3000");
  const envKey = readEnv(env, "ARMORIQ_API_KEY");
  const login = envKey ? { apiKey: envKey } : readSavedLogin(backendEndpoint);
  const apiKey = login?.apiKey;
  const dataHome = readEnv(env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
  const dataDir = readEnv(env, "ARMOROPENCODE_DATA_DIR") ?? path.join(dataHome, "opencode", "armoropencode");
  return {
    mode: readMode(env, apiKey),
    apiKey,
    userId: login?.userId,
    userEmail: login?.email,
    backendEndpoint,
    dataDir,
    policyFile: readEnv(env, "ARMOROPENCODE_POLICY_FILE") ?? path.join(dataDir, "policy.json"),
    flushIntervalMs: readPositiveInt(env, "ARMOROPENCODE_FLUSH_INTERVAL_MS", 5000),
    timeoutMs: readPositiveInt(env, "ARMOROPENCODE_TIMEOUT_MS", 8000),
  };
}
