import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Log } from "../types.ts";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 15_000;
// A staging this recent is still running in some process, or died with it; retrying sooner would
// start a second full clone and install, and a loop of short runs would start one per run.
export const STAGING_BACKOFF_MS = 60 * 60 * 1000;
export const OPT_OUT_ENV = "ARMOROPENCODE_NO_AUTO_UPDATE";
const STATE_FILE = "update-check.json";
// The installer only ever installs a plain x.y.z tag, so a prerelease tag is never offered as an update.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * What an install follows. A release tag follows the newest release tag; a branch (the dev
 * channel installs the dev branch) follows that branch's tip.
 */
export type Track = { kind: "release"; tag: string; commit: string } | { kind: "branch"; branch: string; commit: string };

export type Target = Track;

export type UpdateOutcome =
  | { kind: "skipped"; reason: "opted_out" | "interval" | "staging" | "untracked" }
  | { kind: "checked"; track: Track; target: Target; newer: boolean }
  | { kind: "failed"; reason: string };

export type CheckOptions = {
  dataDir: string;
  liveDir: string;
  log?: Log;
  env?: Record<string, string | undefined>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: number;
};

const execFileAsync = promisify(execFile);

export async function git(args: string[], timeout = 30_000, cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

const tryGit = (args: string[], timeout?: number) => git(args, timeout).catch(() => null);

export function compareTags(a: string, b: string): number | null {
  const left = RELEASE_TAG.exec(a);
  const right = RELEASE_TAG.exec(b);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// Peeled `^{}` lines win, so an annotated tag maps to its commit rather than to the tag object.
export function parseTagListing(listing: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/);
    if (!commit || !ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
    if (!RELEASE_TAG.test(name)) continue;
    if (peeled || !tags.has(name)) tags.set(name, commit);
  }
  return tags;
}

export function newestTag(tags: Map<string, string>): string | null {
  let best: string | null = null;
  for (const tag of tags.keys()) if (best === null || compareTags(tag, best)! > 0) best = tag;
  return best;
}

export const remoteUrl = (liveDir: string) => tryGit(["-C", liveDir, "remote", "get-url", "origin"]);

export async function listTags(url: string, timeout: number): Promise<Map<string, string>> {
  return parseTagListing(await git(["ls-remote", "--tags", url, "v*"], timeout));
}

/**
 * Reads what the installed checkout follows. An install made by re-running an older installer
 * sits detached on a release commit with no local tag, so the remote's tags are matched by commit.
 */
export async function resolveTrack(liveDir: string, remoteTags: () => Promise<Map<string, string>>): Promise<Track | null> {
  const commit = await tryGit(["-C", liveDir, "rev-parse", "HEAD"]);
  if (!commit) return null;
  const branch = await tryGit(["-C", liveDir, "symbolic-ref", "-q", "--short", "HEAD"]);
  if (branch) return { kind: "branch", branch, commit };
  const local = await tryGit(["-C", liveDir, "tag", "--points-at", "HEAD", "v*"]);
  const named = (local ?? "").split("\n").map((t) => t.trim()).filter((t) => RELEASE_TAG.test(t));
  let tag = named.sort((a, b) => compareTags(b, a)!)[0];
  if (!tag) {
    for (const [name, at] of await remoteTags()) if (at === commit && (!tag || compareTags(name, tag)! > 0)) tag = name;
  }
  return tag ? { kind: "release", tag, commit } : null;
}

type State = { lastCheckedAt?: number; latest?: string | null; stagingAt?: number };
const statePath = (dataDir: string) => path.join(dataDir, STATE_FILE);

async function readState(dataDir: string): Promise<State> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(dataDir), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as State) : {};
  } catch {
    return {};
  }
}

async function writeState(dataDir: string, state: State): Promise<void> {
  const file = statePath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, file);
}

export const recordCheck = (dataDir: string, now: number, latest: string | null) =>
  writeState(dataDir, { lastCheckedAt: now, latest }).catch(() => {});

export const markStaging = async (dataDir: string, now: number) =>
  writeState(dataDir, { ...(await readState(dataDir)), stagingAt: now }).catch(() => {});

const recent = (at: unknown, now: number, window: number) => typeof at === "number" && at <= now && now - at < window;

/**
 * Reports whether the installed checkout's remote has something newer. It never writes the checkout.
 * Every outcome but a newer build starts the daily backoff, offline and failed checks included. A
 * newer build starts it only once staged; a staging cut off by its process exiting is retried after an hour.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateOutcome> {
  const env = opts.env ?? process.env;
  if (env[OPT_OUT_ENV] === "1") return { kind: "skipped", reason: "opted_out" };
  const now = opts.now ?? Date.now();
  let state: State;
  try {
    state = await readState(opts.dataDir);
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
  // A timestamp in the future comes from a clock change, and would otherwise suppress every check.
  if (recent(state.lastCheckedAt, now, opts.intervalMs ?? CHECK_INTERVAL_MS)) return { kind: "skipped", reason: "interval" };
  if (recent(state.stagingAt, now, STAGING_BACKOFF_MS)) return { kind: "skipped", reason: "staging" };
  const outcome = await lookUp(opts);
  if (outcome.kind !== "checked") await recordCheck(opts.dataDir, now, state.latest ?? null);
  else if (!outcome.newer) await recordCheck(opts.dataDir, now, outcome.target.kind === "release" ? outcome.target.tag : outcome.target.commit);
  else opts.log?.info("a newer ArmorOpenCode build is available", { track: outcome.track, target: outcome.target });
  return outcome;
}

async function lookUp(opts: CheckOptions): Promise<UpdateOutcome> {
  const timeout = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  try {
    const url = await remoteUrl(opts.liveDir);
    if (!url) return { kind: "skipped", reason: "untracked" };
    let tags: Map<string, string> | null = null;
    const remoteTags = async () => (tags ??= await listTags(url, timeout));
    const track = await resolveTrack(opts.liveDir, remoteTags);
    if (!track) return { kind: "skipped", reason: "untracked" };

    let target: Target;
    if (track.kind === "release") {
      const all = await remoteTags();
      const tag = newestTag(all);
      if (!tag) return { kind: "failed", reason: `${url} has no release tags` };
      target = { kind: "release", tag, commit: all.get(tag)! };
    } else {
      const line = await git(["ls-remote", "--heads", url, `refs/heads/${track.branch}`], timeout);
      const commit = line.split(/\s+/)[0];
      if (!commit) return { kind: "failed", reason: `${url} has no branch ${track.branch}` };
      target = { kind: "branch", branch: track.branch, commit };
    }
    const newer = target.kind === "release" && track.kind === "release" ? compareTags(target.tag, track.tag)! > 0 : target.commit !== track.commit;
    return { kind: "checked", track, target, newer };
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}
