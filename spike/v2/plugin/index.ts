import { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync } from "node:fs"

// Behavior is switched per run by a JSON mode file so one plugin covers every experiment.
type Mode = {
  block?: { tool: string; message: string }
  mutate?: { tool: string; set: Record<string, unknown> }
  sleepMs?: { tool: string; ms: number }
  crash?: { tool: string; kind: "throw-non-error" | "reject" }
  hang?: { tool: string }
  afterThrow?: { tool: string }
  setupThrow?: boolean
  logContext?: boolean
  evaluate?: { action?: string; effect: "allow" | "deny" | "ask"; message?: string }
  evaluateThrow?: { action?: string }
}

function safe(value: unknown): unknown {
  const seen = new WeakSet()
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) return { __error: v.name, message: v.message, ...(v as object) }
      if (typeof v === "bigint") return v.toString()
      if (typeof v === "function") return "[function]"
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]"
        seen.add(v)
      }
      return v
    }) ?? "null",
  )
}

export default Plugin.define({
  id: "armoriq.spike.v2-logger",
  async setup(ctx) {
    const out = String(ctx.options.out)
    const modeFile = String(ctx.options.mode)
    const mode = (): Mode => {
      try {
        return JSON.parse(readFileSync(modeFile, "utf8"))
      } catch {
        return {}
      }
    }
    const log = (hook: string, data: unknown) =>
      appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), hook, data: safe(data) }) + "\n")

    log("setup", { location: ctx.location, options: ctx.options, app: ctx.app })
    if (mode().setupThrow) throw new Error("spike-setup-throw")

    await ctx.tool.hook("execute.before", async (event) => {
      log("tool.execute.before", { keys: Object.keys(event), event })
      const m = mode()
      if (m.sleepMs?.tool === event.tool) {
        await new Promise((r) => setTimeout(r, m.sleepMs!.ms))
        log("tool.execute.before.slept", { id: event.id, ms: m.sleepMs.ms })
      }
      if (m.hang?.tool === event.tool) await new Promise(() => {})
      if (m.mutate?.tool === event.tool) {
        event.input = { ...(event.input as object), ...m.mutate.set }
        log("tool.execute.before.mutated", { id: event.id, input: event.input })
      }
      if (m.crash?.tool === event.tool) {
        if (m.crash.kind === "reject") return Promise.reject("spike-crash-rejected-string")
        throw "spike-crash-thrown-string"
      }
      if (m.block?.tool === event.tool) throw new Error(m.block.message)
    })

    await ctx.tool.hook("execute.after", (event) => {
      log("tool.execute.after", { keys: Object.keys(event), event })
      if (mode().afterThrow?.tool === event.tool) throw new Error("spike-after-throw")
    })

    await ctx.permission.hook("evaluate", (event) => {
      log("permission.evaluate", { keys: Object.keys(event), event })
      const m = mode()
      if (m.evaluateThrow && (!m.evaluateThrow.action || m.evaluateThrow.action === event.action))
        throw new Error("spike-evaluate-throw")
      if (m.evaluate && (!m.evaluate.action || m.evaluate.action === event.action)) {
        event.effect = m.evaluate.effect
        if (m.evaluate.message) event.message = m.evaluate.message
        log("permission.evaluate.set", { action: event.action, effect: event.effect, message: event.message })
      }
    })

    await ctx.session.hook("context", (event) => {
      if (mode().logContext) log("session.context.tail", { agent: event.agent, model: event.model, messages: event.messages.slice(-2) })
    })

    const abort = new AbortController()
    void (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: abort.signal } as never)) {
          const type = (e as { type?: string }).type ?? ""
          if (type.startsWith("permission.") || type.startsWith("session.error")) log(`event:${type}`, e)
        }
      } catch (err) {
        log("event.subscribe.error", err)
      }
    })()

    return () => {
      abort.abort()
      log("cleanup", {})
    }
  },
})
