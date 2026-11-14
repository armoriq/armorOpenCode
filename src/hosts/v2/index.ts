import path from "node:path";
import { acquireHost, type ArmorHost } from "../../host.ts";
import { DATA_DIR } from "../../runtime.ts";
import { isV2Context, type Cleanup, type SetupContext, type V2Context } from "./context.ts";
import { registerApprovals } from "./approvals.ts";
import { registerArmorCommand } from "./command.ts";
import { registerEvents } from "./events.ts";
import { registerGuard } from "./guard.ts";
import { registerIntent } from "./intent.ts";
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
];

// OpenCode 2 entry. A throw here would make V2 drop the plugin without a word, so failures are logged instead.
export async function setup(ctx: SetupContext): Promise<Cleanup | void> {
  if (!isV2Context(ctx)) return;
  const log = fileLog(V2_LOG_FILE);
  let host: ArmorHost;
  try {
    const backend = ctx.options?.backendUrl;
    host = acquireHost(log, typeof backend === "string" ? backend : undefined);
  } catch (error) {
    log.error("setup failed; this location is not guarded", { error: String(error) });
    return;
  }
  const cleanups: Cleanup[] = [];
  for (const register of MODULES) {
    try {
      const cleanup = await register(ctx, host);
      if (cleanup) cleanups.push(cleanup);
    } catch (error) {
      log.error("module failed to register", { module: register.name, error: String(error) });
    }
  }
  log.info("guard active", { opencode: ctx.app?.version ?? null });
  // Releasing the host persists the audit and usage outboxes; unsent rows go out on the next start.
  return async () => {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    await host.release();
    log.info("guard stopped");
  };
}
