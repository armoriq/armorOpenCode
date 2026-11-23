import { afterEach, describe, expect, test } from "bun:test";
import { createPolicyBundle, REVALIDATE_MS, type PolicyBundle } from "../../src/state/policy-bundle.ts";
import type { Login } from "../../src/types.ts";

const login: Login = { backend: "http://backend.test", apiKey: "ak_test_123456789", userId: "u", orgId: "o", email: "e@x", deviceId: "d", deviceName: "n" };
const log = { info() {}, warn() {}, error() {} };

type Seen = { url: string; ifNoneMatch: string | null };

function backend(answers: (() => Response)[]) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), ifNoneMatch: new Headers(init.headers).get("If-None-Match") });
    const next = answers.shift();
    if (!next) throw new Error("connection refused");
    return next();
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const bundle = (name: string) => () =>
  new Response(JSON.stringify({ orgId: "o", agents: [{ agentId: "armoropencode", name: "armoropencode", inactive: false, policy: null, policies: [{ name }], tools: [], members: [] }] }), {
    status: 200,
    headers: { etag: `"${name}"` },
  });

let made: PolicyBundle[] = [];
afterEach(() => {
  for (const b of made) b.stop();
  made = [];
});

function make(fetchFn: typeof fetch, clock: { t: number }) {
  const b = createPolicyBundle({ log, login: () => login, fetch: fetchFn, now: () => clock.t, intervalMs: 3_600_000 });
  made.push(b);
  return b;
}

describe("policy bundle", () => {
  test("asks for the armoropencode agent and revalidates with the ETag", async () => {
    const clock = { t: 0 };
    const be = backend([bundle("v1"), () => new Response(null, { status: 304 }), bundle("v2")]);
    const b = make(be.fetchFn, clock);
    await b.refresh(login);
    expect(be.seen[0]!.url).toBe("http://backend.test/policy/bundles/current?agent=armoropencode");
    expect(be.seen[0]!.ifNoneMatch).toBeNull();
    clock.t = REVALIDATE_MS;
    await b.refresh(login, REVALIDATE_MS);
    expect(be.seen[1]!.ifNoneMatch).toBe('"v1"');
    expect(b.state(login)).toMatchObject({ status: "current", agent: { policies: [{ name: "v1" }] } });
    clock.t = 2 * REVALIDATE_MS;
    await b.refresh(login, REVALIDATE_MS);
    expect(b.state(login)).toMatchObject({ status: "current", agent: { policies: [{ name: "v2" }] } });
  });

  test("a fresh bundle is not refetched inside the window", async () => {
    const clock = { t: 0 };
    const be = backend([bundle("v1")]);
    const b = make(be.fetchFn, clock);
    await b.refresh(login, REVALIDATE_MS);
    clock.t = REVALIDATE_MS - 1;
    await b.refresh(login, REVALIDATE_MS);
    expect(be.seen).toHaveLength(1);
  });

  test("an unreachable backend keeps the last bundle and is not retried on every call", async () => {
    const clock = { t: 0 };
    const be = backend([bundle("v1")]);
    const b = make(be.fetchFn, clock);
    await b.refresh(login);
    clock.t = REVALIDATE_MS;
    await b.refresh(login, REVALIDATE_MS);
    await b.refresh(login, REVALIDATE_MS);
    expect(be.seen).toHaveLength(2);
    clock.t = 3 * REVALIDATE_MS;
    expect(b.state(login)).toMatchObject({ status: "stale", agent: { policies: [{ name: "v1" }] } });
  });

  test("a different login does not see another account's bundle", async () => {
    const clock = { t: 0 };
    const b = make(backend([bundle("v1")]).fetchFn, clock);
    await b.refresh(login);
    expect(b.state({ ...login, apiKey: "ak_other_key_00000" }).status).toBe("unavailable");
  });

  test("concurrent refreshes for two logins do not share one fetch", async () => {
    const clock = { t: 0 };
    const be = backend([bundle("a"), bundle("b")]);
    const b = make(be.fetchFn, clock);
    const other = { ...login, apiKey: "ak_other_key_00000", orgId: "o2" };
    await Promise.all([b.refresh(login), b.refresh(other)]);
    expect(be.seen).toHaveLength(2);
    expect(b.state(other).status).toBe("current");
  });

  test("the timer revalidates on its own so an edit lands within the interval", async () => {
    const be = backend([bundle("v1"), bundle("v2")]);
    const b = createPolicyBundle({ log, login: () => login, fetch: be.fetchFn, intervalMs: 20 });
    made.push(b);
    await b.refresh(login);
    await Bun.sleep(80);
    expect(b.state(login)).toMatchObject({ agent: { policies: [{ name: "v2" }] } });
  });
});
