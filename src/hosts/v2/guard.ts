import type { ArmorHost } from "../../host.ts";
import { deepFreeze } from "../../runtime.ts";
import type { SessionID } from "../../types.ts";
import { CallPairs } from "./calls.ts";
import type { V2Context } from "./context.ts";
import { canonicalArgs, canonicalTool, resultText } from "./tools.ts";

const sid = (id: string) => id as SessionID;

// V2 reports a call it refused to run (config deny, a plugin's evaluate deny, a headless auto-reject) as an
// error whose cause is a Permission.* error. Such a call never reached any tool, so it says nothing about shadowing.
function neverRan(error: { readonly error?: unknown }): boolean {
  const cause = error.error;
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return false;
  return typeof cause._tag === "string" && cause._tag.startsWith("Permission.");
}

// execute.before throws to block; V2 shows the model only the Error message, the same text V1 shows.
// execute.after never fires for a blocked call, so the runtime writes the blocked row from before.
export async function registerGuard(ctx: V2Context, host: ArmorHost): Promise<void> {
  const calls = new CallPairs();

  await ctx.tool.hook("execute.before", (event) => {
    const tool = canonicalTool(event.tool);
    const callId = calls.begin(event.id, event.tool, event.input);
    try {
      host.toolBefore({ sessionId: sid(event.sessionID), callId, tool, args: canonicalArgs(tool, event.input) });
    } catch (error) {
      calls.cancel(event.id, event.tool, callId);
      throw error;
    }
    deepFreeze(event.input);
  });

  // A throw here would replace the tool's real output with an error, so failures are only logged.
  await ctx.tool.hook("execute.after", (event) => {
    try {
      const callId = calls.end(event.id, event.tool, event.input);
      if (callId === null) return;
      const tool = canonicalTool(event.tool);
      if (event.status === "completed") host.toolAfter({ callId, tool }, resultText(event.result));
      else if (neverRan(event.error)) host.event({ kind: "tool_failed", callId, error: String(event.error.message ?? "") });
      else host.toolFailed({ callId, tool }, String(event.error.message ?? ""));
    } catch (error) {
      host.log.error("execute.after failed", { tool: event.tool, error: String(error) });
    }
  });
}
