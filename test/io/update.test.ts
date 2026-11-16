import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyStagedUpdate, resetUpdateForTests, runUpdate, startUpdate, updatePaths } from "../../src/io/update-apply.ts";
import { checkForUpdate, compareTags, parseTagListing } from "../../src/io/update-check.ts";
import { memoryLog, scratch } from "./helpers/stub.ts";

const trash: string[] = [];
const temp = (prefix: string) => {
  const dir = scratch(prefix);
  trash.push(dir);
  return dir;
};

afterEach(() => {
  resetUpdateForTests();
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const version = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;

// Local file: packages stand in for the two runtime dependencies, so staging installs them offline.
function fakeDeps(root: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const name of ["@armoriq/sdk-dev", "@opencode-ai/plugin"]) {
    const dir = join(root, name.replace("/", "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    deps[name] = `file:${dir}`;
  }
  return deps;
}

type Origin = { work: string; bare: string; deps: Record<string, string> };

function origin(): Origin {
  const root = temp("aoc-origin-");
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  git("init", "--quiet", "-b", "main", work);
  git("init", "--quiet", "--bare", "-b", "main", bare);
  git("-C", work, "remote", "add", "origin", bare);
  return { work, bare, deps: fakeDeps(join(root, "deps")) };
}

function commit(o: Origin, v: string, opts: { tag?: boolean; annotated?: boolean; branch?: string } = {}): string {
  mkdirSync(join(o.work, "src"), { recursive: true });
  writeFileSync(join(o.work, "package.json"), JSON.stringify({ name: "@armoriq/armoropencode", version: v, dependencies: o.deps }));
  writeFileSync(join(o.work, "index.ts"), `export * from "./src/plugin.ts";\n`);
  writeFileSync(join(o.work, "src", "plugin.ts"), `export const BUILD = ${JSON.stringify(`${v}-${Math.random()}`)};\n`);
  writeFileSync(join(o.work, ".gitignore"), "node_modules/\n");
  git("-C", o.work, "add", "-A");
  git("-C", o.work, "commit", "--quiet", "-m", `build ${v}`);
  if (opts.tag) git("-C", o.work, "tag", ...(opts.annotated ? ["-a", "-m", `v${v}`] : []), `v${v}`);
  git("-C", o.work, "push", "--quiet", "--tags", "origin", `HEAD:refs/heads/${opts.branch ?? "main"}`);
  return git("-C", o.work, "rev-parse", "HEAD");
}

function install(o: Origin, ref: string): { dataDir: string; live: string } {
  const dataDir = temp("aoc-data-");
  const live = updatePaths(dataDir).live;
  git("clone", "--quiet", "--depth", "1", "--branch", ref, `file://${o.bare}`, live);
  return { dataDir, live };
}

test("tags compare as numbers, and only plain release tags count", () => {
  expect(compareTags("v0.10.0", "v0.9.9")).toBe(1);
  expect(compareTags("v1.2.3", "v1.2.3")).toBe(0);
  expect(compareTags("v1.2.3-dev.1", "v1.2.3")).toBeNull();
  const listing = ["aaa\trefs/tags/v0.2.0", "bbb\trefs/tags/v0.2.0^{}", "ccc\trefs/tags/v0.3.0-rc.1", "ddd\trefs/tags/v0.1.0"].join("\n");
  expect([...parseTagListing(listing)]).toEqual([
    ["v0.2.0", "bbb"],
    ["v0.1.0", "ddd"],
  ]);
});

test("a release install stages the newest release tag beside itself and swaps it in at the next load", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  const liveHead = git("-C", live, "rev-parse", "HEAD");
  commit(o, "0.2.1-unreleased");
  const released = commit(o, "0.3.0", { tag: true, annotated: true });
  const notices: string[] = [];

  const staged = await runUpdate({ dataDir, liveDir: live, env: {}, notify: (m) => notices.push(m) });
  expect(staged).toMatchObject({ kind: "staged", staged: { kind: "release", ref: "v0.3.0", commit: released, version: "0.3.0" } });
  expect(git("-C", live, "rev-parse", "HEAD")).toBe(liveHead);
  expect(existsSync(join(updatePaths(dataDir).staged, "node_modules", "@armoriq", "sdk-dev", "package.json"))).toBe(true);

  const swap = applyStagedUpdate({ dataDir, liveDir: live, env: {}, notify: (m) => notices.push(m) });
  expect(swap).toMatchObject({ kind: "swapped", from: "0.2.0", to: { version: "0.3.0" } });
  expect(version(live)).toBe("0.3.0");
  expect(git("-C", live, "rev-parse", "HEAD")).toBe(released);
  expect(version(updatePaths(dataDir).previous)).toBe("0.2.0");
  expect(notices).toEqual([
    "ArmorOpenCode 0.3.0 was downloaded. It installs when OpenCode exits and runs from the next start.",
    "ArmorOpenCode 0.3.0 is installed and runs from the next start.",
  ]);

  // The swapped-in tree is itself a release install, so the next check finds nothing newer.
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: Date.now() + 2 * 86_400_000 })).toMatchObject({
    kind: "checked",
    track: { kind: "release", tag: "v0.3.0" },
    newer: false,
  });
});

