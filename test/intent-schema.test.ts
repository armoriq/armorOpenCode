import { describe, expect, test } from "bun:test";

import {
  INTENT_PLAN_FORMAT,
  planContainsTool,
  planToolNames,
  validateIntentPlan,
} from "../src/intent-schema.ts";

// ---- Test data ----
//
// Factories so each test gets a fresh object graph and a test asserting the
// validator didn't alias its input can't be fooled by a shared constant.

/** The minimal plan that passes validation. */
function validPlan() {
  return {
    goal: "Read the config and fix the bug",
    steps: [
      { action: "read", description: "read src/config.ts", metadata: {} },
      { action: "edit", description: "apply the fix", metadata: {} },
    ],
  };
}

// ---- INTENT_PLAN_FORMAT: model-facing tool names ----

describe("INTENT_PLAN_FORMAT", () => {
  /**
   * Every built-in tool name internal/research-notes.md §3 records as
   * CONFIRMED by live invocation. The prompt text must name exactly these:
   * an extra name invites the model to declare a step for a tool that does
   * not exist (drift), and a MISSING name means the model calls it without
   * having declared it, so the drift check denies a benign call.
   */
  const CONFIRMED_TOOLS = [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
    "todowrite",
    "websearch",
    "webfetch",
  ] as const;

  /** Names §3 flags as GAP — real-ness or exact spelling unverified. */
  const UNCONFIRMED_TOOLS = ["todoread", "apply_patch", "lsp"] as const;

  /**
   * Pull the tool-name list back out of the prompt text: it lives in the
   * `action` field's placeholder, after "e.g. " and before the closing ">".
   *
   * Parsing rather than substring-matching is the whole point. `toContain`
   * checks can only prove presence, so they cannot catch an omission (the
   * bug that actually shipped in an earlier draft: `todowrite` was absent)
   * and cannot catch an addition either. A parsed list can be compared as a
   * set, which pins both directions.
   */
  function parseListedTools(): string[] {
    const match = /e\.g\. ([^>]+)>/.exec(INTENT_PLAN_FORMAT);
    if (!match?.[1]) {
      throw new Error(
        "could not find the 'e.g. <tools>' list in INTENT_PLAN_FORMAT — " +
          "if its wording changed, update this parser, don't delete the test",
      );
    }
    return match[1].split(",").map((name) => name.trim());
  }

  test("names EXACTLY the confirmed opencode tools — no omissions, no additions", () => {
    const listed = parseListedTools();
    // Set equality both ways, so a missing name and a surplus name each fail.
    expect([...listed].sort()).toEqual([...CONFIRMED_TOOLS].sort());
    // No duplicates smuggled in (a Set comparison alone would hide them).
    expect(listed).toHaveLength(CONFIRMED_TOOLS.length);
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("names todowrite specifically (the model reaches for it every session)", () => {
    // Called out on its own because omitting it is the single most likely
    // way this constant regresses into denying a benign call.
    expect(parseListedTools()).toContain("todowrite");
  });

  test("names no Gemini CLI tools (the port replaced them wholesale)", () => {
    // Every tool name ArmorGemini's version listed. `edit` and `glob` are
    // deliberately absent from this list: they are real in BOTH CLIs.
    for (const geminiTool of [
      "read_file",
      "write_file",
      "run_shell_command",
      "google_web_search",
      "web_fetch",
      "list_directory",
      "search_file_content",
    ]) {
      expect(INTENT_PLAN_FORMAT).not.toContain(geminiTool);
    }
    expect(INTENT_PLAN_FORMAT).not.toContain("Gemini");
  });

  test("names no tool whose existence is only unconfirmed guesswork", () => {
    const listed = parseListedTools();
    for (const unconfirmed of UNCONFIRMED_TOOLS) {
      // Absent from the parsed list...
      expect(listed).not.toContain(unconfirmed);
      // ...and absent from the surrounding prose too, so it can't leak in as
      // a stray "e.g. not apply_patch" style aside.
      expect(INTENT_PLAN_FORMAT).not.toContain(unconfirmed);
    }
  });

  test("is itself valid JSON-ish enough to name the three plan fields", () => {
    expect(INTENT_PLAN_FORMAT).toContain('"goal"');
    expect(INTENT_PLAN_FORMAT).toContain('"steps"');
    expect(INTENT_PLAN_FORMAT).toContain('"action"');
    expect(INTENT_PLAN_FORMAT).toContain('"description"');
    expect(INTENT_PLAN_FORMAT).toContain('"metadata"');
  });
});

// ---- validateIntentPlan: the error-string table ----
//
// These strings are matched on by other code, so each is asserted exactly,
// not with toContain.

describe("validateIntentPlan rejections", () => {
  const cases: Array<[label: string, input: unknown, error: string]> = [
    ["null", null, "plan must be a JSON object"],
    ["undefined", undefined, "plan must be a JSON object"],
    ["an array", [], "plan must be a JSON object"],
    ["a populated array", [{ goal: "g" }], "plan must be a JSON object"],
    ["a string", "read the file", "plan must be a JSON object"],
    ["a number", 42, "plan must be a JSON object"],
    ["a missing goal", { steps: [] }, "plan.goal must be a non-empty string"],
    [
      "a non-string goal",
      { goal: 7, steps: [{ action: "read" }] },
      "plan.goal must be a non-empty string",
    ],
    [
      "an empty goal",
      { goal: "", steps: [{ action: "read" }] },
      "plan.goal must be a non-empty string",
    ],
    [
      "a whitespace-only goal",
      { goal: "   \n ", steps: [{ action: "read" }] },
      "plan.goal must be a non-empty string",
    ],
    ["missing steps", { goal: "g" }, "plan.steps must be a non-empty array"],
    [
      "an EMPTY steps array (a hard error, not an empty allowlist)",
      { goal: "g", steps: [] },
      "plan.steps must be a non-empty array",
    ],
    [
      "a non-array steps",
      { goal: "g", steps: { action: "read" } },
      "plan.steps must be a non-empty array",
    ],
    [
      "a null step",
      { goal: "g", steps: [null] },
      "plan.steps[0] must be an object",
    ],
    [
      "an array step",
      { goal: "g", steps: [{ action: "read" }, ["read"]] },
      "plan.steps[1] must be an object",
    ],
    [
      "a missing action",
      { goal: "g", steps: [{ description: "d" }] },
      "plan.steps[0].action must be a non-empty string",
    ],
    [
      "a whitespace-only action",
      { goal: "g", steps: [{ action: "read" }, { action: "  " }] },
      "plan.steps[1].action must be a non-empty string",
    ],
    [
      "a non-string description",
      { goal: "g", steps: [{ action: "read", description: 3 }] },
      "plan.steps[0].description must be a string when set",
    ],
    [
      "a null metadata",
      { goal: "g", steps: [{ action: "read", metadata: null }] },
      "plan.steps[0].metadata must be an object when set",
    ],
    [
      "an array metadata",
      { goal: "g", steps: [{ action: "read", metadata: ["x"] }] },
      "plan.steps[0].metadata must be an object when set",
    ],
  ];

  for (const [label, input, error] of cases) {
    test(`rejects ${label}`, () => {
      const result = validateIntentPlan(input);
      expect(result.ok).toBe(false);
      expect(result).toEqual({ ok: false, error });
    });
  }

  test("checks goal before steps (order is part of the contract)", () => {
    // Both are wrong; the goal error must win.
    const result = validateIntentPlan({ goal: "", steps: "nope" });
    expect(result).toEqual({
      ok: false,
      error: "plan.goal must be a non-empty string",
    });
  });

  test("checks the object shape before goal", () => {
    // An array with a valid-looking goal property still fails the object check.
    const arr: unknown[] = [];
    (arr as unknown as { goal: string }).goal = "a real goal";
    expect(validateIntentPlan(arr)).toEqual({
      ok: false,
      error: "plan must be a JSON object",
    });
  });

  test("reports the FIRST bad step's index, not the last", () => {
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "read" }, { action: 1 }, { action: 2 }],
    });
    expect(result).toEqual({
      ok: false,
      error: "plan.steps[1].action must be a non-empty string",
    });
  });
});

