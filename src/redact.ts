import { isPlainObject } from "./matcher.ts";

export const MAX_FIELD_CHARS = 2000;

// armorCodex's patterns miss prefixed names such as OPENAI_API_KEY, quoted
// JSON keys, Basic auth, curl -u and bare provider keys; these do not.
const SECRET_NAME = String.raw`\b[A-Za-z0-9_\-]*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_\-]*`;

const SECRET_PATTERNS = [
  /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
  new RegExp(String.raw`(${SECRET_NAME}["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)[^\s"',;]{6,}`, "gi"),
  /(\s-u\s+["']?[^\s:"']+:)[^\s"']+/g,
  /(:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_\-]{16,}/g,
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

// Redaction runs before the final cut so a secret straddling it is never left
// as a prefix too short to match. The first, wider cut bounds regex cost on
// tool output that can be megabytes long.
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > LIMITS.maxDepth) return "<max-depth>";
  if (typeof value === "string") return truncate(redactText(value.slice(0, MAX_FIELD_CHARS * 4)));
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
