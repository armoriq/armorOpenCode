import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stepUsageFromPart } from "../../src/core/usage.ts";
import { scopeDir } from "../../src/io/backend-usage.ts";
import { createUsagePump, type UsagePump } from "../../src/pumps/usage.ts";
import type { Log, Login, StepUsage } from "../../src/types.ts";
import { startStubBackend, waitFor, type StubBackend } from "./stub-backend.ts";

const log: Log = process.env.DEBUG_USAGE ? { info: console.log, warn: console.log, error: console.log } : { info() {}, warn() {}, error() {} };
const SONNET = "anthropic/claude-sonnet-5";
const GPT = "openai/gpt-5";

function step(id: string, model: string, iso: string, tokens: Record<string, unknown>, sessionID = "ses_a"): StepUsage {
  const part = { id, sessionID, messageID: `msg_${model}`, type: "step-finish", tokens };
  return stepUsageFromPart(part, (m) => m.slice(4), "/work/repo", Date.parse(iso))!;
}

const threeSteps = () => [
  step("prt_1", SONNET, "2026-10-11T10:59:58Z", { input: 100, output: 10, reasoning: 2, cache: { read: 1000, write: 50 } }),
  step("prt_2", GPT, "2026-10-11T11:00:01Z", { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }),
  step("prt_3", SONNET, "2026-10-11T11:15:00Z", { input: 300, output: 30, reasoning: 5, cache: { read: 2000, write: 0 } }),
];

