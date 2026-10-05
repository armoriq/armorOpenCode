# Scope: ArmorOpenCode

A TypeScript port of ArmorGemini's policy enforcement to opencode: a plugin that checks every tool call against your ArmorIQ policy and blocks drift from the plan, plus an installer, an MCP server and `/armor/*` commands. It is for developers who run opencode and want enforcement they can trust.

**Build approach:** Tracer Bullet (prove the whole pipe works first: a real plugin loaded by a real opencode that blocks one real call, then thicken one segment at a time).
**Workflow:** GA (after `/develop`: `/check verify`, then `/test`, then a fresh model `/check review`, then `/document`). This is a security product, so a silent bypass is the worst bug. Any feature can carry its own tag to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| A | Research spike and repo skeleton | Foundation | existing |
| B | Installer scripts | Foundation | existing |
| C | CI (typecheck, pinned Bun) | Foundation | existing |
| 1 | Merge the Phase 2 libraries | Foundation | in-progress |
| 2 | Coding standards and tooling | Foundation | planned |
| 3 | Tool name map and local policy (PR 3a) | Foundation | in-progress |
| 4 | Bundled build output | Foundation | planned |
| 5 | Walking skeleton: plugin enforces local policy | Slice 1 | planned |
| 6 | Backend client (PR 3b) | Slice 2 | planned |
| 7 | Intent plan drift enforcement | Slice 3 | planned |
| 8 | MCP policy server (PR 5a) | Slice 4 | planned |
| 9 | CLI and `/armor/*` commands (PR 5b) | Slice 5 | planned |
| 10 | Wire together and real E2E | Slice 6 | planned |

## Already built

### A. Research spike and repo skeleton · existing
Confirmed opencode's real plugin field, tool names, hook behavior and command syntax. Findings in `internal/research-notes.md` (not committed).

### B. Installer scripts · existing
Idempotent `opencode.json` and `AGENTS.md` merge, uninstall, error handling. code in `scripts/install.ts`

### C. CI (typecheck, pinned Bun) · existing
Typecheck step, pinned Bun, least privilege token. code in `.github/`

## Foundations

### 1. Merge the Phase 2 libraries · in-progress
Config resolver, intent schema, policy YAML printer, plan store and pending store are written but sit in four open PRs. Phase 3 branches stack on them.
**Done when:** PRs #5, #6, #7, #8 are merged in that order into the integration branch and `bun test` is green on it.
- [ ] Merge in order and re-run tests: `/develop merge phase 2 PRs`
code in `src/config.ts`, `src/intent-schema.ts`, `src/policy-yaml.ts`, `src/planner.ts`, `src/pending.ts`

### 2. Coding standards and tooling
There is no root `AGENTS.md` yet. Capture the conventions the code already follows (`.ts` import specifiers, snake_case on disk, fail closed) so later sessions share them.
**Done when:** root `AGENTS.md` reflects the real stack and conventions, and typecheck and tests run clean.
- [ ] Capture conventions: `/audit`

### 3. Tool name map and local policy (PR 3a) · in-progress
The single opencode to backend tool name table, the always allowed set, the plan tool matcher that avoids the first run deadlock, and the local `policy.json` store and evaluator, all failing closed.
**Done when:** the three plan tools are recognized by their full names, and a corrupt or unknown policy state denies instead of allowing. 307 tests pass.
- [x] Design it (spec): `/architect tool name map and local policy`
- [x] Build it: `/develop tool name map and local policy`
   - [x] Tool name map and plan tool matcher (AC-A1 to A4)
   - [x] Policy validation and atomic storage (AC-A5, A6)
   - [x] Evaluator with pinned reasons (AC-A7 to A9)
- [x] Verify it: `/check verify tool name map and local policy`
- [x] Test it: `/test tool name map and local policy`
- [x] Review it: `/check review` (Opus: changes requested, see docs/reviews/)
- [x] Document it: `/document pr`
Spec 0001 (child 0001) · code in `src/tool-name-map.ts`, `src/local-policy.ts`

### 4. Bundled build output · needs a decision
`tsc` cannot emit with the `.ts` import specifiers (TS5096), so the plugin needs a bundler. Decide the bundler, output path and `package.json` exports, because the installer points at that output.
**Done when:** one command produces the plugin bundle that opencode can load, and the installer's placeholder path matches it.
- [ ] Design it (spec): `/architect bundled build output`

