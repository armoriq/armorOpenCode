import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createAuditPump, type AuditPump } from "../../src/pumps/audit.ts";
import { parseAuditReply } from "../../src/io/backend-audit.ts";
import { createBackendPosture } from "../../src/state/backend-posture.ts";
import { handleArmorCommand } from "../../src/commands/armor.ts";
import { fakeRuntime } from "../support/intent-harness.ts";
import { login, row, scratch, memoryLog, until } from "../io/helpers/stub.ts";

const pumps: AuditPump[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const p of pumps.splice(0)) await p.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// regression: #0010
test("R9: an authenticated call lifts its own pause while a successful health check does not", async () => {
  const dir = scratch("armor-posture-auth-"); dirs.push(dir);
  const current = login("https://posture-auth.invalid");
  let sends = 0;
  const pump = createAuditPump({ dataDir: dir, login: () => current, log: memoryLog().log,
    post: async (_, rows) => ++sends === 1 ? { ok: false, retryable: false, unauthorized: true, status: 401, reason: "refused" } : { ok: true, value: { written: rows.length, failures: [] } },
  }); pumps.push(pump);
  pump.enqueue(row("paused"));
  await pump.kick();
  const recoveries: Promise<void>[] = [];
  const posture = createBackendPosture({ probe: async () => ({ ok: true, value: undefined }), log: memoryLog().log, onUnauthorized() {}, onRecovered() {},
    onAuthenticated: used => { recoveries.push(pump.authenticationSucceeded(used)); },
  });
  await posture.check(current);
  await pump.kick();
  expect(sends).toBe(1);
  posture.report({ ok: true, value: undefined }, { ...current, apiKey: "another-key" });
  await Promise.all(recoveries);
  expect(pump.status().undeliverable).toBe(1);
  posture.report({ ok: true, value: undefined }, current);
  await Promise.all(recoveries);
  await pump.kick();
  expect(sends).toBe(2);
  expect(pump.status().pending).toBe(0);
});

// regression: #0010
test("R9: the pump probes a refused saved credential and resumes its original queue", async () => {
  const dir = scratch("armor-auth-probe-"); dirs.push(dir);
  const original = login("https://auth-probe.invalid");
  let current: typeof original | null = original;
  let now = 0;
  let calls = 0;
  const sent: number[] = [];
  const pump = createAuditPump({ dataDir: dir, login: () => current, probeLogin: () => original,
    authenticationSucceeded: (restored: typeof original) => { expect(restored).toBe(original); current = original; },
    clock: { now: () => now, random: () => 0 }, timing: { authProbeMs: 120_000 }, log: memoryLog().log,
    report: (result: any) => { if (!result.ok && result.unauthorized) current = null; },
    post: async (_: any, rows: any[]) => {
      sent.push(rows.length);
      if (++calls === 1) return { ok: false, unauthorized: true, retryable: false, status: 401, reason: "refused" };
      return { ok: true, value: { written: rows.length, failures: [] } };
    },
  } as any); pumps.push(pump);
  pump.enqueue(row("paused"));
  await pump.kick();
  expect(pump.status().undeliverable).toBe(1);
  now = 119_999;
  await pump.kick();
  expect(sent).toEqual([1]);
  now++;
  await pump.kick();
  expect(sent).toEqual([1, 0, 1]);
  expect(pump.status()).toMatchObject({ pending: 0, undeliverable: 0 });
});

test("R6: a new key sends its own rows while the previous login stays undeliverable in local status", async () => {
  const dir = scratch("armor-bound-pump-"); dirs.push(dir);
  const a = login("https://bound.invalid", "test-key-a");
  const b = login(a.backend, "test-key-b");
  let current = a;
  const sent: { key: string; tools: string[] }[] = [];
  const pump = createAuditPump({ dataDir: dir, login: () => current, log: memoryLog().log, post: async (used, rows) => {
    sent.push({ key: used.apiKey, tools: rows.map(row => row.tool) });
    return { ok: true, value: { written: rows.length, failures: [] } };
  } }); pumps.push(pump);
  pump.enqueue(row("old"));
  current = b;
  pump.loginChanged();
  pump.enqueue(row("new"));
  pump.kick();
  await until(() => sent.length === 1 && pump.status().pending === 1);
  expect(sent).toEqual([{ key: b.apiKey, tools: ["new"] }]);
  const rt = await fakeRuntime(b); Object.assign(rt, { audit: pump });
  expect(handleArmorCommand("/armor status", "none", rt)).toContain("1 undeliverable, 0 dead letters, 0 capture failures");
  current = a;
  pump.loginChanged();
  await until(() => pump.status().pending === 0);
  expect(sent[1]).toEqual({ key: a.apiKey, tools: ["old"] });
});

test("R9: a restarted pump does not resume an auth pause until explicit credential restoration", async () => {
  const dir = scratch("armor-paused-pump-"); dirs.push(dir);
  const current = login("https://pause.invalid");
  let sends = 0;
  const first = createAuditPump({ dataDir: dir, login: () => current, log: memoryLog().log, post: async () => { sends++; return { ok: false, retryable: false, unauthorized: true, status: 401, reason: "refused" }; } }); pumps.push(first);
  first.enqueue(row("old")); first.kick();
  await until(() => first.status().undeliverable === 1);
  await first.stop();
  const second = createAuditPump({ dataDir: dir, login: () => current, log: memoryLog().log, post: async (_, rows) => { sends++; return { ok: true, value: { written: rows.length, failures: [] } }; } }); pumps.push(second);
  second.loginChanged(false);
  await Bun.sleep(80);
  expect(sends).toBe(1);
  expect(second.status().undeliverable).toBe(1);
  second.loginChanged(true);
  await until(() => second.status().pending === 0);
  expect(sends).toBe(2);
});

test("R7: batch_oversize is a per row retry and repeated legacy failure indices acknowledge nothing", () => {
  const rows = [row("one"), row("two")];
  const retry = parseAuditReply(200, { results: rows.map(row => ({ client_row_id: row.client_row_id, outcome: "retryable", error: "batch_oversize" })) }, new Headers(), rows);
  expect(retry.ok && retry.value.results?.map(result => result.error)).toEqual(["batch_oversize", "batch_oversize"]);
  expect(parseAuditReply(200, { failures: [{ index: 0, error: "bad" }, { index: 0, error: "bad" }] }, new Headers(), rows).ok).toBe(false);
});
