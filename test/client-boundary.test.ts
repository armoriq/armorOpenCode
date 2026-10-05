import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHttpTelemetryTransport } from "../telemetry/http.ts";
import { liveEvents } from "../telemetry/plugin.ts";
import { pendingRecords } from "../telemetry/state.ts";
import type { TelemetryEnvelopeV1 } from "../telemetry/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function payload(): TelemetryEnvelopeV1 {
  return {
    schemaVersion: "telemetry.v1", product: "armoropencode", sessionId: "s1", usageDate: "2026-10-05",
    models: [{ model: "provider/model", tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 }, recordedCost: null, currency: "USD", pricing: { status: "unknown", source: null, asOf: null } }],
    tools: { calls: 1, completed: 1, failed: 0, unknown: 0, byName: { shell: 1 } },
    budgets: { session: { limit: 10, actual: 3, remaining: 7, status: "within" }, account: { limit: null, actual: 3, remaining: null, status: "unconfigured" } },
    coverage: { source: "opencode.live", sessionsScanned: 1, turnsScanned: 1, modelsObserved: 1, unknownModels: 0, missingTokenFields: 0, historyComplete: true, warnings: [] },
  };
}

describe("OpenCode client boundary", () => {
  test("translates supported OpenCode events without retaining private payloads", () => {
    const events = liveEvents({
      id: "evt-1", type: "message.updated", properties: {
        sessionID: "s1", info: {
          id: "turn-1", role: "assistant", providerID: "provider", modelID: "model",
          time: { created: 1000, completed: 2000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 0 }, total: 6 }, cost: 0.01,
          prompt: "private", path: "/private/project",
        },
      },
    });
    expect(events.map((event) => event.kind)).toEqual(["turn.started", "model.completed", "turn.completed"]);
    expect(events[1]?.model).toBe("provider/model");
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("/private/project");
  });

  test("counts a tool completion from the host event shape", () => {
    const events = liveEvents({ id: "evt-2", type: "message.part.updated", properties: { sessionID: "s1", part: { type: "tool", messageID: "turn-1", callID: "call-1", tool: "shell", state: { status: "completed", output: "private" } } } });
    expect(events).toEqual([{ kind: "tool.completed", eventId: "evt-2:call-1:complete", sessionId: "s1", turnId: "turn-1", callId: "call-1", toolName: "shell", status: "completed", atMs: undefined }]);
  });

  test("posts only telemetry envelopes with an API key and acknowledges success", async () => {
    let seen: RequestInit | undefined;
    const transport = createHttpTelemetryTransport({ endpoint: "https://api.example.test/dashboard/telemetry", apiKey: "key-1", fetcher: async (_input, init) => { seen = init; return new Response(JSON.stringify({ accepted: 1 }), { status: 201 }); } });
    const result = await transport.send(pendingRecords([payload()]));
    expect(result).toEqual({ ok: true, status: 201, accepted: 1 });
    expect(seen?.headers).toEqual({ "content-type": "application/json", "x-api-key": "key-1" });
    expect(String(seen?.body)).toContain("telemetry.v1");
    expect(String(seen?.body)).not.toContain("prompt");
  });

  test("rejects non-HTTPS endpoints except explicit loopback", () => {
    expect(() => createHttpTelemetryTransport({ endpoint: "http://example.test/telemetry" })).toThrow("HTTPS");
    expect(() => createHttpTelemetryTransport({ endpoint: "https://user:pass@example.test/telemetry" })).toThrow("credentials");
    expect(() => createHttpTelemetryTransport({ endpoint: "http://127.0.0.1:3000/telemetry" })).not.toThrow();
  });

  test("local plugin state remains metadata-only", async () => {
    const root = mkdtempSync("/tmp/armoropencode-plugin-");
    roots.push(root);
    const prior = process.env.ARMORIQ_OPENCODE_STATE;
    process.env.ARMORIQ_OPENCODE_STATE = join(root, "telemetry.ndjson");
    const { default: plugin } = await import("../telemetry/plugin.ts");
    const hooks = await plugin({});
    await hooks.event({ event: { id: "evt-3", type: "message.updated", properties: { sessionID: "s1", info: { id: "turn-1", role: "assistant", providerID: "p", modelID: "m", time: { created: 1000, completed: 2000 }, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 3 }, prompt: "secret" } } } });
    await hooks.event({ event: { id: "evt-4", type: "session.idle", properties: { sessionID: "s1" } } });
    expect(readFileSync(join(root, "telemetry.ndjson"), "utf8")).toContain("telemetry.v1");
    expect(readFileSync(join(root, "telemetry.ndjson"), "utf8")).not.toContain("secret");
    if (prior === undefined) delete process.env.ARMORIQ_OPENCODE_STATE; else process.env.ARMORIQ_OPENCODE_STATE = prior;
  });
});
