import type { Mode, Plan, Session, SessionID, Token } from "../types.ts";

export interface SessionStore {
  has(id: SessionID): boolean;
  open(id: SessionID, parentId: SessionID | null, mode: Mode): Session;
  get(id: SessionID): Session;
  root(id: SessionID): Session;
  setPlan(id: SessionID, plan: Plan, token: Token): void;
  setToken(id: SessionID, token: Token): void;
  beginMessage(id: SessionID, messageId: string): void;
  advance(id: SessionID, stepIndex: number): void;
  close(id: SessionID): void;
  all(): Iterable<Session>;
  flush(): Promise<void>;
}

// In-memory owner of all session state; per-session snapshot files written in the background.
export function createSessionStore(dir: string, defaultMode: () => Mode): SessionStore {
  throw new Error("not implemented");
}
