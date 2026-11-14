import { stepUsage } from "../../src/core/usage.ts";
import { toHostEvent } from "../../src/hosts/v1/events.ts";
import type { StepUsage } from "../../src/types.ts";

// An OpenCode 1.x step-finish part through the real V1 event parser and the core usage mapping.
export function stepUsageFromPart(part: unknown, modelOf: (messageId: string) => string | null, repo: string, at = Date.now()): StepUsage | null {
  const event = toHostEvent({ type: "message.part.updated", properties: { part } }, repo);
  if (event?.kind !== "step_finished") return null;
  return stepUsage(event.step, modelOf(event.step.messageId), at);
}
