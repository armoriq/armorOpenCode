// Hand-rolled YAML formatter for the armor.policy.v1 PolicyProfile shape.
// Small, dependency-free, purpose-built for the fields the plugin actually
// writes (metadata, defaults, statements with principal/action/resource/
// conditions). NOT a general YAML dumper — see quoteScalar.
//
// The output is meant to be READ by a human in the terminal to decide
// whether to run /armor/yes or /armor/no. It is not meant to be parsed back
// into a policy — the source of truth is the JSON stored in the pending
// file, and the same JSON is what the plugin actually sends to the backend.
//
// Because the output IS the contract here, the formatting details below
// (quoting rules, the leading space on `[]`, the "- " first-key placement,
// the per-branch indent arithmetic, insertion-order keys) are all
// load-bearing and reproduced verbatim from the JS original.
//
// Note the input type is `unknown`, not a PolicyProfile: this formatter reads
// no field of the policy by name, so typing it against the real profile shape
// would couple this module to backend-client (Phase 3) for zero benefit.

// Duplicated in intent-schema.ts rather than shared, deliberately: both
// modules are imported by the MCP policy server child process and stay
// dependency-free. Kept textually identical so the duplication is obvious.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render one scalar, quoting it when necessary.
 *
 * The character class is reproduced VERBATIM from the original and is NOT a
 * general "YAML-unsafe" set — do not "fix" or extend it, because the exact
 * bare-vs-quoted split is what the human reader has been reading. Two
 * consequences worth knowing: `armor.policy.v1` and `PolicyProfile` stay
 * bare (`.` and letters aren't in the class), while any hyphenated value gets
 * quoted (`-` is).
 *
 * `null` and `undefined` both render as the bare word `null`; booleans and
 * numbers go through String() unquoted.
 */
function quoteScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  const s = String(value);
  // Quote when the value contains any character that would change YAML
  // meaning if left bare. Also quote empty strings and leading/trailing
  // whitespace.
  if (s === "" || /[:#\-{}\[\],&*!|>'"%@`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Render the right-hand side of `key:` (including its leading space or
 * newline). Mutually recursive with dumpObject.
 */
function dumpValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    // Leading space (not a newline) so an empty array lands as
    // `conditions: []` on a single line.
    if (value.length === 0) return " []";
    const items = value.map((item: unknown) => {
      if (isPlainObject(item)) {
        const inner = dumpObject(item, indent + 2);
        // First key sits next to the "- ", subsequent keys are re-indented.
        return `\n${pad}- ${inner.replace(/^ +/, "")}`;
      }
      return `\n${pad}- ${quoteScalar(item)}`;
    });
    return items.join("");
  }
  if (isPlainObject(value)) {
    return "\n" + dumpObject(value, indent + 2);
  }
  return " " + quoteScalar(value);
}

/**
 * Render an object's keys, one `key: value` line each, in `Object.entries`
 * INSERTION ORDER — deliberately unsorted, so the reader sees the policy laid
 * out the way it was built.
 *
 * The indent arithmetic differs per branch: array and nested-object values
 * are dumped at `indent + 2`, scalars at `indent`. The scalar case looks
 * redundant (dumpValue's scalar branch ignores `indent` entirely), but the
 * other two branches do use it, so the split is kept as-is rather than
 * collapsed — passing `indent + 2` uniformly would shift every nested line.
 */
function dumpObject(obj: Record<string, unknown>, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}:${dumpValue(value, indent + 2)}`);
    } else if (isPlainObject(value)) {
      lines.push(`${pad}${key}:${dumpValue(value, indent + 2)}`);
    } else {
      lines.push(`${pad}${key}:${dumpValue(value, indent)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a policy profile as human-readable YAML for the terminal preview.
 * Layout mirrors the shape the backend accepts so the reader can eyeball
 * exactly what will be sent when they run /armor/yes.
 *
 * Returns the literal string "(no policy)" for any non-plain-object input —
 * including `null` and arrays. Emits NO trailing newline; callers add their
 * own.
 */
export function policyToYaml(policy: unknown): string {
  if (!isPlainObject(policy)) return "(no policy)";
  return dumpObject(policy, 0);
}
