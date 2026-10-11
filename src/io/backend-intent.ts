import type { Login, Plan, SessionID, Token } from "../types.ts";
import type { CallResult } from "./backend-audit.ts";

export type Minted = { planId: string; token: Token };

// SDK capturePlan + getIntentToken with the plan attached; 5 s timeout, 1 retry. 401 -> refused revoked, 402 -> refused billing.
export async function mintToken(login: Login, plan: Omit<Plan, "id">, sessionId: SessionID): Promise<CallResult<Minted>> {
  throw new Error("not implemented");
}

export async function reanchor(login: Login, planId: string, reason: string): Promise<CallResult<void>> {
  throw new Error("not implemented");
}

export async function revoke(login: Login, planId: string, reason: string): Promise<CallResult<void>> {
  throw new Error("not implemented");
}
