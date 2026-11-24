import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import config from "../tsconfig.core-strict.json";

const root = resolve(import.meta.dir, "..");

test("vendored core includes the client events contract and its test", () => {
  expect(config.include).toEqual(expect.arrayContaining([
    "src/core/client-events.ts",
    "test/contracts/client-events.test.ts",
  ]));
});

test("vendored files import only vendored files, bun:test and node built ins", () => {
  const files = new Set(config.include.map((file) => resolve(root, file)));
  const violations: string[] = [];
  for (const file of config.include.filter((file) => file.endsWith(".ts"))) {
    const path = resolve(root, file);
    const imports = ts.preProcessFile(readFileSync(path, "utf8")).importedFiles;
    for (const { fileName } of imports) {
      if (fileName === "bun:test" || fileName.startsWith("node:")) continue;
      // decide.ts imports the V2Outcome type from the workspace policy module, which armorAntigravity must vendor alongside it.
      if (file === "src/core/decide.ts" && fileName === "./policy-v2.ts") continue;
      if (fileName.startsWith(".") && files.has(resolve(dirname(path), fileName))) continue;
      violations.push(`${file} imports ${fileName}`);
    }
  }
  expect(violations).toEqual([]);
});

test("vendored core compiles with exact optional property types", () => {
  expect(config.compilerOptions.exactOptionalPropertyTypes).toBe(true);
  expect(config.compilerOptions.noEmit).toBe(true);
  const result = Bun.spawnSync([process.execPath, require.resolve("typescript/bin/tsc"), "-p", "tsconfig.core-strict.json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect({ exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }).toEqual({ exitCode: 0, output: "" });
}, 30_000);
