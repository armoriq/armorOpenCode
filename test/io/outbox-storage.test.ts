import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOutbox, type Outbox, type QueueLogin } from "../../src/io/outbox.ts";
import { parseAuditReply } from "../../src/io/backend-audit.ts";
import { auditSendResult } from "../../src/pumps/audit.ts";
import { AUDIT_SIZE_LIMITS, validateSizeLimits } from "../../src/io/audit-size.ts";
import packaged from "../../src/contracts/block-capture-v1.json";
import { memoryLog, row, scratch } from "./helpers/stub.ts";

const binding = { backend: "https://outbox.invalid", keyId: "test-key" };
const boxes: Outbox<any>[] = [];
const dirs: string[] = [];
const directory = () => { const dir = scratch("armor-storage-"); dirs.push(dir); return dir; };
const open = (dir: string, login: () => QueueLogin | null = () => binding) => {
  const box = createOutbox<any>(dir, "audit", memoryLog().log, { login });
  boxes.push(box);
  return box;
};
afterEach(async () => {
  for (const box of boxes.splice(0)) await box.persist();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the sole packaged contract matches the shared v1 contract and invalid size contracts fail explicitly", () => {
  const bytes = readFileSync(join(import.meta.dir, "../../src/contracts/block-capture-v1.json"));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("9a2a0c40ca7c8378a95e63dc18305782ae010d4e731c6fda84c42f2d6849738d");
  expect(packaged).not.toHaveProperty("pendingProducerCodes");
  expect(AUDIT_SIZE_LIMITS).toEqual(packaged.sizeLimits);
  expect(() => validateSizeLimits({ ...AUDIT_SIZE_LIMITS, maxRowBytes: 0 })).toThrow("invalid audit size contract");
});

test("R1: a process killed immediately after append leaves replayable rows", async () => {
  const dir = directory();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/outbox-child.ts"), dir, "killed", "3", "none", "kill-after-append"], { stdout: "ignore", stderr: "inherit" });
  expect(await child.exited).not.toBe(0);
  const box = open(dir);
  expect(box.readPending().map(entry => entry.row.id)).toEqual(["killed-0", "killed-1", "killed-2"]);
  const sent: string[] = [];
  await box.drain(async rows => { sent.push(...rows.map(row => row.id)); return { ok: true, rejected: [] }; });
  expect(sent).toEqual(["killed-0", "killed-1", "killed-2"]);
});

test("R3: real processes contend on queue locks without duplicate deliveries", async () => {
  const dir = directory();
  const file = join(dir, "deliveries.jsonl");
  const child = (prefix: string, count: number, backend: string) => Bun.spawn([process.execPath, join(import.meta.dir, "helpers/outbox-child.ts"), dir, prefix, String(count), backend], { stdout: "ignore", stderr: "inherit" });
  expect(await child("orphan", 5, "none").exited).toBe(0);
  const a = child("a", 7, `file:${file}`);
  const b = child("b", 7, `file:${file}`);
  expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
  const sent = readFileSync(file, "utf8").trim().split("\n").flatMap(line => JSON.parse(line));
  const expected = [ ...Array.from({ length: 5 }, (_, i) => `orphan-${i}`), ...Array.from({ length: 7 }, (_, i) => `a-${i}`), ...Array.from({ length: 7 }, (_, i) => `b-${i}`) ];
  expect(sent.sort()).toEqual(expected.sort());
  expect(new Set(sent).size).toBe(19);
});

