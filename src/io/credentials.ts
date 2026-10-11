import { backendOrigin, getCredentialsPath, loadLoginContext } from "@armoriq/sdk-dev/dist/credentials.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Log, Login } from "../types.ts";

export const PRODUCT = "armoropencode";
export const DEFAULT_BACKEND = "https://api.armoriq.ai";
const RELOAD_DEBOUNCE_MS = 100;
const DIR_POLL_MS = 10_000;

export interface Credentials {
  current(): Login | null;
  markRelogin(reason: string): void;
  stop(): void;
}

type Env = Record<string, string | undefined>;
type Identity = { apiKey: string; userId: string; orgId: string; email: string };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const envValue = (env: Env, key: string) => env[key]?.trim() || undefined;

export function deviceIdentity(env: Env, armoriqDir: string): { deviceId: string; deviceName: string } {
  const deviceName = hostname().trim().slice(0, 120);
  try {
    const persisted = readFileSync(envValue(env, "ARMORIQ_DEVICE_ID_PATH") ?? join(armoriqDir, "device-id"), "utf8").trim();
    if (persisted) return { deviceId: persisted.slice(0, 128), deviceName };
  } catch {}
  return { deviceId: `dev_${createHash("sha256").update(deviceName).digest("hex").slice(0, 16)}`, deviceName };
}

// SDK 0.8 writes v2 profiles keyed `product@host`; a pre-0.8 single-key file is honored only
// when it was minted for this backend and product.
function readLegacy(path: string, backend: string): Identity | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || parsed.version !== undefined) return null;
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey.startsWith("ak_")) return null;
    if (typeof parsed.backend === "string" && backendOrigin(parsed.backend) !== backendOrigin(backend)) return null;
    if (typeof parsed.product === "string" && parsed.product && parsed.product !== PRODUCT) return null;
    return { apiKey: parsed.apiKey, userId: str(parsed.userId), orgId: str(parsed.orgId), email: str(parsed.email) };
  } catch {
    return null;
  }
}

function readProfile(backend: string): Identity | null {
  try {
    const profile = loadLoginContext({ backend, product: PRODUCT })?.profile;
    return profile ? { apiKey: profile.apiKey, userId: profile.userId, orgId: profile.orgId, email: profile.email } : null;
  } catch {
    return null;
  }
}

export function readLogin(env: Env): Login | null {
  const credentialsPath = getCredentialsPath();
  const backend = (envValue(env, "ARMORIQ_BACKEND_URL") ?? DEFAULT_BACKEND).replace(/\/+$/, "");
  const saved = readProfile(backend) ?? readLegacy(credentialsPath, backend);
  const envKey = envValue(env, "ARMORIQ_API_KEY");
  const identity: Identity | null = envKey
    ? saved?.apiKey === envKey
      ? saved
      : { apiKey: envKey, userId: "", orgId: "", email: "" }
    : saved;
  if (!identity) return null;
  return { backend, ...identity, ...deviceIdentity(env, dirname(credentialsPath)) };
}

// SDK loadLoginContext + ~/.armoriq/device-id, read at setup and on file change; current() never touches disk.
export function createCredentials(
  log: Log,
  opts: { env?: Env; dataDir?: string } = {},
): Credentials {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? join(env.ARMORIQ_HOME ?? join(homedir(), ".armoriq"), PRODUCT);
  const armoriqDir = dirname(getCredentialsPath());
  let login = load();
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const warned = new Set<string>();

  function load(): Login | null {
    try {
      return readLogin(env);
    } catch (error) {
      log.error("credentials read failed", { error: String(error) });
      return null;
    }
  }

  function reload(): void {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = load();
      if (next?.apiKey !== login?.apiKey || next?.userId !== login?.userId) log.info("credentials changed", { loggedIn: next !== null });
      login = next;
    }, RELOAD_DEBOUNCE_MS);
    debounce.unref?.();
  }

  // The SDK replaces credentials.json by rename, so watch the directory rather than the file.
  function startWatch(): boolean {
    if (!existsSync(armoriqDir)) return false;
    try {
      watcher = watch(armoriqDir, { persistent: false }, () => reload());
      watcher.on("error", () => {});
      return true;
    } catch {
      return false;
    }
  }

  if (!startWatch()) {
    poll = setInterval(() => {
      if (!startWatch()) return;
      clearInterval(poll);
      reload();
    }, DIR_POLL_MS);
    poll.unref?.();
  }

  return {
    current: () => login,

    markRelogin(reason) {
      const current = login;
      if (!current) return;
      const binding = createHash("sha256").update(`${current.backend}\n${current.apiKey}`).digest("hex").slice(0, 16);
      if (!warned.has(binding)) {
        warned.add(binding);
        log.warn("ArmorIQ login expired; run `armoriq login --product armoropencode --force`", { reason });
      }
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dataDir, `relogin-required-${binding}`), "", { mode: 0o600 });
      } catch (error) {
        log.error("relogin marker write failed", { error: String(error) });
      }
    },

    stop() {
      clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = null;
    },
  };
}
