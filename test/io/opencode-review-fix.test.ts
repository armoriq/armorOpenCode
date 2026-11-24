import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOutbox, type Outbox } from "../../src/io/outbox.ts";
import { createRunsPump } from "../../src/pumps/runs.ts";
import { createHealthPump } from "../../src/pumps/health.ts";
import { parseClientEventsReply } from "../../src/io/backend-client-events.ts";
import { parseRunsReply } from "../../src/io/backend-runs.ts";
import { clientEvent, type ClientEvent } from "../../src/core/client-events.ts";
import { login, memoryLog, scratch } from "./helpers/stub.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const binding = { backend: "http://localhost:1", keyId: "original" };
function store() {
  const dir = scratch("opencode-review-fix-");
  let now = 1000;
  let current = binding;
  const log = memoryLog();
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const open = <T = any>(name = "audit", extra: object = {}): Outbox<T> => {
    const box = createOutbox<T>(dir, name, log.log, { login: () => current, clock: { now: () => now, random: () => 0 }, ...extra });
    cleanup.push(async () => { await box.persist().catch(() => {}); });
    return box;
  };
  return { dir, open, log, clock: { now: () => now, random: () => 0 }, advance: (ms: number) => { now += ms; }, login: (value: typeof current) => { current = value; } };
}

// regression: #0013
test("disabled runs never touch either storage generation, including corrupt storage", async () => {
  const s = store();
  const first = createRunsPump({ dataDir: s.dir, login: () => login(binding.backend), enabled: false, log: s.log.log });
  first.start(); first.begin("r", "s", 1000, true);
  await first.loginChanged(); await first.kick(); await first.stop();
  expect(existsSync(join(s.dir, "outbox", "runs"))).toBe(false);
  expect(existsSync(join(s.dir, "outbox", "runs-v2"))).toBe(false);
  mkdirSync(join(s.dir, "outbox"), { recursive: true });
  writeFileSync(join(s.dir, "outbox", "runs-v2"), "corrupt storage");
  const second = createRunsPump({ dataDir: s.dir, login: () => login(binding.backend), enabled: false, log: s.log.log });
  second.begin("r", "s", 1000, true); await second.loginChanged(); await second.stop();
  expect(readFileSync(join(s.dir, "outbox", "runs-v2"), "utf8")).toBe("corrupt storage");
  expect(s.log.lines).toEqual([]);
});

// regression: #0013
test("rejected runs produce one health dead letter event", async () => {
  const s = store();
  const auth = login(binding.backend);
  const events: ClientEvent[] = [];
  const health = createHealthPump({ dataDir: s.dir, login: () => auth, log: s.log.log, post: async (_auth, batch) => { events.push(...batch); return { ok: true, rejected: [] }; } });
  const runs = createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, health,
    post: async (_auth, reports) => ({ ok: true, rejected: reports.map(item => ({ item, error: "invalid", permanent: true })) }) });
  cleanup.push(async () => { await runs.stop(); await health.stop(); });
  runs.begin("r", "s", 1000, true);
  await runs.kick(); await runs.kick();
  expect(events).toEqual([expect.objectContaining({ type: "dead_letter", queue: "runs", count: 1, reason_code: "rejected" })]);
});

// regression: #0013
test("run attempt appends stay bounded and closed checkpoints move to archives", async () => {
  const s = store();
  const runs = createRunsPump({ dataDir: s.dir, login: () => login(binding.backend), log: s.log.log, enabled: true, clock: s.clock });
  cleanup.push(() => runs.stop());
  runs.begin("r", "s", 1000, true);
  const root = join(s.dir, "outbox", "runs-v2");
  const bytes = () => readdirSync(root).filter(f => f.endsWith(".jsonl")).reduce((n, f) => n + statSync(join(root, f)).size, 0);
  for (let n = 0; n < 100; n++) runs.attempt("r", `call-${n}`, "bash", true);
  const before = bytes();
  for (let n = 100; n < 110; n++) runs.attempt("r", `call-${n}`, "bash", true);
  expect(bytes() - before).toBeLessThan(5000);
  runs.end("r", "stop", 1100);
  await runs.outbox.flush();
  expect(runs.outbox.readCheckpoints()).toEqual([]);
  expect(readdirSync(join(root, "history")).length + readdirSync(join(root, "archive")).length).toBeGreaterThan(0);
  expect(runs.outbox.readPending().at(-1)!.row).toMatchObject({ tool_calls: 110, gated_tool_calls: 110 });
});

