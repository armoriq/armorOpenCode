import { afterEach, expect, test } from "bun:test";
import { probeBackend } from "../../src/io/backend-health.ts";
import type { CallResult } from "../../src/io/backend-audit.ts";
import { createBackendPosture, PROBE_TIMEOUT_MS, RECHECK_AFTER_MS } from "../../src/state/backend-posture.ts";
import { login, memoryLog } from "../io/helpers/stub.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function health(handler: () => Response | Promise<Response>) {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return login(`http://127.0.0.1:${server.port}`);
}

function posture(probe = probeBackend, now = () => Date.now()) {
  const events: string[] = [];
  const p = createBackendPosture({
    probe,
    log: memoryLog().log,
    onUnauthorized: (reason) => void events.push(`signed out: ${reason}`),
    onRecovered: () => void events.push("recovered"),
    now,
  });
  return { p, events };
}

test("a backend that never answers is unreachable after the 2 s timeout", async () => {
  const l = health(() => new Promise<Response>(() => {}));
  const { p } = posture();
  const start = Date.now();
  expect(await p.check(l)).toBe("unreachable");
  const waited = Date.now() - start;
  expect(waited).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
  expect(waited).toBeLessThan(PROBE_TIMEOUT_MS + 500);
  expect(p.seen()?.reason).toContain("no answer within 2000 ms");
});

test("a 5xx or a dead port is unreachable; a 4xx means the backend is up", async () => {
  expect(await posture().p.check(health(() => new Response("down", { status: 503 })))).toBe("unreachable");
  server!.stop(true);
  expect(await posture().p.check(login("http://127.0.0.1:9"))).toBe("unreachable");
  expect(await posture().p.check(health(() => new Response("nope", { status: 404 })))).toBe("reachable");
});

test("the answer is cached for 30 s, then rechecked, and recovery is announced", async () => {
  let clock = 1_000_000;
  let up = false;
  let probes = 0;
  const probe = async (): Promise<CallResult<void>> => {
    probes += 1;
    return up ? { ok: true, value: undefined } : { ok: false, retryable: true, unreachable: true, reason: "503" };
  };
  const { p, events } = posture(probe, () => clock);
  const l = login("http://unused");
  expect(await p.check(l)).toBe("unreachable");
  up = true;
  clock += RECHECK_AFTER_MS - 1;
  expect(await p.check(l)).toBe("unreachable");
  expect(probes).toBe(1);
  clock += 1;
  expect(await p.check(l)).toBe("reachable");
  expect(probes).toBe(2);
  expect(events).toEqual(["recovered"]);
});

test("concurrent checks share one probe", async () => {
  let probes = 0;
  const probe = async (): Promise<CallResult<void>> => {
    probes += 1;
    await Bun.sleep(20);
    return { ok: true, value: undefined };
  };
  const { p } = posture(probe);
  const l = login("http://unused");
  expect(await Promise.all([p.check(l), p.check(l), p.check(l)])).toEqual(["reachable", "reachable", "reachable"]);
  expect(probes).toBe(1);
});

test("a 401 signs out instead of marking the backend unreachable", () => {
  const { p, events } = posture();
  p.report({ ok: false, retryable: false, unauthorized: true, status: 401, reason: "audit batch returned 401" });
  expect(events).toEqual(["signed out: audit batch returned 401"]);
  expect(p.seen()).toBeNull();
});
