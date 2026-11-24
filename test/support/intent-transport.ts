import type { InternalAxiosRequestConfig } from "axios";
import { createRequire } from "node:module";

const axios: typeof import("axios").default = createRequire(import.meta.resolve("@armoriq/sdk-dev"))("axios").default;

// The real SDK runs against an Axios adapter so these transport tests need no listening socket.
export function intentTransport(options: { replayByKey?: boolean } = {}) {
  const original = axios.defaults.adapter;
  const requests: { headers: Record<string, string>; body: any; url: string; timeout: number }[] = [];
  const queue: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; run?: () => Promise<void> }> = [];
  let sequence = 0;
  const ledger = new Map<string, unknown>();
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    requests.push({ headers: config.headers.toJSON() as Record<string, string>, body: JSON.parse(config.data), url: config.url!, timeout: config.timeout! });
    const next = queue.shift() ?? {};
    await next.run?.();
    const body = requests.at(-1)!.body;
    const key = String(config.headers.get("Idempotency-Key"));
    const data = options.replayByKey && ledger.has(key) ? ledger.get(key) : next.body ?? {
      success: true, plan_id: `counted-${++sequence}`, kind: config.headers.get("X-ArmorIQ-Plan-Kind"),
      parent_plan_id: config.headers.get("X-ArmorIQ-Parent-Plan-Id") ?? null, prompt_id: config.headers.get("X-ArmorIQ-Prompt-Id"),
      token: { signature: "test-signature", expires_at: (Date.now() + body.expires_in * 1000) / 1000 },
    };
    if (options.replayByKey && config.url?.endsWith("/token") && (next.status ?? 200) < 400) ledger.set(key, data);
    return {
      config, status: next.status ?? 200, statusText: "test", headers: next.headers ?? {},
      data,
    };
  };
  return { requests, queue, restore: () => { axios.defaults.adapter = original; } };
}