// ---- validateIntentPlan: normalization ----

describe("validateIntentPlan normalization", () => {
  test("accepts a well-formed plan and returns it under .plan", () => {
    const result = validateIntentPlan(validPlan());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(validPlan());
  });

  test("fills a missing description with '' and missing metadata with {}", () => {
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "read" }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.steps).toEqual([
      { action: "read", description: "", metadata: {} },
    ]);
  });

  test("preserves a supplied metadata object verbatim", () => {
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "bash", metadata: { inputs: { command: "ls -la" } } }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.steps[0]?.metadata).toEqual({
      inputs: { command: "ls -la" },
    });
  });

  test("trims the goal", () => {
    const result = validateIntentPlan({
      goal: "  fix the bug \n",
      steps: [{ action: "read" }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.goal).toBe("fix the bug");
  });

  test("trims each action but PRESERVES ITS CASE", () => {
    // Lowercasing here would change what savePlan writes to disk; case
    // folding belongs in planToolNames alone.
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "  ReadFile  " }, { action: "WEBSEARCH" }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.steps.map((s) => s.action)).toEqual([
      "ReadFile",
      "WEBSEARCH",
    ]);
  });

  test("keeps an explicitly-empty description as '' rather than replacing it", () => {
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "read", description: "" }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.steps[0]?.description).toBe("");
  });

  test("drops unknown step fields (the output shape is exactly PlanStep)", () => {
    const result = validateIntentPlan({
      goal: "g",
      steps: [{ action: "read", bogus: "ignored" }],
      alsoBogus: true,
    });
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.plan)).toEqual(["goal", "steps"]);
    expect(Object.keys(result.plan.steps[0]!)).toEqual([
      "action",
      "description",
      "metadata",
    ]);
  });
});

