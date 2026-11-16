import { mock } from "bun:test";
import { fakeRuntime } from "../support/intent-harness.ts";
import { manualTimers } from "./manual-timers.ts";
const [major, dir] = process.argv.slice(2) as [string, string];
if (major === "hint") {
  const { createCredentials } = await import("../../src/io/credentials.ts");
  const messages: string[] = [];
  const credentials = createCredentials({ info() {}, error() {}, warn: message => { messages.push(message); } }, {
    env: { ARMORIQ_API_KEY: "fixture" }, backend: "https://staging-api.armoriq.ai", dataDir: `${dir}/data`,
  });
  credentials.markRelogin("fixture"); credentials.markRelogin("fixture"); credentials.stop();
  console.log(JSON.stringify({ messages }));
  process.exit(0);
}
let messagesSettled!: () => void;
const settled = new Promise<void>(resolve => { messagesSettled = resolve; });
const messageModule = await import("../../src/reach/messages.ts");
const scheduleMessages = messageModule.scheduleMessages;
mock.module("../../src/reach/messages.ts", () => ({ ...messageModule,
  scheduleMessages: (options: any, deps: any, notify: any, done: () => void, eligible: any) => scheduleMessages(options, deps, notify, () => { done(); messagesSettled(); }, eligible),
}));
const hostModule = await import("../../src/host.ts");
const reach = await import("../../src/reach/index.ts");
const decorate = reach.withReach;
const register = Reflect.get(reach, "registerReach");
const rt = await fakeRuntime(null);
Object.assign(rt, { userMessage() {}, sessionCreated() {} });
const host = hostModule.hostFor(rt, rt.log);
mock.module("../../src/host.ts", () => ({ ...hostModule, acquireHost: () => host }));
const deps = { home: dir, env: {}, now: () => Date.parse("2026-11-14T12:00:00Z"), readLogin: () => null, fetch: async () => new Response(null, { status: 204 }) };
mock.module("../../src/reach/index.ts", () => ({ ...reach,
  withReach: (h: any, options: any) => decorate(h, options, deps),
  registerReach: (ctx: any, h: any) => register(ctx, h, deps),
}));
const options = { backendUrl: "https://api.armoriq.ai" };
const sent: unknown[] = []; const toasts: unknown[] = []; const samples: number[] = [];
const result: any = { sent, toasts };
if (major.startsWith("1")) {
  const timers = manualTimers();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void | Promise<void>, ms: number) => ms === 20_000 ? timers.setTimeout(callback, ms) : realSetTimeout(callback, ms)) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => timers.pending.has(timer) ? timers.clearTimeout(timer) : realClearTimeout(timer)) as typeof clearTimeout;
  const { ArmorOpenCode } = await import("../../src/hosts/v1/plugin.ts");
  const hooks = await ArmorOpenCode({ client: { app: { log: async () => {} }, tui: { showToast: async (t: unknown) => { toasts.push(t); } } }, directory: dir, worktree: dir } as any, options);
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await hooks.event!({ event: { type: "session.created", properties: { info: { id: "session", directory: dir } } } } as any);
    samples.push(performance.now() - start);
  }
  result.immediate = toasts.length;
  if (major === "1-early-cleanup") await hooks.dispose!();
  await settled;
  result.beforeDelay = toasts.map((t: any) => t.body.message);
  result.delayedTimers = timers.pending.size;
  result.unreferencedTimers = timers.unreferenced.size;
  await timers.advance(19_999);
  result.beforeExpiry = toasts.map((t: any) => t.body.message);
  if (major === "1-cleanup" || major === "1-early-cleanup") {
    await hooks.dispose!();
    result.pendingAfterCleanup = timers.pending.size;
  }
  await timers.advance(1);
  if (major !== "1-cleanup") await hooks.dispose!();
} else {
  const { setup } = await import("../../src/hosts/v2/index.ts");
  const hooks: Record<string, ((e: any) => unknown)[]> = {};
  const reg = { dispose: async () => {} };
  const ctx: any = {
    app: { name: "opencode", version: "2.0.29" }, options, location: { directory: dir },
    tool: { hook: async () => reg, transform: async () => reg },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    command: { transform: async () => reg },
    session: { hook: async (name: string, cb: any) => { (hooks[name] ??= []).push(cb); return reg; }, get: async () => ({ id: "session" }), synthetic: async (input: any) => { sent.push(input); return { id: "reach-message" }; } },
  };
  const cleanup = await setup(ctx);
  // Only reach's prompt handler is measured. Intent also does its own session lookup.
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    for (const hook of hooks.prompt ?? []) await hook({ sessionID: "session", messageID: "prompt", prompt: { text: "hi" } });
    samples.push(performance.now() - start);
  }
  result.immediate = sent.length;
  await settled;
  const event = { sessionID: "session", system: [], messages: [{ id: "reach-message" }, { id: "user-message" }] };
  for (const hook of hooks.context ?? []) await hook(event);
  result.remaining = event.messages;
  await cleanup?.();
}
samples.sort((a, b) => a - b); result.p95 = samples[94];
console.log(JSON.stringify(result));
