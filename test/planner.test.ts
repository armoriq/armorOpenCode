import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { IntentPlan } from "../src/intent-schema.ts";
import {
  clearPlan,
  hasPlan,
  loadPlan,
  planAgeSeconds,
  planFilePath,
  safeSessionId,
  savePlan,
} from "../src/planner.ts";

// ---- Test data ----

function samplePlan(): IntentPlan {
  return {
    goal: "Fix the failing test",
    steps: [
      { action: "read", description: "read the test file", metadata: {} },
      {
        action: "bash",
        description: "run the suite",
        metadata: { inputs: { command: "bun test" } },
      },
    ],
  };
}

// ---- safeSessionId: the path-traversal defense ----

describe("safeSessionId", () => {
  test("passes through an already-safe id unchanged", () => {
    expect(safeSessionId("ses_abc-123_XYZ")).toBe("ses_abc-123_XYZ");
  });

  test("replaces every character outside [A-Za-z0-9_-] with an underscore", () => {
    expect(safeSessionId("a.b/c\\d:e f")).toBe("a_b_c_d_e_f");
    expect(safeSessionId("../../etc/passwd")).toBe("______etc_passwd");
    expect(safeSessionId("a b")).toBe("a_b");
    // A literal NUL, written as an escape so it cannot smuggle a raw
    // control byte into this source file, is sanitized like anything else.
    expect(safeSessionId("a\u0000b")).toBe("a_b");
    expect(safeSessionId("emoji-\u{1F600}")).toBe("emoji-__");
  });

  test('falls back to "unknown" for every falsy input', () => {
    // `String(sessionId || "")` means null/undefined/""/0/false/NaN all
    // collapse, and so does a value made entirely of stripped characters
    // only if it becomes empty — which it can't, since replacement keeps
    // length. So this list is exactly the falsy set.
    for (const bad of [null, undefined, "", 0, false, NaN]) {
      expect(safeSessionId(bad)).toBe("unknown");
    }
  });

  test("truncates to 128 characters", () => {
    expect(safeSessionId("a".repeat(200))).toBe("a".repeat(128));
    expect(safeSessionId("a".repeat(200))).toHaveLength(128);
    expect(safeSessionId("a".repeat(128))).toHaveLength(128);
    expect(safeSessionId("a".repeat(127))).toHaveLength(127);
  });

  test("sanitizes a hostile id that is ALSO over-long (both guards apply)", () => {
    // Note the replace/truncate ORDER is deliberately not asserted here:
    // mutation testing showed swapping them is behaviorally equivalent,
    // because the replacement is 1:1 in UTF-16 code units. What matters —
    // and what this pins — is that a long, traversal-laden id comes back
    // both fully sanitized and capped.
    const hostile = "../".repeat(60) + "etc/passwd";
    const result = safeSessionId(hostile);
    expect(result).toHaveLength(128);
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result).not.toContain(".");
    expect(result).not.toContain("/");
  });
});

// ---- Filesystem behavior ----

