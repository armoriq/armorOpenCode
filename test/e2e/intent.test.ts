// Intent scenarios through real `opencode run`: a scripted stub model makes the tool calls, a
// logging stub backend answers ArmorIQ. Assertions cover what the model saw and every request made.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStubBackend, type StubBackend } from "../../bench/lib/stub-backend.ts";
import { startStubModel, type ScriptedCall, type StubModel } from "../../bench/lib/stub-model.ts";
import { coreReady, DIST_PLUGIN, HAVE_OPENCODE, resultFor, routes, runScenario, STANDIN_PLUGIN } from "./harness.ts";

const TIMEOUT = 120_000;

const plan = (...tools: string[]): ScriptedCall => ({
  tool: "register_intent_plan",
  args: { goal: "list the project files", steps: tools.map((tool) => ({ action: `use ${tool}`, tool })) },
});
const bash: ScriptedCall = { tool: "bash", args: { command: "ls", description: "list files" } };
const write: ScriptedCall = { tool: "write", args: { filePath: "drift.txt", content: "should never be written" } };

const core = await coreReady();
const SKIP_REASON = `core lanes not landed (${core.missing.join(", ")} still throw "not implemented")`;
if (HAVE_OPENCODE && !core.ready) console.warn(`intent.test.ts: dist/plugin.js scenarios skipped: ${SKIP_REASON}`);

let model: StubModel;
let backend: StubBackend;

beforeAll(async () => {
  model = startStubModel();
  backend = startStubBackend();
  if (core.ready && HAVE_OPENCODE) {
    const build = Bun.spawnSync([process.execPath, "run", "build"], { stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
  }
});

afterAll(() => {
  model?.stop();
  backend?.stop();
});

describe.skipIf(!HAVE_OPENCODE)("harness plumbing (stand-in plugin)", () => {
  test(
    "register, in-plan bash runs, off-plan write is blocked and audited",
    async () => {
      backend.reset();
      const { run, results } = await runScenario({ model, backend, plugin: STANDIN_PLUGIN, calls: [plan("bash"), bash, write] });

      expect(run.exitCode).toBe(0);
      expect(resultFor(results, "register_intent_plan")[0]?.content).toContain("Plan registered: plan-1");
      expect(resultFor(results, "bash")[0]?.content).toContain("f1.txt");
      expect(resultFor(results, "write")[0]?.content).toContain("ArmorIQ blocked this call [intent_drift]");

      expect(routes(backend)).toEqual(["POST /iap/sdk/token", "POST /iap/audit/batch"]);
      const [mint, audit] = backend.requests() as [any, any];
      expect(mint.body.plan.steps).toEqual([{ action: "use bash", tool: "bash" }]);
      expect(audit.body.rows.map((r: any) => [r.tool, r.status, r.plan_id ?? null])).toEqual([
        ["bash", "success", "plan-1"],
        ["write", "blocked", null],
      ]);
    },
    TIMEOUT,
  );

  test(
    "a call before any plan is blocked as intent_plan_missing",
    async () => {
      backend.reset();
      const { results } = await runScenario({ model, backend, plugin: STANDIN_PLUGIN, calls: [bash] });
      expect(resultFor(results, "bash")[0]?.content).toContain("[intent_plan_missing]");
      expect(routes(backend)).toEqual(["POST /iap/audit/batch"]);
    },
    TIMEOUT,
  );
});

// Expectations below encode docs/architecture.md sections 2, 5 and 6 and the design doc. The
// register_intent_plan argument shape ({goal, steps[{action, tool}]}) and the backend URL variable
// (ARMORIQ_BACKEND_URL, as ArmorClaude) are assumptions to confirm when the intent lane lands.
describe.skipIf(!HAVE_OPENCODE || !core.ready)(`ArmorOpenCode intent scenarios${core.ready ? "" : `: skipped, ${SKIP_REASON}`}`, () => {
  const scenario = (calls: ScriptedCall[]) => runScenario({ model, backend, plugin: DIST_PLUGIN, calls });

  test(
    "in-plan call is allowed and audited with the plan id; drift is blocked without one",
    async () => {
      backend.reset();
      const { run, results } = await scenario([plan("bash"), bash, write]);

      expect(run.exitCode).toBe(0);
      expect(resultFor(results, "bash")[0]?.content).toContain("f1.txt");
      expect(resultFor(results, "write")[0]?.content).toContain("ArmorIQ blocked this call [intent_drift]");

      const mints = backend.requests().filter((r) => r.path === "/iap/sdk/token");
      expect(mints).toHaveLength(1);
      expect(JSON.stringify(mints[0]?.body)).toContain('"bash"');
      expect(routes(backend)).not.toContain("POST /iap/enforce");
      expect(routes(backend)).not.toContain("POST /iap/verify-step");

      const rows = backend.requests().filter((r) => r.path === "/iap/audit/batch").flatMap((r: any) => r.body.rows);
      const byTool = (tool: string) => rows.filter((r: any) => r.tool === tool);
      expect(byTool("bash").map((r: any) => r.status)).toEqual(["success"]);
      expect(byTool("bash")[0].plan_id).toBe("plan-1");
      expect(byTool("write").map((r: any) => r.status)).toEqual(["blocked"]);
      expect(byTool("write")[0].plan_id).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "a planless session is blocked as intent_plan_missing",
    async () => {
      backend.reset();
      const { results } = await scenario([bash]);
      expect(resultFor(results, "bash")[0]?.content).toContain("[intent_plan_missing]");
      expect(routes(backend)).not.toContain("POST /iap/sdk/token");
    },
    TIMEOUT,
  );

  test(
    "a revision in the same message reanchors with the model's reason",
    async () => {
      backend.reset();
      const revised = { ...plan("bash", "write"), args: { ...plan("bash", "write").args, reason: "also need to write the summary" } };
      const { results } = await scenario([plan("bash"), revised, write]);
      expect(resultFor(results, "write")[0]?.content).not.toContain("ArmorIQ blocked");
      const reanchor = backend.requests().filter((r) => r.path === "/iap/trust/reanchor");
      expect(reanchor).toHaveLength(1);
      expect(JSON.stringify(reanchor[0]?.body)).toContain("also need to write the summary");
    },
    TIMEOUT,
  );

  for (const [status, code] of [
    [401, "account_revoked"],
    [402, "billing_blocked"],
  ] as const) {
    test(
      `${status} from the token endpoint blocks calls as ${code}`,
      async () => {
        backend.reset();
        backend.on("POST /iap/sdk/token", { status });
        const { results } = await scenario([plan("bash"), bash]);
        expect(resultFor(results, "bash")[0]?.content).toContain(`[${code}]`);
      },
      TIMEOUT,
    );
  }

  test(
    "a 3 s backend still mints inside the 5 s bound",
    async () => {
      backend.reset();
      backend.on("POST /iap/sdk/token", { delayMs: 3000 });
      const { results } = await scenario([plan("bash"), bash]);
      expect(resultFor(results, "bash")[0]?.content).toContain("f1.txt");
    },
    TIMEOUT,
  );

  test(
    "turn end ships usage and traces",
    async () => {
      backend.reset();
      await scenario([plan("bash"), bash]);
      const seen = routes(backend);
      for (const route of ["POST /dashboard/token-usage/stream", "POST /dashboard/token-usage/batch", "GET /observability/policy/lease", "POST /v1/traces"])
        expect(seen).toContain(route);
      for (const r of backend.requests()) expect(r.authorization ?? "").toContain("ak_test_e2e");
    },
    TIMEOUT,
  );
});
