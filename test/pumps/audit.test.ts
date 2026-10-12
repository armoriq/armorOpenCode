import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditPump, type AuditPump } from "../../src/pumps/audit.ts";
import type { Login } from "../../src/types.ts";
import { accepted, login, memoryLog, row, scratch, stubBackend, until, type Handler } from "../io/helpers/stub.ts";

const FAST = { intervalMs: 20, minBackoffMs: 20, maxBackoffMs: 40 };
let stub: ReturnType<typeof stubBackend> | undefined;
let pump: AuditPump | undefined;
afterEach(async () => {
  await pump?.stop();
  stub?.stop();
  pump = stub = undefined;
});

function setup(handler: Handler, opts: { current?: () => Login | null; timing?: object; dataDir?: string } = {}) {
  stub = stubBackend(handler);
  const backend = login(stub.url);
  const { log, lines } = memoryLog();
  const relogins: string[] = [];
  const dataDir = opts.dataDir ?? scratch();
  pump = createAuditPump({
    dataDir,
    login: opts.current ?? (() => backend),
    log,
    relogin: (reason) => relogins.push(reason),
    timing: opts.timing ?? FAST,
  });
  return { stub, pump, lines, relogins, dataDir };
}

const sentTools = () => stub!.batches.flat().map((r) => r.tool);

