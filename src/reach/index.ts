import type { ArmorHost } from "../host.ts";
import { GuardDenied } from "../runtime.ts";
import { appendCount, type Metric } from "./counts.ts";
import { runPing, type ReachDependencies, type ReachOptions } from "./ping.ts";
import { isPlanSuccess } from "./replies.ts";
import { scheduleMessages } from "./messages.ts";
export { composeMessages, reminderEnabled, toastMessages } from "./messages.ts";
export { loginCommand } from "./login.ts";
export { registerReach } from "./v2.ts";

function forward<T extends object>(host: T, overrides: Partial<T>): T {
  return new Proxy(host, { get(target, member) {
    if (Object.hasOwn(overrides, member)) return Reflect.get(overrides, member);
    const value = Reflect.get(target, member, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export function withReach(host: ArmorHost, options: ReachOptions, deps: ReachDependencies = {}): ArmorHost {
  let messagesScheduled = false;
  let pingScheduled = false;
  let counterScheduled = false;
  const counters: Array<{ metric: Metric; at: number }> = [];

  function ping() {
    try {
      if (pingScheduled) return;
      const at = (deps.now ?? Date.now)();
      pingScheduled = true;
      (deps.setTimeout ?? setTimeout)(async () => {
        try { await runPing(options, { ...deps, now: () => at }); }
        catch { /* A failed ping cannot affect a host hook. */ }
        finally { pingScheduled = false; }
      }, 0).unref();
    } catch { pingScheduled = false; }
  }

  function count(metric: Metric) {
    try {
      counters.push({ metric, at: (deps.now ?? Date.now)() });
      if (counterScheduled) return;
      counterScheduled = true;
      (deps.setTimeout ?? setTimeout)(async () => {
        try {
          while (counters.length) {
            const entry = counters.shift()!;
            await appendCount(entry.metric, options, { ...deps, now: () => entry.at });
          }
        } catch { /* A failed counter cannot affect a tool reply. */ }
        finally { counterScheduled = false; }
      }, 0).unref();
    } catch { counterScheduled = false; }
  }

  return forward(host, {
    async toolBefore(call) {
      try {
        return await host.toolBefore(call);
      } catch (error) {
        if (error instanceof GuardDenied) count(error.decision.kind === "hold" ? "held" : "blocked");
        throw error;
      }
    },
    userPrompt(prompt) {
      const result = host.userPrompt(prompt);
      ping();
      return result;
    },
    event(event) {
      const result = host.event(event);
      if (event.kind === "session_created") ping();
      if (event.kind === "session_created" && options.notify && !messagesScheduled) {
        try {
          messagesScheduled = true;
          scheduleMessages(options, deps, options.notify, () => { messagesScheduled = false; });
        } catch { messagesScheduled = false; }
      }
      return result;
    },
    ownTools: forward(host.ownTools, {
      async registerIntentPlan(call, plan, reason) {
        const reply = await host.ownTools.registerIntentPlan(call, plan, reason);
        if (isPlanSuccess(reply)) count("plan");
        return reply;
      },
      async reanchor(call, plan, reason) {
        const reply = await host.ownTools.reanchor(call, plan, reason);
        if (isPlanSuccess(reply)) count("plan");
        return reply;
      },
    }),
  });
}
