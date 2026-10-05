import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stageRelease, validatePublicBase } from "../scripts/build_release.ts";

const repoRoot = process.cwd();
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("versioned release builder", () => {
  test("rejects insecure or credential-bearing public bases", () => {
    expect(() => validatePublicBase("http://example.com")).toThrow();
    expect(() => validatePublicBase("https://user:pass@example.com")).toThrow();
    expect(() => validatePublicBase("https://example.com/a/../b")).toThrow();
    expect(validatePublicBase("http://127.0.0.1:8769/")).toBe("http://127.0.0.1:8769");
  });

  test("stages versioned bundle, stable installer, and manifest", () => {
    const root = mkdtempSync("/tmp/armor-opencode-release-");
    temporary.push(root);
    const output = join(root, "release");
    const release = stageRelease(repoRoot, output, "http://127.0.0.1:8769");
    expect(release.version).toBe("0.0.1");
    expect(existsSync(join(output, "public/install_armoropencode.sh"))).toBe(true);
    expect(existsSync(join(output, "public/releases/armor-opencode/0.0.1/release.json"))).toBe(true);
    expect(readFileSync(join(output, "public/install_armoropencode.sh"), "utf8")).toContain("BUNDLE_SHA256=");
    expect(readFileSync(join(output, "safety-manifest.json"), "utf8")).toContain(release.releaseId);
  });

  test("refuses an existing output directory", () => {
    const root = mkdtempSync("/tmp/armor-opencode-release-");
    temporary.push(root);
    const output = join(root, "release");
    stageRelease(repoRoot, output, "http://127.0.0.1:8769");
    expect(() => stageRelease(repoRoot, output, "http://127.0.0.1:8769")).toThrow("already exists");
  });


});
