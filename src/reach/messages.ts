import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { loginCommand } from "./login.ts";
import { reachContext, type ReachDependencies, type ReachOptions } from "./ping.ts";
import { isSignedIn } from "./signed-in.ts";
import { countsDir, dayTime, pingEnabled, READ_FLAGS, type Env } from "./state.ts";

export const NOTICE = "ArmorIQ sends an anonymous daily usage ping (a random install id, plugin and version, OS, signed in or not, and daily counts of plans and blocks); turn it off with ARMORIQ_USAGE_PING_DISABLED=1 or DO_NOT_TRACK=1.";
export const reachDir = (home: string) => path.join(home, ".armoriq/reach/v1/armoropencode");

export async function reminderEnabled({ env, home, pluginOptions }: { env: Env; home: string; pluginOptions?: Readonly<Record<string, unknown>> }): Promise<boolean> {
  let handle;
  try {
    if (pluginOptions?.signInReminder === false) return false;
    if (["1", "true", "yes"].includes(env.ARMORIQ_SIGNIN_REMINDER_DISABLED?.trim().toLowerCase() ?? "")) return false;
    handle = await open(path.join(home, ".armoriq/settings.json"), READ_FLAGS);
    if (!(await handle.stat()).isFile()) return false;
    const settings: unknown = JSON.parse(await handle.readFile("utf8"));
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
    return !Object.hasOwn(settings, "signInReminder") || (settings as Record<string, unknown>).signInReminder === true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function claim(dir: string, name: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(path.join(dir, name), "wx", 0o600);
    await handle.close();
    return true;
  } catch { return false; }
}

async function claimReminder(dir: string, day: string): Promise<boolean> {
  if (!await claim(dir, `reminder-${day}`)) return false;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith("reminder-") || !(dayTime(day) - dayTime(name.slice(9)) > 30 * 86400000)) continue;
      const file = path.join(dir, name);
      try { if ((await lstat(file)).isFile()) await unlink(file); } catch { /* Keep the new claim. */ }
    }
  } catch { /* Cleanup never revokes a claim. */ }
  return true;
}

// Only the scheduled worker calls this. Neither settings nor claims are read on a host hook.
export async function composeMessages(options: ReachOptions, deps: ReachDependencies = {}): Promise<string> {
  const messages: string[] = [];
  try {
    const ctx = reachContext(options, deps);
    if (!ctx.environment) return "";
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    try {
      if (await pingEnabled(ctx) && await claim(reachDir(ctx.home), "notice-shown")) messages.push(NOTICE);
    } catch { /* A notice failure must not hide the reminder. */ }
    try {
      if (await reminderEnabled(ctx) && !await isSignedIn(ctx, deps)) {
        const command = loginCommand(ctx.backend);
        if (await claimReminder(countsDir(ctx.home, ctx.environment), day)) {
          messages.push(`ArmorOpenCode is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${command} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`);
        }
      }
    } catch { /* A credential or reminder failure must not hide the notice. */ }
  } catch { /* Messages are best effort. */ }
  return messages.join("\n\n");
}

export function scheduleMessages(options: ReachOptions, deps: ReachDependencies, notify: (message: string) => void | Promise<void>, settled: () => void = () => {}, eligible: () => boolean | Promise<boolean> = () => true): ReturnType<typeof setTimeout> {
  const at = (deps.now ?? Date.now)();
  const timer = (deps.setTimeout ?? setTimeout)(async () => {
    try {
      if (!await eligible()) return;
      const message = await composeMessages(options, { ...deps, now: () => at });
      if (message) await notify(message);
    } catch { /* Messages cannot change a host hook result. */ }
    finally { settled(); }
  }, 0);
  timer.unref();
  return timer;
}

export function toastMessages(message: string): string[] {
  return message.split("\n\n").filter(Boolean).map(part => {
    const tail = part.indexOf(" (hide this reminder:");
    return part.length > 300 && tail >= 0 ? part.slice(0, tail) : part;
  });
}
