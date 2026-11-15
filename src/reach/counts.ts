import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { readLogin } from "../io/credentials.ts";
import { reachContext, type ReachDependencies, type ReachOptions } from "./ping.ts";
import { APPEND_FLAGS, countsDir, dayTime, MAX_COUNT_BYTES, pingEnabled, READ_FLAGS, type Environment } from "./state.ts";

export type Metric = "plan" | "blocked" | "held";
export type LocalCounts = { day: string; plans: number; blocked: number; held: number };
const METRICS = { plan: "plans", blocked: "blocked", held: "held" } as const;
const COUNT_FILE = /^counts-(\d{4}-\d{2}-\d{2})\.ndjson(\.sending)?$/;

export async function appendCount(metric: Metric, options: ReachOptions, deps: ReachDependencies = {}): Promise<void> {
  let handle;
  try {
    const ctx = reachContext(options, deps);
    if (!ctx.environment || !await pingEnabled(ctx)) return;
    if ((deps.readLogin ?? readLogin)(ctx.env, ctx.backend) !== null) return;
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    const dir = countsDir(ctx.home, ctx.environment);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    handle = await open(path.join(dir, `counts-${day}.ndjson`), APPEND_FLAGS, 0o600);
    const stat = await handle.stat();
    const line = `${JSON.stringify({ t: metric })}\n`;
    if (!stat.isFile() || stat.size + line.length > MAX_COUNT_BYTES) return;
    // One O_APPEND write, so concurrent processes cannot interleave event lines.
    await handle.write(line);
  } catch {
    // A failed counter must not affect enforcement or tool replies.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readCounts(file: string): Promise<Buffer> {
  const handle = await open(file, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_COUNT_BYTES) throw new Error("invalid reach counter file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function settleCounts(files: readonly string[], acknowledged = false): Promise<void> {
  for (const file of files) {
    let handle;
    try {
      if (!file.endsWith(".ndjson.sending")) continue;
      if (!acknowledged) {
        const target = file.slice(0, -8);
        try {
          // Unlike rename, link cannot overwrite a late writer's new file.
          await link(file, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          const contents = await readCounts(file);
          handle = await open(target, APPEND_FLAGS, 0o600);
          if (!(await handle.stat()).isFile() || (await handle.write(contents)).bytesWritten !== contents.length) continue;
        }
      }
      await unlink(file);
    } catch {
      // Leave unacknowledged data for the next day's attempt.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

export async function collectCounts(home: string, environment: Environment, day: string, sendingFiles: string[], active: () => boolean): Promise<LocalCounts[]> {
  const dir = countsDir(home, environment);
  const time = dayTime(day);
  const localCounts: LocalCounts[] = [];
  for (const name of await readdir(dir)) {
    if (!active()) return localCounts;
    const match = COUNT_FILE.exec(name);
    if (match?.[2] && Number.isFinite(dayTime(match[1]!))) await settleCounts([path.join(dir, name)]);
  }
  const days: string[] = [];
  for (const name of await readdir(dir)) {
    if (!active()) return localCounts;
    const match = COUNT_FILE.exec(name);
    if (!match || match[2]) continue;
    const age = time - dayTime(match[1]!);
    const file = path.join(dir, name);
    try {
      if (!(await lstat(file)).isFile() || !active()) continue;
      if (age > 7 * 86400000) await unlink(file);
      else if (age > 0) days.push(match[1]!);
    } catch { /* An unreadable day remains available for a later attempt. */ }
  }
  for (const countDay of days.sort().reverse().slice(0, 7)) {
    if (!active()) break;
    const file = path.join(dir, `counts-${countDay}.ndjson`);
    const sending = `${file}.sending`;
    try {
      try { await lstat(sending); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      if (!active()) break;
      await rename(file, sending);
      sendingFiles.push(sending);
      const contents = await readCounts(sending);
      const counts: LocalCounts = { day: countDay, plans: 0, blocked: 0, held: 0 };
      for (const line of contents.toString("utf8").split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 1 || typeof entry.t !== "string" || !Object.hasOwn(METRICS, entry.t)) continue;
          const metric = METRICS[entry.t as Metric];
          counts[metric] = Math.min(100000, counts[metric] + 1);
        } catch { /* Skip malformed, partial and unknown lines. */ }
      }
      if (counts.plans || counts.blocked || counts.held) localCounts.push(counts);
    } catch {
      await settleCounts([sending]);
    }
  }
  return localCounts;
}
