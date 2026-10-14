// The surface a host adapter (src/hosts/<major>) drives. Hosts translate their plugin API into these
// calls and never reach into the runtime directly, so V1 and V2 share one enforcement path.
import { handleArmorCommand } from "./commands/armor.ts";
import { acquireRuntime, releaseRuntime, type Runtime } from "./runtime.ts";
import { INTENT_DIRECTIVE, noteOwnExecute, noteToolAfter, noteToolBefore, policyRead, reanchorPlan, registerPlan, revokeCurrent } from "./tools/intent.ts";
import type { Log, SessionID, StepTokens, ToolCall } from "./types.ts";

export type HostEvent =
  | { kind: "session_created"; sessionId: SessionID; parentId: SessionID | null }
  | { kind: "session_title"; sessionId: SessionID; title: string }
  | { kind: "session_idle"; sessionId: SessionID }
  | { kind: "session_deleted"; sessionId: SessionID }
  | { kind: "assistant_model"; messageId: string; model: string }
  | { kind: "tool_failed"; callId: string; error: string }
  | { kind: "step_finished"; step: StepTokens };

// callId is null when the host does not expose it to tool handlers.
export type OwnToolCall = { sessionId: SessionID; messageId: string; callId: string | null };

export interface OwnTools {
  registerIntentPlan(call: OwnToolCall, plan: Record<string, unknown>, reason: string): Promise<string>;
  reanchor(call: OwnToolCall, updatedPlan: unknown, reason: string): Promise<string>;
  revoke(call: OwnToolCall, reason: string): Promise<string>;
  policyRead(call: OwnToolCall, tool: string | undefined): string;
}

export interface ArmorHost {
  readonly log: Log;
  // Throws GuardDenied when the call must not run; the host surfaces the throw as the tool's failure.
  toolBefore(call: ToolCall): void;
  toolAfter(call: Pick<ToolCall, "callId" | "tool">, output: string): void;
  // For hosts whose after hook also reports failures with the tool name; V1 reports them as tool_failed events.
  toolFailed(call: Pick<ToolCall, "callId" | "tool">, error: string): void;
  userPrompt(prompt: { sessionId: SessionID; messageId: string; text: string }): void;
  systemDirective(sessionId: SessionID): string | null;
  armorCommand(sessionId: SessionID, args: string): string;
  event(event: HostEvent): void;
  readonly ownTools: OwnTools;
  release(): Promise<void>;
}

export function acquireHost(log: Log, backend?: string): ArmorHost {
  return hostFor(acquireRuntime(log, backend), log, releaseRuntime);
}

// The runtime is shared across plugin instances; log stays per instance so each host logs to its own client.
export function hostFor(rt: Runtime, log: Log, release: () => Promise<void> = async () => {}): ArmorHost {
  const ctx = (call: OwnToolCall) => {
    if (call.callId !== null) noteOwnExecute(rt, call.callId);
    return { sessionID: call.sessionId, messageID: call.messageId };
  };
  return {
    log,
    toolBefore(call) {
      rt.before(call);
      noteToolBefore(rt, call.tool, call.callId);
    },
    toolAfter(call, output) {
      rt.after(call.callId, output);
      noteToolAfter(rt, call.tool, call.callId);
    },
    toolFailed(call, error) {
      rt.failed(call.callId, "failed", error);
      noteToolAfter(rt, call.tool, call.callId);
    },
    userPrompt({ sessionId, messageId, text }) {
      rt.userMessage(sessionId, messageId, text);
      if (handleArmorCommand(text, sessionId, rt) !== null) log.info("armor command", { sessionID: sessionId });
    },
    systemDirective: () => (rt.mode() === "enforce" && INTENT_DIRECTIVE ? INTENT_DIRECTIVE : null),
    armorCommand: (sessionId, args) => handleArmorCommand(`/armor ${args}`, sessionId, rt) ?? "",
    event(e) {
      switch (e.kind) {
        case "session_created":
          return rt.sessionCreated(e.sessionId, e.parentId);
        case "session_title":
          return rt.sessionTitle(e.sessionId, e.title);
        case "session_idle":
          return rt.idle(e.sessionId);
        case "session_deleted":
          return rt.deleted(e.sessionId);
        case "assistant_model":
          return rt.assistantModel(e.messageId, e.model);
        case "tool_failed":
          return rt.failed(e.callId, "failed", e.error);
        case "step_finished":
          return rt.stepFinished(e.step);
        default: {
          const _exhaustive: never = e;
          return _exhaustive;
        }
      }
    },
    ownTools: {
      registerIntentPlan: (call, plan, reason) => registerPlan(rt, ctx(call), plan, reason),
      reanchor: (call, updatedPlan, reason) => reanchorPlan(rt, ctx(call), updatedPlan, reason),
      revoke: (call, reason) => revokeCurrent(rt, ctx(call).sessionID, reason),
      policyRead: (call, tool) => policyRead(rt, ctx(call).sessionID, tool),
    },
    release,
  };
}
