import type { Log, Login, Pump } from "../types.ts";
import type { SessionStore } from "../state/sessions.ts";

// Refresh 60 s before expiry; revoke on close. Never on the tool-call path.
export function createTokenPump(deps: { sessions: SessionStore; login: () => Login | null; log: Log }): Pump & { revoke(sessionId: string): void } {
  throw new Error("not implemented");
}
