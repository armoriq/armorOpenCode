import { homedir } from "node:os";
import path from "node:path";
import { toAuditRow } from "./core/audit.ts";
import type { BuiltinContext } from "./core/builtin-rules.ts";
import { capabilityOf, type Capability } from "./core/capability.ts";
import { decide } from "./core/decide.ts";
import { stepUsage, titleFromSession } from "./core/usage.ts";
import { probeBackend } from "./io/backend-health.ts";
import { createCredentials, type Credentials } from "./io/credentials.ts";
import { createAuditPump, type AuditPump } from "./pumps/audit.ts";
import { createTokenPump } from "./pumps/token.ts";
import { createTracePump, type TracePump } from "./pumps/traces.ts";
import { createUsagePump, type UsagePump } from "./pumps/usage.ts";
import { createBackendPosture, type BackendPosture } from "./state/backend-posture.ts";
import { createPolicySource, type PolicySource } from "./state/policy-source.ts";
import { createSessionStore, type SessionStore } from "./state/sessions.ts";
import { OWN_TOOL_NAMES } from "./tools/intent.ts";
import type { AuditStatus, Decision, Log, Login, Mode, Pump, SessionID, StepTokens, ToolCall } from "./types.ts";

export const ARMORIQ_DIR = process.env.ARMORIQ_HOME ?? path.join(homedir(), ".armoriq");
export const DATA_DIR = path.join(ARMORIQ_DIR, "armoropencode");

export class GuardDenied extends Error {
  constructor(readonly decision: Exclude<Decision, { kind: "allow" }>) {
    super(denialMessage(decision));
    this.name = "ArmorIQ";
  }
}

function denialMessage(d: Exclude<Decision, { kind: "allow" }>): string {
  if (d.kind === "hold") return `ArmorIQ: approval required (${d.reason}). This call was not run.`;
  return `ArmorIQ blocked this call [${d.code}]: ${d.reason}`;
}

type Pending = { call: ToolCall; decision: Decision; at: number; capability: Capability };

// A rule's own block stands. Anything that would run or wait for approval needs the backend, and so does
// the fix for a missing plan or an expired token: re-registering mints a token.
const NEEDS_BACKEND: ReadonlySet<string> = new Set(["intent_plan_missing", "intent_token_expired"]);
const waitsOnBackend = (d: Decision) => d.kind !== "deny" || NEEDS_BACKEND.has(d.code);

export const UNREACHABLE_HINT = "the ArmorIQ backend is unreachable, so only read calls run. Run `/armor status` to check it, then retry.";

export class Runtime {
  readonly sessions: SessionStore;
  readonly policy: PolicySource;
  readonly audit: AuditPump;
  readonly usage: UsagePump;
  readonly traces: TracePump;
  readonly tokens: Pump & { revoke(sessionId: string): void };
  readonly credentials: Credentials;
  readonly posture: BackendPosture;
  readonly shadowedTools = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly messageModel = new Map<string, string>();
  private readonly builtin: BuiltinContext;

  constructor(readonly log: Log, backend?: string) {
    this.credentials = createCredentials(log, { backend });
    this.posture = createBackendPosture({
      probe: probeBackend,
      log,
      onUnauthorized: (reason) => this.credentials.markSignedOut(reason),
      onRecovered: () => this.audit.retryNow(),
    });
    const report = this.posture.report;
    this.policy = createPolicySource(path.join(DATA_DIR, "policy.json"), log);
    this.sessions = createSessionStore(path.join(DATA_DIR, "sessions"), () => this.mode());
    const login = () => this.login();
    this.audit = createAuditPump({ dataDir: DATA_DIR, login, log, report, relogin: (reason) => this.credentials.markRelogin(reason) });
    this.usage = createUsagePump({ dataDir: DATA_DIR, login, log });
    this.traces = createTracePump({ login, log });
    const revoked = () => this.credentials.markSignedOut("token endpoint returned 401");
    this.tokens = createTokenPump({ sessions: this.sessions, login, log, report, revoked });
    this.builtin = { armoriqDir: ARMORIQ_DIR, ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: this.shadowedTools };
    for (const pump of [this.audit, this.usage, this.traces, this.tokens]) pump.start();
  }

  login(): Login | null {
    return this.credentials.current();
  }

  mode(): Mode {
    return this.login() ? "enforce" : "monitor";
  }

