import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostFor } from "../../../src/host.ts";
import type { V2Event } from "../../../src/hosts/v2/context.ts";
import { toHostEvent } from "../../../src/hosts/v2/events.ts";
import { Runtime } from "../../../src/runtime.ts";
import type { Login, StepUsage } from "../../../src/types.ts";
import { allowAllPolicy, fakeRuntime } from "../../support/intent-harness.ts";

const EVENTS: V2Event[] = readFileSync(path.join(import.meta.dir, "fixtures", "v2-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_x", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };

// Per-session step sums the spike checked against `opencode stats --json --full` and client.session.get
// (spike/v2/FINDINGS-events-packaging.md, section 2). The core folds reasoning into output, as on V1.
const STATS = {
  ses_ec5471193ffeF1DjYk3kExJNmP: { input: 4519, output: 119, reasoning: 123, cacheRead: 17088, cacheWrite: 0, steps: 4 },
  ses_ec546d50fffeJ3CciwWWaIIARC: { input: 2214, output: 84, reasoning: 11, cacheRead: 6208, cacheWrite: 0, steps: 2 },
  ses_ec5328bbaffekXZmHKeKHgO5r1: { input: 4139, output: 33, reasoning: 90, cacheRead: 4312, cacheWrite: 0, steps: 2 },
};

async function observed() {
  const rt: any = await fakeRuntime(login, allowAllPolicy());
  Object.setPrototypeOf(rt, Runtime.prototype);
  const steps: StepUsage[] = [];
  const traced: unknown[] = [];
  Object.assign(rt, {
    pending: new Map(),
    messageModel: new Map(),
    usage: { observe: (s: StepUsage) => void steps.push(s), observeTitle() {}, kick() {} },
    traces: { record: (e: unknown) => void traced.push(e), kick() {} },
    audit: { kick() {} },
    tokens: { revoke() {} },
  });
  const host = hostFor(rt, rt.log);
  for (const event of EVENTS) {
    const e = toHostEvent(event, "/private/tmp/ocv2-spike/work");
    if (e) host.event(e);
  }
  return { steps, traced };
}

describe("V2 token usage from recorded step events", () => {
  test("per-session totals equal opencode stats, one record per ended step, retries not double counted", async () => {
    const { steps } = await observed();
    for (const [sessionId, want] of Object.entries(STATS)) {
      const mine = steps.filter((s) => s.sessionId === sessionId);
      const sum = (f: (s: StepUsage) => number) => mine.reduce((n, s) => n + f(s), 0);
      expect({
        input: sum((s) => s.entry.inputTokens),
        output: sum((s) => s.entry.outputTokens),
        reasoning: sum((s) => s.reasoningTokens),
        cacheRead: sum((s) => s.entry.cacheReadTokens),
        cacheWrite: sum((s) => s.entry.cacheWriteTokens),
        steps: mine.length,
      }).toEqual({ ...want, output: want.output + want.reasoning });
    }
    expect(new Set(steps.map((s) => `${s.messageId}:${s.partId}`)).size).toBe(steps.length);
  });

  test("each step is attributed to the provider/model that ran it, without the variant", async () => {
    const { steps } = await observed();
    expect(new Set(steps.map((s) => s.entry.model))).toEqual(new Set(["opencode/big-pickle"]));
    expect(steps.every((s) => s.repo === "/private/tmp/ocv2-spike/work")).toBe(true);
  });

  test("model steps reach the trace pump and each turn end closes a trace", async () => {
    const { traced } = await observed();
    const kinds = traced.map((e) => (e as { kind: string }).kind);
    expect(kinds.filter((k) => k === "model")).toHaveLength(8);
    expect(kinds.filter((k) => k === "turn_end")).toHaveLength(3);
  });

  test("a step without a model id or message id is skipped, not attributed to a guess", () => {
    expect(toHostEvent({ type: "session.step.started", data: { sessionID: "s", assistantMessageID: "m", model: {} } }, "/r")).toBeNull();
    expect(toHostEvent({ type: "session.step.ended", data: { sessionID: "s", tokens: { input: 1 } } }, "/r")).toBeNull();
    expect(toHostEvent({ type: "session.step.started", data: { sessionID: "s", assistantMessageID: "m", model: { id: "gpt-5", providerID: "openai", variant: "high" } } }, "/r")).toEqual({
      kind: "assistant_model",
      messageId: "m",
      model: "openai/gpt-5",
    });
  });
});
