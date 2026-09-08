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
  describeMarkerAnomaly,
  main,
  mergeAgentsFile,
  mergeMcpConfig,
  mergePluginConfig,
  parseArgs,
  removeAgentsSection,
  removeMcpConfig,
  removePluginConfig,
  type OpenCodeConfig,
} from "../scripts/install.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function readFixtureJson(name: string): OpenCodeConfig {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

function readFixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

/**
 * Counts genuinely-installed ArmorOpenCode sections by counting a line
 * unique to the real snippet body. Deliberately not marker-counting: the
 * fence fixtures contain marker text as documentation, so a marker count
 * can't distinguish "installed" from "documented".
 */
function countRealSnippetBodies(content: string): number {
  return (
    content.split("ArmorOpenCode enforces tool-call policy for this project.")
      .length - 1
  );
}

// ---- mergePluginConfig / removePluginConfig ----

describe("mergePluginConfig", () => {
  test("adds the plugin entry to an empty config", () => {
    const config = readFixtureJson("empty.opencode.json");
    const result = mergePluginConfig(config, PLACEHOLDER_PLUGIN_PATH);
    expect(result.plugin).toEqual([
      [PLACEHOLDER_PLUGIN_PATH, { __armorOpenCode: true }],
    ]);
  });

  test("preserves existing unrelated plugin entries", () => {
    const config = readFixtureJson("unrelated.opencode.json");
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
    const config = readFixtureJson("stale.opencode.json");
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
    const config = readFixtureJson("stale.opencode.json");
    const result = removePluginConfig(config);
    expect(result.plugin).toEqual(["./some-other-plugin.js"]);
  });

  test("drops the plugin field entirely if it becomes empty", () => {
    const config: OpenCodeConfig = mergePluginConfig({}, PLACEHOLDER_PLUGIN_PATH);
    const result = removePluginConfig(config);
    expect(result.plugin).toBeUndefined();
  });

  test("is a no-op on a config with no ArmorOpenCode entry", () => {
    const config = readFixtureJson("unrelated.opencode.json");
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
    const config = readFixtureJson("unrelated.opencode.json");
    const result = mergeMcpConfig(config);
    expect(result.mcp?.["everything"]).toEqual(config.mcp!["everything"]!);
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeDefined();
  });

  test("replaces a stale armor-opencode-policy entry rather than duplicating", () => {
    const config = readFixtureJson("stale.opencode.json");
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
    const config = readFixtureJson("stale.opencode.json");
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
    const config = readFixtureJson("unrelated.opencode.json");
    const installed = applyInstallToConfig(config, PLACEHOLDER_PLUGIN_PATH);
    const uninstalled = applyUninstallToConfig(installed);
    expect(uninstalled).toEqual(config);
  });

  test("applying install twice in a row is fully idempotent", () => {
    const config = readFixtureJson("unrelated.opencode.json");
    const once = applyInstallToConfig(config, PLACEHOLDER_PLUGIN_PATH);
    const twice = applyInstallToConfig(once, PLACEHOLDER_PLUGIN_PATH);
    expect(twice).toEqual(once);
  });

  test("uninstall on a stale config cleans up the stale entries too", () => {
    const config = readFixtureJson("stale.opencode.json");
    const result = applyUninstallToConfig(config);
    expect(result.plugin).toEqual(["./some-other-plugin.js"]);
    expect(result.mcp?.[MCP_SERVER_NAME]).toBeUndefined();
    expect(result.mcp?.["everything"]).toBeDefined();
  });
});

// ---- mergeAgentsFile / removeAgentsSection ----

