// OpenCode tool vocabulary shared by policy, intent and builtin rules.

export const OPENCODE_TOOLS: ReadonlySet<string> = new Set([
  "bash", "read", "write", "edit", "apply_patch", "grep", "glob", "list", "webfetch", "websearch", "task",
  "todowrite", "todoread", "skill", "question", "lsp", "codesearch", "plan",
]);

// ArmorClaude names that differ from OpenCode's by more than case.
export const CLAUDE_TO_OPENCODE: ReadonlyMap<string, string> = new Map([
  ["multiedit", "edit"],
  ["agent", "task"],
  ["notebookread", "read"],
  ["notebookedit", "edit"],
  ["ls", "list"],
]);

// For policies written against ArmorClaude's tool.name values.
export const OPENCODE_TO_CLAUDE: ReadonlyMap<string, string> = new Map([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["list", "LS"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["task", "Task"],
  ["todowrite", "TodoWrite"],
  ["skill", "Skill"],
]);

// OpenCode mcp/catalog.ts names MCP tools sanitize(server) + "_" + sanitize(tool).
export function sanitizeMcpPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

const PATCH_PATH = /^\*\*\* (?:Add File|Delete File|Update File|Move to):(.*)$/gm;

// Every path an apply_patch call touches, parsed as OpenCode patch/index.ts
// does: the text after the colon, trimmed, with or without a space.
export function patchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const m of patchText.matchAll(PATCH_PATH)) {
    const p = m[1]!.trim();
    if (p) out.push(p);
  }
  return out;
}
