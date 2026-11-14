// Prints the newest released CHANGELOG.md version and writes its notes to the given file; prints nothing before the first release.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Release = { version: string; notes: string };

const HEADING = /^## \[(.+?)\](.*)$/;
const RELEASED = /^\d+\.\d+\.\d+$/;
const DATED = /^ - \d{4}-\d{2}-\d{2}$/;

export function latestRelease(changelog: string): Release | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => HEADING.test(line) && !line.startsWith("## [Unreleased]"));
  if (start < 0) return null;
  const [, version = "", date = ""] = HEADING.exec(lines[start]!)!;
  if (!RELEASED.test(version) || !DATED.test(date)) throw new Error(`CHANGELOG.md heading is not "## [x.y.z] - YYYY-MM-DD": ${lines[start]}`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  if (!notes) throw new Error(`CHANGELOG.md section ${version} has no notes`);
  return { version, notes };
}

if (import.meta.main) {
  const [notesFile] = process.argv.slice(2);
  if (!notesFile) throw new Error("usage: bun scripts/release-notes.ts <notes-file>");
  const release = latestRelease(readFileSync(path.join(import.meta.dir, "..", "CHANGELOG.md"), "utf8"));
  if (release) {
    writeFileSync(notesFile, `${release.notes}\n`);
    process.stdout.write(release.version);
  }
}