describe("mergeAgentsFile", () => {
  test("produces just the section for an empty file", () => {
    const result = mergeAgentsFile("");
    expect(result).toContain("ARMOROPENCODE:START");
    expect(result).toContain("ARMOROPENCODE:END");
    expect(result.startsWith("<!-- ARMOROPENCODE:START")).toBe(true);
  });

  test("appends the section, preserving unrelated existing content", () => {
    const original = readFixtureText("unrelated.AGENTS.md");
    const result = mergeAgentsFile(original);
    expect(result).toContain("Some project-specific instructions");
    expect(result).toContain("Run `bun test` before committing.");
    expect(result).toContain("ARMOROPENCODE:START");
  });

  test("replaces an existing (stale) section in place rather than duplicating it", () => {
    const original = readFixtureText("existing-section.AGENTS.md");
    const result = mergeAgentsFile(original);

    const startCount = result.split("ARMOROPENCODE:START").length - 1;
    expect(startCount).toBe(1);
    expect(result).not.toContain("STALE snippet body");
    // Content before and after the section must survive untouched.
    expect(result).toContain("Some project-specific instructions.");
    expect(result).toContain("Run `bun test` before committing.");
  });

  test("running twice is idempotent (no duplicate sections)", () => {
    const original = readFixtureText("unrelated.AGENTS.md");
    const once = mergeAgentsFile(original);
    const twice = mergeAgentsFile(once);
    expect(twice).toBe(once);
    expect(twice.split("ARMOROPENCODE:START").length - 1).toBe(1);
  });

  test("does NOT treat fenced or indented documentation examples of the marker as a real section — appends a real one instead", () => {
    const original = readFixtureText("documented-marker.AGENTS.md");
    const result = mergeAgentsFile(original);

    // Both documented examples — the triple-backtick-fenced one (marker at
    // column 0 but inside a fence) and the indented one — must survive
    // completely untouched, fences included.
    expect(result).toContain(original.replace(/\s+$/, ""));
    expect(result).toContain("This is documentation, not a live section.");
    expect(result).toContain("Indented documentation, not a live section.");
    expect(result).toContain("```markdown\n<!-- ARMOROPENCODE:START");
    // Exactly one real managed section exists, appended after the existing
    // content (the snippet body line is unique to the real snippet).
    expect(countRealSnippetBodies(result)).toBe(1);
    expect(result.trimEnd().endsWith("<!-- ARMOROPENCODE:END -->")).toBe(true);
  });

  test("replaces only the real section when the file also documents the marker inside a fence (no duplicate install)", () => {
    const original = readFixtureText("fenced-and-installed.AGENTS.md");
    const result = mergeAgentsFile(original);

    // The fenced documentation is untouched...
    expect(result).toContain("Fenced documentation, not a live section.");
    expect(result).toContain("```markdown\n<!-- ARMOROPENCODE:START");
    // ...the real section was replaced in place, not duplicated...
    expect(result).not.toContain("STALE real section body");
    expect(countRealSnippetBodies(result)).toBe(1);
    // ...and surrounding content survived.
    expect(result).toContain("Run `bun test` before committing.");
  });
});

describe("removeAgentsSection", () => {
  test("removes the section and restores unrelated content", () => {
    const original = readFixtureText("existing-section.AGENTS.md");
    const result = removeAgentsSection(original);
    expect(result).not.toContain("ARMOROPENCODE:START");
    expect(result).toContain("Some project-specific instructions.");
    expect(result).toContain("Run `bun test` before committing.");
  });

  test("is a no-op when no section is present", () => {
    const original = readFixtureText("unrelated.AGENTS.md");
    expect(removeAgentsSection(original)).toBe(original);
  });

  test("is a no-op on fenced/indented documentation examples of the marker (does not gut the fence)", () => {
    const original = readFixtureText("documented-marker.AGENTS.md");
    expect(removeAgentsSection(original)).toBe(original);
  });

  test("removes only the real section when the file also documents the marker inside a fence (uninstall really uninstalls)", () => {
    const original = readFixtureText("fenced-and-installed.AGENTS.md");
    const result = removeAgentsSection(original);

    // The real section is genuinely gone...
    expect(result).not.toContain("STALE real section body");
    // ...the fenced documentation (and its fence) is intact...
    expect(result).toContain("Fenced documentation, not a live section.");
    expect(result).toContain("```markdown\n<!-- ARMOROPENCODE:START");
    expect(result).toContain("<!-- ARMOROPENCODE:END -->\n```");
    // ...and nothing installer-managed remains to remove.
    expect(removeAgentsSection(result)).toBe(result);
    expect(result).toContain("Run `bun test` before committing.");
    // No doubled blank line left where the section used to be.
    expect(result).not.toContain("\n\n\n");
  });

  test("round-trips through a fenced documentation example unchanged", () => {
    const original = readFixtureText("documented-marker.AGENTS.md");
    expect(removeAgentsSection(mergeAgentsFile(original))).toBe(original);
  });
});

// ---- CommonMark fence rule: same delimiter char, equal-or-greater length ----

const START = "<!-- ARMOROPENCODE:START (managed by scripts/install.ts — do not edit this section by hand) -->";
const END = "<!-- ARMOROPENCODE:END -->";

/** A documented (fenced) marker example wrapped in `open`/`close` fences. */
function fencedDoc(open: string, close: string, inner = ""): string {
  return `# AGENTS.md\n\n${open}\n${inner}${START}\n## ArmorOpenCode\n\nFenced docs.\n${END}\n${close}\n\n## Build\n`;
}

