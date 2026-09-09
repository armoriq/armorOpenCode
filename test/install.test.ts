import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigFileError,
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
  UsageError,
  type OpenCodeConfig,
} from "../scripts/install.ts";

/**
 * Counts genuinely-installed ArmorOpenCode sections by counting a line
 * unique to the real snippet body. Deliberately not marker-counting: the
 * fence test data contains marker text as documentation, so a marker count
 * can't distinguish "installed" from "documented".
 */
function countRealSnippetBodies(content: string): number {
  return (
    content.split("ArmorOpenCode enforces tool-call policy for this project.")
      .length - 1
  );
}

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

// ---- Test data: AGENTS.md files ----

/** The exact marker lines scripts/install.ts writes around its section. */
const START =
  "<!-- ARMOROPENCODE:START (managed by scripts/install.ts — do not edit this section by hand) -->";
const END = "<!-- ARMOROPENCODE:END -->";

/**
 * A triple-backtick fence, spelled once: a bare fence would end the template
 * literals below, and a delimiter length that is subtly wrong would silently
 * defuse the very edge cases these tests exist to catch.
 */
const FENCE = "```";

/** No ArmorOpenCode section at all; every byte must survive the installer. */
const UNRELATED_AGENTS = `# AGENTS.md

Some project-specific instructions for coding agents that must be preserved
exactly as-is by the installer.

## Build

Run \`bun test\` before committing.
`;

/** A real, live section from an older installer: replaced, not duplicated. */
const EXISTING_SECTION_AGENTS = `# AGENTS.md

Some project-specific instructions.

${START}
## ArmorOpenCode

This is a STALE snippet body from a previous installer version that should
be replaced, not duplicated, the next time install.ts runs.
${END}

## Build

Run \`bun test\` before committing.
`;

/**
 * Two *documentation* examples of the marker and no live section: one inside
 * a triple-backtick fence (marker lines at column 0, but fenced) and one
 * indented by four spaces. Neither may be treated as an installed section.
 */
const DOCUMENTED_MARKER_AGENTS = `# AGENTS.md

Some project-specific instructions.

Here's what ArmorOpenCode's managed section looks like, documented inside a
fenced code block. These marker lines DO start at column 0, but they're
inside a fence, so they must NOT be treated as a real managed section:

${FENCE}markdown
${START}
## ArmorOpenCode

This is documentation, not a live section.
${END}
${FENCE}

And the same thing as an indented example (also not a live section):

    ${START}
    ## ArmorOpenCode
    Indented documentation, not a live section.
    ${END}

## Build

Run \`bun test\` before committing.
`;

/** A fenced documentation example AND a real live section below it. */
const FENCED_AND_INSTALLED_AGENTS = `# AGENTS.md

This file both DOCUMENTS the marker syntax inside a fence and has a real
installed section below it. Merge must replace only the real one (never
duplicating into the fence), and uninstall must remove only the real one
(never gutting the fence).

${FENCE}markdown
${START}
## ArmorOpenCode

Fenced documentation, not a live section.
${END}
${FENCE}

${START}
## ArmorOpenCode

STALE real section body from a previous install.
${END}

## Build

Run \`bun test\` before committing.
`;

// ---- mergeAgentsFile / removeAgentsSection ----

