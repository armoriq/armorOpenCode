import type { Log, Login, PendingPlanRequest, Plan, PlanKind, Token } from "../types.ts";
import { toSdkPlan } from "../core/plan-request.ts";
import type { CallResult } from "./backend-audit.ts";
import { CLIENT } from "./credentials.ts";

export type Minted = { planId: string; token: Token; kind?: PlanKind; legacy: boolean };

export const AGENT_ID = "opencode";
export const REQUEST_DEADLINE_MS = 40_000;
const TIMEOUT_MS = 5000;
const TOKEN_TIMEOUT_MS = 20_000;
const ATTEMPTS = 2;

type Sdk = typeof import("@armoriq/sdk-dev");
type Client = InstanceType<Sdk["ArmorIQClient"]>;
type Seen = { status?: number; body?: unknown; retryAfter?: string; now: () => number };
export type RetryOptions = { now?: () => number; sleep?: (ms: number) => Promise<void>; cancelled?: () => boolean };

let sdkPromise: Promise<Sdk> | null = null;
const loadSdk = () => (sdkPromise ??= import("@armoriq/sdk-dev"));
const legacyLogged = new WeakSet<Log>();

export function logLegacyBackend(log: Log): void {
  if (legacyLogged.has(log)) return;
  legacyLogged.add(log);
  log.warn("backend does not support the plan capture contract");
}

// The persisted descriptor is the only source of the token request body and contract headers.
export async function mintToken(login: Login, request: PendingPlanRequest, options: RetryOptions = {}): Promise<CallResult<Minted>> {
  return withRetry<Minted>(login, async (client, timeoutMs) => {
    const body = request.body;
    const capture = client.capturePlan(AGENT_ID, String((body.plan as Record<string, unknown>).goal), body.plan as Record<string, unknown>);
    const token = await client.getIntentToken(capture, body.policy as Record<string, unknown> | undefined, Number(body.expires_in), {
      contextId: String(body.context_id),
      idempotencyKey: request.key,
      planKind: request.headers["X-ArmorIQ-Plan-Kind"] as PlanKind,
      parentPlanId: request.headers["X-ArmorIQ-Parent-Plan-Id"],
      promptId: request.headers["X-ArmorIQ-Prompt-Id"],
      timeoutMs,
    });
    const validation = (token.policyValidation ?? {}) as Record<string, unknown>;
    // An unresolved backend policy has no opinion about these tools.
    const backendChecked = validation.validated !== false;
    const expiresAtSec = Number((token.rawToken?.token as { expires_at?: unknown } | undefined)?.expires_at);
    if (typeof token.planId !== "string" || !token.planId) throw new Error("token response has no plan_id");
    if (!Number.isFinite(expiresAtSec) || expiresAtSec * 1000 <= Date.now()) throw new Error("token response has no usable expiry");
    if (!token.jwtToken && !token.signature) throw new Error("token response has no usable token");
    if (token.kind !== undefined && token.kind !== request.headers["X-ArmorIQ-Plan-Kind"]) throw new Error("token response has a different plan kind");
    return {
      planId: token.planId,
      kind: token.kind as PlanKind | undefined,
      legacy: token.kind === undefined,
      token: {
        status: "active",
        jwt: token.jwtToken || token.signature,
        expiresAt: Math.round(expiresAtSec * 1000),
        deniedTools: new Set(backendChecked ? stringList(validation.denied_tools) : []),
        heldTools: new Set(backendChecked ? stringList(validation.held_tools) : []),
      },
    };
  }, (status) => {
    if (status === 401) return { ok: true, value: { planId: "", token: { status: "refused", code: "account_revoked" }, legacy: false } };
    if (status === 402) return { ok: true, value: { planId: "", token: { status: "refused", code: "billing_blocked" }, legacy: false } };
    return null;
  }, options, request);
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
  run: (client: Client, timeoutMs: number) => Promise<T>,
  mapStatus?: (status: number) => CallResult<T> | null,
  options: RetryOptions = {},
  request?: PendingPlanRequest,
): Promise<CallResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + REQUEST_DEADLINE_MS;
  let sdk: Sdk;
  try {
    sdk = await loadSdk();
  } catch {
    return { ok: false, retryable: false, reason: "sdk unavailable" };
  }
  let last: CallResult<T> = { ok: false, retryable: true, reason: "request deadline reached" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (options.cancelled?.()) return { ok: false, retryable: false, reason: "the prompt or authentication changed" };
    const remaining = deadline - now();
    if (remaining <= 0) break;
    last = await attemptOnce(sdk, login, run, Math.min(request ? TOKEN_TIMEOUT_MS : TIMEOUT_MS, remaining), mapStatus, request, now);
    if (last.ok || !last.retryable || attempt + 1 === ATTEMPTS) return last;
    const delay = last.retryAfterMs ?? 0;
    if (delay >= deadline - now()) return last;
    if (delay > 0) await sleep(delay);
  }
  return last;
}

