import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTokenPump } from "../../src/pumps/token.ts";
import { createSessionStore } from "../../src/state/sessions.ts";
import type { Plan, SessionID } from "../../src/types.ts";
import { startStubBackend } from "../support/intent-harness.ts";

const sid = (s: string) => s as SessionID;
const log = { info() {}, warn() {}, error() {} };
const plan: Plan = { id: "plan-old", hash: "h", goal: "g", steps: [{ action: "bash", tool: "bash" }], revision: 1, registeredInMessage: "m" };
let stub: ReturnType<typeof startStubBackend>;

beforeAll(() => {
  stub = startStubBackend();
});
afterAll(() => stub.stop());

function setup(expiresInMs: number) {
  const sessions = createSessionStore(mkdtempSync(path.join(tmpdir(), "aoc-tok-")), () => "enforce");
  sessions.open(sid("s"), null, "enforce");
  sessions.setPlan(sid("s"), plan, { status: "active", jwt: "old", expiresAt: Date.now() + expiresInMs, deniedTools: new Set(), heldTools: new Set() });
  sessions.advance(sid("s"), 0);
  const pump = createTokenPump({ sessions, login: () => stub.login(), log });
  return { sessions, pump };
}

const settle = async (pump: { stop(): Promise<void> }) => pump.stop();

describe("token pump", () => {
  test("refreshes a token that expires within 60 s and keeps the step cursor", async () => {
    const { sessions, pump } = setup(30_000);
    const before = stub.requests.length;
    pump.kick();
    await settle(pump);
    expect(stub.requests.slice(before).map((r) => r.path)).toEqual(["/iap/sdk/token"]);
    const s = sessions.get(sid("s"));
    expect(s.token?.status).toBe("active");
    if (s.token?.status === "active") expect(s.token.expiresAt - Date.now()).toBeGreaterThan(3_000_000);
    expect(s.plan?.steps).toEqual(plan.steps);
    expect(s.stepCursor).toBe(1);
  });

  test("leaves a token with more than 60 s left alone", async () => {
    const { pump } = setup(120_000);
    const before = stub.requests.length;
    pump.kick();
    await settle(pump);
    expect(stub.requests.length).toBe(before);
  });

  test("a failed refresh leaves the old token to lapse", async () => {
    const { sessions, pump } = setup(30_000);
    stub.queue("/iap/sdk/token", { status: 500 }, { status: 500 });
    pump.kick();
    await settle(pump);
    const t = sessions.get(sid("s")).token;
    expect(t?.status === "active" && t.jwt).toBe("old");
  });

  test("revoke on session close sends the plan id", async () => {
    const { sessions, pump } = setup(3_600_000);
    const before = stub.requests.length;
    pump.revoke("s");
    sessions.close(sid("s"));
    await settle(pump);
    expect(stub.requests.slice(before)).toEqual([
      expect.objectContaining({ path: "/iap/trust/revoke", body: expect.objectContaining({ planId: "plan-old", reason: "opencode session deleted", cascade: true }) }),
    ]);
  });

  test("subagent sessions never refresh or revoke the parent token", async () => {
    const { sessions, pump } = setup(30_000);
    sessions.open(sid("child"), sid("s"), "enforce");
    const before = stub.requests.length;
    pump.revoke("child");
    await settle(pump);
    expect(stub.requests.length).toBe(before);
  });
});
