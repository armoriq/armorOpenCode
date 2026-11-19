import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createRunsPump, runReportingEnabled } from "../../src/pumps/runs.ts";
import { parseRunsReply } from "../../src/io/backend-runs.ts";
import { memoryLog, scratch } from "../io/helpers/stub.ts";
import type { Login } from "../../src/types.ts";
import { createOutbox } from "../../src/io/outbox.ts";
import { auditLogin } from "../../src/pumps/audit.ts";
import { RUN_CAPABILITIES } from "../../src/pumps/runs-capabilities.ts";
import contract from "../fixtures/runs-v1.json";

const login: Login = { backend: "http://localhost:1", apiKey: "test-runs", userId: "u", orgId: "o", email: "test@example.com", deviceId: "d", deviceName: "test" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

function setup(enabled = true) {
  const dir = scratch("armor-runs-");
  let current: Login | null = login;
  let now = Date.now();
  const sent: unknown[] = [];
  const pumps: ReturnType<typeof createRunsPump>[] = [];
  const audit = createOutbox<any>(dir, "audit", memoryLog().log, { login: () => auditLogin(current) });
  let status = 200;
  const open = () => {
    const pump = createRunsPump({ dataDir: dir, login: () => current, log: memoryLog().log, enabled, checkpoints: () => audit.readCheckpoints(),
      clock: { now: () => now, random: () => 0 },
      post: async (auth, reports) => {
        sent.push({ auth, reports });
        return parseRunsReply(status, { results: reports.map(r => ({ run_id: r.run_id, report_seq: r.report_seq, outcome: "accepted" })) }, new Headers(), reports);
      },
    });
    pumps.push(pump);
    return pump;
  };
  cleanup.push(async () => { for (const pump of pumps) await pump.stop(); await audit.persist(); rmSync(dir, { recursive: true, force: true }); });
  return { open, sent, audit, dir, login: (auth: Login | null) => { current = auth; }, status: (value: number) => { status = value; }, advance: (ms: number) => { now += ms; } };
}

test("reporting defaults off and queues and sends nothing while disabled", async () => {
  expect(RUN_CAPABILITIES).toEqual(contract.capabilities.armoropencode.rules);
  expect(runReportingEnabled({})).toBe(false);
  expect(runReportingEnabled({ ARMORIQ_RUN_REPORTING_ENABLED: "true" })).toBe(true);
  const store = setup(false);
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  pump.end("r", "stop", Date.now());
  await pump.kick();
  expect(pump.outbox.readPending()).toEqual([]);
  expect(store.sent).toEqual([]);
});

test("prompt start is persisted with report sequence 1 before any turn end", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  expect(pump.outbox.readPending().map(p => p.row)).toEqual([expect.objectContaining({ run_id: "r", report_seq: 1, tool_calls: 0, plan_ids: [] })]);
  expect(pump.outbox.readCheckpoints()).toHaveLength(1);
  await pump.kick();
  expect(store.sent).toHaveLength(1);
});

test("logout pauses delivery and another login cannot send a run", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  store.login(null);
  pump.end("r", "stop", Date.now());
  await pump.kick();
  store.login({ ...login, apiKey: "another-login" });
  await pump.loginChanged();
  expect(store.sent).toEqual([]);
  expect(pump.status().undeliverable).toBe(2);
  store.login(login);
  await pump.loginChanged();
  expect(store.sent).toHaveLength(1);
  store.login(null);
  pump.begin("logged-out", "s", Date.now(), false);
  store.login(login);
  pump.end("logged-out", "stop", Date.now());
  await pump.kick();
  expect(store.sent).toHaveLength(1);
});

test("404 pauses the runs stream on disk without consuming attempts", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  store.status(404);
  await pump.kick();
  expect(pump.status()).toMatchObject({ pending: 1, paused: true });
  expect(pump.outbox.readPending()[0]!.attempts).toBe(0);
  await pump.stop();
  const next = store.open();
  await next.kick();
  expect(store.sent).toHaveLength(1);
  store.status(200);
  store.advance(300_000);
  await next.kick();
  expect(next.status()).toMatchObject({ pending: 0, paused: false });
});