async function attemptOnce<T>(
  sdk: Sdk,
  login: Login,
  run: (client: Client, timeoutMs: number) => Promise<T>,
  timeoutMs: number,
  mapStatus?: (status: number) => CallResult<T> | null,
  request?: PendingPlanRequest,
  now = Date.now,
): Promise<CallResult<T>> {
  const controller = new AbortController();
  const seen: Seen = { now };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, timeoutMs);
  });
  try {
    const client = createClient(sdk, login, controller.signal, seen, timeoutMs, request);
    const running = run(client, timeoutMs).then((value) => ({ value }));
    running.catch(() => {});
    const outcome = await Promise.race([running, timedOut]);
    if (outcome === "timeout") return { ok: false, retryable: true, unreachable: true, reason: `timed out after ${timeoutMs} ms` };
    if (seen.status !== undefined && seen.status >= 400) return classify(sdk, seen, mapStatus, "");
    return { ok: true, value: outcome.value };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, retryable: true, unreachable: true, reason: `timed out after ${timeoutMs} ms` };
    return classify(sdk, seen, mapStatus, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

function classify<T>(sdk: Sdk, seen: Seen, mapStatus: ((status: number) => CallResult<T> | null) | undefined, message: string): CallResult<T> {
  const status = seen.status;
  if (status === undefined) return { ok: false, retryable: true, unreachable: true, reason: message || "network error" };
  if (status < 400) return { ok: false, retryable: false, unconfirmed: true, status, reason: message || "invalid token response" };
  const mapped = mapStatus?.(status);
  if (mapped) return mapped;
  if (sdk.isReloginRequired(status, seen.body)) return { ok: false, retryable: false, relogin: true, status, reason: "relogin_required" };
  const detail = bodyMessage(seen.body) || message || `HTTP ${status}`;
  const code = (seen.body as { error?: unknown } | null)?.error;
  const retryable = status >= 500 || status === 429 || (status === 409 && code === "request_in_progress");
  return { ok: false, retryable, retryAfterMs: parseRetryAfter(seen.retryAfter, seen.now()), status, unreachable: status >= 500, unauthorized: status === 401, reason: `HTTP ${status}: ${detail}` };
}

export function parseRetryAfter(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function createClient(sdk: Sdk, login: Login, signal: AbortSignal, seen: Seen, timeoutMs: number, request?: PendingPlanRequest): Client {
  const options = { apiKey: login.apiKey, backendEndpoint: login.backend, userId: request ? String(request.body.user_id) : login.userId, agentId: AGENT_ID, timeout: timeoutMs, maxRetries: 0, client: CLIENT };
  const client = new sdk.ArmorIQClient(options as ConstructorParameters<Sdk["ArmorIQClient"]>[0]);
  const http = client._sessionInternals().httpClient;
  http.defaults.signal = signal;
  http.interceptors.response.use((response: { status: number; data: unknown; headers?: Record<string, string> }) => {
    seen.status = response.status;
    seen.body = response.data;
    seen.retryAfter = response.headers?.["retry-after"];
    return response;
  }, (error: { response?: { status: number; data: unknown; headers?: Record<string, string> } }) => {
    if (error?.response) {
      seen.status = error.response.status;
      seen.body = error.response.data;
      seen.retryAfter = error.response.headers?.["retry-after"];
    }
    return Promise.reject(error);
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
