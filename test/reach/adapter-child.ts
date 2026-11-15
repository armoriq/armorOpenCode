import { mock } from "bun:test";
import { fakeRuntime, planArgs } from "../support/intent-harness.ts";
import { GuardDenied } from "../../src/runtime.ts";
import type { SessionID } from "../../src/types.ts";

const [major, enabled, response, dir] = process.argv.slice(2);
const hostModule = await import("../../src/host.ts");
const reachModule = await import("../../src/reach/index.ts");
const decorate = reachModule.withReach;
const rt = await fakeRuntime(null);
const decision = new GuardDenied({ kind: "hold", ruleId: null, reason: "approval" });
Object.assign(rt, {
  before: async () => { throw decision; }, after() {}, failed() {}, userMessage() {}, sessionCreated() {}, sessionTitle() {}, idle() {}, deleted() {}, assistantModel() {}, stepFinished() {},
});
const inner = hostModule.hostFor(rt, rt.log);
mock.module("../../src/host.ts", () => ({ ...hostModule, acquireHost: () => inner }));
let requests = 0;
const leaks: string[] = [];
let capturedVersion: unknown;
mock.module("../../src/reach/index.ts", () => ({ ...reachModule, withReach: (host: any, options: any) => {
  capturedVersion = options.hostVersion;
  return decorate(host, options, {
    home: dir, env: {}, now: () => Date.parse("2026-11-14T12:00:00Z"), readLogin: () => null,
    fetch: async (_url: any, init: any) => {
      requests++;
      const text = String(init.body);
      for (const privateValue of [dir!, "/private/planted", "private-host", "private-tool"]) if (text.includes(privateValue)) leaks.push(privateValue);
      if (response === "offline") throw new Error("offline");
      if (response === "slow") return new Promise<Response>(() => {});
      return new Response(null, { status: Number(response) });
    },
  });
} }));

const options = { backendUrl: "https://api.armoriq.ai", usagePing: enabled === "on" };
const samples: number[] = [];
const result: any = { replies: [], errors: [], promptOutput: null };
let runPrompt: () => Promise<void>;
let runPlan: () => Promise<unknown>;
let runDenied: () => Promise<unknown>;
const started = performance.now();
if (major === "1") {
  const { ArmorOpenCode } = await import("../../src/hosts/v1/plugin.ts");
  const hooks = await ArmorOpenCode({ client: { app: { log: async () => {} } }, worktree: "/private/planted", directory: "/private/planted" } as any, options);
  result.loadMs = performance.now() - started;
  result.immediate = requests;
  const output: any = { message: { id: "m" }, parts: [{ type: "text", text: "private-host /private/planted private-tool" }] };
  runPrompt = async () => { await hooks["chat.message"]!({ sessionID: "s", messageID: "m" } as any, output); };
  runPlan = () => hooks.tool!.register_intent_plan!.execute(planArgs("bash") as any, { sessionID: "s", messageID: "m", callID: "p" } as any);
  runDenied = () => hooks["tool.execute.before"]!({ sessionID: "s", callID: "c", tool: "private-tool" }, { args: {} }).catch(() => {});
  result.replies.push(await hooks.tool!.register_intent_plan!.execute(planArgs("bash") as any, { sessionID: "s", messageID: "m", callID: "p" } as any));
  result.replies.push(await hooks.tool!.register_intent_plan!.execute({} as any, { sessionID: "s", messageID: "m", callID: "bad" } as any));
  try { await hooks["tool.execute.before"]!({ sessionID: "s", callID: "c", tool: "private-tool" }, { args: {} }); } catch (e) { result.errors.push({ same: e === decision, text: String(e) }); }
  result.promptOutput = output;
} else {
  const { setup } = await import("../../src/hosts/v2/index.ts");
  const tools = new Map<string, any>(); const hooks: Record<string, ((e: any) => unknown)[]> = {}; const toolHooks: Record<string, (e: any) => unknown> = {};
  const registration = { dispose: async () => {} };
  const ctx: any = {
    app: { name: "opencode", version: "2.0.29" }, options, location: { directory: "/private/planted" },
    tool: { hook: async (name: string, fn: (e: any) => unknown) => { toolHooks[name] = fn; return registration; }, transform: async (cb: any) => { cb({ add: (t: any) => tools.set(t.name, t) }); return registration; } },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    session: { hook: async (name: string, fn: (e: any) => unknown) => { (hooks[name] ??= []).push(fn); return registration; }, get: async () => ({ id: "s" }), synthetic: async () => ({ id: "synthetic" }) },
    command: { transform: async () => registration },
  };
  const cleanup = await setup(ctx);
  result.loadMs = performance.now() - started;
  result.immediate = requests;
  const output = { sessionID: "s", messageID: "m", prompt: { text: "private-host /private/planted private-tool" } };
  runPrompt = async () => { for (const hook of hooks.prompt ?? []) await hook(output); };
  runPlan = () => tools.get("register_intent_plan").execute(planArgs("bash"), { sessionID: "s", messageID: "m", id: "p" });
  runDenied = async () => { try { await toolHooks["execute.before"]!({ sessionID: "s", messageID: "m", id: "c", tool: "private-tool", input: {} }); } catch {} };
  result.replies.push((await tools.get("register_intent_plan").execute(planArgs("bash"), { sessionID: "s", messageID: "m", id: "p" })).content);
  result.replies.push((await tools.get("register_intent_plan").execute({}, { sessionID: "s", messageID: "m", id: "bad" })).content);
  try { await toolHooks["execute.before"]!({ sessionID: "s", messageID: "m", id: "c", tool: "private-tool", input: {} }); } catch (e) { result.errors.push({ same: e === decision, text: String(e) }); }
  result.promptOutput = output;
  await cleanup?.();
}
for (let i = 0; i < 100; i++) {
  for (const hook of [runPrompt, runPlan, runDenied]) { const start = performance.now(); await hook(); samples.push(performance.now() - start); }
}
samples.sort((a, b) => a - b);
result.p95 = samples[Math.ceil(samples.length * 0.95) - 1];
await Bun.sleep(70);
result.requests = requests;
result.leaks = leaks;
result.version = capturedVersion ?? null;
console.log(JSON.stringify(result));
