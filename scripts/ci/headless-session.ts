// One real headless OpenCode session with the plugin installed the way the installer installs it:
// a `plugin` tuple naming the plugin directory, which OpenCode 1 resolves through package.json and
// OpenCode 2 through the root index.ts. A scripted stub model registers a plan, reads a project
// file and then reads ~/.armoriq, which the built-in rule must block. A stub backend takes the login,
// the plan token and the audit rows, so no credentials or paid model are needed.
//
//   OPENCODE_BIN=<opencode> bun scripts/ci/headless-session.ts [--plugin <dir>] [--out <dir>]
//
// Exits 1 when any check fails, including when OpenCode never loaded the plugin.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { seedCredentials } from "../../bench/lib/login.ts";
import { createSandbox, fileUrl, OPENCODE_BIN, REPO_ROOT } from "../../bench/lib/opencode.ts";
import { startStubBackend } from "../../bench/lib/stub-backend.ts";
import { fromList, startStubModel, type ScriptedCall } from "../../bench/lib/stub-model.ts";

const { values } = parseArgs({ options: { plugin: { type: "string" }, out: { type: "string" } } });
const pluginDir = path.resolve(values.plugin ?? REPO_ROOT);

const versionOut = Bun.spawnSync([OPENCODE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const version = versionOut.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
if (!version) throw new Error(`could not read the OpenCode version from ${OPENCODE_BIN}: ${JSON.stringify(versionOut)}`);
const major = Number(version.split(".")[0]);
// OpenCode 2 renamed read's filePath to path.
const pathKey = major >= 2 ? "path" : "filePath";

const model = startStubModel();
const backend = startStubBackend();
const sandbox = createSandbox({
  modelUrl: model.url,
  plugins: [],
  config: { plugin: [[fileUrl(pluginDir), { backendUrl: backend.url }]] },
  runArgs: major >= 2 ? ["--standalone", "--format", "json"] : ["--format", "json"],
});

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail: detail.replace(/\s+/g, " ") });

try {
  await seedCredentials(sandbox, backend.url);
  const secret = path.join(sandbox.armoriqHome, "credentials.json");
  const calls: ScriptedCall[] = [
    { tool: "register_intent_plan", args: { goal: "read the first project file", steps: [{ action: "read f1.txt", tool: "read" }] } },
    { tool: "read", args: { [pathKey]: path.join(sandbox.project, "f1.txt") } },
    { tool: "read", args: { [pathKey]: secret } },
  ];
  model.setScript(fromList(calls));
  const run = await sandbox.run("go", { ARMORIQ_BACKEND_URL: backend.url });
  const results = model.results();
  const content = (i: number) => results.find((r) => r.callId.startsWith(`call_${i}_`))?.content ?? "<no result>";

  check("opencode run exits 0", run.exitCode === 0, `exit ${run.exitCode}`);
  check("plan registered", content(0).includes("Intent registered"), content(0).slice(0, 200));
  check("allowed read returns the file", content(1).includes("file 1"), content(1).slice(0, 200));
  check("~/.armoriq read is blocked", content(2).includes("ArmorIQ blocked this call [builtin_protected]"), content(2).slice(0, 200));

  const rows = backend
    .requests()
    .filter((r) => r.path === "/iap/audit/batch")
    .flatMap((r) => (r.body as { rows?: { tool: string; status: string }[] })?.rows ?? []);
  const reads = rows.filter((r) => r.tool === "read").map((r) => r.status);
  check("audit rows: read success and read blocked", reads.includes("success") && reads.includes("blocked"), JSON.stringify(reads));

  const logDir = path.join(sandbox.root, "xdg", "data", "opencode", "log");
  const log = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("") : "";
  const failed = log.split("\n").filter((l) => l.includes("failed to load plugin"));
  check("no plugin load failure in the OpenCode log", failed.length === 0, failed.join("\n").slice(0, 500) || "none");
  if (major >= 2) {
    // OpenCode 1.19 does not log plugin loads at all; the block and audit rows above prove it ran.
    const loaded = log.split("\n").filter((l) => l.includes('msg="loading plugin"') && l.includes(pluginDir));
    check("OpenCode log shows our plugin loading", loaded.length > 0, loaded[0]?.slice(0, 300) ?? "no loading plugin line names the plugin dir");
  }

  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(path.join(values.out, "run-output.txt"), run.output);
    writeFileSync(path.join(values.out, "tool-results.json"), JSON.stringify(results, null, 2));
    writeFileSync(path.join(values.out, "backend-requests.json"), JSON.stringify(backend.requests().map(({ bytes: _, ...r }) => r), null, 2));
    if (existsSync(logDir)) cpSync(logDir, path.join(values.out, "opencode-log"), { recursive: true });
  }
} finally {
  sandbox.dispose();
  model.stop();
  backend.stop();
}

console.log(`OpenCode ${version} (${OPENCODE_BIN}), plugin ${pluginDir}`);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
process.exit(checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1);