// regression: #0013
test("run storage faults are counted once per failed capture and never escape lifecycle calls", async () => {
  const s = store();
  writeFileSync(join(s.dir, "outbox"), "blocked storage");
  const runs = createRunsPump({ dataDir: s.dir, login: () => login(binding.backend), log: s.log.log, enabled: true });
  cleanup.push(() => runs.stop());
  expect(() => { runs.begin("r", "s", 1000, true); runs.attempt("r", "c", "bash", true); runs.request("r", "key", "pending"); runs.reject("r"); runs.end("r", "stop", 1100); }).not.toThrow();
  await expect(runs.loginChanged()).resolves.toBeUndefined();
  expect(runs.status().captureFailures).toBeGreaterThan(0);
});

// regression: #0012
test("successful settlement clears stale stalls and newly queued rows are not overdue", async () => {
  const s = store(); const box = s.open(); const health = s.open<ClientEvent>("health");
  box.enqueue({ id: "first" });
  await box.drain(async () => ({ ok: false, stallReason: "backend_unreachable" }));
  await box.reportHealth(health);
  expect(health.readPending()).toEqual([]);
  s.advance(60_000);
  await box.drain(async () => ({ ok: true, rejected: [] }));
  s.advance(3_600_000);
  box.enqueue({ id: "new" });
  await box.reportHealth(health);
  expect(health.readPending()).toEqual([]);
});

// regression: #0012
test("hourly stalls count each binding's overdue rows and retain its delivery login", async () => {
  const s = store(); const box = s.open(); const health = s.open<ClientEvent>("health");
  box.enqueue({ id: "old-login" });
  s.advance(10_000);
  const otherWriter = s.open();
  otherWriter.enqueue({ id: "old-login-other-writer" });
  const current = { backend: "http://localhost:2", keyId: "current" };
  s.login(current); box.prepare();
  box.enqueue({ id: "current-login" });
  s.advance(65_000);
  await box.reportHealth(health, "server_error");
  expect(health.readPending()).toHaveLength(2);
  const delivered: { event: ClientEvent; login: typeof binding }[] = [];
  const send = async (events: readonly ClientEvent[], login: typeof binding) => {
    delivered.push(...events.map(event => ({ event, login })));
    return { ok: true as const, rejected: [] };
  };
  await health.drain(send);
  expect(delivered).toEqual([{ login: current, event: expect.objectContaining({
    type: "queue_stalled", queue: "audit", count: 1, oldest_pending_seconds: 65, reason_code: "server_error",
  }) }]);
  expect(health.status()).toMatchObject({ pending: 1, undeliverable: 1 });
  s.login(binding);
  await health.drain(send);
  expect(delivered[1]).toEqual({ login: binding, event: expect.objectContaining({
    type: "queue_stalled", queue: "audit", count: 2, oldest_pending_seconds: 75, reason_code: "undeliverable_login",
  }) });
  await box.reportHealth(health, "server_error");
  const before = box.diagnostics();
  for (let n = 0; n < 3; n++) await box.reportHealth(health, "server_error");
  expect(box.diagnostics()).toEqual(before);
  expect(health.readPending()).toEqual([]);
});

