// Runs real `opencode run` sessions in a throwaway HOME, XDG tree, ARMORIQ_HOME and project.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? path.join(homedir(), ".opencode", "bin", "opencode");
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

export type Sandbox = {
  root: string;
  home: string;
  project: string;
  armoriqHome: string;
  run(prompt: string, env?: Record<string, string>): Promise<RunResult>;
  dispose(): void;
};

export type RunResult = { exitCode: number; output: string; ms: number };

export type SandboxOptions = {
  modelUrl: string;
  plugins: readonly string[];
  config?: Record<string, unknown>;
  files?: Record<string, string>;
  timeoutMs?: number;
};

export const fileUrl = (p: string) => pathToFileURL(path.resolve(p)).href;

export function createSandbox(opts: SandboxOptions): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "aoc-harness-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const armoriqHome = path.join(home, ".armoriq");
  const xdg = (name: string) => path.join(root, "xdg", name);
  for (const dir of [home, project, armoriqHome, xdg("config"), xdg("data"), xdg("cache"), xdg("state")]) mkdirSync(dir, { recursive: true });

  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      stub: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stub",
        options: { baseURL: opts.modelUrl, apiKey: "none" },
        models: { stub: { name: "stub", tool_call: true } },
      },
    },
    model: "stub/stub",
    small_model: "stub/stub",
    permission: "allow",
    share: "disabled",
    autoupdate: false,
    plugin: opts.plugins,
    ...opts.config,
  };
  writeFileSync(path.join(project, "opencode.json"), JSON.stringify(config, null, 2));
  for (let i = 1; i <= 10; i++) writeFileSync(path.join(project, `f${i}.txt`), `file ${i}\n`);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    writeFileSync(path.join(project, rel), content);
  }

  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdg("config"),
    XDG_DATA_HOME: xdg("data"),
    XDG_CACHE_HOME: xdg("cache"),
    XDG_STATE_HOME: xdg("state"),
    ARMORIQ_HOME: armoriqHome,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_SHARE: "1",
  };

  return {
    root,
    home,
    project,
    armoriqHome,
    async run(prompt, env = {}) {
      const started = performance.now();
      const proc = Bun.spawn([OPENCODE_BIN, "run", prompt], {
        cwd: project,
        env: { ...baseEnv, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 180_000);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      return { exitCode, output: stdout + stderr, ms: performance.now() - started };
    },
    dispose() {
      if (!process.env.AOC_KEEP_SANDBOX) rmSync(root, { recursive: true, force: true });
    },
  };
}
