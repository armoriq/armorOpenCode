import { readFileSync, statSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { compilePolicy, DEFAULT_POLICY_SOURCE, POLICY_IR_VERSION } from "../core/policy.ts";
import type { CompiledPolicy, Log } from "../types.ts";

export interface PolicySource {
  current(): CompiledPolicy;
  stop(): void;
}

const POLL_MS = 500;

// Used only when the file exists but never compiled. Falling back to the
// all-allow default would let a corrupted policy file disable enforcement.
const FAIL_CLOSED_SOURCE = { schemaVersion: POLICY_IR_VERSION, defaults: { decision: "deny" }, statements: [] };

type Loaded = { kind: "missing" } | { kind: "ok"; policy: CompiledPolicy } | { kind: "invalid"; error: string };

function compileText(text: string): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "invalid", error: `policy is not valid JSON: ${(error as Error).message}` };
  }
  const result = compilePolicy(raw);
  return result.ok ? { kind: "ok", policy: result.policy } : { kind: "invalid", error: result.error };
}

function mustCompile(raw: unknown): CompiledPolicy {
  const result = compilePolicy(raw);
  if (!result.ok) throw new Error(`built-in policy failed to compile: ${result.error}`);
  return result.policy;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function fingerprint(s: Stats | null): string {
  return s ? `${s.ino}:${s.size}:${s.mtimeMs}` : "missing";
}

// Loads synchronously at setup; watches the file; swaps only after compile succeeds.
export function createPolicySource(path: string, log: Log): PolicySource {
  const fallback = mustCompile(DEFAULT_POLICY_SOURCE);
  let active: CompiledPolicy;

  // The baseline is taken before the read, so an edit racing setup shows up
  // as a change on the first poll instead of being folded into the baseline.
  let seen = fingerprint(statOrNull());
  let initial: Loaded;
  try {
    initial = compileText(readFileSync(path, "utf8"));
  } catch (error) {
    initial = isMissing(error) ? { kind: "missing" } : { kind: "invalid", error: String(error) };
  }
  if (initial.kind === "ok") active = initial.policy;
  else if (initial.kind === "missing") active = fallback;
  else {
    log.error("policy rejected at startup; denying all tools until it is fixed", { path, error: initial.error });
    active = mustCompile(FAIL_CLOSED_SOURCE);
  }

  function statOrNull(): Stats | null {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  }

  let polling = false;
  let stopped = false;
  // Editors that save by delete-and-recreate leave the file briefly absent;
  // only a second missing poll counts as a deletion.
  let missingPolls = 0;

  const apply = (next: Loaded): void => {
    if (next.kind === "invalid") {
      log.warn("policy change rejected; keeping the last good policy", { path, error: next.error, hash: active.hash });
      return;
    }
    const policy = next.kind === "ok" ? next.policy : fallback;
    if (policy.hash !== active.hash || policy.intentRequired !== active.intentRequired) {
      active = policy;
      log.info("policy reloaded", { path, hash: policy.hash, source: next.kind });
    }
  };

  const poll = async (): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const current = await stat(path).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      const print = fingerprint(current);
      if (print === seen) return;
      if (current === null && missingPolls++ === 0) return;
      missingPolls = 0;
      seen = print;
      let next: Loaded;
      try {
        next = current === null ? { kind: "missing" } : compileText(await readFile(path, "utf8"));
      } catch (error) {
        next = isMissing(error) ? { kind: "missing" } : { kind: "invalid", error: String(error) };
      }
      if (!stopped) apply(next);
    } catch (error) {
      log.error("policy poll failed", { path, error: String(error) });
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), POLL_MS);
  timer.unref?.();

  return {
    current: () => active,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
