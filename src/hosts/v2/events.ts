import type { ArmorHost, HostEvent } from "../../host.ts";
import type { SessionID } from "../../types.ts";
import type { Cleanup, V2Context, V2Event } from "./context.ts";

type Obj = { readonly [key: string]: unknown };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const field = (o: unknown, key: string): unknown => (isObj(o) ? o[key] : undefined);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const sid = (id: string) => id as SessionID;

// V2 never emits session.idle or session.status; a turn ends with one of the execution outcomes.
const TURN_ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

export function toHostEvent(event: V2Event, repo: string): HostEvent | null {
  const data = event.data;
  const sessionId = text(field(data, "sessionID"));
  if (sessionId === null) return null;
  if (TURN_ENDED.has(event.type)) return { kind: "session_idle", sessionId: sid(sessionId) };
  switch (event.type) {
    case "session.created": {
      const parent = text(field(data, "parentID"));
      return { kind: "session_created", sessionId: sid(sessionId), parentId: parent ? sid(parent) : null };
    }
    case "session.renamed": {
      const title = text(field(data, "title"));
      return title === null ? null : { kind: "session_title", sessionId: sid(sessionId), title };
    }
    case "session.deleted":
      return { kind: "session_deleted", sessionId: sid(sessionId) };
    // A retried step starts once per attempt and ends once; the model is the same for every attempt.
    // The variant (reasoning effort and the like) is left off so the id matches the priced model.
    case "session.step.started": {
      const messageId = text(field(data, "assistantMessageID"));
      const model = field(data, "model");
      const id = text(field(model, "id"));
      const provider = text(field(model, "providerID"));
      if (messageId === null || id === null) return null;
      return { kind: "assistant_model", messageId, model: provider === null ? id : `${provider}/${id}` };
    }
    case "session.step.ended": {
      const messageId = text(field(data, "assistantMessageID"));
      if (messageId === null) return null;
      const tokens = field(data, "tokens");
      const cache = field(tokens, "cache");
      return {
        kind: "step_finished",
        step: {
          sessionId: sid(sessionId),
          messageId,
          partId: text(event.id) ?? messageId,
          repo,
          input: num(field(tokens, "input")),
          output: num(field(tokens, "output")),
          reasoning: num(field(tokens, "reasoning")),
          cacheRead: num(field(cache, "read")),
          cacheWrite: num(field(cache, "write")),
        },
      };
    }
    default:
      return null;
  }
}

// Session lifecycle from ctx.event.subscribe(). The stream is read in the background; the returned cleanup ends it.
export async function registerEvents(ctx: V2Context, host: ArmorHost): Promise<Cleanup> {
  const abort = new AbortController();
  const repo = ctx.location?.directory ?? "";
  const stream = ctx.event.subscribe({ signal: abort.signal });
  void (async () => {
    try {
      for await (const event of stream) {
        try {
          const e = toHostEvent(event, repo);
          if (e) host.event(e);
        } catch (error) {
          host.log.error("event handler failed", { type: event.type, error: String(error) });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) host.log.error("event stream failed", { error: String(error) });
    }
  })();
  return async () => abort.abort();
}
