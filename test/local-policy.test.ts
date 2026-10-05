import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activePolicyPath,
  evaluateLocalPolicy,
  hasActivePolicy,
  loadActivePolicy,
  saveActivePolicy,
  validatePolicyProfile,
  type PolicyProfile,
} from "../src/local-policy.ts";

// ---- Fixtures ----

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aoc-local-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stmt(id: string, effect: string, eq: string): Record<string, unknown> {
  return {
    id,
    effect,
    principal: { type: "agent", id: "*" },
    action: { type: "tool", eq },
    resource: { type: "any", scope: "*" },
    conditions: [],
  };
}

function profile(opts: {
  statements?: unknown;
  defaults?: unknown;
}): PolicyProfile {
  return {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "t", description: "t" },
    defaults: opts.defaults ?? {
      decision: "allow",
      conflictResolution: "deny_overrides",
    },
    statements: opts.statements ?? [],
  } as PolicyProfile;
}

const forbid = (eq: string, id = "f1") => stmt(id, "forbid", eq);
const permit = (eq: string, id = "p1") => stmt(id, "permit", eq);

// ---- validatePolicyProfile ----

describe("validatePolicyProfile (AC-A6)", () => {
  const err = (raw: unknown) => {
    const r = validatePolicyProfile(raw);
    return r.ok ? null : r.error;
  };

  test("rejects each malformed shape with a specific error", () => {
    expect(err(null)).toBe("policy must be an object");
    expect(err([])).toBe("policy must be an object");
    expect(err("x")).toBe("policy must be an object");
    expect(err({ statements: "no" })).toBe("policy.statements must be an array");
    expect(err({ statements: ["x"] })).toBe("policy.statements[0] must be an object");
    expect(err({ statements: [{ ...permit("a"), id: "" }] })).toBe(
      "policy.statements[0].id must be a non-empty string",
    );
    expect(err({ statements: [permit("a"), { ...permit("a"), id: 3 }] })).toBe(
      "policy.statements[1].id must be a non-empty string",
    );
    expect(err({ statements: [stmt("x", "maybe", "a")] })).toBe(
      'policy.statements[0].effect must be "permit" or "forbid"',
    );
    expect(err({ statements: [{ ...permit("a"), action: "a" }] })).toBe(
      "policy.statements[0].action must be an object",
    );
    expect(err({ statements: [stmt("x", "permit", "")] })).toBe(
      "policy.statements[0].action.eq must be a non-empty string",
    );
    expect(err({ statements: [], defaults: "x" })).toBe(
      "policy.defaults must be an object",
    );
    expect(err({ statements: [], defaults: { decision: "maybe" } })).toBe(
      'policy.defaults.decision must be "allow" or "deny"',
    );
    expect(err({ statements: [], defaults: { conflictResolution: "x" } })).toBe(
      'policy.defaults.conflictResolution must be "deny_overrides" or "permit_overrides"',
    );
  });

  test("accepts a minimal profile, extra keys, and missing defaults", () => {
    expect(validatePolicyProfile({ statements: [] }).ok).toBe(true);
    const lean = { statements: [{ id: "a", effect: "forbid", action: { eq: "Bash" }, extra: 1 }], other: 2 };
    expect(validatePolicyProfile(lean).ok).toBe(true);
    expect(validatePolicyProfile(profile({ statements: [forbid("Bash")] })).ok).toBe(true);
  });

  test("returns the same object reference", () => {
    const p = profile({});
    const r = validatePolicyProfile(p);
    expect(r.ok && r.policy).toBe(p);
  });
});

// ---- storage ----

