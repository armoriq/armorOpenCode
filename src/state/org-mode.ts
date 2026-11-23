import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { authHeaders } from "../io/backend-audit.ts";
import type { Log, Login } from "../types.ts";

// The workspace's Tools mode from GET /policies/profiles/active: Quiet is shadow, Show in chat is
// shadow with notices, Block is enforce. A new install has no answer yet and runs in Monitor.
export type OrgMode = { mode: "shadow" | "enforce"; notices: boolean };

export interface OrgModeSource {
  current(): OrgMode;
  // Fetches in the background; calls after the answer lands follow it.
  refresh(login: Login): void;
}

const MONITOR: OrgMode = { mode: "shadow", notices: false };
const FETCH_TIMEOUT_MS = 5_000;

export const orgModeForced = (env: NodeJS.ProcessEnv = process.env) => env.ARMORIQ_ORG_MODE?.trim() === "enforce";

function parse(value: unknown): OrgMode | null {
  if (typeof value !== "object" || value === null) return null;
  const { enforcementMode, monitorNotices, mode, notices } = value as Record<string, unknown>;
  const m = enforcementMode ?? mode;
  if (m !== "shadow" && m !== "enforce") return null;
  return { mode: m, notices: (monitorNotices ?? notices) === true };
}

export async function fetchOrgMode(login: Login): Promise<OrgMode | null> {
  const res = await fetch(`${login.backend}/policies/profiles/active`, {
    headers: authHeaders(login.apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return parse(await res.json().catch(() => null));
}

export function createOrgMode(file: string, log: Log, fetcher = fetchOrgMode): OrgModeSource {
  let cached: OrgMode = MONITOR;
  try {
    cached = parse(JSON.parse(readFileSync(file, "utf8"))) ?? MONITOR;
  } catch {}
  let inflight = false;

  const save = (next: OrgMode) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...next, at: new Date().toISOString() }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      log.warn("org mode not saved", { error: String(error) });
    }
  };

  return {
    current: () => cached,
    refresh(login) {
      if (inflight) return;
      inflight = true;
      fetcher(login)
        .then((next) => {
          if (!next || (next.mode === cached.mode && next.notices === cached.notices)) return;
          cached = next;
          save(next);
          log.info("workspace mode changed", { mode: next.mode, notices: next.notices });
        })
        .catch((error: unknown) => log.warn("workspace mode fetch failed", { error: String(error) }))
        .finally(() => {
          inflight = false;
        });
    },
  };
}
