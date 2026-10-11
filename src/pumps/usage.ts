import type { Log, Login, Pump, StepUsage } from "../types.ts";

export type UsagePump = Pump & { observe(step: StepUsage): void };

// On kick() (session idle) and every 60 s: changed session-hours -> batch. 409 generation -> reinitialize and recapture.
export function createUsagePump(deps: { dataDir: string; login: () => Login | null; log: Log }): UsagePump {
  throw new Error("not implemented");
}
