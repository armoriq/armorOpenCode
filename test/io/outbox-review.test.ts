import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOutbox, type Outbox } from "../../src/io/outbox.ts";
import { parseAuditReply } from "../../src/io/backend-audit.ts";
import { auditSendResult } from "../../src/pumps/audit.ts";
import { memoryLog, scratch } from "./helpers/stub.ts";

const binding = { backend: "https://outbox.invalid", keyId: "test-key" };
const dirs: string[] = [];
const boxes: Outbox<any>[] = [];
const directory = () => { const dir = scratch("armor-review-"); dirs.push(dir); return dir; };
const root = (dir: string) => join(dir, "outbox", "audit-v2");
const open = (dir: string, extra: object = {}) => {
  const box = createOutbox<any>(dir, "audit", memoryLog().log, { login: () => binding, ...extra });
  boxes.push(box);
  return box;
};
const queueFile = (dir: string) => join(root(dir), readdirSync(root(dir)).find(name => name.startsWith("queue-") && name.endsWith(".jsonl"))!);
afterEach(async () => {
  for (const box of boxes.splice(0)) await box.persist().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// regression: #0010
test("R15: actual released writers and this version deliver only their own rows and never touch each other's files", async () => {
  const dir = directory();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/released-outbox-child.ts"), dir], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  const oldRoot = join(dir, "outbox", "audit");
  const releasedFile = join(oldRoot, readdirSync(oldRoot).find(name => name.endsWith(".jsonl"))!);
  const before = readFileSync(releasedFile);
  const box = open(dir);
  box.enqueue({ client_row_id: "current-1", tool: "current" });
  const sent: string[] = [];
  await box.drain(async rows => { sent.push(...rows.map(row => row.tool)); return { ok: true, rejected: [] }; });
  expect(sent).toEqual(["current"]);
  expect(readFileSync(releasedFile)).toEqual(before);
  expect(box.status()).toMatchObject({ legacyPending: 1, undeliverable: 1 });
  expect(readdirSync(oldRoot).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
  writeFileSync(join(dir, "continue"), "go");
  expect(await child.exited).toBe(0);
  const oldSent = readFileSync(join(dir, "released-deliveries.jsonl"), "utf8").trim().split("\n").flatMap(line => JSON.parse(line));
  expect(oldSent).toEqual(["released-before", "released-after"]);
  expect(box.status()).toMatchObject({ legacyPending: 0, pending: 0 });
  const restarted = open(dir, { login: () => ({ ...binding, keyId: "other-key" }) });
  await restarted.drain(async () => { throw new Error("settled rows must not resend"); });
  expect(restarted.readPending()).toEqual([]);
});

// regression: #0010
test("a torn tail and a bad middle line preserve good rows and durable corruption counts across restart", async () => {
  const dir = directory();
  const box = open(dir);
  box.enqueue({ id: "first" });
  appendFileSync(queueFile(dir), "not JSON\n");
  box.enqueue({ id: "last" });
  await box.persist();
  appendFileSync(queueFile(dir), '{"t":"a","entry":');
  const restarted = open(dir);
  expect(restarted.readPending().map(entry => entry.row.id)).toEqual(["first", "last"]);
  expect(restarted.status()).toMatchObject({ corruptRecords: 2 });
  const sent: string[] = [];
  await restarted.drain(async rows => { sent.push(...rows.map(row => row.id)); return { ok: true, rejected: [] }; });
  expect(sent).toEqual(["first", "last"]);
  expect(open(dir).readPending()).toEqual([]);
  expect(open(dir).status()).toMatchObject({ corruptRecords: 2 });
  const quarantine = readdirSync(join(root(dir), "corrupt"));
  expect(quarantine).toHaveLength(2);
  expect(quarantine.map(file => readFileSync(join(root(dir), "corrupt", file), "utf8")).join("\n")).toContain("not JSON");
});

// regression: #0010
test("a partial failed append rotates the writer before the next capture", async () => {
  const dir = directory();
  let tear = false;
  const box = open(dir, { beforeCommit(point: string) {
    if (point !== "append" || !tear) return;
    tear = false;
    appendFileSync(queueFile(dir), '{"t":"a"');
    throw new Error("injected short write");
  } });
  box.enqueue({ id: "before" });
  tear = true;
  expect(() => box.enqueue({ id: "failed" })).toThrow("injected short write");
  box.enqueue({ id: "after" });
  expect(box.readPending().map(entry => entry.row.id).sort()).toEqual(["after", "before"]);
  expect(box.status()).toMatchObject({ captureFailures: 1, corruptRecords: 1 });
});

// regression: #0010
test("proxy 403 and unreadable legacy 400 replies stay transient while backend auth refuses pause", () => {
  const rows = [{ client_row_id: "id", tool: "bash" }] as any;
  for (const status of [400, 403, 422]) {
    const result = parseAuditReply(status, "<html>proxy refusal</html>", new Headers(), rows);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.relogin).not.toBe(true);
      expect(result.legacyRefusal).not.toBe(true);
      expect((auditSendResult(rows, result) as any).nonTransient).not.toBe(true);
    }
  }
  expect(parseAuditReply(403, { error: "relogin_required" }, new Headers(), rows)).toMatchObject({ ok: false, relogin: true });
  for (const status of [400, 422]) for (const body of [{}, { error: "proxy refused" }]) {
    const result = parseAuditReply(status, body, new Headers(), rows);
    expect(result.ok === false && result.legacyRefusal).not.toBe(true);
  }
});

// regression: #0010
test("capture failures use a small durable counter and a torn counter never breaks status", async () => {
  const dir = directory();
  const box = open(dir);
  for (let n = 0; n < 20; n++) box.captureFailure();
  const counter = join(root(dir), readdirSync(root(dir)).find(file => file.startsWith("failures-"))!);
  expect(readFileSync(counter).length).toBeLessThan(32);
  expect(open(dir).status().captureFailures).toBe(20);
  writeFileSync(join(root(dir), "failures-damaged.json"), '{"count":');
  expect(open(dir).status()).toMatchObject({ captureFailures: 20, corruptRecords: 1 });
});

// regression: #0010
test("removing the dead letter directory recreates its durable records from the journal", async () => {
  const dir = directory();
  const box = open(dir);
  box.enqueue({ id: "first" });
  const refuse = async (rows: readonly any[]) => ({ ok: true as const, rejected: rows.map(item => ({ item, error: "refused", permanent: true })) });
  await box.drain(refuse);
  rmSync(join(root(dir), "dead"), { recursive: true });
  box.enqueue({ id: "second" });
  await box.drain(refuse);
  const letters = readdirSync(join(root(dir), "dead")).flatMap(file => readFileSync(join(root(dir), "dead", file), "utf8").trim().split("\n").filter(Boolean).map(raw => JSON.parse(raw)));
  expect(letters.map(letter => letter.row.id).sort()).toEqual(["first", "second"]);
  expect(box.status().deadLetters).toBe(2);
});

// regression: #0010
test("settled dead process journals are archived and idle drains do not replay or lease them", async () => {
  const dir = directory();
  mkdirSync(root(dir), { recursive: true });
  for (let n = 0; n < 300; n++) {
    const file = join(root(dir), `queue-99999999-${n.toString(16)}.jsonl`);
    const lines = [{ t: "b", login: binding }];
    for (let i = 0; i < 50; i++) (lines as any[]).push({ t: "a", entry: { id: `${n}:${i}`, row: { id: `${n}:${i}` }, attempts: 0, nextAttemptAt: 0 } });
    (lines as any[]).push({ t: "s", ack: Array.from({ length: 50 }, (_, i) => `${n}:${i}`), retry: [], dead: [] });
    writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  }
  const reader = open(dir);
  await reader.drain(async () => { throw new Error("settled journal sent rows"); });
  expect(readdirSync(join(root(dir), "archive"))).toHaveLength(300);
  const before = (reader as any).diagnostics();
  const started = performance.now();
  for (let n = 0; n < 10; n++) await reader.drain(async () => ({ ok: true, rejected: [] }));
  const elapsed = performance.now() - started;
  const after = (reader as any).diagnostics();
  expect(after.replays - before.replays).toBe(0);
  expect(after.leases - before.leases).toBe(0);
  expect(elapsed).toBeLessThan(100);
  console.info(`Idle drain after 300 archived files: ${(elapsed / 10).toFixed(3)} ms, 0 replays, 0 leases`);
});

// regression: #0010
test("a long drain renews its lease between batches", async () => {
  const dir = directory();
  let now = 0;
  const box = open(dir, { clock: { now: () => now, random: () => 0 }, timing: { baseMs: 1, maxMs: 8, lockTtlMs: 100 } });
  for (let n = 0; n < 5; n++) box.enqueue({ id: String(n) });
  let sends = 0;
  await box.drain(async () => { sends++; now += 60; return { ok: true, rejected: [] }; });
  expect(sends).toBe(1);
  // Use the shared row cap to create multiple requests within one drain.
  for (let n = 0; n < 450; n++) box.enqueue({ id: `later-${n}` });
  await box.drain(async () => { sends++; now += 60; return { ok: true, rejected: [] }; });
  expect(sends).toBe(4);
  expect(box.readPending()).toEqual([]);
});

// regression: #0010
test("the constructor keeps storage failures away from plugin setup and status", async () => {
  const dir = directory();
  writeFileSync(join(dir, "outbox"), "a file blocks storage");
  const box = open(dir);
  expect(box.status()).toMatchObject({ captureFailures: 1 });
  expect(() => box.enqueue({ id: "cannot-store" })).toThrow();
  expect(box.status()).toMatchObject({ captureFailures: 2 });
  expect(existsSync(join(dir, "outbox"))).toBe(true);
});

// regression: #0012
test("concurrent shutdowns share persistence and never close the same descriptor twice", async () => {
  const dir = directory(); const logs = memoryLog();
  const box = createOutbox<any>(dir, "audit", logs.log, { login: () => binding });
  boxes.push(box);
  box.enqueue({ id: "saved" });
  await Promise.all([box.persist(), box.persist()]);
  expect(open(dir).readPending().map(entry => entry.id)).toEqual(["saved"]);
  expect(logs.lines.filter(line => line.level === "error")).toEqual([]);
});
