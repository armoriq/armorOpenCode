import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
// OpenCode 2 loads a local plugin directory only through one of these; it ignores package.json main and exports.
const ROOT_ENTRIES = ["index.ts", "index.js", "index.mjs"];

export const INSTALLER_COMMAND = "curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash";
export const OPENCODE2_UNGUARDED =
  `OpenCode 2 is installed, but it will not load this ArmorOpenCode install, so OpenCode 2 sessions are not guarded. Re-run the installer: ${INSTALLER_COMMAND}`;

export type OpenCode2Gap = { opencode2: string; packageRoot: string };

// Every OpenCode 2 install (npm, curl, `opencode upgrade --major`) provides an opencode2 command.
// File checks only: this runs inside the OpenCode 1 plugin at startup, so it must not spawn anything.
export function findOpenCode2Gap(
  opts: { env?: Record<string, string | undefined>; home?: string; packageRoot?: string } = {},
): OpenCode2Gap | null {
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  if (ROOT_ENTRIES.some((name) => existsSync(join(packageRoot, name)))) return null;
  const env = opts.env ?? process.env;
  const dirs = [...(env.PATH ?? "").split(delimiter), join(opts.home ?? homedir(), ".opencode", "bin")];
  const opencode2 = dirs.filter(Boolean).map((dir) => join(dir, "opencode2")).find((file) => existsSync(file));
  return opencode2 ? { opencode2, packageRoot } : null;
}
