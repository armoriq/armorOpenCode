import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { parsePlan } from "../core/intent.ts";
import { mintToken, reanchor, revoke } from "../io/backend-intent.ts";
import type { Runtime } from "../runtime.ts";
import type { AuditRow, Plan, Session, SessionID, Token } from "../types.ts";

export const OWN_TOOL_NAMES: readonly string[] = ["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"];

export const MAX_REVISIONS_PER_MESSAGE = 2;

export const INTENT_DIRECTIVE = [
  "ArmorIQ intent enforcement is active for this session.",
  "Before any tool that changes state (bash, write, edit, apply_patch, task, or an MCP tool), call register_intent_plan once with the plan in this JSON shape:",
  "",
  "{",
  '  "goal": "<one-line summary of the task>",',
  '  "steps": [',
  '    { "action": "<tool name, e.g. bash, write, edit, task>", "description": "<why this step is needed>", "metadata": { "inputs": { /* expected tool parameters, optional */ } } }',
  "  ]",
  "}",
  "",
  "Use the exact OpenCode tool names. MCP tools are named <server>_<tool>. read, grep, glob, list, webfetch, websearch, todoread and todowrite do not need to be in the plan.",
  "Side-effecting tool calls without a registered plan are blocked, and so is any tool that is not in the plan.",
  `If the task really changes, call register_intent_plan again with the full revised plan and a "reason". At most ${MAX_REVISIONS_PER_MESSAGE} revisions are accepted per user message.`,
  "Subagents inherit the plan of the session that started them and cannot register their own.",
].join("\n");

const z = tool.schema;
const planArg = z.union([z.record(z.string(), z.unknown()), z.string()]);
const stepsArg = z.union([z.array(z.unknown()), z.string()]);

type ToolState = { registering: Set<SessionID>; ownPending: Map<string, number> };
const states = new WeakMap<Runtime, ToolState>();

function stateFor(rt: Runtime): ToolState {
  let s = states.get(rt);
  if (!s) {
    s = { registering: new Set(), ownPending: new Map() };
    states.set(rt, s);
  }
  return s;
}

export function intentTools(rt: Runtime): Record<string, ToolDefinition> {
  const own = <A extends Parameters<typeof tool>[0]["args"]>(def: {
    name: string;
    description: string;
    args: A;
    execute(args: any, ctx: ToolContext): Promise<string>;
  }) =>
    tool({
      description: def.description,
      args: def.args,
      execute: async (args, ctx) => {
        markOwnExecute(rt, ctx.sessionID, def.name);
        return def.execute(args, ctx);
      },
    });

  return {
    register_intent_plan: own({
      name: "register_intent_plan",
      description:
        "Declare the tools you intend to use for this task. Required by ArmorIQ before any side-effecting tool call; " +
        "without a registered plan those calls are blocked. To revise a registered plan, call it again with the full new plan and a reason.",
      args: {
        goal: z.string().optional().describe("One-line summary of what the plan accomplishes"),
        steps: stepsArg.optional().describe("Ordered list of {action, description, metadata.inputs} steps (array, or JSON-stringified array)"),
        plan: planArg.optional().describe("Alternative: pass the whole plan as an object or JSON string"),
        reason: z.string().optional().describe("Required when revising an already registered plan: why the plan changed"),
      },
      execute: async (args, ctx) => {
        const { reason, ...raw } = (args ?? {}) as Record<string, unknown>;
        return registerPlan(rt, ctx, raw, typeof reason === "string" ? reason : "");
      },
    }),

    trust_reanchor: own({
      name: "trust_reanchor",
      description: "Replace the registered intent plan with a revised one. Counts as a plan revision and requires a reason.",
      args: {
        updatedPlan: planArg.describe("The full revised plan, {goal, steps}"),
        reason: z.string().describe("Why the plan changed"),
      },
      execute: async (args, ctx) => {
        const session = sessionFor(rt, ctx.sessionID);
        if (!session.plan) return "No registered plan to re-anchor. Call register_intent_plan first.";
        return registerPlan(rt, ctx, { plan: args.updatedPlan }, typeof args.reason === "string" ? args.reason : "");
      },
    }),

    trust_revoke: own({
      name: "trust_revoke",
      description: "Revoke the intent token of this session's registered plan. Side-effecting calls are blocked until a new plan is registered.",
      args: {
        reason: z.string().describe("Why the plan is being revoked"),
      },
      execute: async (args, ctx) => revokeCurrent(rt, ctx.sessionID as SessionID, String(args.reason ?? "")),
    }),

    policy_read: own({
      name: "policy_read",
      description: "Read the active ArmorIQ policy summary and, optionally, how it treats a given tool.",
      args: {
        tool: z.string().optional().describe("Tool name to evaluate against the policy, e.g. bash"),
      },
      execute: async (args, ctx) => policyRead(rt, ctx.sessionID as SessionID, typeof args.tool === "string" ? args.tool : undefined),
    }),
  };
}

