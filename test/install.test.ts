import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MCP_SERVER_NAME,
  PLACEHOLDER_PLUGIN_PATH,
  applyInstallToConfig,
  applyUninstallToConfig,
  checkCredentials,
  main,
  mergeMcpConfig,
  mergePluginConfig,
  parseArgs,
  removeMcpConfig,
  removePluginConfig,
  type OpenCodeConfig,
} from "../scripts/install.ts";

// ---- Test data: opencode.json configs ----
//
// Factories, not shared constants, so every test gets its own object graph
// and a test asserting the installer didn't mutate its input can't be fooled.

/** Unrelated plugin + mcp entries the installer must preserve untouched. */
function unrelatedConfig(): OpenCodeConfig {
  return {
    plugin: ["./some-other-plugin.js", ["@acme/cool-plugin", { verbose: true }]],
    mcp: {
      everything: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
        enabled: true,
      },
    },
    theme: "dark",
  };
}

/**
 * ArmorOpenCode entries from an *older* installer: a plugin entry at a stale
 * path (found only via its `__armorOpenCode` marker) and an mcp entry under
 * the managed name but with a stale command. Both replaced, never doubled.
 */
function staleConfig(): OpenCodeConfig {
  return {
    plugin: [
      "./some-other-plugin.js",
      ["./old/stale/armor-opencode-plugin.js", { __armorOpenCode: true }],
    ],
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "local",
        command: ["npx", "-y", "@armoriq/armoropencode-old-name", "mcp"],
        enabled: true,
      },
      everything: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
        enabled: true,
      },
    },
  };
}

// ---- mergePluginConfig / removePluginConfig ----

