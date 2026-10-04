# 0001. Phase 3 policy engine and backend client

**Date**: 2026-10-04
**Status**: Proposed

## Summary

Phase 3 ports three ArmorGemini libraries to TypeScript: a tool name map, a local policy engine, and the ArmorIQ backend client. It ships as two pull requests, each under 1,000 lines: 3a (tool name map plus local policy) and 3b (backend client). The port keeps ArmorGemini's logic but closes several places where it failed open (let a call through when something was wrong), because ArmorOpenCode is a security product and a silent bypass is the worst bug it can have. It also fixes the first run deadlock (the product refusing to register its own plan) with a matcher written for opencode's tool naming.

## Structure

- [0001-tool-name-map-and-local-policy.md](0001-tool-name-map-and-local-policy.md): PR 3a. `src/tool-name-map.ts`, `src/local-policy.ts`, and their tests. Decides the tool name table, the always allowed set, the plan tool matcher, and the local policy fail closed rules.
- [0002-backend-client.md](0002-backend-client.md): PR 3b. `src/backend-client.ts` and its tests. Decides the request contract, the failure matrix, the policy builders and templates.

3b depends on 3a. Nothing else in `src/` changes in Phase 3.

## Requirements

Acceptance criteria that span both children (each child holds its own detailed criteria, prefixed `AC-A` and `AC-B`):

- **AC-X1**: With no plan registered and `intentRequired` true, the fully qualified plan management tool names (`armor-opencode-policy_register_intent_plan`, `..._reset_intent_plan`, `..._get_intent_plan`) are recognized by `isArmorPolicyTool`, so Phase 4 can exempt them and the first run deadlock cannot happen.
- **AC-X2**: Every code path in these three modules that cannot positively establish "allowed" returns a deny. No module returns allow because a file is corrupt, a response is malformed, a name is unknown, or a request failed.
- **AC-X3**: No module throws on hostile or odd input (unknown tool names such as `constructor`, `__proto__`, empty strings, non string values, garbage JSON). Failure is always a returned value, never an exception, except `saveActivePolicy` refusing an invalid policy (a caller bug, loud on purpose).
- **AC-X4**: Each PR is under 1,000 changed lines including tests and comments, passes `bun test` and `bunx tsc --noEmit -p tsconfig.json`, and the modules bundle with `bun build` (no `tsc` emit, see the bundler note in `internal/PLAN.md`).
- **AC-X5**: The tool name map is defined once, in `tool-name-map.ts`. The ArmorGemini deliberate duplicate copy in `local-policy` is NOT reproduced (see Decision 2).

## Decision

**Chosen option**: Option 2: a faithful port with fail closed fixes and a single shared tool name map.

The two PRs port the logic and API shape of ArmorGemini's `local-policy.mjs` and `backend-client.mjs`, but with eight deliberate behavior changes (listed in the divergence table below), each pinned by a test.

**Decisions made (pick, one line why, runner up):**