for (const deferredBy of ["Retry-After", "retry deadline"] as const) {
  // regression: #0012
  test(`stall reporting waits for the persisted ${deferredBy}, including its exact boundary`, async () => {
    const s = store();
    const extra = deferredBy === "retry deadline" ? { timing: { baseMs: 7_200_000, maxMs: 7_200_000, lockTtlMs: 60_000 } } : {};
    let box = s.open("audit", extra);
    const health = s.open<ClientEvent>("health");
    box.enqueue({ id: "deferred" });
    await box.drain(async () => ({ ok: false, stallReason: "server_error", ...(deferredBy === "Retry-After" ? { retryAfterMs: 3_600_000 } : {}) }));
    expect(box.readPending()[0]!.nextAttemptAt).toBe(3_601_000);
    await box.persist();
    box = s.open("audit", { preopen: false, ...extra });
    s.advance(65_000);
    await box.reportHealth(health);
    expect(health.readPending()).toEqual([]);
    s.advance(3_534_999);
    await box.reportHealth(health);
    expect(health.readPending()).toEqual([]);
    s.advance(1);
    await box.reportHealth(health);
    expect(health.readPending().map(entry => entry.row)).toEqual([expect.objectContaining({
      type: "queue_stalled", count: 1, oldest_pending_seconds: 3600, reason_code: "server_error",
    })]);
  });
}

// regression: #0012
test("stall depth and oldest age exclude deferred rows and recent captures within a binding", async () => {
  const s = store(); const box = s.open(); const health = s.open<ClientEvent>("health");
  box.enqueue({ id: "deferred-oldest" });
  await box.drain(async () => ({ ok: false, stallReason: "rate_limited", retryAfterMs: 3_600_000 }));
  s.advance(10_000);
  const otherWriter = s.open();
  otherWriter.enqueue({ id: "overdue" });
  s.advance(65_000);
  otherWriter.enqueue({ id: "recent" });
  await box.reportHealth(health, "rate_limited");
  expect(health.readPending().map(entry => entry.row)).toEqual([expect.objectContaining({
    type: "queue_stalled", count: 1, oldest_pending_seconds: 65, reason_code: "rate_limited",
  })]);
});

// regression: #0012
test("each binding keeps its own hourly stall bookmark across restart", async () => {
  const s = store(); let box = s.open(); const health = s.open<ClientEvent>("health");
  box.enqueue({ id: "original" });
  s.advance(65_000);
  await box.reportHealth(health, "server_error");
  const current = { ...binding, keyId: "current" };
  s.login(current); box.prepare();
  box.enqueue({ id: "current" });
  s.advance(65_000);
  await box.reportHealth(health, "server_error");
  expect(health.readPending()).toHaveLength(2);
  await box.persist();
  box = s.open("audit", { preopen: false });
  await box.reportHealth(health, "server_error");
  expect(health.readPending()).toHaveLength(2);
  s.advance(3_535_000);
  await box.reportHealth(health, "server_error");
  expect(health.readPending()).toHaveLength(3);
  s.advance(65_000);
  await box.reportHealth(health, "server_error");
  expect(health.readPending()).toHaveLength(4);
});

// regression: #0012
test("404 probes use persisted exponential backoff from minutes to an hour", async () => {
  const s = store(); let box = s.open<ClientEvent>("health");
  box.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID()));
  let sends = 0;
  const unavailable = async () => { sends++; return { ok: false as const, endpointStatus: 404 }; };
  for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000]) {
    const before = sends;
    await box.drain(unavailable);
    expect(sends).toBe(before + 1);
    await box.persist(); box = s.open<ClientEvent>("health");
    s.advance(delay - 1);
    await box.drain(unavailable); expect(sends).toBe(before + 1);
    s.advance(1);
  }
  await box.drain(async () => { sends++; return { ok: true, endpointStatus: 200, rejected: [] }; });
  expect(box.status()).toMatchObject({ pending: 0, paused: false });
});

