import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findOpenCode2Gap } from "../../src/io/opencode2.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function layout(opts: { entry?: string; opencode2In?: "path" | "home" }) {
  const root = mkdtempSync(join(tmpdir(), "aoc-oc2gap-"));
  dirs.push(root);
  const pkg = join(root, "plugin");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const d of [pkg, bin, join(home, ".opencode/bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  if (opts.entry) writeFileSync(join(pkg, opts.entry), "export default {};\n");
  if (opts.opencode2In) {
    const file = opts.opencode2In === "path" ? join(bin, "opencode2") : join(home, ".opencode/bin/opencode2");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return { packageRoot: pkg, home, env: { PATH: `/nonexistent:${bin}` }, bin };
}

describe("findOpenCode2Gap", () => {
  test("opencode2 on PATH and no root entry is a gap naming the binary", () => {
    const l = layout({ opencode2In: "path" });
    expect(findOpenCode2Gap(l)).toEqual({ opencode2: join(l.bin, "opencode2"), packageRoot: l.packageRoot });
  });

  test("a curl install in ~/.opencode/bin counts even when it is not on PATH", () => {
    const l = layout({ opencode2In: "home" });
    expect(findOpenCode2Gap(l)?.opencode2).toBe(join(l.home, ".opencode/bin/opencode2"));
  });

  for (const entry of ["index.ts", "index.js", "index.mjs"]) {
    test(`a root ${entry} closes the gap`, () => {
      expect(findOpenCode2Gap(layout({ entry, opencode2In: "path" }))).toBeNull();
    });
  }

  test("an entry only under src/ does not close the gap", () => {
    const l = layout({ opencode2In: "path" });
    mkdirSync(join(l.packageRoot, "src"));
    writeFileSync(join(l.packageRoot, "src/index.ts"), "");
    expect(findOpenCode2Gap(l)).not.toBeNull();
  });

  test("no OpenCode 2 means no gap", () => {
    expect(findOpenCode2Gap(layout({}))).toBeNull();
  });

  test("defaults to this package's root", () => {
    const l = layout({ opencode2In: "path" });
    const repo = resolve(import.meta.dir, "../..");
    const hasEntry = ["index.ts", "index.js", "index.mjs"].some((name) => existsSync(join(repo, name)));
    expect(findOpenCode2Gap({ env: l.env, home: l.home })).toEqual(hasEntry ? null : { opencode2: join(l.bin, "opencode2"), packageRoot: repo });
  });
});