// ---- planToolNames ----

describe("planToolNames", () => {
  test("lowercases, trims, and de-duplicates", () => {
    const names = planToolNames({
      goal: "g",
      steps: [
        { action: "Read" },
        { action: "  read  " },
        { action: "READ" },
        { action: "Bash" },
      ],
    });
    expect(names).toEqual(["read", "bash"]);
  });

  test("returns [] for null/undefined/garbage rather than throwing", () => {
    for (const bad of [null, undefined, 0, "", "read", 42, [], {}]) {
      expect(planToolNames(bad)).toEqual([]);
    }
  });

  test("returns [] when steps is present but not an array", () => {
    expect(planToolNames({ goal: "g", steps: "read" })).toEqual([]);
  });

  test("skips steps whose action is not a string, keeping the rest", () => {
    const names = planToolNames({
      steps: [{ action: "read" }, { action: 5 }, null, { nope: 1 }, "read"],
    });
    expect(names).toEqual(["read"]);
  });
});

// ---- planContainsTool ----

describe("planContainsTool", () => {
  const plan = {
    goal: "g",
    steps: [{ action: "Read" }, { action: "websearch" }],
  };

  test("matches case-insensitively and ignores surrounding whitespace", () => {
    for (const name of ["read", "READ", "Read", "  read  "]) {
      expect(planContainsTool(plan, name)).toBe(true);
    }
  });

  test("returns false for a tool the plan does not declare", () => {
    expect(planContainsTool(plan, "bash")).toBe(false);
  });

  test("does NOT prefix-match, substring-match, or namespace-match", () => {
    // Exact-after-lowercase-and-trim only. An MCP tool arriving as
    // `<server>_<tool>` (opencode's confirmed format) is NOT matched by a
    // plan step naming just the bare tool, and vice versa — any exemption
    // for those belongs in the policy engine, not here.
    for (const name of [
      "rea",
      "reads",
      "read_file",
      "everything_read",
      "read.file",
      "websearc",
      "websearchx",
    ]) {
      expect(planContainsTool(plan, name)).toBe(false);
    }
  });

  test("returns false for a non-string tool name", () => {
    for (const bad of [null, undefined, 5, {}, ["read"]]) {
      expect(planContainsTool(plan, bad)).toBe(false);
    }
  });

  test("returns false for a falsy/malformed plan", () => {
    for (const bad of [null, undefined, 0, "", {}, { steps: "read" }]) {
      expect(planContainsTool(bad, "read")).toBe(false);
    }
  });

  test("agrees with planToolNames on a validated plan", () => {
    const result = validateIntentPlan(validPlan());
    if (!result.ok) throw new Error(result.error);
    for (const name of planToolNames(result.plan)) {
      expect(planContainsTool(result.plan, name)).toBe(true);
    }
  });
});
