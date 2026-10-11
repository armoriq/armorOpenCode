import { existsSync } from "node:fs";
import path from "node:path";
import { createSandbox, OPENCODE_BIN, REPO_ROOT, fileUrl, type RunResult, type Sandbox } from "../../bench/lib/opencode.ts";
import type { StubBackend } from "../../bench/lib/stub-backend.ts";
import { fromList, type ScriptedCall, type StubModel, type ToolResult } from "../../bench/lib/stub-model.ts";

export const HAVE_OPENCODE = existsSync(OPENCODE_BIN);
export const DIST_PLUGIN = path.join(REPO_ROOT, "dist", "plugin.js");
export const STANDIN_PLUGIN = path.join(REPO_ROOT, "test", "e2e", "fixtures", "standin-plugin.ts");

// The core lanes replace `throw new Error("not implemented")` bodies; until every module the
// hot path touches is real, scenarios against dist/plugin.js are skipped. Probes avoid anything
// that would read the real ~/.armoriq.
export async function coreReady(): Promise<{ ready: boolean; missing: string[] }> {
  const probes: [string, () => unknown][] = [
    ["core/policy.compilePolicy", async () => (await import("../../src/core/policy.ts")).compilePolicy({ version: "armor.policy.v1", statements: [] })],
    ["core/decide.decide", async () => (await import("../../src/core/decide.ts")).decide({} as never)],
    ["tools/intent.intentTools", async () => (await import("../../src/tools/intent.ts")).intentTools({} as never)],
    ["io/backend-intent.mintToken", async () => (await import("../../src/io/backend-intent.ts")).mintToken({} as never, {} as never, "" as never)],
    ["pumps/audit.createAuditPump", async () => (await import("../../src/pumps/audit.ts")).createAuditPump({} as never)],
  ];
  const missing: string[] = [];
  for (const [name, probe] of probes) {
    try {
      await probe();
    } catch (error) {
      if (error instanceof Error && error.message === "not implemented") missing.push(name);
    }
  }
  return { ready: missing.length === 0, missing };
}

// Writes the login through the SDK's own writer, so the file is exactly what `armoriq login` produces.
export async function seedCredentials(sandbox: Sandbox, backend: string): Promise<void> {
  const script = `
    const { saveLoginProfile, loadLoginContext } = await import(${JSON.stringify(path.join(REPO_ROOT, "node_modules", "@armoriq", "sdk-dev", "dist", "index.js"))});
    saveLoginProfile({ backend: ${JSON.stringify(backend)}, product: "armoropencode", apiKey: "ak_test_e2e", email: "e2e@example.com", userId: "user-e2e", orgId: "org-e2e" });
    if (!loadLoginContext({ backend: ${JSON.stringify(backend)}, product: "armoropencode" })) throw new Error("login not readable");
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: sandbox.home }, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`seeding credentials failed: ${await new Response(proc.stderr).text()}`);
}

export type Scenario = { run: RunResult; results: readonly ToolResult[] };

export async function runScenario(opts: {
  model: StubModel;
  backend: StubBackend;
  plugin: string;
  calls: readonly ScriptedCall[];
  login?: boolean;
  config?: Record<string, unknown>;
}): Promise<Scenario> {
  const sandbox = createSandbox({ modelUrl: opts.model.url, plugins: [fileUrl(opts.plugin)], config: opts.config });
  try {
    if (opts.login !== false) await seedCredentials(sandbox, opts.backend.url);
    opts.model.reset();
    opts.model.setScript(fromList(opts.calls));
    const run = await sandbox.run("go", { ARMORIQ_BACKEND_URL: opts.backend.url });
    return { run, results: opts.model.results() };
  } finally {
    sandbox.dispose();
  }
}

export const routes = (backend: StubBackend) => backend.requests().map((r) => `${r.method} ${r.path}`);

export const resultFor = (results: readonly ToolResult[], tool: string) => results.filter((r) => r.tool === tool);
