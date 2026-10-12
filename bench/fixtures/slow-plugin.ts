// Busy-waits past the before-hook budget so the bench's breach detection can be tested.
import type { Plugin, PluginModule } from "@opencode-ai/plugin";

const spin = (us: number) => {
  const end = process.hrtime.bigint() + BigInt(us * 1000);
  while (process.hrtime.bigint() < end);
};

export const SlowPlugin: Plugin = async () => ({
  "tool.execute.before": async () => spin(250),
});

const plugin: PluginModule = { id: "armoropencode-slow", server: SlowPlugin };
export default plugin;
