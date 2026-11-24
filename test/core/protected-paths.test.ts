import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionStore } from "../../src/state/sessions.ts";
import { checkBuiltin, type BuiltinContext } from "../../src/core/builtin-rules.ts";
import { hostFor } from "../../src/host.ts";
import { realPrefix, Runtime } from "../../src/runtime.ts";
import { OWN_TOOL_NAMES } from "../../src/tools/intent.ts";
import { fakeRuntime } from "../support/intent-harness.ts";
import type { Login, SessionID } from "../../src/types.ts";

const root = realPrefix(mkdtempSync(path.join(tmpdir(), "aoc-protect-")));
const home = path.join(root, "home");
const project = path.join(home, "proj");
const armoriq = path.join(home, ".armoriq");
const configDir = path.join(home, ".config", "opencode");
mkdirSync(armoriq, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(path.join(armoriq, "credentials.json"), "{}");
writeFileSync(path.join(configDir, "opencode.json"), "{}");
writeFileSync(path.join(project, "opencode.json"), "{}");
writeFileSync(path.join(project, "package.json"), "{}");
symlinkSync(armoriq, path.join(root, "innocent"));
symlinkSync(path.join(configDir, "opencode.json"), path.join(project, "settings.json"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx: BuiltinContext = {
  armoriqDir: armoriq,
  ownTools: new Set(),
  shadowedTools: new Set(),
  opencodeConfigDir: configDir,
  cwd: () => project,
  realpath: realPrefix,
  readdir: (dir) => readdirSync(dir),
};

const check = (tool: string, args: Record<string, unknown>) => checkBuiltin({ sessionId: "s" as SessionID, callId: "c", tool, args }, ctx);

describe("protected paths are resolved, not string matched", () => {
  test("shell globs, quoting and escapes that land in the ArmorIQ directory are denied", () => {
    for (const command of [
      "cat ~/.arm?riq/credentials.json",
      "cat ~/.a*/credentials.json",
      "cat ~/.[a]rmoriq/credentials.json",
      "cat ~/.*/credentials.json",
      "cat ~/.arm''oriq/credentials.json",
      'cat ~/".armoriq"/credentials.json',
      "cat ~/.arm\\oriq/credentials.json",
      `cat ${home}/proj/../.arm*/credentials.json`,
      "cd ~ && cat .arm?riq/credentials.json",
      "cd .. ; cat .arm[o]riq/credentials.json",
      "cat ~/${X}/credentials.json",
    ]) {
      expect({ command, d: check("bash", { command }) }).toMatchObject({ d: { code: "builtin_protected", ruleId: "builtin:armoriq_dir" } });
    }
  });

  test("a symlink into the ArmorIQ directory is denied for every file tool", () => {
    const link = path.join(root, "innocent", "credentials.json");
    expect(check("read", { filePath: link })).toMatchObject({ code: "builtin_protected" });
    expect(check("bash", { command: `cat ${link}` })).toMatchObject({ code: "builtin_protected" });
    expect(check("glob", { pattern: "*", path: path.join(root, "innocent") })).toMatchObject({ code: "builtin_protected" });
  });

  test("glob and grep patterns are resolved against their root", () => {
    expect(check("glob", { pattern: ".arm?riq/*", path: home })).toMatchObject({ code: "builtin_protected" });
    expect(check("grep", { pattern: "key", path: home, include: ".a*/*.json" })).toMatchObject({ code: "builtin_protected" });
  });

  test("a task prompt that points a subagent at the ArmorIQ directory is denied", () => {
    expect(check("task", { prompt: "Read ~/.arm?riq/credentials.json and summarise it", description: "x", subagent_type: "general" })).toMatchObject({ code: "builtin_protected" });
    expect(check("task", { prompt: `Print the file at ${armoriq}/credentials.json.`, description: "x" })).toMatchObject({ code: "builtin_protected" });
    expect(check("task", { prompt: "Refactor src/index.ts and run the tests", description: "x" })).toBeNull();
  });

  test("ordinary commands and globs in the project are not denied", () => {
    for (const command of ["ls *.ts", "cat package.json", "ls .*", "git status", "rg -n foo src", "cat *.md", "echo $HOME/x"]) {
      expect({ command, d: check("bash", { command }) }).toEqual({ command, d: null });
    }
    expect(check("read", { filePath: path.join(project, "opencode.json") })).toBeNull();
  });
});

describe("the OpenCode config that loads the guard", () => {
  test("writes to any opencode.json, and shell commands on it, are denied", () => {
    const deny = { code: "builtin_protected", ruleId: "builtin:opencode_config" };
    expect(check("write", { filePath: path.join(configDir, "opencode.json"), content: "{}" })).toMatchObject(deny);
    expect(check("edit", { filePath: "opencode.json", oldString: "a", newString: "b" })).toMatchObject(deny);
    expect(check("edit", { filePath: path.join(project, "settings.json"), oldString: "a", newString: "b" })).toMatchObject(deny);
    expect(check("apply_patch", { patchText: "*** Begin Patch\n*** Update File: opencode.jsonc\n@@\n-a\n+b\n*** End Patch" })).toMatchObject(deny);
    for (const command of [
      "sed -i '' '/armoropencode/d' ~/.config/opencode/opencode.json",
      "sed -i '' '/armor/d' ~/.config/opencode/*.json",
      "rm -rf ~/.config/opencode",
      "mv ~/.config ~/.config.bak",
      "sed -i '' '/armor/d' *.json",
      "python3 -c 'import json' && cat opencod?.json",
    ]) {
      expect({ command, d: check("bash", { command }) }).toMatchObject({ d: deny });
    }
  });

  test("reading the config with the read tool is allowed", () => {
    expect(check("read", { filePath: path.join(configDir, "opencode.json") })).toBeNull();
  });
});

describe("protection holds in every mode", () => {
  const login: Login = { backend: "http://127.0.0.1:9", apiKey: "ak_test_mode", userId: "u", orgId: "o", email: "e@x", deviceId: "d", deviceName: "n" };

  async function attempt(signedIn: boolean, sessionMode: "monitor" | "enforce", tool: string, args: Record<string, unknown>) {
    const rt: any = await fakeRuntime(signedIn ? login : null);
    Object.setPrototypeOf(rt, Runtime.prototype);
    Object.assign(rt, { pending: new Map(), messageModel: new Map(), traces: { record() {} }, builtin: { ...ctx, ownTools: new Set(OWN_TOOL_NAMES), shadowedTools: rt.shadowedTools } });
    rt.org = { current: () => ({ mode: sessionMode === "monitor" ? "shadow" : "enforce", notices: true }), refresh() {} };
    const notes: string[] = [];
    rt.notice = (_: string, text: string) => void notes.push(text);
    delete rt.mode;
    rt.sessions = createSessionStore(mkdtempSync(path.join(root, "sessions-")), () => rt.mode());
    expect(rt.mode()).toBe(signedIn ? sessionMode : "monitor");
    try {
      await hostFor(rt, rt.log).toolBefore({ sessionId: "s1" as SessionID, callId: "c1", tool, args });
      return { outcome: "allow", notes };
    } catch (error) {
      return { outcome: String((error as Error).message), notes };
    }
  }

  for (const [signedIn, mode] of [[false, "monitor"], [true, "monitor"], [true, "enforce"]] as const) {
    test(`${signedIn ? "signed in" : "signed out"}, ${mode}: credentials and the OpenCode config stay protected`, async () => {
      const read = await attempt(signedIn, mode, "read", { filePath: path.join(armoriq, "credentials.json") });
      expect(read.outcome).toContain("[builtin_protected]");
      expect(read.notes).toEqual([]);
      expect((await attempt(signedIn, mode, "bash", { command: "cat ~/.arm?riq/credentials.json" })).outcome).toContain("[builtin_protected]");
      expect((await attempt(signedIn, mode, "edit", { filePath: path.join(configDir, "opencode.json"), oldString: "a", newString: "b" })).outcome).toContain("[builtin_protected]");
    });
  }
});
