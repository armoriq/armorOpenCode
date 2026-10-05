import type { PendingRecord } from "./types.ts";

export interface TransportResult {
  ok: boolean;
  status: number;
  accepted: number;
  error?: string;
}

/** P1 deliberately has no network implementation. P3 can implement this seam. */
export interface TelemetryTransport {
  send(records: readonly PendingRecord[], signal?: AbortSignal): Promise<TransportResult>;
}

export class DisabledTransport implements TelemetryTransport {
  async send(): Promise<TransportResult> {
    return { ok: false, status: 0, accepted: 0, error: "Telemetry transport is disabled." };
  }
}

export function hasCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.ARMORIQ_API_KEY === "string" && env.ARMORIQ_API_KEY.trim().length > 0;
}
