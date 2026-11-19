import { ArmorOpenCode } from "../../../src/hosts/v1/plugin.ts";
import { setup } from "../../../src/hosts/v2/index.ts";
import { acquireRuntime, releaseRuntime } from "../../../src/runtime.ts";

const quiet = { info() {}, warn() {}, error() {} };
const rt = acquireRuntime(quiet);
const resultMode = process.argv[2] === "result";
rt.policy.current = () => ({ hash: "h", intentRequired: false, evaluate: () => ({ effect: resultMode ? "permit" : "forbid", ruleId: "test", reason: "storage must not disable guarding" }) });
rt.posture.check = async () => "reachable";
rt.posture.warm = () => {};
const hooks: any = await ArmorOpenCode({ client: { app: { log: async () => {} } }, directory: process.env.HOME, worktree: process.env.HOME } as any, {});
let v1 = false;
let v2 = false;
let outputKept = false;
if (resultMode) {
  rt.audit.enqueue = () => { throw new Error("injected enqueue failure"); };
  await hooks["tool.execute.before"]({ sessionID: "s", callID: "c", tool: "read" }, { args: {} });
  const result = { title: "read", output: "the real tool output", metadata: {} };
  await hooks["tool.execute.after"]({ sessionID: "s", callID: "c", tool: "read" }, result);
  outputKept = result.output === "the real tool output" && rt.audit.status().captureFailures === 1;
} else {
  try { await hooks["tool.execute.before"]({ sessionID: "s", callID: "c", tool: "bash" }, { args: {} }); }
  catch (error: any) { v1 = error.decision?.code === "policy_forbid"; }
}
const registered = new Map<string, (event: any) => any>();
const registration = { dispose: async () => {} };
const cleanup = await setup({
  tool: { hook: async (name: string, callback: any) => { registered.set(name, callback); return registration; }, transform: async () => registration },
  event: { subscribe: async function* () {} },
  session: { hook: async () => registration, get: async () => ({}), synthetic: async () => ({}) },
  command: { transform: async () => registration },
} as any);
if (!resultMode) {
  try { await registered.get("execute.before")!({ tool: "shell", sessionID: "s2", id: "c2", messageID: "m", agent: "build", input: {} }); }
  catch (error: any) { v2 = error.decision?.code === "policy_forbid"; }
}
const corruptRecords = rt.audit.status().corruptRecords;
await hooks.dispose();
if (cleanup) await cleanup();
await releaseRuntime();
console.log(JSON.stringify({ v1, v2, outputKept, corruptRecords }));
