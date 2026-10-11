import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runtime } from "../../src/runtime.ts";
import type { CompiledPolicy, Decision, Login, Plan, PlanStep, Session, ToolCall } from "../../src/types.ts";
import * as realIntent from "../../src/core/intent.ts";
import * as realDecide from "../../src/core/decide.ts";

// Lane A owns core/intent.ts and core/decide.ts. Until they land, these STAND-INS replace them so lane C
// can be tested end to end. They are deliberately minimal and are swapped out automatically once the
// real functions stop throwing "not implemented".

function implemented(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    return !String(error).includes("not implemented");
  }
}

export const usingParsePlanStandIn = !implemented(() => realIntent.parsePlan({}, 1, "m"));

function standInParsePlan(raw: unknown, revision: number, messageId: string): realIntent.ParsePlanResult {
  let args = raw as Record<string, unknown>;
  if (args && typeof args.plan === "string") args = { ...JSON.parse(args.plan), ...args, plan: undefined };
  else if (args && args.plan && typeof args.plan === "object") args = { ...(args.plan as object), ...args, plan: undefined };
  if (args && typeof args.steps === "string") args = { ...args, steps: JSON.parse(args.steps) };
  const goal = args?.goal;
  const steps = args?.steps;
  if (typeof goal !== "string" || !goal) return { ok: false, error: "goal is required" };
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: "steps must be a non-empty array" };
  const out: PlanStep[] = [];
  for (const s of steps as Record<string, unknown>[]) {
    if (typeof s?.action !== "string" || !s.action) return { ok: false, error: "each step needs an action" };
    const inputs = (s.metadata as { inputs?: Record<string, unknown> } | undefined)?.inputs;
    out.push({ action: typeof s.description === "string" ? s.description : s.action, tool: s.action, ...(inputs ? { params: inputs } : {}) });
  }
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify({ goal, steps: out })).digest("hex");
  return { ok: true, plan: { hash, goal, steps: out, revision, registeredInMessage: messageId } };
}

if (usingParsePlanStandIn) {
  mock.module("../../src/core/intent.ts", () => ({ ...realIntent, parsePlan: standInParsePlan }));
}

export const usingDecideStandIn = !implemented(() =>
  realDecide.decide({
    policy: allowAllPolicy(),
    session: blankSession("x"),
    root: blankSession("x"),
    call: { sessionId: "x" as Session["id"], callId: "c", tool: "read", args: {} },
    now: 0,
    builtin: { armoriqDir: "/nonexistent", ownTools: new Set(), shadowedTools: new Set() },
  }),
);

const READ_ONLY = new Set(["read", "grep", "glob", "list", "webfetch", "websearch", "todoread", "todowrite"]);
const OWN = new Set(["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"]);

// STAND-IN for lane A's decide(): only the plan and token checks this lane's scenario exercises.
function standInDecide(input: { policy: CompiledPolicy; session: Session; root: Session; call: ToolCall; now: number }): Decision {
  const { call, root, now } = input;
  const p = input.policy.evaluate(call);
  if (p.effect === "forbid") return { kind: "deny", code: "policy_forbid", reason: p.reason, ruleId: p.ruleId };
  if (OWN.has(call.tool) || READ_ONLY.has(call.tool) || input.session.mode === "monitor") return { kind: "allow", stepIndex: null, paramMismatch: false };
  const t = root.token;
  if (t?.status === "refused") return { kind: "deny", code: t.code, reason: t.code, ruleId: null };
  if (!root.plan) return { kind: "deny", code: "intent_plan_missing", reason: "no plan", ruleId: null };
  if (!t || t.expiresAt <= now) return { kind: "deny", code: "intent_token_expired", reason: "expired", ruleId: null };
  if (t.deniedTools.has(call.tool)) return { kind: "deny", code: "backend_denied_tool", reason: call.tool, ruleId: null };
  const idx = root.plan.steps.findIndex((s) => s.tool === call.tool);
  if (idx < 0) return { kind: "deny", code: "intent_drift", reason: `${call.tool} not in plan`, ruleId: null };
  return { kind: "allow", stepIndex: idx, paramMismatch: false };
}

export function decide(session: Session, root: Session, call: Omit<ToolCall, "sessionId" | "callId">, policy = allowAllPolicy()): Decision {
  const full: ToolCall = { sessionId: session.id, callId: crypto.randomUUID(), ...call };
  const input = {
    policy,
    session,
    root,
    call: full,
    now: Date.now(),
    builtin: { armoriqDir: "/nonexistent", ownTools: OWN, shadowedTools: new Set<string>() },
  };
  return usingDecideStandIn ? standInDecide(input) : realDecide.decide(input);
}

