import type { RunCapabilityRule } from "../core/runs.ts";

export const RUN_CAPABILITIES: readonly RunCapabilityRule[] = [
  { patterns: ["^(?:register_intent_plan|policy_read|trust_reanchor|trust_revoke)$"], gated: false, counted: false },
  { patterns: ["^(?:read|grep|glob|list|webfetch|websearch|todoread|todowrite)$"], gated: false, counted: true },
  { patterns: ["^.*$"], gated: true, counted: true },
];
