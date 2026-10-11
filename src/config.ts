import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Mode } from "./guard.ts";
import { isPlainObject } from "./matcher.ts";

export interface ArmorConfig {
  mode: Mode;
  apiKey: string | undefined;
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

// `armoriq login --product armoropencode` writes the same shared file as
// every other ArmorIQ product; --product only labels the login page.
export function readCredentialsApiKey(home: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(home, ".armoriq", "credentials.json"), "utf8"));
    if (isPlainObject(parsed) && typeof parsed.apiKey === "string" && parsed.apiKey.startsWith("ak_")) {
      return parsed.apiKey;
    }
  } catch {}
  return undefined;
}

export function loadConfig(env: Env = process.env, home: string = homedir()): ArmorConfig {
  const apiKey = readEnv(env, "ARMORIQ_API_KEY") ?? readCredentialsApiKey(home);
  const dataHome = readEnv(env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
  const dataDir = readEnv(env, "ARMOROPENCODE_DATA_DIR") ?? path.join(dataHome, "opencode", "armoropencode");
  const production = (readEnv(env, "ARMORIQ_ENV") ?? "production").toLowerCase() === "production";
  return {
    mode: readMode(env, apiKey),
    apiKey,
    backendEndpoint:
      readEnv(env, "ARMOROPENCODE_BACKEND_ENDPOINT") ??
      readEnv(env, "BACKEND_ENDPOINT") ??
      (production ? "https://api.armoriq.ai" : "http://127.0.0.1:3000"),
    dataDir,
    policyFile: readEnv(env, "ARMOROPENCODE_POLICY_FILE") ?? path.join(dataDir, "policy.json"),
    flushIntervalMs: readPositiveInt(env, "ARMOROPENCODE_FLUSH_INTERVAL_MS", 5000),
    timeoutMs: readPositiveInt(env, "ARMOROPENCODE_TIMEOUT_MS", 8000),
  };
}
