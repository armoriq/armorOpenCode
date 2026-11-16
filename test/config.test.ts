import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { version } from "../package.json" with { type: "json" };
import {
  CLIENT_HEADER,
  DEFAULT_BACKEND_ENDPOINT,
  DEFAULT_DATA_DIR,
  DEFAULT_PLAN_TTL_SECONDS,
  DEFAULT_TIMEOUT_MS,
  authHeaders,
  defaultCredentialsFilePath,
  loadConfig,
} from "../src/config.ts";

describe("loadConfig", () => {
  let tmpDir: string;
  /** A credentials.json that exists and is well-formed. */
  let credsPath: string;
  /** A path where no credentials.json exists. */
  let noCredsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aoc-config-test-"));
    credsPath = join(tmpDir, "credentials.json");
    noCredsPath = join(tmpDir, "nonexistent-credentials.json");
    writeFileSync(
      credsPath,
      JSON.stringify({
        apiKey: "key-from-file",
        backendEndpoint: "https://file.armoriq.example",
        orgId: "org-from-file",
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Shorthand: resolve with an explicit env, against the good creds file. */
  function withEnv(env: Record<string, string>) {
    return loadConfig(env, credsPath);
  }

  /** Shorthand: resolve with an explicit env and NO creds file at all. */
  function withEnvNoCreds(env: Record<string, string>) {
    return loadConfig(env, noCredsPath);
  }

  // ---- apiKey precedence ----

  describe("apiKey precedence", () => {
    test("ARMORIQ_API_KEY (shared) beats the product env var and the file", () => {
      const config = withEnv({
        ARMORIQ_API_KEY: "shared-env",
        ARMOROPENCODE_API_KEY: "product-env",
      });
      expect(config.apiKey).toBe("shared-env");
    });

    test("ARMOROPENCODE_API_KEY (product) beats the file", () => {
      const config = withEnv({ ARMOROPENCODE_API_KEY: "product-env" });
      expect(config.apiKey).toBe("product-env");
    });

    test("falls back to credentials.json", () => {
      expect(withEnv({}).apiKey).toBe("key-from-file");
    });

    test('falls back to "" — never undefined — when nothing resolves', () => {
      const config = withEnvNoCreds({});
      expect(config.apiKey).toBe("");
      expect(config.apiKey).not.toBeUndefined();
    });

    test("treats an empty-string env var as unset and keeps looking", () => {
      // `||` chaining, not `??`: "" must not shadow the file.
      const config = withEnv({
        ARMORIQ_API_KEY: "",
        ARMOROPENCODE_API_KEY: "",
      });
      expect(config.apiKey).toBe("key-from-file");
    });
  });

  // ---- backendEndpoint precedence + normalization ----

  describe("backendEndpoint", () => {
    test("ARMORIQ_BACKEND_ENDPOINT beats the product env var and the file", () => {
      const config = withEnv({
        ARMORIQ_BACKEND_ENDPOINT: "https://shared.example",
        ARMOROPENCODE_BACKEND_ENDPOINT: "https://product.example",
      });
      expect(config.backendEndpoint).toBe("https://shared.example");
    });

    test("ARMOROPENCODE_BACKEND_ENDPOINT beats the file", () => {
      const config = withEnv({
        ARMOROPENCODE_BACKEND_ENDPOINT: "https://product.example",
      });
      expect(config.backendEndpoint).toBe("https://product.example");
    });

    test("falls back to credentials.json, then to the built-in default", () => {
      expect(withEnv({}).backendEndpoint).toBe("https://file.armoriq.example");
      expect(withEnvNoCreds({}).backendEndpoint).toBe(
        DEFAULT_BACKEND_ENDPOINT,
      );
    });

    test("strips trailing slashes (one or many) from every source", () => {
      expect(
        withEnv({ ARMORIQ_BACKEND_ENDPOINT: "https://a.example/" })
          .backendEndpoint,
      ).toBe("https://a.example");
      expect(
        withEnv({ ARMORIQ_BACKEND_ENDPOINT: "https://a.example///" })
          .backendEndpoint,
      ).toBe("https://a.example");
      // A path suffix keeps its interior slashes; only the tail is stripped.
      expect(
        withEnv({ ARMORIQ_BACKEND_ENDPOINT: "https://a.example/v1/" })
          .backendEndpoint,
      ).toBe("https://a.example/v1");
    });

    test("strips trailing slashes off the credentials.json value too", () => {
      writeFileSync(
        credsPath,
        JSON.stringify({ backendEndpoint: "https://file.example//" }),
        "utf-8",
      );
      expect(withEnv({}).backendEndpoint).toBe("https://file.example");
    });
  });

  // ---- orgId: undefined, not "" ----

  describe("orgId", () => {
    test("resolves from ARMORIQ_ORG_ID", () => {
      expect(withEnv({ ARMORIQ_ORG_ID: "org-env" }).orgId).toBe("org-env");
    });

    test("has NO product-specific env var (unlike the key and endpoint)", () => {
      // ARMOROPENCODE_ORG_ID is deliberately not a thing; setting it must be
      // ignored, leaving the file value to win.
      const config = withEnv({ ARMOROPENCODE_ORG_ID: "should-be-ignored" });
      expect(config.orgId).toBe("org-from-file");
    });

    test("falls back to credentials.json", () => {
      expect(withEnv({}).orgId).toBe("org-from-file");
    });

    test("is genuinely `undefined` when unresolved, NOT an empty string", () => {
      const config = withEnvNoCreds({});
      expect(config.orgId).toBeUndefined();
      expect(config.orgId).not.toBe("");
      // And the key is present-but-undefined rather than absent, so
      // destructuring callers see a consistent shape.
      expect("orgId" in config).toBe(true);
    });

    test("collapses an empty-string env var to undefined, not to ''", () => {
      expect(withEnvNoCreds({ ARMORIQ_ORG_ID: "" }).orgId).toBeUndefined();
    });
  });

  // ---- Fail-closed: isConfigured ----

  describe("isConfigured (fail-closed)", () => {
    test("is false when no api key resolves, even though an endpoint always does", () => {
      const config = withEnvNoCreds({});
      expect(config.apiKey).toBe("");
      // The endpoint defaults, so it is truthy — the key is the whole gate.
      expect(config.backendEndpoint).toBe(DEFAULT_BACKEND_ENDPOINT);
      expect(config.isConfigured).toBe(false);
    });

    test("is false for an EMPTY-STRING api key (falsy, not just non-null)", () => {
      // This is why the implementation is `Boolean(apiKey && endpoint)` and
      // not a `!= null` check: `""` must read as unconfigured.
      const config = withEnvNoCreds({ ARMORIQ_API_KEY: "" });
      expect(config.apiKey).toBe("");
      expect(config.isConfigured).toBe(false);
    });

    test("is false when the endpoint resolves to an empty string", () => {
      // A creds file whose backendEndpoint is "" falls through to the
      // default, so force it via an env var of a bare slash: stripping the
      // trailing slash leaves "".
      const config = withEnv({
        ARMORIQ_API_KEY: "k",
        ARMORIQ_BACKEND_ENDPOINT: "/",
      });
      expect(config.backendEndpoint).toBe("");
      expect(config.isConfigured).toBe(false);
    });

    test("is true only when both an api key and an endpoint resolve", () => {
      expect(withEnvNoCreds({ ARMORIQ_API_KEY: "k" }).isConfigured).toBe(true);
      expect(withEnv({}).isConfigured).toBe(true);
    });
  });

  // ---- Numeric settings: fall back, never throw ----

  describe("numeric settings", () => {
    const badValues = [
      ["garbage", "abc"],
      ["an empty string", ""],
      ["zero", "0"],
      ["a negative", "-5"],
      ["a negative float", "-0.5"],
      ["Infinity", "Infinity"],
      ["NaN", "NaN"],
      ["a bare unit", "ms"],
    ] as const;

    for (const [label, raw] of badValues) {
      test(`timeoutMs falls back to the default for ${label}`, () => {
        const config = withEnvNoCreds({ ARMOROPENCODE_TIMEOUT_MS: raw });
        expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      });

      test(`planTtlSeconds falls back to the default for ${label}`, () => {
        const config = withEnvNoCreds({ ARMOROPENCODE_PLAN_TTL_SECONDS: raw });
        expect(config.planTtlSeconds).toBe(DEFAULT_PLAN_TTL_SECONDS);
      });
    }

    test("never throws on a nonsense numeric env var", () => {
      expect(() =>
        withEnvNoCreds({
          ARMOROPENCODE_TIMEOUT_MS: "{}",
          ARMOROPENCODE_PLAN_TTL_SECONDS: "[]",
        }),
      ).not.toThrow();
    });

    test("accepts a positive integer", () => {
      const config = withEnvNoCreds({
        ARMOROPENCODE_TIMEOUT_MS: "1500",
        ARMOROPENCODE_PLAN_TTL_SECONDS: "30",
      });
      expect(config.timeoutMs).toBe(1500);
      expect(config.planTtlSeconds).toBe(30);
    });

    test("tolerates a trailing unit, because it uses parseInt not Number()", () => {
      // Number("8000ms") is NaN; Number.parseInt("8000ms", 10) is 8000.
      expect(
        withEnvNoCreds({ ARMOROPENCODE_TIMEOUT_MS: "8000ms" }).timeoutMs,
      ).toBe(8000);
      expect(
        withEnvNoCreds({ ARMOROPENCODE_PLAN_TTL_SECONDS: "60 seconds" })
          .planTtlSeconds,
      ).toBe(60);
    });

    test("parses base 10, so a leading zero is not read as octal", () => {
      expect(
        withEnvNoCreds({ ARMOROPENCODE_TIMEOUT_MS: "0100" }).timeoutMs,
      ).toBe(100);
    });
  });

  // ---- intentRequired ----

  describe("intentRequired", () => {
    test("defaults to true (fail-closed) when unset", () => {
      expect(withEnvNoCreds({}).intentRequired).toBe(true);
    });

    test("defaults to true when set to an empty string", () => {
      expect(
        withEnvNoCreds({ ARMOROPENCODE_INTENT_REQUIRED: "" }).intentRequired,
      ).toBe(true);
    });

    for (const raw of ["1", "true", "TRUE", "yes", "on", "On"]) {
      test(`is true for ${JSON.stringify(raw)}`, () => {
        expect(
          withEnvNoCreds({ ARMOROPENCODE_INTENT_REQUIRED: raw })
            .intentRequired,
        ).toBe(true);
      });
    }

    for (const raw of ["0", "false", "no", "off", "maybe"]) {
      test(`is false for ${JSON.stringify(raw)}`, () => {
        expect(
          withEnvNoCreds({ ARMOROPENCODE_INTENT_REQUIRED: raw })
            .intentRequired,
        ).toBe(false);
      });
    }
  });

  // ---- dataDir ----

  describe("dataDir", () => {
    test("defaults to ~/.armoriq/armoropencode (NOT anything Gemini-flavored)", () => {
      expect(withEnvNoCreds({}).dataDir).toBe(DEFAULT_DATA_DIR);
      expect(DEFAULT_DATA_DIR.endsWith(join(".armoriq", "armoropencode"))).toBe(
        true,
      );
      expect(DEFAULT_DATA_DIR).not.toContain(".gemini");
      expect(DEFAULT_DATA_DIR).not.toContain("armorgemini");
    });

    test("is overridden by ARMOROPENCODE_DATA_DIR", () => {
      expect(
        withEnvNoCreds({ ARMOROPENCODE_DATA_DIR: "/tmp/custom" }).dataDir,
      ).toBe("/tmp/custom");
    });
  });

  // ---- credentials.json parsing ----

  describe("credentials.json handling", () => {
    test("ignores NON-STRING values rather than coercing them", () => {
      writeFileSync(
        credsPath,
        JSON.stringify({
          apiKey: 12345,
          backendEndpoint: { url: "https://nope.example" },
          orgId: ["org"],
        }),
        "utf-8",
      );
      const config = withEnv({});
      expect(config.apiKey).toBe("");
      expect(config.backendEndpoint).toBe(DEFAULT_BACKEND_ENDPOINT);
      expect(config.orgId).toBeUndefined();
      expect(config.isConfigured).toBe(false);
    });

    test("treats malformed JSON as absent", () => {
      writeFileSync(credsPath, "{ not json", "utf-8");
      const config = withEnv({});
      expect(config.apiKey).toBe("");
      expect(config.isConfigured).toBe(false);
    });

    test("treats a non-object top level as absent", () => {
      writeFileSync(credsPath, '"just a string"', "utf-8");
      expect(withEnv({}).apiKey).toBe("");
    });

    test("tolerates a partial file (some fields present, some not)", () => {
      writeFileSync(credsPath, JSON.stringify({ apiKey: "k" }), "utf-8");
      const config = withEnv({});
      expect(config.apiKey).toBe("k");
      expect(config.backendEndpoint).toBe(DEFAULT_BACKEND_ENDPOINT);
      expect(config.orgId).toBeUndefined();
    });

    test("treats an absent credentials file as unconfigured (fail-closed)", () => {
      // The injectable credentialsFilePath is what proves this, and is why
      // there is no ARMOROPENCODE_SKIP_CREDS_FILE env var: shipping a
      // documented switch that disables credential loading in a security
      // product is a footgun whose safety depends on an invariant enforced
      // in a different phase.
      const config = withEnvNoCreds({});
      expect(config.apiKey).toBe("");
      expect(config.orgId).toBeUndefined();
      expect(config.credentialSource).toBe("none");
      expect(config.isConfigured).toBe(false);
    });

    test('ignores an apiKey of "" in the file (falsy, so not "configured")', () => {
      writeFileSync(
        credsPath,
        JSON.stringify({ apiKey: "", backendEndpoint: "https://x.example" }),
        "utf-8",
      );
      const config = withEnv({});
      expect(config.apiKey).toBe("");
      expect(config.credentialSource).toBe("none");
      expect(config.isConfigured).toBe(false);
    });
  });

  // ---- credentialSource ----

  describe("credentialSource", () => {
    test('is "none" when no key resolves', () => {
      expect(withEnvNoCreds({}).credentialSource).toBe("none");
    });

    test('is "env" when either api-key env var is set', () => {
      expect(withEnvNoCreds({ ARMORIQ_API_KEY: "k" }).credentialSource).toBe(
        "env",
      );
      expect(
        withEnvNoCreds({ ARMOROPENCODE_API_KEY: "k" }).credentialSource,
      ).toBe("env");
    });

    test('is "credentials.json" when the key came from the file', () => {
      expect(withEnv({}).credentialSource).toBe("credentials.json");
    });

    test("is recomputed from the env vars, not tracked from the resolution path", () => {
      // This is a deliberately-preserved quirk of the JS original: the label
      // is derived by re-testing the two api-key env vars rather than by
      // remembering which source actually won. It happens to agree with the
      // truth today (any TRUTHY env var also wins the precedence race, and a
      // falsy one flips neither the key nor the label), which is exactly why
      // it is safe to keep — but it is a coincidence of the `||` chain, not a
      // guarantee, so both halves are pinned here.
      const falsyEnvVar = loadConfig(
        { ARMOROPENCODE_API_KEY: "" },
        credsPath,
      );
      expect(falsyEnvVar.apiKey).toBe("key-from-file");
      expect(falsyEnvVar.credentialSource).toBe("credentials.json");

      const truthyEnvVar = loadConfig(
        { ARMOROPENCODE_API_KEY: "product" },
        credsPath,
      );
      expect(truthyEnvVar.apiKey).toBe("product");
      expect(truthyEnvVar.credentialSource).toBe("env");
    });
  });

  // ---- The default (process.env) path ----

  describe("default arguments", () => {
    const KEYS = [
      "ARMORIQ_API_KEY",
      "ARMOROPENCODE_API_KEY",
      "ARMORIQ_BACKEND_ENDPOINT",
      "ARMOROPENCODE_BACKEND_ENDPOINT",
      "ARMORIQ_ORG_ID",
      "ARMOROPENCODE_DATA_DIR",
      "ARMOROPENCODE_INTENT_REQUIRED",
      "ARMOROPENCODE_TIMEOUT_MS",
      "ARMOROPENCODE_PLAN_TTL_SECONDS",
    ] as const;

    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      // Snapshot and clear every var this module reads, so the developer's
      // own environment can't change the outcome and so nothing leaks into
      // the next test file.
      saved = {};
      for (const key of KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    test("reads process.env when no env is passed", () => {
      process.env.ARMORIQ_API_KEY = "from-real-process-env";
      const config = loadConfig(undefined, noCredsPath);
      expect(config.apiKey).toBe("from-real-process-env");
      expect(config.credentialSource).toBe("env");
      expect(config.isConfigured).toBe(true);
    });

    test("the fully-default call resolves a coherent, defaulted config", () => {
      // Calls loadConfig() with NO arguments, so it reads the real
      // process.env AND the real ~/.armoriq/credentials.json. That means the
      // api key is machine-dependent and cannot be asserted, so this pins
      // only the machine-INDEPENDENT invariants — including the fail-closed
      // one that matters: isConfigured is true exactly when a key resolved.
      const config = loadConfig();
      expect(config.backendEndpoint).toBe(DEFAULT_BACKEND_ENDPOINT);
      expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
      expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(config.planTtlSeconds).toBe(DEFAULT_PLAN_TTL_SECONDS);
      expect(config.intentRequired).toBe(true);
      expect(typeof config.apiKey).toBe("string");
      // The fail-closed gate agrees with the credential label in both
      // directions (the endpoint always resolves, so the key is the gate).
      expect(config.isConfigured).toBe(config.credentialSource !== "none");
      expect(config.isConfigured).toBe(config.apiKey.length > 0);
    });

    test("defaults the credentials path to ~/.armoriq/credentials.json", () => {
      expect(
        defaultCredentialsFilePath().endsWith(
          join(".armoriq", "credentials.json"),
        ),
      ).toBe(true);
    });
  });
});

// ---- authHeaders ----

describe("authHeaders", () => {
  test("builds the four expected headers", () => {
    expect(authHeaders({ apiKey: "abc123" })).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer abc123",
      "X-ArmorIQ-Client": CLIENT_HEADER,
    });
  });

  test("still emits a Bearer header for an empty key (callers gate on isConfigured)", () => {
    expect(authHeaders({ apiKey: "" }).Authorization).toBe("Bearer ");
  });

  test("the client header is not a placeholder or a missing value", () => {
    // Guards the shape the backend will actually receive: a real
    // dot-separated version, not "undefined", "unknown", "" or a bare name.
    expect(CLIENT_HEADER).toMatch(/^armoropencode\/\d+\.\d+\.\d+/);
    expect(CLIENT_HEADER).not.toContain("undefined");
    expect(CLIENT_HEADER).not.toContain("unknown");
    expect(version.length).toBeGreaterThan(0);
    // NOTE: the sharper guard — `expect(version).not.toBe("0.0.0")` — is
    // deliberately NOT here, because package.json still says 0.0.0 and the
    // assertion would fail today. See the report: this needs a version bump
    // decision, and the guard should land with it.
  });

  test("the client header is armoropencode/<real package.json version>", () => {
    expect(CLIENT_HEADER).toBe(`armoropencode/${version}`);
    // The whole point of reading it from package.json: no hardcoded number
    // that can silently drift out of sync the way ArmorGemini's did.
    expect(CLIENT_HEADER.startsWith("armoropencode/")).toBe(true);
    expect(CLIENT_HEADER).not.toContain("armorgemini");
  });
});
