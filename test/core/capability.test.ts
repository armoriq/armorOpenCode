import { expect, test } from "bun:test";
import { capabilityOf } from "../../src/core/capability.ts";
import { OWN_TOOL_NAMES } from "../../src/tools/intent.ts";

const own = new Set(OWN_TOOL_NAMES);

test("OpenCode tools map to the tools-core capability table", () => {
  const table = Object.fromEntries(
    ["read", "glob", "grep", "list", "write", "edit", "apply_patch", "bash", "webfetch", "websearch", "task", "todowrite", "skill"].map((t) => [t, capabilityOf(t, own)]),
  );
  expect(table).toEqual({
    read: "read",
    glob: "read",
    grep: "read",
    list: "read",
    write: "write",
    edit: "write",
    apply_patch: "write",
    bash: "shell",
    webfetch: "web",
    websearch: "web",
    task: "other",
    todowrite: "other",
    skill: "other",
  });
});

test("every MCP tool is mcp, read-only ones included; the plugin's own tools are other", () => {
  expect(capabilityOf("github_get_issue", own)).toBe("mcp");
  expect(capabilityOf("filesystem_read_file", own)).toBe("mcp");
  expect(capabilityOf("register_intent_plan", own)).toBe("other");
  expect(capabilityOf("trust_revoke", own)).toBe("other");
  expect(capabilityOf("policy_read", own)).toBe("read");
});
