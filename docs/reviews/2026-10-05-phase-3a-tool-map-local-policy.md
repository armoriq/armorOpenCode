# Review, phase-3a-tool-map-local-policy, 2026-10-05

**Reviewed by**: claude-opus-5-5 (author on unknown, likely same family)
**Scope**: 4 files, uncommitted
**Verdict**: Changes requested

## Summary
Adds `src/tool-name-map.ts` and `src/local-policy.ts` plus tests. It is a close, faithful match to spec 0001 (mapping table, exact set plan tool matcher, three state load, the fail closed effect and conflict rules, and the pinned reason strings). Two problems remain. `evaluateLocalPolicy` returns allow for a structurally malformed policy object, which contradicts its own header comment and AC-X2. Also, the "never throws" promise (AC-X3) breaks for some non string tool names; both cases were reproduced.

## Major
### 🟠 Malformed policy objects evaluate to allow (fail open), `src/local-policy.ts:244-262`
**Problem**: Only a non object policy is denied. An array (`evaluateLocalPolicy([], "bash")`), `{}` with no statements, or a policy whose `defaults.decision` is anything other than exactly `"deny"` (for example `"DENY"` or a typo) all return `allow` with `Local policy default (allow)`. Both reproduced. The file header (line 12) says "a malformed policy object denies", so the code and the comment disagree.
**Why it matters**: AC-X2 says any path that cannot positively establish allow must deny. The spec's rules 1, 3 and 6 do sanction this behavior, relying on `validatePolicyProfile` having run first. But `evaluateLocalPolicy` is exported and typed to accept any `PolicyProfile`. A Phase 4 caller that builds or merges a policy without revalidating gets a silent allow for everything. This is the same class of bug as divergence 1.
**Suggested fix**: At the top of `evaluateLocalPolicy`, run `validatePolicyProfile` on any non null policy and deny with `Local policy is malformed: <error>` when it fails. Validation is cheap, and it covers arrays, missing or non array statements, and bad `defaults`. Record the deviation in the spec, or ask the spec owner first, since rules 3 and 6 state the lenient behavior. At minimum, fix the header comment.

## Minor
### 🟡 Throws on some non string tool names (AC-X3), `src/local-policy.ts:249,271` and `src/tool-name-map.ts:94`
**Problem**: `evaluateLocalPolicy(lockdown, Symbol())` throws `Cannot convert a symbol to a string` when it builds the reason template (`String(sym)` works, but a template literal does not). `evaluateLocalPolicy(p, Object.create(null))` and `toBackendToolName(Object.create(null))` throw `No default value` from `String(...)`. Same for an `action.eq` or `id` built from a null prototype object, which only happens on the unvalidated path. The verify pass fixed only the `.trim` crash.
**Why it matters**: The name comes from external hook data (the code comment says so). A throw in `tool.execute.before` behaves however the engine handles exceptions, and that might not be a deny.
**Suggested fix**: Add a safe stringify helper (`typeof x === "string" ? x : try String(x) catch "<unprintable>"`) and use it for the tool name in both modules and in the reason. Even simpler: when `toolName` is not a string, return a deny from `evaluateLocalPolicy`. Add tests for Symbol and null prototype inputs.

### 🟡 Temp file name collides for concurrent saves in one process, `src/local-policy.ts:150`
**Problem**: `${target}.${process.pid}.tmp` is the same for two overlapping saves in the same process. Writes are sync, so this is safe today. A later async refactor would race. There is also no fsync before the rename, so a power loss can leave an empty `policy.json`. That file would then load as `invalid`, which fails closed, so the risk is low.
**Suggested fix**: Add a random suffix (`crypto.randomUUID()`) or a counter. fsync is optional.

## Nits
- ⚪ `src/local-policy.ts:205`, `hasActivePolicy` is a "display only" helper, which Decision 7 rejects in spirit. The spec requires it, so keep it, but consider not exporting it until a caller needs it.
- ⚪ `src/local-policy.ts:265`, `winner.effect === "permit"` is redundant: `matchedPermit` can only be a permit statement.

## Strengths
- `Map` and `Set` lookups with exact membership in `isArmorPolicyTool` make the prototype key and lookalike name cases correct by construction.
- `loadActivePolicy` gets the three state contract right: no existsSync race, ENOENT is the only path to `none`, and every error names the file.

## Test coverage
Coverage is thorough against the spec's test plan: every AC-A6 error string, every AC-A5 invalid source, reason strings pinned exactly, and the fail closed effect and conflict cases. Gaps: no test for an array policy, a policy object without statements, or a bad `defaults.decision` passed straight to `evaluateLocalPolicy`. No test for Symbol or null prototype tool names. These are the inputs behind both findings above.