// regression: #0012
test("an older login's endpoint pause does not mark the current login paused", async () => {
  const s = store(); const health = s.open<ClientEvent>("health");
  health.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID()));
  await health.drain(async () => ({ ok: false, endpointStatus: 404 }));
  s.login({ ...binding, keyId: "current" }); health.prepare();
  health.enqueue(clientEvent("plan_request_failed", "health", 1, "network", 1000, crypto.randomUUID()));
  await health.drain(async () => ({ ok: true, endpointStatus: 200, rejected: [] }));
  expect(health.status()).toMatchObject({ pending: 1, undeliverable: 1, paused: false });
});

// regression: #0012
test("org_required holds stay visible across restart without pausing authentication or spending attempts", async () => {
  const s = store(); let box = s.open<ClientEvent>("health");
  box.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID()));
  await box.drain(async events => parseClientEventsReply(403, { error: "org_required" }, new Headers(), events));
  await box.persist(); box = s.open<ClientEvent>("health");
  expect(box.status()).toMatchObject({ pending: 1, undeliverable: 1, holds: ["org_required"] });
  expect(box.readPending()[0]!.attempts).toBe(0);
  await box.authenticationSucceeded(binding);
  let sends = 0;
  await box.drain(async () => { sends++; return { ok: true, rejected: [] }; });
  expect(sends).toBe(0);
});

// regression: #0013
test("checkpoint sequence wins when file mtimes go backwards", async () => {
  const s = store(); const first = s.open();
  first.checkpoint({ id: "run", sequence: 1, value: { counter: 1 } }, binding);
  await first.persist();
  const root = join(s.dir, "outbox", "audit-v2");
  const older = readdirSync(root).find(f => f.endsWith(".jsonl"))!;
  const second = s.open();
  second.checkpoint({ id: "run", sequence: 2, value: { counter: 2 } }, binding);
  utimesSync(join(root, older), new Date(2_000_000), new Date(2_000_000));
  const newer = readdirSync(root).find(f => f.endsWith(".jsonl") && f !== older)!;
  utimesSync(join(root, newer), new Date(1_000_000), new Date(1_000_000));
  expect(second.readCheckpoints()).toEqual([{ id: "run", sequence: 2, value: { counter: 2 } }]);
});

// regression: #0012
test("dead journals remain live until health transfer is durably acknowledged", async () => {
  const s = store(); const source = s.open();
  source.enqueue({ id: "refused" });
  await source.drain(async rows => ({ ok: true, rejected: rows.map(item => ({ item, error: "refused", permanent: true })) }));
  await source.persist();
  const reader = s.open();
  await reader.drain(async () => ({ ok: true, rejected: [] }));
  const root = join(s.dir, "outbox", "audit-v2");
  expect(readdirSync(join(root, "archive"))).toEqual([]);
  const health = s.open<ClientEvent>("health");
  await reader.reportHealth(health);
  await reader.drain(async () => ({ ok: true, rejected: [] }));
  expect(readdirSync(join(root, "archive"))).toHaveLength(1);
  expect(health.readPending()).toHaveLength(1);
});

// regression: #0012
test("a failed hourly bookmark is repaired before its source journal can be archived", async () => {
  const s = store(); let source = s.open(); const health = s.open<ClientEvent>("health");
  source.enqueue({ id: "first" });
  s.advance(65_000);
  await source.drain(async () => ({ ok: false, stallReason: "server_error" }));
  s.advance(2500);
  const bookmark = join(s.dir, "outbox", "audit-v2", "health-state.json");
  mkdirSync(bookmark);
  await expect(source.reportHealth(health)).rejects.toThrow();
  rmSync(bookmark, { recursive: true });
  await source.reportHealth(health);
  s.advance(65_000);
  await source.drain(async () => ({ ok: true, rejected: [] }));
  await source.persist();
  source = s.open();
  await source.drain(async () => ({ ok: true, rejected: [] }));
  source.enqueue({ id: "later" });
  s.advance(65_000);
  await source.drain(async () => ({ ok: false, stallReason: "server_error" }));
  await source.reportHealth(health);
  expect(health.readPending()).toHaveLength(1);
});

