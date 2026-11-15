import { homedir } from "node:os";
import { CLIENT, DEFAULT_BACKEND, readLogin } from "../io/credentials.ts";
import { collectCounts, settleCounts } from "./counts.ts";
import { claimDay, ensureInstallId, environmentFor, pingEnabled, type Env } from "./state.ts";

export interface ReachOptions {
  backend?: string;
  pluginOptions?: Readonly<Record<string, unknown>>;
  hostVersion?: unknown;
}
export interface ReachDependencies {
  home?: string;
  env?: Env;
  now?: () => number;
  platform?: string;
  readLogin?: typeof readLogin;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export function reachContext(options: ReachOptions, deps: ReachDependencies) {
  const env = deps.env ?? process.env;
  const configured = options.backend ?? (typeof options.pluginOptions?.backendUrl === "string" ? options.pluginOptions.backendUrl : undefined);
  const backend = env.ARMORIQ_BACKEND_URL?.trim() ? env.ARMORIQ_BACKEND_URL : configured || DEFAULT_BACKEND;
  return { env, home: deps.home ?? homedir(), backend, environment: environmentFor(backend), pluginOptions: options.pluginOptions };
}

export function validVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,32})?$/.test(value) ? value : null;
}

// Called only from an unreferenced timer. Nothing here is awaited by a host hook.
export async function runPing(options: ReachOptions, deps: ReachDependencies = {}): Promise<void> {
  let active = true;
  let acknowledged = false;
  const sendingFiles: string[] = [];
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctx = reachContext(options, deps);
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    const send = async () => {
      if (!ctx.environment || !await pingEnabled(ctx) || !active) return;
      const installId = await ensureInstallId(ctx.home);
      if (!installId || !active) return;
      if (!await claimDay({ home: ctx.home, environment: ctx.environment, day }) || !active) return;
      const localCounts = await collectCounts(ctx.home, ctx.environment, day, sendingFiles, () => active);
      if (!active) return;
      const signedIn = (deps.readLogin ?? readLogin)(ctx.env, ctx.backend) !== null;
      const platform = deps.platform ?? process.platform;
      const body = {
        schemaVersion: 1,
        installId,
        plugin: "armoropencode",
        pluginVersion: CLIENT.version,
        hostAgent: "opencode",
        hostVersion: validVersion(options.hostVersion),
        os: ({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[platform] ?? "other",
        signedIn,
        environment: ctx.environment,
        localCounts,
      };
      if (!await pingEnabled(ctx) || !active) return;
      const expired = new Promise<never>((_resolve, reject) => {
        requestTimer = setTimeout(() => { abort.abort(); reject(new Error("reach request timed out")); }, 3000);
        requestTimer.unref();
      });
      const response = await Promise.race([
        (deps.fetch ?? globalThis.fetch)(`${ctx.backend}/install-pings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: abort.signal,
        }),
        expired,
      ]);
      acknowledged = active && response.status >= 200 && response.status < 300;
    };
    await Promise.race([
      send(),
      new Promise<void>(resolve => {
        deadline = setTimeout(() => { active = false; abort.abort(); resolve(); }, 5000);
        deadline.unref();
      }),
    ]);
  } catch {
    // Best effort, including fetch, credentials, settings and state failures.
  } finally {
    active = false;
    clearTimeout(deadline);
    clearTimeout(requestTimer);
    abort.abort();
    await settleCounts(sendingFiles, acknowledged);
  }
}
