import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuditShipper } from "../src/http.ts";

let reply = { status: 200, body: "{}" };
const server = createServer((_req, res) => res.writeHead(reply.status).end(reply.body));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
afterAll(() => server.close());

const { port } = server.address() as AddressInfo;
const ship = createAuditShipper({ apiKey: "ak_test", backendEndpoint: `http://127.0.0.1:${port}`, timeoutMs: 2000 });

describe("createAuditShipper", () => {
  test("returns the per-row failures from a 200 response", async () => {
    const failures = [{ index: 1, error: "invalid row: output must be an object" }];
    reply = { status: 200, body: JSON.stringify({ written: 1, orphan: 1, failures }) };
    expect(await ship([])).toEqual({ failures });
  });

  test("treats a 200 without a failures list as a failed send", async () => {
    reply = { status: 200, body: "ok" };
    await expect(ship([])).rejects.toThrow("without a failures list");
  });

  test("treats a non-2xx response as a failed send", async () => {
    reply = { status: 401, body: "Unauthorized" };
    await expect(ship([])).rejects.toThrow("returned 401");
  });
});
