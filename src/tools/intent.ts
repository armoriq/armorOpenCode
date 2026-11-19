import { parsePlan } from "../core/intent.ts";
import { intentValiditySeconds, planRequest, toSdkPlan } from "../core/plan-request.ts";
import { AGENT_ID, logLegacyBackend, mintToken, reanchor, revoke } from "../io/backend-intent.ts";
import type { Runtime } from "../runtime.ts";
import type { Plan, Session, SessionGeneration, SessionID, PlanKind, Token } from "../types.ts";

export const OWN_TOOL_NAMES: readonly string[] = ["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"];

export const MAX_REVISIONS_PER_MESSAGE = 2;

export const SUBAGENT_CANNOT_REGISTER =
  "This is a subagent session. It inherits the plan registered by its parent session and cannot register its own. Continue within the parent plan.";
export const SUBAGENT_CANNOT_REVOKE = "This is a subagent session; its plan belongs to the parent session and cannot be revoked here.";

export const INTENT_DIRECTIVE = [
  "ArmorIQ intent enforcement is active for this session.",
  "For this user prompt, before the first tool that needs a plan (bash, write, edit, apply_patch, task, or an MCP tool), call register_intent_plan once with the plan in this JSON shape:",
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

type ToolState = { ownPending: Set<string> };
const states = new WeakMap<Runtime, ToolState>();

function stateFor(rt: Runtime): ToolState {
  let s = states.get(rt);
  if (!s) {
    s = { ownPending: new Set() };
    states.set(rt, s);
  }
  return s;
}

export type PlanContext = { sessionID: string; messageID: string };

const notRegistered = (reason: string) => `Plan not registered: ${reason.replace(/\.+$/, "")}.`;
const notConfirmed = (reason: string) => `Plan registration not confirmed: ${reason.replace(/\.+$/, "")}. It will be retried with the same request id.`;

// Both hosts mark a thrown tool result as an error.
export function registrationReply(text: string): string {
  if (text.startsWith("Intent registered:") || text.startsWith("Plan recorded locally,")) return text;
  throw new Error(text);
}

export async function registerPlan(rt: Runtime, ctx: PlanContext, raw: unknown, reason: string, forceRevision = false): Promise<string> {
  const id = ctx.sessionID as SessionID;
  const session = sessionFor(rt, id);
  if (session.parentId !== null) return notRegistered(SUBAGENT_CANNOT_REGISTER);
  const generation = { promptId: session.promptId, promptGeneration: session.promptGeneration, authGeneration: session.authGeneration };
  return rt.sessions.serialize(id, () => registerCurrent(rt, ctx, raw, reason, forceRevision, session, generation));
}

async function registerCurrent(rt: Runtime, ctx: PlanContext, raw: unknown, reason: string, forceRevision: boolean, session: Session, generation: SessionGeneration): Promise<string> {
    const id = session.id;
    if (!rt.sessions.isCurrent(id, generation)) return notRegistered("the prompt or authentication changed");
    const previous = session.plan;
    const previousTokenPlanId = session.tokenPlanId ?? previous?.id;
    const revising = previous?.id && session.countedPlanId ? previous : null;
    const parsed = parsePlan(raw, revising ? previous!.revision + 1 : 1, ctx.messageID);
    if (!parsed.ok) return notRegistered(parsed.error);
    const forbidden = forbiddenStep(rt, id, parsed.plan);
    if (forbidden) return notRegistered(forbidden);
    if (forceRevision && (!revising || !session.promptId)) return notRegistered("no registered plan in the current prompt to reanchor");
    const login = rt.login();
    // Mode follows login here. The monitor branch also supports hosts that supply a mode independently.
    if (!login || rt.mode() === "monitor") {
      rt.sessions.setPlan(id, { ...parsed.plan, id: "" }, null, generation);
      await rt.sessions.flush();
      return `Plan recorded locally, not registered (${login ? "monitor_mode" : "logged_out"}).`;
    }
    if (!session.promptId) return notRegistered("no current user prompt");
    if (!forceRevision && revising && session.planHash === parsed.plan.hash && session.token?.status === "active" && session.token.jwt && session.token.expiresAt > Date.now()) {
      return describeRegistered(previous!, session.token, session.kind === "revision" ? "revision" : "new", session.countedPlanId!);
    }
    if (revising) {
      if (!reason.trim()) return notRegistered('a plan is already registered. Pass a "reason" explaining why the plan changed');
      if (session.revisionsThisMessage >= MAX_REVISIONS_PER_MESSAGE) return notRegistered(`at most ${MAX_REVISIONS_PER_MESSAGE} revisions are allowed per user message`);
    }
    const kind = revising ? "revision" : "new";
    const request = planRequest({ kind, promptId: session.promptId, parentPlanId: session.countedPlanId, planHash: parsed.plan.hash, epoch: session.retirementEpoch }, {
      user_id: login.userId, agent_id: AGENT_ID, context_id: id, plan: toSdkPlan(parsed.plan), expires_in: intentValiditySeconds(process.env),
    });
    const pending = session.pendingRequest;
    // A revision supersedes a token refresh. An uncertain counted request must be resolved first.
    if (pending && pending.key !== request.key && pending.headers["X-ArmorIQ-Plan-Kind"] !== "refresh") {
      const wirePlan = pending.body.plan as { goal: string; steps: Array<{ action: string; tool: string; description: string; metadata: unknown }> };
      const pendingPlan = { goal: wirePlan.goal, steps: wirePlan.steps.map(step => ({ action: step.description, tool: step.tool, metadata: step.metadata })) };
      const settled = await registerCurrent(rt, ctx, pendingPlan, reason, pending.headers["X-ArmorIQ-Plan-Kind"] === "revision", session, generation);
      if (!rt.sessions.isCurrent(id, generation) || session.pendingRequest) return settled;
      return registerCurrent(rt, ctx, raw, reason, forceRevision, session, generation);
    }
    const descriptor = pending?.key === request.key ? pending : request;
    try {
      if (!await rt.sessions.persistRequest(id, descriptor, generation)) return notRegistered("the prompt or authentication changed");
    } catch {
      return notRegistered("could not persist the plan request");
    }
    const minted = await mintToken(login, descriptor, { cancelled: () => !rt.sessions.isCurrent(id, generation) });
    if (!rt.sessions.isCurrent(id, generation) || rt.sessions.get(id) !== session) {
      if (minted.ok && minted.value.token.status === "active") return `Plan dropped: the prompt or authentication changed while registration was in progress. The backend confirmed plan ${minted.value.planId} for the earlier request.`;
      return notRegistered("the prompt or authentication changed while registration was in progress");
    }
    rt.posture.report(minted, login);
    if (!minted.ok) {
      if (minted.relogin) rt.credentials.markRelogin(minted.reason);
      if (minted.retryable || minted.unconfirmed) return notConfirmed(minted.reason);
      await rt.sessions.persistRequest(id, null, generation);
      return notRegistered(minted.reason);
    }
    const { token, planId } = minted.value;
    if (token.status === "refused") {
      rt.sessions.setToken(id, token, generation);
      await rt.sessions.persistRequest(id, null, generation);
      return notRegistered(token.code);
    }
    if (minted.value.legacy) logLegacyBackend(rt.log);
    const plan: Plan = { ...parsed.plan, id: planId };
    rt.sessions.setPlan(id, plan, token, generation);
    if (revising) rt.sessions.noteRevision(id);
    await rt.sessions.flush();
    if (revising) await reanchorRevision(rt, revising, plan, reason, session.id, previousTokenPlanId!);
    return describeRegistered(plan, token, minted.value.kind ?? kind, planId);
}

function forbiddenStep(rt: Runtime, id: SessionID, draft: Omit<Plan, "id">): string | null {
  const policy = rt.policy.current();
  for (const [i, step] of draft.steps.entries()) {
    const verdict = policy.evaluate({ sessionId: id, callId: `plan:${i}`, tool: step.tool, args: step.params ?? {} });
    if (verdict.effect === "forbid") {
      return `step ${i + 1} uses ${step.tool}, which the current policy forbids${verdict.ruleId ? ` (rule ${verdict.ruleId})` : ""}: ${verdict.reason}`;
    }
  }
  return null;
}

async function reanchorRevision(rt: Runtime, previous: Plan, plan: Plan, reason: string, sessionId: SessionID, previousTokenPlanId: string): Promise<void> {
  const login = rt.login();
  if (!login) return;
  if (previous.id) {
    const { id: _id, ...unminted } = plan;
    const r = await reanchor(login, previousTokenPlanId, unminted, reason);
    rt.posture.report(r, login);
    if (!r.ok) rt.log.warn("reanchor failed", { sessionID: sessionId, reason: r.reason });
  }
}

export async function reanchorPlan(rt: Runtime, ctx: PlanContext, updatedPlan: unknown, reason: string): Promise<string> {
  return registerPlan(rt, ctx, { plan: updatedPlan }, reason, true);
}

export async function revokeCurrent(rt: Runtime, id: SessionID, reason: string): Promise<string> {
  const session = sessionFor(rt, id);
  if (session.parentId !== null) return SUBAGENT_CANNOT_REVOKE;
  if (!reason.trim()) return 'Revoke rejected: pass a "reason".';
  const generation = { promptId: session.promptId, promptGeneration: session.promptGeneration, authGeneration: session.authGeneration };
  return rt.sessions.serialize(id, async () => {
    if (!rt.sessions.isCurrent(id, generation)) return "Revoke dropped: the prompt or authentication changed.";
    if (!session.plan) return "No registered plan to revoke.";
    const login = rt.login();
    const planIds = [...new Set([session.tokenPlanId, session.countedPlanId ?? session.plan.id].filter((value): value is string => !!value))];
    if (login) for (const planId of planIds) {
      const r = await revoke(login, planId, reason);
      rt.posture.report(r, login);
      if (!rt.sessions.isCurrent(id, generation)) return "Revoke dropped: the prompt or authentication changed.";
      if (!r.ok) return `Revoke failed: ${r.reason}. The plan is still registered.`;
    }
    rt.sessions.clearPlan(id);
    await rt.sessions.flush();
    return "Intent token revoked. Side-effecting calls are blocked until a new plan is registered.";
  });
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

function describeRegistered(plan: Plan, token: Token, kind: PlanKind, countedPlanId: string): string {
  if (token.status !== "active") return notRegistered(token.code);
  const lines = [`Intent registered: plan ${countedPlanId} (${kind}), ${plan.steps.length} steps. Token valid until ${new Date(token.expiresAt).toISOString()}.`];
  if (token.deniedTools.size) lines.push(`Denied by policy: ${[...token.deniedTools].join(", ")}.`);
  if (token.heldTools.size) lines.push(`Requires approval: ${[...token.heldTools].join(", ")}.`);
  return lines.join("\n");
}

function sessionFor(rt: Runtime, id: string): Session {
  const sid = id as SessionID;
  return rt.sessions.has(sid) ? rt.sessions.get(sid) : rt.sessions.open(sid, null, rt.mode());
}

// MCP tools are merged into OpenCode's tool map after plugin tools, so an MCP tool named like
// one of ours silently replaces it. A call whose after hook runs without our execute having run is
// that case. Matching by call id means a call stopped between the hooks (another plugin's before
// hook threw) is never mistaken for one.
export function noteOwnExecute(rt: Runtime, callID: string): void {
  stateFor(rt).ownPending.delete(callID);
}

export function noteToolBefore(rt: Runtime, toolName: string, callID: string): void {
  if (OWN_TOOL_NAMES.includes(toolName)) stateFor(rt).ownPending.add(callID);
}

export function noteToolAfter(rt: Runtime, toolName: string, callID: string): void {
  if (!stateFor(rt).ownPending.delete(callID) || rt.shadowedTools.has(toolName)) return;
  rt.shadowedTools.add(toolName);
  rt.log.warn("an MCP tool shadows an ArmorIQ tool; further calls to it are blocked", { tool: toolName });
}
