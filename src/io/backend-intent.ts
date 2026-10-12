import type { Login, Plan, SessionID, Token } from "../types.ts";
import type { CallResult } from "./backend-audit.ts";

export type Minted = { planId: string; token: Token };

export const AGENT_ID = "opencode";
export const TOKEN_VALIDITY_SECONDS = 3600;
const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;

type Sdk = typeof import("@armoriq/sdk-dev");
type Client = InstanceType<Sdk["ArmorIQClient"]>;
type Seen = { status?: number; body?: unknown };

let sdkPromise: Promise<Sdk> | null = null;
const loadSdk = () => (sdkPromise ??= import("@armoriq/sdk-dev"));

// SDK capturePlan + getIntentToken with the plan attached; 5 s timeout, 1 retry. 401 -> refused revoked, 402 -> refused billing.
export async function mintToken(login: Login, plan: Omit<Plan, "id">, sessionId: SessionID): Promise<CallResult<Minted>> {
  return withRetry<Minted>(login, async (client) => {
    const capture = client.capturePlan(AGENT_ID, plan.goal, toSdkPlan(plan), {
      source: AGENT_ID,
      session_id: sessionId,
      plan_hash: plan.hash,
      revision: plan.revision,
    });
    const token = await client.getIntentToken(capture, undefined, TOKEN_VALIDITY_SECONDS);
    const validation = (token.policyValidation ?? {}) as Record<string, unknown>;
    // The SDK already substitutes a local expiry when the backend sends none, so a non-number here is a malformed reply.
    const expiresAtSec = Number(token.expiresAt);
    if (!token.planId) throw new Error("token response has no plan_id");
    if (!Number.isFinite(expiresAtSec)) throw new Error(`token response has an invalid expires_at: ${String(token.expiresAt)}`);
    return {
      planId: token.planId,
      token: {
        status: "active",
        // No check reads jwt; it is kept with the token, and the signature stands in when the backend sends no jwt_token.
        jwt: token.jwtToken || token.signature,
        expiresAt: Math.round(expiresAtSec * 1000),
        deniedTools: new Set(stringList(validation.denied_tools)),
        heldTools: new Set(stringList(validation.held_tools)),
      },
    };
  }, (status) => {
    if (status === 401) return { ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" } } };
    if (status === 402) return { ok: true, value: { planId: "", token: { status: "refused", code: "billing_blocked" } } };
    return null;
  });
}

export async function reanchor(
  login: Login,
  planId: string,
  newPlan: Omit<Plan, "id">,
  reason: string,
): Promise<CallResult<{ trustId: string | null }>> {
  return withRetry(login, async (client) => {
    const result = await client.reanchor(minimalToken(planId), toSdkPlan(newPlan), reason, { planId });
    return { trustId: typeof result?.trustId === "string" ? result.trustId : null };
  });
}

export async function revoke(login: Login, planId: string, reason: string): Promise<CallResult<void>> {
  return withRetry(login, async (client) => {
    await client.revoke(minimalToken(planId), reason, { planId, cascade: true });
  });
}

export function toSdkPlan(plan: Omit<Plan, "id">): Record<string, unknown> {
  return {
    goal: plan.goal,
    steps: plan.steps.map((s) => ({
      action: s.tool,
      tool: s.tool,
      mcp: AGENT_ID,
      description: s.action,
      metadata: s.params ? { inputs: s.params } : {},
    })),
    metadata: { goal: plan.goal, source: "opencode-registered", plan_hash: plan.hash },
  };
}

// The SDK reads only planId and rawToken from the token on these routes; the backend resolves the rest from planId.
function minimalToken(planId: string) {
  return {
    tokenId: planId,
    planHash: "",
    planId,
    signature: planId,
    issuedAt: 0,
    expiresAt: 0,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: 0,
    rawToken: undefined as unknown as Record<string, unknown>,
  };
}

async function withRetry<T>(
  login: Login,
  run: (client: Client) => Promise<T>,
  mapStatus?: (status: number) => CallResult<T> | null,
): Promise<CallResult<T>> {
  let sdk: Sdk;
  try {
    sdk = await loadSdk();
  } catch (error) {
    return { ok: false, retryable: false, reason: `sdk unavailable: ${String(error)}` };
  }
  let last: CallResult<T> = { ok: false, retryable: true, reason: "no attempt" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    last = await attemptOnce(sdk, login, run, mapStatus);
    if (last.ok || !last.retryable) return last;
  }
  return last;
}

async function attemptOnce<T>(
  sdk: Sdk,
  login: Login,
  run: (client: Client) => Promise<T>,
  mapStatus?: (status: number) => CallResult<T> | null,
): Promise<CallResult<T>> {
  const controller = new AbortController();
  const seen: Seen = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, TIMEOUT_MS);
  });
  try {
    const client = createClient(sdk, login, controller.signal, seen);
    const running = run(client).then((value) => ({ value }));
    running.catch(() => {});
    const outcome = await Promise.race([running, timedOut]);
    if (outcome === "timeout") return { ok: false, retryable: true, reason: `timed out after ${TIMEOUT_MS} ms` };
    if (seen.status !== undefined && seen.status >= 400) return classify(sdk, seen, mapStatus, "");
    return { ok: true, value: outcome.value };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, retryable: true, reason: `timed out after ${TIMEOUT_MS} ms` };
    return classify(sdk, seen, mapStatus, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

function classify<T>(sdk: Sdk, seen: Seen, mapStatus: ((status: number) => CallResult<T> | null) | undefined, message: string): CallResult<T> {
  const status = seen.status;
  if (status === undefined) return { ok: false, retryable: true, reason: message || "network error" };
  const mapped = mapStatus?.(status);
  if (mapped) return mapped;
  if (sdk.isReloginRequired(status, seen.body)) return { ok: false, retryable: false, relogin: true, reason: "relogin_required" };
  const detail = bodyMessage(seen.body) || message || `HTTP ${status}`;
  return { ok: false, retryable: status >= 500 || status === 429, reason: `HTTP ${status}: ${detail}` };
}

function createClient(sdk: Sdk, login: Login, signal: AbortSignal, seen: Seen): Client {
  // maxRetries is read by the SDK constructor but missing from its declared options; retries are ours.
  const options = { apiKey: login.apiKey, backendEndpoint: login.backend, userId: login.userId, agentId: AGENT_ID, timeout: TIMEOUT_MS, maxRetries: 0 };
  const client = new sdk.ArmorIQClient(options as ConstructorParameters<Sdk["ArmorIQClient"]>[0]);
  // A fresh client per attempt keeps the abort signal and the observed status private to this call.
  const http = client._sessionInternals().httpClient;
  http.defaults.signal = signal;
  http.interceptors.response.use((response: { status: number; data: unknown }) => {
    seen.status = response.status;
    seen.body = response.data;
    return response;
  });
  return client;
}

function bodyMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string") return m.slice(0, 200);
    if (Array.isArray(m)) return m.join("; ").slice(0, 200);
  }
  return "";
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
