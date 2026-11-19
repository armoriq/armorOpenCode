import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHealthPump } from "../../src/pumps/health.ts";
import { createAuditPump } from "../../src/pumps/audit.ts";
import { postClientEvents } from "../../src/io/backend-client-events.ts";
import { handleArmorCommand } from "../../src/commands/armor.ts";
import { login, memoryLog, row, scratch } from "../io/helpers/stub.ts";
import { fakeRuntime } from "../support/intent-harness.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

test("audit dead letters reach the health endpoint with the source login", async () => {
  const dir = scratch();
  const auth = login("http://localhost:1");
  const batches: unknown[][] = [];
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: memoryLog().log, post: async (bound, events) => {
    expect(bound).toEqual(auth);
    batches.push([...events]);
    return { ok: true, rejected: [] };
  } });
  const audit = createAuditPump({ dataDir: dir, login: () => auth, log: memoryLog().log, health, post: async () => ({ ok: true, value: { written: 0, failures: [{ index: 0, error: "invalid row: rejected" }] } }) });
  cleanup.push(async () => { await audit.stop(); await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  audit.enqueue(row("bash"));
  await audit.kick();
  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual([expect.objectContaining({ type: "dead_letter", queue: "audit", count: 1, reason_code: "rejected" })]);
});

test("failed request ids deduplicate across restart and status shows pending health and pause", async () => {
  const dir = scratch();
  const auth = login("http://localhost:1");
  const deps = { dataDir: dir, login: () => auth, log: memoryLog().log, post: async () => ({ ok: false as const, endpointStatus: 404 }) };
  let health = createHealthPump(deps);
  await health.planRequestFailed(auth, "logical-request", "timeout");
  await health.kick();
  await health.stop();
  health = createHealthPump(deps);
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "logical-request", "timeout");
  expect(health.status()).toMatchObject({ pending: 1, paused: true });
  const rt = await fakeRuntime(auth);
  Object.assign(rt, { health });
  const output = handleArmorCommand("/armor status", "s", rt)!;
  expect(output).toContain("Health: 1 pending");
  expect(output).toContain("paused");
});

test("health transport posts events with client headers and consumes duplicate outcomes", async () => {
  const original = globalThis.fetch;
  const auth = login("http://localhost:1");
  const event = { event_id: crypto.randomUUID(), type: "plan_request_failed" as const, queue: "health" as const, count: 1, reason_code: "timeout" as const, occurred_at: new Date().toISOString() };
  try {
    globalThis.fetch = (async (url, init) => {
      expect(url).toBe(`${auth.backend}/iap/client-events`);
      expect(JSON.parse(String(init!.body))).toEqual({ events: [event] });
      expect(new Headers(init!.headers).get("x-armoriq-client")).toBeTruthy();
      expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${auth.apiKey}`);
      return Response.json({ results: [{ event_id: event.event_id, outcome: "duplicate" }] });
    }) as typeof fetch;
    expect(await postClientEvents(auth, [event])).toMatchObject({ ok: true, rejected: [] });
  } finally { globalThis.fetch = original; }
});

test("a transient request failure waits for its logical deadline and recovery cancels it", async () => {
  const dir = scratch();
  const auth = login("http://localhost:1");
  let now = 0;
  const delivered: unknown[] = [];
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: memoryLog().log, clock: { now: () => now, random: () => 0 }, post: async (_auth, events) => {
    delivered.push(...events);
    return { ok: true, rejected: [] };
  } });
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "recovered", "network", 40_000);
  await health.kick();
  expect(delivered).toHaveLength(0);
  await health.planRequestSucceeded(auth, "recovered");
  await health.planRequestFailed(auth, "exhausted", "network", 40_000);
  now = 40_000;
  await health.kick();
  expect(delivered).toEqual([expect.objectContaining({ type: "plan_request_failed", reason_code: "network", occurred_at: new Date(40_000).toISOString() })]);
});

test("a final refusal replaces a provisional failure immediately without counting twice", async () => {
  const dir = scratch();
  const auth = login("http://localhost:1");
  const delivered: unknown[] = [];
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: memoryLog().log, clock: { now: () => 1000, random: () => 0 }, post: async (_auth, events) => {
    delivered.push(...events);
    return { ok: true, rejected: [] };
  } });
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "request", "network", 40_000);
  await health.planRequestFailed(auth, "request", "rejected");
  await health.kick();
  expect(delivered).toEqual([expect.objectContaining({ reason_code: "rejected", occurred_at: new Date(1000).toISOString() })]);
});

// regression: #0012
test("health startup, login and shutdown storage failures stay local and log once", async () => {
  const dir = scratch(); const logs = memoryLog(); const auth = login("http://localhost:1");
  writeFileSync(join(dir, "outbox"), "storage unavailable");
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: logs.log });
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "a", "network");
  await health.planRequestFailed(auth, "b", "network");
  await health.loginChanged(); await health.kick(); await health.stop();
  expect(health.status().captureFailures).toBeGreaterThan(0);
  expect(logs.lines.filter(line => line.level === "error")).toHaveLength(1);
});

// regression: #0012
test("successful registration with no provisional failure does not replay health journals", async () => {
  const dir = scratch(); const auth = login("http://localhost:1");
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: memoryLog().log, post: async () => ({ ok: true, rejected: [] }) });
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "already-reported", "network", 0);
  await health.kick();
  const root = join(dir, "outbox", "health-v2");
  const file = readdirSync(root).find(name => name.endsWith(".jsonl"))!;
  appendFileSync(join(root, file), "damaged journal line\n");
  const before = health.outbox.diagnostics();
  await health.planRequestSucceeded(auth, "never-failed");
  await health.planRequestSucceeded(auth, "already-reported");
  expect(health.outbox.diagnostics()).toEqual(before);
  expect(readdirSync(join(root, "corrupt"))).toEqual([]);
});

// regression: #0012
test("successful authentication with the original login lifts a persisted health auth pause", async () => {
  const dir = scratch(); const auth = login("http://localhost:1");
  const health = createHealthPump({ dataDir: dir, login: () => auth, log: memoryLog().log, post: async () => ({ ok: false, relogin: true }) });
  cleanup.push(async () => { await health.stop(); rmSync(dir, { recursive: true, force: true }); });
  await health.planRequestFailed(auth, "request", "network"); await health.kick();
  expect(health.status().undeliverable).toBe(1);
  await health.authenticationSucceeded({ ...auth, apiKey: "other-key" });
  expect(health.status().undeliverable).toBe(1);
  await health.authenticationSucceeded(auth);
  expect(health.status().undeliverable).toBe(0);
});
