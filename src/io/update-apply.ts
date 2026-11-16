import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Log } from "../types.ts";
import { checkForUpdate, compareTags, git, markStaging, OPT_OUT_ENV, recordCheck, remoteUrl, type CheckOptions, type Target } from "./update-check.ts";

const LIVE_DIR = "plugin";
const STAGED_DIR = "plugin.staged";
const PREVIOUS_DIR = "plugin.previous";
const MARKER_FILE = "plugin.staged.json";
const STAGING_PREFIX = "plugin.staging.";
const DISCARD_PREFIX = "plugin.discard.";

// The installer verifies the same files before it calls an install finished.
export const REQUIRED_DEPS = ["@armoriq/sdk-dev", "@opencode-ai/plugin"];
const REQUIRED_FILES = ["index.ts", path.join("src", "plugin.ts")];

const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 15_000;
const STALE_STAGING_MS = 6 * 60 * 60 * 1000;
// A process ended by a signal it does not handle never runs its exit swap. Applying at start lets a
// process that already loaded the old tree resolve later lazy imports from the new one, so a build
// is applied at start only once it has waited this long for a clean exit.
export const START_SWAP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const START_SWAP_DELAY_MS = 5_000;

export type Notify = (message: string) => void;

export type UpdateOptions = CheckOptions & { notify?: Notify };

export type Staged = { kind: "release" | "branch"; ref: string; commit: string; version: string };

export type StageOutcome =
  | { kind: "skipped"; reason: "opted_out" | "no_update" | "no_install" | "already_staged" }
  | { kind: "staged"; staged: Staged }
  | { kind: "failed"; reason: string };

export type SwapOutcome =
  | { kind: "skipped"; reason: "opted_out" | "nothing_staged" | "waiting_for_exit" }
  | { kind: "swapped"; from: string; to: Staged }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };

export type Paths = { live: string; staged: string; previous: string; marker: string };

export const updatePaths = (dataDir: string): Paths => ({
  live: path.join(dataDir, LIVE_DIR),
  staged: path.join(dataDir, STAGED_DIR),
  previous: path.join(dataDir, PREVIOUS_DIR),
  marker: path.join(dataDir, MARKER_FILE),
});

const execFileAsync = promisify(execFile);

// notify reaches into the host, so a throw there must not undo an outcome that already happened.
function announce(opts: UpdateOptions, message: string): void {
  try {
    opts.notify?.(message);
  } catch {}
}

