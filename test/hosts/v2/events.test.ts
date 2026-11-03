import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostFor, type ArmorHost, type HostEvent } from "../../../src/host.ts";
import type { V2Context, V2Event } from "../../../src/hosts/v2/context.ts";
import { registerEvents, toHostEvent } from "../../../src/hosts/v2/events.ts";
import type { SessionID } from "../../../src/types.ts";
import { fakeRuntime } from "../../support/intent-harness.ts";

// Real V2 events from the spike runs (origin/spike/v2-events-packaging, captures/v2-events/plugin-events-all-runs.jsonl).
const EVENTS: V2Event[] = readFileSync(path.join(import.meta.dir, "fixtures", "v2-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const PARENT = "ses_ec5471193ffeF1DjYk3kExJNmP";
const CHILD = "ses_ec546d50fffeJ3CciwWWaIIARC";
const TITLED = "ses_ec5328bbaffekXZmHKeKHgO5r1";

const lifecycle = (events: readonly V2Event[]) =>
  events.map((e) => toHostEvent(e, "/repo")).filter((e): e is HostEvent => e !== null && e.kind !== "step_finished" && e.kind !== "assistant_model");

describe("V2 session lifecycle mapping", () => {
  test("recorded runs map to created, idle, title and deleted, child before parent on delete", () => {
    expect(lifecycle(EVENTS)).toEqual([
      { kind: "session_created", sessionId: PARENT as any, parentId: null },
      { kind: "session_title", sessionId: PARENT as any, title: "spike run 1" },
      { kind: "session_created", sessionId: CHILD as any, parentId: PARENT as any },
      { kind: "session_idle", sessionId: CHILD as any },
      { kind: "session_idle", sessionId: PARENT as any },
      { kind: "session_created", sessionId: TITLED as any, parentId: null },
      { kind: "session_title", sessionId: TITLED as any, title: "notes.txt summary" },
      { kind: "session_idle", sessionId: TITLED as any },
      { kind: "session_deleted", sessionId: CHILD as any },
      { kind: "session_deleted", sessionId: PARENT as any },
    ]);
  });

  test("failed and interrupted turns also end the turn; events without a session are ignored", () => {
    expect(toHostEvent({ type: "session.execution.failed", data: { sessionID: "ses_1" } }, "/repo")).toEqual({ kind: "session_idle", sessionId: "ses_1" as any });
    expect(toHostEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } }, "/repo")).toEqual({ kind: "session_idle", sessionId: "ses_1" as any });
    expect(toHostEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } }, "/repo")).toBeNull();
    expect(toHostEvent({ type: "session.deleted", data: {} }, "/repo")).toBeNull();
    expect(toHostEvent({ type: "session.renamed", data: { sessionID: "ses_1" } }, "/repo")).toBeNull();
  });
});

describe("V2 event subscription", () => {
  function harness(source: AsyncIterable<V2Event>) {
    const seen: HostEvent[] = [];
    const errors: string[] = [];
    let signal: AbortSignal | undefined;
    const host = { event: (e: HostEvent) => void seen.push(e), hasSession: () => true, log: { info() {}, warn() {}, error: (m: string) => void errors.push(m) } } as unknown as ArmorHost;
    const ctx = {
      tool: { hook: async () => ({ dispose: async () => {} }), transform: async () => ({ dispose: async () => {} }) },
      event: {
        subscribe: (o?: { signal?: AbortSignal }) => {
          signal = o?.signal;
          return source;
        },
      },
      session: { hook: async () => ({ dispose: async () => {} }), get: async () => ({}), synthetic: async () => ({}) },
      command: { transform: async () => ({ dispose: async () => {} }) },
    } as V2Context;
    return { ctx, host, seen, errors, signal: () => signal };
  }

  test("feeds the stream to the host, survives a bad event, and the cleanup aborts it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* source() {
      yield EVENTS[0]!;
      yield { type: "session.created", data: { sessionID: "boom" } };
      yield EVENTS.find((e) => e.type === "session.deleted")!;
      await gate;
    }
    const h = harness(source());
    h.host.event = (e: HostEvent) => {
      if (e.kind === "session_created" && e.sessionId === "boom") throw new Error("handler threw");
      h.seen.push(e);
    };
    const cleanup = await registerEvents(h.ctx, h.host);
    await Bun.sleep(10);
    expect(h.seen.map((e) => e.kind)).toEqual(["session_created", "session_deleted"]);
    expect(h.errors).toEqual(["event handler failed"]);
    expect(h.signal()?.aborted).toBe(false);
    await cleanup();
    expect(h.signal()?.aborted).toBe(true);
    release();
  });

  test("a stream that fails is logged, not thrown", async () => {
    async function* source(): AsyncGenerator<V2Event> {
      throw new Error("disconnected");
    }
    const h = harness(source());
    await registerEvents(h.ctx, h.host);
    await Bun.sleep(10);
    expect(h.errors).toEqual(["event stream failed"]);
  });

  // OpenCode 2.2.5 sends every location's events to each location's plugin instance, each with its own
  // runtime (staging, 2026-11-03: 8 gen_ai.chat spans for 4 model calls, in two traces).
  test("each instance takes only the sessions it opened", async () => {
    async function instance(owned: string[]) {
      const rt = await fakeRuntime(null);
      for (const id of owned) rt.sessions.open(id as SessionID, null, "monitor");
      const steps: string[] = [];
      const kinds: string[] = [];
      Object.assign(rt, {
        stepFinished: (step: { sessionId: string }) => void steps.push(step.sessionId),
        sessionCreated: () => void kinds.push("created"),
        sessionTitle: () => void kinds.push("title"),
        idle: () => void kinds.push("idle"),
        deleted: () => void kinds.push("deleted"),
        assistantModel() {},
      });
      async function* source() {
        yield* EVENTS;
      }
      const h = harness(source());
      await registerEvents(h.ctx, hostFor(rt as any, rt.log));
      return { steps, kinds };
    }
    const stepsOf = (ids: string[]) =>
      EVENTS.filter((e) => e.type === "session.step.ended" && ids.includes((e.data as { sessionID: string }).sessionID)).map(
        (e) => (e.data as { sessionID: string }).sessionID,
      );
    const owner = await instance([PARENT, CHILD]);
    const other = await instance([TITLED]);
    const none = await instance([]);
    await Bun.sleep(10);
    expect(owner.steps).toEqual(stepsOf([PARENT, CHILD]));
    expect(owner.steps).toHaveLength(6);
    expect(owner.kinds).toEqual(["created", "title", "created", "idle", "idle", "deleted", "deleted"]);
    expect(other.steps).toEqual(stepsOf([TITLED]));
    expect(other.kinds).toEqual(["created", "title", "idle"]);
    expect(none.steps).toEqual([]);
    expect(none.kinds).toEqual([]);
  });
});
