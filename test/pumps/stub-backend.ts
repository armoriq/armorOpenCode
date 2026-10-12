import { createHash, randomUUID } from "node:crypto";
import type { Login, TokenUsageEntry } from "../../src/types.ts";

// Mirrors conmap-auto dev src/dashboard/usage-stream.store.ts: generation fence, batch receipts, per-hour revisions.
type Stored = { revision: number; digest: string; entries: TokenUsageEntry[] };

export type Span = { name: string; traceId: string; spanId: string; parentSpanId: string | null; attributes: Record<string, unknown> };

export function startStubBackend() {
  let generation = randomUUID();
  let snapshots = new Map<string, Stored>();
  let receipts = new Map<string, string>();
  let records = new Map<string, any>();
  const sentRecords: string[][] = [];
  const calls = { initialize: 0, batches: 0, conflicts: [] as string[], reset: 0, lease: 0, traces: 0, other: [] as string[] };
  const accepted: { sessionId: string; hour: string; revision: number; digest: string }[] = [];
  let failNext: { status: number; body: unknown } | null = null;
  let lease: Record<string, unknown> | null = { captureMode: "metadata", revision: 1 };
  const spans: Span[] = [];

  const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const conflict = (message: string) => {
    calls.conflicts.push(message);
    return Response.json({ statusCode: 409, message, error: "Conflict" }, { status: 409 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/dashboard/token-usage/stream") {
        calls.initialize += 1;
        return Response.json({ generation });
      }
      if (req.method === "POST" && url.pathname === "/dashboard/token-usage/batch") {
        calls.batches += 1;
        const batch = (await req.json()) as any;
        if (failNext) {
          const f = failNext;
          failNext = null;
          return Response.json(f.body, { status: f.status });
        }
        if (batch.generation !== generation) return conflict("Usage stream generation changed");
        const payload = digest([batch.snapshots, batch.calls ?? []]);
        const prior = receipts.get(batch.batchId);
        if (prior && prior !== payload) return conflict("Batch ID was used with another payload");
        const results = [];
        for (const s of batch.snapshots) {
          const key = `${s.sessionId}|${s.usageDate}|${s.usageHour}`;
          const old = snapshots.get(key);
          const d = digest(s.entries);
          let status: string;
          if (!old || old.revision < s.revision) status = "applied";
          else if (old.revision > s.revision) status = "superseded";
          else if (old.digest !== d) return conflict("Snapshot revision was used with another payload");
          else status = "present";
          if (status === "applied") {
            snapshots.set(key, { revision: s.revision, digest: d, entries: s.entries });
            accepted.push({ sessionId: s.sessionId, hour: `${s.usageDate}T${s.usageHour}`, revision: s.revision, digest: d });
          }
          results.push({ sessionId: s.sessionId, usageDate: s.usageDate, usageHour: s.usageHour, status });
        }
        receipts.set(batch.batchId, payload);
        const keys = (batch.calls ?? []).flatMap((c: any) => c.records.map((r: any) => `${c.sessionId}|${r.key}`));
        sentRecords.push(keys);
        if (!keys.length) return Response.json({ results });
        const stored = keys.filter((k: string) => !records.has(k)).length;
        for (const c of batch.calls) for (const r of c.records) records.set(`${c.sessionId}|${r.key}`, { ...r, batchHours: batch.snapshots.map((s: any) => `${s.sessionId}|${s.usageDate}|${s.usageHour}`) });
        return Response.json({ results, calls: { stored, duplicates: keys.length - stored } });
      }
      if (url.pathname === "/dashboard/token-usage/stream/reset") {
        calls.reset += 1;
        return new Response("not expected", { status: 500 });
      }
      if (req.method === "GET" && url.pathname === "/observability/policy/lease") {
        calls.lease += 1;
        if (!lease) return new Response("no", { status: 503 });
        return Response.json({ ...lease, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (req.method === "POST" && url.pathname === "/v1/traces") {
        calls.traces += 1;
        spans.push(...decodeSpans(Buffer.from(await req.arrayBuffer())));
        return new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/x-protobuf" } });
      }
      calls.other.push(`${req.method} ${url.pathname}`);
      return new Response("not found", { status: 404 });
    },
  });

  const backend = `http://127.0.0.1:${server.port}`;
  return {
    backend,
    calls,
    accepted,
    spans,
    login(overrides: Partial<Login> = {}): Login {
      return {
        backend,
        apiKey: "ak_test_stubstubstubstubstub",
        userId: "00000000-0000-4000-8000-000000000001",
        orgId: "00000000-0000-4000-8000-000000000002",
        email: "dev@example.com",
        deviceId: "device-1",
        deviceName: "test-host",
        ...overrides,
      };
    },
    // What the backend now holds: hour key -> entries.
    stored(): Map<string, TokenUsageEntry[]> {
      return new Map([...snapshots].map(([k, v]) => [k, v.entries]));
    },
    totals(): Record<string, TokenUsageEntry> {
      const out: Record<string, TokenUsageEntry> = {};
      for (const { entries } of snapshots.values())
        for (const e of entries) {
          const t = (out[e.model] ??= { model: e.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
          t.inputTokens += e.inputTokens;
          t.outputTokens += e.outputTokens;
          t.cacheReadTokens += e.cacheReadTokens;
          t.cacheWriteTokens += e.cacheWriteTokens;
        }
      return out;
    },
    // Call records the backend holds: "session|key" -> record, with the hours of the snapshots it arrived beside.
    records: () => records,
    // The record keys of every batch the backend accepted, in order.
    sentRecords,
    // What a console reset does: a new generation with no snapshots.
    rotateGeneration() {
      generation = randomUUID();
      snapshots = new Map();
      receipts = new Map();
      records = new Map();
    },
    failNextBatch(status: number, body: unknown) {
      failNext = { status, body };
    },
    setLease(next: Record<string, unknown> | null) {
      lease = next;
    },
    stop: () => server.stop(true),
  };
}

export type StubBackend = ReturnType<typeof startStubBackend>;

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

// Minimal protobuf reader for ExportTraceServiceRequest, as armorClaude tests/otel-shipping.test.mjs.
type Field = { no: number; wire: number; bytes?: Buffer; varint?: bigint };

function fields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let shift = 0n;
    let v = 0n;
    for (;;) {
      const b = buf[i++]!;
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const no = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ no, wire, varint: varint() });
    else if (wire === 1) {
      out.push({ no, wire, bytes: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      out.push({ no, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, bytes: buf.subarray(i, i + 4) });
      i += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const sub = (buf: Buffer, no: number) => fields(buf).filter((f) => f.no === no && f.bytes) as (Field & { bytes: Buffer })[];

function anyValue(buf: Buffer): unknown {
  const f = fields(buf)[0];
  if (!f) return null;
  if (f.no === 1) return f.bytes!.toString("utf8");
  if (f.no === 2) return f.varint === 1n;
  if (f.no === 3) return Number(BigInt.asIntN(64, f.varint!));
  if (f.no === 4) return f.bytes!.readDoubleLE(0);
  if (f.no === 5) return sub(f.bytes!, 1).map((v) => anyValue(v.bytes));
  return null;
}

export function decodeSpans(body: Buffer): Span[] {
  const spans: Span[] = [];
  for (const rs of sub(body, 1))
    for (const ss of sub(rs.bytes, 2))
      for (const span of sub(ss.bytes, 2)) {
        const attributes: Record<string, unknown> = {};
        for (const kv of sub(span.bytes, 9)) {
          const key = sub(kv.bytes, 1)[0]?.bytes.toString("utf8") ?? "";
          const value = sub(kv.bytes, 2)[0];
          attributes[key] = value ? anyValue(value.bytes) : null;
        }
        const hex = (no: number) => sub(span.bytes, no)[0]?.bytes.toString("hex") || null;
        spans.push({
          name: sub(span.bytes, 5)[0]?.bytes.toString("utf8") ?? "",
          traceId: hex(1) ?? "",
          spanId: hex(2) ?? "",
          parentSpanId: hex(4),
          attributes,
        });
      }
  return spans;
}