describe("storage (AC-A5)", () => {
  const good = () => profile({ statements: [forbid("Bash")] });

  test("round trips a valid policy", () => {
    const rec = saveActivePolicy(dir, good());
    expect(typeof rec.savedAt).toBe("string");
    expect(loadActivePolicy(dir)).toEqual({ status: "ok", policy: good() });
  });

  test("a failed write cleans up its temp file and rethrows", () => {
    // A directory at the target makes the rename step fail after the temp
    // file was written, which is the cleanup path.
    mkdirSync(activePolicyPath(dir));
    expect(() => saveActivePolicy(dir, good())).toThrow();
    expect(readdirSync(dir)).toEqual(["policy.json"]);
  });

  test("none when there is no file", () => {
    expect(loadActivePolicy(dir)).toEqual({ status: "none" });
    expect(hasActivePolicy(dir)).toBe(false);
  });

  test("invalid for each bad file, naming the path", () => {
    const path = activePolicyPath(dir);
    const cases = [
      "not json {",
      "[]",
      "{}",
      '{"policy":"x"}',
      '{"policy":{"statements":"no"}}',
    ];
    for (const body of cases) {
      writeFileSync(path, body);
      const r = loadActivePolicy(dir);
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.error).toContain(path);
    }
  });

  test("invalid when policy.json is a directory", () => {
    mkdirSync(activePolicyPath(dir));
    const r = loadActivePolicy(dir);
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(r.error).toContain(activePolicyPath(dir));
  });

  test("hasActivePolicy is existence only: true for a corrupt file", () => {
    writeFileSync(activePolicyPath(dir), "garbage");
    expect(hasActivePolicy(dir)).toBe(true);
  });

  test("save refuses an invalid policy and keeps the old file byte for byte", () => {
    saveActivePolicy(dir, good());
    const before = readFileSync(activePolicyPath(dir), "utf-8");
    expect(() =>
      saveActivePolicy(dir, profile({ statements: "no" })),
    ).toThrow(/Refusing to save invalid policy: policy\.statements must be an array/);
    expect(readFileSync(activePolicyPath(dir), "utf-8")).toBe(before);
  });

  test("no temp file remains, and a second save replaces the first whole", () => {
    saveActivePolicy(dir, good());
    saveActivePolicy(dir, profile({ statements: [permit("Read", "p9")] }));
    expect(readdirSync(dir)).toEqual(["policy.json"]);
    const r = loadActivePolicy(dir);
    expect(r.status === "ok" && r.policy.statements[0]?.id).toBe("p9");
  });

  test("creates a missing nested dataDir", () => {
    const nested = join(dir, "a", "b");
    saveActivePolicy(nested, good());
    expect(existsSync(activePolicyPath(nested))).toBe(true);
  });
});

// ---- evaluateLocalPolicy ----

