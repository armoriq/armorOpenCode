import { afterEach, describe, it } from "bun:test";
import { rmSync } from "node:fs";
import { createOutbox } from "../../src/io/outbox.ts";
import * as transport from "../../src/io/backend-audit.ts";
import * as pump from "../../src/pumps/audit.ts";
import { memoryLog, scratch } from "../io/helpers/stub.ts";
import { expect, test } from "bun:test";
import { clientEvent, type ClientEvent } from "../../src/core/client-events.ts";
import { parseClientEventsReply } from "../../src/io/backend-client-events.ts";
// The shared suite is JavaScript so the four plugin runtimes can copy it unchanged.
// @ts-expect-error The contract template does not ship TypeScript declarations.
import { defineOutboxConformance } from "./outbox-conformance.template.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function makeAdapter(config: any, shared?: any): any {
  const store = shared ?? { dir: scratch("armor-conformance-"), login: config.login, fault: null, handles: [] };
  const queue: any = createOutbox(store.dir, "audit", memoryLog().log, {
    login: () => store.login,
    preopen: !shared,
    clock: config.clock,
    sizeLimits: config.sizeLimits,
    timing: config.timing,
    beforeCommit(point: string) {
      if (store.fault !== point) return;
      store.fault = null;
      throw new Error(`injected ${point} storage failure`);
    },
  });
  store.handles.push(queue);
  if (!shared) cleanup.push(async () => {
    for (const handle of store.handles) await handle.persist();
    rmSync(store.dir, { recursive: true, force: true });
  });
  return {
    append: async (row: any, options: any) => { queue.prepare(); queue.enqueue(row, options); },
    readPending: async () => queue.readPending(),
    readDeadLetters: async () => queue.readDeadLetters(),
    status: async () => queue.status(),
    switchLogin: async (login: any) => { store.login = login; await queue.restoreLogin(login); queue.prepare(); },
    authenticationSucceeded: async (login: any) => queue.authenticationSucceeded(login),
    failNext: async (point: string) => { store.fault = point; },
    restart: async () => { await queue.persist(); return makeAdapter(config, store); },
    secondDrainer: async () => makeAdapter(config, store),
    drain: async (send: any, { probe }: any = {}) => queue.drain(async (rows: any[], login: any) => {
      const reply = await send({ rows, login });
      // The suite uses empty bodies for status based refusals. Expand those to this backend's actual error envelopes.
      if (reply.status === 403 && !Object.hasOwn(reply.body ?? {}, "results")) reply.body = { error: "relogin_required" };
      if ([400, 422].includes(reply.status) && reply.body && typeof reply.body === "object" && Object.keys(reply.body).length === 0) reply.body = { statusCode: reply.status, error: "Bad Request", message: "legacy row refused" };
      const result = (transport as any).parseAuditReply(reply.status, reply.body, new Headers(reply.headers), rows, config.clock.now());
      return (pump as any).auditSendResult(rows, result);
    }, undefined, { probe: probe && (async (login: any) => { const reply = await probe({ login }); return reply.status >= 200 && reply.status < 300; }) }),
  };
}

defineOutboxConformance({ describe, it, makeAdapter });

function healthStore() {
  const dir = scratch("armor-health-conformance-");
  let now = 10_000;
  let current: { backend: string; keyId: string } | null = { backend: "http://localhost:1", keyId: "original" };
  const handles: ReturnType<typeof createOutbox<any>>[] = [];
  const open = <T>(name: string, extra = {}) => {
    const box = createOutbox<T>(dir, name, memoryLog().log, {
      login: () => current, clock: { now: () => now, random: () => 0 },
      timing: { baseMs: 1, maxMs: 1, lockTtlMs: 1000 }, ...extra,
    });
    handles.push(box);
    return box;
  };
  cleanup.push(async () => {
    for (const box of handles) await box.persist();
    rmSync(dir, { recursive: true, force: true });
  });
  return { open, advance: (ms: number) => { now += ms; }, login: (value: typeof current) => { current = value; } };
}

