// Minimal stand-in for the enforcement contract, used only to prove the e2e plumbing inside real
// OpenCode while src/ is unimplemented: it registers a plan with the backend, blocks off-plan
// calls with the plugin's denial text, and ships audit rows on idle.
import { tool, type Hooks, type Plugin, type PluginModule } from "@opencode-ai/plugin";

const backend = process.env.ARMORIQ_BACKEND_URL ?? "";

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${backend}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

export const StandIn: Plugin = async () => {
  const plans = new Map<string, { planId: string; tools: Set<string> }>();
  const rows: Record<string, unknown>[] = [];

  const hooks: Hooks = {
    tool: {
      register_intent_plan: tool({
        description: "Register the plan of tool calls for this task.",
        args: { goal: tool.schema.string(), steps: tool.schema.array(tool.schema.object({ action: tool.schema.string(), tool: tool.schema.string() })) },
        async execute(args, ctx) {
          const minted = await post("/iap/sdk/token", { plan: { goal: args.goal, steps: args.steps, metadata: { session_id: ctx.sessionID } } });
          plans.set(ctx.sessionID, { planId: minted.plan_id, tools: new Set(args.steps.map((s) => s.tool)) });
          return `Plan registered: ${minted.plan_id}`;
        },
      }),
    },
    "tool.execute.before": async (input) => {
      if (input.tool === "register_intent_plan") return;
      const plan = plans.get(input.sessionID);
      const row = { session_id: input.sessionID, tool: input.tool, step_index: 0, action: input.tool, input: {}, executed_at: new Date().toISOString() };
      if (!plan) {
        rows.push({ ...row, status: "blocked" });
        throw new Error("ArmorIQ blocked this call [intent_plan_missing]: register a plan first");
      }
      if (!plan.tools.has(input.tool)) {
        rows.push({ ...row, status: "blocked" });
        throw new Error(`ArmorIQ blocked this call [intent_drift]: ${input.tool} is not in the registered plan`);
      }
      rows.push({ ...row, plan_id: plan.planId, status: "success" });
    },
    event: async ({ event }) => {
      const e = event as { type: string; properties?: any };
      if (e.type === "session.status" && e.properties?.status?.type === "idle" && rows.length) await post("/iap/audit/batch", { rows: rows.splice(0) });
    },
  };
  return hooks;
};

const plugin: PluginModule = { id: "armoropencode-standin", server: StandIn };
export default plugin;
