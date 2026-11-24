import path from "node:path";
import type { Decision, ToolCall } from "../types.ts";
import { baseNameMatches, BREAK, expandGlob, hasGlob, hasSegment, mayBeAncestor, mayReach, proseWords, resolveWord, shellWords, split } from "./path-match.ts";
import { patchPaths } from "./tools.ts";

export type BuiltinContext = {
  armoriqDir: string;
  ownTools: ReadonlySet<string>;
  shadowedTools: ReadonlySet<string>;
  opencodeConfigDir?: string;
  cwd?: () => string;
  realpath?: (p: string) => string;
  readdir?: (dir: string) => string[];
};

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"]);
const MUTATORS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "mv", "cp", "tee", "dd", "truncate", "chmod", "chown", "ln", "install", "rsync", "unlink", "touch", "sponge", "patch",
  "ed", "ex", "vi", "vim", "nvim", "nano", "emacs", "perl", "python", "python3", "node", "bun", "deno", "ruby", "php", "sh", "bash", "zsh",
  "fish", "xargs", "-delete", "-exec", "-execdir", "-ok", "--in-place",
]);
const GIT_MUTATORS: ReadonlySet<string> = new Set(["checkout", "restore", "rm", "mv", "apply", "reset", "stash", "clean", "am"]);
const LEADING_VARIABLE = /^\$\{[A-Za-z_]\w*\}[^/]/;

function changesFiles(command: string, words: string[]): boolean {
  if (command.includes(">")) return true;
  return words.some((w, i) => MUTATORS.has(w) || /^-i/.test(w) || (w === "git" && GIT_MUTATORS.has(words[i + 1] ?? "")));
}

// Argument fields that name a filesystem location, per OpenCode tool. Content
// fields (write.content, edit.newString, grep.pattern) are deliberately not
// read: writing text that mentions ~/.armoriq is not access to it.
const PATH_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["read", ["filePath"]],
  ["write", ["filePath"]],
  ["edit", ["filePath"]],
  ["list", ["path"]],
  ["grep", ["path", "include"]],
  ["glob", ["pattern", "path"]],
  ["bash", ["command", "workdir"]],
  ["task", ["prompt"]],
]);

// Characters that can end one path or shell word and start the next.
const BOUNDARY = new Set([..."/\\ \t\n\r\"'`=;:,|&()<>{}$"]);
const GLOB_CHARS = new Set([..."*?["]);
const SEGMENT = ".armoriq";

// True when `.armoriq` appears as a whole path segment or as a glob prefix of
// one (`.armoriq*`), in any case.
function namesArmoriqSegment(lower: string): boolean {
  for (let i = lower.indexOf(SEGMENT); i >= 0; i = lower.indexOf(SEGMENT, i + 1)) {
    const before = i === 0 ? "/" : lower[i - 1]!;
    const after = lower[i + SEGMENT.length];
    if (BOUNDARY.has(before) && (after === undefined || BOUNDARY.has(after) || GLOB_CHARS.has(after))) return true;
  }
  return false;
}

