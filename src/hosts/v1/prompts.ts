import type { ArmorHost } from "../../host.ts";
import type { SessionID } from "../../types.ts";

// Ignored command replies do not start model turns.
export function promptMessage(host: ArmorHost, input: { sessionID: string; messageID?: string }, output: {
  message: { id: string };
  parts: readonly { type: string; text?: string; ignored?: boolean }[];
}): void {
  if (output.parts.length > 0 && output.parts.every(part => part.type === "text" && part.ignored)) return;
  const text = output.parts.map(part => part.type === "text" && !part.ignored ? part.text ?? "" : "").join("\n");
  host.userPrompt({ sessionId: input.sessionID as SessionID, messageId: input.messageID ?? output.message.id, text });
}
