import type { Log, Login } from "../types.ts";

export const PRODUCT = "armoropencode";

export interface Credentials {
  current(): Login | null;
  markRelogin(reason: string): void;
  stop(): void;
}

// SDK loadLoginContext + ~/.armoriq/device-id, read at setup and on file change; current() never touches disk.
export function createCredentials(log: Log): Credentials {
  throw new Error("not implemented");
}
