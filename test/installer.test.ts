import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INSTALL = join(ROOT, "install_armoropencode.sh");
const UNINSTALL = join(ROOT, "uninstall_armoropencode.sh");
const SDK_CLI = join(ROOT, "node_modules/@armoriq/sdk/dist/cli/index.js");
const NODE = Bun.which("node");
// A real OpenCode 2 executable, for the checks that start one; tests that need it are skipped without it.
// Shell wrappers (the curl install's opencode2 execs its sibling) cannot be symlinked into the sandbox.
const OPENCODE2 = [process.env.OPENCODE2_BIN, Bun.which("opencode2"), Bun.which("opencode"), join(process.env.HOME ?? "", ".opencode/bin/opencode")]
  .map((p) => (p && existsSync(p) ? realpathSync(p) : null))
  .find((p) => p && !readFileSync(p).subarray(0, 2).equals(Buffer.from("#!"))
    && /(?:^|\D)2\.\d+\.\d+/.test(Bun.spawnSync([p, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: mkdtempSync(join(tmpdir(), "aoc-oc2-")) } }).stdout.toString()));
const NPM_ENTRY = "@armoriq/armoropencode@0.1.0";

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
let source: string;
const homes: string[] = [];

const pluginDir = () => join(home, ".armoriq/armoropencode/plugin");
const spec = () => `file://${pluginDir()}`;
const installedVersion = () => JSON.parse(readFileSync(join(pluginDir(), "package.json"), "utf8")).version;

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

// A plugin repo with stub runtime dependencies, so the git install path runs offline.
function commitVersion(version: string, tag = true) {
  const deps = { "@armoriq/sdk": `file:${join(home, "pkgs/sdk")}`, "@opencode-ai/plugin": `file:${join(home, "pkgs/plugin")}` };
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@armoriq/armoropencode", version, dependencies: deps }));
  git("-C", source, "add", "package.json");
  git("-C", source, "commit", "-q", "-m", version);
  if (tag) git("-C", source, "tag", `v${version}`);
}

function makeSource() {
  for (const [dir, name] of [["sdk", "@armoriq/sdk"], ["plugin", "@opencode-ai/plugin"]] as const) {
    mkdirSync(join(home, "pkgs", dir), { recursive: true });
    writeFileSync(join(home, "pkgs", dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  // A fresh directory each time: on the macOS runner, recreating a just-removed "source" failed with EEXIST.
  source = mkdtempSync(join(home, "source-"));
  git("-C", source, "init", "-q", "-b", "main");
}

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
  makeSource();
  commitVersion("0.1.0");
  commitVersion("0.10.0");
  commitVersion("0.9.0");
  commitVersion("0.11.0-dev", false);
});

function fakeOpencode(name: string, version: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(bin, name), 0o755);
}

const withOpencode = () => fakeOpencode("opencode", "1.19.0");
const withOpencode2 = () => symlinkSync(OPENCODE2!, join(bin, "opencode2"));

function commitEntry(name: string, text: string) {
  writeFileSync(join(source, name), text);
  git("-C", source, "add", name);
  git("-C", source, "commit", "-q", "-m", name);
  git("-C", source, "tag", "-f", "v0.10.0");
}

const DUAL_ENTRY = `export default { id: "armoropencode", server: async () => ({}), setup() {} };\n`;

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
      ARMOROPENCODE_REPO_URL: `file://${source}`,
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
const entry = () => `["${spec()}", {"backendUrl":"${backend}"}]`;

