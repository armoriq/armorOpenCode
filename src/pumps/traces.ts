import type { ArmorIQTelemetryRuntime, OtelSession, PolicyResult, TelemetryRuntimeOptions } from "@armoriq/sdk";
import { redactText, sanitizeParams } from "../core/sanitize.ts";
import { callKey } from "../core/usage.ts";
import { CLIENT } from "../io/credentials.ts";
import type { Decision, Log, Login, Pump, TurnEvent } from "../types.ts";

export type TracePump = Pump & { record(event: TurnEvent): void };

export type TracePumpOptions = {
  intervalMs?: number;
  runtimeOptions?: Partial<TelemetryRuntimeOptions>;
};

const INTERVAL_MS = 2_000;
const MAX_BUFFERED = 5_000;
const STOP_DEADLINE_MS = 150;
const SERVICE_NAME = "armoropencode";

type Sdk = typeof import("@armoriq/sdk");
type Turn = { session: OtelSession; lastAt: number };

const loginKey = (l: Login) => JSON.stringify([l.backend, l.apiKey]);

// Sanitizers come from core/sanitize.ts; if they fail, content is withheld rather than exported raw.
function safeArgs(value: unknown): Record<string, unknown> {
  try {
    return sanitizeParams(value);
  } catch {
    return {};
  }
}

function safeText(text: string): string {
  try {
    return redactText(text);
  } catch {
    return "";
  }
}

function policyResult(decision: Decision): PolicyResult {
  if (decision.kind === "deny") return { decision: "block", policyReasonCode: decision.code, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
  if (decision.kind === "hold") return { decision: "hold", policyReasonCode: "require_approval", ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
  return { decision: "allow", ...(decision.paramMismatch ? { policyReasonCode: "intent_param_mismatch" } : {}) };
}

// One ArmorIQTelemetryRuntime per process; root span per turn; DenyCode on decision spans.
export function createTracePump(deps: { login: () => Login | null; log: Log }, options: TracePumpOptions = {}): TracePump {
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  let buffer: TurnEvent[] = [];
  let dropped = 0;
  const turns = new Map<string, Turn>();
  let sdk: Sdk | null = null;
  let runtime: { key: string; value: ArmorIQTelemetryRuntime } | null = null;
  let pausedFor: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let flushWanted = false;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runtimeFor(login: Login): Promise<ArmorIQTelemetryRuntime> {
    const key = loginKey(login);
    if (runtime?.key === key) return runtime.value;
    if (runtime) await closeAll(runtime.value);
    sdk ??= await import("@armoriq/sdk");
    const value = new sdk.ArmorIQTelemetryRuntime({
      backendEndpoint: login.backend,
      apiKey: login.apiKey,
      client: CLIENT,
      sdkVersion: typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown",
      options: { serviceName: SERVICE_NAME },
      onReloginRequired: () => {
        if (pausedFor !== key) deps.log.warn("traces: relogin required, paused until the login changes");
        pausedFor = key;
      },
      ...options.runtimeOptions,
    });
    runtime = { key, value };
    return value;
  }

  async function closeAll(rt: ArmorIQTelemetryRuntime): Promise<void> {
    const open = [...turns.values()];
    turns.clear();
    await Promise.allSettled(open.map((t) => t.session.close({ status: "ok", taskOutcome: "unknown", endTime: new Date(t.lastAt) })));
    await rt.close().catch(() => {});
    runtime = null;
  }

  async function openTurn(rt: ArmorIQTelemetryRuntime, login: Login, sessionId: string, at: number, input?: string): Promise<Turn> {
    const session = new sdk!.OtelSession(rt, { sessionId, userId: login.userId || null });
    await session.refreshPolicy();
    await session.beginRoot(input === undefined ? {} : { input });
    const turn = { session, lastAt: at };
    turns.set(sessionId, turn);
    return turn;
  }

  async function endTurn(sessionId: string, at: number): Promise<void> {
    const turn = turns.get(sessionId);
    if (!turn) return;
    turns.delete(sessionId);
    await turn.session.close({ status: "ok", endTime: new Date(Math.max(at, turn.lastAt)) });
  }

  async function apply(rt: ArmorIQTelemetryRuntime, login: Login, e: TurnEvent): Promise<void> {
    switch (e.kind) {
      case "prompt":
        await endTurn(e.sessionId, e.at);
        await openTurn(rt, login, e.sessionId, e.at, safeText(e.text));
        return;
      case "decision": {
        const turn = turns.get(e.call.sessionId) ?? (await openTurn(rt, login, e.call.sessionId, e.at));
        turn.lastAt = Math.max(turn.lastAt, e.at);
        await turn.session.recordPolicy(
          { toolName: e.call.tool, toolCallId: e.call.callId, arguments: safeArgs(e.call.args) },
          policyResult(e.decision),
          { endTime: new Date(e.at) },
        );
        return;
      }
      case "result": {
        const turn = turns.get(e.call.sessionId) ?? (await openTurn(rt, login, e.call.sessionId, e.at));
        turn.lastAt = Math.max(turn.lastAt, e.at);
        await turn.session.recordTool(
          { toolName: e.call.tool, toolCallId: e.call.callId, arguments: safeArgs(e.call.args), operation: { category: "tool" } },
          { outcome: e.status === "success" ? "success" : "error", result: safeArgs({ output: e.output }) },
          { endTime: new Date(e.at) },
        );
        return;
      }
      case "model": {
        const turn = turns.get(e.step.sessionId) ?? (await openTurn(rt, login, e.step.sessionId, e.at));
        turn.lastAt = Math.max(turn.lastAt, e.at);
        await sdk!.recordUsageCallSpans([{ key: callKey(e.step), timestampMs: e.step.at, ...e.step.entry }], turn.session);
        return;
      }
      case "turn_end":
        flushWanted = true;
        await endTurn(e.sessionId, e.at);
        return;
    }
  }

  async function pass(): Promise<void> {
    const login = deps.login();
    if (!login || pausedFor === loginKey(login)) {
      buffer = [];
      return;
    }
    pausedFor = null;
    if (!buffer.length && !flushWanted) return;
    const rt = await runtimeFor(login);
    const events = buffer;
    buffer = [];
    if (dropped) {
      deps.log.warn("traces: buffer full, events dropped", { dropped });
      dropped = 0;
    }
    for (const e of events) {
      try {
        await apply(rt, login, e);
      } catch (err) {
        deps.log.warn("traces: event not recorded", { kind: e.kind, error: String(err) });
      }
    }
    if (flushWanted) {
      flushWanted = false;
      await rt.forceFlush().catch(() => {});
    }
  }

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (err) {
          deps.log.warn("traces: pass failed", { error: String(err) });
        }
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    start() {
      if (started) return;
      started = true;
      timer = setInterval(() => void run(), intervalMs);
      timer.unref?.();
    },
    kick() {
      if (started) void run();
    },
    record(event) {
      if (stopped) return;
      if (buffer.length >= MAX_BUFFERED) dropped += 1;
      else buffer.push(event);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const rt = runtime?.value;
      if (!rt) return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          await running?.catch(() => {});
          await pass().catch(() => {});
          await closeAll(rt);
        })(),
        new Promise<void>((resolve) => (deadline = setTimeout(resolve, STOP_DEADLINE_MS))),
      ]);
      clearTimeout(deadline);
    },
  };
}
