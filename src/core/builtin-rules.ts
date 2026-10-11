import type { Decision, ToolCall } from "../types.ts";

export type BuiltinContext = {
  armoriqDir: string;
  ownTools: ReadonlySet<string>;
  shadowedTools: ReadonlySet<string>;
};

// Argument fields that name a filesystem location, per OpenCode tool. Content
// fields (write.content, edit.newString, grep.pattern) are deliberately not
// read: writing text that mentions ~/.armoriq is not access to it.
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["filePath"],
  write: ["filePath"],
  edit: ["filePath"],
  list: ["path"],
  grep: ["path", "include"],
  glob: ["pattern", "path"],
  bash: ["command", "workdir"],
};

const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.*)$/gm;

function needlesFor(armoriqDir: string): string[] {
  const dir = armoriqDir.replace(/\/+$/, "").toLowerCase();
  return [dir, "~/.armoriq", "$home/.armoriq", "${home}/.armoriq", ".armoriq/"];
}

function touchesArmoriq(value: string, needles: readonly string[]): boolean {
  const lower = value.toLowerCase();
  if (lower.trim() === ".armoriq") return true;
  return needles.some((needle) => lower.includes(needle));
}

function patchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const m of patchText.matchAll(PATCH_HEADER)) out.push(m[1]!);
  return out;
}

// Rules config cannot override: protect ~/.armoriq, refuse shadowed own-tool names.
export function checkBuiltin(call: ToolCall, ctx: BuiltinContext): Decision | null {
  if (ctx.shadowedTools.has(call.tool)) {
    return {
      kind: "deny",
      code: "own_tool_shadowed",
      reason: `an MCP tool named ${call.tool} shadows an ArmorIQ tool; every call to this name is blocked`,
      ruleId: "builtin:own_tool_shadowed",
    };
  }

  const fields = PATH_FIELDS[call.tool];
  let values: string[];
  if (fields) {
    values = [];
    for (const field of fields) {
      const v = call.args[field];
      if (typeof v === "string") values.push(v);
    }
  } else if (call.tool === "apply_patch" && typeof call.args.patchText === "string") {
    values = patchPaths(call.args.patchText);
  } else return null;

  const needles = needlesFor(ctx.armoriqDir);
  if (!values.some((v) => touchesArmoriq(v, needles))) return null;
  return {
    kind: "deny",
    code: "builtin_protected",
    reason: `${call.tool} may not access the ArmorIQ directory (${ctx.armoriqDir}); it holds credentials and guard state`,
    ruleId: "builtin:armoriq_dir",
  };
}
