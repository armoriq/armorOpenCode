import { describe, expect, test } from "bun:test";
import { allowAllPolicy, fakeRuntime } from "../support/intent-harness.ts";
import type { Login, SessionID } from "../../src/types.ts";

const { handleArmorCommand } = await import("../../src/commands/armor.ts");

const sid = (s: string) => s as SessionID;
const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_x", userId: "u", orgId: "o", email: "e", deviceId: "d", deviceName: "n" };

describe("/armor", () => {
  test("text that is not an /armor command returns null", async () => {
    const rt = await fakeRuntime(login);
    expect(handleArmorCommand("please run the tests", "s", rt)).toBeNull();
    expect(handleArmorCommand("/armorx status", "s", rt)).toBeNull();
  });

  test("an /armor command with extra words gets the usage text, not an empty reply", async () => {
    const rt = await fakeRuntime(login);
    expect(handleArmorCommand("/armor policy bash x", "s", rt)).toContain("ArmorIQ commands:");
    expect(handleArmorCommand("/armor   ", "s", rt)).toContain("ArmorIQ mode:");
  });

  test("status shows mode, plan goal and steps, token expiry and policy hash", async () => {
    const rt = await fakeRuntime(login);
    rt.sessions.open(sid("s"), null, "enforce");
    const expiresAt = Date.now() + 600_000;
    rt.sessions.setPlan(
      sid("s"),
      { id: "plan-9", hash: "h", goal: "fix the build", steps: [{ action: "run tests", tool: "bash" }, { action: "edit", tool: "edit" }], revision: 2, registeredInMessage: "m" },
      { status: "active", jwt: "j", expiresAt, deniedTools: new Set(), heldTools: new Set() },
    );
    rt.sessions.advance(sid("s"), 0);
    const out = handleArmorCommand("/armor status", "s", rt)!;
    expect(out).toContain("ArmorIQ mode: enforce");
    expect(out).toContain("Policy hash: policy-hash-test");
    expect(out).toContain("Plan: fix the build (revision 2, id plan-9)");
    expect(out).toContain("[x] 1. bash: run tests");
    expect(out).toContain("[ ] 2. edit");
    expect(out).toContain(`expires ${new Date(expiresAt).toISOString()}`);
    expect(handleArmorCommand("/armor", "s", rt)).toBe(out);
  });

  test("status in a subagent reports the parent plan", async () => {
    const rt = await fakeRuntime(login);
    rt.sessions.open(sid("p"), null, "enforce");
    rt.sessions.open(sid("c"), sid("p"), "enforce");
    rt.sessions.setToken(sid("p"), { status: "refused", code: "billing_blocked" });
    const out = handleArmorCommand("/armor status", "c", rt)!;
    expect(out).toContain("Subagent of session p");
    expect(out).toContain("Token: refused (billing_blocked)");
  });

  test("policy prints the policy summary and evaluates a named tool", async () => {
    const rt = await fakeRuntime(null, allowAllPolicy(["bash"]));
    const out = handleArmorCommand("/armor policy bash", "s", rt)!;
    expect(out).toContain("Policy hash: policy-hash-test");
    expect(out).toContain("Mode: monitor");
    expect(out).toContain("bash: forbid (rule deny-bash): bash is forbidden");
  });

  test("an unknown subcommand prints usage", async () => {
    const rt = await fakeRuntime(login);
    expect(handleArmorCommand("/armor frobnicate", "s", rt)).toContain("/armor status");
  });
});
