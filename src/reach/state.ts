import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export type Environment = "production" | "staging";
export type Env = Record<string, string | undefined>;
const ORIGINS = new Map<string, Environment>([
  ["https://api.armoriq.ai", "production"],
  ["https://staging-api.armoriq.ai", "staging"],
  ["https://staging-api.armoriq.io", "staging"],
]);
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/;
export const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const APPEND_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const MAX_COUNT_BYTES = 5 * 1024 * 1024;
export const countsDir = (home: string, environment: Environment) => path.join(home, ".armoriq/reach/v1/armoropencode", environment);

export function environmentFor(origin: string): Environment | null {
  return ORIGINS.get(origin) ?? null;
}

export async function pingEnabled({ env, home, pluginOptions }: { env: Env; home: string; pluginOptions?: Readonly<Record<string, unknown>> }): Promise<boolean> {
  try {
    if (pluginOptions?.usagePing === false) return false;
    if (["1", "true"].includes(env.DO_NOT_TRACK?.trim().toLowerCase() ?? "")) return false;
    if (["1", "true", "yes"].includes(env.ARMORIQ_USAGE_PING_DISABLED?.trim().toLowerCase() ?? "")) return false;
    let handle;
    try {
      handle = await open(path.join(home, ".armoriq/settings.json"), READ_FLAGS);
      const stat = await handle.stat();
      if (!stat.isFile()) return false;
      const settings: unknown = JSON.parse(await handle.readFile("utf8"));
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
      return !Object.hasOwn(settings, "usagePing") || (settings as Record<string, unknown>).usagePing === true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
      await handle?.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function readInstallId(file: string): Promise<string | null> {
  let handle;
  try {
    if (!(await lstat(file)).isFile()) return null;
    handle = await open(file, READ_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 37) return null;
    const value = await handle.readFile("utf8");
    return value.length === 37 && INSTALL_ID.test(value) ? value.slice(0, -1) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function ensureInstallId(home: string): Promise<string | null> {
  let handle;
  let temp: string | undefined;
  try {
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    try {
      await lstat(file);
      return await readInstallId(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const candidate = path.join(dir, `install-id.${process.pid}.${randomUUID()}.tmp`);
    handle = await open(candidate, "wx", 0o600);
    temp = candidate;
    await handle.writeFile(`${id}\n`);
    await handle.close();
    handle = undefined;
    try {
      // Publish only a complete candidate. A racing plugin reads the winner.
      await link(candidate, file);
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return await readInstallId(file);
    }
    // Match the other plugins on filesystems without hard link support.
    try {
      handle = await open(file, "wx", 0o600);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? await readInstallId(file) : null;
    }
    return (await handle.write(`${id}\n`)).bytesWritten === 37 ? id : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
    if (temp) await unlink(temp).catch(() => {});
  }
}

export function dayTime(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : NaN;
}

export async function claimDay({ home, environment, day }: { home: string; environment: Environment; day: string }): Promise<boolean> {
  try {
    const time = dayTime(day);
    if (!Number.isFinite(time) || !["production", "staging"].includes(environment)) return false;
    const dir = countsDir(home, environment);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(path.join(dir, `ping-${day}`), "wx", 0o600);
    await handle.close();
    try {
      for (const name of await readdir(dir)) {
        if (!name.startsWith("ping-") || !(time - dayTime(name.slice(5)) > 30 * 86400000)) continue;
        const file = path.join(dir, name);
        try { if ((await lstat(file)).isFile()) await unlink(file); } catch { /* Leave the new claim intact. */ }
      }
    } catch { /* Cleanup never revokes a claim. */ }
    return true;
  } catch {
    return false;
  }
}
