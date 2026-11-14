import type { HostEvent } from "../../host.ts";
import type { SessionID } from "../../types.ts";

type Obj = { readonly [key: string]: unknown };

// Hand-rolled rather than schema-parsed: this runs on every streamed part update.
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const field = (o: unknown, key: string): unknown => (isObj(o) ? o[key] : undefined);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const sid = (id: string) => id as SessionID;

export function toHostEvent(event: unknown, repo: string): HostEvent | null {
  const p = field(event, "properties");
  const info = field(p, "info");
  const infoId = text(field(info, "id"));
  switch (field(event, "type")) {
    case "session.created": {
      if (infoId === null) return null;
      const parent = text(field(info, "parentID"));
      return { kind: "session_created", sessionId: sid(infoId), parentId: parent ? sid(parent) : null };
    }
    case "session.updated": {
      const title = text(field(info, "title"));
      return infoId !== null && title !== null ? { kind: "session_title", sessionId: sid(infoId), title } : null;
    }
    case "session.status": {
      const sessionId = text(field(p, "sessionID"));
      return field(field(p, "status"), "type") === "idle" && sessionId !== null ? { kind: "session_idle", sessionId: sid(sessionId) } : null;
    }
    case "session.deleted":
      return infoId !== null ? { kind: "session_deleted", sessionId: sid(infoId) } : null;
    case "message.updated": {
      const modelID = field(info, "modelID");
      if (field(info, "role") !== "assistant" || infoId === null || !modelID) return null;
      return { kind: "assistant_model", messageId: infoId, model: `${String(field(info, "providerID"))}/${String(modelID)}` };
    }
    case "message.part.updated":
      return partEvent(field(p, "part"), repo);
    default:
      return null;
  }
}

function partEvent(part: unknown, repo: string): HostEvent | null {
  const type = field(part, "type");
  if (type === "tool") {
    const state = field(part, "state");
    const callId = text(field(part, "callID"));
    if (field(state, "status") !== "error" || callId === null) return null;
    return { kind: "tool_failed", callId, error: String(field(state, "error") ?? "") };
  }
  if (type !== "step-finish") return null;
  const partId = text(field(part, "id"));
  const sessionId = text(field(part, "sessionID"));
  const messageId = text(field(part, "messageID"));
  if (partId === null || sessionId === null || messageId === null) return null;
  // A step-finish part carries that step's tokens; message.tokens holds only the last step.
  const tokens = field(part, "tokens");
  const cache = field(tokens, "cache");
  return {
    kind: "step_finished",
    step: {
      sessionId: sid(sessionId),
      messageId,
      partId,
      repo,
      input: num(field(tokens, "input")),
      output: num(field(tokens, "output")),
      reasoning: num(field(tokens, "reasoning")),
      cacheRead: num(field(cache, "read")),
      cacheWrite: num(field(cache, "write")),
    },
  };
}
