import type { PendingRecord } from "./types.ts";
import type { TelemetryTransport, TransportResult } from "./transport.ts";

export interface HttpTelemetryTransportOptions {
  endpoint?: string;
  apiKey?: string;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

function endpointOf(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Telemetry endpoint must use HTTPS or explicit loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Telemetry endpoint must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 15_000;
}

export class HttpTelemetryTransport implements TelemetryTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetcher: NonNullable<HttpTelemetryTransportOptions["fetcher"]>;
  private readonly timeoutMs: number;

  constructor(options: HttpTelemetryTransportOptions = {}) {
    this.endpoint = endpointOf(options.endpoint ?? "https://api.armoriq.io/dashboard/telemetry");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = positiveTimeout(options.timeoutMs);
  }

  async send(records: readonly PendingRecord[], signal?: AbortSignal): Promise<TransportResult> {
    if (records.length === 0) return { ok: true, status: 204, accepted: 0 };
    if (!this.apiKey) return { ok: false, status: 0, accepted: 0, error: "Telemetry API key is missing." };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify({ records: records.map((record) => record.payload) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* retain status as the source of truth */ }
      const accepted = parsed && typeof parsed === "object" && typeof (parsed as { accepted?: unknown }).accepted === "number"
        ? (parsed as { accepted: number }).accepted
        : response.ok ? records.length : 0;
      return { ok: response.ok, status: response.status, accepted, ...(response.ok ? {} : { error: raw.slice(0, 500) || response.statusText }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, accepted: 0, error: message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relayAbort);
    }
  }
}

export function createHttpTelemetryTransport(options: HttpTelemetryTransportOptions = {}): HttpTelemetryTransport {
  return new HttpTelemetryTransport(options);
}
