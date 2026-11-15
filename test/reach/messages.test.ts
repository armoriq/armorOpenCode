import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as reach from "../../src/reach/index.ts";
import type { ReachDependencies, ReachOptions } from "../../src/reach/ping.ts";
import { hostFor } from "../../src/host.ts";
import { fakeRuntime } from "../support/intent-harness.ts";
import { contract, countsDir, home, manualTimers, origin, relogin, savedLogin, settings, today } from "./helpers.ts";

const note = "ArmorIQ showed you a local notice. No action is needed.";
const command = "npx -y @armoriq/sdk-dev@^0.8.17 login --product armoropencode --backend https://api.armoriq.ai";
const reminder = `ArmorOpenCode is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${command} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`;
const root = (dir: string) => path.join(dir, ".armoriq/reach/v1/armoropencode");
const depsFor = (dir: string): ReachDependencies => ({ home: dir, env: {}, now: () => today, readLogin: () => null });

async function compose(options: ReachOptions, deps: ReachDependencies): Promise<string> {
  return reach.composeMessages(options, deps);
}

test("first run joins the exact notice and reminder, then claims once per home and UTC day", async () => {
  const dir = home(); const deps = depsFor(dir);
  const replies = await Promise.all([compose({ backend: origin }, deps), compose({ backend: origin }, deps)]);
  expect(replies.flatMap(r => r.split("\n\n")).filter(Boolean).sort()).toEqual([contract.notice, reminder].sort());
  expect(await compose({ backend: origin }, deps)).toBe("");
  expect(statSync(path.join(root(dir), "notice-shown")).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(countsDir(dir), "reminder-2026-11-14")).mode & 0o777).toBe(0o600);
  expect(existsSync(path.join(dir, ".armoriq/install-id"))).toBe(false);
  expect(await compose({ backend: origin }, { ...deps, now: () => today + 1 })).toBe(reminder);
  expect(await compose({ backend: "https://staging-api.armoriq.ai" }, deps)).toContain("--backend https://staging-api.armoriq.ai");
});

test("a single composer returns notice then reminder in one first run message", async () => {
  expect(await compose({ backend: origin }, depsFor(home()))).toBe(`${contract.notice}\n\n${reminder}`);
});

test("the reminder follows a relogin marker even while the saved credential remains", async () => {
  const dir = home(); relogin(dir);
  expect(await compose({ backend: origin }, { ...depsFor(dir), readLogin: () => savedLogin })).toBe(`${contract.notice}\n\n${reminder}`);
});

test("reminder claims are pruned after 30 days, preserving other files and invalid dates", async () => {
  const dir = home(); mkdirSync(countsDir(dir), { recursive: true });
  for (const name of ["reminder-2026-10-14", "reminder-2026-10-15", "reminder-2026-02-30", "ping-2026-10-01"]) writeFileSync(path.join(countsDir(dir), name), "");
  await compose({ backend: origin }, depsFor(dir));
  expect(readdirSync(countsDir(dir)).sort()).toEqual(["ping-2026-10-01", "reminder-2026-02-30", "reminder-2026-10-15", "reminder-2026-11-14"]);
});

for (const value of ["1", "true", "YES", " True "]) {
  test(`reminder env opt out ${JSON.stringify(value)} does not suppress the notice`, async () => {
    const dir = home();
    expect(await compose({ backend: origin }, { ...depsFor(dir), env: { ARMORIQ_SIGNIN_REMINDER_DISABLED: value } })).toBe(contract.notice);
    expect(existsSync(countsDir(dir))).toBe(false);
  });
}
for (const value of [{ signInReminder: false }, { signInReminder: "bad" }, "malformed", null, []]) {
  test(`shared reminder settings fail closed: ${JSON.stringify(value)}`, async () => {
    const dir = home(); settings(dir, value);
    expect(await compose({ backend: origin, pluginOptions: { usagePing: false } }, depsFor(dir))).toBe("");
    expect(existsSync(root(dir))).toBe(false);
  });
}

test("unreadable settings, read failures, signed in, and the plugin reminder switch suppress reminders", async () => {
  const unreadable = home(); mkdirSync(path.join(unreadable, ".armoriq/settings.json"), { recursive: true });
  expect(await compose({ backend: origin }, depsFor(unreadable))).toBe("");
  const dir = home();
  expect(await compose({ backend: origin }, { ...depsFor(dir), readLogin: () => { throw new Error("unreadable"); } })).toBe(contract.notice);
  const signedIn = { backend: origin, apiKey: "fake", userId: "", orgId: "", email: "", deviceId: "", deviceName: "" };
  expect(await compose({ backend: origin }, { ...depsFor(dir), readLogin: () => signedIn })).toBe("");
  expect(await compose({ backend: origin, pluginOptions: { signInReminder: false } }, depsFor(dir))).toBe("");
  expect(existsSync(countsDir(dir))).toBe(false);
});

