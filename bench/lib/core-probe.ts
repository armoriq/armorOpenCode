// Decides whether src/ is complete enough to run dist/plugin.js. Runs the real plugin entry through
// setup, chat.message, both tool hooks and an event, in a throwaway HOME with an unreachable backend.
//   exit 0: ready   exit 1: something still throws "not implemented"   exit 2: any other failure
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./opencode.ts";

export type ProbeResult = { status: "ready" | "not_implemented" | "error"; detail: string };

// The child exits 10 for "not implemented" and 11 for other errors, so a crash (exit 1) is never
// mistaken for an unfinished module.
const CHILD = `
const notImplemented = (e) => e instanceof Error && e.message === "not implemented";
const step = async (name, fn) => {
  try { await fn(); } catch (e) {
    if (notImplemented(e)) { console.log(name); process.exit(10); }
    if (e?.name === "ArmorIQ") return;
    console.log(name + ": " + (e?.stack ?? e)); process.exit(11);
  }
};
let ArmorOpenCode, hooks;
await step("import", async () => { ({ ArmorOpenCode } = await import(${JSON.stringify(path.join(REPO_ROOT, "src", "plugin.ts"))})); });
const dir = process.cwd();
await step("setup", async () => { hooks = await ArmorOpenCode({ client: { app: { log: async () => {} } }, directory: dir, worktree: dir }); });
await step("chat.message", () => hooks["chat.message"]({ sessionID: "ses_probe", messageID: "msg_probe" }, { message: { id: "msg_probe" }, parts: [{ type: "text", text: "hi" }] }));
await step("tool.execute.before", () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_probe", callID: "call_probe" }, { args: { command: "ls" } }));
await step("tool.execute.after", () => hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_probe", callID: "call_probe", args: { command: "ls" } }, { title: "", output: "ok", metadata: {} }));
await step("event", () => hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_probe", status: { type: "idle" } } } }));
await step("dispose", () => hooks.dispose?.());
process.exit(0);
`;

export async function probeCore(): Promise<ProbeResult> {
  const home = mkdtempSync(path.join(tmpdir(), "aoc-probe-"));
  try {
    const proc = Bun.spawn([process.execPath, "-e", CHILD], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, ARMORIQ_HOME: path.join(home, ".armoriq"), ARMORIQ_BACKEND_URL: "http://127.0.0.1:9" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const detail = (out + err).trim();
    if (code === 0) return { status: "ready", detail };
    if (code === 10) return { status: "not_implemented", detail };
    return { status: "error", detail: detail || `probe exited ${code}` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await probeCore();
  console.log(`core probe: ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
  process.exit(result.status === "ready" ? 0 : result.status === "not_implemented" ? 1 : 2);
}