export async function registerPlan(rt: Runtime, ctx: Pick<ToolContext, "sessionID" | "messageID">, raw: unknown, reason: string): Promise<string> {
  const id = ctx.sessionID as SessionID;
  const session = sessionFor(rt, id);
  if (session.parentId !== null) {
    return "This is a subagent session. It inherits the plan registered by its parent session and cannot register its own. Continue within the parent plan.";
  }
  const st = stateFor(rt);
  if (st.registering.has(id)) return "A plan registration is already in progress for this session. Wait for it to finish.";

  const previous = session.plan;
  // A plan recorded while logged out was never minted, so replacing it is a first registration.
  const isRevision = previous !== null && previous.id !== "";
  if (isRevision) {
    if (!reason.trim()) return 'Plan revision rejected: a plan is already registered. Pass a "reason" explaining why the plan changed.';
    if (session.revisionsThisMessage >= MAX_REVISIONS_PER_MESSAGE) {
      return `Plan revision rejected: at most ${MAX_REVISIONS_PER_MESSAGE} revisions are allowed per user message. Continue with the current plan or ask the user how to proceed.`;
    }
  }

  const parsed = parsePlan(raw, previous ? previous.revision + 1 : 1, ctx.messageID);
  if (!parsed.ok) return `Plan rejected: ${parsed.error}`;
  const draft = parsed.plan;

  const policy = rt.policy.current();
  for (const [i, step] of draft.steps.entries()) {
    const verdict = policy.evaluate({ sessionId: id, callId: `plan:${i}`, tool: step.tool, args: step.params ?? {} });
    if (verdict.effect === "forbid") {
      return `Plan rejected: step ${i + 1} uses ${step.tool}, which the current policy forbids${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ""}: ${verdict.reason}`;
    }
  }

  const login = rt.login();
  if (!login) {
    rt.sessions.setPlan(id, { ...draft, id: "" }, null);
    return `Intent recorded locally: ${draft.steps.length} steps. ArmorIQ is not logged in, so calls are monitored, not enforced.`;
  }

  if (isRevision) rt.sessions.noteRevision(id);
  st.registering.add(id);
  try {
    const minted = await mintToken(login, draft, id);
    if (!minted.ok) {
      if (minted.relogin) rt.credentials.markRelogin(minted.reason);
      const kept = previous ? " The previous plan is still in effect." : " No plan is active, so side-effecting calls stay blocked.";
      return `Plan not registered: ArmorIQ could not issue an intent token (${minted.reason}).${kept} Try again shortly.`;
    }
    const { token, planId } = minted.value;
    if (token.status === "refused") {
      rt.sessions.setToken(id, token);
      return token.code === "account_revoked"
        ? "Plan not registered: the ArmorIQ API key was revoked (account_revoked). Tool calls are blocked until the user logs in again."
        : "Plan not registered: the ArmorIQ organization has no active subscription or is over quota (billing_blocked). Tool calls are blocked.";
    }
    const plan: Plan = { ...draft, id: planId };
    rt.sessions.setPlan(id, plan, token);
    if (isRevision && previous) await recordRevision(rt, session, previous, plan, reason);
    return describeRegistered(plan, token, isRevision);
  } finally {
    st.registering.delete(id);
  }
}

async function recordRevision(rt: Runtime, session: Session, previous: Plan, plan: Plan, reason: string): Promise<void> {
  const login = rt.login();
  if (!login) return;
  let trustId: string | null = null;
  if (previous.id) {
    const { id: _id, ...unminted } = plan;
    const r = await reanchor(login, previous.id, unminted, reason);
    if (r.ok) trustId = r.value.trustId;
    else rt.log.warn("reanchor failed", { sessionID: session.id, reason: r.reason });
  }
  const row: AuditRow = {
    plan_id: plan.id || undefined,
    session_id: session.id,
    user_id: login.userId,
    step_index: -1,
    action: "plan_revision",
    tool: "register_intent_plan",
    input: {
      reason: reason.slice(0, 2000),
      old_plan_id: previous.id,
      old_plan_hash: previous.hash,
      new_plan_hash: plan.hash,
      revision: plan.revision,
      ...(trustId ? { trust_id: trustId } : {}),
    },
    status: "held",
    error_message: `plan_revision: ${reason.slice(0, 500)}`,
    executed_at: new Date().toISOString(),
  };
  try {
    rt.audit.enqueue(row);
  } catch (error) {
    rt.log.error("audit enqueue failed", { error: String(error) });
  }
}

