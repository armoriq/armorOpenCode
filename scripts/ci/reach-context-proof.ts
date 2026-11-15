// Run outside a sandbox that denies localhost listeners:
// OPENCODE_BIN=/path/to/opencode bun scripts/ci/reach-context-proof.ts --plugin . --out /tmp/aoc-reach-proof
//
// First run the existing CI harness unchanged. Then reuse its sandbox, stub model, and stub backend
// for a first session and a second process resuming that exact session. A proxy saves every model
// request, including title/summary requests. A fixture wrapper loads the complete plugin against the
// local backend, and registers its real reach module with an injected contract origin and signed out
// credential reader. This exercises real synthetic persistence and context hooks without a real ping,
// account, or model. Only fixture prompts and fake credentials exist in the throwaway HOME.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, fileUrl, OPENCODE_BIN, REPO_ROOT } from "../../bench/lib/opencode.ts";
import { startStubBackend } from "../../bench/lib/stub-backend.ts";
import { fromList, startStubModel } from "../../bench/lib/stub-model.ts";
import { NOTICE } from "../../src/reach/messages.ts";
import { loginCommand } from "../../src/reach/login.ts";
import { REACH_NOTE } from "../../src/reach/v2.ts";

const REMINDER_PREFIX = "ArmorOpenCode is not signed in to ArmorIQ.";
export function assertCleanRequests(requests: readonly unknown[]): void {
  if (requests.length === 0) throw new Error("No model requests were captured");
  for (const request of requests) {
    const text = JSON.stringify(request);
    if ([NOTICE, "ArmorIQ sends an anonymous daily usage ping", REMINDER_PREFIX, REACH_NOTE].some(value => text.includes(value))) {
      throw new Error("Reach message leaked into model bound context");
    }
  }
}

async function run(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), 180_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: stdout + stderr };
  } finally { clearTimeout(timeout); }
}

