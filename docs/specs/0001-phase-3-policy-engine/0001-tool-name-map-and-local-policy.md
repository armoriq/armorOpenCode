# 0001. PR 3a: tool name map and local policy

Child of [0001 Phase 3 policy engine and backend client](index.md). Read the umbrella `index.md` first: it holds the module graph, the fail closed contract, the divergence table, and the implementer handoff.

## Summary

Adds `src/tool-name-map.ts` (what each opencode tool is called to the backend, which tools are always allowed, and how to recognize ArmorOpenCode's own plan tools) and `src/local-policy.ts` (reading, validating, saving, and evaluating the local `policy.json`). Both are pure, dependency free libraries with `bun:test` tests. Target size: about 350 source lines, about 500 test lines, under 1,000 total.

## Scope

In: the two source files and `test/tool-name-map.test.ts`, `test/local-policy.test.ts`.
Out: any import of `config.ts`, the backend client, `planner.ts`, `pending.ts`, or `policy-yaml.ts` from these two files. No engine, no plugin glue, no changes to existing files.

## Requirements

**Acceptance criteria**:

- **AC-A1** (mapping): `toBackendToolName` maps the confirmed opencode names per the table below, ignoring case and surrounding whitespace; maps `"*"` to `"*"`; maps `apply_patch` to `Edit`; returns an unknown name unchanged (same string, original casing, no trim); is idempotent on backend names (`toBackendToolName("WebFetch") === "WebFetch"`); never throws and never returns a non string for any string input, including `constructor`, `__proto__`, `toString`, `hasOwnProperty`, and `""`.
- **AC-A2** (always allowed): `isAlwaysAllowedNativeTool` is true for exactly `todowrite`, `todoread`, `lsp`, `skill`, `question` (case and whitespace insensitive), false for everything else including MCP prefixed forms such as `everything_skill`, and false for non strings.
- **AC-A3** (plan tool matcher, the first run deadlock): `isArmorPolicyTool` is true for exactly the three names `armor-opencode-policy_register_intent_plan`, `armor-opencode-policy_reset_intent_plan`, `armor-opencode-policy_get_intent_plan` (case and whitespace insensitive). It is false for: the bare names, `mcp_armor-opencode-policy_register_intent_plan`, `armor-opencode-policy__register_intent_plan`, `evil-armor-opencode-policy_register_intent_plan`, `armor-opencode-policy_register_intent_plan_x`, `armor-opencode-policy_other_tool`, `other-server_register_intent_plan`, the empty string, and any non string. `ARMOR_MCP_SERVER_NAME` equals `MCP_SERVER_NAME` exported by `scripts/install.ts`.
- **AC-A4** (coverage of the planned tools): every tool name in `INTENT_PLAN_FORMAT` (the nine confirmed names) is either a key of `OPENCODE_TO_BACKEND_TOOL` or in `ALWAYS_ALLOWED_NATIVE_TOOLS`. A tool the model is told to plan can never be unclassified.
- **AC-A5** (storage): `saveActivePolicy` then `loadActivePolicy` round trips a valid policy to `{ status: "ok", policy }`. With no file, `loadActivePolicy` returns `{ status: "none" }`. With a file that is unparseable JSON, a JSON value that is not `{ savedAt, policy }`, a policy that fails `validatePolicyProfile`, or a path that is a directory or unreadable, it returns `{ status: "invalid", error }` with a message naming the file path and the first problem. `saveActivePolicy` throws on an invalid policy and leaves any existing `policy.json` untouched. After a successful save no temp file remains in `dataDir`.
- **AC-A6** (validation): `validatePolicyProfile` accepts a well formed profile and rejects, with a specific error string each: non object; `statements` not an array; a statement that is not an object; `id` not a non empty string; `effect` not `permit` or `forbid`; `action` not an object; `action.eq` not a non empty string; `defaults` present but not an object; `defaults.decision` present and not `allow` or `deny`; `defaults.conflictResolution` present and not `deny_overrides` or `permit_overrides`. It ignores extra keys and does not check `principal`, `resource`, `conditions`, `metadata`, `schemaVersion` (the backend owns those).
- **AC-A7** (evaluation): `evaluateLocalPolicy` follows the evaluation rules below. In particular: `deny_overrides` makes a forbid beat a permit; `permit_overrides` makes a permit beat a forbid; no match applies `defaults.decision`; `null` or `undefined` policy returns allow with reason `no local policy`; a non null, non object policy returns deny; a matching statement with an unknown `effect` denies; an unknown `conflictResolution` behaves as `deny_overrides`; a `*` forbid denies every tool name including `""`; never throws.
- **AC-A8** (matching): a statement matches when its `action.eq` (lowercased, trimmed) is `*`, OR equals the lowercased `toBackendToolName(toolName)`, OR equals the lowercased, trimmed raw `toolName`. So a `forbid Edit` denies `apply_patch`, a `forbid apply_patch` also denies `apply_patch`, a `forbid Bash` denies `bash` and `BASH`, and a `forbid armor-opencode-policy_register_intent_plan` denies that MCP tool.
- **AC-A9** (reasons): deny reason is exactly `Local policy statement <id> denies <toolName>`, permit reason is exactly `Local policy statement <id> permits <toolName>`, default reason is exactly `Local policy default (<allow|deny>)`. The engine and later tests match on these strings; do not reword.

## Design

### `src/tool-name-map.ts` (about 110 lines)

Header comment states: this is the single copy of the mapping (ArmorGemini kept two; see index Decision 2), the backend vocabulary comes from the server's `KNOWN_TOOLS`, and that opencode MCP tools are `<server>_<tool>` (confirmed, `internal/research-notes.md` section 3).

```ts
/** The backend (policy-ir `KNOWN_TOOLS`) tool vocabulary. */
export type BackendToolName =
  | "Read" | "Write" | "Edit" | "Bash"
  | "Glob" | "Grep" | "WebFetch" | "WebSearch";

/** Key: lowercased opencode tool name. Value: backend name, or "*" for the wildcard. */
export const OPENCODE_TO_BACKEND_TOOL: ReadonlyMap<string, BackendToolName | "*">;

/** Lowercase opencode tools with no backend equivalent that the engine exempts. */
export const ALWAYS_ALLOWED_NATIVE_TOOLS: ReadonlySet<string>;

/** Must equal MCP_SERVER_NAME in scripts/install.ts (a test enforces it). */
export const ARMOR_MCP_SERVER_NAME = "armor-opencode-policy";
export const PLAN_MANAGEMENT_TOOLS = [
  "register_intent_plan",
  "reset_intent_plan",
  "get_intent_plan",
] as const;
/** The three fully qualified names: `${ARMOR_MCP_SERVER_NAME}_${tool}`. */
export const ARMOR_POLICY_TOOL_NAMES: ReadonlySet<string>;

export function toBackendToolName(toolName: string): string;
export function isAlwaysAllowedNativeTool(toolName: unknown): boolean;
export function isArmorPolicyTool(toolName: unknown): boolean;
```

**The mapping table** (source: `internal/research-notes.md` section 3 and the summary table; the confirmed nine plus `apply_patch`):

| opencode tool (key) | Backend name | Confidence |
|---|---|---|
| `*` | `*` | n/a |
| `read` | `Read` | confirmed |
| `write` | `Write` | confirmed |
| `edit` | `Edit` | confirmed |
| `apply_patch` | `Edit` | GAP: name unconfirmed; backend has no patch tool, bucketed under `Edit` (MEMORY.md flagged gap) |
| `bash` | `Bash` | confirmed |
| `glob` | `Glob` | confirmed |
| `grep` | `Grep` | confirmed |
| `webfetch` | `WebFetch` | confirmed |
| `websearch` | `WebSearch` | confirmed |

**Always allowed native tools** (no backend equivalent, benign by nature: todo state, language server queries, skill loading, asking the user a question):

| Tool | Confidence |
|---|---|
| `todowrite` | confirmed (also in `INTENT_PLAN_FORMAT`) |
| `todoread` | GAP: not observed; included because if it exists it is the read half of `todowrite`, and omitting it would false deny |
| `lsp` | GAP: not observed (LSPs were disabled in the probe) |
| `skill` | indirectly corroborated |
| `question` | indirectly corroborated (appears as a permission key) |

Add a comment above each GAP entry pointing at the research note and saying "re-verify before changing". Do NOT add `list`, `patch`, `multiedit`, `task`, or any Gemini style alias (`ls`, `find`, `shell`, `fetch`): they are not in the research and unclassified names must stay visible (index Q6).

**Behavior notes**:

- `OPENCODE_TO_BACKEND_TOOL` is a `Map` (and the set a `Set`), never a plain object, so `"constructor"` cannot hit a prototype property (divergence 5). Lookup is `map.get(toolName.trim().toLowerCase())`.
- `toBackendToolName(name)` returns `map.get(key) ?? name`. The fallback returns the argument untouched.
- `isArmorPolicyTool(name)`: `typeof name === "string" && ARMOR_POLICY_TOOL_NAMES.has(name.trim().toLowerCase())`. Build the set with lowercase entries. Exact set membership only: no `startsWith`, `endsWith`, regex, or slicing. That is what keeps AC-A3's negative cases false by construction.
- All three functions are total (no throw) for any input.

### `src/local-policy.ts` (about 240 lines)

Header comment keeps ArmorGemini's design note (local policy is authoritative for enforcement; backend adds org wide policy; `/armor/yes` is the only confirmation because the backend confirm endpoint is JWT only) and adds the fail closed rules.

Imports: `node:fs` (`mkdirSync`, `readFileSync`, `writeFileSync`, `renameSync`, `existsSync`, `rmSync`), `node:path` (`join`), and `import { toBackendToolName } from "./tool-name-map.ts"`. Nothing else.

```ts
export type PolicyEffect = "permit" | "forbid";
export type PolicyDecision = "allow" | "deny";
export type ConflictResolution = "deny_overrides" | "permit_overrides";

export interface PolicyStatement {
  id: string;
  effect: PolicyEffect;
  principal: { type: string; id: string };
  action: { type: string; eq: string };
  resource: { type: string; scope: string };
  conditions: unknown[];
}

/** The armor.policy.v1 PolicyProfile document. */
export interface PolicyProfile {
  schemaVersion: string;
  kind: "PolicyProfile";
  metadata: { name: string; description: string };
  defaults: { decision: PolicyDecision; conflictResolution: ConflictResolution };
  statements: PolicyStatement[];
}

/** On disk: `${dataDir}/policy.json`. */
export interface ActivePolicyRecord { savedAt: string; policy: PolicyProfile }

export type ValidatePolicyResult =
  | { ok: true; policy: PolicyProfile }
  | { ok: false; error: string };

export type LoadPolicyResult =
  | { status: "none" }
  | { status: "ok"; policy: PolicyProfile }
  | { status: "invalid"; error: string };

export interface LocalPolicyVerdict {
  decision: PolicyDecision;
  /** The statement that decided it; null when a default applied. */
  matched: PolicyStatement | null;
  reason: string;
}

export function activePolicyPath(dataDir: string): string;
export function validatePolicyProfile(raw: unknown): ValidatePolicyResult;
export function saveActivePolicy(dataDir: string, policy: PolicyProfile): ActivePolicyRecord;
export function loadActivePolicy(dataDir: string): LoadPolicyResult;
export function hasActivePolicy(dataDir: string): boolean;
export function evaluateLocalPolicy(
  policy: PolicyProfile | null | undefined,
  toolName: string,
): LocalPolicyVerdict;
```

Types note: `validatePolicyProfile` validates only the fields the evaluator reads (AC-A6); the interface lists the full shape because 3b builds it. A profile that passes validation but lacks `principal` and so on is accepted and evaluated correctly, since the evaluator never reads those.

**`validatePolicyProfile`**: hand rolled like `validateIntentPlan`. Error strings are specific and path style, for example `policy.statements[2].effect must be "permit" or "forbid"`. Missing `defaults` is accepted (the evaluator applies `allow` and `deny_overrides`). On success return the SAME object, typed; do not clone or normalize.

**`saveActivePolicy`**: validates first (throws `Error("Refusing to save invalid policy: <error>")`); `mkdirSync(dataDir, { recursive: true })`; writes `{ savedAt: new Date().toISOString(), policy }` as `JSON.stringify(record, null, 2) + "\n"` to `${path}.${process.pid}.tmp`, then `renameSync` over `policy.json`; on any write or rename error removes the temp file (best effort) and rethrows. Returns the record.

**`loadActivePolicy`**: one `try` around `readFileSync` (no `existsSync` guard, see the filesystem note in MEMORY.md: the guard only creates a race). A caught error with `code === "ENOENT"` returns `none`; any other read error returns `invalid` with `Cannot read <path>: <message>`. Then `JSON.parse` (failure: `invalid`, `<path> is not valid JSON: <message>`), then require an object with a `policy` key (`<path> is missing "policy"`), then `validatePolicyProfile(parsed.policy)` (failure: `invalid`, `<path>: <error>`).

**`hasActivePolicy`**: `existsSync(activePolicyPath(dataDir))`. Existence only; the doc comment says callers needing validity must use `loadActivePolicy`.

**`evaluateLocalPolicy` rules** (ports the original, plus the fail closed fixes):

1. `policy == null` returns allow, `matched: null`, reason `no local policy`. A non null, non object value returns deny with reason `Local policy is malformed`.
2. `names = new Set([toBackendToolName(toolName).trim().toLowerCase(), String(toolName).trim().toLowerCase()])`.
3. Walk `policy.statements` (treat a non array as empty). For each statement, `eq = String(s?.action?.eq ?? "").trim().toLowerCase()`; skip when empty; it matches when `eq === "*"` or `names.has(eq)`. A matching statement with `effect === "permit"` records the first matched permit; ANY other effect (including unknown) records the first matched forbid.
4. `conflict = policy.defaults?.conflictResolution === "permit_overrides" ? "permit_overrides" : "deny_overrides"`.
5. `deny_overrides`: forbid wins over permit. `permit_overrides`: permit wins over forbid. First matched of the winning kind is `matched`.
6. No match: `defaults.decision === "deny" ? "deny" : "allow"`, `matched: null`.

Note: `defaults.decision` values other than `deny` mean allow here, but `validatePolicyProfile` already rejects anything that is not `allow` or `deny` before the evaluator sees it in the real path.

The engine (Phase 4) is expected to: call `loadActivePolicy`; on `invalid` deny every call with the error text; on `ok` evaluate and deny on a deny verdict; on `none` skip to the backend. That wiring is out of scope here but the result type exists to make the only safe usage the easy one.

## Test plan

Framework: `bun:test`. Test data inline (no fixtures directory; matches commit `1bf0fc8`). Scratch dirs from `mkdtempSync(join(tmpdir(), "aoc-local-policy-"))`, removed in `afterEach`. Fixture policies are written inline (a small `profile({ statements, defaults })` helper that fills the required fields); 3a tests must NOT import the 3b builders (they do not exist yet; the round trip with builders lives in 3b, AC-B9).

`test/tool-name-map.test.ts` (about 170 lines):
- Table driven: each confirmed key maps to its backend name; `apply_patch` to `Edit`; `*` to `*`; upper case and padded variants map the same.
- Unknown name returns the identical string (including `"  Foo "` unchanged); `everything_echo` unchanged.
- Prototype keys: `constructor`, `__proto__`, `toString`, `hasOwnProperty`, `valueOf` return themselves.
- Idempotence over every backend name value.
- Always allowed: exact membership; `skill` true, `everything_skill` false, `bash` false, non strings false.
- Plan tool matcher: the three positives (plus upper case and padded forms); every negative from AC-A3 in a table; non strings.
- Constant equality with `MCP_SERVER_NAME` from `../scripts/install.ts`.
- Coverage cross check using `INTENT_PLAN_FORMAT`: parse the `e.g. <list>` the way `test/intent-schema.test.ts` does (copy its small regex helper, with the same "if the wording changed, update the parser" failure message) and assert every listed name is mapped or always allowed.
- Mutation evidence to capture during `/check`: change `ARMOR_POLICY_TOOL_NAMES.has` to `endsWith` and show the negative table fails; change the `Map` to an object literal and show the prototype test fails.

`test/local-policy.test.ts` (about 330 lines):
- `validatePolicyProfile`: one test per rejection in AC-A6 asserting the exact error string; valid minimal profile; valid with extra keys; missing `defaults` accepted; returns the same object reference.
- Storage: round trip; `none` when absent; each `invalid` source in AC-A5 (garbage JSON, array at top level, `{}` without `policy`, `{ policy: "x" }`, `{ policy: { statements: "no" } }`, `policy.json` as a directory); error text contains the file path; save refuses invalid and keeps the old file byte for byte; no `*.tmp` left behind; save creates a missing nested `dataDir`; `hasActivePolicy` true for a corrupt file (existence only).
- Evaluation, ported cases from ArmorGemini's `tests/local-policy.test.mjs` with fixtures inline: forbid on `web_fetch` style name is now `webfetch` matching `WebFetch`; default allow on unmatched tool; `*` lockdown denies a list of tools including `""`; null policy allows; permit plus forbid on one tool denies and `matched.id` is the forbid.
- New fail closed cases: `permit_overrides` permit wins; unknown `conflictResolution` behaves as deny wins; unknown `effect` matching statement denies; non object policy denies; default deny applies to an unmatched tool; `forbid Edit` denies `apply_patch`; `forbid apply_patch` denies `apply_patch` but not `edit`; MCP tool name forbidden by raw name; `constructor` and `__proto__` tool names do not throw and follow the default; reason strings pinned exactly (AC-A9).
- Atomicity: with `renameSync` unusable is hard to mock in `bun:test`; instead assert no temp file remains after success, and that saving over an existing valid file replaces it whole. Do not mock the filesystem.

Coverage expectation: every branch of the fail closed table that belongs to 3a has a test; every row of the divergence table 1, 2, 5, 6 has a pinned test.

## Build plan

Order is bottom up by dependency, test first within each step (this repo has no recorded build approach; assuming small vertical slices, with the data free module first).

1. Write `test/tool-name-map.test.ts` (red), then `src/tool-name-map.ts` (green), satisfies **AC-A1**, **AC-A2**, **AC-A3**, **AC-A4**, **AC-X1**, **AC-X3**.
2. Write the validation and storage tests (red), then `validatePolicyProfile`, `activePolicyPath`, `saveActivePolicy`, `loadActivePolicy`, `hasActivePolicy` (green), satisfies **AC-A5**, **AC-A6**, **AC-X2**, **AC-X3**.
3. Write the evaluation tests (red), then `evaluateLocalPolicy` (green), satisfies **AC-A7**, **AC-A8**, **AC-A9**, **AC-X2**, **AC-X3**.
4. Run `bun test`, `bunx tsc --noEmit -p tsconfig.json`, the bundle smoke (`bun build src/local-policy.ts --target node --outdir <tmp>`), and check the diff size, satisfies **AC-X4**, **AC-X5**.
5. `/test`, `/check verify`, `/check review` per the index handoff, then commit.

## Consequences

See the umbrella. Specific to 3a: `loadActivePolicy` returning `invalid` is a new contract Phase 4 must honor; the deny reason it produces should tell the user how to recover (fix or delete `policy.json`, or re-run `/armor/yes`).