test("R5: a real dead letter file failure leaves pending and counts a later commit once", async () => {
  const dir = directory();
  const box = open(dir);
  box.enqueue({ client_row_id: "one-action", input: {} });
  const root = join(dir, "outbox", "audit-v2");
  const file = readdirSync(root).find(name => /^queue-\d+-/.test(name))!;
  const blocked = join(root, "dead", file);
  mkdirSync(blocked);
  const refuse = async (rows: readonly any[]) => ({ ok: true as const, rejected: [{ item: rows[0], error: "invalid row", permanent: true }] });
  await expect(box.drain(refuse)).rejects.toThrow();
  expect(open(dir).readPending()).toHaveLength(1);
  expect(box.status().deadLetters).toBe(0);
  rmSync(blocked, { recursive: true });
  await box.drain(refuse);
  expect(open(dir).status()).toMatchObject({ pending: 0, deadLetters: 1 });
  expect(statSync(blocked).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
});

test("R2: a hold then deny of one action captures once and retains the decision id", async () => {
  const box = open(directory());
  box.enqueue({ client_row_id: "one-action", status: "held", decision_code: "approval_required" });
  box.enqueue({ client_row_id: "one-action", status: "blocked", decision_code: "policy_deny" });
  expect(box.readPending()).toHaveLength(1);
  expect(box.readPending()[0]!.row.client_row_id).toBe("one-action");
});


function legacyFile(dir: string, tools = ["old"]) {
  const root = join(dir, "outbox", "audit");
  mkdirSync(root, { recursive: true });
  const file = join(root, "1-aabbcc.jsonl");
  writeFileSync(file, tools.map((tool, index) => JSON.stringify({ t: "a", id: `legacy-${index}`, n: 0, v: row(tool, { client_row_id: undefined }) })).join("\n") + "\n", { mode: 0o600 });
  return file;
}

test("R15: a released queue keeps its exact bytes and is only counted under an identified login", async () => {
  const dir = directory();
  const file = legacyFile(dir);
  const original = readFileSync(file);
  const box = open(dir);
  await box.drain(async () => { throw new Error("an unbound released row reached delivery"); });
  expect(box.status()).toMatchObject({ pending: 1, undeliverable: 1, legacyPending: 1 });
  expect(readFileSync(file)).toEqual(original);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("R15: a released queue is never adopted when a login appears", async () => {
  const dir = directory();
  const file = legacyFile(dir);
  const original = readFileSync(file);
  let current: QueueLogin | null = null;
  const box = open(dir, () => current);
  expect(box.status()).toMatchObject({ legacyPending: 1, undeliverable: 1 });
  current = binding;
  box.prepare();
  let sends = 0;
  await box.drain(async () => { sends++; return { ok: true, rejected: [] }; });
  expect(sends).toBe(0);
  expect(readFileSync(file)).toEqual(original);
  expect(box.status()).toMatchObject({ legacyPending: 1, undeliverable: 1 });
});

test("R15: credential and backend changes cannot bind a released queue", async () => {
  const dir = directory();
  const file = legacyFile(dir);
  const original = readFileSync(file);
  let current = binding;
  const box = open(dir, () => current);
  for (const login of [binding, { ...binding, keyId: "later-key" }, { ...binding, backend: "https://another.invalid" }, binding]) {
    current = login;
    box.prepare();
    await box.restoreLogin(login);
    await box.drain(async () => { throw new Error("released rows must never be sent"); });
    expect(box.status()).toMatchObject({ legacyPending: 1, undeliverable: 1 });
  }
  expect(readFileSync(file)).toEqual(original);
});

test("R15: restart never assigns ids or adds records to a released queue", async () => {
  const dir = directory();
  const file = legacyFile(dir);
  const original = readFileSync(file);
  await open(dir).persist();
  const restarted = open(dir);
  expect(restarted.readPending()).toEqual([]);
  expect(restarted.status().legacyPending).toBe(1);
  expect(readFileSync(file)).toEqual(original);
});

test("R7: current rows settle by persisted UUID without adopting released rows", async () => {
  const dir = directory();
  const old = legacyFile(dir);
  const original = readFileSync(old);
  const box = open(dir);
  for (const tool of ["accepted", "duplicate", "retryable", "rejected"]) box.enqueue(row(tool));
  await box.drain(async rows => auditSendResult(rows, parseAuditReply(200, { results: rows.toReversed().map(row => ({ client_row_id: row.client_row_id, outcome: row.tool })) }, new Headers(), rows)));
  expect(box.readPending().map(entry => [entry.row.tool, entry.attempts])).toEqual([["retryable", 0]]);
  expect(box.readDeadLetters().map(letter => [letter.row.tool, letter.attempts])).toEqual([["rejected", 1]]);
  expect(box.status()).toMatchObject({ pending: 2, undeliverable: 1, deadLetters: 1, legacyPending: 1 });
  expect(readFileSync(old)).toEqual(original);
});

test("R15: released dead letters keep their bytes and remain counted beside new dead letters", async () => {
  const dir = directory();
  const file = legacyFile(dir);
  const oldDead = join(dir, "outbox", "audit", "dead");
  mkdirSync(oldDead);
  const oldLetter = join(oldDead, file.slice(file.lastIndexOf("/") + 1));
  writeFileSync(oldLetter, JSON.stringify({ item: row("old-dead"), error: "refused", attempts: 1 }) + "\n");
  const original = readFileSync(oldLetter);
  const box = open(dir);
  box.enqueue(row("new-dead"));
  await box.drain(async rows => ({ ok: true, rejected: rows.map(item => ({ item, error: "refused", permanent: true })) }));
  expect(box.status()).toMatchObject({ deadLetters: 2, legacyPending: 1 });
  expect(readFileSync(oldLetter)).toEqual(original);
});
