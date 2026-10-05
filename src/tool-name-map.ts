// Tool name classification for ArmorOpenCode.
//
// This is the single copy of the opencode -> backend tool mapping (ArmorGemini
// kept two, which drifted; see the Phase 3 spec, Decision 2). The backend
// vocabulary comes from the server's `KNOWN_TOOLS`. opencode MCP tools are
// named `<server>_<tool>` (confirmed, internal/research-notes.md section 3),
// which is how the plan management tools are recognized below.
//
// Every function here is total: no input makes it throw.

/** The backend (policy-ir `KNOWN_TOOLS`) tool vocabulary. */
export type BackendToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Glob"
  | "Grep"
  | "WebFetch"
  | "WebSearch";

/**
 * Key: lowercased opencode tool name. Value: backend name, or "*" for the
 * wildcard. A Map, never a plain object, so "constructor" and "__proto__"
 * cannot hit a prototype property.
 */
export const OPENCODE_TO_BACKEND_TOOL: ReadonlyMap<
  string,
  BackendToolName | "*"
> = new Map<string, BackendToolName | "*">([
  ["*", "*"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  // GAP: name unconfirmed (internal/research-notes.md section 3); the backend
  // has no patch tool, so it is bucketed under Edit. Re-verify before changing.
  ["apply_patch", "Edit"],
  ["bash", "Bash"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
]);

/**
 * Lowercase opencode tools with no backend equivalent that the engine
 * exempts. Benign by nature: todo state, language server queries, skill
 * loading, asking the user a question.
 */
export const ALWAYS_ALLOWED_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "todowrite",
  // GAP: not observed (internal/research-notes.md section 3). If it exists it
  // is the read half of todowrite; omitting it would false deny. Re-verify
  // before changing.
  "todoread",
  // GAP: not observed, LSPs were disabled in the probe. Re-verify before
  // changing.
  "lsp",
  "skill",
  "question",
]);

/** Must equal MCP_SERVER_NAME in scripts/install.ts (a test enforces it). */
export const ARMOR_MCP_SERVER_NAME = "armor-opencode-policy";

export const PLAN_MANAGEMENT_TOOLS = [
  "register_intent_plan",
  "reset_intent_plan",
  "get_intent_plan",
  "policy_read",
  "policy_stage",
  "policy_discard",
] as const;

/** The three fully qualified names: `${ARMOR_MCP_SERVER_NAME}_${tool}`. */
export const ARMOR_POLICY_TOOL_NAMES: ReadonlySet<string> = new Set(
  PLAN_MANAGEMENT_TOOLS.map((tool) =>
    `${ARMOR_MCP_SERVER_NAME}_${tool}`.toLowerCase(),
  ),
);

/**
 * String(x) that cannot throw (a Symbol or a null prototype object makes the
 * built in throw). Hook data is external, so every coercion goes through here.
 */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

/**
 * Map an opencode tool name to the backend's name. Case and surrounding
 * whitespace are ignored for lookup; an unknown name is returned untouched
 * (same string, original casing) so unclassified tools stay visible.
 */
export function toBackendToolName(toolName: string): string {
  // The name comes from external hook data, so a non string is reachable at
  // runtime despite the type. Coerce it rather than throw (AC-X3).
  if (typeof toolName !== "string") return safeString(toolName);
  return OPENCODE_TO_BACKEND_TOOL.get(toolName.trim().toLowerCase()) ?? toolName;
}

/** True for opencode tools the engine never gates. Non strings are false. */
export function isAlwaysAllowedNativeTool(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    ALWAYS_ALLOWED_NATIVE_TOOLS.has(toolName.trim().toLowerCase())
  );
}

/**
 * True only for ArmorOpenCode's own three plan management tools, fully
 * qualified. Exact set membership on purpose: no prefix or suffix matching,
 * so lookalikes (`evil-...`, `..._x`) can never be exempted.
 */
export function isArmorPolicyTool(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    ARMOR_POLICY_TOOL_NAMES.has(toolName.trim().toLowerCase())
  );
}
