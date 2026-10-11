import type { RowFailure, Ship } from "./audit-queue.ts";
import type { ArmorConfig } from "./config.ts";
import { isPlainObject } from "./matcher.ts";

export async function postJson(input: {
  config: Pick<ArmorConfig, "apiKey" | "backendEndpoint" | "timeoutMs">;
  path: string;
  body: unknown;
}): Promise<{ status: number; text: string }> {
  const { config, path, body } = input;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers["x-api-key"] = config.apiKey;
  }
  const response = await fetch(`${config.backendEndpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return { status: response.status, text: await response.text() };
}

const isRowFailure = (value: unknown): value is RowFailure =>
  isPlainObject(value) && typeof value.index === "number" && typeof value.error === "string";

// A 200 from /iap/audit/batch can still carry per-row `failures`, so a body
// without that list is treated as a failed send rather than as all-written.
export function createAuditShipper(config: Pick<ArmorConfig, "apiKey" | "backendEndpoint" | "timeoutMs">): Ship {
  return async (rows) => {
    const { status, text } = await postJson({ config, path: "/iap/audit/batch", body: { rows } });
    if (status < 200 || status >= 300) throw new Error(`POST /iap/audit/batch returned ${status}: ${text.slice(0, 200)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!isPlainObject(body) || !Array.isArray(body.failures) || !body.failures.every(isRowFailure)) {
      throw new Error(`POST /iap/audit/batch returned ${status} without a failures list: ${text.slice(0, 200)}`);
    }
    return { failures: body.failures };
  };
}