1. **Spec and PR shape.** Two PRs, 3a then 3b, stacked. Why: the plan already sized them, and 3b needs 3a's `PolicyProfile` type. Runner up: one PR (rejected, would crowd 1,000 lines once fail closed tests are added).
2. **One tool name map, no duplicate.** `local-policy.ts` imports `tool-name-map.ts`. PLAN.md asked to preserve ArmorGemini's duplicate copy "for zero dependency loading". Why not: ArmorGemini ran as a fresh process per hook call where load cost mattered, and two tables that must agree are a drift risk. Here both modules are bundled into one plugin file, so a shared import costs nothing, and a drifted second copy would be a silent policy hole. Runner up: keep the duplicate (rejected for that drift risk). This overrides the PLAN.md line; flagged as an open question.
3. **Plan tool matcher lives in `tool-name-map.ts` (3a), not a Phase 4 `is-armor-tool.ts`.** Why: PLAN.md ties the deadlock warning to Phase 3, and the matcher is pure data plus a string compare. Phase 4 should import it and not create a second matcher. Runner up: build it in Phase 4 (rejected, the deadlock test would not exist until the riskiest phase).
4. **Exact match only for plan tools.** Only the three fully qualified names match, compared case insensitively after trim. No bare names, no `mcp_`/`__` forms, no suffix or prefix matching. Why: a looser matcher would let a user defined opencode tool or another MCP server that borrows the name skip enforcement. Runner up: also accept bare names (rejected for that reason).
5. **Always allowed native tools are an engine level exemption, not a policy level one.** `local-policy.ts` evaluates statements only; a `*` forbid statement does forbid `todowrite` there. Phase 4's engine consults `isAlwaysAllowedNativeTool` before it runs any layer. Why: keeps `evaluateLocalPolicy` a pure function of (policy, name) that a user can reason about. Runner up: bake the exemption into `evaluateLocalPolicy` (rejected, hidden exceptions inside a policy evaluator surprise users).
6. **Hand rolled validation, no schema library.** Matches `intent-schema.ts` and keeps modules dependency free. Runner up: zod (rejected, new dependency in a plugin bundle for ~40 lines of checks).
7. **No `readActivePolicy` convenience.** Only `loadActivePolicy`, which returns a three state result. Why: a `PolicyProfile | null` return cannot distinguish "no policy" from "corrupt policy", and that distinction is the whole fail closed fix. Runner up: keep both and document "display only" (rejected, one careless call in the engine recreates the bug).

**Implementation skills**: none installed apply (no `## Agent skills` section exists in `AGENTS.md`; the repo has no `AGENTS.md`). Bun test conventions follow the existing `test/*.test.ts` files.

## Cross child contract

**Module graph** (arrows are imports; `import type` is erased at build time):

```
tool-name-map.ts   : no imports
local-policy.ts    -> tool-name-map.ts   (value)          + node:fs, node:path
backend-client.ts  -> tool-name-map.ts   (value)
                   -> config.ts          (value: authHeaders; type: ArmorConfig)
                   -> local-policy.ts    (type only: PolicyProfile, PolicyStatement)
```

- Cross module imports use the `.ts` specifier, as `planner.ts` does (`from "./intent-schema.ts"`). Types use `import type`, required by `verbatimModuleSyntax`.
- `local-policy.ts` and `tool-name-map.ts` take `dataDir: string` and never import `config.ts`, exactly like `planner.ts` and `pending.ts`. Only `backend-client.ts` imports `config.ts`, and only for `authHeaders` and the `ArmorConfig` type.
- None of the three imports `intent-schema.ts`, `planner.ts`, `pending.ts`, or `policy-yaml.ts` from `src/`. `intent-schema.ts` appears only in a test (3a, AC-A4), which cross checks that every tool the model is told to plan is classified.
- `PolicyProfile` and `PolicyStatement` are defined in `local-policy.ts` (3a) and imported as types by 3b. `pending.ts` and `policy-yaml.ts` stay generic and are not touched; Phase 5 may later tighten their types.
- `scripts/install.ts` exports `MCP_SERVER_NAME`. `tool-name-map.ts` must NOT import it (`src/` must not depend on `scripts/`, the installer pulls in file merging code the plugin bundle must not carry). Instead 3a has a test that imports both and asserts the two constants are equal, so they cannot drift.

**Fail closed contract** (the rule every child follows; AC-X2):

| Situation | Outcome |
|---|---|
| No `policy.json` on disk | No local policy, evaluation skipped (backend still consulted). This is the only "absent" case. |
| `policy.json` unreadable, unparseable, or wrong shape | `loadActivePolicy` returns `invalid`; the Phase 4 engine denies every tool call with the error text. |
| Statement with an unknown `effect` | Treated as `forbid` when it matches. |
| Unknown `defaults.conflictResolution` | Treated as `deny_overrides`. |
| Plugin not configured (`isConfigured` false) | `verifyStep` and `sendAudit` return without any network call; `verifyStep` denies. |
| HTTP 401 or 403 | Deny, `fatal: true`. |
| HTTP 400 | Deny (ArmorGemini failed open here, see divergence 4). |
| Any other non 2xx, network error, timeout | Deny, `fatal: false`. |
| 2xx with a body that is not an object, or `allowed` not strictly boolean true | Deny. |
| Unknown tool name | Passed through unmapped; never throws. |

