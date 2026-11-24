import { describe, expect, test } from "bun:test";
import { stepUsageFromPart } from "../../support/v1-step-usage.ts";

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
      reasoningTokens: 5,
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