describe("mergeAgentsFile", () => {
  test("produces just the section for an empty file", () => {
    const result = mergeAgentsFile("");
    expect(result).toContain("ARMOROPENCODE:START");
    expect(result).toContain("ARMOROPENCODE:END");
    expect(result.startsWith("<!-- ARMOROPENCODE:START")).toBe(true);
  });

  test("appends the section, preserving unrelated existing content", () => {
    const original = UNRELATED_AGENTS;
    const result = mergeAgentsFile(original);
    expect(result).toContain("Some project-specific instructions");
    expect(result).toContain("Run `bun test` before committing.");
    expect(result).toContain("ARMOROPENCODE:START");
  });

  test("replaces an existing (stale) section in place rather than duplicating it", () => {
    const original = EXISTING_SECTION_AGENTS;
    const result = mergeAgentsFile(original);

    const startCount = result.split("ARMOROPENCODE:START").length - 1;
    expect(startCount).toBe(1);
    expect(result).not.toContain("STALE snippet body");
    // Content before and after the section must survive untouched.
    expect(result).toContain("Some project-specific instructions.");
    expect(result).toContain("Run `bun test` before committing.");
  });

  test("running twice is idempotent (no duplicate sections)", () => {
    const original = UNRELATED_AGENTS;
    const once = mergeAgentsFile(original);
    const twice = mergeAgentsFile(once);
    expect(twice).toBe(once);
    expect(twice.split("ARMOROPENCODE:START").length - 1).toBe(1);
  });

  test("does NOT treat fenced or indented documentation examples of the marker as a real section — appends a real one instead", () => {
    const original = DOCUMENTED_MARKER_AGENTS;
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
    const original = FENCED_AND_INSTALLED_AGENTS;
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
    const original = EXISTING_SECTION_AGENTS;
    const result = removeAgentsSection(original);
    expect(result).not.toContain("ARMOROPENCODE:START");
    expect(result).toContain("Some project-specific instructions.");
    expect(result).toContain("Run `bun test` before committing.");
  });

  test("is a no-op when no section is present", () => {
    const original = UNRELATED_AGENTS;
    expect(removeAgentsSection(original)).toBe(original);
  });

  test("is a no-op on fenced/indented documentation examples of the marker (does not gut the fence)", () => {
    const original = DOCUMENTED_MARKER_AGENTS;
    expect(removeAgentsSection(original)).toBe(original);
  });

  test("removes only the real section when the file also documents the marker inside a fence (uninstall really uninstalls)", () => {
    const original = FENCED_AND_INSTALLED_AGENTS;
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
    const original = DOCUMENTED_MARKER_AGENTS;
    expect(removeAgentsSection(mergeAgentsFile(original))).toBe(original);
  });

  test("round-trips: merge then remove restores original unrelated content", () => {
    const original = UNRELATED_AGENTS;
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

// ---- CommonMark fence rule: same delimiter char, equal-or-greater length ----

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
    // Opened with ```, closed with ```` — same char, longer run: a valid
    // close. The balanced ``` block AFTER the section is what makes this
    // discriminating: without the `>=` half of the close rule the first
    // fence stays open, that trailing block's opener closes it instead, and
    // its closer dangles — so the section reads as documentation, not live.
    const content =
      `# AGENTS.md\n\n\`\`\`\nfenced\n\`\`\`\`\n\n` +
      `${START}\n## ArmorOpenCode\n\nREAL body.\n${END}\n\n` +
      `\`\`\`\ntrailing block\n\`\`\`\n`;
    const merged = mergeAgentsFile(content);
    expect(merged).not.toContain("REAL body.");
    expect(countRealSnippetBodies(merged)).toBe(1);
    // Same input, remove path: the section is live, so it really goes away.
    expect(removeAgentsSection(content)).not.toContain("REAL body.");
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
    expect(describeMarkerAnomaly(UNRELATED_AGENTS)).toBeNull();
    expect(
      describeMarkerAnomaly(EXISTING_SECTION_AGENTS),
    ).toBeNull();
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

  test("throws a UsageError on an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["--bogus"])).toThrow(
      "Unrecognized argument: --bogus",
    );
  });

  test("throws a UsageError when a value-taking flag is missing its value", () => {
    expect(() => parseArgs(["--config-path"])).toThrow(UsageError);
    expect(() => parseArgs(["--config-path"])).toThrow(
      "--config-path requires a value",
    );
  });
});

// ---- CLI boundary: usage errors print a message, not a stack ----

