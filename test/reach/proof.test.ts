import { expect, test } from "bun:test";
import { contract } from "./helpers.ts";

import { assertCleanRequests as check, assertCompactionProof, compactionReply, COMPACTION_SUMMARY } from "../../scripts/ci/reach-context-proof.ts";
test("real host proof requires captured requests", () => {
  expect(() => check([])).toThrow("No model requests were captured");
});
test("real host proof accepts ordinary model input", () => {
  expect(check([{ messages: [{ role: "user", content: "fixture prompt" }] }])).toBeUndefined();
});
for (const text of [contract.notice, "ArmorOpenCode is not signed in to ArmorIQ. Sign in", "ArmorIQ showed you a local notice. No action is needed."]) {
  test(`real host proof rejects leaked message: ${text.slice(0, 45)}`, () => {
    expect(() => check([{ messages: [{ role: "user", content: [{ type: "text", text }] }] }])).toThrow("Reach message leaked");
  });
}

const sessionID = "original-session";
const syntheticID = "notice-id";
const compaction = { id: "compact-id", type: "compaction", status: "completed", summary: COMPACTION_SUMMARY };
const headings = ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"];
const summaryPrompt = `You MUST summarize the conversation above into a structured summary.\n<template>\n${headings.join("\n- (none)\n")}\n- (none)\n</template>`;
const retryPrompt = "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.";
const summaryRequest = (prompt = summaryPrompt, content: unknown = "fixture context") => ({
  messages: [{ role: "user", content }, { role: "user", content: prompt }],
  tools: [{ type: "function", function: { name: "read" } }],
});
const requests = [
  { stage: "compaction", request: summaryRequest(), summary: true },
  { stage: "after-compaction", request: { messages: [{ role: "user", content: "continue the fixture" }] } },
];
const contexts = () => ["compaction", "after-compaction"].flatMap(stage => ["before", "after"].map(kind => ({
  stage, kind, sessionID, messages: [{ id: "fixture-id", text: "fixture context" }],
})));

test("compaction proof records summary and prompt evidence for the original session", () => {
  expect(assertCompactionProof(requests, contexts(), sessionID, syntheticID, compaction)).toEqual({
    status: "passed", messageID: "compact-id", summaryRequests: 1, requestsWithReachNote: 0,
    requests: { compaction: 1, afterCompaction: 1 },
    contexts: { compaction: { before: 1, after: 1 }, afterCompaction: { before: 1, after: 1 } },
  });
});

test("compaction proof cannot pass with only a prompt request", () => {
  expect(() => assertCompactionProof(requests.slice(1), contexts(), sessionID, syntheticID, compaction)).toThrow("No compaction summary request");
});

test("compaction proof requires the summary request even if other compaction requests exist", () => {
  const ordinary = requests.map(entry => ({ ...entry, request: { messages: [{ role: "user", content: "ordinary continuation" }] }, summary: true }));
  expect(() => assertCompactionProof(ordinary, contexts(), sessionID, syntheticID, compaction)).toThrow("No compaction summary request");
});

test("compaction summary fills every required template heading with neutral text", () => {
  expect(COMPACTION_SUMMARY.split("\n").filter(line => line.startsWith("#"))).toEqual(headings);
  for (const heading of headings) expect(COMPACTION_SUMMARY).toContain(`${heading}\n- `);
  expect(check([COMPACTION_SUMMARY])).toBeUndefined();
});

test("compaction proof accepts summary calls with offered tools and no context hook events", () => {
  const after = contexts().filter(entry => entry.stage === "after-compaction");
  expect(assertCompactionProof(requests, after, sessionID, syntheticID, compaction).contexts).toEqual({
    compaction: { before: 0, after: 0 }, afterCompaction: { before: 1, after: 1 },
  });
});

test("compaction proof counts requests carrying the neutral note, including summary retries", () => {
  const summaries = [
    { stage: "compaction", request: summaryRequest(summaryPrompt, "ArmorIQ showed you a local notice. No action is needed. ".repeat(2)) },
    { stage: "compaction", request: summaryRequest(retryPrompt, [{ type: "text", text: "ArmorIQ showed you a local notice. No action is needed." }]) },
    requests[1]!,
  ];
  const result = assertCompactionProof(summaries, contexts().filter(entry => entry.stage === "after-compaction"), sessionID, syntheticID, compaction);
  expect(result.summaryRequests).toBe(2);
  expect(result.requestsWithReachNote).toBe(2);
});

for (const text of [contract.notice, "ArmorOpenCode is not signed in to ArmorIQ. Sign in"]) {
  test(`compaction summary still rejects person facing text: ${text.slice(0, 30)}`, () => {
    const leaked = [{ stage: "compaction", request: summaryRequest(summaryPrompt, text) }, requests[1]!];
    expect(() => assertCompactionProof(leaked, contexts(), sessionID, syntheticID, compaction)).toThrow("Reach message leaked");
  });
}

