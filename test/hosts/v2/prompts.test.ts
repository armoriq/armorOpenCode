import { expect, test } from "bun:test";
import { hostFor } from "../../../src/host.ts";
import { registerIntent } from "../../../src/hosts/v2/intent.ts";
import type { IntentContext, SessionHooks } from "../../../src/hosts/v2/plugin-api.ts";
import { Runtime } from "../../../src/runtime.ts";
import type { SessionID } from "../../../src/types.ts";
import { fakeRuntime } from "../../support/intent-harness.ts";

test("a V2 prompt waits for a confirmed root and never starts a subagent prompt", async () => {
  const rt = await fakeRuntime(null);
  Object.assign(rt, {
    sessionCreated: Runtime.prototype.sessionCreated,
    userMessage: Runtime.prototype.userMessage,
    ensureSession: Runtime.prototype["ensureSession"],
    traces: { record() {} },
  });
  const hooks: { [N in keyof SessionHooks]: Array<(e: SessionHooks[N]) => Promise<void> | void> } = { prompt: [], context: [] };
  let unavailable = true;
  const ctx: IntentContext = {
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name, callback) => {
        hooks[name].push(callback);
        return { dispose: async () => {} };
      },
      get: async ({ sessionID }) => {
        if (sessionID === "child" && unavailable) throw new Error("lookup unavailable");
        return { id: sessionID, ...(sessionID === "child" ? { parentID: "root" } : {}) };
      },
    },
  };
  await registerIntent(ctx, hostFor(rt, rt.log));
  const prompt = (sessionID: string, messageID: string) => hooks.prompt[0]!({ sessionID, messageID, prompt: { text: "work" } });
  await prompt("root", "root-message");
  const root = rt.sessions.get("root" as SessionID);
  const rootPrompt = root.promptId;
  await prompt("child", "child-message");
  expect(rt.sessions.get("child" as SessionID).promptId).toBeNull();
  unavailable = false;
  await prompt("child", "child-message");
  const child = rt.sessions.get("child" as SessionID);
  expect(child.parentId).toBe(root.id);
  expect(child.promptId).toBeNull();
  expect(child.promptGeneration).toBe(0);
  expect(root.promptId).toBe(rootPrompt);
});
