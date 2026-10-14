// Launch checks for ArmorOpenCode against a real ArmorIQ backend, one real headless session per
// OpenCode binary. A scripted stub model makes the tool calls, so every run is the same and needs
// no model key; everything else is real: the plugin, OpenCode, the backend and the console APIs.
//
//   ARMORIQ_VERIFY_EMAIL=... ARMORIQ_VERIFY_PASSWORD=... \
//     bun scripts/verify-launch.ts --backend <url> [--dashboard <url>] --opencode <bin> [--opencode <bin>] [--plugin <dir>] [--out <dir>]
//
// The account signs in with its password. Each OpenCode run then runs the real `armoriq login` in
// its own throwaway HOME, which mints one device-bound API key per run, approved by this script.
// Checks: an in-plan read is allowed, an off-plan write is blocked as drift, a policy-forbidden
// webfetch is blocked, a ~/.armoriq read is blocked by the built-in rule, the backend's token
// totals for the session equal `opencode stats`, and the console APIs return the session and its
// audit rows. Exits 1 if any check fails.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, fileUrl, REPO_ROOT, type Sandbox } from "../bench/lib/opencode.ts";
import { fromList, startStubModel, type ScriptedCall } from "../bench/lib/stub-model.ts";

const { values } = parseArgs({
  options: {
    backend: { type: "string" },
    opencode: { type: "string", multiple: true },
    plugin: { type: "string" },
    // Where the backend sends device approvals; `armoriq login` refuses any other origin.
    dashboard: { type: "string" },
    out: { type: "string" },
    "wait-seconds": { type: "string", default: "90" },
  },
});
const backend = values.backend?.replace(/\/+$/, "");
const email = process.env.ARMORIQ_VERIFY_EMAIL;
const password = process.env.ARMORIQ_VERIFY_PASSWORD;
if (!backend || !values.opencode?.length || !email || !password) {
  console.error("usage: ARMORIQ_VERIFY_EMAIL=.. ARMORIQ_VERIFY_PASSWORD=.. bun scripts/verify-launch.ts --backend <url> [--dashboard <url>] --opencode <bin> [--opencode <bin>] [--plugin <dir>] [--out <dir>]");
  process.exit(2);
}
const pluginDir = path.resolve(values.plugin ?? REPO_ROOT);
const waitMs = Number(values["wait-seconds"]) * 1000;

type Check = { name: string; ok: boolean; detail: string };

