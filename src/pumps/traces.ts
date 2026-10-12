import type { Log, Login, Pump, TurnEvent } from "../types.ts";

export type TracePump = Pump & { record(event: TurnEvent): void };

// One ArmorIQTelemetryRuntime per process; root span per turn; DenyCode on decision spans.
export function createTracePump(deps: { login: () => Login | null; log: Log }): TracePump {
  throw new Error("not implemented");
}