async function revokeCurrent(rt: Runtime, id: SessionID, reason: string): Promise<string> {
  const session = sessionFor(rt, id);
  if (session.parentId !== null) return "This is a subagent session; its plan belongs to the parent session and cannot be revoked here.";
  if (!session.plan) return "No registered plan to revoke.";
  if (!reason.trim()) return 'Revoke rejected: pass a "reason".';
  const login = rt.login();
  if (login && session.plan.id) {
    const r = await revoke(login, session.plan.id, reason);
    if (!r.ok) return `Revoke failed: ${r.reason}. The plan is still registered.`;
  }
  rt.sessions.clearPlan(id);
  return "Intent token revoked. Side-effecting calls are blocked until a new plan is registered.";
}

export function policyRead(rt: Runtime, id: SessionID, toolName?: string): string {
  const policy = rt.policy.current();
  const lines = [`Policy hash: ${policy.hash}`, `Intent plan required: ${policy.intentRequired ? "yes" : "no"}`, `Mode: ${rt.mode()}`];
  if (toolName) {
    const v = policy.evaluate({ sessionId: id, callId: "policy_read", tool: toolName, args: {} });
    lines.push(`${toolName}: ${v.effect}${v.ruleId ? ` (rule ${v.ruleId})` : ""}${v.reason ? `: ${v.reason}` : ""}`);
  }
  const t = rt.sessions.has(id) ? rt.sessions.root(id).token : null;
  if (t?.status === "active") {
    if (t.deniedTools.size) lines.push(`Denied by backend: ${[...t.deniedTools].join(", ")}`);
    if (t.heldTools.size) lines.push(`Held for approval by backend: ${[...t.heldTools].join(", ")}`);
  }
  return lines.join("\n");
}

function describeRegistered(plan: Plan, token: Token, isRevision: boolean): string {
  const expiry = token.status === "active" ? ` Token valid until ${new Date(token.expiresAt).toISOString()}.` : "";
  const denied = token.status === "active" && token.deniedTools.size ? ` Denied by policy: ${[...token.deniedTools].join(", ")}.` : "";
  const held = token.status === "active" && token.heldTools.size ? ` Requires approval: ${[...token.heldTools].join(", ")}.` : "";
  return `Intent ${isRevision ? `revised (revision ${plan.revision})` : "registered"}: ${plan.steps.length} steps.${expiry}${denied}${held}`;
}

function sessionFor(rt: Runtime, id: string): Session {
  const sid = id as SessionID;
  return rt.sessions.has(sid) ? rt.sessions.get(sid) : rt.sessions.open(sid, null, rt.mode());
}

const key = (sessionID: string, tool: string) => `${sessionID}\u0000${tool}`;

// MCP tools are merged into OpenCode's tool map after plugin tools, so an MCP tool named like
// one of ours silently replaces it. A call that completes without our execute running is that case.
export function noteToolBefore(rt: Runtime, sessionID: string, toolName: string): void {
  if (!OWN_TOOL_NAMES.includes(toolName)) return;
  const pending = stateFor(rt).ownPending;
  const k = key(sessionID, toolName);
  pending.set(k, (pending.get(k) ?? 0) + 1);
}

export function noteToolAfter(rt: Runtime, sessionID: string, toolName: string): void {
  if (!OWN_TOOL_NAMES.includes(toolName)) return;
  const pending = stateFor(rt).ownPending;
  const k = key(sessionID, toolName);
  const n = pending.get(k) ?? 0;
  if (n <= 0) return;
  if (n === 1) pending.delete(k);
  else pending.set(k, n - 1);
  if (rt.shadowedTools.has(toolName)) return;
  rt.shadowedTools.add(toolName);
  rt.log.warn("an MCP tool shadows an ArmorIQ tool; further calls to it are blocked", { tool: toolName });
}

function markOwnExecute(rt: Runtime, sessionID: string, toolName: string): void {
  const pending = stateFor(rt).ownPending;
  const k = key(sessionID, toolName);
  const n = pending.get(k) ?? 0;
  if (n <= 1) pending.delete(k);
  else pending.set(k, n - 1);
}