// regression: #0013
test("concurrent recovery closes an orphan once using its last checkpoint time", async () => {
  const s = store(); const auth = login(binding.backend);
  const original = createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, clock: s.clock });
  await original.ready;
  original.begin("orphan", "s", 1000, true);
  s.advance(1000); original.attempt("orphan", "call", "bash", true);
  await original.stop();
  s.advance(100_000);
  const first = createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, clock: s.clock });
  const second = createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, clock: s.clock });
  cleanup.push(async () => { await first.stop(); await second.stop(); });
  await Promise.all([first.ready, second.ready]);
  const finals = first.outbox.readPending().filter(entry => entry.row.report_seq === 2);
  expect(finals).toHaveLength(1);
  expect(finals[0]!.row).toMatchObject({ ended_at: new Date(2000).toISOString(), end_reason: "recovered", tool_calls: 1 });
});

// regression: #0013
test("a malformed run checkpoint is retained and counted while valid orphans recover", async () => {
  const s = store(); const auth = login(binding.backend);
  const outbox = s.open("runs");
  outbox.checkpoint({ id: "bad", sequence: 1, value: { runId: "bad", sessionId: "s", version: 1, owner: {} } }, binding);
  await outbox.persist();
  const runs = createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, clock: s.clock });
  cleanup.push(() => runs.stop());
  await runs.ready;
  expect(runs.status().captureFailures).toBeGreaterThan(0);
  runs.begin("good", "s", 1000, true); runs.end("good", "stop", 1100);
  expect(runs.outbox.readPending().at(-1)!.row).toMatchObject({ run_id: "good", end_reason: "stop" });
  expect(outbox.readCheckpoints().some(c => c.id === "bad")).toBe(true);
});

// regression: #0013
test("recovery keeps every parallel attempt when an older gated call commits last", async () => {
  const s = store(); const auth = login(binding.backend);
  const open = () => createRunsPump({ dataDir: s.dir, login: () => auth, log: s.log.log, enabled: true, clock: s.clock,
    post: async () => ({ ok: false, deferred: true }) });
  const original = open();
  cleanup.push(() => original.stop());
  await original.ready;
  original.begin("parallel", "s", 1000, true);
  // The gated call waits on posture while the read call can commit immediately.
  const gated = original.attempt("parallel", "a", "bash", true, { persist: false });
  const read = original.attempt("parallel", "b", "read", true, { persist: false });
  original.commit(read);
  original.commit(gated, undefined, true);
  await original.stop();
  const recovered = open();
  cleanup.push(() => recovered.stop());
  await recovered.ready;
  expect(recovered.outbox.readPending().find(p => p.row.report_seq === 2)?.row).toMatchObject({
    tool_calls: 2, gated_tool_calls: 1, end_reason: "recovered", no_plan_reason: "backend_unreachable",
  });
});

