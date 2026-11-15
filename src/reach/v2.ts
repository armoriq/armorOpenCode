import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArmorHost } from "../host.ts";
import type { Cleanup, V2Context } from "../hosts/v2/context.ts";
import type { Registration } from "../hosts/v2/plugin-api.ts";
import { reachDir, scheduleMessages } from "./messages.ts";
import { reachContext, type ReachDependencies } from "./ping.ts";
import { dayTime, READ_FLAGS } from "./state.ts";

export const REACH_NOTE = "ArmorIQ showed you a local notice. No action is needed.";
const idFile = (id: string) => `message-${createHash("sha256").update(id).digest("hex")}.json`;
type ReachContext = Pick<V2Context, "options"> & { readonly session: Pick<V2Context["session"], "hook" | "synthetic"> };

// One tiny file per notice message. No prompt, notice text, or credentials are stored here.
async function readIds(dir: string, ids: Set<string>, now: number): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (!/^message-[a-f0-9]{64}\.json$/.test(name)) continue;
      let handle;
      try {
        const file = path.join(dir, name);
        if (!(await lstat(file)).isFile()) continue;
        handle = await open(file, READ_FLAGS);
        if ((await handle.stat()).size > 512) continue;
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (typeof value !== "object" || value === null || !("id" in value) || !("day" in value)) continue;
        if (typeof value.id !== "string" || typeof value.day !== "string") continue;
        if (now - dayTime(value.day) > 30 * 86400000) await unlink(file).catch(() => {});
        else ids.add(value.id);
      } catch { /* A bad record cannot affect a model request. */ }
      finally { await handle?.close().catch(() => {}); }
    }
  } catch { /* No records yet. */ }
}

function isReachMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "synthetic" || !("payload" in message)) return false;
  const payload = message.payload;
  return typeof payload === "object" && payload !== null && "text" in payload && payload.text === REACH_NOTE;
}

export async function registerReach(ctx: ReachContext, host: Pick<ArmorHost, "log">, deps: ReachDependencies = {}): Promise<Cleanup> {
  const options = { pluginOptions: ctx.options };
  const { home } = reachContext(options, deps);
  const dir = reachDir(home);
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const registrations: Registration[] = [];
  let active = true;
  const now = dayTime(new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10));
  // Warm the cache outside setup and the hook path. The neutral synthetic payload is also filtered
  // below, so a resumed request stays safe if it races this read, or a record cannot be read.
  const load = setTimeout(() => { timers.delete(load); void readIds(dir, ids, now); }, 0).unref();
  timers.add(load);
  registrations.push(await ctx.session.hook("context", event => {
    event.messages = event.messages.filter(message => !ids.has(message.id ?? "") && !isReachMessage(message));
  }));
  registrations.push(await ctx.session.hook("prompt", event => {
    if (!active || sessions.has(event.sessionID)) return;
    sessions.add(event.sessionID);
    try {
      const timer = scheduleMessages(options, deps, async description => {
        if (!active) return;
        try {
          const message = await ctx.session.synthetic({ sessionID: event.sessionID, text: REACH_NOTE, description, resume: false });
          if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "string") return;
          ids.add(message.id);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await writeFile(path.join(dir, idFile(message.id)), JSON.stringify({ id: message.id, day: new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10) }), { flag: "wx", mode: 0o600 });
        } catch (error) {
          host.log.warn("reach notice failed", { error: String(error) });
        }
      }, () => { timers.delete(timer); });
      timers.add(timer);
    } catch { /* Scheduling cannot change the prompt result. */ }
  }));
  return async () => {
    active = false;
    for (const timer of timers) clearTimeout(timer);
    await Promise.allSettled(registrations.map(registration => registration.dispose()));
  };
}
