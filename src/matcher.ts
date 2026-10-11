// Ported from armorCodex scripts/lib/common.mjs so policy files written for
// ArmorCodex match identically here.

const OPERATORS = ["$equals", "$contains", "$startsWith", "$endsWith", "$matches", "$pathContains"] as const;
type Operator = (typeof OPERATORS)[number];
export type MatcherSpec = Partial<Record<Operator, string>>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperator(key: string): key is Operator {
  return (OPERATORS as readonly string[]).includes(key);
}

export function isMatcherSpec(value: unknown): value is MatcherSpec {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(isOperator);
}

function isSubsetValue(candidate: unknown, target: unknown): boolean {
  if (candidate === undefined) return true;
  if (candidate === null || target === null) return candidate === target;
  if (Array.isArray(candidate)) {
    return Array.isArray(target) && candidate.every((value) => target.some((item) => isSubsetValue(value, item)));
  }
  if (isPlainObject(candidate)) {
    if (!isPlainObject(target)) return false;
    return Object.entries(candidate).every(([key, value]) => isSubsetValue(value, target[key]));
  }
  return candidate === target;
}

// A rule mentioning ~/.ssh must match /Users/foo/.ssh, $HOME/.ssh and
// "ls ~/.ssh" alike, so every home spelling collapses to one sentinel.
function canonicalizePath(input: string): string {
  return input
    .trim()
    .replace(/(^|[\s"'`(=:])~(?=\/)/g, "$1$HOME")
    .replace(/\$\{?HOME\}?/g, "<HOME>")
    .replace(/\/(?:home|Users)\/[^/\s'"`)]+/gi, "<HOME>")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

export function matchesScalar(spec: unknown, actual: unknown): boolean {
  if (!isMatcherSpec(spec)) return spec === actual;
  if (typeof actual !== "string" && typeof actual !== "number") return false;
  const haystack = String(actual);
  const lower = haystack.toLowerCase();
  for (const [op, needle] of Object.entries(spec)) {
    const needleLower = String(needle).toLowerCase();
    switch (op) {
      case "$equals":
        if (haystack !== needle) return false;
        break;
      case "$contains":
        if (!lower.includes(needleLower)) return false;
        break;
      case "$startsWith":
        if (!lower.startsWith(needleLower)) return false;
        break;
      case "$endsWith":
        if (!lower.endsWith(needleLower)) return false;
        break;
      case "$matches":
        try {
          if (!new RegExp(String(needle), "i").test(haystack)) return false;
        } catch {
          return false;
        }
        break;
      case "$pathContains": {
        const actualPath = canonicalizePath(haystack);
        const needlePath = canonicalizePath(String(needle));
        const homeStripped = needlePath.replace(/^<home>\/?/, "");
        if (!actualPath.includes(needlePath) && !(homeStripped && actualPath.includes(homeStripped))) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

export function matchParams(ruleParams: Record<string, unknown>, toolInput: unknown): boolean {
  const target = isPlainObject(toolInput) ? toolInput : {};
  for (const [key, expected] of Object.entries(ruleParams)) {
    const actual = target[key];
    if (actual === undefined) return false;
    if (isMatcherSpec(expected)) {
      if (!matchesScalar(expected, actual)) return false;
    } else if (isPlainObject(expected)) {
      if (!matchParams(expected, actual)) return false;
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return false;
      const allFound = expected.every((needle) =>
        actual.some((item) => matchesScalar(needle, item) || isSubsetValue(needle, item)),
      );
      if (!allFound) return false;
    } else if (expected !== actual) {
      return false;
    }
  }
  return true;
}

export function matchesAnyStringField(spec: MatcherSpec, toolInput: unknown, depth = 0): boolean {
  if (depth > 4 || toolInput === null || toolInput === undefined) return false;
  if (typeof toolInput === "string") return matchesScalar(spec, toolInput);
  if (Array.isArray(toolInput)) return toolInput.some((entry) => matchesAnyStringField(spec, entry, depth + 1));
  if (isPlainObject(toolInput)) {
    return Object.values(toolInput).some((value) => matchesAnyStringField(spec, value, depth + 1));
  }
  return false;
}
