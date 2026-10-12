import { setTimeout as sleep } from "node:timers/promises";
import { MAX_BATCH_ROWS, postAuditBatch, type CallResult } from "../io/backend-audit.ts";
import { createOutbox, type SendResult } from "../io/outbox.ts";
import type { AuditRow, BatchAck, Log, Login, Pump } from "../types.ts";

export type AuditPump = Pump & { enqueue(row: AuditRow): void };

export type PumpTiming = { intervalMs: number; minBackoffMs: number; maxBackoffMs: number; stopBudgetMs: number };
export const DEFAULT_TIMING: PumpTiming = { intervalMs: 5_000, minBackoffMs: 5_000, maxBackoffMs: 600_000, stopBudgetMs: 2_000 };

type Failure = Extract<CallResult<BatchAck>, { ok: false }>;

type DrainState = Awaited<ReturnType<ReturnType<typeof createOutbox>["drain"]>>;

// The backend rejects a row that fails CreateAuditLogDto with this prefix; resending cannot help.
const isPermanent = (error: string) => error.startsWith("invalid row:");
const tooLarge = (f: Failure) => !f.retryable && !f.relogin;

// Every 5 s and on kick(): outbox -> /iap/audit/batch, up to 200 rows. Rows the backend marks "invalid row:" are dead-lettered;
// other rejected rows are retried up to 10 times first.
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
  let batchSize = MAX_BATCH_ROWS;

  function backoff(retryAfterMs: number | undefined): void {
    failures += 1;
    const ceiling = Math.min(timing.maxBackoffMs, timing.minBackoffMs * 2 ** (failures - 1));
    const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
    blockedUntil = Date.now() + Math.max(jittered, Math.min(retryAfterMs ?? 0, timing.maxBackoffMs));
  }

  function sendable(): Login | null {
    if (Date.now() < blockedUntil) return null;
    const current = login();
    if (!current || reloginKey === current.apiKey) return null;
    reloginKey = null;
    return current;
  }

  async function sendOnce(current: Login): Promise<{ state: DrainState; failure?: Failure; size: number }> {
    let failure: Failure | undefined;
    let size = 0;
    const state = await outbox.drain(async (batch): Promise<SendResult<AuditRow>> => {
      size = batch.length;
      const result = await post(current, batch);
      if (result.ok) {
        batchSize = Math.min(MAX_BATCH_ROWS, batchSize * 2);
        return { ok: true, rejected: result.value.failures.map(({ index, error }) => ({ item: batch[index]!, error, permanent: isPermanent(error) })) };
      }
      failure = result;
      // A lone row still too large counts an attempt and moves behind the rest of the queue.
      if (tooLarge(result) && batch.length === 1) return { ok: true, rejected: [{ item: batch[0]!, error: result.reason }] };
      return { ok: false };
    }, batchSize);
    return { state, failure, size };
  }

  // True when the next batch should go out right away.
  function onFailure(current: Login, f: Failure, size: number): boolean {
    if (f.relogin) {
      reloginKey = current.apiKey;
      deps.relogin?.(f.reason);
      return false;
    }
    if (tooLarge(f) && size > 1) {
      batchSize = Math.ceil(size / 2);
      return true;
    }
    backoff(f.retryAfterMs);
    log.warn("audit send failed, backing off", { reason: f.reason, untilMs: blockedUntil - Date.now() });
    return false;
  }

  async function cycle(): Promise<void> {
    while (!stopped) {
      again = false;
      const current = sendable();
      if (!current) return;
      const { state, failure, size } = await sendOnce(current);
      if (failure) {
        if (onFailure(current, failure, size)) continue;
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