for (const opt of [
  { env: { DO_NOT_TRACK: "1" } }, { env: { DO_NOT_TRACK: "TRUE" } },
  { env: { ARMORIQ_USAGE_PING_DISABLED: "yes" } }, { pluginOptions: { usagePing: false } }, { shared: { usagePing: false } },
]) {
  test(`ping opt out hides only the notice: ${JSON.stringify(opt)}`, async () => {
    const dir = home(); if (opt.shared) settings(dir, opt.shared);
    expect(await compose({ backend: origin, pluginOptions: opt.pluginOptions }, { ...depsFor(dir), env: opt.env ?? {} })).toBe(reminder);
    expect(existsSync(path.join(root(dir), "notice-shown"))).toBe(false);
  });
}

test("non contract backends never write message claims and env backend wins", async () => {
  const dir = home();
  expect(await compose({ backend: origin }, { ...depsFor(dir), env: { ARMORIQ_BACKEND_URL: "https://custom.example/a?secret=yes" } })).toBe("");
  expect(existsSync(root(dir))).toBe(false);
  expect(await compose({ pluginOptions: { backendUrl: "https://staging-api.armoriq.io" } }, depsFor(dir))).toContain("--backend https://staging-api.armoriq.io");
});

test("one formatter matches the installer SDK, README commands, bare origins, and shell quoting", async () => {
  const fn = reach.loginCommand;
  expect(fn(origin)).toBe(command);
  expect(fn("https://user:secret@api.armoriq.ai/a?q=secret#hash")).toBe(command);
  expect(fn("https://custom.example:8443/a?secret=yes")).toBe(command.replace(origin, "'https://custom.example:8443'"));
  expect(fn("https://foo'bar.example/path")).toEndWith("--backend 'https://foo'\\''bar.example'");
  const readme = readFileSync(path.join(import.meta.dir, "../../README.md"), "utf8");
  expect(readme).toContain(fn(origin));
  expect(readme).toContain(fn("https://staging-api.armoriq.ai"));
  expect(readFileSync(path.join(import.meta.dir, "../../install_armoropencode.sh"), "utf8")).toContain('SDK_SPEC="@armoriq/sdk-dev@^0.8.17"');
});

test("the decorator schedules notice work only on session creation and preserves hook results", async () => {
  const dir = home(); const rt = await fakeRuntime(null);
  Object.assign(rt, { userMessage() {}, sessionCreated() {} });
  const inner = hostFor(rt, rt.log); const sent: string[] = [];
  const options = { backend: origin, notify: (m: string) => { sent.push(m); } };
  const timers = manualTimers();
  const host = reach.withReach(inner, options, { ...depsFor(dir), ...timers, fetch: async () => new Response(null, { status: 204 }) });
  const sid = "session" as import("../../src/types.ts").SessionID;
  expect(host.userPrompt({ sessionId: sid, messageId: "m", text: "hello" })).toBeUndefined();
  await timers.advance(); expect(sent).toEqual([]);
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    expect(host.event({ kind: "session_created", sessionId: sid, parentId: null })).toBeUndefined();
    samples.push(performance.now() - start);
  }
  expect(sent).toEqual([]);
  await timers.advance();
  expect(sent).toEqual([`${contract.notice}\n\n${reminder}`]);
  samples.sort((a, b) => a - b); expect(samples[189]!).toBeLessThan(20);
});

