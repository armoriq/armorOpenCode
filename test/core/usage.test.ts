import { describe, expect, test } from "bun:test";
import sdk from "@armoriq/sdk-dev";
import {
  bucketByHour,
  changedBuckets,
  hourKey,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_SNAPSHOTS,
  packBatches,
  stepUsageFromPart,
  toSnapshots,
  type UsageSnapshot,
} from "../../src/core/usage.ts";

const part = (id: string, tokens: Record<string, unknown>, messageID = "msg_1", sessionID = "ses_1") => ({
  id,
  sessionID,
  messageID,
  type: "step-finish",
  reason: "stop",
  cost: 0,
  tokens,
});
const models: Record<string, string> = { msg_1: "anthropic/claude-sonnet-5", msg_2: "openai/gpt-5" };
const modelOf = (id: string) => models[id] ?? null;
const at = (iso: string) => Date.parse(iso);

describe("stepUsageFromPart", () => {
  test("maps step tokens and counts reasoning as output, as ArmorCodex does", () => {
    const step = stepUsageFromPart(
      part("prt_1", { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 40 } }),
      modelOf,
      "/repo",
      at("2026-10-11T10:00:00Z"),
    );
    expect(step).toEqual({
      sessionId: "ses_1" as any,
      messageId: "msg_1",
      partId: "prt_1",
      at: at("2026-10-11T10:00:00Z"),
      repo: "/repo",
      entry: { model: "anthropic/claude-sonnet-5", inputTokens: 100, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 40 },
    });
  });

  test("rejects non step-finish parts, zero usage and malformed ids; unknown model stays countable", () => {
    expect(stepUsageFromPart({ ...part("p", { input: 1 }), type: "text" }, modelOf, "r")).toBeNull();
    expect(stepUsageFromPart(part("p", { input: 0, output: 0, cache: {} }), modelOf, "r")).toBeNull();
    expect(stepUsageFromPart({ ...part("p", { input: 1 }), sessionID: 7 }, modelOf, "r")).toBeNull();
    expect(stepUsageFromPart(part("p", { input: -5, output: Number.NaN, reasoning: "x" }), modelOf, "r")).toBeNull();
    expect(stepUsageFromPart(part("p", { input: 3 }, "msg_9"), modelOf, "r")?.entry.model).toBe("unknown");
  });
});

describe("bucketByHour", () => {
  test("splits a session at the UTC hour boundary and sums per model", () => {
    const steps = [
      stepUsageFromPart(part("a", { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }), modelOf, "/r", at("2026-10-11T10:59:59Z"))!,
      stepUsageFromPart(part("b", { input: 20, output: 2, reasoning: 1, cache: { read: 5, write: 0 } }, "msg_2"), modelOf, "/r", at("2026-10-11T11:00:00Z"))!,
      stepUsageFromPart(part("c", { input: 30, output: 3, reasoning: 0, cache: { read: 0, write: 7 } }), modelOf, "/r", at("2026-10-11T11:30:00Z"))!,
    ];
    const buckets = bucketByHour(steps);
    expect(buckets.map((b) => [hourKey(b), b.entries])).toEqual([
      ["2026-10-11T10", [{ model: "anthropic/claude-sonnet-5", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]],
      [
        "2026-10-11T11",
        [
          { model: "anthropic/claude-sonnet-5", inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 7 },
          { model: "openai/gpt-5", inputTokens: 20, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 },
        ],
      ],
    ]);
    expect(bucketByHour([...steps].reverse()).map((b) => b.digest)).toEqual(buckets.map((b) => b.digest));
    expect(changedBuckets(buckets, { [hourKey(buckets[0]!)]: buckets[0]!.digest })).toEqual([buckets[1]!]);
  });
});

describe("packBatches", () => {
  test("uses the SDK's batch limits", () => {
    expect([MAX_BATCH_SNAPSHOTS, MAX_BATCH_ENTRIES, MAX_BATCH_BYTES]).toEqual([
      sdk.MAX_BATCH_SNAPSHOTS,
      sdk.MAX_BATCH_ENTRIES,
      sdk.MAX_BATCH_BYTES,
    ]);
  });

  test("the SDK turns timed calls into usage call records", () => {
    const usage = { model: "openai/gpt-5", inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 };
    expect(sdk.usageCallRecords([{ ...usage, key: "msg_1:prt_1", timestampMs: Date.UTC(2026, 9, 12, 9, 30) }])).toEqual([
      { ...usage, key: "msg_1:prt_1", occurredAt: "2026-10-12T09:30:00.000Z" },
    ]);
  });

  test("every batch stays inside the snapshot, entry and byte limits", () => {
    const entry = (m: number) => ({ model: `m${m}`, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const many: UsageSnapshot[] = Array.from({ length: 250 }, (_, i) => ({
      sessionId: `ses_${i}`,
      usageDate: "2026-10-11",
      usageHour: 1,
      revision: 1,
      armored: true,
      repo: "x".repeat(200),
      entries: Array.from({ length: 1 + (i % 7) }, (_, m) => entry(m)),
    }));
    const batches = packBatches(many);
    expect(batches.flat()).toEqual(many);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(MAX_BATCH_SNAPSHOTS);
      expect(b.reduce((n, s) => n + s.entries.length, 0)).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
      expect(Buffer.byteLength(JSON.stringify({ generation: "g", batchId: "b", snapshots: b }))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  test("snapshots carry armored, a bounded repo and the revision", () => {
    const [b] = bucketByHour([stepUsageFromPart(part("a", { input: 1 }), modelOf, "r".repeat(500), 0)!]);
    const [s] = toSnapshots([b!], 7);
    expect(s).toMatchObject({ sessionId: "ses_1", usageDate: "1970-01-01", usageHour: 0, revision: 7, armored: true });
    expect(s!.repo).toHaveLength(200);
  });

  test("a repo cut at the limit never ends in half of a surrogate pair", () => {
    const repo = `${"r".repeat(199)}\u{1F600}tail`;
    const [b] = bucketByHour([stepUsageFromPart(part("a", { input: 1 }), modelOf, repo, 0)!]);
    const [s] = toSnapshots([b!], 1);
    expect(s!.repo).toBe("r".repeat(199));
    expect(s!.repo!.isWellFormed()).toBe(true);
  });
});
