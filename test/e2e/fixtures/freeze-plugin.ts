// Deep-freezes output.args in tool.execute.before when FREEZE_ARGS=1, the same way runtime.ts does
// after decide(), and records each tool call's terminal state to FREEZE_OUT.
import { writeFileSync } from "node:fs";
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

export type CallRecord = { callId: string; tool: string; status: string; frozenAtExecute: boolean | null; error: string | null };

const freeze = process.env.FREEZE_ARGS === "1";
const out = process.env.FREEZE_OUT;

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}

export const FreezeArgs: Plugin = async () => {
  const calls = new Map<string, CallRecord>();
  const record = (callId: string, patch: Partial<CallRecord>) => {
    const prev = calls.get(callId) ?? { callId, tool: "", status: "pending", frozenAtExecute: null, error: null };
    calls.set(callId, { ...prev, ...patch });
  };

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      if (freeze) deepFreeze(output.args);
      record(input.callID, { tool: input.tool });
    },
    // input.args is the object the tool executed with (session/tools.ts passes the same reference).
    "tool.execute.after": async (input) => {
      record(input.callID, { frozenAtExecute: Object.isFrozen(input.args) });
    },
    event: async ({ event }) => {
      const e = event as { type: string; properties?: any };
      const part = e.properties?.part;
      if (e.type === "message.part.updated" && part?.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error"))
        record(part.callID, { tool: part.tool, status: part.state.status, error: part.state.status === "error" ? String(part.state.error ?? "") : null });
      if (e.type === "session.status" && e.properties?.status?.type === "idle" && out) writeFileSync(out, JSON.stringify([...calls.values()]));
    },
  };
  return hooks;
};

const plugin: PluginModule = { id: "armoropencode-freeze-check", server: FreezeArgs };
export default plugin;
