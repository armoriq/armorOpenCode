// runtime.ts deep-freezes args after decide() so a later plugin cannot rewrite an allowed call.
// This runs every built-in tool OpenCode offers once with plain args and once with frozen args,
// and requires identical outcomes. Not exercised: question (needs an interactive user),
// websearch (calls Exa or Parallel over the internet), plan tools (not offered to `opencode run`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createSandbox, fileUrl, REPO_ROOT } from "../../bench/lib/opencode.ts";
import { startStubModel, type ScriptedCall, type StubModel } from "../../bench/lib/stub-model.ts";
import type { CallRecord } from "./fixtures/freeze-plugin.ts";
import { HAVE_OPENCODE } from "./harness.ts";

const FREEZE_PLUGIN = path.join(REPO_ROOT, "test", "e2e", "fixtures", "freeze-plugin.ts");
const SUBTASK = "SUBTASK: reply done";

const SKILL = `---
name: demo
description: A demo skill used by the frozen-args check.
---

Say hello.
`;

function defaultTools(project: string, modelUrl: string): ScriptedCall[] {
  const p = (f: string) => path.join(project, f);
  return [
    { tool: "bash", args: { command: "echo hi > out.txt && cat out.txt", timeout: 10_000, workdir: project } },
    { tool: "read", args: { filePath: p("f1.txt"), offset: 1, limit: 5 } },
    { tool: "glob", args: { pattern: "*.txt", path: project } },
    { tool: "grep", args: { pattern: "file", path: project, include: "*.txt" } },
    { tool: "edit", args: { filePath: p("f2.txt"), oldString: "file 2", newString: "file two", replaceAll: false } },
    { tool: "write", args: { filePath: p("new.txt"), content: "hello\n" } },
    { tool: "todowrite", args: { todos: [{ content: "check freezing", status: "in_progress", priority: "high" }, { content: "report", status: "pending", priority: "low" }] } },
    { tool: "webfetch", args: { url: `${modelUrl}/models`, format: "text", timeout: 10 } },
    { tool: "skill", args: { name: "demo" } },
    { tool: "task", args: { description: "frozen args subtask", prompt: SUBTASK, subagent_type: "general" } },
    { tool: "lsp", args: { operation: "documentSymbol", filePath: p("f1.txt"), line: 1, character: 1 } },
  ];
}

function patchTools(project: string): ScriptedCall[] {
  const patchText = ["*** Begin Patch", "*** Add File: patched.txt", "+added by apply_patch", "*** Update File: f3.txt", "@@", "-file 3", "+file three", "*** End Patch"].join("\n");
  return [{ tool: "apply_patch", args: { patchText } }];
}

type Pass = { name: string; model: string; tools: (project: string, modelUrl: string) => ScriptedCall[] };

const PASSES: Pass[] = [
  { name: "default model", model: "stub", tools: defaultTools },
  // OpenCode swaps edit/write for apply_patch on gpt-5 style model ids.
  { name: "gpt-5 model id", model: "gpt-5-stub", tools: patchTools },
];

let model: StubModel;

async function runPass(pass: Pass, frozen: boolean): Promise<CallRecord[]> {
  const sandbox = createSandbox({
    modelUrl: model.url,
    plugins: [fileUrl(FREEZE_PLUGIN)],
    files: { ".opencode/skills/demo/SKILL.md": SKILL },
    config: {
      model: `stub/${pass.model}`,
      provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: model.url, apiKey: "none" }, models: { [pass.model]: { name: pass.model, tool_call: true } } } },
    },
  });
  try {
    const calls = pass.tools(sandbox.project, model.url);
    model.reset();
    model.setScript((step, _offered, prompt) => (prompt.includes(SUBTASK) ? null : (calls[step] ?? null)));
    const out = path.join(sandbox.root, "calls.json");
    const run = await sandbox.run("go", { FREEZE_ARGS: frozen ? "1" : "0", FREEZE_OUT: out, OPENCODE_EXPERIMENTAL_LSP_TOOL: "1" });
    if (run.exitCode !== 0 || !existsSync(out)) throw new Error(`opencode run failed (${run.exitCode}):\n${run.output.slice(-2000)}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    sandbox.dispose();
  }
}

beforeAll(() => {
  model = startStubModel();
});

afterAll(() => model?.stop());

describe.skipIf(!HAVE_OPENCODE)("built-in tools with deep-frozen args", () => {
  for (const pass of PASSES) {
    test(
      pass.name,
      async () => {
        const control = await runPass(pass, false);
        const frozen = await runPass(pass, true);
        const expected = pass.tools("/p", "http://x").map((c) => c.tool);

        const rows = expected.map((tool) => {
          const c = control.find((r) => r.tool === tool);
          const f = frozen.find((r) => r.tool === tool);
          return { tool, control: c?.status ?? "missing", frozen: f?.status ?? "missing", frozenAtExecute: f?.frozenAtExecute ?? null, error: f?.error ?? c?.error ?? null };
        });
        console.log(`\nfrozen-args (${pass.name}):`);
        for (const r of rows)
          console.log(
            `  ${r.tool.padEnd(12)} control=${r.control.padEnd(9)} frozen=${r.frozen.padEnd(9)} tool saw frozen args=${r.frozenAtExecute ?? "n/a"}` +
              (r.error ? `  (${r.error.slice(0, 120).replace(/\s+/g, " ")})` : ""),
          );

        for (const r of rows) {
          expect({ tool: r.tool, status: r.frozen }).toEqual({ tool: r.tool, status: r.control });
          expect(r.control).not.toBe("missing");
          if (r.frozen === "completed") expect({ tool: r.tool, frozenAtExecute: r.frozenAtExecute }).toEqual({ tool: r.tool, frozenAtExecute: true });
        }
      },
      240_000,
    );
  }
});
