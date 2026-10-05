#!/usr/bin/env bun
import { loadActivePolicy, savePendingPolicy, clearPendingPolicy } from "../src/local-policy.ts";
import { clearPlan, loadPlan, savePlan } from "../src/planner.ts";
import { validateIntentPlan } from "../src/intent-schema.ts";

type Json = Record<string, unknown>;
const serverName = "armor-opencode-policy";
const version = "0.0.1";
const dataDir = process.env.ARMOROPENCODE_DATA_DIR ?? `${process.env.HOME ?? "."}/.armoriq/armoropencode`;
const sessionId = process.env.ARMOROPENCODE_SESSION_ID ?? "default";

function result(text: string, structured?: Json): Json {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function tools(): Json[] {
  return [
    { name: "register_intent_plan", description: "Register the tools planned for this session before calling them.", inputSchema: { type: "object", properties: { goal: { type: "string" }, steps: { type: "array", items: { type: "object" } }, sessionId: { type: "string" } }, required: ["goal", "steps"] } },
    { name: "get_intent_plan", description: "Read the current intent plan for this session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } } } },
    { name: "reset_intent_plan", description: "Clear the current intent plan.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } } } },
    { name: "policy_read", description: "Read the active local ArmorOpenCode policy.", inputSchema: { type: "object", properties: {} } },
    { name: "policy_stage", description: "Stage a policy for terminal review. This never activates it.", inputSchema: { type: "object", properties: { policy: { type: "object" } }, required: ["policy"] } },
    { name: "policy_discard", description: "Discard a staged policy.", inputSchema: { type: "object", properties: {} } },
  ];
}

function dispatch(name: string, args: Json): Json {
  const sid = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId : sessionId;
  if (name === "register_intent_plan") {
    const checked = validateIntentPlan(args);
    if (!checked.ok) return result(`Plan rejected: ${checked.error}`);
    const saved = savePlan(dataDir, sid, checked.plan);
    return result(`Intent registered: ${saved.steps.length} steps.`, { sessionId: sid, steps: saved.steps.length, goal: saved.goal });
  }
  if (name === "get_intent_plan") {
    const plan = loadPlan(dataDir, sid);
    return result(plan ? JSON.stringify(plan, null, 2) : "No intent plan is registered.", { plan });
  }
  if (name === "reset_intent_plan") {
    clearPlan(dataDir, sid);
    return result("Intent plan cleared.", { sessionId: sid });
  }
  if (name === "policy_read") {
    const policy = loadActivePolicy(dataDir);
    return result(JSON.stringify(policy, null, 2), { policy });
  }
  if (name === "policy_stage") {
    const checked = savePendingPolicy(dataDir, args.policy);
    return checked.ok ? result("Policy staged for terminal confirmation. It is not active.", { staged: true }) : result(`Policy rejected: ${checked.error}`);
  }
  if (name === "policy_discard") {
    clearPendingPolicy(dataDir);
    return result("Staged policy discarded.");
  }
  return result(`Unknown tool: ${name}`);
}

function response(id: unknown, body: Json): string {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result: body });
  return outputMode === "content"
    ? `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
    : `${payload}\n`;
}

let buffer = Buffer.alloc(0);
let outputMode: "newline" | "content" = "newline";
function handle(raw: string): void {
  try {
    const message = JSON.parse(raw) as Json;
    if (message.method === "notifications/initialized") return;
    let body: Json;
    if (message.method === "initialize") body = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: serverName, version } };
    else if (message.method === "tools/list") body = { tools: tools() };
    else if (message.method === "tools/call") {
      const params = (message.params as Json | undefined) ?? {};
      body = dispatch(String(params.name ?? ""), ((params.arguments as Json | undefined) ?? {}));
    } else body = {};
    if (message.id !== undefined) process.stdout.write(response(message.id, body));
  } catch (error) {
    process.stderr.write(`ArmorOpenCode MCP error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function consume(): void {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      // Current MCP clients use newline-delimited JSON. Keep accepting the
      // older Content-Length framing as well because OpenCode versions in the
      // field have used both transports.
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
      if (!line.startsWith("{")) return;
      buffer = buffer.subarray(lineEnd + 1);
      outputMode = "newline";
      handle(line);
      continue;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const raw = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    outputMode = "content";
    handle(raw);
  }
}

process.stdin.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); consume(); });