describe("mergePluginConfig", () => {
  test("adds the plugin entry to an empty config", () => {
    const result = mergePluginConfig({}, PLACEHOLDER_PLUGIN_PATH);
    expect(result.plugin).toEqual([
      [PLACEHOLDER_PLUGIN_PATH, { __armorOpenCode: true }],
    ]);
  });

  test("preserves existing unrelated plugin entries", () => {
    const config = unrelatedConfig();
    const result = mergePluginConfig(config, PLACEHOLDER_PLUGIN_PATH);

    expect(result.plugin).toContainEqual("./some-other-plugin.js");
    expect(result.plugin).toContainEqual([
      "@acme/cool-plugin",
      { verbose: true },
    ]);
    expect(result.plugin).toContainEqual([
      PLACEHOLDER_PLUGIN_PATH,
      { __armorOpenCode: true },
    ]);
    expect(result.plugin).toHaveLength(3);
  });

  test("replaces a stale ArmorOpenCode entry in place rather than duplicating it", () => {
    const config = staleConfig();
    const result = mergePluginConfig(config, PLACEHOLDER_PLUGIN_PATH);

    // Still 2 entries: the unrelated one, plus exactly one ArmorOpenCode one.
    expect(result.plugin).toHaveLength(2);
    expect(result.plugin).toContainEqual("./some-other-plugin.js");
    expect(result.plugin).toContainEqual([
      PLACEHOLDER_PLUGIN_PATH,
      { __armorOpenCode: true },
    ]);
    // The stale path must be gone.
    expect(JSON.stringify(result.plugin)).not.toContain("old/stale");
  });

  test("running twice is idempotent (no duplication)", () => {
    const once = mergePluginConfig({}, PLACEHOLDER_PLUGIN_PATH);
    const twice = mergePluginConfig(once, PLACEHOLDER_PLUGIN_PATH);
    expect(twice.plugin).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  test("does not mutate the input config", () => {
    const config: OpenCodeConfig = { plugin: ["./foo.js"] };
    const originalJson = JSON.stringify(config);
    mergePluginConfig(config, PLACEHOLDER_PLUGIN_PATH);
    expect(JSON.stringify(config)).toBe(originalJson);
  });
});

describe("removePluginConfig", () => {
  test("removes the ArmorOpenCode entry and preserves everything else", () => {
    const config = staleConfig();
    const result = removePluginConfig(config);
    expect(result.plugin).toEqual(["./some-other-plugin.js"]);
  });

  test("drops the plugin field entirely if it becomes empty", () => {
    const config: OpenCodeConfig = mergePluginConfig({}, PLACEHOLDER_PLUGIN_PATH);
    const result = removePluginConfig(config);
    expect(result.plugin).toBeUndefined();
  });

  test("is a no-op on a config with no ArmorOpenCode entry", () => {
    const config = unrelatedConfig();
    const result = removePluginConfig(config);
    expect(result.plugin).toEqual(config.plugin);
  });

  test("is safe to call on a config with no plugin field at all", () => {
    const result = removePluginConfig({});
    expect(result).toEqual({});
  });
});

// ---- mergeMcpConfig / removeMcpConfig ----

describe("mergeMcpConfig", () => {
  test("adds the mcp entry to an empty config", () => {
    const result = mergeMcpConfig({});
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeDefined();
    expect(result.mcp?.[MCP_SERVER_NAME]?.type).toBe("local");
  });

  test("preserves existing unrelated mcp servers", () => {
    const config = unrelatedConfig();
    const result = mergeMcpConfig(config);
    expect(result.mcp?.["everything"]).toEqual(config.mcp!["everything"]!);
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeDefined();
  });

  test("replaces a stale armor-opencode-policy entry rather than duplicating", () => {
    const config = staleConfig();
    const result = mergeMcpConfig(config);
    expect(Object.keys(result.mcp ?? {})).toHaveLength(2);
    expect(result.mcp?.["everything"]).toBeDefined();
    // The stale command array (old package name) must be gone.
    expect(JSON.stringify(result.mcp?.[MCP_SERVER_NAME])).not.toContain(
      "armoropencode-old-name",
    );
  });

  test("running twice is idempotent", () => {
    const once = mergeMcpConfig({});
    const twice = mergeMcpConfig(once);
    expect(twice).toEqual(once);
  });
});

describe("removeMcpConfig", () => {
  test("removes only the armor-opencode-policy server", () => {
    const config = staleConfig();
    const result = removeMcpConfig(config);
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeUndefined();
    expect(result.mcp?.["everything"]).toBeDefined();
  });

  test("drops the mcp field entirely if it becomes empty", () => {
    const config = mergeMcpConfig({});
    const result = removeMcpConfig(config);
    expect(result.mcp).toBeUndefined();
  });

  test("is a no-op when the server is absent", () => {
    const result = removeMcpConfig({});
    expect(result).toEqual({});
  });
});

// ---- applyInstallToConfig / applyUninstallToConfig (combined, round-trip) ----

describe("applyInstallToConfig + applyUninstallToConfig", () => {
  test("install then uninstall restores an empty config to empty", () => {
    const installed = applyInstallToConfig({}, PLACEHOLDER_PLUGIN_PATH);
    const uninstalled = applyUninstallToConfig(installed);
    expect(uninstalled).toEqual({});
  });

  test("install then uninstall on an unrelated config restores exactly the original", () => {
    const config = unrelatedConfig();
    const installed = applyInstallToConfig(config, PLACEHOLDER_PLUGIN_PATH);
    const uninstalled = applyUninstallToConfig(installed);
    expect(uninstalled).toEqual(config);
  });

  test("applying install twice in a row is fully idempotent", () => {
    const config = unrelatedConfig();
    const once = applyInstallToConfig(config, PLACEHOLDER_PLUGIN_PATH);
    const twice = applyInstallToConfig(once, PLACEHOLDER_PLUGIN_PATH);
    expect(twice).toEqual(once);
  });

  test("uninstall on a stale config cleans up the stale entries too", () => {
    const config = staleConfig();
    const result = applyUninstallToConfig(config);
    expect(result.plugin).toEqual(["./some-other-plugin.js"]);
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeUndefined();
    expect(result.mcp?.["everything"]).toBeDefined();
  });
});

// ---- checkCredentials ----

describe("checkCredentials", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aoc-install-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reports configured via ARMORIQ_API_KEY env var", () => {
    const status = checkCredentials(
      { ARMORIQ_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      join(tmpDir, "nonexistent-credentials.json"),
    );
    expect(status).toEqual({ configured: true, source: "env" });
  });

  test("reports configured via credentials.json", () => {
    const credsPath = join(tmpDir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify({ apiKey: "from-file" }), "utf-8");
    const status = checkCredentials({} as NodeJS.ProcessEnv, credsPath);
    expect(status).toEqual({ configured: true, source: "credentials-file" });
  });

  test("env var takes precedence over credentials.json", () => {
    const credsPath = join(tmpDir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify({ apiKey: "from-file" }), "utf-8");
    const status = checkCredentials(
      { ARMORIQ_API_KEY: "from-env" } as NodeJS.ProcessEnv,
      credsPath,
    );
    expect(status.source).toBe("env");
  });

  test("reports not configured when neither is present", () => {
    const status = checkCredentials(
      {} as NodeJS.ProcessEnv,
      join(tmpDir, "nonexistent-credentials.json"),
    );
    expect(status).toEqual({ configured: false });
  });

  test("treats malformed credentials.json as not configured", () => {
    const credsPath = join(tmpDir, "credentials.json");
    writeFileSync(credsPath, "{ not valid json", "utf-8");
    const status = checkCredentials({} as NodeJS.ProcessEnv, credsPath);
    expect(status.configured).toBe(false);
  });

  test("treats a credentials.json with no apiKey field as not configured", () => {
    const credsPath = join(tmpDir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify({ other: "field" }), "utf-8");
    const status = checkCredentials({} as NodeJS.ProcessEnv, credsPath);
    expect(status.configured).toBe(false);
  });
});

