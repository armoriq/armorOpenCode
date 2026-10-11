import type { Decision, ToolCall } from "../types.ts";

export type BuiltinContext = {
  armoriqDir: string;
  ownTools: ReadonlySet<string>;
  shadowedTools: ReadonlySet<string>;
};

// Rules config cannot override: protect ~/.armoriq, refuse shadowed own-tool names.
export function checkBuiltin(call: ToolCall, ctx: BuiltinContext): Decision | null {
  throw new Error("not implemented");
}
