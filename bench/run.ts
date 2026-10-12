// Latency bench: real `opencode run` sessions against the stub model, with the plugin wrapped by
// the timing shim. Budgets are docs/architecture.md section 6. Exits 1 on a breach or a broken run.
//
//   bun bench/run.ts [--noop | --target plugin.ts] [--sessions 3] [--calls 40] [--case small,write-1mb,policy-50] [--json out.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, fileUrl, REPO_ROOT } from "./lib/opencode.ts";
import { seedCredentials } from "./lib/login.ts";
import { policyWithRules } from "./lib/policy.ts";
import { startStubBackend } from "./lib/stub-backend.ts";
import { startStubModel, type Script } from "./lib/stub-model.ts";
import type { Sample } from "./lib/timing-shim.ts";

const SMALL_BYTES = 16 * 1024;
const MB = 1024 * 1024;

type Case = { name: string; script: (calls: number) => Script; policyRules?: number };

const smallCall = (step: number) =>
  step % 2 === 0 ? { tool: "read", args: { filePath: `f${(step % 10) + 1}.txt` } } : { tool: "bash", args: { command: "ls", description: "list files" } };

const BIG = "x".repeat(MB);

const CASES: Case[] = [
  { name: "small", script: (calls) => (step) => (step < calls ? smallCall(step) : null) },
  {
    name: "write-1mb",
    script: (calls) => (step) => {
      if (step >= calls) return null;
      return step % 4 === 3 ? { tool: "write", args: { filePath: "big.txt", content: BIG } } : smallCall(step);
    },
  },
  { name: "policy-50", policyRules: 50, script: (calls) => (step) => (step < calls ? smallCall(step) : null) },
];

const REGISTER = "register_intent_plan";
const PLAN = { tool: REGISTER, args: { goal: "bench", steps: ["read", "bash", "write"].map((tool) => ({ action: `use ${tool}`, tool })) } };

// Sessions run logged in against the stub backend, so the plugin is in enforce mode and does its
// full work (decide, audit rows, sanitizing). When the plugin offers the intent tool, the session
// registers a plan covering every benched tool first, so measured calls take the allow path.
const withPlan =
  (inner: Script): Script =>
  (step, offered, prompt) => {
    if (!offered.includes(REGISTER)) return inner(step, offered, prompt);
    return step === 0 ? PLAN : inner(step - 1, offered, prompt);
  };

type Budget = { p50: number; p95: number };

const MIN_GATED_SAMPLES = 20;

// Microseconds. Calls above 16 KB get 2 ms per MB on top (before only; after is reported, not enforced).
// Sized for shared CI runners (before measured about 70 us p50, 350 us p95 there), so a breach means a
// real regression; still about 200 times under ArmorClaude's ~215 ms per tool call.
const BUDGETS: Record<string, Budget> = {
  setup: { p50: 20_000, p95: 50_000 },
  "tool.execute.before": { p50: 250, p95: 1000 },
  "tool.execute.after": { p50: 250, p95: 1000 },
  "chat.message": { p50: 1000, p95: 2000 },
};

type Row = { case: string; hook: string; bucket: string; n: number; p50: number; p95: number; max: number; settleP95: number; budget: Budget | null; pass: boolean };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

function budgetFor(hook: string, bucket: string, maxBytes: number): Budget | null {
  const base = BUDGETS[hook];
  if (!base) return null;
  if (bucket === "small") return base;
  if (hook !== "tool.execute.before") return null;
  const extra = (2000 * Math.max(0, maxBytes - SMALL_BYTES)) / MB;
  return { p50: base.p50 + extra, p95: base.p95 + extra };
}

