// One default export carrying both loader shapes: V1 reads { id, server }, V2 reads { id, setup }.
import { appendFileSync } from "node:fs"

const out = process.env.SPIKE_LOG ?? "/tmp/ocv2-spike/events.jsonl"
const write = (major, kind, payload) =>
  appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), major, kind, payload }) + "\n")

export default {
  id: "armor-spike-logger",
  server: async (input, options) => {
    write(1, "init", { inputKeys: Object.keys(input), options })
    return { event: async ({ event }) => write(1, "event", event) }
  },
  setup: async (ctx) => {
    write(2, "setup", { contextKeys: Object.keys(ctx), location: ctx.location, options: ctx.options })
    // OpenCode 1.19 also calls setup, with a partial context that has no event domain.
    if (!ctx.event) return
    const abort = new AbortController()
    ;(async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) write(2, "event", event)
    })().catch((e) => write(2, "subscribe-error", String(e?.stack ?? e)))
    return () => {
      write(2, "cleanup", {})
      abort.abort()
    }
  },
}