  async before(call: ToolCall): Promise<void> {
    const now = Date.now();
    const session = this.ensureSession(call.sessionId);
    const capability = capabilityOf(call.tool, this.builtin.ownTools);
    let decision: Decision;
    try {
      decision = decide({
        policy: this.policy.current(),
        session,
        root: this.sessions.root(call.sessionId),
        call,
        now,
        builtin: this.builtin,
      });
    } catch (error) {
      this.log.error("decide failed", { error: String(error), tool: call.tool });
      decision = { kind: "deny", code: "internal_error", reason: "guard error", ruleId: null };
    }
    const login = this.login();
    if (login && waitsOnBackend(decision)) {
      if (capability === "read") this.posture.warm(login);
      else if ((await this.posture.check(login)) === "unreachable") {
        decision = { kind: "deny", code: "backend_unreachable", reason: UNREACHABLE_HINT, ruleId: null };
      }
    }
    this.traces.record({ kind: "decision", call, decision, at: now });

    const outage = decision.kind === "deny" && decision.code === "backend_unreachable";
    if (decision.kind === "allow" || (session.mode === "monitor" && !outage)) {
      if (decision.kind === "allow" && decision.stepIndex !== null) this.sessions.advance(call.sessionId, decision.stepIndex);
      this.pending.set(call.callId, { call, decision, at: now, capability });
      deepFreeze(call.args);
      return;
    }
    this.record(call, decision.kind === "hold" ? "held" : "blocked", decision, null, null, 0, now, capability);
    throw new GuardDenied(decision);
  }

  after(callId: string, output: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    const now = Date.now();
    this.record(pending.call, "success", pending.decision, output, null, now - pending.at, now, pending.capability);
    this.traces.record({ kind: "result", call: pending.call, status: "success", output, at: now });
  }

  failed(callId: string, status: "failed" | "error", error: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    const now = Date.now();
    this.record(pending.call, status, pending.decision, null, error, now - pending.at, now, pending.capability);
    this.traces.record({ kind: "result", call: pending.call, status, output: error, at: now });
  }

  sessionCreated(id: SessionID, parentId: SessionID | null): void {
    if (this.sessions.has(id)) return;
    this.sessions.open(id, parentId, this.mode());
  }

  userMessage(id: SessionID, messageId: string, text: string): void {
    this.ensureSession(id);
    this.sessions.beginMessage(id, messageId);
    this.traces.record({ kind: "prompt", sessionId: id, text, at: Date.now() });
  }

  assistantModel(messageId: string, model: string): void {
    this.messageModel.set(messageId, model);
  }

  sessionTitle(id: SessionID, title: string): void {
    const titled = titleFromSession({ id, title });
    if (titled) this.usage.observeTitle(titled);
  }

  stepFinished(tokens: StepTokens): void {
    const step = stepUsage(tokens, this.messageModel.get(tokens.messageId) ?? null);
    if (!step) return;
    this.usage.observe(step);
    this.traces.record({ kind: "model", step, at: step.at });
  }

  idle(id: SessionID): void {
    this.traces.record({ kind: "turn_end", sessionId: id, at: Date.now() });
    this.audit.kick();
    this.usage.kick();
    this.traces.kick();
  }

  deleted(id: SessionID): void {
    this.tokens.revoke(id);
    this.sessions.close(id);
    this.audit.kick();
  }

  async close(): Promise<void> {
    this.policy.stop();
    this.credentials.stop();
    await Promise.allSettled([this.audit.stop(), this.usage.stop(), this.traces.stop(), this.tokens.stop(), this.sessions.flush()]);
  }

  private ensureSession(id: SessionID) {
    return this.sessions.has(id) ? this.sessions.get(id) : this.sessions.open(id, null, this.mode());
  }

  private record(
    call: ToolCall,
    status: AuditStatus,
    decision: Decision | null,
    output: string | null,
    error: string | null,
    durationMs: number,
    at: number,
    capability: Capability,
  ): void {
    if (!this.login()) return;
    try {
      this.audit.enqueue(
        toAuditRow({
          call,
          session: this.sessions.get(call.sessionId),
          root: this.sessions.root(call.sessionId),
          status,
          decision,
          output,
          error,
          durationMs,
          at,
          userId: this.login()?.userId,
          userEmail: this.login()?.email,
          capability,
        }),
      );
    } catch (e) {
      this.log.error("audit enqueue failed", { error: String(e) });
    }
  }
}

export function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}

let shared: Runtime | null = null;
let refs = 0;

export function acquireRuntime(log: Log, backend?: string): Runtime {
  shared ??= new Runtime(log, backend);
  refs += 1;
  return shared;
}

export async function releaseRuntime(): Promise<void> {
  refs -= 1;
  if (refs > 0 || !shared) return;
  const rt = shared;
  shared = null;
  await rt.close();
}
