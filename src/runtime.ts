import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { clientRowId, decisionCodeOf, fallbackAuditRow, snapshotAuditContext, toAuditRow, type AuditSnapshot } from "./core/audit.ts";
import type { BuiltinContext } from "./core/builtin-rules.ts";
import { capabilityOf, type Capability } from "./core/capability.ts";
import { decide } from "./core/decide.ts";
import { evaluateV2, type V2Outcome } from "./core/policy-v2.ts";
import { intentValiditySeconds } from "./core/plan-request.ts";
import { stepUsage, titleFromSession } from "./core/usage.ts";
import { resolveHold } from "./io/backend-approval.ts";
import { probeBackend } from "./io/backend-health.ts";
import { createCredentials, type Credentials } from "./io/credentials.ts";
import { CaptureError } from "./io/outbox.ts";
import { createAuditPump, type AuditPump } from "./pumps/audit.ts";
import { createHealthPump, type HealthPump } from "./pumps/health.ts";
import { createTokenPump, type TokenPump } from "./pumps/token.ts";
import { createRunsPump, runReportingEnabled, type RunsPump } from "./pumps/runs.ts";
import type { JournalCheckpoint } from "./io/outbox.ts";
import { createTracePump, type TracePump } from "./pumps/traces.ts";
import { createUsagePump, type UsagePump } from "./pumps/usage.ts";
import { createBackendPosture, type BackendPosture } from "./state/backend-posture.ts";
import { createPolicyBundle, REVALIDATE_MS, type PolicyBundle } from "./state/policy-bundle.ts";
import { createOrgMode, orgModeForced, type OrgModeSource } from "./state/org-mode.ts";
import { createPolicySource, type PolicySource } from "./state/policy-source.ts";
import { createSessionStore, type SessionStore } from "./state/sessions.ts";
import { OWN_TOOL_NAMES } from "./tools/intent.ts";
import type { AuditRow, AuditStatus, Decision, Log, Login, Mode, Pump, SessionID, StepTokens, ToolCall } from "./types.ts";

export const ARMORIQ_DIR = process.env.ARMORIQ_HOME ?? path.join(homedir(), ".armoriq");
export const DATA_DIR = path.join(ARMORIQ_DIR, "armoropencode");

export class GuardDenied extends Error {
  constructor(readonly decision: Exclude<Decision, { kind: "allow" }>, captureError?: unknown) {
    super(denialMessage(decision) + (captureError ? " Audit capture failed in local storage." : ""), captureError ? { cause: captureError } : undefined);
    this.name = "ArmorIQ";
  }
}

function denialMessage(d: Exclude<Decision, { kind: "allow" }>): string {
  if (d.kind === "hold" && d.requestId) {
    return (
      `ArmorIQ: ${d.reason}. Approval request ${d.requestId} is waiting for another workspace member. ` +
      "This call was not run; retry it with the same arguments after the request is approved."
    );
  }
  if (d.kind === "hold") return `ArmorIQ: approval required (${d.reason}). This call was not run.`;
  return `ArmorIQ blocked this call [${d.code}]: ${d.reason}`;
}

type Pending = { call: ToolCall; decision: Decision; at: number; capability: Capability; snapshot: AuditSnapshot; login: Login | null; runEnforcing: boolean };

// A rule's own block stands. Anything that would run or wait for approval needs the backend, and so does
// the fix for a missing plan or an expired token: registering or refreshing needs the backend.
const NEEDS_BACKEND: ReadonlySet<string> = new Set(["intent_plan_missing", "intent_token_expired"]);
const waitsOnBackend = (d: Decision) => d.kind !== "deny" || NEEDS_BACKEND.has(d.code);

// Rollback switch: ARMORIQ_POLICY_V2=0 turns workspace (v2) policies off and leaves the local policy alone.
const V2_ENABLED = process.env.ARMORIQ_POLICY_V2 !== "0";

const MONITOR_NOTE = { deny: "ArmorIQ would block this call in Enforce", hold: "ArmorIQ would ask for approval here in Enforce" };

