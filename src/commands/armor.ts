import type { Runtime } from "../runtime.ts";

// Returns the reply for an /armor command, or null when the text is not one.
export function handleArmorCommand(text: string, sessionId: string, rt: Runtime): string | null {
  throw new Error("not implemented");
}
