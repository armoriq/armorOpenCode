import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTracePump, type TracePump } from "../../src/pumps/traces.ts";
import type { Log, SessionID, ToolCall, TurnEvent } from "../../src/types.ts";
import { startStubBackend, waitFor, type StubBackend } from "./stub-backend.ts";

const log: Log = process.env.DEBUG_TRACES ? { info: console.log, warn: console.log, error: console.log } : { info() {}, warn() {}, error() {} };
const sid = "ses_trace" as SessionID;

let stub: StubBackend;
const pumps: TracePump[] = [];

function pump() {
  const login = stub.login();
  const p = createTracePump({ login: () => login, log }, { intervalMs: 60_000 });
  pumps.push(p);
  p.start();
  return p;
}

const call = (callId: string, tool: string, args: Record<string, unknown>): ToolCall => ({ sessionId: sid, callId, tool, args });

function turn(p: TracePump, t0: number) {
  const read = call("call_1", "read", { filePath: "/work/a.ts" });
  const write = call("call_2", "write", { filePath: "/work/b.ts", content: "x" });
  const events: TurnEvent[] = [
    { kind: "prompt", sessionId: sid, text: "fix the bug", at: t0 },
    { kind: "decision", call: read, decision: { kind: "allow", stepIndex: 0, paramMismatch: false }, at: t0 + 10 },
    { kind: "result", call: read, status: "success", output: "file body", at: t0 + 20 },
    {
      kind: "decision",
      call: write,
      decision: { kind: "deny", code: "intent_drift", reason: "write not in plan", ruleId: null },
      at: t0 + 30,
    },
    { kind: "turn_end", sessionId: sid, at: t0 + 40 },
  ];
  for (const e of events) p.record(e);
  p.kick();
}

beforeEach(() => {
  stub = startStubBackend();
});

afterEach(async () => {
  await Promise.all(pumps.splice(0).map((p) => p.stop()));
  stub.stop();
});

describe("trace pump against a stub lease and OTLP receiver", () => {
  test("a turn with one allowed and one drift-blocked call exports a root span with decision and tool children", async () => {
    turn(pump(), Date.now());
    await waitFor(() => stub.spans.length >= 4, 10_000, "exported spans");
    await Bun.sleep(100);

    if (process.env.DEBUG_TRACES) console.log(JSON.stringify(stub.spans, null, 2));
    const root = stub.spans.find((s) => !s.parentSpanId)!;
    expect(root).toBeDefined();
    const children = stub.spans.filter((s) => s.parentSpanId === root.spanId);
    expect(stub.spans.every((s) => s.traceId === root.traceId)).toBe(true);

    expect(root.name).toBe("armoriq.agent.run");
    expect(root.attributes["armoriq.session_id"]).toBe(sid);
    // The SDK writes the "block" decision as "deny" on the wire, as it does for armorClaude.
    expect(children.map((s) => [s.name, s.attributes["armoriq.tool.name"], s.attributes["armoriq.policy.decision"] ?? null, s.attributes["armoriq.policy.reason_code"] ?? null])).toEqual([
      ["armoriq.policy.evaluate", "read", "allow", null],
      ["armoriq.tool", "read", null, null],
      ["armoriq.policy.evaluate", "write", "deny", "intent_drift"],
    ]);
    expect(children[1]!.attributes["armoriq.tool.outcome"]).toBe("success");
    expect(children[2]!.attributes["armoriq.intent_plan_item_status"]).toBe("blocked");
  });

  test("no span leaves the process when the lease turns capture off", async () => {
    stub.setLease({ captureMode: "off", revision: 2 });
    turn(pump(), Date.now());
    await waitFor(() => stub.calls.lease > 0, 10_000, "lease request");
    await Bun.sleep(1_000);
    expect(stub.calls.traces).toBe(0);
    expect(stub.spans).toEqual([]);
  });
});

describe("hot path cost", () => {
  test("record() p95 stays under 20 us", () => {
    const login = stub.login();
    const p = createTracePump({ login: () => login, log }, { intervalMs: 60_000 });
    pumps.push(p);
    const c = call("call_x", "bash", { command: "ls" });
    const samples: number[] = [];
    for (let i = 0; i < 4_000; i++) {
      const e: TurnEvent = { kind: "decision", call: c, decision: { kind: "allow", stepIndex: null, paramMismatch: false }, at: i };
      const t = Bun.nanoseconds();
      p.record(e);
      samples.push(Bun.nanoseconds() - t);
    }
    samples.sort((x, y) => x - y);
    const p95us = samples[Math.floor(samples.length * 0.95)]! / 1000;
    console.log(`record(): p50 ${(samples[samples.length >> 1]! / 1000).toFixed(2)} us, p95 ${p95us.toFixed(2)} us`);
    expect(p95us).toBeLessThan(20);
  });
});
