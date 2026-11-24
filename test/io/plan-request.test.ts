import { afterEach, beforeEach, expect, test } from "bun:test";
import { mintToken } from "../../src/io/backend-intent.ts";
import { planRequest } from "../../src/core/plan-request.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Login } from "../../src/types.ts";
import { intentTransport } from "../support/intent-transport.ts";

const login: Login = { backend: "http://localhost:1", apiKey: "ak_test_contract", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
let wire: ReturnType<typeof intentTransport>;
beforeEach(() => { wire = intentTransport(); });
afterEach(() => { wire.restore(); });
const descriptor = () => planRequest({ kind: "new", promptId: "prompt", planHash: "hash" }, { user_id: "u", agent_id: "opencode", context_id: "root", expires_in: 3600, plan: { goal: "g", steps: [{ action: "bash" }] } });

for (const failure of ["network", "timeout", "429", "503", "in_progress"]) test(`transport retries ${failure} with the same key and body`, async () => {
  const d = descriptor();
  if (failure === "network" || failure === "timeout") wire.queue.push({ run: async () => { throw new Error(failure); } });
  else wire.queue.push({ status: failure === "in_progress" ? 409 : Number(failure), body: { error: "request_in_progress" }, headers: { "retry-after": "0" } });
  const result = await mintToken(login, d);
  expect(result.ok).toBe(true);
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[1]!.headers).toEqual(wire.requests[0]!.headers);
  expect(wire.requests[1]!.body).toEqual(d.body);
});

test("other 409 and 4xx are terminal failures", async () => {
  for (const status of [400, 409, 422]) {
    wire.queue.push({ status, body: { error: "different_error" } });
    const start = wire.requests.length;
    const result = await mintToken(login, descriptor());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.retryable).toBe(false);
    expect(wire.requests.length - start).toBe(1);
  }
});

test("one 40 second deadline bounds attempts and honours both Retry-After forms", async () => {
  for (const header of ["2", new Date(12_000).toUTCString()]) {
    let clock = 10_000;
    const delays: number[] = [];
    wire.queue.push({ status: 429, headers: { "retry-after": header } });
    const result = await mintToken(login, descriptor(), { now: () => clock, sleep: async ms => { delays.push(ms); clock += ms; } });
    expect(result.ok).toBe(true);
    expect(delays).toEqual([2000]);
  }
  let clock = 10_000;
  const before = wire.requests.length;
  wire.queue.push({ status: 409, body: { error: "request_in_progress" }, headers: { "retry-after": "41" } });
  const result = await mintToken(login, descriptor(), { now: () => clock, sleep: async ms => { clock += ms; } });
  expect(result.ok).toBe(false);
  expect(wire.requests.length - before).toBe(1);
  expect(clock).toBeLessThanOrEqual(50_000);
});

test("invalid validity refuses startup before resources are opened", () => {
  const previous = process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
  try {
    process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = "179";
    expect(() => new Runtime({ info() {}, warn() {}, error() {} })).toThrow("ARMORIQ_INTENT_VALIDITY_SECONDS");
  } finally {
    if (previous === undefined) delete process.env.ARMORIQ_INTENT_VALIDITY_SECONDS;
    else process.env.ARMORIQ_INTENT_VALIDITY_SECONDS = previous;
  }
});

test("the remaining logical deadline caps the next attempt timeout", async () => {
  let clock = 0;
  wire.queue.push({ status: 503, run: async () => { clock += 38_000; } });
  expect((await mintToken(login, descriptor(), { now: () => clock })).ok).toBe(true);
  expect(wire.requests.map(r => r.timeout)).toEqual([20_000, 2000]);
});

test("one failure is reported after the logical deadline, rather than per attempt", async () => {
  let clock = 0;
  const reasons: string[] = [];
  for (let i = 0; i < 2; i++) wire.queue.push({ status: 503, run: async () => { clock += 20_000; } });
  const result = await mintToken(login, descriptor(), { now: () => clock, onFailure: reason => { reasons.push(reason); } });
  expect(result.ok).toBe(false);
  expect(wire.requests).toHaveLength(2);
  expect(reasons).toEqual(["server_error"]);
});

test("final refusal reports once and transient recovery reports no failure", async () => {
  const reasons: string[] = [];
  wire.queue.push({ status: 422 });
  await mintToken(login, descriptor(), { onFailure: reason => { reasons.push(reason); } });
  expect(reasons).toEqual(["rejected"]);
  reasons.length = 0;
  wire.queue.push({ status: 503 });
  expect((await mintToken(login, descriptor(), { onFailure: reason => { reasons.push(reason); } })).ok).toBe(true);
  expect(reasons).toEqual([]);
});

test("a real attempt timeout retries once within the logical deadline", async () => {
  wire.queue.push({ run: () => new Promise(() => {}) }, { run: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await mintToken(login, descriptor());
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toMatch(/^timed out after \d+ ms$/);
  expect(wire.requests[0]!.timeout).toBe(20_000);
  expect(wire.requests).toHaveLength(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(39_900);
  expect(Date.now() - started).toBeLessThan(41_500);
  expect(wire.requests[0]!.headers["Idempotency-Key"]).toBe(wire.requests[1]!.headers["Idempotency-Key"]);
}, 45_000);
