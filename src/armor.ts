import { createAuditQueue, flushOnce, type AuditRow, type FlushResult } from "./audit-queue.ts";
import type { ArmorConfig } from "./config.ts";
import { decide, type Verdict } from "./guard.ts";
import { loadPolicy } from "./policy.ts";
import { scrub } from "./redact.ts";

export type Log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;

export interface ToolCall {
  tool: string;
  sessionID: string;
  callID: string;
}

export class ArmorBlockedError extends Error {
  override name = "ArmorBlockedError";
}

// The OpenCode-independent core: the plugin adapter only translates hook
// arguments into these calls, so later steps (intent, traces, token usage)
// add methods here rather than logic in the adapter.
export function createArmor(input: {
  config: ArmorConfig;
  log: Log;
  ship: (rows: AuditRow[]) => Promise<void>;
  now?: () => number;
}) {
  const { config, log, ship } = input;
  const now = input.now ?? Date.now;
  const queue = createAuditQueue(config.dataDir);
  const startedAt = new Map<string, number>();

  async function record(row: Omit<AuditRow, "token" | "step_index">): Promise<void> {
    try {
      await queue.append({ token: "", step_index: 0, ...row });
    } catch (error) {
      log("error", "audit append failed", { tool: row.tool, error: String(error) });
    }
  }

  async function beforeTool(call: ToolCall, args: unknown): Promise<Verdict> {
    startedAt.set(call.callID, now());
    const verdict = decide({ mode: config.mode, load: await loadPolicy(config.policyFile), tool: call.tool, args });
    if (verdict.kind === "observe") {
      log("warn", "watch-only mode, would block", { tool: call.tool, sessionID: call.sessionID, reason: verdict.reason });
    }
    if (verdict.kind === "block") {
      log("info", "blocked tool call", { tool: call.tool, sessionID: call.sessionID, reason: verdict.reason });
      throw new ArmorBlockedError(verdict.reason);
    }
    return verdict;
  }

  async function afterTool(call: ToolCall, args: unknown, output: string): Promise<void> {
    const start = startedAt.get(call.callID) ?? now();
    startedAt.delete(call.callID);
    await record({
      action: call.tool,
      tool: call.tool,
      input: scrub(args),
      output: scrub(output),
      status: "success",
      executed_at: new Date(start).toISOString(),
      duration_ms: now() - start,
    });
  }

  // OpenCode skips tool.execute.after when a tool throws, including when
  // beforeTool blocks it, so failures arrive only as tool-part error events.
  async function failedTool(call: ToolCall, args: unknown, error: string, time: { start: number; end: number }) {
    if (!startedAt.delete(call.callID)) return;
    await record({
      action: call.tool,
      tool: call.tool,
      input: scrub(args),
      output: null,
      status: "failed",
      error_message: String(scrub(error)),
      executed_at: new Date(time.start).toISOString(),
      duration_ms: time.end - time.start,
    });
  }

  let flushing = false;
  async function flush(): Promise<FlushResult> {
    if (!config.apiKey) return { kind: "idle" };
    if (flushing) return { kind: "locked" };
    flushing = true;
    try {
      const result = await flushOnce(queue, ship);
      if (result.kind === "failed") log("warn", "audit flush failed, will retry", { error: result.error });
      if (result.kind === "shipped") log("debug", "audit rows shipped", { rows: result.rows });
      return result;
    } catch (error) {
      log("error", "audit flush crashed", { error: String(error) });
      return { kind: "failed", error: String(error) };
    } finally {
      flushing = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    if (!config.apiKey || timer) return;
    timer = setInterval(() => void flush(), config.flushIntervalMs);
    timer.unref?.();
  }

  async function dispose(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = undefined;
    await flush();
  }

  return { beforeTool, afterTool, failedTool, flush, start, dispose, queue };
}

export type Armor = ReturnType<typeof createArmor>;