**Divergences from ArmorGemini (each has a test that pins it):**

| # | ArmorGemini behavior | This port | Why |
|---|---|---|---|
| 1 | Corrupt `policy.json` read as "no policy" (fails open) | `invalid` result, engine denies | A corrupted file silently disabled every local deny rule |
| 2 | Unknown `effect` ignored; unknown `conflictResolution` meant permit wins | forbid; deny wins | Typos must not weaken a policy |
| 3 | 200 response with empty or garbage body allowed the call | Deny | A proxy or captive portal page must not grant access |
| 4 | HTTP 400 allowed the call as "monitor" | Deny with the backend message in the reason | A payload that triggers 400 would bypass org policy; drift becomes loud instead of silent. Open question 2. |
| 5 | Plain object lookups (`MAP[name]`) | `Map` lookups | `MAP["constructor"]` returned a function and crashed or mis-evaluated |
| 6 | `saveActivePolicy` wrote anything, in place | Validates, writes a temp file, renames | A torn write now blocks every tool call, so atomicity matters more |
| 7 | `entry` could override `source` in audit | `source` always last | Audit provenance must not be caller controlled |
| 8 | Deprecated `proposePolicyChange`, `proposePolicyTemplate` | Not ported | No new caller needs them |

## Build plan

Branch strategy: Phase 2 PRs are not merged yet, so work branches from `phase-3-planning` (which already contains all four Phase 2 branches). When the real Phase 2 PRs land on `dev`, rebase each Phase 3 branch with `git rebase --onto dev phase-3-planning <branch>` so its PR diff holds only Phase 3 files.