describe("install_armoropencode.sh", () => {
  test("fresh install on an empty HOME logs in through the device flow and writes the entry", async () => {
    withOpencode();
    const r = await run(INSTALL);
    expect(r.out).toContain("ArmorOpenCode is installed.");
    expect(r.code).toBe(0);
    expect(deviceCodeRequests).toBe(1);
    const config = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(config.plugin).toEqual([[spec(), { backendUrl: backend }]]);
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
    writeConfig(`{"plugin": [["${spec()}", {"backendUrl": "${backend}", "mode": "monitor"}]]}`);
    const r = await run(INSTALL, [], { ARMORIQ_BACKEND_URL: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("keeping the installed backend");
    expect(r.out).toContain("already loads");
    expect(deviceCodeRequests).toBe(1);
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[spec(), { backendUrl: backend, mode: "monitor" }]]);
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

  test("installs the newest release tag by version order, not main and not the latest tag pushed", async () => {
    withOpencode();
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(r.out).toContain("from v0.10.0");
    expect(installedVersion()).toBe("0.10.0");
  });

  test("a re-run moves an existing install to a newer release tag", async () => {
    withOpencode();
    expect((await run(INSTALL)).code).toBe(0);
    commitVersion("0.12.0");
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`updating ${pluginDir()} to v0.12.0`);
    expect(installedVersion()).toBe("0.12.0");
  });

  test("before the first release it installs main, and ARMOROPENCODE_GIT_REF still picks a branch", async () => {
    withOpencode();
    rmSync(source, { recursive: true, force: true });
    makeSource();
    commitVersion("0.1.0", false);
    git("-C", source, "branch", "dev");
    commitVersion("0.2.0-main", false);
    const first = await run(INSTALL);
    expect(first.code).toBe(0);
    expect(installedVersion()).toBe("0.2.0-main");
    const pinned = await run(INSTALL, [], { ARMOROPENCODE_GIT_REF: "dev" });
    expect(pinned.code).toBe(0);
    expect(installedVersion()).toBe("0.1.0");
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
    writeConfig(`{"plugin": ["a", "${NPM_ENTRY}"]}`);
    const r = await run(UNINSTALL, ["--purge"]);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"plugin": ["a"]}`);
    expect(existsSync(join(home, ".armoriq/armoropencode"))).toBe(false);
    expect(existsSync(join(home, ".armoriq/credentials.json"))).toBe(true);
  });

  test("comments containing commas and trailing commas around the entry survive removal", async () => {
    writeConfig(`{"plugin": ["a", /* keep, this */ "${NPM_ENTRY}", ], "x": 1}`);
    writeConfig(`{\n  "plugin": [\n    // only ours, for now\n    "${NPM_ENTRY}"\n  ]\n}\n`, "opencode.jsonc");
    const r = await run(UNINSTALL);
    expect(r.code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"plugin": ["a" /* keep, this */ , ], "x": 1}`);
    expect(readFileSync(configPath("opencode.jsonc"), "utf8")).toBe(`{\n  "plugin": [\n    // only ours, for now\n    \n  ]\n}\n`);
  });

  test("comments that belong to the next entry or key are kept when ours is first", async () => {
    writeConfig(`{"plugin": ["${NPM_ENTRY}"],\n  // Theme: synced from dotfiles\n  "theme": "x"}`);
    writeConfig(`{\n  "plugin": [\n    "${NPM_ENTRY}",\n    // wakatime needs WAKATIME_KEY\n    "opencode-wakatime"\n  ]\n}\n`, "opencode.jsonc");
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
      const repo = join(home, "repo");
      git("clone", "-q", ROOT, repo);
      git("-C", repo, "checkout", "-q", "-B", "installer-test", Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout.toString().trim());
      const env = { ARMOROPENCODE_REPO_URL: `file://${repo}`, ARMOROPENCODE_GIT_REF: "installer-test" };
      const dir = join(home, ".armoriq/armoropencode/plugin");

      const first = await run(INSTALL, [], env);
      expect(first.out).toContain("ArmorOpenCode is installed.");
      expect(first.code).toBe(0);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[`file://${dir}`, { backendUrl: backend }]]);
      for (const dep of ["@armoriq/sdk", "@opencode-ai/plugin"])
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

describe("OpenCode major detection", () => {
  test("OpenCode 2 alone and a release without a root entry: refused before login and before any config write", async () => {
    fakeOpencode("opencode", "opencode v2.0.29");
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenCode 2.0.29 at");
    expect(r.out).toContain("ArmorOpenCode v0.10.0 has no OpenCode 2 entry");
    expect(r.out).toContain("ArmorOpenCode was NOT installed.");
    expect(existsSync(join(home, "xdg"))).toBe(false);
    expect(deviceCodeRequests).toBe(0);
  });

  test("OpenCode 1 plus the opencode2 alias and no root entry: installs for 1 and says 2 is not guarded", async () => {
    withOpencode();
    fakeOpencode("opencode2", "opencode v2.0.29");
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OpenCode 1.19.0 at");
    expect(r.out).toContain("Only OpenCode 1.19.0 will be guarded.");
    expect(r.out).toContain("OpenCode 2.0.29 is NOT guarded");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[spec(), { backendUrl: backend }]]);
  });

  test("an unsupported OpenCode 1 next to OpenCode 2 is reported and does not block the install", async () => {
    fakeOpencode("opencode", "1.17.9");
    fakeOpencode("opencode2", "opencode v2.0.29");
    commitEntry("index.mjs", DUAL_ENTRY);
    const r = await run(INSTALL, [], { ARMOROPENCODE_GIT_REF: "v0.10.0" });
    expect(r.out).toContain("OpenCode 1.17.9 at");
    expect(r.out).toContain("is not supported and will not be guarded");
    expect(r.out).toContain("OpenCode 2.0.29 at");
  });

  test("a stale OpenCode 2 \"plugins\" entry becomes the single \"plugin\" tuple and keeps its options", async () => {
    withOpencode();
    writeConfig(`{"plugins": [{"package": "${spec()}", "options": {"backendUrl": "${backend}", "mode": "monitor"}}, "other"], "theme": "x"}\n`);
    const r = await run(INSTALL, [], { ARMORIQ_BACKEND_URL: "" });
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(config.plugin).toEqual([[spec(), { backendUrl: backend, mode: "monitor" }]]);
    expect(config.plugins).toEqual(["other"]);
    expect(config.theme).toBe("x");
  });
});

describe("OpenCode 2 and a config.json-only setup", () => {
  test("other plugins in config.json stop the install before login, since a new opencode.json would hide them from OpenCode 1", async () => {
    withOpencode();
    fakeOpencode("opencode2", "opencode v2.0.29");
    const original = `{"plugin": ["opencode-wakatime"], "share": "disabled"}`;
    writeConfig(original, "config.json");
    const r = await run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Rename it to opencode.json");
    expect(readFileSync(configPath("config.json"), "utf8")).toBe(original);
    expect(existsSync(configPath())).toBe(false);
    expect(deviceCodeRequests).toBe(0);
  });

  test("without OpenCode 2, config.json keeps receiving the entry next to its other plugins", async () => {
    withOpencode();
    writeConfig(`{"plugin": ["opencode-wakatime"]}`, "config.json");
    const r = await run(INSTALL);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath("config.json"), "utf8")).plugin).toEqual(["opencode-wakatime", [spec(), { backendUrl: backend }]]);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe.skipIf(!OPENCODE2)("OpenCode 2 load check (real binary)", () => {
  test(
    "a dual export at the root is confirmed active by a private OpenCode 2 server; the re-run leaves the config alone",
    async () => {
      withOpencode();
      withOpencode2();
      commitEntry("index.mjs", DUAL_ENTRY);
      const first = await run(INSTALL);
      expect(first.out).toContain(`loads ArmorOpenCode: active (`);
      expect(first.code).toBe(0);
      const after = readFileSync(configPath(), "utf8");
      // serve prints no password when one is preset; the check must not depend on the user's env.
      const again = await run(INSTALL, [], { OPENCODE_SERVER_PASSWORD: "preset", OPENCODE_SERVER_USERNAME: "someone" });
      expect(again.code).toBe(0);
      expect(again.out).toContain("loads ArmorOpenCode: active (");
      expect(readFileSync(configPath(), "utf8")).toBe(after);
      expect(existsSync(join(home, ".local/share/opencode/opencode.db"))).toBe(false);

      expect((await run(UNINSTALL)).code).toBe(0);
      expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ $schema: "https://opencode.ai/config.json" });
    },
    180_000,
  );

  const V1_ONLY_ENTRY = `export default { id: "armoropencode", server: async () => ({}) };\n`;

  test(
    "OpenCode 2 alone rejecting the entry: its load error is shown and the config is restored byte for byte",
    async () => {
      withOpencode2();
      commitEntry("index.mjs", V1_ONLY_ENTRY);
      const original = `{\n  // mine\n  "theme": "x"\n}\n`;
      writeConfig(original);
      const r = await run(INSTALL);
      expect(r.code).toBe(1);
      expect(r.out).toContain("does not load ArmorOpenCode: Plugin must export a default definition with an id and an effect or setup function");
      expect(r.out).toContain("The OpenCode config was restored.");
      expect(readFileSync(configPath(), "utf8")).toBe(original);
    },
    180_000,
  );

  test(
    "OpenCode 2 rejecting the entry next to OpenCode 1: installed for 1, and 2 is reported as not guarded",
    async () => {
      withOpencode();
      withOpencode2();
      commitEntry("index.mjs", V1_ONLY_ENTRY);
      const r = await run(INSTALL);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Only OpenCode 1.19.0 will be guarded.");
      expect(r.out).toMatch(/OpenCode 2\.\d+\.\d+ is NOT guarded/);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[spec(), { backendUrl: backend }]]);
    },
    180_000,
  );

  test(
    "with OpenCode 2 present a config.json-only setup gets the entry in opencode.json, which OpenCode 2 reads",
    async () => {
      withOpencode2();
      commitEntry("index.mjs", DUAL_ENTRY);
      writeConfig(`{"theme": "x", "plugin": ["${spec()}"]}`, "config.json");
      const r = await run(INSTALL);
      expect(r.out).toContain("loads ArmorOpenCode: active (");
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(configPath(), "utf8")).plugin).toEqual([[spec(), { backendUrl: backend }]]);
      expect(readFileSync(configPath("config.json"), "utf8")).toBe(`{"theme": "x"}`);
    },
    180_000,
  );
});

describe("uninstall with OpenCode 2 entries", () => {
  test("removes ours from \"plugin\" and every \"plugins\" form, keeps everything else", async () => {
    const dir = join(home, ".armoriq/armoropencode/plugin");
    writeConfig(`{"plugin": [["file://${dir}", {"backendUrl": "x"}], "a"], "plugins": ["${dir}", {"package": "file://${dir}"}, {"package": "b"}], "theme": "x"}`);
    const r = await run(UNINSTALL);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ plugin: ["a"], plugins: [{ package: "b" }], theme: "x" });
  });

  test("drops a \"plugins\" key that held only our entry", async () => {
    writeConfig(`{"theme": "x", "plugins": [{"package": "${NPM_ENTRY}", "options": {}}]}`);
    expect((await run(UNINSTALL)).code).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(`{"theme": "x"}`);
  });
});
