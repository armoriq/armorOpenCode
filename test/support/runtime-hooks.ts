import { Runtime } from "../../src/runtime.ts";
import { OWN_TOOL_NAMES } from "../../src/tools/intent.ts";
import type { CompiledPolicy, Login } from "../../src/types.ts";
import { fakeRuntime } from "./intent-harness.ts";

// Exercise the real hooks with an isolated session store and a reachable cached posture.
export async function runtimeHooks(login: Login | null, policy?: CompiledPolicy) {
  const rt = await fakeRuntime(login, policy);
  Object.setPrototypeOf(rt, Runtime.prototype);
  Object.assign(rt, {
    pending: new Map(),
    messageModel: new Map(),
    traces: { record() {} },
    builtin: { armoriqDir: "/home/test/.armoriq", ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools },
  });
  return rt;
}
