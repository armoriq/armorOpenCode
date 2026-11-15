import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claimDay, ensureInstallId, environmentFor, pingEnabled } from "../../src/reach/state.ts";
import { contract, countsDir, home, origin, settings, validBody } from "./helpers.ts";

test("the schema checker accepts and rejects every contract example and extra rule", () => {
  for (const body of contract.examples.valid) expect(validBody(body)).toBe(true);
  for (const { body, reason } of contract.examples.invalid) expect(validBody(body), reason).toBe(false);
});

for (const [i, v] of contract.optOut.testVectors.entries()) {
  if ("plugin" in v && v.plugin !== "armoropencode") continue;
  test(`opt out vector ${i + 1} fails closed without writing reach state`, async () => {
    const dir = home();
    if ("settingsJson" in v) settings(dir, v.settingsJson);
    else if (v.settings !== null || ("settingsReadable" in v && !v.settingsReadable)) settings(dir, v.settings ?? {});
    if ("settingsReadable" in v && !v.settingsReadable) chmodSync(path.join(dir, ".armoriq/settings.json"), 0);
    expect(await pingEnabled({ home: dir, env: v.env, pluginOptions: "pluginConfig" in v ? v.pluginConfig : {} })).toBe(v.enabled);
    expect(existsSync(countsDir(dir))).toBe(false);
    expect(existsSync(path.join(dir, ".armoriq/install-id"))).toBe(false);
  });
}

test("origins match byte for byte, including scheme, user info, ports and paths", () => {
  for (const [environment, origins] of Object.entries(contract.origins)) for (const url of origins) expect(environmentFor(url)).toBe(environment as "production" | "staging");
  for (const url of ["http://api.armoriq.ai", `${origin}/`, `${origin}/prefix`, `${origin}:443`, `${origin}?q=x`, `${origin}#x`, "https://user@api.armoriq.ai", "https://API.ARMORIQ.AI", "https://api.armoriq.ai.evil.test", "http://localhost:3000", ""]) expect(environmentFor(url)).toBeNull();
});

test("install id is complete, private, reused and independent of the sign in device", async () => {
  const dir = home();
  const id = await ensureInstallId(dir);
  expect(id).toMatch(new RegExp(contract.schema.properties.installId.pattern));
  expect(await ensureInstallId(dir)).toBe(id);
  const base = path.join(dir, ".armoriq");
  expect(readFileSync(path.join(base, "install-id"), "utf8")).toBe(`${id}\n`);
  expect(lstatSync(base).mode & 0o777).toBe(0o700);
  expect(lstatSync(path.join(base, "install-id")).mode & 0o777).toBe(0o600);
  expect(readdirSync(base)).toEqual(["install-id"]);
  expect(existsSync(path.join(base, "device-id"))).toBe(false);
});

test("a stale install id candidate does not prevent publishing a new id", async () => {
  const dir = home(); const base = path.join(dir, ".armoriq");
  mkdirSync(base); writeFileSync(path.join(base, "install-id.stale.tmp"), "partial");
  expect(await ensureInstallId(dir)).toMatch(new RegExp(contract.schema.properties.installId.pattern));
  expect(readdirSync(base).sort()).toEqual(["install-id", "install-id.stale.tmp"]);
});

test("an unwritable ArmorIQ home creates neither an id nor a candidate", async () => {
  const dir = home(); const base = path.join(dir, ".armoriq");
  mkdirSync(base, { mode: 0o500 });
  try { expect(await ensureInstallId(dir)).toBeNull(); expect(readdirSync(base)).toEqual([]); }
  finally { chmodSync(base, 0o700); }
});

for (const kind of ["symlink", "invalid", "empty", "no-newline", "unreadable", "directory"] as const) {
  test(`an existing ${kind} install id is never replaced`, async () => {
    const dir = home();
    const base = path.join(dir, ".armoriq");
    mkdirSync(base);
    const file = path.join(base, "install-id");
    if (kind === "symlink") { writeFileSync(path.join(dir, "target"), "secret"); symlinkSync(path.join(dir, "target"), file); }
    else if (kind === "directory") mkdirSync(file);
    else { writeFileSync(file, kind === "invalid" ? "bad\n" : kind === "empty" ? "" : contract.examples.valid[0]!.installId + (kind === "no-newline" ? "" : "\n")); if (kind === "unreadable") chmodSync(file, 0); }
    const before = lstatSync(file);
    expect(await ensureInstallId(dir)).toBeNull();
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(readdirSync(base)).toEqual(["install-id"]);
  });
}

async function child(mode: string, dir: string) {
  const script = mode === "id"
    ? 'import {ensureInstallId} from "./src/reach/state.ts"; console.log(await ensureInstallId(process.argv[1]));'
    : 'import {claimDay} from "./src/reach/state.ts"; console.log(await claimDay({home:process.argv[1],environment:"production",day:"2026-11-14"}));';
  const proc = Bun.spawn([process.execPath, "-e", script, dir], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim();
}
test("two processes publish the same complete install id without leftover temps", async () => {
  const dir = home();
  const ids = await Promise.all([child("id", dir), child("id", dir)]);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[0]).toMatch(new RegExp(contract.schema.properties.installId.pattern));
  expect(readdirSync(path.join(dir, ".armoriq"))).toEqual(["install-id"]);
});
test("two processes claim exactly one attempt for a UTC day", async () => {
  const dir = home();
  expect((await Promise.all([child("claim", dir), child("claim", dir)])).sort()).toEqual(["false", "true"]);
  expect(lstatSync(path.join(countsDir(dir), "ping-2026-11-14")).mode & 0o777).toBe(0o600);
});
test("daily claims survive failures and prune only valid old dates", async () => {
  const dir = home();
  const claim = (day: string, environment: "production" | "staging" = "production") => claimDay({ home: dir, environment, day });
  expect(await claim("2026-10-01")).toBe(true);
  expect(await claim("2026-10-15")).toBe(true);
  writeFileSync(path.join(countsDir(dir), "ping-invalid"), "");
  expect(await claim("2026-11-14")).toBe(true);
  expect(await claim("2026-11-14")).toBe(false);
  expect(await claim("2026-11-15")).toBe(true);
  expect(await claim("2026-11-14", "staging")).toBe(true);
  expect(await claim("2026-02-30")).toBe(false);
  expect(existsSync(path.join(countsDir(dir), "ping-2026-10-01"))).toBe(false);
  expect(existsSync(path.join(countsDir(dir), "ping-2026-10-15"))).toBe(false);
  expect(existsSync(path.join(countsDir(dir), "ping-invalid"))).toBe(true);
});
