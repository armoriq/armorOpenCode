// Stand-in for dist/plugin.js with the same hook surface and no work, so the harness can be
// proven inside real OpenCode before the core lanes land.
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

export const NoopPlugin: Plugin = async () => {
  const hooks: Hooks = {
    "tool.execute.before": async () => {},
    "tool.execute.after": async () => {},
    "chat.message": async () => {},
    event: async () => {},
  };
  return hooks;
};

const plugin: PluginModule = { id: "armoropencode-noop", server: NoopPlugin };
export default plugin;
