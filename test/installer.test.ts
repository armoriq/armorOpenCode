import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INSTALL = join(ROOT, "install_armoropencode.sh");
const UNINSTALL = join(ROOT, "uninstall_armoropencode.sh");
const SDK_CLI = join(ROOT, "node_modules/@armoriq/sdk-dev/dist/cli/index.js");
const NODE = Bun.which("node");
const OPENCODE = [Bun.which("opencode"), join(process.env.HOME ?? "", ".opencode/bin/opencode")].find((p) => p && existsSync(p));
const VERSION = "0.1.0";
const SPEC = `@armoriq/armoropencode@${VERSION}`;

let loginOutcome: "approve" | "deny" = "approve";
let deviceCodeRequests = 0;
let server: ReturnType<typeof Bun.serve>;
let backend: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/auth/device/code") {
        deviceCodeRequests++;
        return Response.json({
          device_code: "dev-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: `${backend}/auth/device?code=ABCD-EFGH`,
          interval: 1,
          expires_in: 30,
        });
      }
      if (path === "/auth/device/token") {
        return loginOutcome === "approve"
          ? Response.json({ api_key: "ak_test_123", email: "dev@example.com", user_id: "user-1", org_id: "org-1" })
          : Response.json({ error: "access_denied", error_description: "denied by stub" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  backend = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

let home: string;
let bin: string;
const homes: string[] = [];

beforeEach(() => {
  loginOutcome = "approve";
  deviceCodeRequests = 0;
  home = mkdtempSync(join(tmpdir(), "aoc-installer-"));
  homes.push(home);
  bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "open"), 0o755);
  chmodSync(join(bin, "xdg-open"), 0o755);
});

function withOpencode() {
  if (OPENCODE) return symlinkSync(OPENCODE, join(bin, "opencode"));
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 1.18.31\n");
  chmodSync(join(bin, "opencode"), 0o755);
}

const configPath = (name = "opencode.json") => join(home, "xdg", "opencode", name);

function writeConfig(text: string, name = "opencode.json") {
  mkdirSync(dirname(configPath(name)), { recursive: true });
  writeFileSync(configPath(name), text);
}

async function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", script, ...args], {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
      TMPDIR: join(home),
      PATH: [bin, dirname(NODE!), "/usr/bin", "/bin"].join(":"),
      ARMORIQ_BACKEND_URL: backend,
      ARMORIQ_DASHBOARD_URL: backend,
      ARMOROPENCODE_VERSION: VERSION,
      ARMOROPENCODE_LOGIN_CLI: `${NODE} ${SDK_CLI}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: stdout + stderr };
}

const credentials = () => JSON.parse(readFileSync(join(home, ".armoriq/credentials.json"), "utf8"));
const entry = () => `["${SPEC}", {"backendUrl":"${backend}"}]`;

describe("install_armoropencode.sh", () => {
  test("fresh install on an empty HOME logs in through the device flow and writes the entry", async () => {
    withOpencode();
    const r = await run(INSTALL);
    expect(r.out).toContain("ArmorOpenCode is installed.");
    expect(r.code).toBe(0);
    expect(deviceCodeRequests).toBe(1);
    const config = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(config.plugin).toEqual([[SPEC, { backendUrl: backend }]]);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    const host = new URL(backend).host;
    expect(credentials().profiles[`armoropencode@${host}`].apiKey).toBe("ak_test_123");
  });

  test("install over a commented config keeps comments and other plugins, re-run is a no-op", async () => {
    withOpencode();
    const original = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", /* inline */
  "plugin": [
    "opencode-wakatime",
    ["some-plugin@1.2.3", { "a": 1 }]
  ],
  "model": "anthropic/claude-sonnet-5"
}
`;
    writeConfig(original, "opencode.jsonc");
    const first = await run(INSTALL);
    expect(first.code).toBe(0);
    const after = readFileSync(configPath("opencode.jsonc"), "utf8");
    expect(after).toBe(original.replace(
      `["some-plugin@1.2.3", { "a": 1 }]\n`,
      `["some-plugin@1.2.3", { "a": 1 }],\n    ${entry()}\n`,
    ));

    const second = await run(INSTALL);
    expect(second.code).toBe(0);
    expect(second.out).toContain("skipping sign-in");
    expect(second.out).toContain("already loads");
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(after);
    expect(deviceCodeRequests).toBe(1);

    const un = await run(UNINSTALL);
    expect(un.code).toBe(0);
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(original);
    expect(existsSync(join(home, ".armoriq/credentials.json"))).toBe(true);
  });

  test("a new version replaces the old entry in place and removes duplicates from other config files", async () => {
    withOpencode();
    writeConfig(`{"plugin": ["@armoriq/armoropencode@0.0.9", "x"], "share": "disabled"}\n`);
    writeConfig(`{"plugin": ["@armoriq/armoropencode"]}\n`, "config.json");
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"plugin": [${entry()}, "x"], "share": "disabled"}\n`);
    expect(readFileSync(configPath("config.json"), "utf8")).toBe(`{}\n`);
  });

  test("uninstall of an entry the installer added as a new key restores the file byte for byte", async () => {
    withOpencode();
    const original = `{\n  "theme": "opencode",\n  "autoupdate": false\n}\n`;
    writeConfig(original);
    expect((await run(INSTALL)).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toHaveLength(1);
    expect((await run(INSTALL, ["--uninstall"])).code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(original);
  });

  test("a failed login exits non-zero, never claims success, and leaves the config untouched", async () => {
    withOpencode();
    loginOutcome = "deny";
    const original = `{ "theme": "opencode" }\n`;
    writeConfig(original);
    const r = await run(INSTALL);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ArmorOpenCode was NOT installed.");
    expect(r.out).not.toContain("ArmorOpenCode is installed.");
    expect(readFileSync(configPath(), "utf8")).toBe(original);
  });

  test("a profile for a different backend does not count as logged in", async () => {
    withOpencode();
    mkdirSync(join(home, ".armoriq"));
    writeFileSync(join(home, ".armoriq/credentials.json"), JSON.stringify({
      version: 2,
      profiles: { "armoropencode@api.armoriq.ai": { backend: "https://api.armoriq.ai", product: "armoropencode", apiKey: "k" } },
    }));
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(deviceCodeRequests).toBe(1);
  });

  test("missing opencode fails cleanly before touching anything", async () => {
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("opencode was not found");
    expect(r.out).toContain("ArmorOpenCode was NOT installed.");
    expect(existsSync(join(home, "xdg"))).toBe(false);
    expect(deviceCodeRequests).toBe(0);
  });

  test("an unsupported OpenCode version is refused", async () => {
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 1.17.9\n");
    chmodSync(join(bin, "opencode"), 0o755);
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenCode >= 1.18 is required (found 1.17.9)");
  });

  test("an invalid config is reported and left unchanged, before any login", async () => {
    withOpencode();
    writeConfig(`{ "plugin": "not-an-array" }`);
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"plugin" must be an array');
    expect(readFileSync(configPath(), "utf8")).toBe(`{ "plugin": "not-an-array" }`);
    expect(deviceCodeRequests).toBe(0);
  });
});

describe("uninstall_armoropencode.sh", () => {
  test("--purge removes local plugin data but keeps credentials", async () => {
    mkdirSync(join(home, ".armoriq/armoropencode"), { recursive: true });
    writeFileSync(join(home, ".armoriq/armoropencode/outbox.log"), "x");
    writeFileSync(join(home, ".armoriq/credentials.json"), "{}");
    writeConfig(`{"plugin": ["a", "${SPEC}"]}`);
    const r = await run(UNINSTALL, ["--purge"]);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"plugin": ["a"]}`);
    expect(existsSync(join(home, ".armoriq/armoropencode"))).toBe(false);
    expect(existsSync(join(home, ".armoriq/credentials.json"))).toBe(true);
  });

  test("comments containing commas and trailing commas around the entry survive removal", async () => {
    writeConfig(`{"plugin": ["a", /* keep, this */ "${SPEC}", ], "x": 1}`);
    writeConfig(`{\n  "plugin": [\n    // only ours, for now\n    "${SPEC}"\n  ]\n}\n`, "opencode.jsonc");
    const r = await run(UNINSTALL);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"plugin": ["a" /* keep, this */ , ], "x": 1}`);
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(`{\n  "plugin": [\n    // only ours, for now\n    \n  ]\n}\n`);
  });

  test("shares the exact config editor with the installer", () => {
    const block = (file: string) => {
      const src = readFileSync(file, "utf8");
      return src.slice(src.indexOf("# >>> config-editor"), src.indexOf("# <<< config-editor"));
    };
    expect(block(UNINSTALL).length).toBeGreaterThan(1000);
    expect(block(UNINSTALL)).toBe(block(INSTALL));
  });
});

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});
