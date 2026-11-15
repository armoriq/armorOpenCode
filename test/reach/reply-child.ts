import { mock } from "bun:test";
import { allowAllPolicy, fakeRuntime, planArgs } from "../support/intent-harness.ts";
import type { SessionID } from "../../src/types.ts";

// Keep backend stubbing in a child process, so it cannot alter other tests or fetch.
const backend = await import("../../src/io/backend-intent.ts");
let result: any;
mock.module("../../src/io/backend-intent.ts", () => ({ ...backend,
  mintToken: () => result,
  reanchor: async () => ({ ok: true, value: { trustId: "trust" } }),
}));
const { hostFor } = await import("../../src/host.ts");
const rt = await fakeRuntime(null);
const h = hostFor(rt, rt.log);
const call = { sessionId: "s" as SessionID, messageId: "m", callId: null };
const observed: Record<string, string> = {};
observed.local = await h.ownTools.registerIntentPlan(call, planArgs("bash"), "");
observed.parse = await h.ownTools.registerIntentPlan(call, {}, "");
rt.setPolicy(allowAllPolicy(["bash"]));
observed.policy = await h.ownTools.registerIntentPlan(call, planArgs("bash"), "");
rt.sessions.open("child" as SessionID, call.sessionId, "monitor");
observed.child = await h.ownTools.registerIntentPlan({ ...call, sessionId: "child" as SessionID }, {}, "");
observed.empty = await h.ownTools.reanchor({ ...call, sessionId: "empty" as SessionID }, {}, "");
rt.setPolicy(allowAllPolicy());
rt.sessions.clearPlan(call.sessionId);
rt.setLogin({ backend: "https://api.armoriq.ai", apiKey: "ak_test", userId: "", orgId: "", email: "", deviceId: "", deviceName: "" });
const token = (denied: string[] = [], held: string[] = []) => ({ ok: true, value: { planId: "p", token: { status: "active", jwt: "test", expiresAt: 4102444800000, deniedTools: new Set(denied), heldTools: new Set(held) } } });
result = token();
observed.minted = await h.ownTools.registerIntentPlan(call, planArgs("bash"), "");
observed.reason = await h.ownTools.registerIntentPlan(call, planArgs("bash"), "");
result = token(["bash"], ["edit"]);
observed.revised = await h.ownTools.reanchor(call, planArgs("edit"), "change");
rt.sessions.noteRevision(call.sessionId);
observed.limit = await h.ownTools.registerIntentPlan(call, planArgs("bash"), "change");
for (const code of ["account_revoked", "billing_blocked"]) {
  result = { ok: true, value: { planId: "", token: { status: "refused", code } } };
  observed[code] = await h.ownTools.registerIntentPlan({ ...call, sessionId: code as SessionID }, planArgs("bash"), "");
}
result = { ok: false, reason: "HTTP 503: offline" };
observed.failure = await h.ownTools.registerIntentPlan({ ...call, sessionId: "failed" as SessionID }, planArgs("bash"), "");
let finish!: (value: unknown) => void;
result = new Promise(resolve => { finish = resolve; });
const concurrent = { ...call, sessionId: "concurrent" as SessionID };
const pending = h.ownTools.registerIntentPlan(concurrent, planArgs("bash"), "");
observed.concurrent = await h.ownTools.registerIntentPlan(concurrent, planArgs("bash"), "");
finish(token());
await pending;
result = { ok: false, reason: "HTTP 503: offline" };
observed.kept = await h.ownTools.registerIntentPlan(concurrent, planArgs("bash"), "change");
console.log(JSON.stringify(observed));
