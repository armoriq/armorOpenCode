import { describe, expect, test } from "bun:test";

import { MCP_SERVER_NAME } from "../scripts/install.ts";
import { INTENT_PLAN_FORMAT } from "../src/intent-schema.ts";
import {
  ALWAYS_ALLOWED_NATIVE_TOOLS,
  ARMOR_MCP_SERVER_NAME,
  ARMOR_POLICY_TOOL_NAMES,
  OPENCODE_TO_BACKEND_TOOL,
  isAlwaysAllowedNativeTool,
  isArmorPolicyTool,
  toBackendToolName,
} from "../src/tool-name-map.ts";

// ---- toBackendToolName ----

describe("toBackendToolName", () => {
  const table: [string, string][] = [
    ["*", "*"],
    ["read", "Read"],
    ["write", "Write"],
    ["edit", "Edit"],
    ["apply_patch", "Edit"],
    ["bash", "Bash"],
    ["glob", "Glob"],
    ["grep", "Grep"],
    ["webfetch", "WebFetch"],
    ["websearch", "WebSearch"],
  ];

  for (const [input, expected] of table) {
    test(`maps ${input} to ${expected}, ignoring case and padding`, () => {
      expect(toBackendToolName(input)).toBe(expected);
      expect(toBackendToolName(input.toUpperCase())).toBe(expected);
      expect(toBackendToolName(`  ${input} \n`)).toBe(expected);
    });
  }

  test("returns an unknown name untouched: same casing, no trim", () => {
    expect(toBackendToolName("  Foo ")).toBe("  Foo ");
    expect(toBackendToolName("everything_echo")).toBe("everything_echo");
    expect(toBackendToolName("")).toBe("");
  });

  test("non strings never throw and come back as strings (AC-X3)", () => {
    for (const bad of [undefined, null, 5, {}, [], Symbol("x"), Object.create(null)]) {
      expect(typeof toBackendToolName(bad as unknown as string)).toBe("string");
    }
  });

  test("prototype keys return themselves", () => {
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(toBackendToolName(name)).toBe(name);
    }
  });

  test("is idempotent on every backend name", () => {
    for (const backend of OPENCODE_TO_BACKEND_TOOL.values()) {
      expect(toBackendToolName(backend)).toBe(backend);
    }
  });
});

// ---- isAlwaysAllowedNativeTool ----

describe("isAlwaysAllowedNativeTool", () => {
  test("true for exactly the five exempt tools, case and padding insensitive", () => {
    for (const name of ["todowrite", "todoread", "lsp", "skill", "question"]) {
      expect(isAlwaysAllowedNativeTool(name)).toBe(true);
      expect(isAlwaysAllowedNativeTool(` ${name.toUpperCase()} `)).toBe(true);
    }
    expect(ALWAYS_ALLOWED_NATIVE_TOOLS.size).toBe(5);
  });

  test("false for MCP prefixed forms and other tools", () => {
    for (const name of ["everything_skill", "bash", "read", "", "skills"]) {
      expect(isAlwaysAllowedNativeTool(name)).toBe(false);
    }
  });

  test("false for non strings", () => {
    for (const v of [undefined, null, 1, {}, ["skill"]]) {
      expect(isAlwaysAllowedNativeTool(v)).toBe(false);
    }
  });
});

// ---- isArmorPolicyTool ----

describe("isArmorPolicyTool", () => {
  const positives = [
    "armor-opencode-policy_register_intent_plan",
    "armor-opencode-policy_reset_intent_plan",
    "armor-opencode-policy_get_intent_plan",
  ];

  test("true for exactly the three qualified names", () => {
    for (const name of positives) {
      expect(isArmorPolicyTool(name)).toBe(true);
      expect(isArmorPolicyTool(name.toUpperCase())).toBe(true);
      expect(isArmorPolicyTool(`  ${name}\t`)).toBe(true);
    }
    expect(ARMOR_POLICY_TOOL_NAMES.size).toBe(3);
  });

  test("false for lookalikes (AC-A3 negatives)", () => {
    const negatives = [
      "register_intent_plan",
      "reset_intent_plan",
      "get_intent_plan",
      "mcp_armor-opencode-policy_register_intent_plan",
      "armor-opencode-policy__register_intent_plan",
      "evil-armor-opencode-policy_register_intent_plan",
      "armor-opencode-policy_register_intent_plan_x",
      "armor-opencode-policy_other_tool",
      "other-server_register_intent_plan",
      "",
    ];
    for (const name of negatives) {
      expect(isArmorPolicyTool(name)).toBe(false);
    }
  });

  test("false for non strings", () => {
    for (const v of [undefined, null, 1, {}, [positives[0]]]) {
      expect(isArmorPolicyTool(v)).toBe(false);
    }
  });

  test("server name matches the installer's MCP_SERVER_NAME", () => {
    expect(ARMOR_MCP_SERVER_NAME).toBe(MCP_SERVER_NAME);
  });
});

// ---- coverage of the tools the model is told to plan ----

describe("INTENT_PLAN_FORMAT coverage", () => {
  // Same parser as test/intent-schema.test.ts.
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

  test("every planned tool is mapped or always allowed", () => {
    const listed = parseListedTools();
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      const classified =
        OPENCODE_TO_BACKEND_TOOL.has(name) ||
        ALWAYS_ALLOWED_NATIVE_TOOLS.has(name);
      expect({ name, classified }).toEqual({ name, classified: true });
    }
  });
});
