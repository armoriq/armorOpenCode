import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BundleAgent } from "../../src/core/policy-v2.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { CompiledPolicy, Decision, Login, Plan, Session, SessionID, ToolCall } from "../../src/types.ts";
import { decide as realDecide } from "../../src/core/decide.ts";

const OWN = new Set(["register_intent_plan", "policy_read", "trust_reanchor", "trust_revoke"]);

// The deciding policy layer is covered in policy-v2.test.ts; intent tests compare the decision alone.
export function decide(session: Session, root: Session, call: Omit<ToolCall, "sessionId" | "callId">, policy = allowAllPolicy()): Decision {
  const { policy: _decidedBy, ...decision } = realDecide({
    policy,
    session,
    root,
    call: { sessionId: session.id, callId: crypto.randomUUID(), ...call },
    now: Date.now(),
    builtin: { armoriqDir: "/nonexistent", ownTools: OWN, shadowedTools: new Set<string>() },
  });
  return decision;
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

export type StubRequest = { path: string; body: any; at: number };
export type StubReply = { status?: number; delayMs?: number; body?: unknown };

// Logging stand-in for the ArmorIQ backend on 127.0.0.1. Replies are queued per path; the default is success.
export function startStubBackend() {
  const requests: StubRequest[] = [];
  const queued = new Map<string, StubReply[]>();
  let planSeq = 0;
  const routes: Record<string, () => Response> = {
    "/iap/sdk/token": () => {
      planSeq += 1;
      return Response.json({
        success: true,
        plan_id: `plan-${planSeq}`,
        plan_hash: `hash-${planSeq}`,
        intent_reference: `ref-${planSeq}`,
        token: { signature: `sig-${planSeq}`, issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
        policy_validation: { allowed_tools: [], denied_tools: [], held_tools: [] },
      });
    },
    "/iap/trust/reanchor": () => Response.json({ trustId: "trust-reanchor", delta: { payload: { from_hash: "a", to_hash: "b" } } }),
    "/iap/trust/revoke": () => Response.json({ trustId: "trust-revoke", delta: {} }),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      requests.push({ path: url.pathname, body, at: Date.now() });
      const queuedReply = await replyWith(queued.get(url.pathname)?.shift() ?? {});
      return queuedReply ?? routes[url.pathname]?.() ?? Response.json({ message: "not found" }, { status: 404 });
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
      apiKey: "ak_test_intent",
      userId: "user-1",
      orgId: "org-1",
      email: "dev@example.com",
      deviceId: "device-1",
      deviceName: "test",
    }),
  };
}

// A queued reply with only a delay falls through to the default route.
async function replyWith(reply: StubReply): Promise<Response | null> {
  if (reply.delayMs) await Bun.sleep(reply.delayMs);
  if (reply.status && reply.status >= 400) return Response.json(reply.body ?? { message: `stub ${reply.status}` }, { status: reply.status });
  return reply.body ? Response.json(reply.body, { status: reply.status ?? 200 }) : null;
}

export type FakeRuntime = Runtime & { sessionDir: string; auditRows: unknown[]; warnings: string[]; signedOut: string[]; setLogin(l: Login | null): void; setPolicy(p: CompiledPolicy): void; setBundle(agent: BundleAgent | undefined | null): void };

// Only the Runtime members the intent tools and /armor touch.
export async function fakeRuntime(login: Login | null, policy = allowAllPolicy()): Promise<FakeRuntime> {
  const { createSessionStore } = await import("../../src/state/sessions.ts");
  let current = login;
  let pol = policy;
  let bundleAgent: BundleAgent | undefined | null = null;
  const mode = (): "enforce" | "monitor" => (current ? "enforce" : "monitor");
  const auditRows: unknown[] = [];
  const warnings: string[] = [];
  const signedOut: string[] = [];
  const log = { info() {}, warn: (m: string) => void warnings.push(m), error: (m: string) => void warnings.push(m) };
  const sessionDir = mkdtempSync(path.join(tmpdir(), "aoc-sessions-"));
  const rt = {
    sessionDir,
    sessions: createSessionStore(sessionDir, mode, () => current),
    policy: { current: () => pol, stop() {} },
    bundle: {
      state: () => (bundleAgent === null ? { status: "unavailable" } : { status: "current", agent: bundleAgent, checkedAt: Date.now() }),
      refresh: async () => {},
      stop() {},
    },
    audit: { enqueue: (row: unknown) => void auditRows.push(row), status: () => ({ pending: 0, undeliverable: 0, deadLetters: 0, captureFailures: 0 }), captureFailure() {}, loginChanged() {} },
    health: { status: () => ({ pending: 0, paused: false, undeliverable: 0, deadLetters: 0, captureFailures: 0 }), planRequestFailed() {}, async planRequestSucceeded() {} },
    credentials: { current: () => current, markRelogin() {}, markSignedOut: (reason: string) => void signedOut.push(reason), stop() {} },
    posture: { check: async () => "reachable", warm() {}, report() {}, seen: () => null },
    shadowedTools: new Set<string>(),
    // These tests cover Block; workspace Monitor has its own (org-monitor.test.ts).
    org: { current: () => ({ mode: "enforce", notices: false }), refresh() {} },
    noticeListeners: new Set(),
    // Runtime.openSession also asks the workspace mode; these tests cover Block only.
    openSession: (id: string, parentId: string | null) => rt.sessions.open(id as SessionID, parentId as SessionID | null, mode()),
    onNotice: () => () => {},
    log,
    login: () => current,
    mode,
    auditRows,
    warnings,
    signedOut,
    setLogin: (l: Login | null) => {
      current = l;
      rt.sessions.syncAuth();
    },
    setPolicy: (p: CompiledPolicy) => {
      pol = p;
    },
    // null: no bundle fetched yet; undefined: the bundle has no entry for this agent.
    setBundle: (agent: BundleAgent | undefined | null) => {
      bundleAgent = agent;
    },
  };
  return rt as unknown as FakeRuntime;
}

export const planArgs = (...tools: string[]) => ({
  goal: `use ${tools.join(", ")}`,
  steps: tools.map((t) => ({ action: t, description: `run ${t}` })),
});

export type { Plan };