describe("audit pump", () => {
  test("kick sends queued rows once", async () => {
    const { pump } = setup(accepted, { timing: { intervalMs: 60_000 } });
    pump.enqueue(row("bash"));
    pump.enqueue(row("read"));
    pump.kick();
    await until(() => stub!.batches.length === 1);
    pump.kick();
    await Bun.sleep(50);
    expect(stub!.batches.map((b) => b.map((r) => r.tool))).toEqual([["bash", "read"]]);
  });

  test("batches carry at most 200 rows", async () => {
    const { pump } = setup(accepted, { timing: { intervalMs: 60_000 } });
    for (let i = 0; i < 450; i++) pump.enqueue(row(`t${i}`));
    pump.kick();
    await until(() => stub!.batches.flat().length === 450);
    expect(stub!.batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  test("an invalid row is dead-lettered after one send while the rest are written", async () => {
    const { pump, dataDir } = setup((rows) =>
      Response.json({ written: rows.length - 1, failures: [{ index: rows.findIndex((r) => r.tool === "bad"), error: "invalid row: input must be an object" }] }),
    );
    pump.enqueue(row("good"));
    pump.enqueue(row("bad"));
    pump.start();
    await Bun.sleep(200);
    expect(sentTools()).toEqual(["good", "bad"]);
    await pump.stop();
    const deadDir = join(dataDir, "outbox", "audit", "dead");
    const dead = readdirSync(deadDir).map((f) => JSON.parse(readFileSync(join(deadDir, f), "utf8")));
    expect(dead.map((d) => [d.item.tool, d.error])).toEqual([["bad", "invalid row: input must be an object"]]);
  });

  test("any other row failure is retried up to 10 attempts in total", async () => {
    const { pump } = setup((rows) => Response.json({ written: 0, failures: rows.map((_, index) => ({ index, error: "row timeout" })) }));
    pump.enqueue(row("slow"));
    pump.start();
    await until(() => stub!.batches.length >= 10);
    await Bun.sleep(150);
    expect(sentTools()).toEqual(Array(10).fill("slow"));
  });

  test("a 2xx without failures is a failed send: the row is kept and resent", async () => {
    let calls = 0;
    const { pump } = setup((rows) => (++calls === 1 ? Response.json({ written: rows.length }) : accepted(rows)));
    pump.enqueue(row("bash"));
    pump.start();
    await until(() => stub!.batches.length === 2);
    await Bun.sleep(100);
    expect(sentTools()).toEqual(["bash", "bash"]);
  });

  for (const status of [400, 422]) {
    test(`a whole-request ${status} keeps every row and retries it, dead-lettering nothing`, async () => {
      let calls = 0;
      const { pump, dataDir } = setup((rows) => (++calls <= 2 ? new Response("bad envelope", { status }) : accepted(rows)));
      for (const tool of ["a", "b", "c"]) pump.enqueue(row(tool));
      pump.start();
      await until(() => stub!.batches.some((b) => b.length === 3) && calls >= 3);
      await pump.stop();
      expect(stub!.batches.map((b) => b.length)).toEqual([3, 3, 3]);
      expect(existsSync(join(dataDir, "outbox", "audit", "dead"))).toBe(false);
    });
  }

  test("a batch too large for the backend is split, and a row too large alone is kept rather than dead-lettered", async () => {
    const { pump, dataDir } = setup((rows) =>
      rows.some((r) => r.tool === "huge") ? new Response("payload too large", { status: 413 }) : accepted(rows),
    );
    for (const tool of ["a", "b", "huge", "c", "d"]) pump.enqueue(row(tool));
    pump.start();
    await until(() => ["a", "b", "c", "d"].every((t) => stub!.batches.some((b) => b.length > 0 && b.every((r) => r.tool !== "huge") && b.some((r) => r.tool === t))));
    await until(() => stub!.batches.filter((b) => b.length === 1 && b[0]!.tool === "huge").length >= 2);
    await pump.stop();
    const written = stub!.batches.filter((b) => b.every((r) => r.tool !== "huge")).flat().map((r) => r.tool);
    expect(written.sort()).toEqual(["a", "b", "c", "d"]);
    expect(existsSync(join(dataDir, "outbox", "audit", "dead"))).toBe(false);
  });

  test("after a split, batches grow back to 200 rows while the queue stays busy", async () => {
    let calls = 0;
    const { pump } = setup((rows) => (++calls === 1 ? new Response("payload too large", { status: 413 }) : accepted(rows)), {
      timing: { intervalMs: 60_000 },
    });
    for (let i = 0; i < 1000; i++) pump.enqueue(row(`t${i}`));
    pump.kick();
    await until(() => stub!.batches.slice(1).flat().length === 1000);
    expect(stub!.batches.map((b) => b.length)).toEqual([200, 100, 200, 200, 200, 200, 100]);
  });

  test("Retry-After is capped at the longest backoff", async () => {
    let calls = 0;
    const { pump } = setup((rows) => (++calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "86400" } }) : accepted(rows)), {
      timing: { intervalMs: 20, minBackoffMs: 20, maxBackoffMs: 100 },
    });
    pump.enqueue(row("bash"));
    pump.start();
    await until(() => stub!.batches.length === 2, 1000);
  });

  test("Retry-After holds the pump back even when kicked", async () => {
    let calls = 0;
    const { pump } = setup((rows) => (++calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "1" } }) : accepted(rows)), {
      timing: { ...FAST, maxBackoffMs: 5000 },
    });
    pump.enqueue(row("bash"));
    pump.start();
    await until(() => stub!.batches.length === 1);
    for (let i = 0; i < 10; i++) {
      pump.kick();
      await Bun.sleep(50);
    }
    expect(stub!.batches.length).toBe(1);
    await until(() => stub!.batches.length === 2, 2000);
  });

  test("relogin_required stops sending until the login changes", async () => {
    let current: Login | null = null;
    const { pump, relogins } = setup(
      (rows, req) =>
        req.headers.get("x-api-key") === "ak_live_old" ? Response.json({ error: "relogin_required" }, { status: 403 }) : accepted(rows),
      { current: () => current },
    );
    current = login(stub!.url, "ak_live_old");
    pump.enqueue(row("bash"));
    pump.start();
    await until(() => stub!.batches.length === 1);
    await Bun.sleep(150);
    expect([stub!.batches.length, relogins]).toEqual([1, ["relogin_required"]]);
    current = login(stub!.url, "ak_live_new");
    await until(() => stub!.batches.length === 2);
    expect(stub!.headers[1]!.get("x-api-key")).toBe("ak_live_new");
  });

  test("only one request is in flight however often the pump is kicked", async () => {
    let inFlight = 0;
    let peak = 0;
    const { pump } = setup(async (rows) => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(40);
      inFlight--;
      return accepted(rows);
    });
    pump.start();
    for (let i = 0; i < 20; i++) {
      pump.enqueue(row(`t${i}`));
      pump.kick();
      await Bun.sleep(5);
    }
    await until(() => stub!.batches.flat().length === 20);
    expect(peak).toBe(1);
  });

  test("logged out, nothing is sent", async () => {
    const { pump } = setup(accepted, { current: () => null });
    pump.enqueue(row("bash"));
    pump.start();
    await Bun.sleep(100);
    expect(stub!.batches).toEqual([]);
  });

  test("stop sends nothing, returns within 200 ms, and leaves rows for the next process", async () => {
    const dataDir = scratch();
    const first = setup(accepted, { timing: { intervalMs: 60_000 }, dataDir });
    for (let i = 0; i < 3; i++) first.pump.enqueue(row(`t${i}`));
    const started = performance.now();
    await first.pump.stop();
    expect(performance.now() - started).toBeLessThan(200);
    expect(stub!.batches).toEqual([]);
    stub!.stop();

    const next = setup(accepted, { timing: { intervalMs: 60_000 }, dataDir });
    next.pump.kick();
    await until(() => stub!.batches.flat().length === 3);
    expect(sentTools()).toEqual(["t0", "t1", "t2"]);
  });
});