test("compaction proof requires a request after compaction", () => {
  expect(() => assertCompactionProof(requests.slice(0, 1), contexts(), sessionID, syntheticID, compaction)).toThrow("No model requests");
});

for (const result of [null, { ...compaction, status: "running" }, { ...compaction, status: "failed" }, { ...compaction, summary: "unrelated title" }]) {
  test(`compaction proof rejects an unproven summary: ${result?.status ?? "missing"} ${result?.summary === "unrelated title"}`, () => {
    expect(() => assertCompactionProof(requests, contexts(), sessionID, syntheticID, result)).toThrow("Compaction did not complete with the scripted summary");
  });
}

for (const stage of ["compaction", "after-compaction"]) {
  for (const text of [contract.notice, "ArmorOpenCode is not signed in to ArmorIQ. Sign in", "ArmorIQ showed you a local notice. No action is needed."]) {
    test(`compaction proof rejects a leaked ${stage} model request: ${text.slice(0, 30)}`, () => {
      const leaked = [...requests, { stage, request: { messages: [{ role: "user", content: text }] } }];
      expect(() => assertCompactionProof(leaked, contexts(), sessionID, syntheticID, compaction)).toThrow("Reach message leaked");
    });
    for (const kind of text.startsWith("ArmorIQ showed") ? ["after"] : ["before", "after"]) {
      test(`compaction proof rejects a leaked ${stage} ${kind} context: ${text.slice(0, 30)}`, () => {
        const leaked = contexts().map(entry => entry.stage === stage && entry.kind === kind ? { ...entry, messages: [{ id: "fixture-id", text }] } : entry);
        expect(() => assertCompactionProof(requests, leaked, sessionID, syntheticID, compaction)).toThrow("Reach message leaked");
      });
    }
  }
  for (const kind of ["before", "after"]) {
    if (stage === "compaction") {
      test(`compaction proof records an optional ${kind} context when the summary bypasses the hook`, () => {
        const absent = contexts().filter(entry => entry.stage !== stage || entry.kind !== kind);
        expect(assertCompactionProof(requests, absent, sessionID, syntheticID, compaction).contexts.compaction[kind as "before" | "after"]).toBe(0);
      });
      continue;
    }
    test(`compaction proof requires the original session's ${stage} ${kind} context`, () => {
      const otherSession = contexts().map(entry => entry.stage === stage && entry.kind === kind ? { ...entry, sessionID: "another-session" } : entry);
      expect(() => assertCompactionProof(requests, otherSession, sessionID, syntheticID, compaction)).toThrow(`No ${stage} ${kind} context`);
    });
  }
}

test("raw before contexts may contain the neutral synthetic message that the hook removes", () => {
  const before = contexts().map(entry => entry.kind === "before" ? { ...entry, messages: [{ id: syntheticID, text: "ArmorIQ showed you a local notice. No action is needed." }] } : entry);
  expect(assertCompactionProof(requests, before, sessionID, syntheticID, compaction).status).toBe("passed");
});

test("an ordinary compaction request cannot carry the neutral note even when marked as a summary", () => {
  const ordinary = { stage: "compaction", summary: true, request: { messages: [{ role: "user", content: "ArmorIQ showed you a local notice. No action is needed." }] } };
  expect(() => assertCompactionProof([...requests, ordinary], contexts(), sessionID, syntheticID, compaction)).toThrow("Reach message leaked");
});

test("an earlier summary instruction does not exempt a later ordinary request", () => {
  const ordinary = { stage: "compaction", request: { messages: [{ role: "user", content: summaryPrompt }, { role: "user", content: "ArmorIQ showed you a local notice. No action is needed." }] } };
  expect(() => assertCompactionProof([...requests, ordinary], contexts(), sessionID, syntheticID, compaction)).toThrow("Reach message leaked");
});

test("compaction proof rejects a surviving synthetic id even if its text changed", () => {
  const leaked = contexts().map(entry => ({ ...entry, messages: [{ id: syntheticID, text: "changed text" }] }));
  expect(() => assertCompactionProof(requests, leaked, sessionID, syntheticID, compaction)).toThrow("Synthetic id survived");
});

for (const stream of [false, true]) {
  test(`compaction stub answers a ${stream ? "streaming" : "JSON"} summary request`, async () => {
    const response = compactionReply(stream);
    if (stream) {
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const body = await response.text();
      const chunks = body.split("\n\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
      expect(chunks.map(chunk => chunk.choices[0].delta.content ?? "").join("")).toBe(COMPACTION_SUMMARY);
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
      expect(body).toContain("data: [DONE]");
    } else {
      const body = await response.json() as { choices: { message: { role: string; content: string }; finish_reason: string }[] };
      expect(body.choices[0]?.message).toEqual({ role: "assistant", content: COMPACTION_SUMMARY });
      expect(body.choices[0]?.finish_reason).toBe("stop");
    }
  });
}
