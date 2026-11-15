import { expect, test } from "bun:test";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendCount } from "../../src/reach/counts.ts";
import { runPing, type ReachDependencies } from "../../src/reach/ping.ts";
import { contract, countsDir, countsFile, home, manualTimers, origin, relogin, savedLogin, settings, today, validBody } from "./helpers.ts";
import pkg from "../../package.json";

const options = { backend: origin, hostVersion: "2.0.29" };
const deps = (dir: string, extra: ReachDependencies = {}): ReachDependencies => ({ home: dir, env: {}, now: () => today, readLogin: () => null, ...extra });
const plant = (dir: string, day: string, contents = '{"t":"plan"}\n') => {
  mkdirSync(countsDir(dir), { recursive: true });
  writeFileSync(countsFile(dir, day), contents, { mode: 0o600 });
};

test("a relogin marker makes a saved credential signed out for the ping and every counter", async () => {
  const dir = home(); relogin(dir);
  const d = deps(dir, { readLogin: () => savedLogin });
  for (const metric of ["plan", "blocked", "held"] as const) await appendCount(metric, options, d);
  expect(existsSync(countsFile(dir, "2026-11-14"))).toBe(true);
  expect(readFileSync(countsFile(dir, "2026-11-14"), "utf8")).toBe(contract.localCountsLine.join(""));
  let body: any;
  await runPing(options, { ...d, fetch: async (_url, init) => { body = JSON.parse(String(init.body)); return new Response(null, { status: 204 }); } });
  expect(body.signedIn).toBe(false);
});

test("relogin markers follow ARMORIQ_HOME and are bound to the backend and saved key", async () => {
  for (const kind of ["matching", "new-key", "other-backend"]) {
    const dir = home(); const armoriqDir = path.join(dir, "custom-armor"); relogin(dir, savedLogin, armoriqDir);
    const login = { ...savedLogin, ...(kind === "new-key" ? { apiKey: "replacement" } : kind === "other-backend" ? { backend: "https://staging-api.armoriq.ai" } : {}) };
    let body: any;
    const d = deps(dir, { env: { ARMORIQ_HOME: armoriqDir }, readLogin: () => login, fetch: async (_url, init) => { body = JSON.parse(String(init.body)); return new Response(null, { status: 204 }); } });
    await appendCount("plan", { backend: login.backend }, d);
    await runPing({ backend: login.backend }, d);
    expect(body.signedIn).toBe(kind !== "matching");
    expect(existsSync(countsFile(dir, "2026-11-14"))).toBe(kind === "matching");
  }
});

test("body follows the exact contract and contains no session, device or auth information", async () => {
  const dir = home();
  let body: any;
  await runPing(options, deps(dir, { fetch: async (url, init) => {
    expect(url).toBe(`${origin}/install-pings`);
    expect(init!.method).toBe("POST");
    expect(init!.headers).toEqual({ "content-type": "application/json" });
    expect(init!.redirect).toBe("error");
    body = JSON.parse(String(init!.body));
    return new Response(null, { status: 204 });
  } }));
  expect(validBody(body)).toBe(true);
  expect(body).toMatchObject({ plugin: "armoropencode", pluginVersion: pkg.version, hostAgent: "opencode", hostVersion: "2.0.29", signedIn: false, environment: "production", localCounts: [] });
  expect(existsSync(path.join(dir, ".armoriq/device-id"))).toBe(false);
});
test("backend precedence, sign in and host versions use their named sources", async () => {
  for (const version of [null, "bad", "1.2", "1.2.3", "2.0.29-beta.1", "1.2.3-" + "a".repeat(65)]) {
    const dir = home();
    let body: any;
    await runPing({ backend: origin, pluginOptions: { backendUrl: "https://staging-api.armoriq.io" }, hostVersion: version }, deps(dir, { env: { ARMORIQ_BACKEND_URL: "https://staging-api.armoriq.ai", ARMORIQ_API_KEY: "ak_planted" }, readLogin: (env, backend) => {
      expect(env.ARMORIQ_API_KEY).toBe("ak_planted"); expect(backend).toBe("https://staging-api.armoriq.ai");
      return { backend: origin, apiKey: "ak_planted", userId: "user", orgId: "org", email: "private@example.com", deviceId: "private-device", deviceName: "private-host" };
    }, fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return new Response(null, { status: 204 }); } }));
    expect(validBody(body)).toBe(true);
    expect(body.environment).toBe("staging"); expect(body.signedIn).toBe(true);
    expect(body.hostVersion).toBe(typeof version === "string" && /^\d+\.\d+\.\d+(-[\w.-]{1,32})?$/.test(version) ? version : null);
    for (const forbidden of ["ak_planted", "private@example.com", "private-device", "private-host", dir]) expect(JSON.stringify(body)).not.toContain(forbidden);
  }
});

