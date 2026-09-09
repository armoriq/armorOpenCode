#!/usr/bin/env bun
// ArmorOpenCode end-user installer.
//
// Idempotently merges (or, with --uninstall, reverses) the ArmorOpenCode
// plugin + MCP policy server entries into a user's opencode project's
// `opencode.json`. Also checks for existing ArmorIQ credentials and, if
// absent, prints guidance to run `armoriq login` (see "SCOPE DECISION" near
// `checkCredentials` below — a full browser/OAuth flow is out of scope here).
//
// Design note: the merge/removal *logic* is pure functions (no file I/O, no
// process.exit) so test/install.test.ts can exercise it without real files
// for every case. The bottom of this file wires those functions up to real
// file I/O and CLI argument parsing.
//
// Schema facts relied on below (full verified writeup in
// docs/research-notes.md, pulled from installed @opencode-ai/plugin and
// @opencode-ai/sdk .d.ts files, not docs paraphrase): opencode.json's plugin
// field is `"plugin"` (singular, never `"plugins"`), typed
// `Array<string | [string, PluginOptions]>`; MCP servers live under `"mcp"`,
// e.g. `{ "mcp": { "<name>": { "type": "local", "command": [...], "enabled": true } } }`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---- Types ----

/** `PluginOptions` per @opencode-ai/plugin's own .d.ts: `Record<string, unknown>`. */
export type PluginOptions = Record<string, unknown>;

/** A single entry in opencode.json's `plugin` array. */
export type PluginEntry = string | [string, PluginOptions];

export interface McpServerEntry {
  type: string;
  command: string[];
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * The subset of opencode.json this installer cares about. `[key: string]:
 * unknown` preserves any other top-level fields (model config, permissions,
 * etc.) untouched as we round-trip through JSON.parse/stringify.
 */
export interface OpenCodeConfig {
  plugin?: PluginEntry[];
  mcp?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ---- Constants ----

/**
 * PLACEHOLDER PLUGIN PATH. The real plugin (src/plugin.ts -> built dist
 * output) doesn't exist yet — it lands in Phase 4. Whoever lands Phase 4-6
 * must verify/update this to the real build output path (one place, here).
 */
export const PLACEHOLDER_PLUGIN_PATH = "./dist/plugin.js";

/**
 * Marker embedded in the plugin entry's PluginOptions tuple element so this
 * installer can identify "an ArmorOpenCode plugin entry" independent of the
 * literal path string. This is what makes stale-entry replacement work even
 * if PLACEHOLDER_PLUGIN_PATH changes across versions of this installer (e.g.
 * once Phase 4 repoints it to the real dist path) — no need to hardcode a
 * list of "old known paths", just look for this marker on the options object.
 * Namespaced with a "__" prefix (rather than a bare "armorOpenCode") to
 * further reduce the (already small) chance of colliding with a real option
 * the plugin itself defines once it exists.
 */
const PLUGIN_MARKER_KEY = "__armorOpenCode" as const;

export const MCP_SERVER_NAME = "armor-opencode-policy";

/**
 * PLACEHOLDER MCP SERVER COMMAND. The real ArmorOpenCode MCP policy server
 * package doesn't exist yet either (later phase). Shape mirrors the
 * confirmed-working example from docs/research-notes.md; verify/update the
 * command once the real server package name and invocation are known.
 */
function buildMcpServerEntry(): McpServerEntry {
  return {
    type: "local",
    command: ["npx", "-y", "@armoriq/armoropencode", "mcp"],
    enabled: true,
  };
}

// ---- Pure merge/removal logic: opencode.json ----

function isArmorOpenCodePluginEntry(entry: PluginEntry): boolean {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[1] === "object" &&
    entry[1] !== null &&
    (entry[1] as PluginOptions)[PLUGIN_MARKER_KEY] === true
  );
}

function makeArmorOpenCodePluginEntry(pluginPath: string): PluginEntry {
  return [pluginPath, { [PLUGIN_MARKER_KEY]: true }];
}

/**
 * Idempotently ensure `config.plugin` contains exactly one ArmorOpenCode
 * entry, pointed at `pluginPath`. If one already exists (fresh or stale, any
 * path — identified via the marker, not the path string) it is replaced in
 * place; otherwise a new entry is appended. All other entries in the array
 * are preserved untouched, in their original order.
 *
 * Returns a new config object; does not mutate the input.
 */
export function mergePluginConfig(
  config: OpenCodeConfig,
  pluginPath: string = PLACEHOLDER_PLUGIN_PATH,
): OpenCodeConfig {
  const existing = config.plugin ?? [];
  const newEntry = makeArmorOpenCodePluginEntry(pluginPath);
  const index = existing.findIndex(isArmorOpenCodePluginEntry);

  const plugin =
    index === -1
      ? [...existing, newEntry]
      : existing.map((entry, i) => (i === index ? newEntry : entry));

  return { ...config, plugin };
}

/**
 * Remove the ArmorOpenCode entry (if any) from `config.plugin`. Preserves
 * all other entries. If the array becomes empty, the `plugin` field is
 * dropped entirely (an absent field and an empty array are equivalent for
 * this schema, and dropping it keeps a fully-uninstalled config clean).
 */
export function removePluginConfig(config: OpenCodeConfig): OpenCodeConfig {
  if (!config.plugin) return { ...config };

  const plugin = config.plugin.filter((e) => !isArmorOpenCodePluginEntry(e));
  const next = { ...config };
  if (plugin.length === 0) {
    delete next.plugin;
  } else {
    next.plugin = plugin;
  }
  return next;
}

/**
 * Idempotently set `config.mcp[MCP_SERVER_NAME]`, preserving any other MCP
 * servers the user already has configured untouched.
 */
export function mergeMcpConfig(config: OpenCodeConfig): OpenCodeConfig {
  return {
    ...config,
    mcp: {
      ...(config.mcp ?? {}),
      [MCP_SERVER_NAME]: buildMcpServerEntry(),
    },
  };
}

/**
 * Remove only the `MCP_SERVER_NAME` entry from `config.mcp`, preserving any
 * other MCP servers. If `mcp` becomes empty, drop the field entirely (same
 * rationale as removePluginConfig).
 */
export function removeMcpConfig(config: OpenCodeConfig): OpenCodeConfig {
  if (!config.mcp || !(MCP_SERVER_NAME in config.mcp)) return { ...config };

  const mcp = { ...config.mcp };
  delete mcp[MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(mcp).length === 0) {
    delete next.mcp;
  } else {
    next.mcp = mcp;
  }
  return next;
}

/** Apply both the plugin and MCP merges. Idempotent; safe to call twice. */
export function applyInstallToConfig(
  config: OpenCodeConfig,
  pluginPath: string = PLACEHOLDER_PLUGIN_PATH,
): OpenCodeConfig {
  return mergeMcpConfig(mergePluginConfig(config, pluginPath));
}

/** Reverse applyInstallToConfig. Safe to call on an already-clean config. */
export function applyUninstallToConfig(config: OpenCodeConfig): OpenCodeConfig {
  return removeMcpConfig(removePluginConfig(config));
}

// ---- I/O helpers ----

function readConfigFile(path: string): OpenCodeConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as OpenCodeConfig;
}