test("a release install with no local tag, as an installer re-run leaves it, is matched to its release by commit", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true, annotated: true });
  const { dataDir, live } = install(o, "v0.2.0");
  git("-C", live, "tag", "-d", "v0.2.0");
  commit(o, "0.2.1", { tag: true });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {} })).toMatchObject({
    kind: "checked",
    track: { kind: "release", tag: "v0.2.0" },
    target: { kind: "release", tag: "v0.2.1" },
    newer: true,
  });
});

test("a dev channel install follows its branch tip, even when the version did not change", async () => {
  const o = origin();
  commit(o, "0.2.0", { branch: "dev" });
  const { dataDir, live } = install(o, "dev");
  const tip = commit(o, "0.2.0", { branch: "dev" });
  commit(o, "9.9.9", { tag: true });

  const staged = await runUpdate({ dataDir, liveDir: live, env: {} });
  expect(staged).toMatchObject({ kind: "staged", staged: { kind: "branch", ref: "dev", commit: tip } });
  expect(applyStagedUpdate({ dataDir, liveDir: live, env: {} })).toMatchObject({ kind: "swapped" });
  expect(git("-C", live, "rev-parse", "HEAD")).toBe(tip);
  expect(git("-C", live, "symbolic-ref", "--short", "HEAD")).toBe("dev");
});

test("nothing is staged when the install is current, and the check runs once a day", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  const now = 1_000_000_000_000;
  expect(await runUpdate({ dataDir, liveDir: live, env: {}, now })).toEqual({ kind: "skipped", reason: "no_update" });
  commit(o, "0.3.0", { tag: true });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: now + 3_600_000 })).toEqual({ kind: "skipped", reason: "interval" });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: now + 86_400_000 })).toMatchObject({ kind: "checked", newer: true });
  expect(existsSync(updatePaths(dataDir).staged)).toBe(false);
});

test("an unreachable remote fails quietly and backs off", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  rmSync(o.bare, { recursive: true, force: true });
  const { log, lines } = memoryLog();
  expect(await runUpdate({ dataDir, liveDir: live, env: {}, log, now: 5 })).toEqual({ kind: "skipped", reason: "no_update" });
  expect(lines.some((l) => l.message === "ArmorOpenCode update check failed")).toBe(true);
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: 6 })).toEqual({ kind: "skipped", reason: "interval" });
});

test("an untracked file does not block the swap, but a modified install is refused and keeps the staged build", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  expect(await runUpdate({ dataDir, liveDir: live, env: {} })).toMatchObject({ kind: "staged" });
  writeFileSync(join(live, "package-lock.json"), "{}\n");
  expect(applyStagedUpdate({ dataDir, liveDir: live, env: {}, now: 0 }).kind).toBe("swapped");
  rmSync(live, { recursive: true });
  rmSync(updatePaths(dataDir).previous, { recursive: true });
  git("clone", "--quiet", "--depth", "1", "--branch", "v0.2.0", `file://${o.bare}`, live);
  expect(await runUpdate({ dataDir, liveDir: live, env: {}, now: Date.now() + 2 * 86_400_000 })).toMatchObject({ kind: "staged" });
  writeFileSync(join(live, "src", "plugin.ts"), "// local edit\n");
  expect(applyStagedUpdate({ dataDir, liveDir: live, env: {} })).toEqual({ kind: "refused", reason: "the installed checkout has local modifications" });
  expect(version(live)).toBe("0.2.0");
  expect(existsSync(updatePaths(dataDir).staged)).toBe(true);
});

