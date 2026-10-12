import { afterEach, expect, test } from "bun:test";
import { BATCH_TIMEOUT_MS, postAuditBatch } from "../../src/io/backend-audit.ts";
import { accepted, login, row, stubBackend } from "./helpers/stub.ts";

let stub: ReturnType<typeof stubBackend> | undefined;
afterEach(() => stub?.stop());

test("posts rows with the api key and returns per-row failures", async () => {
  stub = stubBackend(() => Response.json({ written: 1, orphan: 1, failures: [{ index: 1, error: "invalid row: input must be an object" }] }));
  const result = await postAuditBatch(login(stub.url), [row("bash"), row("read")]);
  expect(result).toEqual({ ok: true, value: { written: 1, failures: [{ index: 1, error: "invalid row: input must be an object" }] } });
  expect(stub.batches[0]!.map((r) => r.tool)).toEqual(["bash", "read"]);
  expect(stub.headers[0]!.get("authorization")).toBe("Bearer ak_live_test");
  expect(stub.headers[0]!.get("x-api-key")).toBe("ak_live_test");
});

test("a 2xx without a failures list is a failed send", async () => {
  stub = stubBackend(() => Response.json({ written: 2 }));
  const result = await postAuditBatch(login(stub.url), [row("bash")]);
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.retryable).toBe(true);
});

test("a failure index outside the batch is a failed send, not a written row", async () => {
  stub = stubBackend(() => Response.json({ written: 0, failures: [{ index: 1, error: "invalid row: x" }] }));
  const result = await postAuditBatch(login(stub.url), [row("bash")]);
  expect(result.ok === false && result.retryable).toBe(true);
});

test("a whole-request 400 or 422 is retried unchanged; only 413 asks for a smaller batch", async () => {
  for (const [status, retryable] of [[400, true], [422, true], [413, false]] as const) {
    stub?.stop();
    stub = stubBackend(() => new Response("refused", { status }));
    const result = await postAuditBatch(login(stub.url), [row("bash")]);
    expect([status, result.ok === false && result.retryable]).toEqual([status, retryable]);
  }
});

test("403 relogin_required asks for a relogin", async () => {
  stub = stubBackend(() => Response.json({ error: "relogin_required" }, { status: 403 }));
  expect(await postAuditBatch(login(stub.url), [row("bash")])).toEqual({ ok: false, retryable: false, relogin: true, reason: "relogin_required" });
});

test("503 with Retry-After is retryable and carries the delay", async () => {
  stub = stubBackend(() => new Response("busy", { status: 503, headers: { "retry-after": "7" } }));
  const result = await postAuditBatch(login(stub.url), [row("bash")]);
  expect(result.ok === false && [result.retryable, result.retryAfterMs]).toEqual([true, 7000]);
});

test("an unreachable backend is retryable", async () => {
  const result = await postAuditBatch(login("http://127.0.0.1:1"), [row("bash")]);
  expect(result.ok === false && result.retryable).toBe(true);
});

test("a response slower than the timeout is abandoned as retryable", async () => {
  stub = stubBackend(async (rows) => {
    await Bun.sleep(300);
    return accepted(rows);
  });
  const result = await postAuditBatch(login(stub.url), [row("bash")], 50);
  expect(result.ok === false && result.retryable).toBe(true);
});

test("the default timeout outlasts the backend's 15 s batch budget", () => {
  expect(BATCH_TIMEOUT_MS).toBeGreaterThan(15_000);
});