type Observation = { stage: string; kind: string; sessionID?: string; input?: { sessionID: string; text: string; description: string }; id?: string; messages?: unknown[] };
const observations = (file: string): Observation[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function prove(pluginDir: string, out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  for (const name of ["summary.json", "failure.txt"]) {
    const file = path.join(out, name); if (existsSync(file)) unlinkSync(file);
  }
  for (const name of ["model-requests.ndjson", "host-observations.ndjson"]) writeFileSync(path.join(out, name), "");
  const versionData = path.join(out, "version-data"); mkdirSync(versionData, { recursive: true });
  const version = await run([OPENCODE_BIN, "--version"], pluginDir, { PATH: process.env.PATH, XDG_DATA_HOME: versionData });
  writeFileSync(path.join(out, "version.txt"), version.output);
  if (version.code !== 0 || version.output.match(/(\d+)\.(\d+)\.(\d+)/)?.[1] !== "2") throw new Error("This proof requires an OpenCode 2 executable in OPENCODE_BIN");

  const baseline = await run([process.execPath, path.join(REPO_ROOT, "scripts/ci/headless-session.ts"), "--plugin", pluginDir, "--out", path.join(out, "baseline")], pluginDir,
    { ...process.env, OPENCODE_BIN, XDG_DATA_HOME: versionData });
  writeFileSync(path.join(out, "baseline-output.txt"), baseline.output);
  if (baseline.code !== 0) throw new Error("The existing headless harness failed; see baseline-output.txt. No reach proof is claimed.");

  const model = startStubModel();
  const backend = startStubBackend();
  let stage = "first";
  const captured: { stage: string; request: unknown }[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : undefined;
    if (url.pathname.endsWith("/chat/completions") && raw) {
      const entry = { stage, request: JSON.parse(raw) };
      captured.push(entry);
      appendFileSync(path.join(out, "model-requests.ndjson"), `${JSON.stringify(entry)}\n`);
      // Give the scheduled notice time to arrive before the next tool/model turn.
      await Bun.sleep(150);
    }
    const suffix = url.pathname.replace(/^\/v1/, "");
    return fetch(`${model.url}${suffix}${url.search}`, { method: req.method, headers: { "content-type": "application/json" }, body: raw });
  } });
  const wrapper = path.join(out, "fixture-plugin"); mkdirSync(wrapper, { recursive: true });
  const observedFile = path.join(out, "host-observations.ndjson");
  writeFileSync(path.join(wrapper, "package.json"), JSON.stringify({ name: "armoropencode-reach-proof", type: "module", main: "index.ts" }));
  writeFileSync(path.join(wrapper, "index.ts"), `
import plugin from ${JSON.stringify(fileUrl(path.join(pluginDir, "index.ts")))};
import { registerReach } from ${JSON.stringify(fileUrl(path.join(pluginDir, "src/reach/v2.ts")))};
import { appendFileSync } from "node:fs";
const record = value => appendFileSync(${JSON.stringify(observedFile)}, JSON.stringify({stage:process.env.AOC_PROOF_STAGE,...value})+"\\n");
export default { ...plugin, id: "armoropencode-reach-proof", async setup(ctx) {
  const registrations = [];
  registrations.push(await ctx.session.hook("context", e => record({kind:"before",sessionID:e.sessionID,messages:e.messages})));
  const stopPlugin = await plugin.setup(ctx);
  const reachCtx = { ...ctx, options: {backendUrl:"https://api.armoriq.ai",usagePing:true,signInReminder:true}, session: {
    ...ctx.session, hook: (...args) => ctx.session.hook(...args), synthetic: async input => {
      const message = await ctx.session.synthetic(input);
      record({kind:"synthetic",input,id:message?.id}); return message;
    }
  }};
  const log = {info(){},warn(message,extra){record({kind:"warning",message,extra});},error(){}};
  const stopReach = await registerReach(reachCtx, {log}, {home:process.env.HOME,env:{},readLogin:()=>null});
  registrations.push(await ctx.session.hook("context", e => record({kind:"after",sessionID:e.sessionID,messages:e.messages})));
  return async () => { await stopReach(); await stopPlugin?.(); for (const r of registrations) await r.dispose(); };
}};
`);
  const sandbox = createSandbox({ modelUrl: `http://127.0.0.1:${proxy.port}/v1`, plugins: [],
    config: { plugin: [[fileUrl(wrapper), { backendUrl: backend.url, usagePing: false, signInReminder: false }]] },
    runArgs: ["--standalone", "--format", "json"],
  });
  try {
    model.setScript(fromList([{ tool: "read", args: { path: path.join(sandbox.project, "f1.txt") } }]));
    const first = await sandbox.run("reach proof: read the fixture", { AOC_PROOF_STAGE: "first" });
    writeFileSync(path.join(out, "first-output.txt"), first.output);
    if (first.exitCode !== 0) throw new Error("First OpenCode session failed; see first-output.txt");
    const notice = observations(observedFile).find(e => e.stage === "first" && e.kind === "synthetic");
    const sessionID = notice?.input?.sessionID;
    const reminder = `${REMINDER_PREFIX} Sign in to see your plans and blocks on your dashboard: ${loginCommand("https://api.armoriq.ai")} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`;
    if (!sessionID || !notice?.id || notice.input?.text !== REACH_NOTE || notice.input.description !== `${NOTICE}\n\n${reminder}`) {
      throw new Error("The first session did not emit both exact messages as one neutral synthetic notice");
    }
    const reachState = path.join(sandbox.home, ".armoriq/reach/v1/armoropencode");
    const records = readdirSync(reachState).filter(name => /^message-.*\.json$/.test(name));
    if (!records.some(name => JSON.parse(readFileSync(path.join(reachState, name), "utf8")).id === notice.id)) throw new Error("Synthetic id was not persisted");

    stage = "resume";
    const xdg = (name: string) => path.join(sandbox.root, "xdg", name);
    const resumed = await run([OPENCODE_BIN, "run", "--standalone", "--format", "json", "--session", sessionID, "reach proof: resume the same session"], sandbox.project, {
      PATH: process.env.PATH, HOME: sandbox.home, ARMORIQ_HOME: sandbox.armoriqHome,
      XDG_CONFIG_HOME: xdg("config"), XDG_DATA_HOME: xdg("data"), XDG_CACHE_HOME: xdg("cache"), XDG_STATE_HOME: xdg("state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_SHARE: "1", AOC_PROOF_STAGE: "resume",
    });
    writeFileSync(path.join(out, "resume-output.txt"), resumed.output);
    if (resumed.code !== 0) throw new Error("Resumed OpenCode session failed; see resume-output.txt");

    const observed = observations(observedFile);
    for (const phase of ["first", "resume"]) {
      assertCleanRequests(captured.filter(entry => entry.stage === phase).map(entry => entry.request));
      const contexts = observed.filter(e => e.stage === phase && e.kind === "after" && e.sessionID === sessionID);
      if (!contexts.length) throw new Error(`No ${phase} context captured for the original session`);
      assertCleanRequests(contexts.map(e => e.messages));
      if (contexts.some(e => e.messages?.some((message: any) => message.id === notice.id))) throw new Error(`Synthetic id survived ${phase} context filtering`);
    }
    if (observed.some(e => e.stage === "resume" && e.kind === "synthetic")) throw new Error("Resume repeated a once per day message");
    const log = path.join(sandbox.root, "xdg/data/opencode/log");
    if (existsSync(log)) cpSync(log, path.join(out, "opencode-log"), { recursive: true });
    cpSync(reachState, path.join(out, "reach-state"), { recursive: true });
    writeFileSync(path.join(out, "summary.json"), JSON.stringify({
      status: "passed", version: version.output.trim(), sessionID, syntheticID: notice.id,
      requests: { first: captured.filter(e => e.stage === "first").length, resume: captured.filter(e => e.stage === "resume").length },
      compaction: "Not run: the shared headless harness and this run CLI expose no compaction operation.",
      fixture: "Full plugin uses the local backend; its real reach module uses an injected contract origin and signed out reader. No real ping or login.",
    }, null, 2));
    console.log(`PASS: exact messages emitted; no notice, reminder, or neutral message in first or resumed model requests. Evidence: ${out}`);
    console.log("Compaction was not run: the shared harness and OpenCode run CLI expose no compaction operation.");
  } finally {
    sandbox.dispose(); proxy.stop(true); model.stop(); backend.stop();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { plugin: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("OPENCODE_BIN=/path/to/opencode bun scripts/ci/reach-context-proof.ts --plugin . --out /tmp/aoc-reach-proof\nRequires localhost listeners. Saves raw fixture model requests and real host context. Compaction is not exposed by this harness.");
  } else {
    const out = path.resolve(values.out ?? mkdtempSync(path.join(tmpdir(), "aoc-reach-proof-")));
    try { await prove(path.resolve(values.plugin ?? REPO_ROOT), out); }
    catch (error) {
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "failure.txt"), String(error));
      console.error(`FAIL: ${String(error)}\nEvidence: ${out}`);
      process.exitCode = 1;
    }
  }
}
