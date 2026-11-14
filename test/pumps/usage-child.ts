// One OpenCode-like process writing usage for a shared session; driven by test/pumps/usage.test.ts.
import { stepUsageFromPart } from "../support/step-usage.ts";
import { createUsagePump } from "../../src/pumps/usage.ts";
import type { Login } from "../../src/types.ts";

const [dataDir, loginJson, prefix, countArg] = process.argv.slice(2);
const login = JSON.parse(loginJson!) as Login;
const quiet = { info() {}, warn: (m: string, e?: unknown) => console.error(m, e), error: (m: string, e?: unknown) => console.error(m, e) };
const pump = createUsagePump({ dataDir: dataDir!, login: () => login, log: quiet }, { intervalMs: 60_000, persistDelayMs: 1 });
pump.start();
const base = Date.parse("2026-10-11T10:59:50Z");
for (let i = 0; i < Number(countArg); i++) {
  const part = { id: `${prefix}-${i}`, sessionID: "ses_shared", messageID: "msg_1", type: "step-finish", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
  pump.observe(stepUsageFromPart(part, () => "anthropic/claude-sonnet-5", "/repo", base + i * 1000)!);
  pump.kick();
  await Bun.sleep(3);
}
await Bun.sleep(50);
pump.kick();
await Bun.sleep(300);
await pump.stop();
