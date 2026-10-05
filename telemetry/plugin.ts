import type { Hooks } from "@opencode-ai/plugin";
import { liveEvents, sessionOf } from "./host-events.ts";
import { createLiveTelemetryAdapter, type LiveTelemetryAdapter } from "./live.ts";
import { LocalState, defaultStatePath, pendingRecords } from "./state.ts";
import { createHttpTelemetryTransport, type HttpTelemetryTransport } from "./http.ts";
import { evaluateToolCall } from "./policy.ts";
import { isArmorPolicyTool } from "../src/tool-name-map.ts";
import { createRemotePolicyClient, type RemotePolicyClient } from "./remote-policy.ts";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;


function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statePath(env: Record<string, string | undefined>): string {
  return env.ARMORIQ_OPENCODE_STATE ?? defaultStatePath(env);
}

function budget(env: Record<string, string | undefined>, key: string): number | undefined {
  const value = env[key];
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

const ArmorOpenCodeTelemetryPlugin = async () => {
  const env = process.env;
  const policyDataDir = env.ARMOROPENCODE_DATA_DIR ?? join(homedir(), ".armoriq", "armoropencode");
  const state = new LocalState(statePath(env));
  const adapters = new Map<string, LiveTelemetryAdapter>();
  const transport: HttpTelemetryTransport | null = env.ARMORIQ_OPENCODE_UPLOAD === "1" && env.ARMORIQ_API_KEY
    ? createHttpTelemetryTransport({ endpoint: env.ARMORIQ_TELEMETRY_URL, apiKey: env.ARMORIQ_API_KEY })
    : null;
  const remotePolicy: RemotePolicyClient | null = env.ARMOROPENCODE_REMOTE_POLICY_REQUIRED === "1"
    ? createRemotePolicyClient({ endpoint: env.ARMORIQ_BACKEND_URL, apiKey: env.ARMORIQ_API_KEY ?? "", token: env.ARMORIQ_INTENT_TOKEN ?? "" })
    : null;
  const adapterFor = (sessionId: string): LiveTelemetryAdapter => {
    const existing = adapters.get(sessionId);
    if (existing) return existing;
    const adapter = createLiveTelemetryAdapter({ sessionBudget: budget(env, "ARMORIQ_SESSION_BUDGET"), accountBudget: budget(env, "ARMORIQ_TOTAL_BUDGET") });
    adapters.set(sessionId, adapter);
    return adapter;
  };
  const flush = async (sessionId: string): Promise<void> => {
    const adapter = adapters.get(sessionId);
    if (!adapter) return;
    const records = pendingRecords(adapter.records());
    if (records.length === 0) return;
    state.reconcile(records);
    if (!transport) return;
    const pending = state.pending();
    const result = await transport.send(pending);
    if (result.ok) for (const item of pending.slice(0, result.accepted)) state.acknowledge(item);
  };
  return {
    event: async ({ event }: { event: unknown }) => {
      const raw = record(event);
      if (!raw) return;
      const properties = record(raw.properties);
      const sessionId = sessionOf(raw);
      if (!sessionId) return;
      const adapter = adapterFor(sessionId);
      for (const item of liveEvents(raw)) adapter.accept(item);
      if (text(raw.type) === "session.idle" || (text(raw.type) === "session.status" && text(record(properties?.status)?.type) === "idle")) await flush(sessionId);
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push("ArmorOpenCode requires an intent plan before tool calls. Call armor-opencode-policy_register_intent_plan with goal and steps first. Each step needs an action matching the tool name. Session routing is supplied by the plugin.");
    },
    "tool.execute.before": async (...[input, output]: Parameters<NonNullable<Hooks["tool.execute.before"]>>) => {
      const tool = input.tool;
      const session = input.sessionID;
      if (isArmorPolicyTool(tool)) {
        const args = record(output.args);
        if (!args) throw new Error("ArmorOpenCode management arguments must be an object.");
        args.sessionId = session;
      }
      const verdict = evaluateToolCall({ dataDir: policyDataDir, intentRequired: env.ARMOROPENCODE_INTENT_REQUIRED !== "false", planTtlSeconds: budget(env, "ARMOROPENCODE_PLAN_TTL_SECONDS") }, session, tool);
      if (!verdict.allowed) throw new Error(`ArmorOpenCode denied ${tool}: ${verdict.reason}`);
      if (remotePolicy && !isArmorPolicyTool(tool)) {
        const remote = await remotePolicy.enforce(tool, session);
        if (!remote.allowed) throw new Error(`ArmorOpenCode denied ${tool}: ${remote.reason}`);
      }
    },
  } satisfies Hooks;
};

export default ArmorOpenCodeTelemetryPlugin;