1. **PR 3a** (`phase-3a-local-policy`): the child spec [0001](0001-tool-name-map-and-local-policy.md). Satisfies AC-X1, AC-X2, AC-X3, AC-X4, AC-X5 for its two modules, plus AC-A1 to AC-A8.
2. **PR 3b** (`phase-3b-backend-client`, branched from 3a's branch, PR targets `dev` after 3a merges or targets the 3a branch while stacked): the child spec [0002](0002-backend-client.md). Satisfies AC-X2, AC-X3, AC-X4 for `backend-client.ts`, plus AC-B1 to AC-B9.
3. **The spec files themselves** (`docs/specs/`) go in their own small docs PR (about 500 lines). Do NOT fold them into 3a or 3b: they would eat half the 1,000 line budget.

### Implementation handoff (read this first, implementer)

Do PR 3a to completion, then PR 3b. For EACH of the two PRs, run these four skills in this order, and do not start the next PR until the current one is clean:

1. **`/develop`**: build the child spec. Read the child spec and this index first. If anything load bearing is undecided, STOP and run `/architect` for it; do not invent it. Write tests as you go (red, then green) following the test plan in the child spec.
2. **`/test`**: after `/develop`, run `/test` on the uncommitted changes to fill coverage gaps (hostile inputs, every row of the fail closed table). Read `test/*.test.ts` for conventions: `bun:test`, inline test data, `mkdtempSync` scratch dirs under `os.tmpdir()`, cleanup in `afterEach`. Framework is already decided: `bun:test`.
3. **`/check verify`**: prove each acceptance criterion against the real code. Run `export PATH=$HOME/.bun/bin:$PATH && bun install --frozen-lockfile && bun test && bunx tsc --noEmit -p tsconfig.json`, then the bundle smoke: `bun build src/local-policy.ts src/backend-client.ts --target node --outdir "$(mktemp -d)"` (3a: only `src/local-policy.ts`). Confirm `git diff --stat dev...HEAD` is under 1,000 lines.
4. **`/check review`**: a fresh model reviews the diff. Fix everything it finds that is real, rerun `/check verify`, and only then commit. For mutation evidence (a lesson recorded in project memory): for each fail closed test, revert the fix and show the test fails.

Commit style: conventional commits, focused commits, trailer lines as the session configuration requires. Do not push or open PRs until the human says so (this is a local first project; the human merges PRs).

If a PR passes 900 lines before it is done, stop and report with `ao report --needs-input`. Pre approved seams: 3a splits at `tool-name-map` vs `local-policy`; 3b splits at (transport, `verifyStep`, `sendAudit`, `fetchPolicy`) vs (builders, templates, `pushProposal`). Do not split silently.

## Consequences

**Positive**:
- The first run deadlock is closed and test pinned before Phase 4 starts.
- Local policy and backend failures cannot quietly turn into allows.
- One tool name table means a new opencode tool is added in exactly one place.

**Negative / tradeoffs**:
- A corrupt or hand edited `policy.json` now stops all tool calls until fixed. That is the intended failure mode, and the deny reason must name the file and the problem.
- Denying on HTTP 400 means a backend contract change (for example rejecting the new `source` value) blocks every session until fixed, instead of degrading to monitor mode.
- Always allowed tools (`todowrite`, `todoread`, `lsp`, `skill`, `question`) bypass every layer in the engine, including a `lockdown` template. An opencode custom tool or plugin that reuses one of these names inherits the exemption.
- The ArmorGemini behavior is no longer byte for byte reproducible; the eight divergences must be remembered when comparing against the port source.

**Neutral**:
- `fetchPolicy` has no caller in ArmorGemini's CLI (dead code there). It is ported because PLAN.md lists the endpoint; it is the first thing to cut if a PR runs over budget.
- `apply_patch` is bucketed under `Edit` (backend has no patch tool). A policy forbidding `Edit` therefore also blocks `apply_patch`, which is what a user expects.

## Follow-up

Open questions for the human (also in the final report):

- [ ] **Q1. Backend tool name on `/iap/enforce`.** ArmorGemini sent the raw name (`run_shell_command`). This spec sends the mapped backend name (`Bash`) for enforce and keeps the raw opencode name in audit records. Needs one live check with a real API key that `tool_name: "Bash"` matches a `Bash` forbid. If the backend actually matches raw names, flip one call site in `verifyStep`.
- [ ] **Q2. HTTP 400 behavior.** This spec denies; ArmorGemini allowed. Confirm the human wants fail closed here, knowing it fails loudly if the backend rejects the new `source`/`principal.id` values.
- [ ] **Q3. New identifiers the backend may validate.** `source: "armoropencode"` (enforce and audit) and `principal.id: "opencode"` (policy statements) are new values. Does the backend whitelist them? If so they must be registered before Phase 6.
- [ ] **Q4. Hyphenated MCP server name.** Research confirmed only `everything_echo`. The matcher assumes opencode keeps hyphens, giving `armor-opencode-policy_register_intent_plan`. Confirm in `~/iq/aoc-playground` with the real server registered; Phase 6 E2E must assert first run registration works.
- [ ] **Q5. Overriding PLAN.md's duplicate tool map.** Decision 2 drops the duplicate copy. OK?
- [ ] **Q6. Unconfirmed tool names** (`todoread`, `apply_patch`, `lsp`, `question`, `skill`; also real opencode tools `list`, `patch`, `multiedit`, `task` not in the research notes). Unclassified names fall through to drift check plus backend, which can produce a false deny. Worth one more live verification before Phase 6.
- [ ] **Q7. Matcher home.** Phase 4's `src/is-armor-tool.ts` becomes unnecessary (or a one line re-export). PLAN.md should be updated.
- [ ] **Q8. `docs/specs/` placement.** These specs are committable (unlike `internal/`) but the repo is public. Confirm you want the design rationale public, otherwise keep them out of PRs.

## Rationale

Reasoning, options considered, and references: see [rationale.md](rationale.md).
