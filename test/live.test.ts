import { describe, expect, test } from "bun:test";
import { createLiveTelemetryAdapter } from "../telemetry/live.ts";

describe("OpenCode live metadata adapter", () => {
  test("keeps model switches and deduplicates retried lifecycle events", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "turn.started", eventId: "t-start", sessionId: "s1", turnId: "t1", model: "provider/first", atMs: Date.UTC(2026, 9, 5) });
    const modelEvent = { kind: "model.completed", eventId: "m-first", sessionId: "s1", turnId: "t1", model: "provider/first", atMs: Date.UTC(2026, 9, 5), tokens: { input: 2, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 } };
    adapter.accept(modelEvent);
    adapter.accept(modelEvent);
    adapter.accept({ kind: "model.completed", eventId: "m-second", sessionId: "s1", turnId: "t2", model: "provider/second", atMs: Date.UTC(2026, 9, 5), tokens: { input: 4, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 } });
    const [record] = adapter.records();
    expect(record?.models.map((model) => model.model)).toEqual(["provider/first", "provider/second"]);
    expect(record?.models[0]?.tokens.total).toBe(5);
    expect(record?.coverage.turnsScanned).toBe(2);
  });

  test("counts tools once and normalizes missing tool metadata to unknown", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    const start = { kind: "tool.started", eventId: "tool-start", sessionId: "s1", turnId: "t1", callId: "c1", toolName: "read", atMs: Date.UTC(2026, 9, 5) };
    adapter.accept(start);
    adapter.accept(start);
    adapter.accept({ kind: "tool.completed", eventId: "tool-done", sessionId: "s1", turnId: "t1", callId: "c1", atMs: Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "tool.failed", eventId: "tool-unknown", sessionId: "s1", turnId: "t1", callId: "c2", atMs: Date.UTC(2026, 9, 5) });
    const [record] = adapter.records();
    expect(record?.tools).toEqual({ calls: 2, completed: 1, failed: 1, unknown: 0, byName: { read: 1, unknown: 1 } });
  });

  test("preserves missing token fields and marks unknown model coverage", () => {
    const adapter = createLiveTelemetryAdapter({ sessionBudget: 5, clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "model.completed", sessionId: "s1", turnId: "t1", atMs: Date.UTC(2026, 9, 5), tokens: { input: 2 } });
    const [record] = adapter.records();
    expect(record?.models[0]?.model).toBe("unknown/unknown");
    expect(record?.models[0]?.tokens.output).toBeNull();
    expect(record?.budgets.session).toMatchObject({ actual: null, status: "unknown" });
    expect(record?.coverage.unknownModels).toBe(1);
  });

  test("never retains prompts, arguments, results, or invalid event data", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "model.completed", sessionId: "s1", turnId: "t1", atMs: Date.UTC(2026, 9, 5), prompt: "private prompt", toolInput: { secret: true }, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
    adapter.accept({ kind: "not-supported", sessionId: "s1", turnId: "t2", prompt: "private" });
    const serialized = JSON.stringify(adapter.records());
    expect(serialized).not.toContain("private");
    expect(adapter.diagnosticsSnapshot().map((diagnostic) => diagnostic.code)).toContain("invalid_event");
  });

  test("uses receipt time with an explicit diagnostic when timestamps are missing", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "turn.started", sessionId: "s1", turnId: "t1" });
    expect(adapter.records()[0]?.usageDate).toBe("2026-10-05");
    expect(adapter.diagnosticsSnapshot().map((diagnostic) => diagnostic.code)).toContain("missing_timestamp");
    expect(adapter.records()[0]?.coverage.historyComplete).toBe(false);
  });

  test("deduplicates equivalent events without an event ID", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    const event = { kind: "model.completed", sessionId: "s1", turnId: "t1", model: "provider/model", atMs: Date.UTC(2026, 9, 5), tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 } };
    adapter.accept(event);
    adapter.accept({ ...event });
    expect(adapter.records()[0]?.models[0]?.tokens.total).toBe(3);
  });

  test("keeps terminal tool state when lifecycle events arrive out of order", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "tool.completed", eventId: "done", sessionId: "s1", turnId: "t1", callId: "c1", toolName: "read", atMs: Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "tool.started", eventId: "late-start", sessionId: "s1", turnId: "t1", callId: "c1", toolName: "read", atMs: Date.UTC(2026, 9, 5) });
    expect(adapter.records()[0]?.tools).toMatchObject({ calls: 1, completed: 1, failed: 0, unknown: 0 });
  });

  test("scopes event IDs to their session and turn", () => {
    const adapter = createLiveTelemetryAdapter({ clock: () => Date.UTC(2026, 9, 5) });
    for (const [sessionId, turnId] of [["s1", "t1"], ["s1", "t2"], ["s2", "t1"]]) {
      adapter.accept({ kind: "model.completed", eventId: "same-id", sessionId, turnId, model: "provider/model", atMs: Date.UTC(2026, 9, 5), tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
    }
    expect(adapter.records().map((record) => record.models[0]?.tokens.total)).toEqual([4, 2]);
  });

  test("keeps a model completion on its own UTC date when the turn started earlier", () => {
    const adapter = createLiveTelemetryAdapter();
    adapter.accept({ kind: "turn.started", sessionId: "s1", turnId: "t1", atMs: Date.UTC(2026, 9, 5, 23, 59) });
    adapter.accept({ kind: "model.completed", sessionId: "s1", turnId: "t1", model: "provider/model", atMs: Date.UTC(2026, 9, 6), tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
    expect(adapter.records().find((record) => record.usageDate === "2026-10-06")?.models[0]?.tokens.total).toBe(2);
  });

  test("handles invalid timestamps, private token fields, and bounded incomplete state", () => {
    const adapter = createLiveTelemetryAdapter({ maxEvents: 2, clock: () => Date.UTC(2026, 9, 5) });
    adapter.accept({ kind: "turn.started", sessionId: "s1", turnId: "t1", atMs: Number.MAX_SAFE_INTEGER });
    adapter.accept({ kind: "tool.started", sessionId: "s1", turnId: "t1", callId: "c1", toolName: "read", tokens: { input: 1, private: "secret" } });
    adapter.accept({ kind: "model.completed", sessionId: "s1", turnId: "t1", tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } });
    const serialized = JSON.stringify(adapter.records());
    expect(serialized).not.toContain("secret");
    expect(adapter.diagnosticsSnapshot().map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(["invalid_timestamp", "state_limit"]));
    expect(adapter.records()[0]?.coverage.warnings).toEqual(expect.arrayContaining(["incomplete_turn", "incomplete_tool"]));
    expect(serialized).not.toContain("duration");
  });
});
