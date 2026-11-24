import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditPump, type AuditPump } from "../../src/pumps/audit.ts";
import { authHeaders, parseAuditReply } from "../../src/io/backend-audit.ts";
import type { AuditRow, Login } from "../../src/types.ts";
import { accepted, login, memoryLog, row, scratch, type Handler } from "../io/helpers/stub.ts";

const FAST = { intervalMs: 60_000, minBackoffMs: 20, maxBackoffMs: 40 };
let stub: { url: string; batches: AuditRow[][]; headers: Headers[] } | undefined;
let pump: AuditPump | undefined;
afterEach(async () => {
  await pump?.stop();
  pump = stub = undefined;
});

function setup(handler: Handler, opts: { current?: () => Login | null; timing?: object; dataDir?: string } = {}) {
  const backendStub = { url: "https://audit.invalid", batches: [] as AuditRow[][], headers: [] as Headers[] };
  stub = backendStub;
  const backend = login(backendStub.url);
  const { log, lines } = memoryLog();
  const relogins: string[] = [];
  const dataDir = opts.dataDir ?? scratch();
  let now = 0;
  const clock = { now: () => now, random: () => 0.5 };
  const post: NonNullable<Parameters<typeof createAuditPump>[0]["post"]> = async (current, rows) => {
    const request = new Request(`${current.backend}/iap/audit/batch`, {
      method: "POST", headers: authHeaders(current.apiKey), body: JSON.stringify({ rows }),
    });
    const body = await request.json() as { rows: AuditRow[] };
    backendStub.batches.push(body.rows);
    backendStub.headers.push(request.headers);
    const response = await handler(body.rows, request);
    let reply: unknown = null;
    try { reply = await response.json(); } catch {}
    return parseAuditReply(response.status, reply, response.headers, rows, clock.now());
  };
  pump = createAuditPump({
    dataDir,
    login: opts.current ?? (() => backend),
    log,
    relogin: (reason) => relogins.push(reason),
    timing: { ...FAST, ...opts.timing },
    clock,
    post,
  });
  return { stub: backendStub, pump, lines, relogins, dataDir, clock, post, advance: (ms: number) => { now += ms; } };
}

const sentTools = () => stub!.batches.flat().map((r) => r.tool);

