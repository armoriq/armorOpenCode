import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import type { ArmorHost, OwnToolCall } from "../../host.ts";
import type { SessionID } from "../../types.ts";

const z = tool.schema;
const planArg = z.union([z.record(z.string(), z.unknown()), z.string()]);
const stepsArg = z.union([z.array(z.unknown()), z.string()]);

// OpenCode passes the call id on the tool context at runtime; the plugin's ToolContext type omits it.
function ownCall(ctx: ToolContext): OwnToolCall {
  const callId = "callID" in ctx && typeof ctx.callID === "string" ? ctx.callID : null;
  return { sessionId: ctx.sessionID as SessionID, messageId: ctx.messageID, callId };
}

export function intentTools(host: ArmorHost): Record<string, ToolDefinition> {
  const own = host.ownTools;
  return {
    register_intent_plan: tool({
      description:
        "Declare the tools you intend to use for this task. Required by ArmorIQ before any side-effecting tool call; " +
        "without a registered plan those calls are blocked. To revise a registered plan, call it again with the full new plan and a reason.",
      args: {
        goal: z.string().optional().describe("One-line summary of what the plan accomplishes"),
        steps: stepsArg.optional().describe("Ordered list of {action, description, metadata.inputs} steps (array, or JSON-stringified array)"),
        plan: planArg.optional().describe("Alternative: pass the whole plan as an object or JSON string"),
        reason: z.string().optional().describe("Required when revising an already registered plan: why the plan changed"),
      },
      execute: async ({ reason, ...plan }, ctx) => own.registerIntentPlan(ownCall(ctx), plan, typeof reason === "string" ? reason : ""),
    }),

    trust_reanchor: tool({
      description: "Replace the registered intent plan with a revised one. Counts as a plan revision and requires a reason.",
      args: {
        updatedPlan: planArg.describe("The full revised plan, {goal, steps}"),
        reason: z.string().describe("Why the plan changed"),
      },
      execute: async (args, ctx) => own.reanchor(ownCall(ctx), args.updatedPlan, typeof args.reason === "string" ? args.reason : ""),
    }),

    trust_revoke: tool({
      description: "Revoke the intent token of this session's registered plan. Side-effecting calls are blocked until a new plan is registered.",
      args: {
        reason: z.string().describe("Why the plan is being revoked"),
      },
      execute: async (args, ctx) => own.revoke(ownCall(ctx), String(args.reason ?? "")),
    }),

    policy_read: tool({
      description: "Read the active ArmorIQ policy summary and, optionally, how it treats a given tool.",
      args: {
        tool: z.string().optional().describe("Tool name to evaluate against the policy, e.g. bash"),
      },
      execute: async (args, ctx) => own.policyRead(ownCall(ctx), typeof args.tool === "string" ? args.tool : undefined),
    }),
  };
}