test("a crash recovers counters and atomically closes the run with its final report", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  pump.attempt("r", "call", "bash", true);
  pump.attempt("r", "call", "bash", true);
  await pump.stop();
  const recovered = store.open();
  await recovered.ready;
  expect(recovered.outbox.readPending().map(p => p.row).sort((a, b) => a.report_seq - b.report_seq)).toEqual([
    expect.objectContaining({ run_id: "r", report_seq: 1 }),
    expect.objectContaining({ run_id: "r", report_seq: 2, tool_calls: 1, gated_tool_calls: 1, end_reason: "recovered", no_plan_reason: "not_registered" }),
  ]);
  await recovered.stop();
  const twice = store.open();
  await twice.ready;
  expect(twice.outbox.readPending()).toHaveLength(2);
});

test("final reporting waits for registrations and a late result never changes the next run", async () => {
  const store = setup();
  const pump = store.open();
  const at = Date.now();
  pump.begin("old", "s", at, true);
  const settle = pump.registration("old");
  pump.request("old", "descriptor", "pending");
  pump.end("old", "next_prompt", at + 1);
  pump.begin("new", "s", at + 1, true);
  expect(pump.outbox.readPending()).toHaveLength(2);
  pump.request("old", "descriptor", "confirmed", "11111111-1111-4111-8111-111111111111");
  settle();
  pump.attempt("old", "late", "bash", true);
  pump.end("new", "stop", at + 2);
  const finals = pump.outbox.readPending().map(p => p.row).filter(r => r.report_seq === 2);
  expect(finals).toEqual([
    expect.objectContaining({ run_id: "old", plan_ids: ["11111111-1111-4111-8111-111111111111"], tool_calls: 0 }),
    expect.objectContaining({ run_id: "new", plan_ids: [], tool_calls: 0, no_plan_reason: "no_tool_use" }),
  ]);
  expect(finals[0]!.no_plan_reason).toBeUndefined();
});

test("a blocked audit row persists its counter in the same journal record", async () => {
  const store = setup();
  const pump = store.open();
  pump.begin("r", "s", Date.now(), true);
  const checkpoint = pump.attempt("r", "blocked", "bash", true, { persist: false });
  pump.commit(checkpoint, value => store.audit.enqueue({ client_row_id: "blocked", status: "blocked" }, { checkpoint: value }));
  await pump.stop();
  const recovered = store.open();
  await recovered.ready;
  expect(recovered.outbox.readPending().find(p => p.row.report_seq === 2)?.row).toMatchObject({ tool_calls: 1, gated_tool_calls: 1 });
  await recovered.stop();
  const again = store.open();
  await again.ready;
  expect(again.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(1);
});

test("a killed host retains the open run and counters without a flush", async () => {
  const store = setup();
  const child = Bun.spawn([process.execPath, new URL("../support/runs-child.ts", import.meta.url).pathname, store.dir], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  const recovered = store.open();
  await recovered.ready;
  expect(recovered.outbox.readPending().map(p => p.row).sort((a, b) => a.report_seq - b.report_seq)).toEqual([
    expect.objectContaining({ run_id: "killed", report_seq: 1 }),
    expect.objectContaining({ run_id: "killed", report_seq: 2, tool_calls: 1, end_reason: "recovered" }),
  ]);
});

test("another live runtime does not recover a session that is still running", async () => {
  const store = setup();
  const first = store.open();
  first.begin("live", "s", Date.now(), true);
  const second = store.open();
  await second.ready;
  expect(second.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(0);
  await first.stop();
  const restarted = store.open();
  await restarted.ready;
  expect(restarted.outbox.readPending().filter(p => p.row.report_seq === 2)).toHaveLength(1);
});

// regression: #0013
test("stop returns within its budget while a report is still in flight and later saves its acknowledgement", async () => {
  const dir = scratch("armor-runs-stop-");
  let entered!: () => void; let finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  let completed = false;
  const runs = createRunsPump({ dataDir: dir, login: () => login, log: memoryLog().log, enabled: true, timing: { stopBudgetMs: 1 },
    post: async () => { entered(); await release; completed = true; return { ok: true, endpointStatus: 200, rejected: [] }; } });
  await runs.ready;
  runs.begin("r", "s", Date.now(), true);
  const sending = runs.kick(); await ready;
  await runs.stop();
  expect(completed).toBe(false);
  finish(); await sending; await runs.outbox.persist();
  expect(runs.outbox.readPending()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
