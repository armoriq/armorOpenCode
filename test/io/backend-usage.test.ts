import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acknowledge,
  acknowledgedIn,
  allocateRevision,
  enqueueBatches,
  mergeSteps,
  queuedBatches,
  readSession,
  noteTitle,
  refuse,
  sentCallsIn,
  sentTitleIn,
  setAside,
  setGeneration,
  storedGeneration,
  storedSessionIds,
  updateSession,
  type UsageBatch,
} from "../../src/io/backend-usage.ts";
import type { UsageSnapshot } from "../../src/core/usage.ts";
import type { SessionID, StepUsage } from "../../src/types.ts";
import { scratch } from "./helpers/stub.ts";

const step = (partId: string, sessionId = "ses_1"): StepUsage => ({
  sessionId: sessionId as SessionID,
  messageId: "msg_1",
  partId,
  at: 0,
  repo: "/repo",
  entry: { model: "m", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  reasoningTokens: 0,
});
const snapshot = (hour: number, inputTokens = 1): UsageSnapshot => ({
  sessionId: "ses_1",
  usageDate: "2026-10-12",
  usageHour: hour,
  revision: 1,
  armored: true,
  entries: [{ model: "m", inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }],
});
// Queue file names embed the batch id, which is a UUID; the label rides in the generation field.
const batch = (label: string): UsageBatch => ({ generation: label, batchId: randomUUID(), snapshots: [snapshot(1)], calls: [], sessions: [] });
const batchIds = async (dir: string) => (await queuedBatches(dir)).map((q) => q.batch.generation);

describe("usage store", () => {
  test("revisions increase across calls and the generation is kept beside them", async () => {
    const dir = scratch();
    expect(await storedGeneration(dir)).toBeNull();
    expect([await allocateRevision(dir), await allocateRevision(dir)]).toEqual([1, 2]);
    await setGeneration(dir, "g1");
    expect(await allocateRevision(dir)).toBe(3);
    expect(await storedGeneration(dir)).toBe("g1");
  });

  test("concurrent revision allocations never hand out the same number", async () => {
    const dir = scratch();
    const revisions = await Promise.all(Array.from({ length: 10 }, () => allocateRevision(dir)));
    expect(revisions.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a garbled stream.lock left long ago is reclaimed instead of failing every allocation", async () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "stream.lock");
    writeFileSync(lock, "garbage");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const started = Date.now();
    expect(await allocateRevision(dir)).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("session steps merge by part id and acknowledgements are kept per generation", async () => {
    const dir = scratch();
    await updateSession(dir, "ses_1", async (s) => [mergeSteps(s, [step("a"), step("b")]), null]);
    await updateSession(dir, "ses_1", async (s) => [mergeSteps(s, [step("b"), step("c")]), null]);
    const state = await readSession(dir, "ses_1");
    expect(state.steps.map((s) => s.partId)).toEqual(["a", "b", "c"]);

    const acked = acknowledge(state, "g1", { snapshots: [snapshot(1)], callKeys: ["msg_1:a"] });
    expect(Object.keys(acknowledgedIn(acked, "g1"))).toEqual(["2026-10-12T01"]);
    expect(acknowledgedIn(acked, "g2")).toEqual({});
    expect(Object.keys(refuse(state, { snapshots: [snapshot(2)], callKeys: [] }).refused ?? {})).toEqual(["2026-10-12T02"]);
    expect(await storedSessionIds(dir, 60_000)).toEqual(["ses_1"]);
  });

  test("sent call keys are kept per generation and refused call keys are kept across them", () => {
    const state = { steps: [step("a")] };
    const acked = acknowledge(acknowledge(state, "g1", { snapshots: [], callKeys: ["msg_1:a"] }), "g1", { snapshots: [], callKeys: ["msg_1:b", "msg_1:a"] });
    expect(sentCallsIn(acked, "g1")).toEqual(["msg_1:a", "msg_1:b"]);
    expect(sentCallsIn(acknowledge(acked, "g2", { snapshots: [], callKeys: ["msg_1:c"] }), "g2")).toEqual(["msg_1:c"]);
    expect(refuse(refuse(state, { snapshots: [], callKeys: ["msg_1:a"] }), { snapshots: [], callKeys: ["msg_1:a", "msg_1:b"] }).refusedCalls).toEqual(["msg_1:a", "msg_1:b"]);
  });

  test("queued batches come back in enqueue order, and a set-aside batch leaves the queue", async () => {
    const dir = scratch();
    await enqueueBatches(dir, [batch("b1"), batch("b2"), batch("b3")]);
    expect(await batchIds(dir)).toEqual(["b1", "b2", "b3"]);
    const [first] = await queuedBatches(dir);
    await setAside(dir, first!, "refused");
    expect(await batchIds(dir)).toEqual(["b2", "b3"]);
    expect(readdirSync(join(dir, "queue", "refused"))).toHaveLength(1);
  });

  test("a queued batch that cannot be read right now is kept; one that does not parse is dropped", async () => {
    const dir = scratch();
    await enqueueBatches(dir, [batch("b1"), batch("b2")]);
    const [unreadable, corrupt] = (await queuedBatches(dir)).map((q) => q.file);
    chmodSync(unreadable!, 0o000);
    writeFileSync(corrupt!, "{not json");
    expect(await batchIds(dir)).toEqual([]);
    expect([existsSync(unreadable!), existsSync(corrupt!)]).toEqual([true, false]);
    chmodSync(unreadable!, 0o600);
    expect(await batchIds(dir)).toEqual(["b1"]);
  });

  test("a session keeps the time its title was first seen, and the sent title is kept per generation", () => {
    const named = (title: string, at: string) => ({ sessionId: "ses_1", title, titleSource: "opencode-session-title" as const, titleUpdatedAt: at });
    const first = noteTitle({ steps: [] }, named("Fix it", "2026-10-12T10:00:00.000Z"));
    expect(noteTitle(first, named("Fix it", "2026-10-12T10:05:00.000Z")).title).toEqual(named("Fix it", "2026-10-12T10:00:00.000Z"));
    expect(noteTitle(first, named("Fix it now", "2026-10-12T10:05:00.000Z")).title!.title).toBe("Fix it now");
    const acked = acknowledge(first, "g1", { snapshots: [], callKeys: [], title: "Fix it" });
    expect([sentTitleIn(acked, "g1"), sentTitleIn(acked, "g2")]).toEqual(["Fix it", undefined]);
    expect(sentTitleIn(acknowledge(acked, "g1", { snapshots: [], callKeys: ["k"] }), "g1")).toBe("Fix it");
    expect(refuse(first, { snapshots: [], callKeys: [], title: "Fix it" }).refusedTitle).toBe("Fix it");
  });

  test("a rename always carries a later time than the title it replaces, so the backend takes it", () => {
    const named = (title: string, at: string) => ({ sessionId: "ses_1", title, titleSource: "opencode-session-title" as const, titleUpdatedAt: at });
    const b = noteTitle({ steps: [] }, named("B", "2026-10-12T10:00:00.000Z"));
    expect(noteTitle(b, named("C", "2026-10-12T10:00:00.000Z")).title!.titleUpdatedAt).toBe("2026-10-12T10:00:00.001Z");
    expect(noteTitle(b, named("C", "2026-10-12T09:59:00.000Z")).title!.titleUpdatedAt).toBe("2026-10-12T10:00:00.001Z");
    expect(noteTitle(b, named("C", "2026-10-12T10:00:05.000Z")).title!.titleUpdatedAt).toBe("2026-10-12T10:00:05.000Z");
  });

  test("a queued batch without a calls list is dropped, so the next capture rebuilds it", async () => {
    const dir = scratch();
    await enqueueBatches(dir, [batch("b1")]);
    const [queued] = await queuedBatches(dir);
    const { calls: _calls, ...old } = queued!.batch;
    writeFileSync(queued!.file, JSON.stringify({ batch: old }));
    expect(await batchIds(dir)).toEqual([]);
    expect(existsSync(queued!.file)).toBe(false);
  });
});