describe("evaluateLocalPolicy (AC-A7, AC-A8, AC-A9)", () => {
  test("an unprintable tool name does not throw (AC-X3)", () => {
    const p = profile({ statements: [forbid("*")] });
    for (const bad of [Symbol("x"), Object.create(null)]) {
      expect(evaluateLocalPolicy(p, bad as unknown as string).decision).toBe("deny");
    }
  });

  test("null and undefined policy allow", () => {
    for (const p of [null, undefined]) {
      expect(evaluateLocalPolicy(p, "bash")).toEqual({
        decision: "allow",
        matched: null,
        reason: "no local policy",
      });
    }
  });

  test("a non object policy denies", () => {
    for (const p of ["x", 1, true]) {
      const v = evaluateLocalPolicy(p as unknown as PolicyProfile, "bash");
      expect(v).toEqual({
        decision: "deny",
        matched: null,
        reason: "Local policy is malformed",
      });
    }
  });

  test("forbid on a backend name denies the opencode name", () => {
    const v = evaluateLocalPolicy(profile({ statements: [forbid("WebFetch")] }), "webfetch");
    expect(v.decision).toBe("deny");
    expect(v.matched?.id).toBe("f1");
  });

  test("unmatched tool takes the default (allow, then deny)", () => {
    const stmts = [forbid("Bash")];
    expect(evaluateLocalPolicy(profile({ statements: stmts }), "read").decision).toBe("allow");
    const denyDefault = profile({
      statements: stmts,
      defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    });
    expect(evaluateLocalPolicy(denyDefault, "read")).toEqual({
      decision: "deny",
      matched: null,
      reason: "Local policy default (deny)",
    });
    expect(evaluateLocalPolicy(profile({}), "read").reason).toBe(
      "Local policy default (allow)",
    );
  });

  test("a * forbid denies every tool name including empty", () => {
    const p = profile({ statements: [forbid("*")] });
    for (const name of ["read", "bash", "", "mystery_tool", "constructor"]) {
      expect(evaluateLocalPolicy(p, name).decision).toBe("deny");
    }
  });

  test("deny_overrides: forbid beats permit, matched is the forbid", () => {
    const p = profile({ statements: [permit("Bash"), forbid("Bash", "f9")] });
    const v = evaluateLocalPolicy(p, "bash");
    expect(v.decision).toBe("deny");
    expect(v.matched?.id).toBe("f9");
  });

  test("permit_overrides: permit beats forbid", () => {
    const p = profile({
      statements: [forbid("Bash"), permit("Bash", "p7")],
      defaults: { decision: "allow", conflictResolution: "permit_overrides" },
    });
    const v = evaluateLocalPolicy(p, "bash");
    expect(v.decision).toBe("allow");
    expect(v.matched?.id).toBe("p7");
  });

  test("unknown conflictResolution behaves as deny_overrides", () => {
    const p = profile({
      statements: [permit("Bash"), forbid("Bash")],
      defaults: { decision: "allow", conflictResolution: "bogus" },
    });
    expect(evaluateLocalPolicy(p, "bash").decision).toBe("deny");
  });

  test("a matching statement with an unknown effect denies", () => {
    const p = profile({ statements: [stmt("weird", "maybe", "Bash")] });
    const v = evaluateLocalPolicy(p, "bash");
    expect(v.decision).toBe("deny");
    expect(v.matched?.id).toBe("weird");
  });

  test("forbid Edit denies apply_patch; forbid apply_patch denies only itself", () => {
    const edit = profile({ statements: [forbid("Edit")] });
    expect(evaluateLocalPolicy(edit, "apply_patch").decision).toBe("deny");
    const patch = profile({ statements: [forbid("apply_patch")] });
    expect(evaluateLocalPolicy(patch, "apply_patch").decision).toBe("deny");
    expect(evaluateLocalPolicy(patch, "edit").decision).toBe("allow");
  });

  test("matching ignores case and padding on both sides", () => {
    const p = profile({ statements: [forbid(" Bash ")] });
    for (const name of ["bash", "BASH", "  Bash "]) {
      expect(evaluateLocalPolicy(p, name).decision).toBe("deny");
    }
  });

  test("an MCP tool is matched by its raw name", () => {
    const name = "armor-opencode-policy_register_intent_plan";
    const p = profile({ statements: [forbid(name)] });
    expect(evaluateLocalPolicy(p, name).decision).toBe("deny");
  });

  test("prototype-like tool names do not throw and follow the default", () => {
    const p = profile({ statements: [forbid("Bash")] });
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(evaluateLocalPolicy(p, name).decision).toBe("allow");
    }
  });

  test("tolerates a non array statements and junk statements without throwing", () => {
    const junk = { defaults: { decision: "deny" }, statements: "no" };
    expect(evaluateLocalPolicy(junk as unknown as PolicyProfile, "x").decision).toBe("deny");
    const mixed = profile({ statements: [null, 3, {}, forbid("Bash")] });
    expect(evaluateLocalPolicy(mixed, "bash").decision).toBe("deny");
  });

  test("reason strings are pinned exactly", () => {
    const p = profile({ statements: [forbid("Bash", "f1"), permit("Read", "p1")] });
    expect(evaluateLocalPolicy(p, "bash").reason).toBe("Local policy statement f1 denies bash");
    expect(evaluateLocalPolicy(p, "Read").reason).toBe("Local policy statement p1 permits Read");
  });
});