test("default and plugin option backends and every OS follow the contract", async () => {
  for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
    for (const backend of [undefined, "https://staging-api.armoriq.io"]) {
      let body: any;
      await runPing({ pluginOptions: backend ? { backendUrl: backend } : {} }, deps(home(), { platform, fetch: async (url, init) => {
        expect(url).toBe(`${backend ?? origin}/install-pings`);
        body = JSON.parse(String(init.body)); return new Response(null, { status: 204 });
      } }));
      expect(validBody(body)).toBe(true);
      expect(body.os).toBe(({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[platform] ?? "other");
      expect(body.hostVersion).toBeNull();
      expect(body.environment).toBe(backend ? "staging" : "production");
    }
  }
});

test("two processes send only the winning daily claim", async () => {
  const dir = home(); const sent = path.join(dir, "requests");
  const script = 'import {appendFile} from "node:fs/promises"; import {runPing} from "./src/reach/ping.ts"; await runPing({}, {home:process.argv[1],env:{},now:()=>Date.parse("2026-11-14T12:00:00Z"),readLogin:()=>null,fetch:async()=>{await appendFile(process.argv[2],"ping\\n");return new Response(null,{status:204});}});';
  const processes = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script, dir, sent], { stdout: "pipe", stderr: "pipe" }));
  for (const proc of processes) { const err = await new Response(proc.stderr).text(); expect(await proc.exited, err).toBe(0); }
  expect(readFileSync(sent, "utf8")).toBe("ping\n");
});

test("real credential lookup reads only the effective backend and creates no device id", async () => {
  for (const signedIn of [false, true]) {
    const dir = home();
    const script = 'import {runPing} from "./src/reach/ping.ts"; await runPing({}, {home:process.argv[1],fetch:async(_url,init)=>{console.log(init.body);return new Response(null,{status:204});}});';
    const proc = Bun.spawn([process.execPath, "-e", script, dir], { env: { ...process.env, HOME: dir, ARMORIQ_HOME: `${dir}/.armoriq`, ARMORIQ_BACKEND_URL: origin, ARMORIQ_API_KEY: signedIn ? "ak_private_test" : "", DO_NOT_TRACK: "", ARMORIQ_USAGE_PING_DISABLED: "" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const body = JSON.parse(out.trim()); expect(validBody(body)).toBe(true); expect(body.signedIn).toBe(signedIn);
    expect(out).not.toContain("ak_private_test"); expect(existsSync(path.join(dir, ".armoriq/device-id"))).toBe(false);
  }
});

for (const result of [204, 201, 400, 429, 500, 302, "lost reply"] as const) {
  test(`one request, claim retained and counters settled after ${result}`, async () => {
    const dir = home(); plant(dir, "2026-11-13"); let calls = 0;
    const d = deps(dir, { fetch: async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init!.body)).localCounts).toEqual([{ day: "2026-11-13", plans: 1, blocked: 0, held: 0 }]);
      expect(existsSync(`${countsFile(dir)}.sending`)).toBe(true);
      if (result === "lost reply") throw new Error("offline");
      return new Response(null, { status: result });
    } });
    await runPing(options, d); await runPing(options, d);
    expect(calls).toBe(1);
    expect(existsSync(path.join(countsDir(dir), "ping-2026-11-14"))).toBe(true);
    expect(existsSync(`${countsFile(dir)}.sending`)).toBe(false);
    expect(existsSync(countsFile(dir))).toBe(!(typeof result === "number" && result >= 200 && result < 300));
  });
}

test("request aborts at three seconds and does not retry", async () => {
  let calls = 0; let aborted = false;
  const timers = manualTimers();
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let finish!: (response: Response) => void;
  const worker = runPing(options, deps(home(), { ...timers, fetch: async (_url, init) => {
    calls++;
    requestStarted();
    return await new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
    });
  } }));
  await started;
  await timers.advance(2999); expect(aborted).toBe(false);
  await timers.advance(1);
  const abortedAtDeadline = aborted;
  finish(new Response(null, { status: 204 }));
  await worker;
  expect(abortedAtDeadline).toBe(true); expect(calls).toBe(1);
  expect(timers.pending.size).toBe(0);
});

test("the worker ends within five seconds even when a sender ignores cancellation", async () => {
  const dir = home(); plant(dir, "2026-11-13");
  const timers = manualTimers();
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const worker = runPing(options, deps(dir, { ...timers, fetch: () => { requestStarted(); return new Promise<Response>(() => {}); } }));
  await started;
  expect(timers.unreferenced.size).toBe(2);
  await timers.advance(5000);
  await worker;
  expect(existsSync(countsFile(dir))).toBe(true);
  expect(existsSync(`${countsFile(dir)}.sending`)).toBe(false);
  expect(timers.pending.size).toBe(0);
});

