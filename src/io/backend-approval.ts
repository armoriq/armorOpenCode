import type { Login } from "../types.ts";
import { authHeaders } from "./backend-audit.ts";
import { AGENT_ID } from "./backend-intent.ts";

export const APPROVAL_TIMEOUT_MS = 5000;

export type HeldCall = { tool: string; args: Readonly<Record<string, unknown>>; planId: string; jwt: string };

export type HoldResolution =
  | { action: "allow"; reason: string }
  | { action: "block"; reason: string }
  | { action: "hold"; requestId: string; reason: string }
  | { action: "hold"; error: string };

type Reply = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

// The backend rejects an enforce whose agent_id differs from the one the intent token was minted for.
export function tokenAgent(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { agent_id?: unknown };
    return typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : AGENT_ID;
  } catch {
    return AGENT_ID;
  }
}

async function send(login: Login, path: string, init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string> }): Promise<Reply> {
  try {
    const res = await fetch(`${login.backend}${path}`, {
      method: init.method,
      headers: { ...authHeaders(login.apiKey), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (res.status < 200 || res.status >= 300) {
      const message = typeof record.message === "string" ? record.message : text.slice(0, 200);
      return { ok: false, error: `${path} answered ${res.status}${message ? `: ${message}` : ""}` };
    }
    return { ok: true, body: record };
  } catch (error) {
    return { ok: false, error: `${path} failed: ${String(error)}` };
  }
}

// Asks the backend for the held call's verdict. It spends an approved request for this exact call and
// plan, so a retry after approval comes back allowed; a call still held gets an approval request.
export async function resolveHold(login: Login, call: HeldCall): Promise<HoldResolution> {
  const enforce = await send(login, "/iap/sdk/enforce", {
    method: "POST",
    body: {
      tool: call.tool,
      mcp: AGENT_ID,
      arguments: call.args,
      intent_token: { jwt_token: call.jwt, plan_id: call.planId },
      agent_id: tokenAgent(call.jwt),
      ...(login.email ? { user_email: login.email } : {}),
    },
  });
  if (!enforce.ok) return { action: "hold", error: enforce.error };
  const verdict = enforce.body;
  const reason = typeof verdict.reason === "string" ? verdict.reason : "";
  if (verdict.allowed === true) return { action: "allow", reason: reason || "allowed" };
  if (verdict.enforcementAction !== "hold") {
    const message = typeof verdict.message === "string" ? verdict.message : "";
    return { action: "block", reason: [message, reason && `(${reason})`].filter(Boolean).join(" ") || "blocked by the backend" };
  }
  if (!login.email) return { action: "hold", error: "the signed-in ArmorIQ profile has no email to file the approval request under" };

  // The backend reuses a pending request for the same plan, tool and arguments, so a retry gets the same id.
  const as = { "X-User-Email": login.email };
  const role = await send(login, "/delegation/my-role", { method: "GET", headers: as });
  const known = role.ok && typeof role.body.role === "string";
  const filed = await send(login, "/delegation/request", {
    method: "POST",
    headers: { ...as, "Idempotency-Key": `armoropencode-${crypto.randomUUID()}` },
    body: {
      tool: call.tool,
      action: "execute",
      arguments: call.args,
      requesterEmail: login.email,
      requesterRole: known ? role.body.role : "agent_user",
      requesterLimit: known && typeof role.body.limit === "number" ? role.body.limit : 0,
      domain: AGENT_ID,
      planId: call.planId,
      reason: reason || `${call.tool} requires approval`,
    },
  });
  if (!filed.ok) return { action: "hold", error: filed.error };
  const id = filed.body.delegationId;
  if (typeof id !== "string" || !id) return { action: "hold", error: "/delegation/request returned no delegationId" };
  return { action: "hold", requestId: id, reason };
}
