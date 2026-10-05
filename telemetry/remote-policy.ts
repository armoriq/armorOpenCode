import { toBackendToolName } from "../src/tool-name-map.ts";

export interface RemotePolicyDecision {
  allowed: boolean;
  action: string;
  reason: string;
}

export interface RemotePolicyOptions {
  endpoint?: string;
  apiKey: string;
  token: string;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

function endpointOf(value: string): string {
  const url = new URL(value.replace(/\/$/, ""));
  const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Remote policy endpoint must use HTTPS or explicit loopback HTTP");
  if (url.username || url.password || url.search || url.hash) throw new Error("Remote policy endpoint must not contain credentials, query, or fragment");
  return url.toString();
}

function timeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 8_000;
}

export class RemotePolicyClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly token: string;
  private readonly fetcher: NonNullable<RemotePolicyOptions["fetcher"]>;
  private readonly timeoutMs: number;

  constructor(options: RemotePolicyOptions) {
    this.endpoint = `${endpointOf(options.endpoint ?? "https://api.armoriq.ai")}/iap/enforce`;
    this.apiKey = options.apiKey.trim();
    this.token = options.token.trim();
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = timeout(options.timeoutMs);
  }

  async enforce(tool: string, sessionId: string): Promise<RemotePolicyDecision> {
    if (!this.apiKey || !this.token) return { allowed: false, action: "deny", reason: "Remote policy credentials are missing." };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ token: this.token, tool: toBackendToolName(tool), mcp: "opencode", arguments: {}, step_index: 0, session_id: sessionId }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* malformed responses deny */ }
      if (!response.ok || parsed === null || typeof parsed !== "object") return { allowed: false, action: "deny", reason: `Remote policy denied the tool (HTTP ${response.status}).` };
      const body = parsed as { allowed?: unknown; action?: unknown; reason?: unknown };
      const action = typeof body.action === "string" ? body.action : "deny";
      const allowed = body.allowed === true && action !== "deny" && action !== "block";
      return { allowed, action, reason: typeof body.reason === "string" ? body.reason.slice(0, 240) : allowed ? "Remote policy allowed the tool." : "Remote policy denied the tool." };
    } catch {
      return { allowed: false, action: "deny", reason: "Remote policy could not be reached." };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRemotePolicyClient(options: RemotePolicyOptions): RemotePolicyClient {
  return new RemotePolicyClient(options);
}