export function allowAllPolicy(forbid: readonly string[] = []): CompiledPolicy {
  return {
    hash: "policy-hash-test",
    intentRequired: true,
    evaluate: (call) =>
      forbid.includes(call.tool)
        ? { effect: "forbid", ruleId: `deny-${call.tool}`, reason: `${call.tool} is forbidden` }
        : { effect: "permit", ruleId: null, reason: "" },
  };
}

function blankSession(id: string): Session {
  return { id: id as Session["id"], parentId: null, mode: "enforce", plan: null, token: null, stepCursor: 0, revisionsThisMessage: 0, currentMessageId: null };
}

export type StubRequest = { path: string; body: any; at: number };
export type StubReply = { status?: number; delayMs?: number; body?: unknown };

// Logging stand-in for the ArmorIQ backend on 127.0.0.1. Replies are queued per path; the default is success.
export function startStubBackend() {
  const requests: StubRequest[] = [];
  const queued = new Map<string, StubReply[]>();
  let planSeq = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      requests.push({ path: url.pathname, body, at: Date.now() });
      const reply = queued.get(url.pathname)?.shift() ?? {};
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      if (reply.status && reply.status >= 400) return Response.json(reply.body ?? { message: `stub ${reply.status}` }, { status: reply.status });
      if (reply.body) return Response.json(reply.body, { status: reply.status ?? 200 });
      if (url.pathname === "/iap/sdk/token") {
        planSeq += 1;
        return Response.json({
          success: true,
          plan_id: `plan-${planSeq}`,
          plan_hash: `hash-${planSeq}`,
          intent_reference: `ref-${planSeq}`,
          token: { signature: `sig-${planSeq}`, issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
          policy_validation: { allowed_tools: [], denied_tools: [], held_tools: [] },
        });
      }
      if (url.pathname === "/iap/trust/reanchor") return Response.json({ trustId: "trust-reanchor", delta: { payload: { from_hash: "a", to_hash: "b" } } });
      if (url.pathname === "/iap/trust/revoke") return Response.json({ trustId: "trust-revoke", delta: {} });
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    queue(pathname: string, ...replies: StubReply[]) {
      queued.set(pathname, [...(queued.get(pathname) ?? []), ...replies]);
    },
    paths: () => requests.map((r) => r.path),
    stop: () => server.stop(true),
    login: (): Login => ({
      backend: url,
      apiKey: "ak_test_lanec",
      userId: "user-1",
      orgId: "org-1",
      email: "dev@example.com",
      deviceId: "device-1",
      deviceName: "test",
    }),
  };
}

export type FakeRuntime = Runtime & { auditRows: unknown[]; warnings: string[]; setLogin(l: Login | null): void; setPolicy(p: CompiledPolicy): void };

// Only the Runtime members lane C touches; the real Runtime wires lanes that are not merged yet.
export async function fakeRuntime(login: Login | null, policy = allowAllPolicy()): Promise<FakeRuntime> {
  const { createSessionStore } = await import("../../src/state/sessions.ts");
  let current = login;
  let pol = policy;
  const mode = (): "enforce" | "monitor" => (current ? "enforce" : "monitor");
  const auditRows: unknown[] = [];
  const warnings: string[] = [];
  const log = { info() {}, warn: (m: string) => void warnings.push(m), error: (m: string) => void warnings.push(m) };
  const rt = {
    sessions: createSessionStore(mkdtempSync(path.join(tmpdir(), "aoc-sessions-")), mode),
    policy: { current: () => pol, stop() {} },
    audit: { enqueue: (row: unknown) => void auditRows.push(row) },
    credentials: { current: () => current, markRelogin() {}, stop() {} },
    shadowedTools: new Set<string>(),
    log,
    login: () => current,
    mode,
    auditRows,
    warnings,
    setLogin: (l: Login | null) => {
      current = l;
    },
    setPolicy: (p: CompiledPolicy) => {
      pol = p;
    },
  };
  return rt as unknown as FakeRuntime;
}

export const planArgs = (...tools: string[]) => ({
  goal: `use ${tools.join(", ")}`,
  steps: tools.map((t) => ({ action: t, description: `run ${t}` })),
});

export type { Plan };
