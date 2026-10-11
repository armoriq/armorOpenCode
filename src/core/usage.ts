import type { SessionID, StepUsage, TokenUsageEntry } from "../types.ts";

// A step-finish part carries that step's tokens; message.tokens holds only the last step.
export function stepUsageFromPart(part: unknown, modelOf: (messageId: string) => string | null, repo: string): StepUsage | null {
  throw new Error("not implemented");
}

export type HourKey = { sessionId: SessionID; usageDate: string; usageHour: number };

export type HourBucket = HourKey & { repo: string; entries: TokenUsageEntry[]; digest: string };

export function bucketByHour(steps: readonly StepUsage[]): HourBucket[] {
  throw new Error("not implemented");
}
