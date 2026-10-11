// Loaded by OpenCode as the only plugin. Wraps the plugin named by BENCH_TARGET and records
// the time spent inside each of its hooks. Samples are written to BENCH_OUT on idle and dispose.
//
// `ns` is the synchronous time from calling the hook until it returns its promise. That is the
// budgeted quantity: hook work is synchronous by design (docs/architecture.md section 6), and
// time measured across the await includes whatever else OpenCode has queued on the event loop,
// which reached 60 ms for an empty event hook. `settleNs` keeps that await-inclusive time.
import { writeFileSync } from "node:fs";

export type Sample = { hook: string; tool: string | null; bytes: number; ns: number; settleNs: number; threw: boolean };

type Fn = (...args: any[]) => any;

const samples: Sample[] = [];
const out = process.env.BENCH_OUT;

function flush(): void {
  if (out) writeFileSync(out, JSON.stringify(samples));
}

function argBytes(hook: string, args: any[]): number {
  if (hook !== "tool.execute.before" && hook !== "tool.execute.after") return 0;
  try {
    return JSON.stringify(args[hook === "tool.execute.before" ? 1 : 0]?.args ?? {}).length;
  } catch {
    return -1;
  }
}

function label(hook: string, args: any[]): string | null {
  if (hook === "event") return args[0]?.event?.type ?? null;
  return args[0]?.tool ?? null;
}

function isIdle(e: any): boolean {
  return e?.type === "session.idle" || (e?.type === "session.status" && e.properties?.status?.type === "idle");
}

function wrap(hook: string, fn: Fn): Fn {
  return async (...args: any[]) => {
    let threw = false;
    let ns = 0;
    const t0 = process.hrtime.bigint();
    try {
      const pending = fn(...args);
      ns = Number(process.hrtime.bigint() - t0);
      return await pending;
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      const settleNs = Number(process.hrtime.bigint() - t0);
      samples.push({ hook, tool: label(hook, args), bytes: argBytes(hook, args), ns: ns || settleNs, settleNs, threw });
      if (hook === "event" && isIdle(args[0]?.event)) flush();
    }
  };
}

async function loadTarget(): Promise<Fn> {
  const target = process.env.BENCH_TARGET;
  if (!target) throw new Error("BENCH_TARGET is not set");
  const mod = await import(target);
  const server = mod.default?.server ?? Object.values(mod).find((v) => typeof v === "function");
  if (typeof server !== "function") throw new Error(`no server plugin in ${target}`);
  return server as Fn;
}

export const TimingShim = async (input: unknown, options: unknown) => {
  const server = await loadTarget();
  const t0 = process.hrtime.bigint();
  const hooks = (await server(input, options)) as Record<string, unknown>;
  const setupNs = Number(process.hrtime.bigint() - t0);
  samples.push({ hook: "setup", tool: null, bytes: 0, ns: setupNs, settleNs: setupNs, threw: false });

  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(hooks)) wrapped[name] = typeof value === "function" ? wrap(name, value as Fn) : value;
  const dispose = wrapped.dispose as Fn | undefined;
  wrapped.dispose = async () => {
    try {
      await dispose?.();
    } finally {
      flush();
    }
  };
  return wrapped;
};

export default { id: "armoropencode-bench-shim", server: TimingShim };
