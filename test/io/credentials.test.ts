import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { scratch } from "./helpers/stub.ts";

const CHILD = join(import.meta.dir, "./helpers/credentials-child.ts");
const BACKEND = "http://127.0.0.1:3917";

async function run(mode: string, home: string, env: Record<string, string> = {}, profile?: object): Promise<any[]> {
  const proc = Bun.spawn([process.execPath, CHILD, mode, ...(profile ? [JSON.stringify(profile)] : [])], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ARMORIQ_BACKEND_URL: BACKEND, TEST_DATA_DIR: join(home, "data"), ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(text);
}

function armoriqDir(home: string): string {
  const dir = join(home, ".armoriq");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const profile = (fields: Record<string, string>) => ({
  backend: BACKEND,
  product: "armoropencode",
  email: "dev@example.com",
  userId: "user-1",
  orgId: "org-1",
  ...fields,
});

describe("credentials", () => {
  test("no credentials means no login", async () => {
    expect(await run("read", scratch())).toEqual([null]);
  });

  test("reads the armoropencode profile for the configured backend, with the persisted device id", async () => {
    const home = scratch();
    writeFileSync(join(armoriqDir(home), "device-id"), "dev_persisted\n");
    expect(await run("read", home, {}, profile({ apiKey: "ak_live_v2" }))).toEqual([
      { backend: BACKEND, apiKey: "ak_live_v2", userId: "user-1", orgId: "org-1", email: "dev@example.com", deviceId: "dev_persisted", deviceName: hostname().trim() },
    ]);
  });

  test("another product's profile is not used", async () => {
    const home = scratch();
    expect(await run("read", home, {}, profile({ apiKey: "ak_live_claude", product: "armorclaude" }))).toEqual([null]);
  });

  test("a pre-0.8 login file is not used", async () => {
    const home = scratch();
    writeFileSync(
      join(armoriqDir(home), "credentials.json"),
      JSON.stringify({ apiKey: "ak_live_v1", email: "e@x", userId: "u", orgId: "o", savedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(await run("read", home)).toEqual([null]);
  });

  test("ARMORIQ_API_KEY wins over the saved profile", async () => {
    const home = scratch();
    expect((await run("read", home, { ARMORIQ_API_KEY: "ak_live_env" }, profile({ apiKey: "ak_live_v2" })))[0]).toMatchObject({ apiKey: "ak_live_env", userId: "" });
  });

  test("the backend defaults to production", async () => {
    const home = scratch();
    const proc = Bun.spawn([process.execPath, CHILD, "read"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, ARMORIQ_API_KEY: "ak_live_env" },
      stdout: "pipe",
    });
    expect(JSON.parse(await new Response(proc.stdout).text())[0].backend).toBe("https://api.armoriq.ai");
  });

  test("a login made while running is picked up without a restart", async () => {
    const home = scratch();
    armoriqDir(home);
    const [before, after] = await run("watch", home);
    expect(before).toBeNull();
    expect(after).toMatchObject({ apiKey: "ak_live_after_login", userId: "user-new", email: "new@example.com" });
  });

  test("a login made after the ArmorIQ directory was deleted and recreated is picked up", async () => {
    const home = scratch();
    armoriqDir(home);
    const [before, after] = await run("rewatch", home, { TEST_POLL_MS: "50" });
    expect(before).toBeNull();
    expect(after).toMatchObject({ apiKey: "ak_live_after_login" });
  });

  test("markRelogin writes a marker bound to the backend and key", async () => {
    const home = scratch();
    const [, files] = await run("relogin", home, {}, profile({ apiKey: "ak_live_v2" }));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^relogin-required-[0-9a-f]{16}$/);
  });
});
