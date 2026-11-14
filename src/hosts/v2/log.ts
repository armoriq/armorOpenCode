import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { Log } from "../../types.ts";

const MAX_BYTES = 1_000_000;

// OpenCode 2 gives plugins no log API and does not capture their console, so the host logs to a file
// next to its other state. One rotated copy is kept.
export function fileLog(file: string): Log {
  let ready = false;
  const write = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      if (!ready) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        ready = true;
      }
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`);
      const line = JSON.stringify({ time: new Date().toISOString(), level, service: "armoropencode", message, ...extra });
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break a hook.
    }
  };
  return {
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}