describe("audit pump", () => {
  test("kick sends queued rows once", async () => {
    const { pump } = setup(accepted, { timing: { intervalMs: 60_000 } });
    pump.enqueue(row("bash"));
    pump.enqueue(row("read"));
    pump.start();
    await pump.kick();
    await pump.kick();
    expect(stub!.batches.map((b) => b.map((r) => r.tool))).toEqual([["bash", "read"]]);
  });

  test("batches carry at most 200 rows", async () => {
    const { pump } = setup(accepted, { timing: { intervalMs: 60_000 } });
    for (let i = 0; i < 450; i++) pump.enqueue(row(`t${i}`));
    await pump.kick();
    expect(stub!.batches.map((b) => b.length)).toEqual([200, 200, 50]);
  });

  test("an invalid row is dead-lettered after one send while the rest are written", async () => {
    const { pump, dataDir } = setup((rows) =>
      Response.json({ written: rows.length - 1, failures: [{ index: rows.findIndex((r) => r.tool === "bad"), error: "invalid row: input must be an object" }] }),
    );
    pump.enqueue(row("good"));
    pump.enqueue(row("bad"));
    await pump.kick();
    await pump.kick();
    expect(sentTools()).toEqual(["good", "bad"]);
    await pump.stop();
    const deadDir = join(dataDir, "outbox", "audit-v2", "dead");
    const dead = readdirSync(deadDir).map((f) => JSON.parse(readFileSync(join(deadDir, f), "utf8")));
    expect(dead.map((d) => [d.row.tool, d.reason])).toEqual([["bad", "invalid row: input must be an object"]]);
  });

  test("transient legacy row failures survive a long outage and eventually deliver", async () => {
    let recovered = false;
    const { pump, advance } = setup((rows) => recovered ? accepted(rows) : Response.json({ written: 0, failures: rows.map((_, index) => ({ index, error: "row timeout" })) }));
    pump.enqueue(row("slow"));
    for (let attempt = 1; attempt <= 40; attempt++) {
      await pump.kick();
      expect(stub!.batches).toHaveLength(attempt);
      advance(86_400_000);
    }
    expect(pump.status()).toMatchObject({ pending: 1, deadLetters: 0 });
    recovered = true;
    await pump.kick();
    expect(stub!.batches).toHaveLength(41);
    expect(pump.status()).toMatchObject({ pending: 0, deadLetters: 0 });
  });

  test("a 2xx without failures is a failed send: the row is kept and resent", async () => {
    let calls = 0;
    const { pump, advance } = setup((rows) => (++calls === 1 ? Response.json({ written: rows.length }) : accepted(rows)));
    pump.enqueue(row("bash"));
    await pump.kick();
    advance(14);
    await pump.kick();
    expect(sentTools()).toEqual(["bash"]);
    advance(1);
    await pump.kick();
    await pump.kick();
    expect(sentTools()).toEqual(["bash", "bash"]);
  });

  for (const status of [400, 422]) {
    test(`a legacy whole-request ${status} isolates a poison row while healthy rows drain`, async () => {
      const { pump, dataDir } = setup((rows) => rows.some(row => row.tool === "bad") ? Response.json({ error: "Bad Request", message: "invalid row", statusCode: status }, { status }) : accepted(rows));
      for (const tool of ["a", "bad", "c"]) pump.enqueue(row(tool));
      await pump.kick();
      await pump.stop();
      expect(stub!.batches.map((b) => b.length)).toEqual([3, 2, 1, 1, 1]);
      expect(pump.status()).toMatchObject({ pending: 0, deadLetters: 1 });
      const dead = readdirSync(join(dataDir, "outbox", "audit-v2", "dead")).flatMap(file => readFileSync(join(dataDir, "outbox", "audit-v2", "dead", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
      expect(dead.map(letter => [letter.row.tool, letter.attempts])).toEqual([["bad", 1]]);
    });
  }

  test("HTTP 413 shrinks subsequent batches and retains healthy rows while a lone refusal exhausts its budget", async () => {
    const delivered: string[] = [];
    const { pump, advance } = setup((rows) => {
      if (rows.some(row => row.tool === "huge")) return new Response("payload too large", { status: 413 });
      delivered.push(...rows.map(row => row.tool));
      return accepted(rows);
    });
    for (const tool of ["a", "b", "huge", "c", "d"]) pump.enqueue(row(tool));
    for (let attempt = 1; attempt <= 12; attempt++) {
      await pump.kick();
      advance(40);
    }
    await pump.stop();
    expect(stub!.batches[0]!).toHaveLength(5);
    expect(stub!.batches[1]!).toHaveLength(2);
    expect(stub!.batches.some(batch => batch.length === 1)).toBe(true);
    expect(delivered.sort()).toEqual(["a", "b", "c", "d"]);
    expect(pump.status()).toMatchObject({ pending: 0, deadLetters: 1 });
  });

  test("after a split, batches grow back to 200 rows while the queue stays busy", async () => {
    let calls = 0;
    const { pump } = setup((rows) => (++calls === 1 ? Response.json({ error: "Bad Request", message: "invalid row", statusCode: 400 }, { status: 400 }) : accepted(rows)), {
      timing: { intervalMs: 60_000 },
    });
    for (let i = 0; i < 1000; i++) pump.enqueue(row(`t${i}`));
    await pump.kick();
    expect(stub!.batches.map((b) => b.length)).toEqual([200, 100, 100, 200, 200, 200, 200]);
  });

  test("Retry-After remains a lower bound beyond the longest local backoff", async () => {
    let calls = 0;
    const { pump, advance } = setup((rows) => (++calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "86400" } }) : accepted(rows)), {
      timing: { minBackoffMs: 20, maxBackoffMs: 100 },
    });
    pump.enqueue(row("bash"));
    await pump.kick();
    advance(86_400_000 - 1);
    await pump.kick();
    expect(stub!.batches).toHaveLength(1);
    advance(1);
    await pump.kick();
    expect(stub!.batches).toHaveLength(2);
  });

  test("Retry-After holds the pump back even when kicked", async () => {
    let calls = 0;
    const { pump, advance } = setup((rows) => (++calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "1" } }) : accepted(rows)), {
      timing: { ...FAST, maxBackoffMs: 5000 },
    });
    pump.enqueue(row("bash"));
    await pump.kick();
    for (let i = 0; i < 10; i++) {
      advance(50);
      await pump.kick();
    }
    expect(stub!.batches.length).toBe(1);
    advance(499);
    await pump.kick();
    expect(stub!.batches).toHaveLength(1);
    advance(1);
    await pump.kick();
    expect(stub!.batches).toHaveLength(2);
  });

  test("relogin_required keeps the old login backlog while a new login drains its own rows", async () => {
    let current: Login | null = null;
    const { pump, relogins, advance } = setup(
      (rows, req) =>
        req.headers.get("x-api-key") === "ak_live_old" ? Response.json({ error: "relogin_required" }, { status: 403 }) : accepted(rows),
      { current: () => current },
    );
    current = login(stub!.url, "ak_live_old");
    await pump.loginChanged();
    pump.enqueue(row("bash"));
    await pump.kick();
    advance(60_000);
    await pump.kick();
    expect([stub!.batches.length, relogins]).toEqual([1, ["relogin_required"]]);
    current = login(stub!.url, "ak_live_new");
    await pump.loginChanged();
    pump.enqueue(row("new-login"));
    await pump.kick();
    expect(stub!.headers[1]!.get("x-api-key")).toBe("ak_live_new");
    expect(stub!.batches[1]!.map(row => row.tool)).toEqual(["new-login"]);
    expect(pump.status().undeliverable).toBe(1);
  });

  test("only one request is in flight however often the pump is kicked", async () => {
    let inFlight = 0;
    let peak = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { pump } = setup(async (rows) => {
      peak = Math.max(peak, ++inFlight);
      entered.resolve();
      await release.promise;
      inFlight--;
      return accepted(rows);
    });
    pump.enqueue(row("t0"));
    const first = pump.kick();
    await entered.promise;
    const kicks = [first];
    for (let i = 1; i < 20; i++) {
      pump.enqueue(row(`t${i}`));
      kicks.push(pump.kick());
    }
    expect(stub!.batches).toHaveLength(1);
    release.resolve();
    await Promise.all(kicks);
    expect(sentTools()).toEqual(Array.from({ length: 20 }, (_, i) => `t${i}`));
    expect(peak).toBe(1);
  });

  test("logged out, nothing is sent", async () => {
    const { pump } = setup(accepted, { current: () => null });
    pump.enqueue(row("bash"));
    await pump.kick();
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
    pump = createAuditPump({ dataDir, login: () => login(first.stub.url), log: memoryLog().log, timing: FAST, clock: first.clock, post: first.post });
    await pump.kick();
    expect(sentTools()).toEqual(["t0", "t1", "t2"]);
  });
});
