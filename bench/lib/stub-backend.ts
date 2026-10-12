// Logging ArmorIQ backend. Answers the endpoints in docs/architecture.md section 2 with the shapes
// the SDK validates, records every request, and lets a test override status, body or delay per route.

export type Recorded = { method: string; path: string; authorization: string | null; client: string | null; body: unknown; bytes: Buffer; at: number };
export type Override = { status?: number; body?: unknown; delayMs?: number };

export type StubBackend = {
  url: string;
  requests(): readonly Recorded[];
  on(route: string, override: Override): void;
  reset(): void;
  stop(): void;
};

const uuid = () => crypto.randomUUID();

function defaultBody(method: string, path: string, body: any, n: number): unknown {
  const route = `${method} ${path}`;
  if (route === "POST /iap/sdk/token") {
    const now = Math.floor(Date.now() / 1000);
    return {
      success: true,
      plan_id: `plan-${n}`,
      plan_hash: `hash-${n}`,
      intent_reference: `ref-${n}`,
      jwt_token: `jwt-${n}`,
      token: { signature: "sig", issued_at: now, expires_at: now + 3600 },
      step_proofs: [],
      policy_validation: { denied_tools: [], held_tools: [] },
    };
  }
  if (route === "POST /iap/trust/reanchor" || route === "POST /iap/trust/revoke") return { success: true, trustId: `trust-${n}` };
  if (route === "POST /iap/audit/batch") return { written: Array.isArray(body?.rows) ? body.rows.length : 0, orphan: 0, failures: [] };
  if (route === "GET /observability/policy/lease")
    return { captureMode: "metadata", revision: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  if (route === "POST /dashboard/token-usage/stream") return { generation: uuid() };
  if (route === "POST /dashboard/token-usage/batch") {
    const calls = (body?.calls ?? []).reduce((n: number, c: any) => n + c.records.length, 0);
    return {
      results: (body?.snapshots ?? []).map((s: any) => ({ sessionId: s.sessionId, usageDate: s.usageDate, usageHour: s.usageHour, status: "applied" })),
      ...(calls ? { calls: { stored: calls, duplicates: 0 } } : {}),
    };
  }
  if (method === "PUT" && path.startsWith("/dashboard/token-usage/runs/")) return { applied: true, run: { runId: path.split("/").pop() } };
  return {};
}

function routeKey(method: string, path: string): string {
  return method === "PUT" && path.startsWith("/dashboard/token-usage/runs/") ? "PUT /dashboard/token-usage/runs/:id" : `${method} ${path}`;
}

export function startStubBackend(): StubBackend {
  const log: Recorded[] = [];
  const overrides = new Map<string, Override>();
  let n = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const bytes = req.method === "GET" ? Buffer.alloc(0) : Buffer.from(await req.arrayBuffer());
      const raw = bytes.toString();
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = `<${raw.length} bytes, not JSON>`;
      }
      const authorization = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      log.push({ method: req.method, path: url.pathname, authorization, client: req.headers.get("x-armoriq-client"), body, bytes, at: Date.now() });
      const override = overrides.get(routeKey(req.method, url.pathname));
      if (override?.delayMs) await Bun.sleep(override.delayMs);
      const status = override?.status ?? 200;
      return Response.json(override?.body ?? (status === 200 ? defaultBody(req.method, url.pathname, body, ++n) : { message: `stub ${status}` }), { status });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => log,
    on: (route, override) => {
      overrides.set(route, override);
    },
    reset: () => {
      n = 0;
      log.length = 0;
      overrides.clear();
    },
    stop: () => server.stop(true),
  };
}
