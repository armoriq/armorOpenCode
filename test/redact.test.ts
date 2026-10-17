import { describe, expect, test } from "bun:test";
import { redactText, scrub, truncate } from "../src/redact.ts";

describe("redactText", () => {
  test("keeps the field label and drops the secret value", () => {
    expect(redactText("export API_KEY=sk_l1ve_abcdefghijklmnop")).toBe("export API_KEY=<redacted>");
    expect(redactText("curl -H 'Authorization: Bearer abcdefghijklmnopqrst'")).toBe(
      "curl -H 'Authorization: Bearer <redacted>'",
    );
  });

  test("redacts provider tokens and private keys found anywhere in text", () => {
    expect(redactText("aws AKIAABCDEFGHIJKLMNOP done")).toBe("aws <redacted> done");
    expect(redactText(`gh ghp_${"a".repeat(36)}`)).toBe("gh <redacted>");
    expect(redactText("key ak_live_0123456789abcdef0123")).toBe("key <redacted>");
    expect(redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("<redacted>");
  });

  test("redacts prefixed env names, quoted JSON keys, Basic auth, curl -u and bare provider keys", () => {
    expect(redactText("echo OPENAI_API_KEY=sk-pr0j-abcdefghijklmnopqrstuvwx")).toBe("echo OPENAI_API_KEY=<redacted>");
    expect(redactText("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG DB_PASSWORD=hunter22")).toBe(
      "AWS_SECRET_ACCESS_KEY=<redacted> DB_PASSWORD=<redacted>",
    );
    expect(redactText('{"password": "hunter2hunter2", "user": "bob"}')).toBe('{"password": "<redacted>", "user": "bob"}');
    expect(redactText("Authorization: Basic YWRtaW46c2VjcmV0")).toBe("Authorization: Basic <redacted>");
    expect(redactText("curl -u admin:SuperSecretPass123 https://x.io")).toBe("curl -u admin:<redacted> https://x.io");
    expect(redactText("psql postgres://app:s3cretpw@db:5432/x")).toBe("psql postgres://app:<redacted>@db:5432/x");
    expect(redactText("key sk_l1ve_abcdefghijklmnop1234 and sk-pr0j-abcdefghijklmnopqrst")).toBe(
      "key <redacted> and <redacted>",
    );
  });

  test("leaves ordinary text untouched", () => {
    expect(redactText("git status && ls -la")).toBe("git status && ls -la");
  });
});

describe("truncate", () => {
  test("cuts at 2000 characters and marks the cut", () => {
    const out = truncate("x".repeat(2500));
    expect(out.length).toBe(2003);
    expect(out.endsWith("x...")).toBe(true);
  });

  test("leaves strings at the limit alone", () => {
    expect(truncate("y".repeat(2000))).toBe("y".repeat(2000));
  });
});

describe("scrub", () => {
  test("redacts before truncating so a secret straddling the cut never leaks a prefix", () => {
    const secret = "token=abcdefghijklmnopqrstuvwxyz";
    const out = scrub(`${"a".repeat(1990)} ${secret}`);
    expect(out).toBe(`${"a".repeat(1990)} token=<re...`);
  });

  test("walks nested tool args", () => {
    expect(scrub({ command: "echo password=hunter2hunter2", env: ["SECRET: abcdefghijklmnop"], n: 3 })).toEqual({
      command: "echo password=<redacted>",
      env: ["SECRET: <redacted>"],
      n: 3,
    });
  });
});
