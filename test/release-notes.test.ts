import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { latestRelease } from "../scripts/release-notes.ts";

const root = path.join(import.meta.dir, "..");

describe("latestRelease", () => {
  test("returns the newest released section, skipping Unreleased", () => {
    const changelog = [
      "# Changelog",
      "",
      "Intro.",
      "",
      "## [Unreleased]",
      "",
      "- not yet",
      "",
      "## [0.3.0] - 2026-11-02",
      "",
      "### Added",
      "- call records",
      "",
      "## [0.2.0] - 2026-10-20",
      "",
      "- first",
      "",
    ].join("\n");
    expect(latestRelease(changelog)).toEqual({ version: "0.3.0", notes: "### Added\n- call records" });
  });

  test("returns null while nothing has been released", () => {
    expect(latestRelease("# Changelog\n\n## [Unreleased]\n\n- soon\n")).toBeNull();
  });

  test("a released section without notes is an error", () => {
    expect(() => latestRelease("# Changelog\n\n## [0.2.0] - 2026-10-20\n\n## [0.1.0] - 2026-10-01\n\n- x\n")).toThrow(
      "CHANGELOG.md section 0.2.0 has no notes",
    );
  });

  test("a heading that is not a semver version and date is an error", () => {
    expect(() => latestRelease("# Changelog\n\n## [v0.2] - soon\n\n- x\n")).toThrow("CHANGELOG.md heading is not");
  });
});

test("package.json is at the CHANGELOG's newest release, or nothing is released yet", () => {
  const release = latestRelease(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  if (release) expect(release.version).toBe(version);
});
