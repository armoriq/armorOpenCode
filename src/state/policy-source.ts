import { readFileSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
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

// Loads synchronously at setup; watches the file; swaps only after compile succeeds.
export function createPolicySource(path: string, log: Log): PolicySource {
  const fallback = mustCompile(DEFAULT_POLICY_SOURCE);
  let active: CompiledPolicy;

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

  let reloading = false;
  let again = false;
  let stopped = false;

  const reload = async (): Promise<void> => {
    if (reloading) {
      again = true;
      return;
    }
    reloading = true;
    try {
      do {
        again = false;
        let next: Loaded;
        try {
          next = compileText(await readFile(path, "utf8"));
        } catch (error) {
          next = isMissing(error) ? { kind: "missing" } : { kind: "invalid", error: String(error) };
        }
        if (stopped) return;
        if (next.kind === "invalid") {
          log.warn("policy change rejected; keeping the last good policy", { path, error: next.error, hash: active.hash });
          continue;
        }
        const policy = next.kind === "ok" ? next.policy : fallback;
        if (policy.hash !== active.hash || policy.intentRequired !== active.intentRequired) {
          active = policy;
          log.info("policy reloaded", { path, hash: policy.hash, source: next.kind });
        }
      } while (again);
    } finally {
      reloading = false;
    }
  };

  const onChange = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    reload().catch((error) => log.error("policy reload failed", { error: String(error) }));
  };
  // watchFile polls stat, so it also sees the file being created, deleted or
  // atomically replaced, which a plain fs.watch on the file misses.
  watchFile(path, { interval: POLL_MS, persistent: false }, onChange);

  return {
    current: () => active,
    stop() {
      stopped = true;
      unwatchFile(path, onChange);
    },
  };
}