export function monitorNote(d: Exclude<Decision, { kind: "allow" }>): string {
  const why = d.reason.split("\n")[0]!.slice(0, 200);
  return `${MONITOR_NOTE[d.kind]}${why ? ` (${why})` : ""}. Monitor let it run.`;
}

export type NoticeListener = (sessionId: SessionID, text: string) => void;

export const UNREACHABLE_HINT = "the ArmorIQ backend is unreachable, so only read calls run. Run `/armor status` to check it, then retry.";

export class Runtime {
  readonly sessions: SessionStore;
  readonly policy: PolicySource;
  readonly bundle: PolicyBundle;
  readonly audit: AuditPump;
  readonly health: HealthPump;
  readonly runs: RunsPump;
  readonly usage: UsagePump;
  readonly traces: TracePump;
  readonly tokens: TokenPump;
  readonly credentials: Credentials;
  readonly posture: BackendPosture;
  readonly org: OrgModeSource;
  private readonly noticeListeners = new Set<NoticeListener>();
  readonly shadowedTools = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly messageModel = new Map<string, string>();
  private readonly builtin: BuiltinContext;

  constructor(readonly log: Log, backend?: string) {
    intentValiditySeconds(process.env);
    this.credentials = createCredentials(log, { backend, onChange: revalidated => {
      this.sessions?.syncAuth();
      void this.audit?.loginChanged(revalidated).catch(() => log.error("audit login change failed"));
      void this.health?.loginChanged(revalidated).catch(() => log.error("health login change failed"));
      void this.runs?.loginChanged(revalidated).catch(() => log.error("run login change failed"));
    } });
    this.posture = createBackendPosture({
      probe: probeBackend,
      log,
      onUnauthorized: (reason) => this.credentials.markSignedOut(reason),
      onRecovered: async () => { await Promise.all([this.audit.retryNow(), this.health.kick(), this.runs.kick()]); },
      onAuthenticated: login => {
        this.credentials.authenticationSucceeded(login);
        void this.audit?.authenticationSucceeded(login);
        void this.health?.authenticationSucceeded(login);
        void this.runs?.authenticationSucceeded(login);
      },
    });
    const report = this.posture.report;
    this.policy = createPolicySource(path.join(DATA_DIR, "policy.json"), log);
    this.org = createOrgMode(path.join(DATA_DIR, "org-mode.json"), log);
    this.bundle = createPolicyBundle({ log, login: () => this.login(), enabled: V2_ENABLED });
    this.sessions = createSessionStore(path.join(DATA_DIR, "sessions"), () => this.mode(), () => this.login());
    const login = () => this.login();
    this.health = createHealthPump({ dataDir: DATA_DIR, login, probeLogin: () => this.credentials.forAuthenticationProbe(), log });
    this.audit = createAuditPump({ dataDir: DATA_DIR, login, probeLogin: () => this.credentials.forAuthenticationProbe(), authenticationSucceeded: login => this.credentials.authenticationSucceeded(login), log, report, health: this.health, relogin: (reason) => this.credentials.markRelogin(reason) });
    this.runs = createRunsPump({ dataDir: DATA_DIR, login, probeLogin: () => this.credentials.forAuthenticationProbe(), log, enabled: runReportingEnabled(process.env), checkpoints: () => this.audit.runCheckpoints(), retireCheckpoints: ids => this.audit.retireRunCheckpoints(ids), health: this.health });
    this.usage = createUsagePump({ dataDir: DATA_DIR, login, log });
    this.traces = createTracePump({ login, log });
    this.tokens = createTokenPump({ sessions: this.sessions, login, log, report, health: this.health });
    this.builtin = { armoriqDir: ARMORIQ_DIR, ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: this.shadowedTools };
    for (const pump of [this.health, this.audit, this.runs, this.usage, this.traces, this.tokens]) pump.start();
  }

  login(): Login | null {
    return this.credentials.current();
  }

  // Signed in, the workspace picks the mode on the Tools Monitor page; signed out is always monitor.
  mode(): Mode {
    if (!this.login()) return "monitor";
    return orgModeForced() || this.org.current().mode === "enforce" ? "enforce" : "monitor";
  }

