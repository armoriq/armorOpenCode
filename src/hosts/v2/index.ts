import path from "node:path";
import { acquireHost, type ArmorHost } from "../../host.ts";
import { withReach, registerReach } from "../../reach/index.ts";
import { CLIENT } from "../../io/credentials.ts";
import { startUpdate } from "../../io/update-apply.ts";
import { DATA_DIR } from "../../runtime.ts";
import { isV2Context, type Cleanup, type SetupContext, type V2Context } from "./context.ts";
import type { Log } from "../../types.ts";
import { registerApprovals } from "./approvals.ts";
import { registerArmorCommand } from "./command.ts";
import { registerEvents } from "./events.ts";
import { registerGuard } from "./guard.ts";
import { registerIntent } from "./intent.ts";
import { registerNotices } from "./notices.ts";
import { fileLog } from "./log.ts";

export const V2_LOG_FILE = path.join(DATA_DIR, "logs", "opencode-v2.log");

export type V2Module = (ctx: V2Context, host: ArmorHost) => Promise<Cleanup | void>;

// One line per feature, registered in this order.
const MODULES: readonly V2Module[] = [
  registerGuard,
  registerEvents,
  registerIntent,
  registerArmorCommand,
  registerApprovals,
  registerReach,
  registerNotices,
];

export const SETUP_FAILED = `ArmorIQ could not start its guard, so tool calls are blocked. Check ${V2_LOG_FILE}, then restart OpenCode.`;

async function blockEveryCall(ctx: V2Context): Promise<void> {
  await ctx.tool.hook("execute.before", () => {
    throw Object.assign(new Error(SETUP_FAILED), { name: "ArmorIQ" });
  });
}

export async function setup(
  ctx: SetupContext,
  deps: { acquire?: (log: Log, backend?: string) => ArmorHost; modules?: readonly V2Module[] } = {},
): Promise<Cleanup | void> {
  if (!isV2Context(ctx)) return;
  const log = fileLog(V2_LOG_FILE);
  // OpenCode 2 has no toast for plugins, so the update notices go to the plugin log.
  startUpdate({ dataDir: DATA_DIR, log });
  let host: ArmorHost;
  try {
    const backend = ctx.options?.backendUrl;
    host = withReach((deps.acquire ?? acquireHost)(log, typeof backend === "string" ? backend : undefined), { backend: typeof backend === "string" ? backend : undefined, pluginOptions: ctx.options, hostVersion: ctx.app?.version });
  } catch (error) {
    log.error("setup failed; every tool call is blocked", { error: String(error) });
    await blockEveryCall(ctx);
    return;
  }
  const [guard, ...rest] = deps.modules ?? MODULES;
  const cleanups: Cleanup[] = [];
  try {
    const cleanup = await guard!(ctx, host);
    if (cleanup) cleanups.push(cleanup);
  } catch (error) {
    log.error("guard failed to register; every tool call is blocked", { error: String(error) });
    await blockEveryCall(ctx);
    await host.release();
    return;
  }
  for (const register of rest) {
    try {
      const cleanup = await register(ctx, host);
      if (cleanup) cleanups.push(cleanup);
    } catch (error) {
      log.error("module failed to register", { module: register.name, error: String(error) });
    }
  }
  log.info("guard active", { opencode: ctx.app?.version ?? null, armoropencode: CLIENT.version });
  // Releasing the host persists the audit and usage outboxes; unsent rows go out on the next start.
  return async () => {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    await host.release();
    log.info("guard stopped");
  };
}