function packageVersion(dir: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

function gitSync(dir: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

const label = (s: Pick<Staged, "kind" | "ref" | "commit" | "version">) =>
  s.kind === "release" ? s.version : `${s.version} (${s.ref} ${s.commit.slice(0, 7)})`;

function missingFile(dir: string): string | null {
  for (const file of REQUIRED_FILES) if (!existsSync(path.join(dir, file))) return file;
  for (const dep of REQUIRED_DEPS) if (!existsSync(path.join(dir, "node_modules", dep, "package.json"))) return dep;
  return null;
}

function firstStagedAt(marker: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { firstStagedAt?: unknown; stagedAt?: unknown };
    const at = parsed.firstStagedAt ?? parsed.stagedAt;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

export function verifyStaged(dataDir: string): { ok: true; staged: Staged } | { ok: false; reason: string } {
  const paths = updatePaths(dataDir);
  if (!existsSync(paths.staged)) return { ok: false, reason: "nothing is staged" };
  let parsed: Partial<Staged>;
  try {
    parsed = JSON.parse(readFileSync(paths.marker, "utf8"));
  } catch {
    return { ok: false, reason: "the staged tree has no completion marker" };
  }
  const { kind, ref, commit, version } = parsed;
  if ((kind !== "release" && kind !== "branch") || typeof ref !== "string" || typeof commit !== "string" || typeof version !== "string")
    return { ok: false, reason: "the completion marker is unreadable" };
  const head = gitSync(paths.staged, ["rev-parse", "HEAD"]);
  if (head !== commit) return { ok: false, reason: `the staged tree is at ${head ?? "no commit"}, its marker says ${commit}` };
  if (packageVersion(paths.staged) !== version) return { ok: false, reason: `the staged tree does not report version ${version}` };
  const missing = missingFile(paths.staged);
  if (missing) return { ok: false, reason: `the staged tree is missing ${missing}` };
  return { ok: true, staged: { kind, ref, commit, version } };
}

// Decided from the checkout alone: the swap runs on the plugin's load path and must not touch the network.
// A stale reason means the staged tree can never apply, so it is removed rather than kept on disk.
function supersedes(live: string, staged: Staged): { reason: string; stale: boolean } | null {
  const refuse = (reason: string, stale = false) => ({ reason, stale });
  const installed = packageVersion(live);
  if (installed === null) return refuse("the installed checkout has no readable version");
  const commit = gitSync(live, ["rev-parse", "HEAD"]);
  if (commit === null) return refuse("the installed checkout is not a readable git checkout");
  if (commit === staged.commit) return refuse("the staged build is already installed", true);
  const branch = gitSync(live, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (staged.kind === "branch") {
    if (branch !== staged.ref) return refuse(`the installed checkout follows ${branch ?? "a release"}, the staged build ${staged.ref}`, true);
    return null;
  }
  if (branch) return refuse(`the installed checkout follows the ${branch} branch, not releases`, true);
  const ahead = compareTags(staged.ref, `v${installed}`);
  if (ahead === null || ahead <= 0) return refuse(`staged ${staged.ref} is not newer than the installed ${installed}`, true);
  return null;
}

/**
 * Swaps a staged build onto the install path. Synchronous and rename-only once it commits, so the
 * install path is never absent for longer than one rename even if the process dies here. It runs
 * as the process exits: a process that kept running would resolve its lazy imports, such as the
 * SDK, from the new tree while still running the old code.
 */
export function applyStagedUpdate(opts: UpdateOptions, minWaitMs = 0): SwapOutcome {
  const env = opts.env ?? process.env;
  try {
    if (env[OPT_OUT_ENV] === "1") return { kind: "skipped", reason: "opted_out" };
    const paths = updatePaths(opts.dataDir);
    if (!existsSync(paths.staged)) return { kind: "skipped", reason: "nothing_staged" };
    if (minWaitMs > 0) {
      const waitingSince = firstStagedAt(paths.marker);
      if (waitingSince === null || (opts.now ?? Date.now()) - waitingSince < minWaitMs) return { kind: "skipped", reason: "waiting_for_exit" };
    }

    const verified = verifyStaged(opts.dataDir);
    if (!verified.ok) return { kind: "refused", reason: verified.reason };
    const refusal = supersedes(paths.live, verified.staged);
    if (refusal) {
      if (refusal.stale) {
        rmSync(paths.marker, { force: true });
        renameSync(paths.staged, path.join(opts.dataDir, `${DISCARD_PREFIX}${randomUUID().slice(0, 8)}`));
      }
      return { kind: "refused", reason: refusal.reason };
    }
    // Untracked files do not count: the installer's npm install leaves a package-lock.json behind.
    const changes = gitSync(paths.live, ["status", "--porcelain", "--untracked-files=no"]);
    if (changes === null) return { kind: "refused", reason: "the installed checkout is not a readable git checkout" };
    if (changes !== "") return { kind: "refused", reason: "the installed checkout has local modifications" };
    const from = packageVersion(paths.live)!;

    if (existsSync(paths.previous)) renameSync(paths.previous, path.join(opts.dataDir, `${DISCARD_PREFIX}${randomUUID().slice(0, 8)}`));
    renameSync(paths.live, paths.previous);
    try {
      renameSync(paths.staged, paths.live);
    } catch (error) {
      renameSync(paths.previous, paths.live);
      throw error;
    }
    rmSync(paths.marker, { force: true });

    opts.log?.info("applied a staged ArmorOpenCode build", { from, to: verified.staged });
    announce(opts, `ArmorOpenCode ${label(verified.staged)} is installed and runs from the next start.`);
    return { kind: "swapped", from, to: verified.staged };
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}

async function chooseInstall(env: Record<string, string | undefined>): Promise<{ cmd: string; args: string[] } | null> {
  const probe = (cmd: string) =>
    execFileAsync(cmd, ["--version"], { timeout: PROBE_TIMEOUT_MS }).then(
      () => true,
      () => false,
    );
  for (const bun of ["bun", path.join(env.HOME ?? homedir(), ".bun", "bin", "bun")]) {
    if (await probe(bun)) return { cmd: bun, args: ["install", "--production", "--silent"] };
  }
  if (await probe("npm")) return { cmd: "npm", args: ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"] };
  return null;
}

/**
 * Builds the next version in a sibling directory. The install path is read but never written
 * until the swap, so a failure anywhere here leaves the running install exactly as it was.
 */
export async function stageBuild(opts: UpdateOptions & { url: string; target: Target }): Promise<StageOutcome> {
  const env = opts.env ?? process.env;
  const paths = updatePaths(opts.dataDir);
  const ref = opts.target.kind === "release" ? opts.target.tag : opts.target.branch;
  const existing = verifyStaged(opts.dataDir);
  if (existing.ok && existing.staged.commit === opts.target.commit) return { kind: "skipped", reason: "already_staged" };

  const tmp = path.join(opts.dataDir, `${STAGING_PREFIX}${process.pid}.${randomUUID().slice(0, 8)}`);
  try {
    await git(["clone", "--quiet", "--depth", "1", "--branch", ref, opts.url, tmp], CLONE_TIMEOUT_MS);
    const commit = await git(["-C", tmp, "rev-parse", "HEAD"]);
    // A branch may move between the listing and the clone; whatever its tip is now is what gets staged.
    if (opts.target.kind === "release" && commit !== opts.target.commit)
      throw new Error(`${ref} is at ${commit}, the listing said ${opts.target.commit}`);
    const version = packageVersion(tmp);
    if (version === null) throw new Error("the build has no package version");
    if (opts.target.kind === "release" && `v${version}` !== ref) throw new Error(`release ${ref} reports version ${version}`);

    const install = await chooseInstall(env);
    if (install === null) throw new Error("neither bun nor npm is available to install the dependencies");
    await execFileAsync(install.cmd, install.args, { cwd: tmp, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const missing = missingFile(tmp);
    if (missing) throw new Error(`${missing} is missing after the dependency install`);

    const staged: Staged = { kind: opts.target.kind, ref, commit, version };
    // A newer build replacing one that never applied keeps the older wait, or a branch pushed more
    // often than START_SWAP_AFTER_MS would restart the clock forever and never apply at start.
    const now = opts.now ?? Date.now();
    const waitingSince = firstStagedAt(paths.marker) ?? now;
    // The old staged tree is moved aside in one rename, never deleted in place, so a process
    // swapping at this moment takes a complete tree or finds none.
    await rm(paths.marker, { force: true });
    if (existsSync(paths.staged)) renameSync(paths.staged, path.join(opts.dataDir, `${DISCARD_PREFIX}${randomUUID().slice(0, 8)}`));
    renameSync(tmp, paths.staged);
    // Written last, so a tree that an interrupted staging left behind is never eligible for the swap.
    writeFileSync(paths.marker, JSON.stringify({ ...staged, stagedAt: now, firstStagedAt: waitingSince }), { mode: 0o600 });

    opts.log?.info("staged an ArmorOpenCode build", staged);
    announce(opts, `ArmorOpenCode ${label(staged)} was downloaded. It installs when OpenCode exits and runs from the next start.`);
    return { kind: "staged", staged };
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    opts.log?.warn("staging an ArmorOpenCode build failed", { ref, error: String(error) });
    return { kind: "failed", reason: String(error) };
  }
}

async function prune(dataDir: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dataDir, name);
    if (name.startsWith(DISCARD_PREFIX)) {
      await rm(full, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!name.startsWith(STAGING_PREFIX)) continue;
    try {
      if (now - statSync(full).mtimeMs < STALE_STAGING_MS) continue;
    } catch {
      continue;
    }
    await rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runUpdate(opts: UpdateOptions): Promise<StageOutcome> {
  const env = opts.env ?? process.env;
  if (env[OPT_OUT_ENV] === "1") return { kind: "skipped", reason: "opted_out" };
  try {
    await prune(opts.dataDir, opts.now ?? Date.now());
    const outcome = await checkForUpdate(opts);
    if (outcome.kind === "failed") opts.log?.warn("ArmorOpenCode update check failed", { reason: outcome.reason });
    if (outcome.kind !== "checked" || !outcome.newer) return { kind: "skipped", reason: "no_update" };
    const url = await remoteUrl(opts.liveDir);
    if (!url) return { kind: "skipped", reason: "no_install" };
    await markStaging(opts.dataDir, opts.now ?? Date.now());
    const staged = await stageBuild({ ...opts, url, target: outcome.target });
    const target = outcome.target;
    await recordCheck(opts.dataDir, opts.now ?? Date.now(), target.kind === "release" ? target.tag : target.commit);
    return staged;
  } catch (error) {
    return { kind: "failed", reason: String(error) };
  }
}

const sameDir = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

// The checkout this module was loaded from. Only the installer's checkout updates itself, never a
// development clone or a test run that happens to import the plugin.
export const RUNNING_DIR = path.resolve(import.meta.dirname, "..", "..");

const TICK_MS = 60 * 60 * 1000;

// Kept on globalThis: OpenCode 2 hot-reloads the plugin after a swap, which loads a second copy of this
// module, and a second copy must not start a second timer and exit hook in the same process.
type Session = { started: boolean; ticker: ReturnType<typeof setInterval> | null; inFlight: Promise<unknown> | null };
const SESSION = Symbol.for("armoropencode.update");
const session = (): Session => ((globalThis as Record<symbol, Session>)[SESSION] ??= { started: false, ticker: null, inFlight: null });

function check(opts: UpdateOptions): void {
  const s = session();
  if (s.inFlight) return;
  s.inFlight = runUpdate(opts)
    .catch(() => {})
    .finally(() => {
      s.inFlight = null;
    });
}

export type StartOutcome = { kind: "started" } | { kind: "skipped"; reason: "already_started" | "not_managed" };

/**
 * Once per process: check now and every hour after, gated by the daily state file, because an
 * OpenCode 2 background service hosts the plugin for days; swap in whatever is staged when the
 * process exits; and, once the host has finished loading the plugin, swap in a build that has waited
 * too long for a clean exit. Swapping during setup would change the path OpenCode 2 is still loading.
 */
export function startUpdate(
  opts: Omit<UpdateOptions, "liveDir"> & { runningDir?: string; onExit?: (swap: () => void) => void; startDelayMs?: number },
): StartOutcome {
  const s = session();
  if (s.started) return { kind: "skipped", reason: "already_started" };
  s.started = true;
  const live = updatePaths(opts.dataDir).live;
  if (!sameDir(opts.runningDir ?? RUNNING_DIR, live)) return { kind: "skipped", reason: "not_managed" };
  const full = { ...opts, liveDir: live };
  const apply = (at: "start" | "exit") => {
    const swap = applyStagedUpdate(full, at === "start" ? START_SWAP_AFTER_MS : 0);
    if (swap.kind === "refused" || swap.kind === "failed") opts.log?.warn("a staged ArmorOpenCode build was not applied", { reason: swap.reason, at });
    return swap;
  };
  const onExit = opts.onExit ?? ((fn: () => void) => process.once("exit", fn));
  onExit(() => apply("exit"));
  // Long after setup has registered, so a reload OpenCode 2 starts on seeing the path change finds
  // a finished plugin to reload, as it does when a neighbouring process swaps.
  setTimeout(() => apply("start"), opts.startDelayMs ?? START_SWAP_DELAY_MS).unref?.();
  check(full);
  s.ticker = setInterval(() => check({ ...full, now: undefined }), TICK_MS);
  s.ticker.unref?.();
  return { kind: "started" };
}

export function resetUpdateForTests(): void {
  const s = session();
  if (s.ticker) clearInterval(s.ticker);
  s.started = false;
  s.ticker = null;
}