test("opt out is rechecked immediately before send and rolls counts back", async () => {
  const dir = home(); plant(dir, "2026-11-13"); let calls = 0;
  await runPing(options, deps(dir, { readLogin: () => { settings(dir, { usagePing: false }); return null; }, fetch: async () => { calls++; return new Response(null, { status: 204 }); } }));
  expect(calls).toBe(0); expect(existsSync(countsFile(dir))).toBe(true);
});
test("disabled, invalid origins and invalid ids send nothing and create no claim or id", async () => {
  for (const kind of ["env", "settings", "plugin", "origin", "id"]) {
    const dir = home(); let calls = 0;
    if (kind === "settings") settings(dir, "malformed");
    if (kind === "id") { mkdirSync(path.join(dir, ".armoriq")); writeFileSync(path.join(dir, ".armoriq/install-id"), "bad"); }
    const d = deps(dir, { env: kind === "env" ? { DO_NOT_TRACK: "1" } : {}, fetch: async () => { calls++; return new Response(null, { status: 204 }); } });
    await runPing({ backend: kind === "origin" ? `${origin}/` : origin, pluginOptions: { usagePing: kind === "plugin" ? false : true } }, d);
    await appendCount("plan", options, d);
    if (kind !== "plugin" && kind !== "origin" && kind !== "id") expect(existsSync(countsDir(dir))).toBe(false);
    expect(calls).toBe(0); expect(existsSync(path.join(countsDir(dir), "ping-2026-11-14"))).toBe(false);
    if (kind !== "id") expect(existsSync(path.join(dir, ".armoriq/install-id"))).toBe(false);
  }
});

test("collects only seven earlier real UTC dates, skips bad lines and caps metrics", async () => {
  const dir = home();
  for (let day = 5; day <= 15; day++) plant(dir, `2026-11-${String(day).padStart(2, "0")}`);
  plant(dir, "2026-11-12", '{\nnull\n{"t":"unknown"}\n{"t":["plan"]}\n{"t":"plan","extra":1}\n' + contract.localCountsLine.join(""));
  plant(dir, "2026-11-11", contract.localCountsLine.map(line => line.repeat(100001)).join(""));
  plant(dir, "2026-02-30");
  let counts: any[] = [];
  await runPing(options, deps(dir, { fetch: async (_url, init) => { const body = JSON.parse(String(init!.body)); expect(validBody(body)).toBe(true); counts = body.localCounts; return new Response(null, { status: 204 }); } }));
  expect(counts.map(c => c.day)).toEqual(["13", "12", "11", "10", "09", "08", "07"].map(d => `2026-11-${d}`));
  expect(counts[1]).toEqual({ day: "2026-11-12", plans: 1, blocked: 1, held: 1 });
  expect(counts[2]).toEqual({ day: "2026-11-11", plans: 100000, blocked: 100000, held: 100000 });
  for (const day of ["05", "06"]) expect(existsSync(countsFile(dir, `2026-11-${day}`))).toBe(false);
  for (const day of ["2026-11-14", "2026-11-15", "2026-02-30"]) expect(existsSync(countsFile(dir, day))).toBe(true);
});
for (const status of [204, 500]) {
  test(`leftover sending files and a late writer lose no events after ${status}`, async () => {
    const dir = home(); plant(dir, "2026-11-13", '{"t":"held"}\n');
    writeFileSync(`${countsFile(dir)}.sending`, '{"t":"plan"}\n');
    writeFileSync(`${countsFile(dir, "2026-11-01")}.sending`, '{"t":"plan"}\n');
    await runPing(options, deps(dir, { fetch: async (_url, init) => {
      expect(JSON.parse(String(init!.body)).localCounts).toEqual([{ day: "2026-11-13", plans: 1, blocked: 0, held: 1 }]);
      appendFileSync(countsFile(dir), '{"t":"blocked"}\n', { mode: 0o600 });
      return new Response(null, { status });
    } }));
    expect(readFileSync(countsFile(dir), "utf8").trim().split("\n").map(l => JSON.parse(l).t).sort()).toEqual(status === 204 ? ["blocked"] : ["blocked", "held", "plan"]);
    expect(existsSync(`${countsFile(dir)}.sending`)).toBe(false);
    expect(existsSync(countsFile(dir, "2026-11-01"))).toBe(false);
    expect(lstatSync(countsFile(dir)).mode & 0o777).toBe(0o600);
  });
}
test("counter append is one contract line and stops at the five MB cap", async () => {
  const dir = home();
  for (const metric of ["plan", "blocked", "held"] as const) await appendCount(metric, options, deps(dir));
  const file = countsFile(dir, "2026-11-14");
  expect(readFileSync(file, "utf8")).toBe(contract.localCountsLine.join(""));
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
  await appendCount("plan", options, deps(dir));
  expect(lstatSync(file).size).toBe(5 * 1024 * 1024 + 1);
  expect(readdirSync(countsDir(dir))).toEqual(["counts-2026-11-14.ndjson"]);
});