test("dead letters reach health once after an outage across restarts", async () => {
  const store = healthStore();
  let audit = store.open<any>("audit");
  const health = store.open<ClientEvent>("health");
  for (let i = 0; i < 3; i++) audit.enqueue({ client_row_id: crypto.randomUUID() });
  // A non transient failure spends an attempt; a plain outage never would (outbox v1.1).
  await audit.drain(async rows => ({ ok: true, rejected: rows.map(item => ({ item, error: "refused", permanent: true })) }));
  for (let i = 0; i < 10; i++) {
    await health.drain(async () => ({ ok: false, reason: "outage", stallReason: "server_error" }));
    store.advance(10);
  }
  expect(audit.readDeadLetters()).toHaveLength(3);
  await audit.persist();
  audit = store.open("audit");
  await audit.reportHealth(health);
  expect(health.readPending().map(({ row }) => [row.type, row.queue, row.count, row.reason_code])).toEqual([["dead_letter", "audit", 3, "rejected"]]);
  await health.drain(async () => ({ ok: false, reason: "outage", stallReason: "server_error" }));
  expect(health.readPending()[0]!.attempts).toBe(0);
  store.advance(10);
  await health.drain(async () => ({ ok: true, endpointStatus: 200, rejected: [] }));
  expect(health.readPending()).toHaveLength(0);
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(0);
});

test("stall depth and age use enqueue times and the hourly limit survives restart", async () => {
  const store = healthStore();
  let audit = store.open<any>("audit");
  const health = store.open<ClientEvent>("health");
  audit.enqueue({ client_row_id: crypto.randomUUID(), executed_at: "2000-01-01T00:00:00Z" });
  store.advance(65_000);
  await audit.drain(async () => ({ ok: false, stallReason: "rate_limited" }));
  await audit.reportHealth(health);
  expect(health.readPending()[0]!.row).toMatchObject({ type: "queue_stalled", count: 1, oldest_pending_seconds: 65, reason_code: "rate_limited" });
  await audit.persist();
  audit = store.open("audit");
  audit.enqueue({ client_row_id: crypto.randomUUID() });
  await audit.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
  store.advance(3_600_000);
  await audit.reportHealth(health);
  expect(health.readPending().at(-1)!.row).toMatchObject({ count: 2, oldest_pending_seconds: 3665 });
});

test("404 pauses health on disk without attempts and a later non 404 probe resumes", async () => {
  const store = healthStore();
  let health = store.open<ClientEvent>("health");
  const event = clientEvent("plan_request_failed", "health", 1, "timeout", 10_000, crypto.randomUUID());
  health.enqueue(event);
  let calls = 0;
  await health.drain(async rows => {
    calls++;
    return parseClientEventsReply(404, null, new Headers(), rows);
  });
  expect(health.status()).toMatchObject({ pending: 1, paused: true });
  expect(health.readPending()[0]!.attempts).toBe(0);
  await health.persist();
  health = store.open("health");
  await health.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(1);
  store.advance(300_000);
  await health.drain(async rows => parseClientEventsReply(200, { results: [{ event_id: rows[0]!.event_id, outcome: "duplicate" }] }, new Headers(), rows));
  expect(health.status()).toMatchObject({ pending: 0, paused: false });
});

test("a persisted 404 also pauses events appended by a new writer", async () => {
  const store = healthStore();
  const first = store.open<ClientEvent>("health");
  first.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 10_000, crypto.randomUUID()));
  await first.drain(async rows => parseClientEventsReply(404, null, new Headers(), rows));
  await first.persist();
  const next = store.open<ClientEvent>("health");
  next.enqueue(clientEvent("plan_request_failed", "health", 1, "network", 10_000, crypto.randomUUID()));
  let calls = 0;
  await next.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(0);
  store.advance(300_000);
  await next.drain(async rows => parseClientEventsReply(500, null, new Headers(), rows));
  expect(next.status()).toMatchObject({ pending: 2, paused: false });
});

