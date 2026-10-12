// decide() with a 50-rule policy over a realistic call mix.
// Usage: bun bench/decide.ts   (exits 1 if p95 for small args is 100 us or more)
import type { BuiltinContext } from "../src/core/builtin-rules.ts";
import { decide } from "../src/core/decide.ts";
import { parsePlan } from "../src/core/intent.ts";
import { compilePolicy } from "../src/core/policy.ts";
import type { Session, SessionID, ToolCall } from "../src/types.ts";

const statements: unknown[] = [];
for (let i = 0; i < 20; i++) {
  statements.push({
    id: `deny-cmd-${i}`,
    effect: "forbid",
    action: { type: "tool", eq: "Bash" },
    conditions: [{ field: "bash.raw", op: "matches", value: `\\bdanger${i}\\b.*--force` }],
  });
}
for (let i = 0; i < 10; i++) {
  statements.push({
    id: `hold-path-${i}`,
    effect: "require_approval",
    action: { type: "tool", in: ["Write", "Edit"] },
    conditions: [{ field: "file.path", op: "starts_with", value: `/etc/svc${i}/` }],
  });
}
for (let i = 0; i < 10; i++) {
  statements.push({
    id: `deny-host-${i}`,
    effect: "forbid",
    action: { type: "tool", eq: "*" },
    conditions: [{ field: "network.host", op: "in", value: [`bad${i}.example.com`] }],
  });
}
for (let i = 0; i < 9; i++) {
  statements.push({ id: `deny-mcp-${i}`, effect: "forbid", action: { type: "tool", eq: "*" }, conditions: [{ field: "mcp.server", op: "eq", value: `srv${i}` }] });
}
statements.push({ id: "allow", effect: "permit", action: { type: "tool", eq: "*" } });

const compiled = compilePolicy({ schemaVersion: "armor.policy.v1", defaults: { decision: "deny" }, statements });
if (!compiled.ok) throw new Error(compiled.error);
const policy = compiled.policy;
const parsed = parsePlan(
  { goal: "g", steps: [{ action: "read" }, { action: "edit" }, { action: "bash", metadata: { inputs: { command: "bun test" } } }, { action: "write" }] },
  1,
  "m",
);
if (!parsed.ok) throw new Error(parsed.error);

const root: Session = {
  id: "s" as SessionID,
  parentId: null,
  mode: "enforce",
  plan: { ...parsed.plan, id: "p" },
  token: { status: "active", jwt: "j", expiresAt: Date.now() + 3_600_000, deniedTools: new Set(), heldTools: new Set() },
  stepCursor: 0,
  revisionsThisMessage: 0,
  currentMessageId: "m",
};
const builtin: BuiltinContext = { armoriqDir: "/home/dev/.armoriq", ownTools: new Set(["register_intent_plan"]), shadowedTools: new Set() };

const call = (tool: string, args: Record<string, unknown>): ToolCall => ({ sessionId: root.id, callId: "c", tool, args });
const small = [
  call("bash", { command: "bun test", workdir: "/w" }),
  call("bash", { command: "git status && git diff --stat" }),
  call("read", { filePath: "/w/src/index.ts" }),
  call("edit", { filePath: "/w/src/a.ts", oldString: "const a = 1", newString: "const a = 2" }),
  call("write", { filePath: "/w/src/b.ts", content: "export const b = 1;\n".repeat(200) }),
  call("grep", { pattern: "TODO", path: "/w/src" }),
  call("webfetch", { url: "https://docs.example.com/page" }),
  call("srv3_query", { sql: "select 1" }),
];
const largeWrite = call("write", { filePath: "/w/big.txt", content: "x".repeat(1 << 20) });
const largeBash = call("bash", { command: `echo ${"danger3 ".repeat(1 << 17)}` });

function measure(calls: ToolCall[], n: number): { p50: number; p95: number; max: number } {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = calls[i % calls.length]!;
    const t = performance.now();
    decide({ policy, session: root, root, call: c, now: Date.now(), builtin });
    samples[i] = (performance.now() - t) * 1000;
  }
  samples.sort();
  return { p50: samples[Math.floor(n * 0.5)]!, p95: samples[Math.floor(n * 0.95)]!, max: samples[n - 1]! };
}

measure(small, 20_000);
const s = measure(small, 100_000);
const lw = measure([largeWrite], 200);
const lb = measure([largeBash], 50);
const fmt = (r: { p50: number; p95: number; max: number }) => `p50 ${r.p50.toFixed(1)} us, p95 ${r.p95.toFixed(1)} us, max ${r.max.toFixed(1)} us`;
console.log(`decide(), 50-rule policy, ${small.length} small call shapes x 100000: ${fmt(s)}`);
console.log(`decide(), 50-rule policy, 1 MB write x 200: ${fmt(lw)}`);
console.log(`decide(), 50-rule policy, 1 MB bash command x 50: ${fmt(lb)}`);
if (s.p95 >= 100) process.exit(1);