async function api<T>(method: string, route: string, opts: { jwt?: string; org?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  if (opts.org) headers["x-organization-id"] = opts.org;
  const res = await fetch(`${backend}${route}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body: body as T };
}

type Account = { jwt: string; orgId: string; email: string };

async function signIn(): Promise<{ jwt: string }> {
  const login = await api<{ data?: { accessToken?: string } }>("POST", "/auth/login", { body: { email, password } });
  const jwt = login.body.data?.accessToken;
  if (!jwt) throw new Error(`POST /auth/login returned ${login.status}`);
  return { jwt };
}

// The SDK's own `armoriq login`, run in the sandbox HOME so the key is bound to that device exactly as
// a user's is. The script approves the printed code with the account's session instead of a browser,
// and a no-op `open` / `xdg-open` keeps the CLI from opening one.
async function armoriqLogin(sandbox: Sandbox, jwt: string): Promise<Account> {
  const bin = path.join(sandbox.root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, name), 0o755);
  }
  const cli = path.join(REPO_ROOT, "node_modules", "@armoriq", "sdk-dev", "dist", "cli", "index.js");
  const proc = Bun.spawn([process.execPath, cli, "login", "--product", "armoropencode", "--force"], {
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: sandbox.home, ARMORIQ_BACKEND_URL: backend!, ...(values.dashboard ? { ARMORIQ_DASHBOARD_URL: values.dashboard } : {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 120_000);
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    out += decoder.decode(chunk);
    const code = out.replace(/\x1b\[[0-9;]*m/g, "").match(/Confirm this code in your browser: (\S+)/)?.[1];
    if (!code) continue;
    const approve = await api("POST", "/auth/device/approve", {
      jwt,
      body: { userCode: code, createNew: true, newKeyName: `armoropencode launch verification ${new Date().toISOString()}` },
    });
    if (approve.status >= 300) throw new Error(`POST /auth/device/approve returned ${approve.status}: ${JSON.stringify(approve.body)}`);
    break;
  }
  const exit = await proc.exited;
  clearTimeout(timer);
  if (exit !== 0) throw new Error(`armoriq login exited ${exit}: ${out}${await new Response(proc.stderr).text()}`);
  const creds = JSON.parse(readFileSync(path.join(sandbox.armoriqHome, "credentials.json"), "utf8"));
  const profile = creds.profiles[creds.active];
  return { jwt, orgId: profile.orgId, email: profile.email };
}

const POLICY = {
  schemaVersion: "armor.policy.v1",
  defaults: { decision: "allow" },
  statements: [{ id: "launch-no-webfetch", effect: "forbid", action: { type: "tool", eq: "webfetch" } }],
};

function version(bin: string): { version: string; major: number } {
  const out = Bun.spawnSync([bin, "--version"], { stdout: "pipe" }).stdout.toString();
  const v = out.match(/\d+\.\d+\.\d+/)?.[0];
  if (!v) throw new Error(`could not read the OpenCode version from ${bin}`);
  return { version: v, major: Number(v.split(".")[0]) };
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number };

// The sandbox holds only this run's session, so OpenCode's own totals are that session's totals.
function opencodeStats(bin: string, major: number, sandbox: Sandbox): Totals {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: sandbox.home,
    XDG_CONFIG_HOME: path.join(sandbox.root, "xdg", "config"),
    XDG_DATA_HOME: path.join(sandbox.root, "xdg", "data"),
    XDG_CACHE_HOME: path.join(sandbox.root, "xdg", "cache"),
    XDG_STATE_HOME: path.join(sandbox.root, "xdg", "state"),
  };
  if (major >= 2) {
    const out = Bun.spawnSync([bin, "stats", "--standalone", "--json", "--all"], { cwd: sandbox.project, env, stdin: "ignore", stdout: "pipe" }).stdout.toString();
    const t = JSON.parse(out).tokens;
    return { input: t.input, output: t.output, cacheRead: t.cache.read, cacheWrite: t.cache.write };
  }
  // OpenCode 1.19 has no JSON stats, and counts nothing without --project (empty means this project).
  const out = Bun.spawnSync([bin, "stats", "--project="], { cwd: sandbox.project, env, stdin: "ignore", stdout: "pipe" }).stdout.toString();
  const row = (label: string) => Number(out.match(new RegExp(`│${label}\\s+([\\d,]+)\\s*│`))?.[1]?.replaceAll(",", "") ?? NaN);
  return { input: row("Input"), output: row("Output"), cacheRead: row("Cache Read"), cacheWrite: row("Cache Write") };
}

async function poll<T>(fn: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = await fn();
    if (v !== null || Date.now() > deadline) return v;
    await Bun.sleep(3000);
  }
}

async function verify(bin: string, jwt: string): Promise<Check[]> {
  const { version: v, major } = version(bin);
  const p = major >= 2 ? "path" : "filePath";
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown) =>
    checks.push({ name: `OpenCode ${v}: ${name}`, ok, detail: (typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\s+/g, " ").slice(0, 300) });

  const model = startStubModel();
  const sandbox = createSandbox({
    modelUrl: model.url,
    plugins: [],
    config: { plugin: [[fileUrl(pluginDir), { backendUrl: backend }]] },
    runArgs: major >= 2 ? ["--standalone", "--format", "json"] : ["--format", "json"],
    timeoutMs: 240_000,
    bin,
  });
  try {
    const key = await armoriqLogin(sandbox, jwt);
    mkdirSync(path.join(sandbox.armoriqHome, "armoropencode"), { recursive: true });
    writeFileSync(path.join(sandbox.armoriqHome, "armoropencode", "policy.json"), JSON.stringify(POLICY, null, 2));
    const calls: ScriptedCall[] = [
      { tool: "register_intent_plan", args: { goal: "read the first project file", steps: [{ action: "read f1.txt", tool: "read" }] } },
      { tool: "read", args: { [p]: path.join(sandbox.project, "f1.txt") } },
      { tool: "write", args: { [p]: path.join(sandbox.project, "drift.txt"), content: "off-plan" } },
      { tool: "webfetch", args: { url: `${backend}/`, format: "text" } },
      { tool: "read", args: { [p]: path.join(sandbox.armoriqHome, "credentials.json") } },
    ];
    model.setScript(fromList(calls));
    const run = await sandbox.run("go", { ARMORIQ_BACKEND_URL: backend! });
    const result = (i: number) => model.results().find((r) => r.callId.startsWith(`call_${i}_`))?.content ?? "<no result>";
    const sessionId = run.output.match(/"sessionID":"(ses_[A-Za-z0-9]+)"/)?.[1] ?? null;

    check("opencode run exits 0", run.exitCode === 0, `exit ${run.exitCode}`);
    check("plan registered", result(0).includes("Intent registered"), result(0));
    check("allowed read returns the file", result(1).includes("file 1"), result(1));
    check("off-plan write is blocked as drift", result(2).includes("ArmorIQ blocked this call [intent_drift]"), result(2));
    check("policy-forbidden webfetch is blocked", result(3).includes("ArmorIQ blocked this call [policy_forbid]"), result(3));
    check("~/.armoriq read is blocked", result(4).includes("ArmorIQ blocked this call [builtin_protected]"), result(4));
    check("session id found in the run output", sessionId !== null, sessionId ?? run.output.slice(-300));

    const local = opencodeStats(bin, major, sandbox);
    if (sessionId) {
      type SessionTokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      const remote = await poll(async () => {
        const r = await api<SessionTokens>("GET", `/dashboard/tokens/sessions/${sessionId}`, { jwt, org: key.orgId });
        return r.status === 200 && r.body.input === local.input && r.body.output === local.output ? r.body : null;
      });
      const last = remote ?? (await api<SessionTokens>("GET", `/dashboard/tokens/sessions/${sessionId}`, { jwt, org: key.orgId })).body;
      const same = ["input", "output", "cacheRead", "cacheWrite"].every((k) => (last as any)[k] === (local as any)[k]);
      check("backend token totals equal opencode stats", same, { opencodeStats: local, backend: last });

      // The console keys sessions by its own UUID and keeps OpenCode's id as harnessSessionId.
      type Listed = { sessionId: string; harnessSessionId?: string; input: number; output: number; title?: string };
      const listed = await poll(async () => {
        const r = await api<Listed[]>("GET", "/dashboard/tokens/sessions?product=armoropencode&limit=1000", { jwt, org: key.orgId });
        return (Array.isArray(r.body) ? r.body : []).find((i) => i.harnessSessionId === sessionId) ?? null;
      });
      check("console session list returns the session", listed !== null, listed ?? "not listed");
      if (listed) {
        const detail = await api<unknown>("GET", `/organization/${key.orgId}/observability/sessions/${listed.sessionId}`, { jwt, org: key.orgId });
        check("console session detail returns the session", detail.status === 200 && JSON.stringify(detail.body).includes(listed.sessionId), { status: detail.status, consoleId: listed.sessionId });
      }

      type Run = { tool: string; status: string; sessionId?: string };
      const want = ["read:success", "write:blocked", "webfetch:blocked", "read:blocked"];
      let seen: string[] = [];
      await poll(async () => {
        const r = await api<{ data?: Run[] } | Run[]>("GET", "/dashboard/runs?limit=100", { jwt, org: key.orgId });
        const rows = Array.isArray(r.body) ? r.body : (r.body.data ?? []);
        seen = rows.filter((row) => row.sessionId === sessionId).map((row) => `${row.tool}:${row.status}`);
        return want.every((w) => seen.includes(w)) ? seen : null;
      });
      check("console audit rows for the session", want.every((w) => seen.includes(w)), { want, seen });
    }

    if (values.out) {
      const dir = path.join(values.out, `opencode-${v}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "run-output.txt"), run.output);
      writeFileSync(path.join(dir, "tool-results.json"), JSON.stringify(model.results(), null, 2));
    }
  } finally {
    sandbox.dispose();
    model.stop();
  }
  return checks;
}

const { jwt } = await signIn();
console.log(`Signed in to ${backend} as ${email}; plugin ${pluginDir}`);
const all: Check[] = [];
for (const bin of values.opencode!) {
  try {
    all.push(...(await verify(bin, jwt)));
  } catch (error) {
    all.push({ name: `${bin}: run`, ok: false, detail: String(error) });
  }
}
for (const c of all) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
if (values.out) writeFileSync(path.join(values.out, "checks.json"), JSON.stringify(all, null, 2));
process.exit(all.every((c) => c.ok) ? 0 : 1);
