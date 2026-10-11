export const MAX_PARAM_CHARS = 2000;

const LIMITS = { maxDepth: 4, maxKeys: 50, maxItems: 50 };

// A superset of ArmorClaude common.mjs SECRET_PATTERNS (from PR #36): also
// prefixed names such as OPENAI_API_KEY, quoted JSON keys, Basic auth,
// `curl -u`, URL userinfo and bare provider keys.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Redaction runs before the final cut so a secret straddling the cut is never
// left as a prefix too short to match. The wider first cut bounds regex cost
// on megabyte-sized arguments.
function scrubString(value: string): string {
  const redacted = redactText(value.slice(0, MAX_PARAM_CHARS * 4));
  return redacted.length > MAX_PARAM_CHARS ? `${redacted.slice(0, MAX_PARAM_CHARS)}...` : redacted;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > LIMITS.maxDepth) return "<max-depth>";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "<function>";
  if (value instanceof Uint8Array) return `<binary:${value.length}>`;
  if (Array.isArray(value)) return value.slice(0, LIMITS.maxItems).map((entry) => scrub(entry, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, LIMITS.maxKeys)) out[key] = scrub(entry, depth + 1);
    return out;
  }
  return String(value);
}

export function sanitizeParams(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return scrub(value, 0) as Record<string, unknown>;
}
