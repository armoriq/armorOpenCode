import type { Login } from "../types.ts";
import type { HourBucket } from "../core/usage.ts";
import type { CallResult } from "./backend-audit.ts";

// SDK initializeUsageStream / recordTokenUsageBatch; generation and revisions allocated under the shared lock.
export async function sendUsage(login: Login, buckets: readonly HourBucket[]): Promise<CallResult<{ applied: number }>> {
  throw new Error("not implemented");
}
