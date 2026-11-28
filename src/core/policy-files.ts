import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type FileFacts = { path: string; withinWorkspace?: boolean };

function insideWorkspace(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspaceRelative(workspace: string, file: string): string {
  const relative = path.relative(workspace, file);
  if (insideWorkspace(relative)) return relative;
  try {
    return path.relative(realpathSync.native(workspace), realpathSync.native(file));
  } catch {
    return relative;
  }
}

function facts(file: string, cwd: string | undefined, workspace: string | undefined): FileFacts[] {
  const home = homedir();
  const expanded = file.replace(/^~(?=\/|$)/, () => home);
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : cwd ? path.resolve(cwd, expanded) : null;
  if (absolute === null) return [{ path: path.normalize(file) }];
  const relative = workspace ? workspaceRelative(workspace, absolute) : null;
  const inside = relative !== null && insideWorkspace(relative);
  const names = new Set([absolute]);
  if (inside && relative) names.add(relative);
  if (absolute === home || absolute.startsWith(home + path.sep)) names.add(`~${absolute.slice(home.length)}`);
  return [...names].map((name) => ({ path: name, ...(relative === null ? {} : { withinWorkspace: inside }) }));
}

// Quoted and escaped words stay together. Metacharacters delimit words, and a
// redirection operand is meaningful even when it is not an argv entry.
function shellOperands(command: string): string[] {
  const tokens = command.matchAll(/((?:\x22(?:[^\x22\\]|\\.)*\x22|\x27[^\x27]*\x27|\\[^]|[^\s;&|()<>'"\\])+)|([^\s])/g);
  const files: string[] = [];
  let atProgram = true;
  let redirect = false;
  for (const [, word, operator] of tokens) {
    if (!word) {
      if (operator === "<" || operator === ">") redirect = true;
      else if (operator && ";&|()".includes(operator)) atProgram = true;
      continue;
    }
    if (atProgram && !redirect) {
      atProgram = false;
      continue;
    }
    redirect = false;
    const decoded = word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\([^])/g, (_all, double, single, escaped) =>
      typeof double === "string" ? double.replace(/\\(["\\$\x60])/g, "$1") : single ?? escaped,
    );
    if (decoded.includes("/") && !decoded.startsWith("-") && !decoded.includes("://") && !decoded.includes("$")) files.push(decoded);
  }
  return [...new Set(files)];
}

export function policyFileFacts(tool: string, args: Readonly<Record<string, unknown>>, workspace?: string): FileFacts[] {
  if (tool === "bash" && typeof args.command === "string") {
    const cwd = typeof args.workdir === "string"
      ? (workspace ? path.resolve(workspace, args.workdir) : path.isAbsolute(args.workdir) ? args.workdir : undefined)
      : workspace;
    return shellOperands(args.command).flatMap((file) => facts(file, cwd, workspace));
  }
  if (["read", "edit", "write", "list", "glob", "grep"].includes(tool)) {
    const file = args.filePath ?? args.path;
    if (typeof file === "string" && file) return facts(file, workspace, workspace);
  }
  return [];
}