test("a staged build without its completion marker is never swapped in", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  await runUpdate({ dataDir, liveDir: live, env: {} });
  rmSync(updatePaths(dataDir).marker);
  expect(applyStagedUpdate({ dataDir, liveDir: live, env: {} })).toEqual({ kind: "refused", reason: "the staged tree has no completion marker" });
  expect(version(live)).toBe("0.2.0");
});

test("a staged build the installer already moved past is discarded instead of applied", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  await runUpdate({ dataDir, liveDir: live, env: {} });
  commit(o, "0.4.0", { tag: true });
  git("-C", live, "fetch", "--quiet", "--depth", "1", "origin", "refs/tags/v0.4.0:refs/tags/v0.4.0");
  git("-C", live, "checkout", "--quiet", "--detach", "v0.4.0");
  expect(applyStagedUpdate({ dataDir, liveDir: live, env: {} })).toMatchObject({ kind: "refused", reason: "staged v0.3.0 is not newer than the installed 0.4.0" });
  expect(existsSync(updatePaths(dataDir).staged)).toBe(false);
  expect(version(live)).toBe("0.4.0");
});

test("ARMOROPENCODE_NO_AUTO_UPDATE=1 stops the check, the staging and the swap", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  const env = { ARMOROPENCODE_NO_AUTO_UPDATE: "1" };
  expect(await runUpdate({ dataDir, liveDir: live, env })).toEqual({ kind: "skipped", reason: "opted_out" });
  expect(readdirSync(dataDir)).toEqual(["plugin"]);
  expect(applyStagedUpdate({ dataDir, liveDir: live, env })).toEqual({ kind: "skipped", reason: "opted_out" });
});

test("a plugin loaded from anywhere but the installer's checkout never updates itself", () => {
  const dataDir = temp("aoc-data-");
  expect(startUpdate({ dataDir, env: {} })).toEqual({ kind: "skipped", reason: "not_managed" });
  expect(readdirSync(dataDir)).toEqual([]);
});

test("a process checks in the background and swaps in what was staged only when it exits", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  let atExit: (() => void) | null = null;

  expect(startUpdate({ dataDir, env: {}, runningDir: live, onExit: (swap) => (atExit = swap) })).toEqual({ kind: "started" });
  expect(startUpdate({ dataDir, env: {}, runningDir: live })).toEqual({ kind: "skipped", reason: "already_started" });
  const marker = updatePaths(dataDir).marker;
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(100);
  expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ ref: "v0.3.0", version: "0.3.0" });
  expect(version(live)).toBe("0.2.0");

  atExit!();
  expect(version(live)).toBe("0.3.0");
  expect(existsSync(marker)).toBe(false);
});

test("restaging moves the older staged tree aside in one rename", async () => {
  const o = origin();
  commit(o, "0.2.0", { branch: "dev" });
  const { dataDir, live } = install(o, "dev");
  commit(o, "0.2.0", { branch: "dev" });
  await runUpdate({ dataDir, liveDir: live, env: {} });
  const first = git("-C", updatePaths(dataDir).staged, "rev-parse", "HEAD");
  const tip = commit(o, "0.2.0", { branch: "dev" });
  expect(await runUpdate({ dataDir, liveDir: live, env: {}, now: Date.now() + 2 * 86_400_000 })).toMatchObject({ kind: "staged", staged: { commit: tip } });
  const discarded = readdirSync(dataDir).filter((n) => n.startsWith("plugin.discard."));
  expect(discarded.length).toBe(1);
  expect(git("-C", join(dataDir, discarded[0]!), "rev-parse", "HEAD")).toBe(first);
});

test("a newer build found by a process that exits before staging is looked up again at the next start", async () => {
  const o = origin();
  commit(o, "0.2.0", { tag: true });
  const { dataDir, live } = install(o, "v0.2.0");
  commit(o, "0.3.0", { tag: true });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: 10 })).toMatchObject({ kind: "checked", newer: true });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: 20 })).toMatchObject({ kind: "checked", newer: true });
  expect(await runUpdate({ dataDir, liveDir: live, env: {}, now: 30 })).toMatchObject({ kind: "staged" });
  expect(await checkForUpdate({ dataDir, liveDir: live, env: {}, now: 40 })).toEqual({ kind: "skipped", reason: "interval" });
});