for (const name of ["health", "runs"] as const) {
  // regression: #0012
  test(`${name} org_required probes back off across restart, retain every row and lift only on delivery`, async () => {
    const s = store(); let box = s.open(name);
    const health = s.open<ClientEvent>("health");
    box.enqueue({ id: "first" });
    let sends = 0;
    const refused = async () => { sends++; return { ok: false as const, hold: "org_required" }; };
    for (const [index, delay] of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000].entries()) {
      const before = sends;
      await box.drain(refused);
      expect(sends).toBe(before + 1);
      box.enqueue({ id: `later-${index}` });
      expect(box.status()).toMatchObject({ pending: index + 2, undeliverable: index + 2, holds: ["org_required"], paused: false });
      expect(box.readPending().every(entry => entry.attempts === 0)).toBe(true);
      await box.persist(); box = s.open(name);
      await box.authenticationSucceeded(binding);
      s.advance(delay - 1);
      await box.drain(refused);
      expect(sends).toBe(before + 1);
      await box.reportHealth(health);
      expect(health.readPending().filter(p => p.row.type === "queue_stalled")).toEqual([]);
      s.advance(1);
    }
    // A lost reply must keep the visible hold and postpone the next probe too.
    await box.drain(async () => { sends++; return { ok: false, reason: "timeout" }; });
    expect(box.status().holds).toEqual(["org_required"]);
    s.advance(3_599_999);
    const before = sends;
    await box.drain(refused); expect(sends).toBe(before);
    s.advance(1);
    const delivered: string[] = [];
    await box.drain(async rows => { delivered.push(...rows.map(row => row.id)); return { ok: true, rejected: [] }; });
    expect(delivered.toSorted()).toEqual(["first", "later-0", "later-1", "later-2", "later-3", "later-4", "later-5"]);
    expect(box.status()).toMatchObject({ pending: 0, holds: [], deadLetters: 0 });
  });
}

// regression: #0012
test("a provisional failure whose send timed out survives a later request success", async () => {
  const s = store(); const auth = login(binding.backend);
  const sent: ClientEvent[] = [];
  const health = createHealthPump({ dataDir: s.dir, login: () => auth, log: s.log.log, clock: s.clock,
    post: async (_auth, events) => { sent.push(...events); return { ok: false, reason: "timeout" }; } });
  cleanup.push(() => health.stop());
  await health.planRequestFailed(auth, "lost-reply", "server_error", 41_000);
  s.advance(41_000);
  await health.kick();
  expect(sent).toHaveLength(1);
  expect(health.outbox.readPending()[0]).toMatchObject({ attempts: 0, retries: 1 });
  await health.planRequestSucceeded(auth, "lost-reply");
  expect(health.outbox.readPending().map(p => p.row)).toEqual(sent);
});

for (const mutation of ["cancel", "update"] as const) {
  // regression: #0012
  test(`scheduled ${mutation} opens only its indexed journal after restart`, async () => {
    const s = store();
    for (let n = 0; n < 8; n++) {
      const writer = s.open<ClientEvent>("health");
      writer.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 40_000, crypto.randomUUID()), { notBefore: 40_000 });
      await writer.persist();
    }
    const root = join(s.dir, "outbox", "health-v2");
    const journals = readdirSync(root).filter(file => /^queue-.*\.jsonl$/.test(file)).map(file => join(root, file)).sort();
    const target = journals.at(-1)!;
    const event: ClientEvent = JSON.parse(readFileSync(target, "utf8").trim().split("\n")[1]!).entry.row;
    const reader = s.open<ClientEvent>("health", { preopen: false });
    // Invalidate replay caches without changing any rows, so every journal read is observable.
    for (const file of journals) fs.appendFileSync(file, "\n");
    const opened = new Set<string>();
    const read = fs.readFileSync;
    const open = fs.openSync;
    const note = (path: fs.PathLike) => { if (journals.includes(String(path))) opened.add(String(path)); };
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: any) => {
      if (typeof path !== "number") note(path);
      return read(path, options);
    }) as typeof fs.readFileSync);
    const openSpy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      note(path);
      return open(path, flags, mode);
    }) as typeof fs.openSync);
    const before = reader.diagnostics();
    try {
      if (mutation === "cancel") await reader.cancelScheduled(event.event_id, binding);
      else expect(await reader.updateScheduled({ ...event, reason_code: "rejected" }, binding)).toBe(true);
    } finally { readSpy.mockRestore(); openSpy.mockRestore(); }
    expect([...opened]).toEqual([target]);
    expect(reader.diagnostics().replays - before.replays).toBe(1);
    const pending = reader.readPending();
    expect(pending).toHaveLength(mutation === "cancel" ? 7 : 8);
    expect(pending.find(entry => entry.id === event.event_id)?.row.reason_code).toBe(mutation === "cancel" ? undefined : "rejected");
    const restarted = s.open<ClientEvent>("health", { preopen: false });
    expect(restarted.readPending()).toEqual(pending);
  });

  // regression: #0012
  test(`a provisional event cannot ${mutation} during a send or after lost settlement and restart`, async () => {
    const s = store(); let failSettlement = true;
    const box = s.open<ClientEvent>("health", { beforeCommit: (point: string) => {
      if (point === "ack" && failSettlement) { failSettlement = false; throw new Error("lost settlement"); }
    } });
    const event = clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID());
    box.enqueue(event, { notBefore: 1000 });
    const mutate = async (target: Outbox<ClientEvent>) => {
      if (mutation === "cancel") await target.cancelScheduled(event.event_id, binding);
      else await target.updateScheduled({ ...event, reason_code: "rejected", occurred_at: new Date(2000).toISOString() }, binding);
    };
    await expect(box.drain(async events => {
      await mutate(box);
      expect(box.readPending().map(p => p.row)).toEqual([event]);
      return { ok: false, reason: "timeout" };
    })).rejects.toThrow("lost settlement");
    await box.persist();
    const restarted = s.open<ClientEvent>("health");
    await mutate(restarted);
    expect(restarted.readPending().map(p => p.row)).toEqual([event]);
    const delivered: ClientEvent[] = [];
    await restarted.drain(async events => { delivered.push(...events); return { ok: true, rejected: [] }; });
    expect(delivered).toEqual([event]);
  });
}

