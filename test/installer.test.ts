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

  test("a backend URL with mixed case and a trailing slash maps to the SDK's profile name", async () => {
    withOpencode();
    const mixed = `http://LocalHost:${server.port}/`;
    const first = await run(INSTALL, [], { ARMORIQ_BACKEND_URL: mixed });
    expect(first.out).toContain("ArmorOpenCode is installed.");
    expect(credentials().profiles[`armoropencode@localhost:${server.port}`]).toBeDefined();
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin[0][1]).toEqual({ backendUrl: `http://localhost:${server.port}` });
    const second = await run(INSTALL, [], { ARMORIQ_BACKEND_URL: mixed });
    expect(second.out).toContain("skipping sign-in");
    expect(deviceCodeRequests).toBe(1);
  });

  test("a re-run without ARMORIQ_BACKEND_URL keeps the installed backend and the user's extra options", async () => {
    withOpencode();
    expect((await run(INSTALL)).code).toBe(0);
    writeConfig(`{"plugin": [["${SPEC}", {"backendUrl": "${backend}", "mode": "monitor"}]]}`);
    const r = await run(INSTALL, [], { ARMORIQ_BACKEND_URL: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("keeping the installed backend");
    expect(r.out).toContain("already loads");
    expect(deviceCodeRequests).toBe(1);
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[SPEC, { backendUrl: backend, mode: "monitor" }]]);
  });

  test("a broken secondary config stops the install before login and before any write", async () => {
    withOpencode();
    writeConfig(`{ "theme": "x" }`, "opencode.jsonc");
    writeConfig(``, "config.json");
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("config.json: unexpected end of input");
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(`{ "theme": "x" }`);
    expect(deviceCodeRequests).toBe(0);
  });

  test("a read-only config is refused, not replaced", async () => {
    withOpencode();
    writeConfig(`{ "theme": "x" }`);
    chmodSync(configPath(), 0o444);
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is read-only");
    expect(readFileSync(configPath(), "utf8")).toBe(`{ "theme": "x" }`);
  });

  test("a file: spec with a quote in the path verifies", async () => {
    withOpencode();
    const r = await run(INSTALL, [], { ARMOROPENCODE_VERSION: `file:/tmp/my"pkg.tgz` });
    expect(r.out).toContain("ArmorOpenCode is installed.");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin[0][0]).toBe(`@armoriq/armoropencode@file:/tmp/my"pkg.tgz`);
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

  test("comments that belong to the next entry or key are kept when ours is first", async () => {
    writeConfig(`{"plugin": ["${SPEC}"],\n  // Theme: synced from dotfiles\n  "theme": "x"}`);
    writeConfig(`{\n  "plugin": [\n    "${SPEC}",\n    // wakatime needs WAKATIME_KEY\n    "opencode-wakatime"\n  ]\n}\n`, "opencode.jsonc");
    const r = await run(UNINSTALL);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{\n  // Theme: synced from dotfiles\n  "theme": "x"}`);
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(`{\n  "plugin": [\n    // wakatime needs WAKATIME_KEY\n    "opencode-wakatime"\n  ]\n}\n`);
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

describe("git install (the default)", () => {
  test(
    "clones the repo, installs runtime deps, points OpenCode at the checkout, updates in place, uninstall removes the code",
    async () => {
      withOpencode();
      // CI checks out a detached commit, so serve the current commit from a scratch repo under a known branch.
      const source = join(home, "source");
      const git = (...args: string[]) => expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
      git("clone", "-q", ROOT, source);
      git("-C", source, "checkout", "-q", "-B", "installer-test", Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout.toString().trim());
      const env = { ARMOROPENCODE_VERSION: "", ARMOROPENCODE_REPO_URL: `file://${source}`, ARMOROPENCODE_GIT_REF: "installer-test" };
      const dir = join(home, ".armoriq/armoropencode/plugin");

      const first = await run(INSTALL, [], env);
      expect(first.out).toContain("ArmorOpenCode is installed.");
      expect(first.code).toBe(0);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[`file://${dir}`, { backendUrl: backend }]]);
      for (const dep of ["@armoriq/sdk-dev", "@opencode-ai/plugin"])
        expect(existsSync(join(dir, "node_modules", dep, "package.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main).toBe("src/plugin.ts");

      const again = await run(INSTALL, [], env);
      expect(again.code).toBe(0);
      expect(again.out).toContain(`updating ${dir}`);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toHaveLength(1);

      const removed = await run(UNINSTALL, [], env);
      expect(removed.code).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin ?? []).toEqual([]);
      expect(credentials().profiles[`armoropencode@${new URL(backend).host}`].apiKey).toBe("ak_test_123");
    },
    240_000,
  );
});
