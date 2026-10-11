import type { ArmorConfig } from "./config.ts";

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

export function createAuditShipper(config: Pick<ArmorConfig, "apiKey" | "backendEndpoint" | "timeoutMs">) {
  return async (rows: unknown[]): Promise<void> => {
    const { status, text } = await postJson({ config, path: "/iap/audit/batch", body: { rows } });
    if (status < 200 || status >= 300) throw new Error(`POST /iap/audit/batch returned ${status}: ${text.slice(0, 200)}`);
  };
}