describe("CLI usage errors", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "install.ts");

  /** Runs the installer as a real subprocess so the top-level catch is exercised. */
  function runCli(args: string[]) {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args]);
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    };
  }

  test("an unrecognized flag exits 1 with the message plus usage, and no stack trace", () => {
    const { exitCode, stderr } = runCli(["--bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unrecognized argument: --bogus");
    expect(stderr).toContain("Usage:");
    // No source dump / stack frames: the give-aways are the `at ...` frames
    // and Bun's caret-annotated source excerpt.
    expect(stderr).not.toContain("scripts/install.ts:");
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test("a flag missing its value exits 1 with just the message and usage", () => {
    const { exitCode, stderr } = runCli(["--config-path"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--config-path requires a value");
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test("--help still exits 0 and prints usage on stdout", () => {
    const { exitCode, stdout } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
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

// ---- malformed opencode.json: clear failure, no auto-repair ----

describe("malformed opencode.json", () => {
  let tmpDir: string;
  let configPath: string;
  let agentsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aoc-install-malformed-"));
    configPath = join(tmpDir, "opencode.json");
    agentsPath = join(tmpDir, "AGENTS.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Writes `raw` as the config, then runs install and returns the thrown error. */
  function runWith(raw: string): ConfigFileError {
    writeFileSync(configPath, raw, "utf-8");
    let caught: unknown;
    try {
      main(["--config-path", configPath, "--agents-path", agentsPath]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigFileError);
    return caught as ConfigFileError;
  }

  test('rejects a "plugin" field that is a string, naming the file and the field', () => {
    const error = runWith(JSON.stringify({ plugin: "./one-plugin.js" }));
    expect(error.message).toContain(configPath);
    expect(error.message).toContain('"plugin" must be an array, found string');
  });

  test('rejects a "plugin" field that is an object', () => {
    const error = runWith(JSON.stringify({ plugin: { path: "./p.js" } }));
    expect(error.message).toContain('"plugin" must be an array, found object');
  });

  test('rejects a null "plugin" field (typeof null === "object")', () => {
    const error = runWith(JSON.stringify({ plugin: null }));
    expect(error.message).toContain('"plugin" must be an array, found null');
  });

  test('rejects an "mcp" field that is an array (arrays are typeof "object")', () => {
    const error = runWith(JSON.stringify({ mcp: [{ type: "local" }] }));
    expect(error.message).toContain('"mcp" must be an object, found array');
  });

  test('rejects an "mcp" field that is a string', () => {
    const error = runWith(JSON.stringify({ mcp: "everything" }));
    expect(error.message).toContain('"mcp" must be an object, found string');
  });

  test('rejects a null "mcp" field', () => {
    const error = runWith(JSON.stringify({ mcp: null }));
    expect(error.message).toContain('"mcp" must be an object, found null');
  });

  test("rejects a top-level array", () => {
    const error = runWith("[]");
    expect(error.message).toContain(
      "expected a JSON object at the top level, found array",
    );
  });

  test("rejects a top-level string", () => {
    const error = runWith('"just a string"');
    expect(error.message).toContain(
      "expected a JSON object at the top level, found string",
    );
  });

  test("rejects a top-level null", () => {
    const error = runWith("null");
    expect(error.message).toContain(
      "expected a JSON object at the top level, found null",
    );
  });

  test("rejects unparseable JSON with a message naming the file, not a bare SyntaxError", () => {
    const error = runWith("{ theme: dark, oops");
    expect(error.message).toContain(configPath);
    expect(error.message).toContain("not valid JSON");
    expect(error.name).toBe("ConfigFileError");
  });

  test("leaves the user's malformed file byte-for-byte untouched, and does not create AGENTS.md", () => {
    const raw = '{\n  "theme": "dark",\n  "plugin": "./one-plugin.js"\n}\n';
    runWith(raw);
    expect(readFileSync(configPath, "utf-8")).toBe(raw);
    expect(existsSync(agentsPath)).toBe(false);
  });

  test("--uninstall also refuses to touch a malformed file rather than rewriting it", () => {
    const raw = '{ "mcp": [] }';
    writeFileSync(configPath, raw, "utf-8");
    expect(() =>
      main([
        "--config-path",
        configPath,
        "--agents-path",
        agentsPath,
        "--uninstall",
      ]),
    ).toThrow(ConfigFileError);
    expect(readFileSync(configPath, "utf-8")).toBe(raw);
  });

  test("accepts well-formed configs unchanged (validation is not over-eager)", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        theme: "dark",
        plugin: ["./unrelated.js"],
        mcp: { everything: { type: "local", command: ["npx", "everything"] } },
        someUnknownField: [1, 2, 3],
      }),
      "utf-8",
    );
    main(["--config-path", configPath, "--agents-path", agentsPath]);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.someUnknownField).toEqual([1, 2, 3]);
    expect(config.plugin).toHaveLength(2);
    expect(config.mcp[MCP_SERVER_NAME]).toBeDefined();
  });
});

