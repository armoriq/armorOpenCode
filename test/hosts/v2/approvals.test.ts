import { describe, expect, test } from "bun:test";
import { fakeRuntime } from "../../support/intent-harness.ts";

const { hostFor } = await import("../../../src/host.ts");
const { approvalsSetting, registerApprovals, ASK_REFUSED } = await import("../../../src/hosts/v2/approvals.ts");

describe("V2 approvals option", () => {
  test("holds are denied by default and when deny is set", () => {
    expect(approvalsSetting(undefined)).toEqual({ setting: "deny", warning: null });
    expect(approvalsSetting("deny")).toEqual({ setting: "deny", warning: null });
  });

  test("ask is recognized and refused with the reason", () => {
    expect(approvalsSetting("ask")).toEqual({ setting: "ask", warning: ASK_REFUSED });
  });

  test("an unknown value falls back to deny", () => {
    expect(approvalsSetting(true)).toEqual({ setting: "deny", warning: "unknown approvals option true; holds are denied" });
  });

  // --auto can only run a held call if something answers permission.evaluate with "ask". With approvals
  // set to ask, the module still registers no permission hook, so nothing can produce one.
  test("approvals: ask registers no permission hook and logs why", async () => {
    const rt = await fakeRuntime(null);
    const hooked: string[] = [];
    const ctx = {
      options: { approvals: "ask" },
      permission: { hook: async (name: string) => void hooked.push(name) },
    };
    await registerApprovals(ctx, hostFor(rt, rt.log));
    expect(hooked).toEqual([]);
    expect(rt.warnings).toEqual([ASK_REFUSED]);
  });
});
