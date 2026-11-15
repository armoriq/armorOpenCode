// Run outside a sandbox that denies localhost listeners:
// OPENCODE_BIN=/path/to/opencode bun scripts/ci/reach-context-proof.ts --plugin . --out /tmp/aoc-reach-proof
//
// First run the existing CI harness unchanged. Then reuse its sandbox, stub model, and stub backend
// for a first session, a second process resuming it, and a server compacting that exact session before
// one more prompt. A proxy saves every model request, including title/summary requests. A fixture
// wrapper loads the complete plugin against the local backend, and registers its real reach module
// with an injected contract origin and signed out credential reader. This exercises real synthetic
// persistence and context hooks without a real ping, account, or model. Only fixture prompts and fake
// credentials exist in the throwaway HOME.
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
export const COMPACTION_SUMMARY = `## Objective
- Continue answering fixture prompts.

## Requirements
- (none)

## Decisions
- (none)

## Work State
- Fixture progress follows.

### Completed
- Read the fixture file and resumed the original session.

### Active
- (none)

### Blocked
- (none)

## Next Move
- Respond to the next fixture prompt.

## Relevant Files
- (none)

## Important Context
- (none)`;

// Compaction may use either generateText or streamText. Keep this fixture local to the proof.
export function compactionReply(stream: boolean): Response {
  const base = { id: "reach-proof-summary", created: 1, model: "stub" };
  const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
  if (!stream) return Response.json({ ...base, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", content: COMPACTION_SUMMARY }, finish_reason: "stop" }],
  });
  const chunks = [
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: COMPACTION_SUMMARY }, finish_reason: null }] },
    { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

export function assertCleanRequests(requests: readonly unknown[], allowReachNote = false): void {
  if (requests.length === 0) throw new Error("No model requests were captured");
  for (const request of requests) {
    const text = JSON.stringify(request);
    if ([NOTICE, "ArmorIQ sends an anonymous daily usage ping", REMINDER_PREFIX, ...(allowReachNote ? [] : [REACH_NOTE])].some(value => text.includes(value))) {
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
type CapturedRequest = { stage: string; request: unknown; summary?: boolean };
type ProjectedMessage = { id: string; type: string; status?: string; summary?: string; outcome?: string };
const observations = (file: string): Observation[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

function isCompactionSummaryRequest(request: unknown): boolean {
  if (typeof request !== "object" || request === null || !("messages" in request) || !Array.isArray(request.messages)) return false;
  const content = request.messages.findLast(message => message?.role === "user")?.content;
  const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
  // OpenCode 2 still offers tools on summary calls. Identify the instruction, not the tool list.
  return (prompt.startsWith("You MUST summarize the conversation above") && prompt.includes("<template>") && prompt.includes("</template>")) ||
    prompt === "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.";
}

export function assertCompactionProof(captured: readonly CapturedRequest[], observed: readonly Observation[], sessionID: string, syntheticID: string, compacted: ProjectedMessage | null) {
  const compactionRequests = captured.filter(entry => entry.stage === "compaction");
  const summaryRequests = compactionRequests.filter(entry => isCompactionSummaryRequest(entry.request)).length;
  if (!summaryRequests) throw new Error("No compaction summary request was captured");
  if (compacted?.type !== "compaction" || compacted.status !== "completed" || compacted.summary !== COMPACTION_SUMMARY) {
    throw new Error("Compaction did not complete with the scripted summary");
  }
  const counts = { compaction: { before: 0, after: 0 }, afterCompaction: { before: 0, after: 0 } };
  for (const phase of ["compaction", "after-compaction"] as const) {
    const requests = captured.filter(entry => entry.stage === phase);
    if (!requests.length) throw new Error("No model requests were captured");
    for (const entry of requests) assertCleanRequests([entry.request], phase === "compaction" && isCompactionSummaryRequest(entry.request));
    for (const kind of ["before", "after"] as const) {
      const contexts = observed.filter(entry => entry.stage === phase && entry.kind === kind && entry.sessionID === sessionID);
      // Compaction summaries bypass this hook. The prompt afterward must exercise it.
      if (!contexts.length && phase === "compaction") continue;
      if (!contexts.length || contexts.some(entry => !Array.isArray(entry.messages))) throw new Error(`No ${phase} ${kind} context captured for the original session`);
      // Raw before contexts may hold the neutral synthetic message; the after context must not.
      assertCleanRequests(contexts.map(entry => entry.messages), kind === "before");
      if (kind === "after" && contexts.some(entry => entry.messages?.some((message: any) => message.id === syntheticID))) throw new Error(`Synthetic id survived ${phase} ${kind} context`);
      counts[phase === "compaction" ? "compaction" : "afterCompaction"][kind] = contexts.length;
    }
  }
  return {
    status: "passed", messageID: compacted.id, summaryRequests,
    requestsWithReachNote: compactionRequests.filter(entry => JSON.stringify(entry.request).includes(REACH_NOTE)).length,
    requests: { compaction: compactionRequests.length, afterCompaction: captured.filter(entry => entry.stage === "after-compaction").length },
    contexts: counts,
  };
}

async function waitFor<T>(label: string, poll: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await poll();
    if (result !== undefined) return result;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function startProofServer(cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn([OPENCODE_BIN, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let url = "";
  let password = "";
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  // Startup output contains a password. Drain both pipes, parse it only in memory, and never log it.
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!.slice(-8192);
      for (const line of lines) {
        url = line.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? url;
        password = line.match(/server password (\S+)/)?.[1] ?? password;
      }
    }
  };
  const drains = Promise.allSettled([drain(proc.stdout), drain(proc.stderr)]);
  return {
    async ready() {
      await waitFor("OpenCode server startup", async () => {
        if (exited) throw new Error("OpenCode server exited before startup completed");
        if (url && password) return true;
      }, 30_000);
    },
    async request<T>(route: string, body?: Record<string, unknown>, allowMissing = false): Promise<T | null> {
      let response: Response;
      try {
        response = await fetch(`${url}${route}`, {
          method: body ? "POST" : "GET", signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch { throw new Error(`OpenCode server request failed: ${route}`); }
      if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode server returned HTTP ${response.status}: ${route}`); }
      const result = await response.json() as { data: T };
      if (!result || !("data" in result)) throw new Error(`OpenCode server response has no data: ${route}`);
      return result.data;
    },
    async stop() {
      if (!exited) proc.kill();
      const timer = setTimeout(() => { if (!exited) proc.kill("SIGKILL"); }, 3000);
      try { await proc.exited; await drains; }
      finally { clearTimeout(timer); password = ""; }
    },
  };
}

async function waitForIdleAfter(server: ReturnType<typeof startProofServer>, sessionRoute: string, messageID: string) {
  return waitFor("OpenCode session idle", async () => {
    const messages = await server.request<ProjectedMessage[]>(`${sessionRoute}/message?order=desc&limit=100`);
    if (!Array.isArray(messages)) throw new Error("OpenCode server returned no message timeline");
    const index = messages.findIndex(message => message.id === messageID);
    if (index < 0) return;
    const idle = messages.slice(0, index).find(message => message.type === "idle");
    if (!idle) return;
    if (idle.outcome !== "succeeded") throw new Error("OpenCode session did not finish successfully");
    return messages;
  });
}

async function prove(pluginDir: string, out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  for (const name of ["summary.json", "failure.txt", "compaction-output.json", "after-compaction-output.json"]) {
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
  const stageFile = path.join(out, "stage.txt");
  const setStage = (value: string) => { stage = value; writeFileSync(stageFile, value); };
  setStage("first");
  const captured: CapturedRequest[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : undefined;
    if (url.pathname.endsWith("/chat/completions") && raw) {
      const request = JSON.parse(raw);
      const summary = stage === "compaction" && isCompactionSummaryRequest(request);
      const entry = { stage, request, ...(summary ? { summary: true } : {}) };
      captured.push(entry);
      appendFileSync(path.join(out, "model-requests.ndjson"), `${JSON.stringify(entry)}\n`);
      // Give the scheduled notice time to arrive before the next tool/model turn.
      await Bun.sleep(150);
      if (summary) return compactionReply(request.stream === true);
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
import { appendFileSync, readFileSync } from "node:fs";
const record = value => appendFileSync(${JSON.stringify(observedFile)}, JSON.stringify({stage:readFileSync(${JSON.stringify(stageFile)},"utf8"),...value})+"\\n");
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

    setStage("resume");
    const xdg = (name: string) => path.join(sandbox.root, "xdg", name);
    const sessionEnv = {
      PATH: process.env.PATH, HOME: sandbox.home, ARMORIQ_HOME: sandbox.armoriqHome,
      XDG_CONFIG_HOME: xdg("config"), XDG_DATA_HOME: xdg("data"), XDG_CACHE_HOME: xdg("cache"), XDG_STATE_HOME: xdg("state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_SHARE: "1", AOC_PROOF_STAGE: "resume",
    };
    const resumed = await run([OPENCODE_BIN, "run", "--standalone", "--format", "json", "--session", sessionID, "reach proof: resume the same session"], sandbox.project, sessionEnv);
    writeFileSync(path.join(out, "resume-output.txt"), resumed.output);
    if (resumed.code !== 0) throw new Error("Resumed OpenCode session failed; see resume-output.txt");

    setStage("compaction");
    model.setScript(fromList([]));
    const server = startProofServer(sandbox.project, { ...sessionEnv, AOC_PROOF_STAGE: "compaction" });
    let compacted: ProjectedMessage | null = null;
    try {
      await server.ready();
      const sessionRoute = `/api/session/${encodeURIComponent(sessionID)}`;
      // The API admits work asynchronously. Assume its inbox id identifies the projected message.
      const admitted = await server.request<{ id: string; type: string; sessionID: string }>(`${sessionRoute}/compact`, {});
      if (!admitted?.id || admitted.type !== "compaction" || admitted.sessionID !== sessionID) throw new Error("OpenCode did not admit compaction for the original session");
      writeFileSync(path.join(out, "compaction-output.json"), JSON.stringify({ admitted }, null, 2));
      compacted = await waitFor("completed compaction", async () => {
        const message = await server.request<ProjectedMessage>(`${sessionRoute}/message/${encodeURIComponent(admitted.id)}`, undefined, true);
        if (message?.status === "failed") throw new Error("OpenCode compaction failed");
        if (message?.type === "compaction" && message.status === "completed") return message;
      });
      await waitForIdleAfter(server, sessionRoute, admitted.id);
      writeFileSync(path.join(out, "compaction-output.json"), JSON.stringify({ admitted, completed: compacted }, null, 2));
      if (!captured.some(entry => entry.stage === "compaction" && entry.summary)) throw new Error("No compaction summary request was captured");

      setStage("after-compaction");
      const prompt = await server.request<{ id: string; type: string; sessionID: string }>(`${sessionRoute}/prompt`, { text: "reach proof: continue the same session after compaction" });
      if (!prompt?.id || prompt.type !== "user" || prompt.sessionID !== sessionID) throw new Error("OpenCode did not admit the prompt after compaction");
      const messages = await waitForIdleAfter(server, sessionRoute, prompt.id);
      writeFileSync(path.join(out, "after-compaction-output.json"), JSON.stringify({ admitted: prompt, messages }, null, 2));
    } finally { await server.stop(); }

    const observed = observations(observedFile);
    const compaction = assertCompactionProof(captured, observed, sessionID, notice.id, compacted);
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
      requests: { first: captured.filter(e => e.stage === "first").length, resume: captured.filter(e => e.stage === "resume").length, ...compaction.requests },
      compaction,
      fixture: "Full plugin uses the local backend; its real reach module uses an injected contract origin and signed out reader. No real ping or login.",
    }, null, 2));
    console.log(`PASS: no notice or reminder in any model request; the neutral note appears only in compaction summaries (${compaction.requestsWithReachNote} requests). Evidence: ${out}`);
  } finally {
    sandbox.dispose(); proxy.stop(true); model.stop(); backend.stop();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { plugin: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("OPENCODE_BIN=/path/to/opencode bun scripts/ci/reach-context-proof.ts --plugin . --out /tmp/aoc-reach-proof\nRequires localhost listeners. Saves every model request and available before/after contexts. Compaction summaries bypass the context hook; only those requests may carry the neutral note, counted in summary.json.");
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
