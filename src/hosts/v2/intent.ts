import { renamePlanTools } from "../../core/intent.ts";
import type { ArmorHost, OwnToolCall } from "../../host.ts";
import { MAX_REVISIONS_PER_MESSAGE } from "../../tools/intent.ts";
import type { SessionID } from "../../types.ts";
import type { IntentContext, OwnToolContext, OwnToolInfo } from "./plugin-api.ts";
import { canonicalTool } from "./tools.ts";

const sid = (id: string) => id as SessionID;


export const V2_INTENT_DIRECTIVE = [
  "ArmorIQ intent enforcement is active for this session.",
  "Before any tool that changes state (shell, write, edit, patch, subagent, execute, or an MCP tool), call register_intent_plan once with the plan in this JSON shape:",
  "",
  "{",
  '  "goal": "<one-line summary of the task>",',
  '  "steps": [',
  '    { "action": "<tool name, e.g. shell, write, edit, subagent>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }',
  "  ]",
  "}",
  "",
  "Use the exact OpenCode tool names. MCP tools are named <server>_<tool>; code run through execute is a step named execute, and every tool it calls must also be a step.",
  "read, grep, glob, webfetch and websearch do not need to be in the plan.",
  "Side-effecting tool calls without a registered plan are blocked, and so is any tool that is not in the plan.",
  `If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most ${MAX_REVISIONS_PER_MESSAGE} revisions are accepted per user message.`,
  "Subagents inherit the plan of the session that started them and cannot register their own.",
].join("\n");

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const planInput = { anyOf: [{ type: "object" }, { type: "string" }] };

// A subagent's prompt hook runs before its session.created event, so a session first seen here could be
// opened as a root and escape its parent's plan. The parent is read from the session record instead.
function sessionLinker(ctx: IntentContext, host: ArmorHost) {
  const linked = new Map<string, Promise<void>>();
  return (sessionID: string): Promise<void> => {
    let done = linked.get(sessionID);
    if (!done) {
      done = ctx.session.get({ sessionID }).then(
        (info) => {
          const parent = isRecord(info) ? str(info.parentID) : undefined;
          host.event({ kind: "session_created", sessionId: sid(sessionID), parentId: parent ? sid(parent) : null });
        },
        (error: unknown) => {
          linked.delete(sessionID);
          host.log.warn("session lookup failed", { sessionID, error: String(error) });
        },
      );
      linked.set(sessionID, done);
    }
    return done;
  };
}

function planTools(host: ArmorHost, link: (sessionID: string) => Promise<void>): OwnToolInfo[] {
  const own = host.ownTools;
  const call = async (c: OwnToolContext): Promise<OwnToolCall> => {
    await link(c.sessionID);
    return { sessionId: sid(c.sessionID), messageId: c.messageID, callId: c.id };
  };
  const args = (input: unknown) => (isRecord(input) ? input : {});
  const reply = (content: string) => ({ content });
  return [
    {
      name: "register_intent_plan",
      description:
        "Declare the tools you intend to use for this task. Required by ArmorIQ before any side-effecting tool call; " +
        "without a registered plan those calls are blocked. To revise a registered plan, call it again with the full new plan and a reason.",
      input: {
        type: "object",
        properties: {
          goal: { type: "string", description: "One-line summary of what the plan accomplishes" },
          steps: {
            anyOf: [{ type: "array", items: { type: "object" } }, { type: "string" }],
            description: "Ordered list of {action, description, metadata.inputs} steps (array, or JSON-stringified array)",
          },
          plan: { ...planInput, description: "Alternative: pass the whole plan as an object or JSON string" },
          reason: { type: "string", description: "Required when revising an already registered plan: why the plan changed" },
        },
      },
      options: { codemode: false },
      execute: async (input, c) => {
        const { reason, ...plan } = args(input);
        return reply(await own.registerIntentPlan(await call(c), { plan: renamePlanTools(plan, canonicalTool) }, str(reason) ?? ""));
      },
    },
    {
      name: "trust_reanchor",
      description: "Replace the registered intent plan with a revised one. Counts as a plan revision and requires a reason.",
      input: {
        type: "object",
        properties: {
          updatedPlan: { ...planInput, description: "The full revised plan, {goal, steps}" },
          reason: { type: "string", description: "Why the plan changed" },
        },
        required: ["updatedPlan", "reason"],
      },
      options: { codemode: false },
      execute: async (input, c) => {
        const { updatedPlan, reason } = args(input);
        return reply(await own.reanchor(await call(c), renamePlanTools(updatedPlan, canonicalTool), str(reason) ?? ""));
      },
    },
    {
      name: "trust_revoke",
      description: "Revoke the intent token of this session's registered plan. Side-effecting calls are blocked until a new plan is registered.",
      input: { type: "object", properties: { reason: { type: "string", description: "Why the plan is being revoked" } }, required: ["reason"] },
      options: { codemode: false },
      execute: async (input, c) => reply(await own.revoke(await call(c), str(args(input).reason) ?? "")),
    },
    {
      name: "policy_read",
      description: "Read the active ArmorIQ policy summary and, optionally, how it treats a given tool.",
      input: { type: "object", properties: { tool: { type: "string", description: "Tool name to evaluate against the policy, e.g. shell" } } },
      options: { codemode: false },
      execute: async (input, c) => {
        const tool = str(args(input).tool);
        return reply(own.policyRead(await call(c), tool === undefined ? undefined : canonicalTool(tool)));
      },
    },
  ];
}

export async function registerIntent(ctx: IntentContext, host: ArmorHost): Promise<void> {
  const link = sessionLinker(ctx, host);
  const tools = planTools(host, link);
  await ctx.tool.transform((editor) => {
    for (const tool of tools) editor.add(tool);
  });

  await ctx.session.hook("prompt", async (event) => {
    await link(event.sessionID);
    host.userPrompt({ sessionId: sid(event.sessionID), messageId: event.messageID, text: event.prompt.text });
  });

  await ctx.session.hook("context", (event) => {
    if (host.systemDirective(sid(event.sessionID)) !== null) event.system.push({ type: "text", text: V2_INTENT_DIRECTIVE });
  });
}
