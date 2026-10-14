// The slices of the OpenCode 2 plugin context (@opencode/plugin 2.0.29) that intent, /armor and approvals
// use. Written out rather than imported: V2 refuses a plugin that resolves its own @opencode/plugin.

export type Registration = { readonly dispose: () => Promise<void> };

export type JsonSchema = Readonly<Record<string, unknown>>;

export type OwnToolContext = { readonly sessionID: string; readonly messageID: string; readonly id: string };

export type OwnToolInfo = {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema;
  // Code mode would hide the tool behind `execute`; the plan tools must be called directly.
  readonly options: { readonly codemode: false };
  readonly execute: (input: unknown, context: OwnToolContext) => Promise<{ readonly content: string }>;
};

export interface ToolEditor {
  add(tool: OwnToolInfo): void;
}

export type SystemPart = { type: "text"; text: string };

export type PromptEvent = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly prompt: { readonly text: string };
};

export type ContextEvent = {
  readonly sessionID: string;
  system: SystemPart[];
  messages: Array<{ readonly id?: string }>;
};

export type SessionHooks = { prompt: PromptEvent; context: ContextEvent };

export type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (event: Spec[Name]) => Promise<void> | void) => Promise<Registration>;

export interface IntentContext {
  readonly tool: { transform(callback: (editor: ToolEditor) => void): Promise<Registration> };
  readonly session: {
    readonly hook: Hooks<SessionHooks>;
    get(input: { sessionID: string }): Promise<unknown>;
  };
}
