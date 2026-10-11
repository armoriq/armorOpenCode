import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createArmor, type Log } from "./armor.ts";
import { loadConfig } from "./config.ts";
import { createAuditShipper } from "./http.ts";

export const ArmorOpenCode: Plugin = async ({ client }) => {
  const config = loadConfig();
  const log: Log = (level, message, extra) => {
    void client.app.log({ body: { service: "armoropencode", level, message, extra } }).catch(() => {});
  };
  const armor = createArmor({ config, log, ship: createAuditShipper(config) });
  armor.start();
  log("info", "loaded", { mode: config.mode, policyFile: config.policyFile, dataDir: config.dataDir });

  return {
    "tool.execute.before": async (input, output) => {
      await armor.beforeTool(input, output.args);
    },
    "tool.execute.after": async (input, output) => {
      await armor.afterTool(input, input.args, output);
    },
    event: async ({ event }) => {
      if (event.type !== "message.part.updated") return;
      const part = event.properties.part;
      if (part.type !== "tool" || part.state.status !== "error") return;
      await armor.failedTool(
        { tool: part.tool, sessionID: part.sessionID, callID: part.callID },
        part.state.input,
        part.state.error,
        part.state.time,
      );
    },
    dispose: armor.dispose,
  };
};

export default { id: "armoropencode", server: ArmorOpenCode } satisfies PluginModule;