// regression: #0012
test("scheduled event lookup includes both backend and key id when event ids are shared", async () => {
  const s = store(); const box = s.open<ClientEvent>("health");
  const otherBackend = { ...binding, backend: "http://localhost:2" };
  const otherKey = { ...binding, keyId: "other" };
  const event = clientEvent("plan_request_failed", "health", 1, "timeout", 40_000, crypto.randomUUID());
  for (const login of [binding, otherBackend, otherKey]) {
    box.prepare(login);
    box.enqueue(event, { binding: login, notBefore: 40_000 });
  }
  expect(await box.updateScheduled({ ...event, reason_code: "rejected" }, binding)).toBe(true);
  await box.cancelScheduled(event.event_id, otherBackend);
  expect(box.readPending()).toHaveLength(2);
  s.advance(40_000);
  const delivered: { event: ClientEvent; login: typeof binding }[] = [];
  const send = async (events: readonly ClientEvent[], login: typeof binding) => {
    delivered.push(...events.map(event => ({ event, login })));
    return { ok: true as const, rejected: [] };
  };
  await box.drain(send);
  s.login(otherBackend); await box.drain(send);
  s.login(otherKey); await box.drain(send);
  expect(delivered).toEqual([
    { login: binding, event: { ...event, reason_code: "rejected" } },
    { login: otherKey, event },
  ]);
  expect(box.readPending()).toEqual([]);
});

