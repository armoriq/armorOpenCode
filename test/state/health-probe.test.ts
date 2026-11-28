import { afterEach, expect, test } from "bun:test";
import { probeBackend } from "../../src/io/backend-health.ts";
import { login } from "../io/helpers/stub.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function serve(handler: (req: Request) => Response) {
  const seen: { path: string; auth: string | null }[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.get("authorization") ?? req.headers.get("x-api-key") });
      return handler(req);
    },
  });
  return { seen, l: login(`http://127.0.0.1:${server.port}`) };
}

test("liveness asks for the authenticated policy bundle, not the open health route", async () => {
  const { seen, l } = serve((req) => (new URL(req.url).pathname === "/auth/health" ? Response.json({ ok: true }) : new Response("down", { status: 500 })));
  const result = await probeBackend(l, 2_000);
  expect(seen.map((s) => s.path)).toEqual(["/policy/bundles/current?agent=armoropencode"]);
  expect(seen[0]!.auth).toContain(l.apiKey);
  expect(result).toMatchObject({ ok: false, unreachable: true });
});

test("a 401 from the bundle is an answer, not an outage, and does not sign the developer out", async () => {
  const { l } = serve(() => new Response("no", { status: 401 }));
  const result = await probeBackend(l, 2_000);
  expect(result).toEqual({ ok: true, value: undefined });
});

test("a 200 or 304 from the bundle is reachable", async () => {
  const { l } = serve(() => Response.json({ agents: [] }));
  expect(await probeBackend(l, 2_000)).toEqual({ ok: true, value: undefined });
});
