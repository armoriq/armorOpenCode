import type { ArmorHost } from "../host.ts";
import { GuardDenied } from "../runtime.ts";
import { appendCount, type Metric } from "./counts.ts";
import { runPing, type ReachDependencies, type ReachOptions } from "./ping.ts";
import { isPlanSuccess } from "./replies.ts";

export function withReach(host: ArmorHost, options: ReachOptions, deps: ReachDependencies = {}): ArmorHost {
  let pingScheduled = false;
  let counterScheduled = false;
  const counters: Array<{ metric: Metric; at: number }> = [];

  function ping() {
    try {
      if (pingScheduled) return;
      const at = (deps.now ?? Date.now)();
      pingScheduled = true;
      setTimeout(() => {
        void runPing(options, { ...deps, now: () => at }).catch(() => {}).finally(() => { pingScheduled = false; });
      }, 0).unref();
    } catch { pingScheduled = false; }
  }

  function count(metric: Metric) {
    try {
      counters.push({ metric, at: (deps.now ?? Date.now)() });
      if (counterScheduled) return;
      counterScheduled = true;
      setTimeout(() => {
        void (async () => {
          while (counters.length) {
            const entry = counters.shift()!;
            await appendCount(entry.metric, options, { ...deps, now: () => entry.at });
          }
        })().catch(() => {}).finally(() => { counterScheduled = false; });
      }, 0).unref();
    } catch { counterScheduled = false; }
  }

  return {
    get log() { return host.log; },
    async toolBefore(call) {
      try {
        return await host.toolBefore(call);
      } catch (error) {
        if (error instanceof GuardDenied) count(error.decision.kind === "hold" ? "held" : "blocked");
        throw error;
      }
    },
    toolAfter: (call, output) => host.toolAfter(call, output),
    toolFailed: (call, error) => host.toolFailed(call, error),
    userPrompt(prompt) {
      const result = host.userPrompt(prompt);
      ping();
      return result;
    },
    systemDirective: sessionId => host.systemDirective(sessionId),
    armorCommand: (sessionId, args) => host.armorCommand(sessionId, args),
    event(event) {
      const result = host.event(event);
      if (event.kind === "session_created") ping();
      return result;
    },
    hasSession: sessionId => host.hasSession(sessionId),
    ownTools: {
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
      revoke: (call, reason) => host.ownTools.revoke(call, reason),
      policyRead: (call, tool) => host.ownTools.policyRead(call, tool),
      answered: call => host.ownTools.answered(call),
    },
    release: () => host.release(),
  };
}
