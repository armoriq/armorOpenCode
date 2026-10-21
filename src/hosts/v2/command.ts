import { ARMOR_COMMAND } from "../../commands/armor.ts";
import type { ArmorHost } from "../../host.ts";
import type { SessionID } from "../../types.ts";
import type { CommandContext } from "./plugin-api.ts";

const sid = (id: string) => id as SessionID;

export const ARMOR_REPLY_NOTE = "The user ran /armor and ArmorIQ answered it locally. No action is needed.";

// /armor is answered without a model turn: a command that does not prompt starts none. The reply is a
// synthetic message whose description the TUI shows. Synthetic messages reach the model with the next
// prompt, so the replies are dropped from the request context, as V1's ignored part never reached it.
export async function registerArmorCommand(ctx: CommandContext, host: ArmorHost): Promise<void> {
  const replies = new Set<string>();

  await ctx.command.transform((editor) => {
    editor.add({
      name: ARMOR_COMMAND,
      description: "ArmorIQ status and policy (answered locally)",
      execute: async ({ sessionID, prompt }) => {
        const reply = host.armorCommand(sid(sessionID), prompt.text);
        try {
          const message = await ctx.session.synthetic({ sessionID, text: ARMOR_REPLY_NOTE, description: reply, resume: false });
          const id = typeof message === "object" && message !== null && "id" in message ? message.id : undefined;
          if (typeof id === "string") replies.add(id);
        } catch (error) {
          host.log.warn("armor command reply failed", { sessionID, error: String(error) });
        }
        host.log.info("armor command", { sessionID });
      },
    });
  });

  await ctx.session.hook("context", (event) => {
    if (replies.size > 0) event.messages = event.messages.filter((m) => m.id === undefined || !replies.has(m.id));
  });
}
