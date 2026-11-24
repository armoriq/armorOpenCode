import { mock } from "bun:test";
import { manualTimers } from "./manual-timers.ts";

const counts = await import("../../src/reach/counts.ts");
let finishAppend!: () => void;
const appended = new Promise<void>(resolve => { finishAppend = resolve; });
let writes = 0;
mock.module("../../src/reach/counts.ts", () => ({ ...counts, appendCount: () => { writes++; return writes === 1 ? appended : Promise.resolve(); } }));
const { withReach } = await import("../../src/reach/index.ts");
const timers = manualTimers();
globalThis.setTimeout = timers.setTimeout as typeof setTimeout;
const host = withReach({ ownTools: { registerIntentPlan: async () => "Plan recorded locally, not registered (logged_out)." } } as any, {}, timers);
const register = () => host.ownTools.registerIntentPlan({} as any, {}, "");
await register();
const draining = timers.advance();
finishAppend();
await appended;
// The drain has left its loop. Queue a count before the old catch/finally chain resets its flag.
await register();
await draining;
await timers.advance();
console.log(JSON.stringify({ writes }));
