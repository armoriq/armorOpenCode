import type { AuditRow, Log, Login, Pump } from "../types.ts";

export type AuditPump = Pump & { enqueue(row: AuditRow): void };

// Every 5 s and on kick(): outbox -> /iap/audit/batch, up to 200 rows; rejected rows retried twice then dropped.
export function createAuditPump(deps: {
  dataDir: string;
  login: () => Login | null;
  log: Log;
  relogin?: (reason: string) => void;
}): AuditPump {
  throw new Error("not implemented");
}
