import { isPlainObject } from "./matcher.ts";

export const MAX_FIELD_CHARS = 2000;

// Same patterns as armorCodex's redactSecrets, applied before anything leaves
// the host or lands in the local queue.
const SECRET_PATTERNS = [
  /\b(Bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bak_[A-Za-z0-9_\-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: unknown) => `${typeof prefix === "string" ? prefix : ""}<redacted>`);
  }
  return out;
}

export function truncate(text: string, max = MAX_FIELD_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const LIMITS = { maxDepth: 4, maxKeys: 50, maxItems: 50 };

// Redaction runs before truncation so a cut can never leave a secret prefix
// too short for its pattern to match.
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > LIMITS.maxDepth) return "<max-depth>";
  if (typeof value === "string") return truncate(redactText(value));
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, LIMITS.maxItems).map((entry) => scrub(entry, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, LIMITS.maxKeys)
        .map(([key, entry]) => [key, scrub(entry, depth + 1)]),
    );
  }
  return String(value);
}
