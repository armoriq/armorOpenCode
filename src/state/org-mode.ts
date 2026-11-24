import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { authHeaders } from "../io/backend-audit.ts";
import type { Log, Login } from "../types.ts";

// The workspace's Tools mode from GET /policies/profiles/active: Quiet is shadow, Show in chat is
// shadow with notices, Block is enforce.
export type OrgMode = { mode: "shadow" | "enforce"; notices: boolean };

export interface OrgModeSource {
  // The last answer for this login's workspace; an answer saved for another workspace does not count.
  current(login: Login | null): OrgMode;
  known(login: Login | null): boolean;
  // Asks the backend. Resolves once the answer, or the failure, is in; never rejects.
  refresh(login: Login): Promise<void>;
}

const UNKNOWN: OrgMode = { mode: "enforce", notices: false };
const FETCH_TIMEOUT_MS = 5_000;

export const orgModeForced = (env: NodeJS.ProcessEnv = process.env) => env.ARMORIQ_ORG_MODE?.trim() === "enforce";

// The backend answers enforcementMode/monitorNotices; the cache file stores mode/notices.
function parse(value: unknown, cacheFile = false): OrgMode | null {
  if (typeof value !== "object" || value === null) return null;
  const { enforcementMode, monitorNotices, mode, notices } = value as Record<string, unknown>;
  const m = cacheFile ? mode : enforcementMode;
  if (m !== "shadow" && m !== "enforce") return null;
  return { mode: m, notices: (cacheFile ? notices : monitorNotices) === true };
}

// The workspace the answer belongs to, without keeping the key itself on disk.
const workspaceOf = (login: Login) =>
  createHash("sha256").update(`${login.backend}\n${login.orgId || login.apiKey}`).digest("hex").slice(0, 32);

export async function fetchOrgMode(login: Login): Promise<OrgMode | null | "unauthorized"> {
  const res = await fetch(`${login.backend}/policies/profiles/active`, {
    headers: authHeaders(login.apiKey),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401) return "unauthorized";
  if (!res.ok) return null;
  return parse(await res.json().catch(() => null));
}

export function createOrgMode(
  file: string,
  log: Log,
  fetcher: (login: Login) => Promise<OrgMode | null | "unauthorized"> = fetchOrgMode,
  onUnauthorized: (reason: string) => void = () => {},
): OrgModeSource {
  let cached: OrgMode | null = null;
  // null: a cache from before answers were tied to a workspace; it counts for any login until the next answer.
  let cachedFor: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    cached = parse(saved, true);
    if (typeof saved?.for === "string") cachedFor = saved.for;
  } catch {}
  // One fetch in flight per workspace, so a new login never waits on the old one's answer.
  const inflight = new Map<string, Promise<void>>();
  // The workspace asked about last; a slower answer for an earlier login is dropped.
  let latest: string | null = null;

  const save = (next: OrgMode, workspace: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ ...next, for: workspace, at: new Date().toISOString() }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      log.warn("org mode not saved", { error: String(error) });
    }
  };

  const known = (login: Login | null) => cached !== null && !(login && cachedFor !== null && cachedFor !== workspaceOf(login));

  if (cached === null) log.info("workspace mode not confirmed yet; Block applies until the backend answers");

  return {
    current: (login) => (known(login) ? cached! : UNKNOWN),
    known,
    refresh(login) {
      const workspace = workspaceOf(login);
      latest = workspace;
      const running = inflight.get(workspace);
      if (running) return running;
      const request = fetcher(login)
        .then((next) => {
          if (next === "unauthorized") return onUnauthorized("workspace mode request returned 401");
          if (!next || workspace !== latest || (next.mode === cached?.mode && next.notices === cached.notices && workspace === cachedFor)) return;
          cached = next;
          cachedFor = workspace;
          save(next, workspace);
          log.info("workspace mode changed", { mode: next.mode, notices: next.notices });
        })
        .catch((error: unknown) => log.warn("workspace mode fetch failed", { error: String(error) }))
        .finally(() => inflight.delete(workspace));
      inflight.set(workspace, request);
      return request;
    },
  };
}