## Slice 1: Walking skeleton

### 5. Walking skeleton: plugin enforces local policy · needs a decision
The thinnest real thread: a plugin loaded by a real opencode, `tool.execute.before` reads the local policy and throws to deny, fails open on an internal bug, and the product can report whether enforcement is active. No backend, no plan, no MCP yet.
**Done when:** in a scratch opencode project, a forbidden tool call is blocked with the policy message, an allowed call runs, a corrupt `policy.json` denies, and a liveness check says whether the plugin loaded.
- [ ] Design it (spec): `/architect walking skeleton plugin`

## Slice 2: Backend enforcement

### 6. Backend client (PR 3b)
The ArmorIQ backend client with a failure matrix, policy builders and templates. Its spec is already captured.
**Done when:** every failed or malformed backend response yields a deny, and policies built here round trip through the local store.
- [x] Design it (spec): `/architect backend client`
- [ ] Build it: `/develop backend client`
   - [ ] Request contract and failure matrix
   - [ ] Policy builders and templates
   - [ ] Round trip with the local store (AC-B9)
- [ ] Verify it: `/check verify backend client`
- [ ] Test it: `/test backend client`
- [ ] Review it: `/check review`
- [ ] Document it: `/document pr`
Spec 0001 (child 0002)

## Slice 3: Intent drift

### 7. Intent plan drift enforcement · needs a decision
Thicken the engine: register a plan, then deny tool calls that were not declared in it. The plan tools themselves are exempt so the first run cannot deadlock.
**Done when:** with no plan and `intentRequired` true, registering a plan works; an undeclared tool is denied; a declared one is allowed and audited.
- [ ] Design it (spec): `/architect intent plan drift enforcement`

## Slice 4: MCP server

### 8. MCP policy server (PR 5a) · needs a decision
The stdio MCP server exposing the three plan tools under `armor-opencode-policy`, plus the `armor-opencode-mcp` bin entry.
**Done when:** a real opencode session lists and calls the three tools, and smoke tests cover each.
- [ ] Design it (spec): `/architect MCP policy server`

## Slice 5: Commands

### 9. CLI and `/armor/*` commands (PR 5b) · needs a decision
The stage, list, yes, no and template logic and the six command files, namespaced with `/` as Phase 0 confirmed.
**Done when:** each of the six commands runs from a real opencode session and `/armor/yes` is the only confirmation that activates a policy.
- [ ] Design it (spec): `/architect CLI and armor commands`

## Slice 6: Ship it

### 10. Wire together and real E2E · GA
Point the installer at the real build, write `ARMOROPENCODE.md`, and run the full manual pass against a real opencode install. This is the acceptance gate for v0.1.
**Done when:** deny, allow and audit work; `session.created`, `idle` and `deleted` fire; all six commands work; `bun test` is green in CI.
- [ ] Build it: `/develop wire together and E2E`
- [ ] Verify it: `/check verify wire together and E2E`
- [ ] Test it: `/test wire together and E2E`
- [ ] Review it: `/check review`
- [ ] Document it: `/document release-note`

## Deferred
Out of scope until v0.1 is proven working end to end.
- **npm publish of `@armoriq/armoropencode`** · needs a decision
- **GitHub release and `awesome-opencode` listing**
- **Bonus hooks** (`permission.asked`, `permission.replied`, `command.executed`) · needs a decision
- **opencode V2 `context` per turn hook**, to replace the `AGENTS.md` injection fallback once V2 leaves beta · needs a decision

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | `/architect` at spec capture | `Design it` ticked; spec linked; `Build it` with 2 to 5 milestones; the tier's closing boxes |
| `in-progress` (building) | `/develop` | milestone boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` ticked; `Verify it` ticked |
| `done` | you, when you decide it is | boxes you ran ticked, skipped ones marked skipped |

- **Next step** is the first unticked box.
- **Status** goes `planned`, `in-progress`, `done`, plus `existing` (before the workflow) and `dropped` (kept for history).
- **Workflow** is the project default. GA runs `/check verify`, `/test`, a fresh model `/check review`, then `/document`.