/** Used by writeConfigFile: make sure the parent dir exists. */
function ensureParentDir(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function writeConfigFile(path: string, config: OpenCodeConfig): void {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

// ============================================================================
// Credential check / `armoriq login` guidance
//
// SCOPE DECISION: ArmorGemini's real pattern (see ~/iq/armorGemini) runs a
// full `armoriq login --product <name>` browser/OAuth flow that mints an API
// key and writes ~/.armoriq/credentials.json. Implementing that flow is out
// of scope for this config-merge installer. Instead this installer only
// *detects* whether credentials already exist and, if not, prints the
// command to run — mirroring ArmorGemini's precedence order:
//   1. ARMORIQ_API_KEY env var   2. ~/.armoriq/credentials.json's `apiKey`
// ============================================================================

export interface CredentialStatus {
  configured: boolean;
  source?: "env" | "credentials-file";
}

export function checkCredentials(
  env: NodeJS.ProcessEnv = process.env,
  credentialsFilePath: string = join(homedir(), ".armoriq", "credentials.json"),
): CredentialStatus {
  if (env.ARMORIQ_API_KEY) {
    return { configured: true, source: "env" };
  }

  if (existsSync(credentialsFilePath)) {
    try {
      const parsed = JSON.parse(readFileSync(credentialsFilePath, "utf-8"));
      if (typeof parsed?.apiKey === "string" && parsed.apiKey.length > 0) {
        return { configured: true, source: "credentials-file" };
      }
    } catch {
      // Malformed credentials.json is treated the same as "not configured".
    }
  }

  return { configured: false };
}

const LOGIN_GUIDANCE = [
  "",
  "ArmorOpenCode is not yet connected to an ArmorIQ account.",
  "Run this in a terminal to authenticate:",
  "  armoriq login --product armoropencode",
  "",
  "It opens the browser, mints an API key, and writes it to",
  "~/.armoriq/credentials.json (or set ARMORIQ_API_KEY yourself).",
].join("\n");

// ---- CLI argument parsing ----

export interface CliOptions {
  uninstall: boolean;
  configPath: string;
  pluginPath: string;
  help: boolean;
}

const DEFAULT_CONFIG_PATH = "opencode.json";

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    uninstall: false,
    configPath: DEFAULT_CONFIG_PATH,
    pluginPath: PLACEHOLDER_PLUGIN_PATH,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--uninstall":
        options.uninstall = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--config-path":
        options.configPath = requireValue(argv, ++i, "--config-path");
        break;
      case "--plugin-path":
        options.pluginPath = requireValue(argv, ++i, "--plugin-path");
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

const HELP_TEXT = `ArmorOpenCode installer

Usage:
  bun scripts/install.ts [options]

Options:
  --uninstall           Remove ArmorOpenCode from the target project instead
                         of installing it.
  --config-path <path>  Path to opencode.json (default: ./opencode.json)
  --plugin-path <path>  Plugin module path to register (default: a
                         placeholder until Phase 4-6 ship the real build).
  -h, --help             Show this help text.
`;

// ---- main() ----

export function main(argv: string[] = process.argv.slice(2)): void {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const config = readConfigFile(options.configPath);
  const nextConfig = options.uninstall
    ? applyUninstallToConfig(config)
    : applyInstallToConfig(config, options.pluginPath);
  writeConfigFile(options.configPath, nextConfig);

  if (options.uninstall) {
    console.log(`ArmorOpenCode removed from ${options.configPath}.`);
    return;
  }

  console.log(`ArmorOpenCode installed into ${options.configPath}.`);

  const credentials = checkCredentials();
  if (!credentials.configured) {
    console.log(LOGIN_GUIDANCE);
  } else {
    console.log(`\nArmorIQ credentials found (source: ${credentials.source}).`);
  }
}

// Only run the CLI when this file is executed directly (e.g. `bun
// scripts/install.ts`), not when it's imported by the test suite.
if (import.meta.main) {
  main();
}
