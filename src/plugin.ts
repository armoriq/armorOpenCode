import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { handleArmorCommand } from "./commands/armor.ts";
import { acquireRuntime, releaseRuntime, type Runtime } from "./runtime.ts";
import { INTENT_DIRECTIVE, intentTools } from "./tools/intent.ts";
import type { Log, SessionID } from "./types.ts";

const sid = (id: string) => id as SessionID;

function createLog(client: Parameters<Plugin>[0]["client"]): Log {
  const send = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    void client.app.log({ body: { service: "armoropencode", level, message, extra } }).catch(() => {});
  };
  return {
    info: (m, e) => send("info", m, e),
    warn: (m, e) => send("warn", m, e),
    error: (m, e) => send("error", m, e),
  };
}

function onEvent(rt: Runtime, event: { type: string; properties?: any }, repo: string): void {
  const p = event.properties ?? {};
  switch (event.type) {
    case "session.created":
      if (typeof p.info?.id === "string") rt.sessionCreated(sid(p.info.id), p.info.parentID ? sid(p.info.parentID) : null);
      return;
    case "session.status":
      if (p.status?.type === "idle" && typeof p.sessionID === "string") rt.idle(sid(p.sessionID));
      return;
    case "session.deleted":
      if (typeof p.info?.id === "string") rt.deleted(sid(p.info.id));
      return;
    case "message.updated":
      if (p.info?.role === "assistant" && typeof p.info.id === "string" && p.info.modelID)
        rt.assistantModel(p.info.id, `${p.info.providerID}/${p.info.modelID}`);
      return;
    case "message.part.updated": {
      const part = p.part;
      if (part?.type === "tool" && part.state?.status === "error") rt.failed(part.callID, "failed", String(part.state.error ?? ""));
      else if (part?.type === "step-finish") rt.stepFinished(part, repo);
      return;
    }
  }
}

export const ArmorOpenCode: Plugin = async (input) => {
  const log = createLog(input.client);
  const rt = acquireRuntime(log);
  const repo = input.worktree || input.directory;

  const hooks: Hooks = {
    tool: intentTools(rt),

    "tool.execute.before": async (i, o) => {
      rt.before({ sessionId: sid(i.sessionID), callId: i.callID, tool: i.tool, args: o.args ?? {} });
    },

    "tool.execute.after": async (i, o) => {
      rt.after(i.callID, typeof o.output === "string" ? o.output : "");
    },

    "chat.message": async (i, o) => {
      const text = o.parts.map((part: any) => (part.type === "text" ? part.text : "")).join("\n");
      rt.userMessage(sid(i.sessionID), i.messageID ?? o.message.id, text);
      const reply = handleArmorCommand(text, i.sessionID, rt);
      if (reply !== null) log.info("armor command", { sessionID: i.sessionID });
    },

    "experimental.chat.system.transform": async (i, o) => {
      if (i.sessionID && rt.mode() === "enforce" && INTENT_DIRECTIVE) o.system.push(INTENT_DIRECTIVE);
    },

    event: async ({ event }) => {
      try {
        onEvent(rt, event as { type: string; properties?: any }, repo);
      } catch (error) {
        log.error("event handler failed", { type: (event as { type: string }).type, error: String(error) });
      }
    },

    dispose: async () => {
      await releaseRuntime();
    },
  };
  return hooks;
};

const plugin: PluginModule = { id: "armoropencode", server: ArmorOpenCode };
export default plugin;
