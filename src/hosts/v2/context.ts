// The slice of the OpenCode 2 plugin context (@opencode/plugin 2.0.x) this host uses. Written out rather
// than imported: V2 refuses to load a plugin that resolves its own copy of @opencode/plugin.

import type { CommandContext, IntentContext, Registration } from "./plugin-api.ts";

export type { Registration };

export type ToolBefore = {
  tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  input: unknown;
};

export type ToolResult = { readonly output?: unknown; readonly content?: unknown };

export type ToolAfter = Omit<ToolBefore, "tool" | "input"> & { readonly tool: string; readonly input: unknown } & (
    | { readonly status: "completed"; readonly result: ToolResult }
    | { readonly status: "error"; readonly error: { readonly message?: unknown; readonly error?: unknown } }
  );

export interface ToolDomain {
  hook(name: "execute.before", callback: (event: ToolBefore) => Promise<void> | void): Promise<Registration>;
  hook(name: "execute.after", callback: (event: ToolAfter) => Promise<void> | void): Promise<Registration>;
}

export type V2Event = { readonly type: string; readonly id?: string; readonly data?: unknown };

export interface EventDomain {
  subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<V2Event>;
}

export interface V2Context {
  readonly app?: { readonly name: string; readonly version: string };
  readonly options?: Readonly<Record<string, unknown>>;
  readonly tool: ToolDomain & IntentContext["tool"];
  readonly event: EventDomain;
  readonly session: IntentContext["session"] & CommandContext["session"];
  readonly command: CommandContext["command"];
}

export type Cleanup = () => Promise<void>;

// OpenCode 1.18 and 1.19 also call setup, with a context that has no event, tool or session domain.
export type SetupContext = Partial<V2Context>;

export function isV2Context(ctx: SetupContext): ctx is V2Context {
  return typeof ctx.event?.subscribe === "function" && typeof ctx.tool?.hook === "function";
}
