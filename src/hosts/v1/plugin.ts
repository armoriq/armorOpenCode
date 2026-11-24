import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { ARMOR_COMMAND } from "../../commands/armor.ts";
import { acquireHost } from "../../host.ts";
import { withReach, toastMessages } from "../../reach/index.ts";
import { findOpenCode2Gap, OPENCODE2_UNGUARDED } from "../../io/opencode2.ts";
import { startUpdate } from "../../io/update-apply.ts";
import { DATA_DIR } from "../../runtime.ts";
import type { Log, SessionID } from "../../types.ts";
import { toHostEvent } from "./events.ts";
import { intentTools } from "./tools.ts";
import { promptMessage } from "./prompts.ts";

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

export const ArmorOpenCode: Plugin = async (input, options) => {
  const log = createLog(input.client);
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const reachOptions = {
    backend: typeof options?.backendUrl === "string" ? options.backendUrl : undefined,
    pluginOptions: options,
    hostVersion: null,
    notify(message: string) {
      if (disposed) return;
      for (const [index, part] of toastMessages(message).entries()) {
        const show = () => {
          if (disposed) return;
          void input.client.tui.showToast({ body: { title: "ArmorIQ", message: part, variant: "info", duration: 20_000 } }).catch(() => {});
        };
        if (index === 0) show();
        else {
          const timer = setTimeout(() => { toastTimers.delete(timer); show(); }, index * 20_000).unref();
          toastTimers.add(timer);
        }
      }
    },
  };
  startUpdate({ dataDir: DATA_DIR, log, notify: reachOptions.notify });
  const host = withReach(acquireHost(log, reachOptions.backend), reachOptions);
  const stopNotices = host.onNotice((_, text) => reachOptions.notify(text));
  const repo = input.worktree || input.directory;
  const opencode2Gap = findOpenCode2Gap();
  if (opencode2Gap) log.warn(OPENCODE2_UNGUARDED, { ...opencode2Gap });
  let toastShown = false;

  const hooks: Hooks = {
    tool: intentTools(host),

    config: async (cfg) => {
      cfg.command ??= {};
      cfg.command[ARMOR_COMMAND] ??= { template: "/armor $ARGUMENTS", description: "ArmorIQ status and policy (answered locally)" };
    },

    // Answered without a model turn: the reply is posted as an ignored part (shown, never sent to the model),
    // then the throw cancels the command before OpenCode prompts. The TUI does not surface command errors.
    "command.execute.before": async (i) => {
      if (i.command !== ARMOR_COMMAND) return;
      const reply = host.armorCommand(sid(i.sessionID), i.arguments);
      await input.client.session
        .prompt({ path: { id: i.sessionID }, body: { noReply: true, parts: [{ type: "text", text: reply, ignored: true }] } })
        .catch((error: unknown) => log.warn("armor command reply failed", { error: String(error) }));
      throw new Error("ArmorIQ: /armor answered locally");
    },

    "tool.execute.before": async (i, o) => {
      await host.toolBefore({ sessionId: sid(i.sessionID), callId: i.callID, tool: i.tool, args: o.args ?? {} });
    },

    "tool.execute.after": async (i, o) => {
      host.toolAfter({ callId: i.callID, tool: i.tool }, typeof o.output === "string" ? o.output : "");
    },

    "chat.message": async (i, o) => {
      promptMessage(host, i, o);
    },

    "experimental.chat.system.transform": async (i, o) => {
      const directive = i.sessionID ? host.systemDirective(sid(i.sessionID)) : null;
      if (directive) o.system.push(directive);
    },

    event: async ({ event }) => {
      // Shown on the first session rather than at startup, when the TUI may not be listening yet.
      if (opencode2Gap && !toastShown && event.type === "session.created") {
        toastShown = true;
        void input.client.tui
          .showToast({ body: { title: "ArmorIQ", message: OPENCODE2_UNGUARDED, variant: "warning", duration: 20_000 } })
          .catch(() => {});
      }
      try {
        const e = toHostEvent(event, repo);
        if (e) host.event(e);
      } catch (error) {
        log.error("event handler failed", { type: event.type, error: String(error) });
      }
    },

    dispose: async () => {
      disposed = true;
      stopNotices();
      for (const timer of toastTimers) clearTimeout(timer);
      toastTimers.clear();
      await host.release();
    },
  };
  return hooks;
};

const plugin: PluginModule = { id: "armoropencode", server: ArmorOpenCode };
export default plugin;
