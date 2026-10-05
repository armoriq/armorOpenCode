// ArmorOpenCode intent-plan schema.
//
// A "plan" is the declaration the model makes at the start of a turn about
// which tools it is about to call and why. ArmorOpenCode enforces that every
// tool call seen at `tool.execute.before` time is present in the plan; drift
// is denied.
//
// Shape kept small on purpose. The model produces this via a directive
// injected into its context by the plugin, either by calling the
// register_intent_plan MCP tool the plugin bundles, or as a fenced ```json
// block in a plan artifact. We validate both.
//
// This file is stdlib-only (in fact import-free) so it can be imported by the
// MCP policy server child process without paying the cost of pulling in the
// full engine.

// ---- Types ----

/**
 * A single normalized step of a validated plan. Every field is required:
 * validateIntentPlan fills `description` with "" and `metadata` with {} when
 * the model omits them, so downstream code never has to re-check.
 */
export interface PlanStep {
  action: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface IntentPlan {
  goal: string;
  steps: PlanStep[];
}

/**
 * A step as the *model* may emit it, before normalization: `description` and
 * `metadata` are genuinely optional. Deliberately a separate type from
 * PlanStep — validateIntentPlan's whole job is turning one into the other,
 * and collapsing them would erase the distinction that makes the
 * normalization defaults meaningful.
 */
export interface RawPlanStep {
  action: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface RawIntentPlan {
  goal: string;
  steps: RawPlanStep[];
}

/**
 * Discriminated union so callers must handle the failure arm: there is no
 * `plan` on an error result and no `error` on a success result.
 */
export type ValidateIntentPlanResult =
  | { ok: true; plan: IntentPlan }
  | { ok: false; error: string };

// ---- Model-facing schema string ----

/**
 * Human-readable schema string injected into the model's context.
 *
 * Uses concrete opencode tool names so the model doesn't have to guess. The
 * list is EXACTLY the nine names empirically confirmed against opencode
 * 1.18.29 (each observed as a real `tool.execute.after` tool string in a live
 * headless session — see internal/research-notes.md §3), no more and no
 * fewer. Both directions matter:
 *
 * - Naming a tool that does NOT exist invites the model to declare a step for
 *   it, which then reads as plan drift. So `todoread`, `apply_patch`, `lsp`,
 *   `question` and `skill` are excluded — the notes flag each as a GAP.
 * - OMITTING a tool that DOES exist is just as bad, and is a fail-closed
 *   false positive: the model calls it, never declared it (because this
 *   prompt never mentioned it), and the drift check denies a benign call.
 *   `todowrite` is the sharp case — the notes record the model reaching for
 *   it in every live session — and it was missing from an earlier draft of
 *   this constant for exactly that reason. The test for this constant
 *   asserts the parsed list against the confirmed set as a SET EQUALITY, so
 *   neither an omission nor an addition can pass unnoticed.
 *
 * Re-verify against a live session before changing this list in either
 * direction.
 */
export const INTENT_PLAN_FORMAT = `{
  "goal": "<one-line summary of the task>",
  "steps": [
    {
      "action": "<opencode tool name, e.g. read, write, edit, bash, grep, glob, todowrite, websearch, webfetch>",
      "description": "<why this step is needed>",
      "metadata": { "inputs": { "/* expected tool parameters, optional */": "" } }
    }
  ]
}`;

// ---- Validation ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a raw parsed object against the intent-plan shape. Returns
 * { ok: true, plan } on success or { ok: false, error } on failure with a
 * human-readable reason.
 *
 * Also NORMALIZES on success: `action` is trimmed (but NOT lowercased — see
 * planToolNames), a missing `description` becomes "", and a missing
 * `metadata` becomes {}.
 *
 * The check order and the exact error strings are part of this function's
 * contract — other code matches on them — so neither may be reordered or
 * reworded casually. Note in particular that an EMPTY `steps` array is a hard
 * error, not an empty allowlist: a plan that declares no tools must be
 * rejected outright rather than silently permitting nothing (or, worse, being
 * read as "no restrictions").
 *
 * Deliberately hand-rolled: keeps this module dependency-free so the MCP
 * server can import it without dragging in the engine or the backend client.
 */
export function validateIntentPlan(raw: unknown): ValidateIntentPlanResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "plan must be a JSON object" };
  }
  const goal = raw.goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    return { ok: false, error: "plan.goal must be a non-empty string" };
  }
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, error: "plan.steps must be a non-empty array" };
  }

  const steps: PlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const s: unknown = rawSteps[i];
    if (!isPlainObject(s)) {
      return { ok: false, error: `plan.steps[${i}] must be an object` };
    }
    const action = s.action;
    if (typeof action !== "string" || action.trim().length === 0) {
      return {
        ok: false,
        error: `plan.steps[${i}].action must be a non-empty string`,
      };
    }
    const description = s.description;
    if (description !== undefined && typeof description !== "string") {
      return {
        ok: false,
        error: `plan.steps[${i}].description must be a string when set`,
      };
    }
    const metadata = s.metadata;
    if (metadata !== undefined && !isPlainObject(metadata)) {
      return {
        ok: false,
        error: `plan.steps[${i}].metadata must be an object when set`,
      };
    }
    steps.push({
      // Trimmed but CASE-PRESERVED: this is what gets written to the plan
      // file on disk. Lowercasing happens only at comparison time, in
      // planToolNames; doing it here would change stored file contents.
      action: action.trim(),
      description: typeof description === "string" ? description : "",
      metadata: isPlainObject(metadata) ? metadata : {},
    });
  }

  return { ok: true, plan: { goal: goal.trim(), steps } };
}

// ---- Tool-name queries ----

/**
 * Pull the `steps` array off a possibly-malformed plan. Mirrors the original
 * JS, which relied on `plan.steps` simply being `undefined` for any non-plan
 * input: nothing here throws, every bad shape degrades to an empty list.
 */
function planSteps(plan: unknown): unknown[] {
  if (!plan || typeof plan !== "object") return [];
  const steps = (plan as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps : [];
}

/**
 * Return the set of tool names declared in the plan (de-duplicated, trimmed,
 * LOWERCASED). Used to build the allowed-tool set and to check drift.
 *
 * Takes `unknown` rather than IntentPlan on purpose: callers pass whatever
 * came back from loadPlan, which does not re-validate shape, so this must
 * return [] for null/garbage rather than throwing.
 */
export function planToolNames(plan: unknown): string[] {
  const seen = new Set<string>();
  for (const step of planSteps(plan)) {
    const action = (step as { action?: unknown } | null)?.action;
    if (typeof action === "string") {
      seen.add(action.trim().toLowerCase());
    }
  }
  return Array.from(seen);
}

/**
 * True iff `toolName` is present in the plan. Case-insensitive and trimmed on
 * both sides, to survive the model emitting different casing.
 *
 * Matching is EXACT after lowercase+trim — there is deliberately no prefix,
 * wildcard, or namespace matching here. In particular opencode's MCP tools
 * arrive as `<mcpServerName>_<toolName>` (confirmed, see
 * internal/research-notes.md §3) and are NOT matched by a plan step naming
 * just the server or just the tool; any exemption for those belongs in the
 * policy engine, not in this schema module.
 */
export function planContainsTool(plan: unknown, toolName: unknown): boolean {
  if (!plan || typeof toolName !== "string") return false;
  const needle = toolName.trim().toLowerCase();
  return planToolNames(plan).includes(needle);
}