describe("planner filesystem behavior", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "aoc-planner-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** True iff `candidate` resolves to somewhere at/under `dir`. */
  function isInside(dir: string, candidate: string): boolean {
    const rel = relative(resolve(dir), resolve(candidate));
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
  }

  describe("planFilePath", () => {
    test("lands inside <dataDir>/plans", () => {
      const file = planFilePath(dataDir, "ses_1");
      expect(file).toBe(join(dataDir, "plans", "ses_1.json"));
      expect(isInside(join(dataDir, "plans"), file)).toBe(true);
    });

    test("a traversal-laden session id CANNOT escape the plans directory", () => {
      for (const hostile of [
        "../../etc/passwd",
        "..",
        "../..",
        "/etc/shadow",
        "..\\..\\windows\\system32",
        "./../../../../../../tmp/pwned",
      ]) {
        const file = planFilePath(dataDir, hostile);
        expect(isInside(join(dataDir, "plans"), file)).toBe(true);
        // And the filename component itself contains no separators or dots.
        expect(file.slice(join(dataDir, "plans").length + 1)).toMatch(
          /^[A-Za-z0-9_-]+\.json$/,
        );
      }
    });

    test('re-sanitizes independently, so a raw id reaches the same file as a pre-sanitized one', () => {
      expect(planFilePath(dataDir, "a/b")).toBe(
        planFilePath(dataDir, safeSessionId("a/b")),
      );
    });
  });

  describe("savePlan", () => {
    test("creates the plans directory and writes the file", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      expect(existsSync(join(dataDir, "plans", "ses_1.json"))).toBe(true);
    });

    test("writes a snake_case record with the plan's goal and steps", () => {
      const record = savePlan(dataDir, "ses_1", samplePlan());
      const onDisk: unknown = JSON.parse(
        readFileSync(join(dataDir, "plans", "ses_1.json"), "utf-8"),
      );
      expect(onDisk).toEqual(record);
      expect(Object.keys(record)).toEqual([
        "session_id",
        "registered_at",
        "goal",
        "steps",
      ]);
      expect(record.goal).toBe("Fix the failing test");
      expect(record.steps).toEqual(samplePlan().steps);
      expect(record.registered_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
      );
    });

    test("stores the SANITIZED id in the record, not the raw one", () => {
      const record = savePlan(dataDir, "../../etc/passwd", samplePlan());
      expect(record.session_id).toBe("______etc_passwd");
      // The file lives under plans/, named by the sanitized id — nothing was
      // written outside dataDir.
      expect(readdirSync(join(dataDir, "plans"))).toEqual([
        "______etc_passwd.json",
      ]);
    });

    test("writes pretty-printed JSON with a trailing newline", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const raw = readFileSync(join(dataDir, "plans", "ses_1.json"), "utf-8");
      expect(raw.endsWith("}\n")).toBe(true);
      expect(raw).toContain('\n  "session_id"');
    });

    test("overwrites an earlier plan for the same session", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      savePlan(dataDir, "ses_1", { goal: "second", steps: [] });
      expect(readdirSync(join(dataDir, "plans"))).toHaveLength(1);
      expect(loadPlan(dataDir, "ses_1")?.goal).toBe("second");
    });

    test('a null/empty session id writes to the "unknown" slot', () => {
      savePlan(dataDir, null, samplePlan());
      expect(existsSync(join(dataDir, "plans", "unknown.json"))).toBe(true);
      expect(loadPlan(dataDir, "")?.session_id).toBe("unknown");
    });
  });

  describe("loadPlan / hasPlan / clearPlan", () => {
    test("round-trips a saved plan", () => {
      const record = savePlan(dataDir, "ses_1", samplePlan());
      expect(loadPlan(dataDir, "ses_1")).toEqual(record);
    });

    test("returns null when nothing is stored", () => {
      expect(loadPlan(dataDir, "ses_1")).toBeNull();
      expect(hasPlan(dataDir, "ses_1")).toBe(false);
    });

    test("returns null for CORRUPT JSON (and leaves the file in place)", () => {
      const file = planFilePath(dataDir, "ses_1");
      mkdirSync(join(dataDir, "plans"), { recursive: true });
      writeFileSync(file, "{ not json at all", "utf-8");
      expect(loadPlan(dataDir, "ses_1")).toBeNull();
      // hasPlan only checks existence, so it still reports true — corrupt is
      // not the same as absent as far as the filesystem is concerned.
      expect(hasPlan(dataDir, "ses_1")).toBe(true);
      expect(existsSync(file)).toBe(true);
    });

    test("does NOT re-validate the shape of well-formed-but-wrong JSON", () => {
      const file = planFilePath(dataDir, "ses_1");
      mkdirSync(join(dataDir, "plans"), { recursive: true });
      writeFileSync(file, JSON.stringify({ nonsense: true }), "utf-8");
      expect(loadPlan(dataDir, "ses_1") as unknown).toEqual({
        nonsense: true,
      });
    });

    test("passes non-object JSON straight through without throwing", () => {
      // Same `as PlanRecord` cast hazard as readPending, but loadPlan never
      // dereferences the result, so even `null` comes back as-is rather than
      // throwing. The consumers (planToolNames/planContainsTool) all take
      // `unknown` and degrade to [] / false, which is what keeps this safe.
      mkdirSync(join(dataDir, "plans"), { recursive: true });
      const file = planFilePath(dataDir, "ses_1");
      for (const [raw, expected] of [
        ["[]", []],
        ["null", null],
        ["5", 5],
        ['"str"', "str"],
      ] as Array<[string, unknown]>) {
        writeFileSync(file, raw, "utf-8");
        expect(() => loadPlan(dataDir, "ses_1")).not.toThrow();
        expect(loadPlan(dataDir, "ses_1") as unknown).toEqual(expected);
      }
    });

    test("clearPlan removes the file and is a safe no-op when absent", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      clearPlan(dataDir, "ses_1");
      expect(hasPlan(dataDir, "ses_1")).toBe(false);
      expect(() => clearPlan(dataDir, "ses_1")).not.toThrow();
    });

    test("clearPlan sanitizes too, so it cannot delete outside the plans dir", () => {
      const outside = join(dataDir, "important.json");
      writeFileSync(outside, "keep me", "utf-8");
      clearPlan(dataDir, "../important.json");
      expect(existsSync(outside)).toBe(true);
    });
  });

  // ---- planAgeSeconds: mtime semantics + fail-closed infinity ----

  describe("planAgeSeconds", () => {
    test("returns POSITIVE_INFINITY when there is no plan", () => {
      // This is what makes a caller's naive `age > ttl` comparison DENY by
      // construction rather than fail open. A `null`/`0` return here would
      // silently permit unplanned tool calls.
      const age = planAgeSeconds(dataDir, "ses_1");
      expect(age).toBe(Number.POSITIVE_INFINITY);
      expect(age > 600).toBe(true);
      expect(Number.isFinite(age)).toBe(false);
    });

    test("returns POSITIVE_INFINITY for a session whose id sanitizes elsewhere", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      expect(planAgeSeconds(dataDir, "ses_2")).toBe(Number.POSITIVE_INFINITY);
    });

    test("is near zero for a freshly-written plan", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const age = planAgeSeconds(dataDir, "ses_1");
      expect(Number.isFinite(age)).toBe(true);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(5);
    });

    test("derives the age from FILESYSTEM MTIME, not from registered_at", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const file = planFilePath(dataDir, "ses_1");

      // Doctor registered_at to claim the plan is brand new, then backdate
      // the mtime by an hour. If the implementation ever switched to reading
      // registered_at, this would report ~0 instead of ~3600.
      const record = JSON.parse(readFileSync(file, "utf-8")) as {
        registered_at: string;
      };
      record.registered_at = new Date().toISOString();
      writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf-8");

      const anHourAgo = new Date(Date.now() - 3600_000);
      utimesSync(file, anHourAgo, anHourAgo);

      const age = planAgeSeconds(dataDir, "ses_1");
      expect(age).toBeGreaterThan(3500);
      expect(age).toBeLessThan(3700);
    });

    test("the converse: a stale registered_at with a fresh mtime reads as fresh", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const file = planFilePath(dataDir, "ses_1");
      writeFileSync(
        file,
        JSON.stringify(
          {
            session_id: "ses_1",
            registered_at: "2020-01-01T00:00:00.000Z",
            goal: "old",
            steps: [],
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
      // The write just refreshed the mtime, so this plan is NEW despite the
      // ancient registered_at. That's the documented behavior: copying or
      // touching a plan file resets its age.
      expect(planAgeSeconds(dataDir, "ses_1")).toBeLessThan(5);
    });

    test("returns POSITIVE_INFINITY when statSync THROWS, not just when absent", () => {
      // The other half of the fail-closed guarantee, and the reason the
      // implementation is one statSync in a try/catch rather than an
      // existsSync guard: each of these paths makes statSync throw a
      // DIFFERENT errno, and every one must still deny.
      const plansDir = join(dataDir, "plans");
      mkdirSync(plansDir, { recursive: true });

      // A dangling symlink at the plan path -> ENOENT on stat (a real file
      // entry exists, so this is NOT the plain missing-file case).
      symlinkSync(join(plansDir, "missing-target"), join(plansDir, "a.json"));
      // A symlink loop -> ELOOP, an errno the absent case never produces.
      symlinkSync(join(plansDir, "c.json"), join(plansDir, "b.json"));
      symlinkSync(join(plansDir, "b.json"), join(plansDir, "c.json"));

      // Session ids are bare so safeSessionId leaves them alone; anything
      // with a "/" or "." would be sanitized and land on a different path.
      for (const sessionId of ["a", "b", "c"]) {
        const age = planAgeSeconds(dataDir, sessionId);
        expect(age).toBe(Number.POSITIVE_INFINITY);
        // The point of the infinity: a caller's naive comparison denies.
        expect(age > 600).toBe(true);
      }

      // Sanity-check the premise: these really are throwing stats, not
      // just absent files, so this test exercises the catch and not the
      // ENOENT path the previous tests already cover.
      expect(() => statSync(join(plansDir, "b.json"))).toThrow();
      expect(existsSync(join(plansDir, "b.json"))).toBe(false);
    });

    test("swallows the stat error rather than propagating it to the caller", () => {
      // A throw escaping here would crash the hook instead of denying, which
      // is a different (and worse) failure mode than reporting "too old".
      const plansDir = join(dataDir, "plans");
      mkdirSync(plansDir, { recursive: true });
      symlinkSync(join(plansDir, "y.json"), join(plansDir, "x.json"));
      symlinkSync(join(plansDir, "x.json"), join(plansDir, "y.json"));

      expect(() => planAgeSeconds(dataDir, "x")).not.toThrow();
      expect(() => planAgeSeconds(dataDir, "definitely-absent")).not.toThrow();
    });

    test("clamps a future mtime to 0 rather than reporting a negative age", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const file = planFilePath(dataDir, "ses_1");
      const inAnHour = new Date(Date.now() + 3600_000);
      utimesSync(file, inAnHour, inAnHour);
      // Without the Math.max(0, ...) guard, clock skew would make a plan
      // read as "negative seconds old" — i.e. permanently fresh.
      expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now());
      expect(planAgeSeconds(dataDir, "ses_1")).toBe(0);
    });

    test("grows monotonically as the mtime recedes", () => {
      savePlan(dataDir, "ses_1", samplePlan());
      const file = planFilePath(dataDir, "ses_1");
      const ages: number[] = [];
      for (const secondsAgo of [10, 100, 1000]) {
        const when = new Date(Date.now() - secondsAgo * 1000);
        utimesSync(file, when, when);
        ages.push(planAgeSeconds(dataDir, "ses_1"));
      }
      expect(ages[0]).toBeLessThan(ages[1]!);
      expect(ages[1]).toBeLessThan(ages[2]!);
      // ...and the absolute value tracks the mtime, not just its ordering.
      expect(ages[0]).toBeGreaterThanOrEqual(10);
      expect(ages[0]).toBeLessThan(12);
      expect(ages[2]).toBeGreaterThanOrEqual(1000);
      expect(ages[2]).toBeLessThan(1002);
    });
  });
});
