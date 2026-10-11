// Lane A owns core/sanitize.ts. Until it lands, stand in a pass-through so rows can be built;
// tests only use inputs that a real sanitizer leaves unchanged. Delete once sanitize is implemented.
import { mock } from "bun:test";
import * as sanitize from "../../../src/core/sanitize.ts";

let implemented = true;
try {
  sanitize.sanitizeParams({});
} catch {
  implemented = false;
}
if (!implemented) {
  mock.module(Bun.resolveSync("../../../src/core/sanitize.ts", import.meta.dir), () => ({
    MAX_PARAM_CHARS: 2000,
    sanitizeParams: (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {}),
    redactText: (t: string) => t,
  }));
}
