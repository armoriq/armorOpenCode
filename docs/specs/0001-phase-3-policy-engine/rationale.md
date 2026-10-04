# 0001. Phase 3 policy engine and backend client: rationale

Decision record for [index.md](index.md). The build specs do not need this file.

## Context

ArmorOpenCode enforces policy on an AI coding agent's tool calls. Phase 2 ported the stores and schemas. Phase 3 ports the pieces that decide "allow or deny": a tool name map, a local policy evaluator, and the backend client. Phase 4 then wires them into opencode's `tool.execute.before` hook, where a thrown error blocks the call and any internal bug fails open by design (`internal/MEMORY.md`, ArmorGemini's router).

That last point shapes everything here. The adapter already fails open on unexpected exceptions, so these libraries are the last place where a mistake can be caught. If a library quietly returns "allow" for a corrupt file or a garbled response, nothing downstream notices. opencode also silently ignores a plugin that fails to load (`internal/MEMORY.md`, "Critical platform finding"), so the product has no safety net outside its own code.

Two PLAN.md warnings apply directly: the first run deadlock (the plan registration tool is itself an undeclared tool, so it needs an exemption written for opencode's `<server>_<tool>` naming and the hyphenated server name), and the bundler only build constraint (value imports with `.ts` specifiers appear for the first time in Phase 3, so the modules must bundle cleanly with `bun build`).

The 1,000 line per PR limit applies. The plan already splits Phase 3 into 3a and 3b.

Facts used from the port source, verified by reading it: `local-policy.mjs` returns `null` from `readActivePolicy` on both a missing and a corrupt file; its evaluator ignores statements with an unrecognized `effect` and treats any `conflictResolution` other than `deny_overrides` as permit wins; `backend-client.mjs` allows the call when a 200 body is empty, and allows it on HTTP 400 as "monitor"; both modules index a plain object by a model controlled tool name, so `constructor` returns a function; `fetchPolicy` has no caller in the ArmorGemini CLI.

## Options considered

### Option 1: Mechanical port

Convert `.mjs` to `.ts` with types and `bun:test`, keep every behavior including the duplicate tool map and the fail open paths.

**Pros**:
- Smallest review: reviewers diff against ArmorGemini line by line.
- Behavior matches the product that already ships on Gemini.

**Cons**:
- Carries four fail open bugs into a security product, and the plan's own warning proves a mechanical port of the plan tool matcher bricks first run.
- Needs a Phase 4 or later cleanup, by which time more code depends on the old behavior.

### Option 2: Faithful port with fail closed fixes and a single tool name map (chosen)

Same API shape and logic, but every place that could silently allow now denies or returns an explicit invalid state, lookups are prototype safe, and the map exists once.

**Pros**:
- Closes the bypasses while the code is cheap to change, before the engine depends on it.
- Each divergence is small and pinned by a test, so reviewers can still read it against the original.
- The three state `loadActivePolicy` result makes the safe usage the only easy usage.

**Cons**:
- Eight behavior differences from ArmorGemini to remember.
- Slightly more code and tests, so the PRs sit near 850 lines instead of about 600.
- Denying on HTTP 400 can block sessions on backend contract drift (mitigated by a loud, specific deny reason).

### Option 3: Redesign around a shared decision type

Define one `Decision` union used by local policy, backend client, and engine, and have both layers return it, so fail closed is enforced by types across the whole stack.

**Pros**:
- Strongest guarantee, one shape for the engine to consume.

**Cons**:
- Forces Phase 4's design into Phase 3 before the adapter exists; the engine port (`engine.mjs`) is where decisions get composed, and its needs are not known yet.
- Breaks the one to one mapping with ArmorGemini that makes the port reviewable, and the 1,000 line limit leaves no room for rework.

## Rationale

Option 2. The deciding constraint is that the adapter fails open on internal errors, so correctness of the verdict functions is the security boundary, not a detail. The fixes are cheap now (a few conditionals and a `Map`) and expensive later (every caller written against `readActivePolicy` returning `null`).

Each divergence follows one rule: when the code cannot positively establish "allowed", the answer is deny. For the local policy file that means a corrupt file stops the session loudly rather than quietly turning off every local deny rule. For the backend response it means a proxy error page or an empty body cannot grant access. For lookups it means a model supplied name like `constructor` cannot crash the evaluator (which the adapter would then convert to an allow).

The HTTP 400 choice is the closest call. ArmorGemini chose "monitor" so contract drift would not wedge sessions, and that is a reasonable product trade. It is not reasonable as a default for a deny layer: any request the backend rejects with 400 (for example an unusual `tool_input`) would skip org wide policy, and local policy is not a substitute for org wide rules. Failing closed with the backend's message in the reason keeps drift visible and recoverable. This is the decision most worth the human's review (index Q2).

Dropping the duplicate tool map goes against a line in PLAN.md, but its stated reason (zero dependency loading) belonged to ArmorGemini's one process per hook invocation, where load time mattered. In a bundled plugin both modules are already in memory, and two tables that must agree is a drift risk with no benefit. The matcher for plan tools sits in the same file for the same reason: it is a pure table lookup, it belongs with the other table, and putting it in Phase 3 means the deadlock test exists before the riskiest phase begins.

Always allowed tools are exempted in the engine and not inside `evaluateLocalPolicy`, because a policy evaluator that has hidden built in exceptions makes `lockdown` hard to reason about; the cost (a `lockdown` that still lets `todowrite` through) is documented and small.

Considered and rejected for the design itself: a schema library for validation (new dependency in a plugin bundle for about 40 lines of checks, and `intent-schema.ts` already sets the hand rolled precedent), mocking the filesystem for the atomic write test (brittle in `bun:test`; asserting no temp file remains and the old file survives a refused save covers the observable behavior), and keeping `readActivePolicy` as a convenience (one careless call recreates the bug).

## References

**Project sources** (verifiable, in this repo or the local checkout):
- `internal/PLAN.md`, Phase 3 section, including the first run deadlock and bundler only warnings (internal, not committed)
- `internal/MEMORY.md`, "Critical platform finding", "Verified filesystem behavior", the 1,000 line PR limit, and the mutation testing lesson (internal, not committed)
- `internal/research-notes.md`, sections 3 and 4 and the summary table: confirmed tool names, MCP name format `<server>_<tool>`, throw to deny (internal, not committed)
- `~/iq/armorGemini/scripts/lib/local-policy.mjs`, `backend-client.mjs`, `engine.mjs` (lines 155 to 183 for the plan tool exemption), and `tests/local-policy.test.mjs`
- Phase 2 code on this branch: `src/config.ts` (`authHeaders`, `ArmorConfig`), `src/intent-schema.ts` (`INTENT_PLAN_FORMAT`, hand rolled validation precedent), `src/planner.ts` and `src/pending.ts` (store and fail closed conventions), `scripts/install.ts` (`MCP_SERVER_NAME`)

**Practices & standards**:
- Fail closed (deny by default) for authorization decisions
- Write to a temporary file and rename for atomic replacement
- Treat all external data (files, HTTP bodies, tool names) as untrusted and validate at the boundary
