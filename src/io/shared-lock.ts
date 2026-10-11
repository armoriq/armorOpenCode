import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_WAIT_MS = 5_000;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryLock(path: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => unlink(path).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (owner && isAlive(owner)) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

// O_EXCL lockfile with stale-owner recovery, as ArmorClaude dev scripts/lib/live-usage.mjs.
export async function withLock<T>(path: string, fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
  const until = Date.now() + waitMs;
  let release = await tryLock(path);
  while (!release) {
    if (Date.now() > until) throw new Error(`${path} is held by another process`);
    await sleep(25);
    release = await tryLock(path);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}