// ---- parseArgs ----

describe("parseArgs", () => {
  test("defaults", () => {
    const options = parseArgs([]);
    expect(options.uninstall).toBe(false);
    expect(options.configPath).toBe("opencode.json");
    expect(options.pluginPath).toBe(PLACEHOLDER_PLUGIN_PATH);
    expect(options.help).toBe(false);
  });

  test("--uninstall flag", () => {
    expect(parseArgs(["--uninstall"]).uninstall).toBe(true);
  });

  test("path overrides", () => {
    const options = parseArgs([
      "--config-path",
      "/tmp/foo/opencode.json",
      "--plugin-path",
      "./dist/real-plugin.js",
    ]);
    expect(options.configPath).toBe("/tmp/foo/opencode.json");
    expect(options.pluginPath).toBe("./dist/real-plugin.js");
  });

  test("throws on an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow();
  });

  test("throws when a value-taking flag is missing its value", () => {
    expect(() => parseArgs(["--config-path"])).toThrow();
  });
});

// ---- main() — end-to-end against real temp files ----

describe("main() end-to-end", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aoc-install-e2e-"));
    configPath = join(tmpDir, "opencode.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(extraArgs: string[] = []) {
    main(["--config-path", configPath, ...extraArgs]);
  }

  test("creates opencode.json from scratch when it does not exist", () => {
    run();

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toEqual([
      [PLACEHOLDER_PLUGIN_PATH, { __armorOpenCode: true }],
    ]);
    expect(config.mcp[MCP_SERVER_NAME]).toBeDefined();
  });

  test("running twice does not duplicate anything on disk", () => {
    run();
    run();

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toHaveLength(1);
  });

  test("--uninstall removes what install added and leaves a clean file", () => {
    run();
    run(["--uninstall"]);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toBeUndefined();
    expect(config.mcp).toBeUndefined();
  });

  test("preserves pre-existing unrelated content through install and uninstall", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ theme: "dark", plugin: ["./unrelated.js"] }, null, 2),
      "utf-8",
    );

    run();
    let config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.plugin).toContainEqual("./unrelated.js");

    run(["--uninstall"]);
    config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.plugin).toEqual(["./unrelated.js"]);
  });
});