async function adapter(major: string, dir: string) {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "message-adapter-child.ts"), major, dir], {
    env: { ...process.env, HOME: dir, ARMORIQ_HOME: path.join(dir, ".armoriq"), ARMORIQ_BACKEND_URL: "", ARMORIQ_API_KEY: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0); return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("OpenCode 1 sends two exact info toasts, notice first, at most 300 characters each", async () => {
  const dir = home(); const result = await adapter("1", dir);
  expect(result.immediate).toBe(0);
  expect(result.beforeDelay).toEqual([contract.notice]);
  expect(result.beforeExpiry).toEqual([contract.notice]);
  expect(result.delayedTimers).toBe(1);
  expect(result.unreferencedTimers).toBe(1);
  expect(result.toasts).toEqual([contract.notice, reminder].map(message => ({ body: { title: "ArmorIQ", message, variant: "info", duration: 20_000 } })));
  for (const toast of result.toasts) expect(toast.body.message.length).toBeLessThanOrEqual(300);
  expect(result.p95).toBeLessThan(20);
  expect((await adapter("1", dir)).toasts).toEqual([]);
});

test("OpenCode 1 cancels the delayed reminder on plugin cleanup", async () => {
  const result = await adapter("1-cleanup", home());
  expect(result.beforeDelay).toEqual([contract.notice]);
  expect(result.toasts.map((toast: any) => toast.body.message)).toEqual([contract.notice]);
  expect(result.pendingAfterCleanup).toBe(0);
});

test("OpenCode 1 does not schedule a reminder when the composer finishes after cleanup", async () => {
  const result = await adapter("1-early-cleanup", home());
  expect(result.toasts).toEqual([]);
  expect(result.delayedTimers).toBe(0);
});

test("OpenCode 2 posts a neutral synthetic text and excludes its recorded id across processes", async () => {
  const dir = home(); const first = await adapter("2", dir);
  expect(first.immediate).toBe(0);
  expect(first.sent).toEqual([{ sessionID: "session", text: note, description: `${contract.notice}\n\n${reminder}`, resume: false }]);
  expect(first.remaining).toEqual([{ id: "user-message" }]);
  expect(first.p95).toBeLessThan(20);
  const resumed = await adapter("2", dir);
  expect(resumed.sent).toEqual([]);
  expect(resumed.remaining).toEqual([{ id: "user-message" }]);
});

test("the toast formatter drops only the hide tail for a long custom origin, without cutting the command", () => {
  const fn = reach.toastMessages;
  const login = reach.loginCommand(`https://${"long".repeat(14)}.example`);
  const full = reminder.replace(command, login);
  expect(full.length).toBeGreaterThan(300);
  expect(fn(full)).toEqual([full.slice(0, full.indexOf(" (hide this reminder:"))]);
  expect(fn(full)[0]!.length).toBeLessThanOrEqual(300);
  expect(fn(full)[0]).toContain(login);
});

test("the expiry hint uses the same command formatter for this install's backend", async () => {
  const result = await adapter("hint", home());
  expect(result.messages).toEqual([`ArmorIQ login expired; run \`${command.replace(origin, "https://staging-api.armoriq.ai")}\``]);
});

async function v2Fixture(deps: ReachDependencies, get: (input: { sessionID: string }) => Promise<unknown> = async () => ({})) {
  const hooks: Record<string, (e: any) => void | Promise<void>> = {};
  const sent: any[] = []; const warnings: string[] = [];
  let reject = false;
  const ctx = { session: {
    get,
    hook: async (name: string, cb: any) => { hooks[name] = cb; return { dispose: async () => {} }; },
    synthetic: async (input: any) => { if (reject) throw new Error("offline host"); sent.push(input); return { id: "notice-id" }; },
  } };
  const timers = manualTimers();
  const cleanup = await reach.registerReach(ctx, { log: { info() {}, error() {}, warn: (message: string) => { warnings.push(message); } } }, { ...deps, ...timers });
  return { hooks, sent, warnings, cleanup, timers, fail: () => { reject = true; } };
}
const prompt = { sessionID: "s", messageID: "m", prompt: { text: "hi" } };

test("V2 leaves the day's reminder for a root session when a child prompts first", async () => {
  const dir = home();
  const lookedUp: string[] = [];
  const fixture = await v2Fixture(depsFor(dir), async ({ sessionID }) => { lookedUp.push(sessionID); return { parentID: sessionID === "child" ? "root" : undefined }; });
  fixture.hooks.prompt!({ ...prompt, sessionID: "child" });
  fixture.hooks.prompt!({ ...prompt, sessionID: "root" });
  await fixture.timers.advance();
  expect(lookedUp).toEqual(["child", "root"]);
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0].sessionID).toBe("root");
  expect(fixture.sent[0].description).toBe(`${contract.notice}\n\n${reminder}`);
  await fixture.cleanup();
});

test("V2 leaves message claims untouched when the session lookup fails", async () => {
  const dir = home();
  const fixture = await v2Fixture(depsFor(dir), async () => { throw new Error("session unavailable"); });
  expect(fixture.hooks.prompt!(prompt)).toBeUndefined();
  await fixture.timers.advance();
  expect(fixture.sent).toEqual([]);
  expect(existsSync(root(dir))).toBe(false);
  await fixture.cleanup();
});

test("V2 filters a resumed synthetic payload even before its id cache loads", async () => {
  const fixture = await v2Fixture(depsFor(home()));
  const user = { id: "user", type: "user", payload: { text: note } };
  const context = { messages: [{ id: "old", type: "synthetic", payload: { text: note, description: contract.notice } }, user] };
  expect(fixture.hooks.context!(context)).toBeUndefined();
  expect(context.messages).toEqual([user]);
  await fixture.cleanup();
});

test("V2 notification failure is swallowed and does not retry that session or daily claim", async () => {
  const dir = home(); const fixture = await v2Fixture(depsFor(dir)); fixture.fail();
  expect(fixture.hooks.prompt!(prompt)).toBeUndefined();
  await fixture.timers.advance();
  fixture.hooks.prompt!(prompt); await fixture.timers.advance();
  expect(fixture.warnings).toEqual(["reach notice failed"]);
  expect(existsSync(path.join(countsDir(dir), "reminder-2026-11-14"))).toBe(true);
  await fixture.cleanup();
});

test("V2 scheduling errors cannot change the prompt hook result", async () => {
  let calls = 0;
  const fixture = await v2Fixture({ ...depsFor(home()), now: () => { if (calls++ > 0) throw new Error("clock unavailable"); return today; } });
  expect(() => fixture.hooks.prompt!(prompt)).not.toThrow();
  await fixture.cleanup();
});