function summarize(caseName: string, samples: Sample[]): Row[] {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const bucket = s.bytes > SMALL_BYTES ? "large" : "small";
    const key = `${s.hook}\u0000${bucket}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const rows: Row[] = [];
  for (const [key, group] of groups) {
    const [hook = "", bucket = ""] = key.split("\u0000");
    const us = group.map((s) => s.ns / 1000).sort((a, b) => a - b);
    const settle = group.map((s) => s.settleNs / 1000).sort((a, b) => a - b);
    // A p95 of a handful of calls is just the slowest one, often a cold first call; report those instead.
    const budget = group.length >= MIN_GATED_SAMPLES ? budgetFor(hook, bucket, Math.max(...group.map((s) => s.bytes))) : null;
    const p50 = quantile(us, 0.5);
    const p95 = quantile(us, 0.95);
    rows.push({
      case: caseName,
      hook,
      bucket,
      n: us.length,
      p50,
      p95,
      max: us[us.length - 1] ?? 0,
      settleP95: quantile(settle, 0.95),
      budget,
      pass: !budget || (p50 <= budget.p50 && p95 <= budget.p95),
    });
  }
  const order = ["setup", "tool.execute.before", "tool.execute.after", "chat.message", "event"];
  return rows.sort((a, b) => order.indexOf(a.hook) - order.indexOf(b.hook) || a.bucket.localeCompare(b.bucket));
}

function printRows(rows: Row[]): void {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}ms` : `${n.toFixed(1)}us`);
  const header = ["case", "hook", "args", "n", "p50", "p95", "max", "budget p50/p95", "await p95", "result"];
  const lines = rows.map((r) => [
    r.case,
    r.hook,
    r.bucket,
    String(r.n),
    fmt(r.p50),
    fmt(r.p95),
    fmt(r.max),
    r.budget ? `${fmt(r.budget.p50)}/${fmt(r.budget.p95)}` : "report only",
    fmt(r.settleP95),
    r.budget ? (r.pass ? "ok" : "BREACH") : "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]?.length ?? 0)));
  for (const line of [header, ...lines]) console.log(line.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  "));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      noop: { type: "boolean", default: false },
      target: { type: "string" },
      sessions: { type: "string", default: "3" },
      calls: { type: "string", default: "40" },
      case: { type: "string", default: CASES.map((c) => c.name).join(",") },
      json: { type: "string" },
    },
  });
  const sessions = Number(values.sessions);
  const calls = Number(values.calls);
  const wanted = new Set(values.case.split(","));
  const target = values.target
    ? path.resolve(values.target)
    : values.noop
      ? path.join(REPO_ROOT, "bench", "fixtures", "noop-plugin.ts")
      : path.join(REPO_ROOT, "dist", "plugin.js");
  if (!existsSync(target)) {
    console.error(`missing ${target}; run \`bun run build\` first or pass --noop`);
    return 1;
  }
  console.log(`target: ${path.relative(REPO_ROOT, target)}  sessions/case: ${sessions}  tool calls/session: ${calls}`);

  const model = startStubModel();
  const backend = startStubBackend();
  const rows: Row[] = [];
  const failures: string[] = [];
  try {
    for (const c of CASES.filter((c) => wanted.has(c.name))) {
      const sandbox = createSandbox({ modelUrl: model.url, plugins: [fileUrl(path.join(REPO_ROOT, "bench", "lib", "timing-shim.ts"))] });
      try {
        if (c.policyRules) {
          mkdirSync(path.join(sandbox.armoriqHome, "armoropencode"), { recursive: true });
          writeFileSync(path.join(sandbox.armoriqHome, "armoropencode", "policy.json"), JSON.stringify(policyWithRules(c.policyRules)));
        }
        await seedCredentials(sandbox, backend.url);
        const all: Sample[] = [];
        for (let s = 0; s < sessions; s++) {
          model.setScript(withPlan(c.script(calls)));
          model.reset();
          backend.reset();
          const out = path.join(sandbox.root, `samples-${s}.json`);
          const run = await sandbox.run("go", { BENCH_TARGET: target, BENCH_OUT: out, ARMORIQ_BACKEND_URL: backend.url });
          const samples: Sample[] = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
          const expected = calls + (model.offeredTools().includes(REGISTER) ? 1 : 0);
          const before = samples.filter((x) => x.hook === "tool.execute.before");
          const denied = before.filter((x) => x.threw).length;
          const results = model.results().length;
          console.log(
            `  ${c.name} session ${s + 1}: exit ${run.exitCode}, ${(run.ms / 1000).toFixed(1)}s, ${before.length} before-hook calls (${denied} denied), ${results} tool results, ${backend.requests().length} backend requests`,
          );
          if (run.exitCode !== 0 || before.length !== expected || results !== expected || denied > 0) {
            failures.push(
              `${c.name} session ${s + 1}: exit ${run.exitCode}, ${before.length}/${expected} hook calls, ${denied} denied, ${results}/${expected} tool results\n${run.output.slice(-2000)}`,
            );
          }
          all.push(...samples);
        }
        rows.push(...summarize(c.name, all));
      } finally {
        sandbox.dispose();
      }
    }
  } finally {
    model.stop();
    backend.stop();
  }

  console.log("");
  printRows(rows);
  if (values.json) writeFileSync(values.json, JSON.stringify({ target, sessions, calls, rows, failures }, null, 2));
  for (const f of failures) console.error(`\nrun failed: ${f}`);
  const breaches = rows.filter((r) => !r.pass);
  if (breaches.length) console.error(`\n${breaches.length} budget breach(es)`);
  return failures.length || breaches.length ? 1 : 0;
}

process.exit(await main());
