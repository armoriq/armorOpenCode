import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seedCredentials } from "../../bench/lib/login.ts";
import { createSandbox, OPENCODE_BIN, REPO_ROOT, fileUrl, type RunResult } from "../../bench/lib/opencode.ts";
import type { StubBackend } from "../../bench/lib/stub-backend.ts";
import { fromList, type ScriptedCall, type StubModel, type ToolResult } from "../../bench/lib/stub-model.ts";

export const HAVE_OPENCODE = existsSync(OPENCODE_BIN);
export const DIST_PLUGIN = path.join(REPO_ROOT, "dist", "plugin.js");
export const STANDIN_PLUGIN = path.join(REPO_ROOT, "test", "e2e", "fixtures", "standin-plugin.ts");

export type Scenario = { run: RunResult; results: readonly ToolResult[] };

export async function runScenario(opts: {
  model: StubModel;
  backend: StubBackend;
  plugin: string;
  calls: readonly ScriptedCall[];
  login?: boolean;
  config?: Record<string, unknown>;
  // "workspace" follows what the stub backend says; the default forces Block, which most scenarios cover.
  orgMode?: "enforce" | "workspace";
  policy?: unknown;
}): Promise<Scenario> {
  const sandbox = createSandbox({ modelUrl: opts.model.url, plugins: [fileUrl(opts.plugin)], config: opts.config });
  try {
    if (opts.login !== false) await seedCredentials(sandbox, opts.backend.url);
    opts.model.reset();
    opts.model.setScript(fromList(opts.calls));
    if (opts.policy !== undefined) {
      mkdirSync(path.join(sandbox.armoriqHome, "armoropencode"), { recursive: true });
      writeFileSync(path.join(sandbox.armoriqHome, "armoropencode", "policy.json"), JSON.stringify(opts.policy));
    }
    // A new install starts in Quiet until the workspace answers, so Block scenarios force it.
    const forced: Record<string, string> = opts.orgMode === "workspace" ? {} : { ARMORIQ_ORG_MODE: "enforce" };
    const run = await sandbox.run("go", { ARMORIQ_BACKEND_URL: opts.backend.url, ...forced });
    return { run, results: opts.model.results() };
  } finally {
    sandbox.dispose();
  }
}

export const routes = (backend: StubBackend) => backend.requests().map((r) => `${r.method} ${r.path}`);

export const resultFor = (results: readonly ToolResult[], tool: string) => results.filter((r) => r.tool === tool);