  // Show in chat: the host shows the user what Enforce would have done. Returns the unsubscribe.
  onNotice(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  async before(call: ToolCall): Promise<void> {
    if (!call.callId) call.callId = randomUUID();
    let now = Date.now();
    const session = this.ensureSession(call.sessionId);
    const runEnforcing = session.mode === "enforce";
    const checkpoint = session.parentId === null ? this.runs?.attempt(session.promptId, call.attemptId ?? call.callId, call.tool,
      runEnforcing,
      { trusted: !this.shadowedTools.has(call.tool), persist: false }) : undefined;
    this.sessions.noteActivity(call.sessionId, now);
    const capability = capabilityOf(call.tool, this.builtin.ownTools);
    const login = this.login();
    // Workspace Monitor: every check runs and nothing is stopped, so no outage check and no approval request.
    const orgMonitor = login !== null && session.mode === "monitor";
    if (login && V2_ENABLED) await this.refreshBundle(login);
    let decision: Decision;
    try {
      const input = () => ({
        v2: login && V2_ENABLED ? this.v2Outcome(login, call, now) : null,
        policy: this.policy.current(),
        session,
        root: this.sessions.root(call.sessionId),
        call,
        now,
        builtin: this.builtin,
      });
      decision = decide(input());
      if (decision.kind === "deny" && decision.code === "intent_token_expired") {
        try {
          await this.tokens.refreshExpired(this.sessions.root(call.sessionId).id);
        } catch (error) {
          this.log.warn("intent token refresh failed", { tool: call.tool, errorName: error instanceof Error ? error.name : "unknown" });
        }
        now = Date.now();
        decision = decide(input());
      }
    } catch (error) {
      this.log.error("decide failed", { tool: call.tool, errorName: error instanceof Error ? error.name : "unknown" });
      decision = { kind: "deny", code: "internal_error", reason: "guard error", ruleId: null };
    }
    // Copy the evaluated context before the posture check can yield to a later prompt or login.
    let snapshot = snapshotAuditContext(session, this.sessions.root(call.sessionId), decision);
    const planSteps = this.sessions.root(call.sessionId).plan?.steps;
    if (login && !orgMonitor && waitsOnBackend(decision)) {
      if (capability === "read") this.posture.warm(login);
      else if ((await this.posture.check(login)) === "unreachable") {
        decision = { kind: "deny", code: "backend_unreachable", reason: UNREACHABLE_HINT, ruleId: null };
      }
    }
    if (login && !orgMonitor && decision.kind === "hold" && decision.approvable) decision = await this.resolveV2Hold(login, call, decision);
    // An approved hold becomes an allow after the snapshot, so its matched step comes from the plan copied with it.
    if (decision.kind === "allow" && decision.stepIndex !== null && snapshot.step === null) {
      const step = planSteps?.[decision.stepIndex];
      if (step) snapshot = { ...snapshot, step: { index: decision.stepIndex, action: step.action } };
    }
    this.traces.record({ kind: "decision", call, decision, at: now });

    if (orgMonitor && decision.kind !== "allow" && this.org.current().notices) this.notice(call.sessionId, monitorNote(decision));
    const outage = decision.kind === "deny" && decision.code === "backend_unreachable";
    if (decision.kind === "allow" || (session.mode === "monitor" && !outage)) {
      this.runs?.commit(checkpoint);
      if (decision.kind === "allow" && decision.stepIndex !== null) this.sessions.advance(call.sessionId, decision.stepIndex);
      this.pending.set(call.callId, { call, decision, at: now, capability, snapshot, login, runEnforcing });
      deepFreeze(call.args);
      return;
    }
    try {
      let captured = false;
      this.runs?.commit(checkpoint, login ? value => {
        this.record(call, decision.kind === "hold" ? "held" : "blocked", decision, null, null, 0, now, capability, snapshot, login, value);
        captured = true;
      } : undefined, outage);
      if (!captured) this.record(call, decision.kind === "hold" ? "held" : "blocked", decision, null, null, 0, now, capability, snapshot, login);
    } catch (captureError) {
      throw new GuardDenied(decision, captureError);
    }
    throw new GuardDenied(decision);
  }

  // OpenCode has no approval prompt: a member approves the request in ArmorIQ and the model retries the call.
  // Anything short of the backend's allow keeps the call stopped, as a hold so the plan stays usable.
  private async resolveV2Hold(login: Login, call: ToolCall, hold: Extract<Decision, { kind: "hold" }>): Promise<Decision> {
    const { approvable, ...held } = hold;
    const root = this.sessions.root(call.sessionId);
    const token = root.token;
    if (!root.plan || token?.status !== "active") {
      return { ...held, reason: `${hold.reason}, but this session has no intent plan to file the approval under. Call register_intent_plan, then retry` };
    }
    const outcome = await resolveHold(login, { tool: call.tool, args: call.args, planId: root.plan.id, jwt: token.jwt });
    switch (outcome.action) {
      case "allow":
        return { kind: "allow", stepIndex: approvable!.stepIndex, paramMismatch: approvable!.paramMismatch, ...(hold.policy ? { policy: hold.policy } : {}) };
      case "block":
        return { kind: "deny", code: "policy_v2_block", reason: outcome.reason, ruleId: hold.ruleId, ...(hold.policy ? { policy: hold.policy } : {}) };
      default:
        if ("requestId" in outcome) return { ...held, requestId: outcome.requestId };
        this.log.warn("policy v2 hold could not be filed for approval", { tool: call.tool, error: outcome.error });
        return { ...held, reason: `${hold.reason}; the approval request could not be filed (${outcome.error}). Retry later` };
    }
  }

  // Only the first call waits for the bundle; afterwards the cached one is used while it revalidates.
  private async refreshBundle(login: Login): Promise<void> {
    if (this.bundle.state(login).status === "unavailable") await this.bundle.refresh(login, REVALIDATE_MS);
    else void this.bundle.refresh(login, REVALIDATE_MS);
  }

  private v2Outcome(login: Login, call: ToolCall, now: number): V2Outcome | null {
    const state = this.bundle.state(login);
    if (state.status === "unavailable" || !state.agent) return null;
    return evaluateV2(state.agent, { tool: call.tool, arguments: { ...call.args }, userEmail: login.email || undefined }, now);
  }

  after(callId: string, output: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    const now = Date.now();
    if (this.sessions.has(pending.call.sessionId)) this.sessions.noteActivity(pending.call.sessionId, now, true);
    this.recordResult(pending, "success", output, null, now);
    this.traces.record({ kind: "result", call: pending.call, status: "success", output, at: now });
  }

  failed(callId: string, status: "failed" | "error", error: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    const now = Date.now();
    if (this.sessions.has(pending.call.sessionId)) this.sessions.noteActivity(pending.call.sessionId, now, true);
    this.recordResult(pending, status, null, error, now);
    this.traces.record({ kind: "result", call: pending.call, status, output: error, at: now });
  }

  sessionCreated(id: SessionID, parentId: SessionID | null): void {
    // An open session may learn its parent late, and the store then retires the plan it held as a root.
    if (this.sessions.has(id)) this.sessions.open(id, parentId, this.mode());
    else this.openSession(id, parentId);
  }

  userMessage(id: SessionID, messageId: string, text: string): void {
    const session = this.ensureSession(id);
    const persistRun = ({ previousRunId, runId, startedAt }: { previousRunId: string | null; runId: string; startedAt: number }) => {
      this.runs?.end(previousRunId, "next_prompt", startedAt);
      this.runs?.begin(runId, id, startedAt, session.mode === "enforce");
    };
    const first = session.parentId === null ? this.sessions.beginMessage(id, messageId, persistRun) : this.sessions.noteMessage(id, messageId);
    if (!first) return;
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
    if (this.sessions.has(tokens.sessionId)) this.sessions.noteActivity(tokens.sessionId);
    const step = stepUsage(tokens, this.messageModel.get(tokens.messageId) ?? null);
    if (!step) return;
    this.usage.observe(step);
    this.traces.record({ kind: "model", step, at: step.at });
  }

  idle(id: SessionID): void {
    const session = this.sessions.has(id) ? this.sessions.get(id) : null;
    if (session?.parentId === null) this.runs?.end(session.promptId, "stop", Date.now());
    this.sessions.endPrompt(id);
    this.traces.record({ kind: "turn_end", sessionId: id, at: Date.now() });
    this.audit.kick();
    this.usage.kick();
    this.traces.kick();
    void this.runs?.kick();
  }

  deleted(id: SessionID): void {
    const session = this.sessions.has(id) ? this.sessions.get(id) : null;
    if (session?.parentId === null) this.runs?.end(session.promptId, "session_end", Date.now());
    this.tokens.revoke(id);
    this.sessions.close(id);
    this.audit.kick();
    void this.runs?.kick();
  }

  async close(): Promise<void> {
    this.policy.stop();
    this.bundle.stop();
    this.credentials.stop();
    await Promise.allSettled([this.audit.stop(), this.runs.stop(), this.usage.stop(), this.traces.stop(), this.tokens.stop(), this.sessions.flush()]);
    await this.health.stop();
  }

  private ensureSession(id: SessionID) {
    return this.sessions.has(id) ? this.sessions.get(id) : this.openSession(id, null);
  }

  // Each new session asks for the workspace mode; calls follow the answer once it lands.
  private openSession(id: SessionID, parentId: SessionID | null) {
    const login = this.login();
    if (login) this.org.refresh(login);
    return this.sessions.open(id, parentId, this.mode());
  }

  private notice(sessionId: SessionID, text: string): void {
    for (const listener of this.noticeListeners) {
      try {
        listener(sessionId, text);
      } catch (error) {
        this.log.warn("notice failed", { error: String(error) });
      }
    }
  }

  private recordResult(pending: Pending, status: AuditStatus, output: string | null, error: string | null, at: number): void {
    const { call, snapshot } = pending;
    const checkpoint = snapshot.sessionId === snapshot.rootSessionId && this.builtin.ownTools.has(call.tool) && this.shadowedTools.has(call.tool)
      ? this.runs?.attempt(snapshot.promptId ?? null, call.attemptId ?? call.callId, call.tool, pending.runEnforcing, { trusted: false, persist: false }) : undefined;
    const record = (value?: JournalCheckpoint) => this.record(call, status, pending.decision, output, error, at - pending.at, at, pending.capability, snapshot, pending.login, value);
    let captured = false;
    this.runs?.commit(checkpoint, value => { record(value); captured = true; });
    if (!captured) record();
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
    snapshot: AuditSnapshot,
    login: Login | null,
    checkpoint?: JournalCheckpoint,
  ): void {
    if (!login) { if (snapshot.enforcing) this.audit.captureFailure(); return; }
    const stopped = status === "blocked" || status === "held";
    const minimal = (): AuditRow => ({
      ...fallbackAuditRow(clientRowId(snapshot.rootSessionId, call.callId, stopped ? "decision" : "result"), snapshot.rootSessionId, at - durationMs, decision?.kind === "hold" ? "approval_required" : decision?.kind === "deny" ? decisionCodeOf(decision.code) : "internal_error"),
      tool: call.tool, action: snapshot.step?.action ?? call.tool, status,
      session_id: snapshot.rootSessionId,
      step_index: stopped ? -1 : snapshot.step?.index ?? -1,
      ...(snapshot.planId ? { plan_id: snapshot.planId } : {}),
      ...(snapshot.contextPlanId ? { context_plan_id: snapshot.contextPlanId } : {}),
      ...(snapshot.promptId ? { prompt_id: snapshot.promptId } : {}),
      ...(!stopped ? { decision_code: undefined } : {}),
    });
    let row;
    try {
      row = decision?.kind === "deny" && decision.code === "internal_error"
        ? minimal()
        : toAuditRow({
          call,
          status,
          decision,
          output,
          error,
          durationMs,
          at,
          userId: login.userId,
          userEmail: login.email,
          capability,
          snapshot,
        });
    } catch {
      row = minimal();
    }
    try {
      this.audit.enqueue(row as AuditRow, login, checkpoint);
    } catch (error) {
      this.log.error("audit enqueue failed");
      if (!(error instanceof CaptureError)) {
        try { this.audit.captureFailure(); } catch { this.log.error("audit capture failure count could not be saved"); }
      }
      if (stopped) throw error;
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
