import path from "node:path";
import { acquireHost, type ArmorHost } from "../../host.ts";
import { DATA_DIR } from "../../runtime.ts";
import { isV2Context, type Cleanup, type SetupContext, type V2Context } from "./context.ts";
import { registerArmorCommand } from "./command.ts";
import { registerGuard } from "./guard.ts";
import { registerIntent } from "./intent.ts";
import { fileLog } from "./log.ts";

export const V2_LOG_FILE = path.join(DATA_DIR, "logs", "opencode-v2.log");

export type V2Module = (ctx: V2Context, host: ArmorHost) => Promise<void>;

// One line per feature, registered in this order.
const MODULES: readonly V2Module[] = [registerGuard, registerIntent, registerArmorCommand];

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
  for (const register of MODULES) {
    try {
      await register(ctx, host);
    } catch (error) {
      log.error("module failed to register", { module: register.name, error: String(error) });
    }
  }
  log.info("guard active", { opencode: ctx.app?.version ?? null });
  return () => host.release();
}
