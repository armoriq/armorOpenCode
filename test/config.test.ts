import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BACKEND = "http://127.0.0.1:3917";
const root = path.join(import.meta.dir, "..");

// The SDK resolves ~/.armoriq through os.homedir(), which Bun fixes at
// startup, so each case runs in its own process with its own HOME.
function loadIn(home: string, script = "", env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(
    [
      "bun",
      "-e",
      `${script}
      const { loadConfig } = await import(${JSON.stringify(path.join(root, "src/config.ts"))});
      const { apiKey, userId, userEmail, mode } = loadConfig();
      console.log(JSON.stringify({ apiKey, userId, userEmail, mode }));`,
    ],
    { cwd: root, env: { PATH: process.env.PATH, HOME: home, ARMOROPENCODE_BACKEND_ENDPOINT: BACKEND, ...env } },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

function saveLogin(product: string, backend = BACKEND) {
  return `
    const { saveLoginProfile } = await import("@armoriq/sdk-dev");
    saveLoginProfile({ backend: ${JSON.stringify(backend)}, product: ${JSON.stringify(product)},
      apiKey: "ak_${product}_0123456789abcdef", email: "dev@example.com", userId: "user-1", orgId: "org-1" });`;
}

function legacyHome(contents: Record<string, unknown>) {
  const home = mkdtempSync(path.join(tmpdir(), "armor-home-"));
  mkdirSync(path.join(home, ".armoriq"));
  writeFileSync(path.join(home, ".armoriq", "credentials.json"), JSON.stringify(contents));
  return home;
}

const freshHome = () => mkdtempSync(path.join(tmpdir(), "armor-home-"));

describe("loadConfig credentials", () => {
  test("reads the armoropencode profile the SDK saved for the configured backend", () => {
    expect(loadIn(freshHome(), saveLogin("armoropencode"))).toEqual({
      apiKey: "ak_armoropencode_0123456789abcdef",
      userId: "user-1",
      userEmail: "dev@example.com",
      mode: "enforce",
    });
  });

  test("ignores a profile saved for another product or another backend", () => {
    expect(loadIn(freshHome(), saveLogin("armorcodex")).apiKey).toBeUndefined();
    expect(loadIn(freshHome(), saveLogin("armoropencode", "https://api.armoriq.ai")).apiKey).toBeUndefined();
  });

  test("still reads a pre-0.8 single-key file", () => {
    const home = legacyHome({ apiKey: "ak_legacy_0123456789abcdef", email: "old@example.com", userId: "user-0" });
    expect(loadIn(home)).toEqual({
      apiKey: "ak_legacy_0123456789abcdef",
      userId: "user-0",
      userEmail: "old@example.com",
      mode: "enforce",
    });
  });

  test("rejects a pre-0.8 file minted for another backend or product", () => {
    expect(loadIn(legacyHome({ apiKey: "ak_legacy_0123456789abcdef", backend: "https://api.armoriq.ai" })).apiKey).toBeUndefined();
    expect(loadIn(legacyHome({ apiKey: "ak_legacy_0123456789abcdef", product: "armorclaude" })).apiKey).toBeUndefined();
  });

  test("ARMORIQ_API_KEY wins over a saved profile", () => {
    const result = loadIn(freshHome(), saveLogin("armoropencode"), { ARMORIQ_API_KEY: "ak_env" });
    expect(result).toEqual({ apiKey: "ak_env", mode: "enforce" });
  });
});