const entry = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => ({
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

let stub: StubBackend;
let dataDir: string;
const pumps: UsagePump[] = [];

function pump(login: Login = stub.login()) {
  const p = createUsagePump({ dataDir, login: () => login, log }, { intervalMs: 60_000, persistDelayMs: 1 });
  pumps.push(p);
  p.start();
  return p;
}

const queueFiles = async (login: Login) =>
  (await readdir(path.join(scopeDir(dataDir, login), "queue")).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));

beforeEach(async () => {
  stub = startStubBackend();
  dataDir = await mkdtemp(path.join(tmpdir(), "aoc-usage-"));
});

afterEach(async () => {
  await Promise.all(pumps.splice(0).map((p) => p.stop()));
  stub.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("usage pump against a stub backend", () => {
  test("three steps across two models and an hour boundary become the exact session-hour snapshots", async () => {
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.stored().size === 2, 10_000, "two stored hours");

    expect(Object.fromEntries(stub.stored())).toEqual({
      "ses_a|2026-10-11|10": [entry(SONNET, 100, 12, 1000, 50)],
      "ses_a|2026-10-11|11": [entry(SONNET, 300, 35, 2000, 0), entry(GPT, 200, 20, 0, 0)],
    });
    expect(stub.calls.initialize).toBe(1);
    expect(stub.calls.conflicts).toEqual([]);
    await waitFor(async () => (await queueFiles(stub.login())).length === 0, 5_000, "queue settled");
  });

  test("a restart resends nothing and a replayed step-finish is not counted twice", async () => {
    const first = pump();
    for (const s of threeSteps()) first.observe(s);
    first.kick();
    await waitFor(() => stub.stored().size === 2);
    await first.stop();
    const before = { batches: stub.calls.batches, totals: stub.totals() };

    const second = pump();
    second.observe(threeSteps()[2]!);
    second.kick();
    await Bun.sleep(300);
    expect(stub.calls.batches).toBe(before.batches);
    expect(stub.totals()).toEqual(before.totals);

    second.observe(step("prt_4", GPT, "2026-10-11T11:20:00Z", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }));
    second.kick();
    await waitFor(() => stub.totals()[GPT]?.inputTokens === 201);
    expect(stub.totals()).toEqual({ [SONNET]: entry(SONNET, 400, 47, 3000, 50), [GPT]: entry(GPT, 201, 21, 0, 0) });
  });

  test("a batch the backend did not acknowledge survives a restart and lands once", async () => {
    stub.failNextBatch(503, { message: "unavailable" });
    const first = pump();
    for (const s of threeSteps()) first.observe(s);
    first.kick();
    await waitFor(() => stub.calls.batches === 1);
    await first.stop();
    expect((await queueFiles(stub.login())).length).toBe(1);
    expect(stub.stored().size).toBe(0);

    pump();
    await waitFor(() => stub.stored().size === 2);
    expect(stub.totals()).toEqual({ [SONNET]: entry(SONNET, 400, 47, 3000, 50), [GPT]: entry(GPT, 200, 20, 0, 0) });
    await waitFor(async () => (await queueFiles(stub.login())).length === 0, 5_000, "queue settled");
  });

  test("409 generation clears the queue, re-initializes the stream and recaptures every hour", async () => {
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.stored().size === 2);

    stub.rotateGeneration();
    p.observe(step("prt_4", GPT, "2026-10-11T11:20:00Z", { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
    p.kick();
    await waitFor(() => stub.stored().size === 2 && stub.totals()[GPT]?.inputTokens === 201, 10_000, "recapture under the new generation");

    expect(stub.calls.conflicts).toEqual(["Usage stream generation changed"]);
    expect(stub.calls.initialize).toBe(2);
    expect(stub.calls.reset).toBe(0);
    expect(stub.totals()).toEqual({ [SONNET]: entry(SONNET, 400, 47, 3000, 50), [GPT]: entry(GPT, 201, 20, 0, 0) });
  });

  test("each step reaches the backend once as a call record, beside its own hour's snapshot", async () => {
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.records().size === 3, 10_000, "three call records");

    const records = stub.records();
    expect(records.get("ses_a|msg_anthropic/claude-sonnet-5:prt_1")).toEqual({
      key: "msg_anthropic/claude-sonnet-5:prt_1",
      model: SONNET,
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      reasoningOutputTokens: 2,
      occurredAt: "2026-10-11T10:59:58.000Z",
      batchHours: expect.arrayContaining(["ses_a|2026-10-11|10"]),
    });
    for (const r of records.values()) {
      const hour = `ses_a|${r.occurredAt.slice(0, 10)}|${Number(r.occurredAt.slice(11, 13))}`;
      expect(r.batchHours).toContain(hour);
    }
    expect(stub.sentRecords.flat()).toHaveLength(3);
  });

  test("a restart sends no record twice, and a new step sends only its own", async () => {
    const first = pump();
    for (const s of threeSteps()) first.observe(s);
    first.kick();
    await waitFor(() => stub.records().size === 3);
    await first.stop();

    const second = pump();
    second.observe(step("prt_4", GPT, "2026-10-11T11:20:00Z", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }));
    second.kick();
    await waitFor(() => stub.records().size === 4);
    await Bun.sleep(100);
    const sent = stub.sentRecords.flat();
    expect(sent).toHaveLength(4);
    expect(new Set(sent).size).toBe(4);
  });

  test("a refused batch is resent one hour at a time, each record beside its own hour", async () => {
    stub.failNextBatch(400, { statusCode: 400, message: "bad snapshot" });
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.stored().size === 2 && stub.records().size === 3, 10_000, "split batches landed");
    expect(stub.sentRecords.map((keys) => keys.length).sort()).toEqual([1, 2]);
    for (const r of stub.records().values()) expect(r.batchHours).toEqual([`ses_a|2026-10-11|${Number(r.occurredAt.slice(11, 13))}`]);
  });

  test("a new stream generation resends every call record", async () => {
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.records().size === 3);

    stub.rotateGeneration();
    p.observe(step("prt_4", GPT, "2026-10-11T11:20:00Z", { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
    p.kick();
    await waitFor(() => stub.records().size === 4, 10_000, "every record under the new generation");
  });

  test("relogin_required pauses the pump until the login changes", async () => {
    // conmap-auto dev src/common/tool-telemetry.ts ReloginRequiredException
    stub.failNextBatch(403, { statusCode: 403, error: "relogin_required", reason: "no_product", message: "Run: armoriq login" });
    const p = pump();
    for (const s of threeSteps()) p.observe(s);
    p.kick();
    await waitFor(() => stub.calls.batches === 1);
    p.kick();
    await Bun.sleep(200);
    expect(stub.calls.batches).toBe(1);
    expect(stub.stored().size).toBe(0);
  });

  test("two processes writing the same session never reuse a revision", async () => {
    const login = stub.login();
    const child = (prefix: string) =>
      Bun.spawn(["bun", path.join(import.meta.dir, "usage-child.ts"), dataDir, JSON.stringify(login), prefix, "40"], {
        stdout: "inherit",
        stderr: "inherit",
      });
    const [a, b] = [child("a"), child("b")];
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);

    // A final pass ships whatever the children left queued or uncaptured.
    pump(login).kick();
    await waitFor(() => stub.totals()[SONNET]?.inputTokens === 80, 10_000, "all 80 steps counted");

    expect(stub.calls.conflicts).toEqual([]);
    const seen = new Map<string, string>();
    for (const s of stub.accepted) {
      const key = `${s.sessionId}|${s.hour}|${s.revision}`;
      expect(seen.get(key) ?? s.digest).toBe(s.digest);
      seen.set(key, s.digest);
    }
    const revisions = stub.accepted.map((s) => s.revision);
    expect(stub.accepted.length).toBeGreaterThan(2);
    expect(new Set(revisions.map((r, i) => `${stub.accepted[i]!.hour}|${r}`)).size).toBe(revisions.length);
    expect(stub.totals()).toEqual({ [SONNET]: entry(SONNET, 80, 80, 0, 0) });
  }, 30_000);
});

describe("hot path cost", () => {
  test("observe() p95 stays under 20 us", () => {
    const login = stub.login();
    const p = createUsagePump({ dataDir, login: () => login, log }, { intervalMs: 60_000, persistDelayMs: 60_000 });
    pumps.push(p);
    const steps = Array.from({ length: 20_000 }, (_, i) =>
      step(`prt_${i}`, SONNET, "2026-10-11T10:00:00Z", { input: i, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, `ses_${i % 50}`),
    );
    const samples: number[] = [];
    for (const s of steps) {
      const t = Bun.nanoseconds();
      p.observe(s);
      samples.push(Bun.nanoseconds() - t);
    }
    samples.sort((x, y) => x - y);
    const p95us = samples[Math.floor(samples.length * 0.95)]! / 1000;
    console.log(`observe(): p50 ${(samples[samples.length >> 1]! / 1000).toFixed(2)} us, p95 ${p95us.toFixed(2)} us`);
    expect(p95us).toBeLessThan(20);
  });
});

describe("idle", () => {
  test("a logged-in pump with nothing to send never opens the stream", async () => {
    let made = 0;
    const login = stub.login();
    const p = createUsagePump(
      { dataDir, login: () => login, log },
      { intervalMs: 20, persistDelayMs: 1, client: async () => (made++, { initialize: async () => ({ ok: false, retryable: true, reason: "x" }), send: async () => ({ ok: false, retryable: true, reason: "x" }) }) },
    );
    pumps.push(p);
    p.start();
    p.kick();
    await Bun.sleep(150);
    expect(made).toBe(0);
    expect(stub.calls.initialize).toBe(0);
  });
});
