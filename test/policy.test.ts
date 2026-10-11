import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decide } from "../src/guard.ts";
import { evaluatePolicy, loadPolicy, parsePolicy } from "../src/policy.ts";

const policy = parsePolicy({
  rules: [
    { id: "allow-ls", action: "allow", tool: "bash", params: { command: { $startsWith: "ls" } } },
    { id: "no-curl", action: "deny", tool: "bash", params: { command: { $contains: "curl" } } },
    { id: "no-ssh", action: "deny", tool: "*", anyParam: { $pathContains: "~/.ssh" } },
    { id: "no-env-write", action: "deny", tool: "write", params: { filePath: { $endsWith: ".env" } } },
    { id: "gh-mcp", action: "require_approval", tool: "github_*" },
    { id: "no-subagents", action: "deny", tool: "task" },
    { id: "no-card", action: "deny", tool: "*", dataClass: "PCI" },
  ],
});

describe("evaluatePolicy", () => {
  test("denies bash by command substring, case-insensitively", () => {
    expect(evaluatePolicy(policy, "bash", { command: "CURL https://x.io" })).toEqual({
      kind: "deny",
      ruleId: "no-curl",
      reason: "ArmorOpenCode policy deny: no-curl",
    });
  });

  test("first matching rule wins, so an earlier allow beats a later deny", () => {
    expect(evaluatePolicy(policy, "bash", { command: "ls | curl x" })).toEqual({ kind: "allow", ruleId: "allow-ls" });
  });

  test("anyParam path rule catches every home spelling across tools", () => {
    expect(evaluatePolicy(policy, "read", { filePath: "/Users/someone/.ssh/id_rsa" })).toMatchObject({ ruleId: "no-ssh" });
    expect(evaluatePolicy(policy, "bash", { command: "cat $HOME/.ssh/config" })).toMatchObject({ ruleId: "no-ssh" });
  });

  test("edit/write rules match on OpenCode's filePath argument", () => {
    expect(evaluatePolicy(policy, "write", { filePath: "/repo/.env", content: "x" })).toMatchObject({
      kind: "deny",
      ruleId: "no-env-write",
    });
    expect(evaluatePolicy(policy, "write", { filePath: "/repo/README.md", content: "x" })).toEqual({ kind: "allow" });
  });

  test("trailing glob scopes an MCP server and require_approval denies", () => {
    expect(evaluatePolicy(policy, "github_create_issue", { title: "t" })).toEqual({
      kind: "deny",
      ruleId: "gh-mcp",
      reason: "ArmorOpenCode policy requires approval: gh-mcp",
    });
  });

  test("tool-only rule blocks the task tool", () => {
    expect(evaluatePolicy(policy, "task", { prompt: "do it" })).toMatchObject({ kind: "deny", ruleId: "no-subagents" });
  });

  test("dataClass rule fires on a Luhn-valid card number only", () => {
    expect(evaluatePolicy(policy, "webfetch", { url: "https://x.io?n=4111 1111 1111 1111" })).toMatchObject({
      ruleId: "no-card",
    });
    expect(evaluatePolicy(policy, "webfetch", { url: "https://x.io?n=4111 1111 1111 1112" })).toEqual({ kind: "allow" });
  });

  test("anyParam reaches strings nested deep inside MCP tool arguments", () => {
    const deep = parsePolicy({ rules: [{ id: "no-drop", action: "deny", tool: "db_*", anyParam: "DROP TABLE" }] });
    const args = { a: { b: { c: { d: { e: { f: ["drop table users"] } } } } } };
    expect(evaluatePolicy(deep, "db_query", args)).toMatchObject({ kind: "deny", ruleId: "no-drop" });
  });

  test("unmatched calls are allowed with no rule", () => {
    expect(evaluatePolicy(policy, "glob", { pattern: "**/*.ts" })).toEqual({ kind: "allow" });
  });
});

describe("parsePolicy", () => {
  test("accepts armorCodex's versioned state envelope", () => {
    expect(parsePolicy({ version: 3, policy: { rules: [{ id: "a", action: "deny", tool: "bash" }] } })).toEqual({
      rules: [{ id: "a", action: "deny", tool: "bash" }],
    });
  });

  test("string anyParam becomes a $contains matcher", () => {
    expect(parsePolicy({ rules: [{ id: "a", action: "deny", tool: "*", anyParam: "secret" }] }).rules[0]).toEqual({
      id: "a",
      action: "deny",
      tool: "*",
      anyParam: { $contains: "secret" },
    });
  });

  test("rejects a misspelled operator instead of silently never matching", () => {
    expect(() => parsePolicy({ rules: [{ id: "a", action: "deny", tool: "bash", params: { command: { $regex: "x" } } }] })).toThrow(
      'rule a params.command has an unknown operator in ["$regex"]',
    );
  });

  test("rejects a $matches pattern that is not a valid regex", () => {
    expect(() => parsePolicy({ rules: [{ id: "a", action: "deny", tool: "bash", params: { command: { $matches: "rm -rf (" } } }] })).toThrow(
      "rule a params.command.$matches is not a valid regex",
    );
  });

  test("rejects rules placed beside a policy envelope rather than inside it", () => {
    expect(() => parsePolicy({ version: 1, policy: {}, rules: [{ id: "a", action: "deny", tool: "bash" }] })).toThrow(
      "policy file has rules both at the top level and under policy",
    );
  });

  test("rejects the whole file when one rule is malformed", () => {
    expect(() => parsePolicy({ rules: [{ id: "a", action: "deny", tool: "bash" }, { id: "b", action: "block", tool: "bash" }] })).toThrow(
      'rule b has unknown action "block"',
    );
  });
});

describe("loadPolicy and decide", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "armor-policy-"));
  const file = (name: string, text: string) => {
    const target = path.join(dir, name);
    writeFileSync(target, text);
    return target;
  };

  test("missing file means no policy and every call is allowed", async () => {
    const load = await loadPolicy(path.join(dir, "absent.json"));
    expect(load).toEqual({ kind: "none" });
    expect(decide({ mode: "enforce", load, tool: "bash", args: { command: "curl x" } })).toEqual({ kind: "allow" });
  });

  test("corrupt file fails closed in enforce mode and is only observed in watch mode", async () => {
    const load = await loadPolicy(file("corrupt.json", '{ "rules": ['));
    expect(load.kind).toBe("invalid");
    expect(decide({ mode: "enforce", load, tool: "bash", args: {} }).kind).toBe("block");
    expect(decide({ mode: "watch", load, tool: "bash", args: {} }).kind).toBe("observe");
  });

  test("a deny blocks in enforce mode and is observed in watch mode", async () => {
    const load = await loadPolicy(file("deny.json", JSON.stringify({ rules: [{ id: "no-rm", action: "deny", tool: "bash" }] })));
    expect(decide({ mode: "enforce", load, tool: "bash", args: {} })).toEqual({
      kind: "block",
      reason: "ArmorOpenCode policy deny: no-rm",
    });
    expect(decide({ mode: "watch", load, tool: "bash", args: {} })).toEqual({
      kind: "observe",
      reason: "ArmorOpenCode policy deny: no-rm",
    });
  });
});