describe("fenced-code detection follows CommonMark's fence rule", () => {
  test("a ~~~ line inside a ``` fence does not close it (markers stay documentation)", () => {
    // ~~~ is a different delimiter char, so it's fenced content, not a close.
    const content = fencedDoc("```markdown", "```", "~~~\n");
    expect(removeAgentsSection(content)).toBe(content);
    expect(mergeAgentsFile(content)).toContain("Fenced docs.");
    expect(countRealSnippetBodies(mergeAgentsFile(content))).toBe(1);
  });

  test("a 3-backtick fence inside a 4-backtick fence does not close it (idiomatic nesting)", () => {
    const content = fencedDoc("````markdown", "````", "```\n");
    expect(removeAgentsSection(content)).toBe(content);
    expect(countRealSnippetBodies(mergeAgentsFile(content))).toBe(1);
  });

  test("a longer closing run still closes a shorter fence", () => {
    // Opened with ```, closed with ```` — same char, longer run: a valid close.
    const content = `# AGENTS.md\n\n\`\`\`\nfenced\n\`\`\`\`\n\n${START}\n## ArmorOpenCode\n\nREAL body.\n${END}\n`;
    // The section below the closed fence is live, so it gets replaced.
    const merged = mergeAgentsFile(content);
    expect(merged).not.toContain("REAL body.");
    expect(countRealSnippetBodies(merged)).toBe(1);
  });

  test("an unclosed fence above a real section does not cause unbounded duplication, and uninstall still works", () => {
    const content = `# AGENTS.md\n\n\`\`\`\noops, never closed\n\n${START}\n## ArmorOpenCode\n\nREAL body.\n${END}\n`;
    const once = mergeAgentsFile(content);
    const twice = mergeAgentsFile(once);
    expect(countRealSnippetBodies(once)).toBe(1);
    expect(twice).toBe(once);
    // ...and uninstall genuinely removes it rather than silently no-op'ing.
    expect(removeAgentsSection(once)).not.toContain("ARMOROPENCODE:START");
  });
});

describe("describeMarkerAnomaly", () => {
  test("warns when the only marker is inside a fence", () => {
    const message = describeMarkerAnomaly(fencedDoc("```markdown", "```"));
    expect(message).toContain("inside a fenced code block");
  });

  test("warns when a marker sits below an unclosed fence", () => {
    const content = `\`\`\`\nnever closed\n\n${START}\nbody\n${END}\n`;
    expect(describeMarkerAnomaly(content)).toContain("unclosed code fence");
  });

  test("is silent for files with no marker, or a normal installed section", () => {
    expect(describeMarkerAnomaly(readFixtureText("unrelated.AGENTS.md"))).toBeNull();
    expect(
      describeMarkerAnomaly(readFixtureText("existing-section.AGENTS.md")),
    ).toBeNull();
  });

  test("round-trips: merge then remove restores original unrelated content", () => {
    const original = readFixtureText("unrelated.AGENTS.md");
    const merged = mergeAgentsFile(original);
    const restored = removeAgentsSection(merged);
    expect(restored).toBe(original);
  });

  test("merge then remove on an empty file restores empty content", () => {
    const merged = mergeAgentsFile("");
    const restored = removeAgentsSection(merged);
    expect(restored).toBe("");
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
    expect(options.agentsPath).toBe("AGENTS.md");
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
      "--agents-path",
      "/tmp/foo/AGENTS.md",
      "--plugin-path",
      "./dist/real-plugin.js",
    ]);
    expect(options.configPath).toBe("/tmp/foo/opencode.json");
    expect(options.agentsPath).toBe("/tmp/foo/AGENTS.md");
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
  let agentsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aoc-install-e2e-"));
    configPath = join(tmpDir, "opencode.json");
    agentsPath = join(tmpDir, "AGENTS.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(extraArgs: string[] = []) {
    main([
      "--config-path",
      configPath,
      "--agents-path",
      agentsPath,
      ...extraArgs,
    ]);
  }

  test("creates opencode.json and AGENTS.md from scratch when neither exists", () => {
    run();

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toEqual([
      [PLACEHOLDER_PLUGIN_PATH, { __armorOpenCode: true }],
    ]);
    expect(config.mcp[MCP_SERVER_NAME]).toBeDefined();

    const agents = readFileSync(agentsPath, "utf-8");
    expect(agents).toContain("ARMOROPENCODE:START");
  });

  test("running twice does not duplicate anything on disk", () => {
    run();
    run();

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toHaveLength(1);

    const agents = readFileSync(agentsPath, "utf-8");
    expect(agents.split("ARMOROPENCODE:START").length - 1).toBe(1);
  });

  test("--uninstall removes what install added and leaves clean files", () => {
    run();
    run(["--uninstall"]);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.plugin).toBeUndefined();
    expect(config.mcp).toBeUndefined();

    const agents = readFileSync(agentsPath, "utf-8");
    expect(agents).not.toContain("ARMOROPENCODE:START");
  });

  test("preserves pre-existing unrelated content in both files through install and uninstall", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ theme: "dark", plugin: ["./unrelated.js"] }, null, 2),
      "utf-8",
    );
    writeFileSync(agentsPath, "# My project\n\nDo not break this.\n", "utf-8");

    run();
    let config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.plugin).toContainEqual("./unrelated.js");
    let agents = readFileSync(agentsPath, "utf-8");
    expect(agents).toContain("Do not break this.");

    run(["--uninstall"]);
    config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.theme).toBe("dark");
    expect(config.plugin).toEqual(["./unrelated.js"]);
    agents = readFileSync(agentsPath, "utf-8");
    expect(agents).toBe("# My project\n\nDo not break this.\n");
  });
});
