import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fakeRuntime, startStubBackend, type FakeRuntime } from "../../support/intent-harness.ts";
import type { CommandContext, CommandDefinition, ContextEvent, SessionHooks, SyntheticInput } from "../../../src/hosts/v2/plugin-api.ts";

const { hostFor } = await import("../../../src/host.ts");
const { registerArmorCommand, ARMOR_REPLY_NOTE } = await import("../../../src/hosts/v2/command.ts");

// Recorded from OpenCode 2.0.29: the TUI's `/armor status` reaches the command as this invocation,
// and session.synthetic answers with the inbox item.
const INVOCATION = { sessionID: "ses_ec3ed2a8affe9V7daueW2i5ShO", prompt: { text: "status", files: [], agents: [] }, delivery: "steer" };
const SYNTHETIC_ID = "msg_13c12d7be001PBus5jKPJsWO8I";
const USER_MESSAGE = { id: "msg_13c14d19e0013l5ofHh53NBk5a", role: "user" };

function fakeContext(synthetic: (input: SyntheticInput) => Promise<unknown>) {
  const commands: CommandDefinition[] = [];
  const hooks: { [N in keyof SessionHooks]: Array<(e: SessionHooks[N]) => Promise<void> | void> } = { prompt: [], context: [] };
  const sent: SyntheticInput[] = [];
  const registration = { dispose: async () => {} };
  const ctx: CommandContext = {
    command: {
      transform: async (cb) => {
        cb({ add: (d) => void commands.push(d) });
        return registration;
      },
    },
    session: {
      hook: async <N extends keyof SessionHooks>(name: N, cb: (e: SessionHooks[N]) => Promise<void> | void) => {
        hooks[name].push(cb);
        return registration;
      },
      synthetic: (input) => {
        sent.push(input);
        return synthetic(input);
      },
    },
  };
  return { ctx, commands, hooks, sent };
}

let stub: ReturnType<typeof startStubBackend>;
let rt: FakeRuntime;
beforeEach(async () => {
  stub ??= startStubBackend();
  rt = await fakeRuntime(stub.login());
});
afterAll(() => stub.stop());

describe("V2 /armor command", () => {
  test("status is answered as a synthetic notice, with no prompt and no model turn requested", async () => {
    const oc = fakeContext(async (i) => ({ id: SYNTHETIC_ID, sessionID: i.sessionID, type: "synthetic", payload: { text: i.text, description: i.description }, delivery: "steer" }));
    await registerArmorCommand(oc.ctx, hostFor(rt, rt.log));
    expect(oc.commands.map((c) => c.name)).toEqual(["armor"]);
    await oc.commands[0]!.execute(INVOCATION);
    expect(oc.sent).toEqual([
      {
        sessionID: INVOCATION.sessionID,
        text: ARMOR_REPLY_NOTE,
        description: "ArmorIQ mode: enforce\nPolicy hash: policy-hash-test\nPlan: none registered",
        resume: false,
      },
    ]);
  });

  test("the reply is dropped from later model requests and other messages are kept", async () => {
    const oc = fakeContext(async () => ({ id: SYNTHETIC_ID }));
    await registerArmorCommand(oc.ctx, hostFor(rt, rt.log));
    await oc.commands[0]!.execute(INVOCATION);
    const event: ContextEvent = { sessionID: INVOCATION.sessionID, system: [], messages: [{ id: SYNTHETIC_ID }, USER_MESSAGE] };
    await oc.hooks.context[0]!(event);
    expect(event.messages).toEqual([USER_MESSAGE]);
  });

  test("policy and unknown subcommands get their V1 replies", async () => {
    const oc = fakeContext(async () => ({ id: SYNTHETIC_ID }));
    await registerArmorCommand(oc.ctx, hostFor(rt, rt.log));
    await oc.commands[0]!.execute({ ...INVOCATION, prompt: { text: "policy" } });
    await oc.commands[0]!.execute({ ...INVOCATION, prompt: { text: "nope" } });
    expect(oc.sent.map((s) => s.description.split("\n")[0])).toEqual(["Policy hash: policy-hash-test", "ArmorIQ commands:"]);
  });

  test("a failed reply is logged and does not throw into OpenCode", async () => {
    const oc = fakeContext(async () => {
      throw new Error("session not found");
    });
    await registerArmorCommand(oc.ctx, hostFor(rt, rt.log));
    await oc.commands[0]!.execute(INVOCATION);
    expect(rt.warnings).toContain("armor command reply failed");
  });
});
