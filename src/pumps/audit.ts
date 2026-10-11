import { setTimeout as sleep } from "node:timers/promises";
import { MAX_BATCH_ROWS, postAuditBatch, type CallResult } from "../io/backend-audit.ts";
import { createOutbox, type SendResult } from "../io/outbox.ts";
import type { AuditRow, BatchAck, Log, Login, Pump } from "../types.ts";

export type AuditPump = Pump & { enqueue(row: AuditRow): void };

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 200 };

type Failure = Extract<CallResult<BatchAck>, { ok: false }>;

// The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
const isPermanent = (error: string) => error.startsWith("invalid row:");

// Every 5 s and on kick(): outbox -> /iap/audit/batch, up to 200 rows; rejected rows retried up to 10 times, then dead-lettered.
export function createAuditPump(deps: {
  dataDir: string;
  login: () => Login | null;
  log: Log;
  relogin?: (reason: string) => void;
  timing?: Partial<PumpTiming>;
  post?: typeof postAuditBatch;
}): AuditPump {
  const { login, log } = deps;
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const post = deps.post ?? postAuditBatch;
  const outbox = createOutbox<AuditRow>(deps.dataDir, "audit", log);
  let interval: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let failures = 0;
  let blockedUntil = 0;
  let reloginKey: string | null = null;

  function backoff(retryAfterMs: number | undefined): void {
    failures += 1;
    const ceiling = Math.min(timing.maxBackoffMs, timing.minBackoffMs * 2 ** (failures - 1));
    const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
    blockedUntil = Date.now() + Math.max(jittered, retryAfterMs ?? 0);
  }

  async function cycle(): Promise<void> {
    while (!stopped) {
      again = false;
      if (Date.now() < blockedUntil) return;
      const current = login();
      if (!current) return;
      if (reloginKey !== null) {
        if (reloginKey === current.apiKey) return;
        reloginKey = null;
      }
      const last: { failure?: Failure } = {};
      const state = await outbox.drain(async (batch): Promise<SendResult<AuditRow>> => {
        const result = await post(current, batch);
        if (!result.ok) {
          last.failure = result;
          return { ok: false, retryAfterMs: result.retryAfterMs, relogin: result.relogin };
        }
        const rejected = result.value.failures.flatMap(({ index, error }) => {
          const item = batch[index];
          return item ? [{ item, error, permanent: isPermanent(error) }] : [];
        });
        return { ok: true, rejected };
      }, MAX_BATCH_ROWS);

      const f = last.failure;
      if (state === "blocked" && f) {
        if (f.relogin) {
          reloginKey = current.apiKey;
          deps.relogin?.(f.reason);
          return;
        }
        backoff(f.retryAfterMs);
        log.warn("audit send failed, backing off", { reason: f.reason, untilMs: blockedUntil - Date.now() });
        return;
      }
      failures = 0;
      if (state !== "more" && !again) return;
    }
  }

  function kick(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = cycle()
      .catch((error) => log.error("audit pump failed", { error: String(error) }))
      .finally(() => {
        running = null;
      });
  }

  return {
    enqueue: (row) => outbox.enqueue(row),
    start() {
      if (interval || stopped) return;
      interval = setInterval(kick, timing.intervalMs);
      interval.unref?.();
      kick();
    },
    kick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      await Promise.race([outbox.persist(), sleep(timing.stopBudgetMs, undefined, { ref: false })]);
    },
  };
}
