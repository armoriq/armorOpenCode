// OpenCode 2 renamed tools and arguments. Calls are translated to the V1 vocabulary before the core sees
// them, so existing policies, plans, built-in rules and audit rows apply unchanged.

const TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["shell", "bash"],
  ["subagent", "task"],
  ["patch", "apply_patch"],
]);

const ARG_NAMES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ["read", new Map([["path", "filePath"]])],
  ["write", new Map([["path", "filePath"]])],
  ["edit", new Map([["path", "filePath"]])],
  ["task", new Map([["agent", "subagent_type"]])],
]);

export const canonicalTool = (tool: string): string => TOOL_NAMES.get(tool) ?? tool;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Returns the input itself when no argument is renamed, so freezing the checked args freezes what runs.
export function canonicalArgs(tool: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const renames = ARG_NAMES.get(tool);
  if (!renames || !Object.keys(input).some((k) => renames.has(k))) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) out[renames.get(key) ?? key] = value;
  return out;
}

// What the model sees: the text parts of the result, else the raw output.
export function resultText(result: { readonly output?: unknown; readonly content?: unknown }): string {
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const part of result.content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof result.output === "string") return result.output;
  return result.output === undefined ? "" : JSON.stringify(result.output);
}