function touchesDir(value: string, dir: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes(dir) || namesArmoriqSegment(lower);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

// ripgrep runs with --hidden, so grep rooted at an ancestor of the directory
// reads its files. Only absolute and home-relative roots can be resolved here.
function isAncestorOf(root: string, dir: string, home: string | null): boolean {
  let p = trimTrailingSlashes(root.trim().toLowerCase());
  if (home !== null) p = p.replace(/^(?:~|\$home|\$\{home\})(?=\/|$)/, home);
  if (p === "") return root.trim().startsWith("/");
  return p.startsWith("/") && dir.startsWith(`${p}/`);
}

function protectedDeny(call: ToolCall, ctx: BuiltinContext): Decision {
  return {
    kind: "deny",
    code: "builtin_protected",
    reason: `${call.tool} may not access the ArmorIQ directory (${ctx.armoriqDir}); it holds credentials and guard state`,
    ruleId: "builtin:armoriq_dir",
  };
}

function configDeny(call: ToolCall, target: string): Decision {
  return {
    kind: "deny",
    code: "builtin_protected",
    reason: `${call.tool} may not change the OpenCode config (${target}); it loads the ArmorIQ guard`,
    ruleId: "builtin:opencode_config",
  };
}

function candidates(call: ToolCall, values: string[], cwd: string, home: string): string[] {
  if (call.tool === "task") return values.flatMap(proseWords).map((w) => resolveWord(w, cwd, home));
  if (call.tool === "glob" || call.tool === "grep") {
    const root = typeof call.args.path === "string" ? resolveWord(call.args.path, cwd, home) : cwd;
    const pattern = call.tool === "glob" ? call.args.pattern : call.args.include;
    const out = [root];
    if (typeof pattern === "string") out.push(resolveWord(pattern, root, home));
    return out;
  }
  if (call.tool !== "bash") return values.map((v) => resolveWord(v, cwd, home));
  let dir = typeof call.args.workdir === "string" ? resolveWord(call.args.workdir, cwd, home) : cwd;
  const out = [dir];
  const words = typeof call.args.command === "string" ? shellWords(call.args.command) : [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === BREAK) continue;
    out.push(resolveWord(word, dir, home));
    for (const piece of word.split(/["'()[\]]/)) if (piece && piece !== word) out.push(resolveWord(piece, dir, home));
    if (LEADING_VARIABLE.test(word) && !/^\$\{home\}/i.test(word)) out.push(resolveWord(`/**/${word}`, dir, home));
    if ((word === "cd" || word === "pushd") && words[i + 1] !== undefined && words[i + 1] !== BREAK) {
      dir = resolveWord(words[i + 1]!, dir, home);
    } else if (word === "cd" && (words[i + 1] === undefined || words[i + 1] === BREAK)) dir = home;
  }
  return out;
}

function realOf(ctx: BuiltinContext, p: string): string | null {
  if (!ctx.realpath) return null;
  const segs = p.split("/");
  const k = segs.findIndex(hasGlob);
  try {
    if (k < 0) return ctx.realpath(p);
    return [ctx.realpath(segs.slice(0, k).join("/") || "/"), ...segs.slice(k)].join("/");
  } catch {
    return null;
  }
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

  let values: string[];
  const fields = PATH_FIELDS.get(call.tool);
  if (fields) {
    values = [];
    for (const field of fields) {
      const v = call.args[field];
      if (typeof v === "string") values.push(v);
    }
  } else if (call.tool === "apply_patch" && typeof call.args.patchText === "string") {
    values = patchPaths(call.args.patchText);
  } else return null;

  const dir = trimTrailingSlashes(ctx.armoriqDir).toLowerCase();
  if (values.some((v) => touchesDir(v, dir))) return protectedDeny(call, ctx);

  const armoriq = trimTrailingSlashes(ctx.armoriqDir);
  const home = armoriq.toLowerCase().endsWith(`/${SEGMENT}`) ? armoriq.slice(0, -SEGMENT.length - 1) : path.dirname(armoriq);
  const cwd = ctx.cwd?.() ?? process.cwd();
  const realArmoriq = realOf(ctx, armoriq);
  const configDir = ctx.opencodeConfigDir ? trimTrailingSlashes(ctx.opencodeConfigDir) : null;
  const realConfigDir = configDir ? realOf(ctx, configDir) : null;
  const homeDepth = split(home).length;
  const armoriqForms = realArmoriq !== null && realArmoriq !== armoriq ? [armoriq, realArmoriq] : [armoriq];
  const command = call.tool === "bash" && typeof call.args.command === "string" ? call.args.command : "";
  const guardsConfig = WRITE_TOOLS.has(call.tool) || (call.tool === "bash" && changesFiles(command, shellWords(command)));
  const targets = candidates(call, values, cwd, home);
  for (const target of targets) {
    const real = realOf(ctx, target);
    const forms = real && real !== target ? [target, real] : [target];
    if (forms.some((f) => armoriqForms.some((a) => mayReach(f, a)))) return protectedDeny(call, ctx);
    if (!guardsConfig) continue;
    const expanded = hasGlob(target) && ctx.readdir ? expandGlob(target, ctx.readdir) : null;
    const literalBase = !hasGlob(split(target).at(-1) ?? "");
    for (const f of expanded ?? forms) {
      if ((expanded !== null || literalBase) && baseNameMatches(f, CONFIG_NAMES)) return configDeny(call, f);
      if (hasSegment(f, ".opencode")) return configDeny(call, f);
      for (const c of [configDir, realConfigDir]) {
        if (c === null) continue;
        if (mayReach(f, c)) return configDeny(call, c);
        if (call.tool === "bash" && mayBeAncestor(f, c) && split(f).length > homeDepth) return configDeny(call, c);
      }
    }
  }
  if (call.tool === "grep" && armoriqForms.some((a) => mayBeAncestor(targets[0]!, a))) {
    return {
      kind: "deny",
      code: "builtin_protected",
      reason: `grep under ${String(call.args.path ?? cwd)} would search the ArmorIQ directory (${ctx.armoriqDir}); search a narrower path`,
      ruleId: "builtin:armoriq_dir",
    };
  }

  if (call.tool === "grep" && typeof call.args.path === "string") {
    const home = dir.endsWith(`/${SEGMENT}`) ? dir.slice(0, -SEGMENT.length - 1) : null;
    if (isAncestorOf(call.args.path, dir, home)) {
      return {
        kind: "deny",
        code: "builtin_protected",
        reason: `grep under ${call.args.path} would search the ArmorIQ directory (${ctx.armoriqDir}); search a narrower path`,
        ruleId: "builtin:armoriq_dir",
      };
    }
  }
  return null;
}
