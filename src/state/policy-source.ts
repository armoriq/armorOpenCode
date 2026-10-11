import type { CompiledPolicy, Log } from "../types.ts";

export interface PolicySource {
  current(): CompiledPolicy;
  stop(): void;
}

// Loads synchronously at setup; watches the file; swaps only after compile succeeds.
export function createPolicySource(path: string, log: Log): PolicySource {
  throw new Error("not implemented");
}
