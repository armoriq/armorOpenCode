import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STAGE_REASON,
  DEFAULT_STAGE_SOURCE,
  PROPOSAL_TTL_MS,
  clearPending,
  hasPending,
  pendingPath,
  readPending,
  stagePending,
} from "../src/pending.ts";

// ---- Test data ----
//
// The policy payload is deliberately an opaque blob here: pending.ts reads no
// field of it (PolicyProfile itself belongs to the Phase 3 backend client),
// and typing/constructing a real profile would couple this test to a module
// that does not exist yet.

interface FakePolicy {
  schema: string;
  statements: Array<{ sid: string; effect: string }>;
}

function samplePolicy(sid = "allow-reads"): FakePolicy {
  return {
    schema: "armor.policy.v1",
    statements: [{ sid, effect: "allow" }],
  };
}

describe("pending store", () => {
  let dataDir: string;

  beforeEach(() => {
    // Deliberately a path that does NOT exist yet, to prove stagePending
    // creates dataDir itself (unlike planner, which creates a plans/ subdir).
    dataDir = join(mkdtempSync(join(tmpdir(), "aoc-pending-test-")), "nested");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  /**
   * Write arbitrary raw content as the pending file, creating dataDir if
   * needed — several tests plant a hand-written/legacy record without ever
   * calling stagePending.
   */
  function writeRaw(content: string): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(pendingPath(dataDir), content, "utf-8");
  }

  // ---- stagePending ----

  describe("stagePending", () => {
    test("creates dataDir itself and writes policy-pending.json", () => {
      expect(existsSync(dataDir)).toBe(false);
      stagePending(dataDir, { policy: samplePolicy() });
      expect(existsSync(join(dataDir, "policy-pending.json"))).toBe(true);
      expect(pendingPath(dataDir)).toBe(join(dataDir, "policy-pending.json"));
    });

    test("writes a camelCase record in a fixed key order", () => {
      const record = stagePending(dataDir, { policy: samplePolicy() });
      expect(Object.keys(record)).toEqual([
        "proposalId",
        "stagedAt",
        "expiresAt",
        "reason",
        "source",
        "policy",
      ]);
      const onDisk: unknown = JSON.parse(
        readFileSync(pendingPath(dataDir), "utf-8"),
      );
      expect(onDisk).toEqual(record);
    });

    test("writes pretty-printed JSON with a trailing newline", () => {
      stagePending(dataDir, { policy: samplePolicy() });
      const raw = readFileSync(pendingPath(dataDir), "utf-8");
      expect(raw.endsWith("}\n")).toBe(true);
      expect(raw).toContain('\n  "proposalId"');
    });

    test("mints a prop_-prefixed 8-hex-character proposal id", () => {
      const record = stagePending(dataDir, { policy: samplePolicy() });
      expect(record.proposalId).toMatch(/^prop_[0-9a-f]{8}$/);
    });

    test("carries the policy payload through verbatim", () => {
      const policy = samplePolicy("deny-bash");
      const record = stagePending(dataDir, { policy });
      expect(record.policy).toEqual(policy);
      expect(readPending<FakePolicy>(dataDir).record?.policy).toEqual(policy);
    });

    test("defaults reason and source when omitted or empty", () => {
      const omitted = stagePending(dataDir, { policy: samplePolicy() });
      expect(omitted.reason).toBe(DEFAULT_STAGE_REASON);
      expect(omitted.source).toBe(DEFAULT_STAGE_SOURCE);
      // `||`, not `??`: an empty string also falls back.
      const empty = stagePending(dataDir, {
        policy: samplePolicy(),
        reason: "",
        source: "",
      });
      expect(empty.reason).toBe(DEFAULT_STAGE_REASON);
      expect(empty.source).toBe(DEFAULT_STAGE_SOURCE);
    });

    test("uses a supplied reason and source", () => {
      const record = stagePending(dataDir, {
        policy: samplePolicy(),
        reason: "denied bash rm -rf",
        source: "mcp",
      });
      expect(record.reason).toBe("denied bash rm -rf");
      expect(record.source).toBe("mcp");
    });

    test("names ArmorOpenCode (not ArmorGemini) in the default reason", () => {
      expect(DEFAULT_STAGE_REASON).toContain("ArmorOpenCode");
      expect(DEFAULT_STAGE_REASON).not.toContain("ArmorGemini");
    });

    test("STORES expiresAt at stage time, PROPOSAL_TTL_MS after stagedAt", () => {
      const before = Date.now();
      const record = stagePending(dataDir, { policy: samplePolicy() });
      const after = Date.now();

      const staged = Date.parse(record.stagedAt);
      const expires = Date.parse(record.expiresAt);
      expect(staged).toBeGreaterThanOrEqual(before);
      expect(staged).toBeLessThanOrEqual(after);
      expect(expires - staged).toBe(PROPOSAL_TTL_MS);
      expect(PROPOSAL_TTL_MS).toBe(30 * 60 * 1000);
    });

    test("is a SINGLE SLOT: re-staging overwrites and re-mints the id", () => {
      const first = stagePending(dataDir, { policy: samplePolicy("first") });
      const second = stagePending(dataDir, { policy: samplePolicy("second") });

      expect(second.proposalId).not.toBe(first.proposalId);
      const { record } = readPending<FakePolicy>(dataDir);
      expect(record?.proposalId).toBe(second.proposalId);
      expect(record?.policy.statements[0]?.sid).toBe("second");
    });
  });

  // ---- readPending: expiry ----

  describe("readPending expiry", () => {
    test("reports a freshly-staged proposal as not expired", () => {
      const staged = stagePending(dataDir, { policy: samplePolicy() });
      const { record, expired } = readPending<FakePolicy>(dataDir);
      expect(record?.proposalId).toBe(staged.proposalId);
      expect(expired).toBe(false);
    });

    test("reports a past expiresAt as expired", () => {
      const staged = stagePending(dataDir, { policy: samplePolicy() });
      writeRaw(
        JSON.stringify({
          ...staged,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      const { record, expired } = readPending<FakePolicy>(dataDir);
      expect(expired).toBe(true);
      // The record still comes back — the caller decides what to do with it.
      expect(record?.proposalId).toBe(staged.proposalId);
    });

    test("an ABSENT expiresAt reads as NOT expired (a legacy record never expires)", () => {
      // Load-bearing: flipping this to fail-closed would silently discard
      // legacy/hand-written proposals. Staging is user-initiated and the
      // confirmation step is the real gate.
      writeRaw(
        JSON.stringify({
          proposalId: "prop_legacy1",
          stagedAt: "2020-01-01T00:00:00.000Z",
          reason: "hand-written, no expiresAt field at all",
          source: "cli",
          policy: samplePolicy(),
        }),
      );
      const { record, expired } = readPending<FakePolicy>(dataDir);
      expect(record?.proposalId).toBe("prop_legacy1");
      expect(expired).toBe(false);
    });

    test("an empty-string expiresAt also reads as not expired (falsy, so unchecked)", () => {
      writeRaw(
        JSON.stringify({
          proposalId: "prop_empty01",
          expiresAt: "",
          policy: samplePolicy(),
        }),
      );
      expect(readPending(dataDir).expired).toBe(false);
    });

    test("a MALFORMED expiresAt reads as not expired (Date.now() > NaN is false)", () => {
      for (const bad of ["not-a-date", "yesterday", "2020-13-45T99:99:99Z"]) {
        writeRaw(
          JSON.stringify({
            proposalId: "prop_bad00001",
            expiresAt: bad,
            policy: samplePolicy(),
          }),
        );
        expect(Number.isNaN(Date.parse(bad))).toBe(true);
        expect(readPending(dataDir).expired).toBe(false);
      }
    });

    test("does NOT delete an expired file — clearing is the caller's job", () => {
      const staged = stagePending(dataDir, { policy: samplePolicy() });
      writeRaw(
        JSON.stringify({
          ...staged,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      expect(readPending(dataDir).expired).toBe(true);
      // Still there, byte-for-byte, after the read.
      expect(existsSync(pendingPath(dataDir))).toBe(true);
      const raw = readFileSync(pendingPath(dataDir), "utf-8");
      expect(readPending(dataDir).expired).toBe(true);
      expect(readFileSync(pendingPath(dataDir), "utf-8")).toBe(raw);
    });
  });

  // ---- readPending: absent / corrupt ----

  describe("readPending absent and corrupt", () => {
    test("returns { record: null, expired: false } when nothing is staged", () => {
      expect(readPending(dataDir)).toEqual({ record: null, expired: false });
    });

    test("returns the SAME result for corrupt JSON — deliberately indistinguishable", () => {
      const absent = readPending(dataDir);
      stagePending(dataDir, { policy: samplePolicy() });
      writeRaw("{ this is not json");
      expect(readPending(dataDir)).toEqual({ record: null, expired: false });
      expect(readPending(dataDir)).toEqual(absent);
    });

    test("does not delete a corrupt file either", () => {
      stagePending(dataDir, { policy: samplePolicy() });
      writeRaw("{ corrupt");
      readPending(dataDir);
      expect(existsSync(pendingPath(dataDir))).toBe(true);
      expect(readFileSync(pendingPath(dataDir), "utf-8")).toBe("{ corrupt");
    });

    test("does not shape-validate well-formed-but-wrong JSON", () => {
      stagePending(dataDir, { policy: samplePolicy() });
      writeRaw(JSON.stringify({ totally: "wrong" }));
      const { record, expired } = readPending(dataDir);
      expect(record as unknown).toEqual({ totally: "wrong" });
      expect(expired).toBe(false);
    });

    test("survives JSON that parses to a NON-OBJECT, never expiring", () => {
      // This is the one branch the `as PendingRecord` cast actually puts at
      // risk: readPending dereferences `record.expiresAt` on whatever came
      // back from JSON.parse. `null` makes that dereference throw a
      // TypeError, which the catch swallows into the same result as "nothing
      // staged"; the other primitives just read `undefined` and fall through
      // the not-expired branch, so they come back AS the record. Neither is
      // a crash, and neither ever reports expired — pinned here because a
      // future "tidy the cast away" change could easily turn one into a
      // throw that escapes.
      const cases: Array<[raw: string, record: unknown]> = [
        ["null", null], // dereference throws -> caught -> null
        ["5", 5], // primitives pass straight through
        ['"a string"', "a string"],
        ["true", true],
        ["[]", []],
      ];

      for (const [raw, expectedRecord] of cases) {
        writeRaw(raw);
        const result = readPending(dataDir);
        expect(result.record as unknown).toEqual(expectedRecord);
        expect(result.expired).toBe(false);
        // And it never throws out to the caller.
        expect(() => readPending(dataDir)).not.toThrow();
      }
    });
  });

  // ---- hasPending / clearPending ----

  describe("hasPending and clearPending", () => {
    test("hasPending is false before staging, true after", () => {
      expect(hasPending(dataDir)).toBe(false);
      stagePending(dataDir, { policy: samplePolicy() });
      expect(hasPending(dataDir)).toBe(true);
    });

    test("hasPending IGNORES expiry — true alongside expired is reachable", () => {
      const staged = stagePending(dataDir, { policy: samplePolicy() });
      writeRaw(
        JSON.stringify({
          ...staged,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      expect(hasPending(dataDir)).toBe(true);
      expect(readPending(dataDir).expired).toBe(true);
    });

    test("hasPending is true for a corrupt file even though readPending says null", () => {
      stagePending(dataDir, { policy: samplePolicy() });
      writeRaw("{ corrupt");
      expect(hasPending(dataDir)).toBe(true);
      expect(readPending(dataDir).record).toBeNull();
    });

    test("clearPending removes the file", () => {
      stagePending(dataDir, { policy: samplePolicy() });
      clearPending(dataDir);
      expect(hasPending(dataDir)).toBe(false);
      expect(readPending(dataDir)).toEqual({ record: null, expired: false });
    });

    test("clearPending is a safe no-op when nothing is staged", () => {
      expect(() => clearPending(dataDir)).not.toThrow();
      // Including when dataDir itself does not exist yet.
      rmSync(dataDir, { recursive: true, force: true });
      expect(() => clearPending(dataDir)).not.toThrow();
    });
  });
});