test("health outcomes settle by event id and malformed replies acknowledge nothing", async () => {
  const store = healthStore();
  const health = store.open<ClientEvent>("health");
  const events = [0, 1, 2].map(() => clientEvent("plan_request_failed", "health", 1, "network", 10_000, crypto.randomUUID()));
  events.forEach(event => health.enqueue(event));
  await health.drain(async rows => parseClientEventsReply(200, { results: [{ event_id: rows[0]!.event_id, outcome: "accepted" }, { event_id: "foreign", outcome: "accepted" }] }, new Headers(), rows));
  expect(health.readPending()).toHaveLength(3);
  store.advance(10);
  await health.drain(async rows => parseClientEventsReply(422, { results: [
    { event_id: rows[2]!.event_id, outcome: "rejected" },
    { event_id: rows[0]!.event_id, outcome: "duplicate" },
  ] }, new Headers(), rows));
  expect(health.readPending().map(({ row }) => row.event_id)).toEqual([events[1]!.event_id]);
  expect(health.readDeadLetters()).toHaveLength(1);
  await health.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
});

test("health respects the original login and the 100 event request cap", async () => {
  const store = healthStore();
  const health = store.open<ClientEvent>("health");
  for (let i = 0; i < 101; i++) health.enqueue(clientEvent("plan_request_failed", "health", 1, "rejected", 10_000, crypto.randomUUID()));
  store.login({ backend: "http://localhost:2", keyId: "different" });
  let calls = 0;
  await health.drain(async () => { calls++; return { ok: true, rejected: [] }; });
  expect(calls).toBe(0);
  expect(health.status().undeliverable).toBe(101);
  store.login({ backend: "http://localhost:1", keyId: "original" });
  const sizes: number[] = [];
  await health.drain(async rows => { sizes.push(rows.length); return { ok: true, rejected: [] }; });
  expect(sizes).toEqual([100, 1]);
});

test("a failed health append keeps the source receipt for retry", async () => {
  const store = healthStore();
  const audit = store.open<any>("audit");
  let fail = true;
  const health = store.open<ClientEvent>("health", { beforeCommit: () => { if (fail) throw new Error("disk full"); } });
  audit.enqueue({ client_row_id: crypto.randomUUID() });
  await audit.drain(async rows => ({ ok: true, rejected: rows.map(item => ({ item, error: "refused", permanent: true })) }));
  await expect(audit.reportHealth(health)).rejects.toThrow("disk full");
  fail = false;
  await audit.reportHealth(health);
  expect(health.readPending().map(({ row }) => row.reason_code)).toEqual(["rejected"]);
});

test("health legacy row refusals dead letter locally without reporting themselves", async () => {
  const store = healthStore();
  const health = store.open<ClientEvent>("health");
  health.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 10_000, crypto.randomUUID()));
  await health.drain(async rows => parseClientEventsReply(400, {}, new Headers(), rows));
  expect(health.status()).toMatchObject({ pending: 0, deadLetters: 1 });
  await health.reportHealth(health);
  expect(health.readPending()).toHaveLength(0);
});

test("client events reject every ambiguous result list without a legacy fallback", () => {
  const event = clientEvent("plan_request_failed", "health", 1, "timeout", 10_000, crypto.randomUUID());
  const result = { event_id: event.event_id, outcome: "accepted" };
  for (const body of [null, {}, { results: null }, { results: [result, result] }, { results: [{ ...result, event_id: crypto.randomUUID() }] }, { results: [{ ...result, outcome: "unknown" }] }, { results: [{ ...result, error: {} }] }]) {
    expect(parseClientEventsReply(200, body, new Headers(), [event]).ok).toBe(false);
  }
  expect(parseClientEventsReply(403, { results: null }, new Headers(), [event])).toMatchObject({ ok: false, relogin: true });
});