for (const name of ["runs", "health"] as const) {
  const parse = (status: number, body: unknown, rows: readonly any[]) => name === "runs"
    ? parseRunsReply(status, body, new Headers(), rows) : parseClientEventsReply(status, body, new Headers(), rows);
  const row = (id: string) => name === "runs"
    ? { run_id: id, report_seq: 1, session_id: "s", started_at: new Date(1000).toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] }
    : clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID());
  for (const status of [400, 422]) for (const [label, body] of [
    ["object", { error: "invalid" }], ["unreadable", null], ["HTML", "<html>proxy refusal</html>"], ["array", []],
  ] as const) {
    // regression: #0012
    test(`${name} splits a whole ${status} ${label} refusal and keeps the poison row as a dead letter`, async () => {
      const s = store(); const box = s.open(name);
      const poison = row("poison"); const healthy = row("healthy");
      box.enqueue(poison); box.enqueue(healthy);
      const sizes: number[] = [];
      await box.drain(async rows => {
        sizes.push(rows.length);
        if (rows.some(r => (r.run_id ?? r.event_id) === ("run_id" in poison ? poison.run_id : poison.event_id))) return parse(status, body, rows);
        return parse(200, { results: rows.map(r => ({ ...(name === "runs" ? { run_id: r.run_id, report_seq: 1 } : { event_id: r.event_id }), outcome: "accepted" })) }, rows);
      });
      expect(sizes).toEqual([2, 1, 1]);
      expect(box.readPending()).toEqual([]);
      expect(box.readDeadLetters()).toEqual([{ row: poison, attempts: 1, reason: expect.any(String) }]);
    });
  }
  for (const status of [405, 410, 413]) {
    // regression: #0012
    test(`${name} charges ${status} refusals and exhausts them without dropping the row`, async () => {
      const s = store(); const box = s.open(name); const refused = row("refused");
      box.enqueue(refused);
      for (let n = 0; n < 10; n++) {
        await box.drain(async rows => parse(status, {}, rows));
        s.advance(600_001);
      }
      expect(box.readPending()).toEqual([]);
      expect(box.readDeadLetters()).toEqual([{ row: refused, attempts: 10, reason: expect.any(String) }]);
    });
  }
  // regression: #0012
  test(`${name} never splits malformed results or charges transient refusals`, async () => {
    const s = store(); const box = s.open(name);
    box.enqueue(row("a")); box.enqueue(row("b"));
    for (const [status, body] of [[400, { results: null }], [422, { results: [{}] }], [408, {}], [429, {}], [503, {}], [409, { error: "request_in_progress" }]] as const) {
      let sends = 0;
      await box.drain(async rows => { sends++; return parse(status, body, rows); });
      expect(sends).toBe(1);
      expect(box.readPending().map(p => p.attempts)).toEqual([0, 0]);
      s.advance(600_001);
    }
  });
}

// regression: #0012
test("successful sends do not rewrite an unchanged endpoint state", async () => {
  const s = store(); const box = s.open<ClientEvent>("health");
  box.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID()));
  await box.drain(async () => ({ ok: false, endpointStatus: 404 }));
  s.advance(300_000);
  await box.drain(async () => ({ ok: true, endpointStatus: 200, rejected: [] }));
  const file = join(s.dir, "outbox", "health-v2", "endpoint-state.json");
  const before = statSync(file);
  box.enqueue(clientEvent("plan_request_failed", "health", 1, "timeout", 1000, crypto.randomUUID()));
  await box.drain(async () => ({ ok: true, endpointStatus: 200, rejected: [] }));
  expect(statSync(file).ino).toBe(before.ino);
});

// regression: #0012
test("health scanning tolerates a journal archived between directory listing and stat", async () => {
  const s = store(); const box = s.open(); const health = s.open<ClientEvent>("health");
  box.enqueue({ id: "waiting" });
  await box.drain(async () => ({ ok: false, stallReason: "server_error" }));
  s.advance(65_000);
  const root = join(s.dir, "outbox", "audit-v2");
  const file = join(root, "queue-99999999-abcd.jsonl");
  const archived = join(root, "archive", "queue-99999999-abcd.jsonl");
  writeFileSync(file, `${JSON.stringify({ t: "b", login: binding })}\n`);
  const original = fs.statSync;
  let moved = false;
  // Perform the competing drainer's rename at the precise point where the listed file can disappear.
  const stat = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, options?: any) => {
    if (path === file && !moved) { moved = true; fs.renameSync(file, archived); }
    return original(path, options);
  }) as typeof fs.statSync);
  try { await box.reportHealth(health); }
  finally { stat.mockRestore(); }
  expect(moved).toBe(true);
  expect(health.readPending().map(p => p.row)).toEqual([expect.objectContaining({ type: "queue_stalled", count: 1, reason_code: "server_error" })]);
});
