import { describe, expect, test } from "bun:test";

import { policyToYaml } from "../src/policy-yaml.ts";

// policyToYaml is a formatter, so its OUTPUT is its contract — a human reads
// it in the terminal to decide whether to run /armor/yes. These tests
// therefore assert exact strings (and one exact whole-document render), not
// just "contains something plausible".

// ---- Test data ----

/** A realistic armor.policy.v1 profile exercising every rendering branch. */
function samplePolicy() {
  return {
    schema: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "armor-opencode-generated", version: 1 },
    defaults: { effect: "deny", intentRequired: true },
    statements: [
      {
        sid: "allow-reads",
        effect: "allow",
        action: ["read", "grep"],
        resource: "*",
        conditions: [],
      },
      {
        sid: "deny-destructive-bash",
        effect: "deny",
        action: ["bash"],
        conditions: [{ key: "command", op: "contains", value: "rm -rf" }],
      },
    ],
  };
}

// ---- Whole-document render ----

describe("policyToYaml whole-document render", () => {
  test("renders a full profile exactly, including indent arithmetic", () => {
    // Nested objects land at indent+4 while array items land at indent+2 —
    // an artifact of the per-branch indent arithmetic, reproduced verbatim
    // from the JS original because changing it shifts every nested line.
    const expected = [
      "schema: armor.policy.v1",
      "kind: PolicyProfile",
      "metadata:",
      '    name: "armor-opencode-generated"',
      "    version: 1",
      "defaults:",
      "    effect: deny",
      "    intentRequired: true",
      "statements:",
      '  - sid: "allow-reads"',
      "    effect: allow",
      "    action:",
      "      - read",
      "      - grep",
      '    resource: "*"',
      "    conditions: []",
      '  - sid: "deny-destructive-bash"',
      "    effect: deny",
      "    action:",
      "      - bash",
      "    conditions:",
      "      - key: command",
      "        op: contains",
      '        value: "rm -rf"',
    ].join("\n");

    expect(policyToYaml(samplePolicy())).toBe(expected);
  });

  test("emits no trailing newline (callers add their own)", () => {
    expect(policyToYaml(samplePolicy()).endsWith("\n")).toBe(false);
  });

  test("preserves key insertion order rather than sorting", () => {
    const out = policyToYaml({ zebra: 1, apple: 2, mango: 3 });
    expect(out).toBe("zebra: 1\napple: 2\nmango: 3");
  });
});

// ---- Bare vs quoted: the exact quoting character class ----

describe("policyToYaml quoting", () => {
  test("leaves the policy's own identifier strings bare", () => {
    // Neither `.` nor plain letters are in the quoting class, which is why
    // these two read cleanly in the terminal preview.
    expect(policyToYaml({ schema: "armor.policy.v1" })).toBe(
      "schema: armor.policy.v1",
    );
    expect(policyToYaml({ kind: "PolicyProfile" })).toBe(
      "kind: PolicyProfile",
    );
  });

  test("quotes hyphenated values (`-` IS in the class)", () => {
    expect(policyToYaml({ sid: "allow-reads" })).toBe('sid: "allow-reads"');
  });

  test("quotes the empty string", () => {
    expect(policyToYaml({ note: "" })).toBe('note: ""');
  });

  test("quotes leading/trailing whitespace", () => {
    expect(policyToYaml({ a: " pad", b: "pad ", c: "\tpad" })).toBe(
      'a: " pad"\nb: "pad "\nc: "\\tpad"',
    );
  });

  test("quotes every character in the class, and nothing outside it", () => {
    const mustQuote = [
      ":",
      "#",
      "-",
      "{",
      "}",
      "[",
      "]",
      ",",
      "&",
      "*",
      "!",
      "|",
      ">",
      "'",
      '"',
      "%",
      "@",
      "`",
      "\n",
    ];
    for (const ch of mustQuote) {
      const value = `a${ch}b`;
      expect(policyToYaml({ k: value })).toBe(`k: ${JSON.stringify(value)}`);
    }

    // Characters deliberately NOT in the class — this is not a general
    // YAML-safety set, and pretending otherwise is how a "fix" creeps in.
    for (const ch of [".", "_", "/", "+", "=", "?", "(", ")", "~", ";", "<"]) {
      const value = `a${ch}b`;
      expect(policyToYaml({ k: value })).toBe(`k: ${value}`);
    }
  });

  test("renders booleans and numbers unquoted", () => {
    expect(policyToYaml({ t: true, f: false, n: 600, z: 0, neg: -1.5 })).toBe(
      "t: true\nf: false\nn: 600\nz: 0\nneg: -1.5",
    );
  });

  test("renders both null and undefined as the bare word null", () => {
    expect(policyToYaml({ a: null, b: undefined })).toBe("a: null\nb: null");
  });
});

// ---- Arrays ----

describe("policyToYaml arrays", () => {
  test("renders an empty array inline as `key: []` on one line", () => {
    const out = policyToYaml({ conditions: [] });
    expect(out).toBe("conditions: []");
    expect(out.includes("\n")).toBe(false);
  });

  test("puts an object item's FIRST key on the `- ` line", () => {
    expect(
      policyToYaml({ statements: [{ sid: "s1", effect: "allow" }] }),
    ).toBe("statements:\n  - sid: s1\n    effect: allow");
  });

  test("renders scalar array items one per line", () => {
    expect(policyToYaml({ action: ["read", "bash"] })).toBe(
      "action:\n  - read\n  - bash",
    );
  });

  test("quotes scalar array items by the same rules", () => {
    expect(policyToYaml({ action: ["read-file", "read", null, 3, true] })).toBe(
      'action:\n  - "read-file"\n  - read\n  - null\n  - 3\n  - true',
    );
  });

  test("renders an object nested inside an array item at indent+4", () => {
    // The nested object lands 4 spaces in from its key, not 2 — the same
    // per-branch indent arithmetic visible in the whole-document render.
    expect(policyToYaml({ items: [{ a: 1, nested: { b: 2 } }] })).toBe(
      "items:\n  - a: 1\n    nested:\n        b: 2",
    );
  });
});

// ---- Non-object inputs ----

describe("policyToYaml non-object inputs", () => {
  test('returns the literal "(no policy)" for anything that is not a plain object', () => {
    for (const bad of [null, undefined, [], [1, 2], "policy", 0, 42, true]) {
      expect(policyToYaml(bad)).toBe("(no policy)");
    }
  });

  test("renders an empty object as the empty string, NOT as (no policy)", () => {
    // An empty object is still a plain object, so it takes the normal path.
    expect(policyToYaml({})).toBe("");
  });
});
