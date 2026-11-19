// Socket free companion to bench/run.ts, with real runtime hooks, session state and audit storage.
import { rmSync } from "node:fs";
import { createAuditPump } from "../src/pumps/audit.ts";
import { runtimeHooks } from "../test/support/runtime-hooks.ts";
import { login, memoryLog, scratch } from "../test/io/helpers/stub.ts";
import type { SessionID } from "../src/types.ts";

const dir = scratch("armor-hook-bench-");
const current = login("https://bench.invalid");
const rt = await runtimeHooks(current, { hash: "bench", intentRequired: false, evaluate: () => ({ effect: "permit", ruleId: null, reason: "" }) });
const pump = createAuditPump({ dataDir: dir, login: () => current, log: memoryLog().log });
Object.assign(rt, { audit: pump });
const id = "bench-session" as SessionID;
rt.sessions.open(id, null, "enforce");
rt.sessions.beginMessage(id, "bench-prompt");
const content = "x".repeat(16 * 1024 - Buffer.byteLength(JSON.stringify({ content: "" })));
const before: number[] = [];
const after: number[] = [];
const denied: number[] = [];
try {
  for (let i = 0; i < 2500; i++) {
    const call = { sessionId: id, callId: `call-${i}`, tool: "write", args: { content } };
    let start = performance.now();
    const pending = rt.before(call);
    const elapsed = (performance.now() - start) * 1000;
    await pending;
    start = performance.now();
    rt.after(call.callId, "ok");
    if (i >= 500) {
      before.push(elapsed);
      after.push((performance.now() - start) * 1000);
    }
  }
  rt.setPolicy({ hash: "deny", intentRequired: false, evaluate: () => ({ effect: "forbid", ruleId: "bench", reason: "no" }) });
  for (let i = 0; i < 2500; i++) {
    const start = performance.now();
    const pending = rt.before({ sessionId: id, callId: `denied-${i}`, tool: "write", args: { content } });
    const elapsed = (performance.now() - start) * 1000;
    await pending.catch(() => {});
    if (i >= 500) denied.push(elapsed);
  }
  for (const [hook, values] of [["tool.execute.before", before], ["tool.execute.after", after], ["tool.execute.before (deny)", denied]] as const) {
    values.sort((a, b) => a - b);
    const p50 = values[Math.ceil(values.length * 0.50) - 1]!;
    const p95 = values[Math.ceil(values.length * 0.95) - 1]!;
    console.log(`${hook}, 16 KB arguments, ${values.length} samples: p50 ${p50.toFixed(2)} us, p95 ${p95.toFixed(2)} us`);
    if (p50 > 250 || p95 > 1000) process.exitCode = 1;
  }
} finally {
  await pump.stop();
  await rt.sessions.flush();
  rmSync(dir, { recursive: true, force: true });
  rmSync(rt.sessionDir, { recursive: true, force: true });
}
