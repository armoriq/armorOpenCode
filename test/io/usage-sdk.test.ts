import { describe, expect, test } from "bun:test";
import sdk from "@armoriq/sdk-dev";
import { MAX_BATCH_SNAPSHOTS, MAX_BATCH_ENTRIES, MAX_BATCH_BYTES } from "../../src/core/usage.ts";

describe("packBatches SDK compatibility", () => {
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
});
