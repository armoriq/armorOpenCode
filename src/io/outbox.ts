import type { Log } from "../types.ts";

export type SendResult<T> =
  | { ok: true; rejected: readonly { item: T; error: string }[] }
  | { ok: false; retryAfterMs?: number; relogin?: boolean };

export interface Outbox<T> {
  enqueue(item: T): void;
  drain(send: (batch: readonly T[]) => Promise<SendResult<T>>, maxBatch: number): Promise<"empty" | "more" | "blocked">;
  persist(): Promise<void>;
}

// One file per process (pid + nonce); appends coalesced within 100 ms; orphans adopted under a lock.
export function createOutbox<T>(dir: string, name: string, log: Log): Outbox<T> {
  throw new Error("not implemented");
}
