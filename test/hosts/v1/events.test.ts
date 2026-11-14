import { describe, expect, test } from "bun:test";
import { toHostEvent } from "../../../src/hosts/v1/events.ts";

const ev = (type: string, properties: unknown) => toHostEvent({ type, properties }, "/repo");

describe("V1 event mapping", () => {
  test("session lifecycle", () => {
    expect(ev("session.created", { info: { id: "ses_1", parentID: "ses_0" } })).toEqual({ kind: "session_created", sessionId: "ses_1" as any, parentId: "ses_0" as any });
    expect(ev("session.created", { info: { id: "ses_1" } })).toEqual({ kind: "session_created", sessionId: "ses_1" as any, parentId: null });
    expect(ev("session.updated", { info: { id: "ses_1", title: "Fix the build" } })).toEqual({ kind: "session_title", sessionId: "ses_1" as any, title: "Fix the build" });
    expect(ev("session.status", { sessionID: "ses_1", status: { type: "idle" } })).toEqual({ kind: "session_idle", sessionId: "ses_1" as any });
    expect(ev("session.status", { sessionID: "ses_1", status: { type: "busy" } })).toBeNull();
    expect(ev("session.deleted", { info: { id: "ses_1" } })).toEqual({ kind: "session_deleted", sessionId: "ses_1" as any });
  });

  test("assistant model is provider/model, and only for assistant messages with a model", () => {
    expect(ev("message.updated", { info: { id: "msg_1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-5" } })).toEqual({
      kind: "assistant_model",
      messageId: "msg_1",
      model: "anthropic/claude-sonnet-5",
    });
    expect(ev("message.updated", { info: { id: "msg_1", role: "user", providerID: "a", modelID: "b" } })).toBeNull();
    expect(ev("message.updated", { info: { id: "msg_1", role: "assistant", providerID: "a" } })).toBeNull();
  });

  test("tool errors and step tokens", () => {
    expect(ev("message.part.updated", { part: { type: "tool", callID: "c1", state: { status: "error", error: "boom" } } })).toEqual({ kind: "tool_failed", callId: "c1", error: "boom" });
    expect(ev("message.part.updated", { part: { type: "tool", callID: "c1", state: { status: "completed" } } })).toBeNull();
    const part = { type: "step-finish", id: "prt_1", sessionID: "ses_1", messageID: "msg_1", tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } } };
    expect(ev("message.part.updated", { part })).toEqual({
      kind: "step_finished",
      step: { sessionId: "ses_1" as any, messageId: "msg_1", partId: "prt_1", repo: "/repo", input: 10, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 4 },
    });
  });

  test("malformed or unknown events map to nothing instead of throwing", () => {
    for (const bad of [null, 7, "x", {}, { type: 3 }, { type: "session.created" }, { type: "session.created", properties: { info: { id: 5 } } }, { type: "file.edited", properties: {} }])
      expect(toHostEvent(bad, "/repo")).toBeNull();
    expect(ev("message.part.updated", { part: { type: "step-finish", id: "p", sessionID: 7, messageID: "m" } })).toBeNull();
    expect(ev("message.part.updated", { part: { type: "tool", state: { status: "error" } } })).toBeNull();
  });
});
