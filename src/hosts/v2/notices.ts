import type { ArmorHost } from "../../host.ts";
import { REACH_NOTE } from "../../reach/v2.ts";
import type { Cleanup, V2Context } from "./context.ts";

// OpenCode 2 has no plugin toast. A synthetic message shows its description in the TUI; its text is the
// neutral reach note, which the reach context hook keeps out of every model turn.
export async function registerNotices(ctx: V2Context, host: ArmorHost): Promise<Cleanup> {
  const stop = host.onNotice((sessionId, description) => {
    void ctx.session.synthetic({ sessionID: sessionId, text: REACH_NOTE, description, resume: false }).catch((error: unknown) =>
      host.log.warn("monitor notice failed", { error: String(error) }),
    );
  });
  return async () => stop();
}
