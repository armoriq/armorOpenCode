# 0002. PR 3b: backend client

Child of [0001 Phase 3 policy engine and backend client](index.md). Read the umbrella `index.md` first. Depends on PR 3a ([0001](0001-tool-name-map-and-local-policy.md)): needs `toBackendToolName` and the `PolicyProfile` type.

## Summary

Adds `src/backend-client.ts`: the HTTP client for the ArmorIQ backend (`/iap/enforce`, `/iap/audit`, `/policies/profiles/active`, `/draft`, `/propose`) plus the builders for single rule policies and the three named templates. Every failure path returns a deny or a failed result; none throws and none grants access. Target size: about 330 source lines, about 550 test lines, under 1,000 total.

## Scope

In: `src/backend-client.ts` and `test/backend-client.test.ts`.
Out: the engine, retries or caching, any `/policies/profiles/confirm` call (JWT only, dashboard side, never called from plugin code), the deprecated `proposePolicyChange` and `proposePolicyTemplate`, and any change to existing files.

## Requirements

**Acceptance criteria**:

- **AC-B1** (enforce request): `verifyStep` sends `POST <backendEndpoint>/iap/enforce` with headers from `authHeaders(config)` (Bearer key, `X-ArmorIQ-Client`, JSON content type and accept), `redirect: "error"`, an `AbortSignal`, and a JSON body of exactly `{ source: "armoropencode", session_id, tool_name, tool_input, description, org_id }`, where `tool_name` is `toBackendToolName(toolName)`, `description` and `org_id` are omitted from the JSON when undefined or empty, and `tool_input` is passed through unchanged.
- **AC-B2** (verdicts): a 2xx response whose body is an object with `allowed === true` and `action !== "deny"` returns `{ allowed: true }` with `verdict` equal to `action` when it is a string, else `"allow"`, `reason` equal to `reason` when a string else `""`, and `matchedPolicy` equal to `matched_policy` when an object else `null`. Any other 2xx body returns `{ allowed: false }`: `allowed: false`; `action: "deny"` (even with `allowed: true`); `allowed` missing or non boolean; body not an object (`null`, array, string, unparseable, empty). A deny from the backend carries the backend `reason`, or `Denied by ArmorIQ policy` when it is empty.
- **AC-B3** (failure matrix): not configured returns deny with no `fetch` call; 401 and 403 return deny with `fatal: true` and reason `ArmorIQ API key invalid or lacks permission`; 400 returns deny with `fatal: false` and a reason containing `HTTP 400` and the backend `message` when present; any other non 2xx (404, 429, 500, 503) returns deny, `fatal: false`, reason `ArmorIQ backend unavailable (HTTP <status>). Fail-closed policy applies.`; a network error, an aborted request after `timeoutMs`, and a redirect response each return deny with `HTTP network` in the reason. `verifyStep` never throws.
- **AC-B4** (audit): `sendAudit` sends `POST /iap/audit` with `{ ...entry, source: "armoropencode" }` (the entry cannot override `source`); returns `{ ok, status }`; returns `{ ok: false, status: 0 }` on a network error, timeout, or when not configured (no `fetch` call); never throws.
- **AC-B5** (fetch policy): `fetchPolicy` sends `GET /policies/profiles/active` with no body. On a 2xx with a `policy` object it returns `{ ok: true, policy: { name, description, defaultDecision, rules } }` with defaults `"current"`, `""`, `"allow"`, and `rules` mapped from `statements` as `{ id, verb: effect, target: action, note: description }` (tolerating a non array or missing `statements` as empty and non object statements skipped). On non 2xx, or a 2xx body with no `policy` object, it returns `{ ok: false, status, error? }`. Never throws.
- **AC-B6** (builders): `buildPolicyForRule({ verb, target, note })` returns a single statement `PolicyProfile` per the shape below; `verb` maps `allow` to `permit` and `deny` and `hold` to `forbid`, and an unknown verb at runtime maps to `forbid`; `target` is mapped with `toBackendToolName`. `buildPolicyForTemplate` returns a fresh `PolicyProfile` for `lockdown`, `strict-read-only`, `balanced`, and `null` for anything else including `constructor` and `__proto__`. `listTemplateNames()` returns the three names. Every policy any builder returns passes `validatePolicyProfile` from 3a.
- **AC-B7** (push): `pushProposal` calls `PUT /policies/profiles/draft` with `{ policy, orgId }` then, only if that succeeded, `POST /policies/profiles/propose` with `{ reason, orgId }` (default reason `Proposed via ArmorOpenCode /armor`). Returns `{ ok: true, proposal }`, or `{ ok: false, stage, status, error }` where `stage` is `"config"` (not configured, nothing sent), `"draft"`, or `"propose"`. Backend `message` as a string or an array of strings becomes `error` (array joined with `"; "`). Propose is never sent when draft failed.
- **AC-B8** (no secret leakage): in every failure case the API key does not appear anywhere in the returned value or in any error message produced by this module.
- **AC-B9** (bridge to 3a): a policy built by `buildPolicyForRule` and by each template survives `saveActivePolicy`, `loadActivePolicy`, and `evaluateLocalPolicy` with the expected decisions (see test plan). This is the test that was in ArmorGemini's `local-policy.test.mjs`; it lives here because 3a cannot import this module.

## Design

### `src/backend-client.ts` (about 330 lines)

Imports:

```ts
import { authHeaders, type ArmorConfig } from "./config.ts";
import type { PolicyProfile, PolicyStatement } from "./local-policy.ts";
import { toBackendToolName } from "./tool-name-map.ts";
```

(`type` modifier inline or a separate `import type`, whichever the existing files use; `verbatimModuleSyntax` requires the erasure to be explicit.)

```ts
/** Only the config fields this module reads, so callers can pass a full ArmorConfig or a literal. */
export type BackendConfig = Pick<
  ArmorConfig,
  "apiKey" | "backendEndpoint" | "timeoutMs" | "orgId" | "isConfigured"
>;

export interface VerifyStepInput {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  description?: string;
}

export type Verdict = "allow" | "deny" | "monitor" | "unavailable" | "auth" | (string & {});

/** Every field is always present, so a caller cannot forget a null check and fail open. */
export interface VerifyStepResult {
  allowed: boolean;
  reason: string;
  /** Backend `action` string, or a module generated label for failures. */
  verdict: string;
  /** True only for 401/403: the key is invalid, retrying cannot help. */
  fatal: boolean;
  matchedPolicy: Record<string, unknown> | null;
}

export interface AuditEntry {
  event: string;
  at: string;
  session_id: string;
  tool_name: string;
  tool_input?: unknown;
  result_summary?: string;
  [key: string]: unknown;
}

export interface SendAuditResult { ok: boolean; status: number }

export type FetchPolicyResult =
  | { ok: true; policy: { name: string; description: string; defaultDecision: string;
        rules: Array<{ id: string; verb: string; target: string; note: string }> } }
  | { ok: false; status: number; error?: string };

export type PolicyVerb = "allow" | "deny" | "hold";
export interface RuleInput { verb: PolicyVerb; target: string; note?: string }
export type TemplateName = "lockdown" | "strict-read-only" | "balanced";

export type PushProposalResult =
  | { ok: true; proposal: unknown }
  | { ok: false; stage: "config" | "draft" | "propose"; status: number; error: string | undefined };

export function verifyStep(config: BackendConfig, input: VerifyStepInput): Promise<VerifyStepResult>;
export function sendAudit(config: BackendConfig, entry: AuditEntry): Promise<SendAuditResult>;
export function fetchPolicy(config: BackendConfig): Promise<FetchPolicyResult>;
export function buildPolicyForRule(rule: RuleInput): PolicyProfile;
export function listTemplateNames(): TemplateName[];
export function buildPolicyForTemplate(name: string): PolicyProfile | null;
export function pushProposal(config: BackendConfig, policy: PolicyProfile, reason?: string): Promise<PushProposalResult>;
```

Constants (exported so Phase 4 and tests share them): `POLICY_SCHEMA_VERSION = "armor.policy.v1"`, `SOURCE = "armoropencode"`, `PRINCIPAL_ID = "opencode"` (index Q3).

**Transport** (private `jsonRequest(config, method, path, body?)`): ports the original. `AbortController` with `setTimeout(() => controller.abort(), config.timeoutMs)`, cleared in `finally`; the timer must cover reading the body (`res.json()` happens inside the same `try`, with `.catch(() => null)`). Reads `globalThis.fetch` at call time (not captured at import) so tests can replace it. Adds `redirect: "error"` (a redirect would otherwise re-send the Bearer key to wherever the response points; runner up `"manual"`, rejected as a redirect is never legitimate for these exact endpoints). Returns `{ ok, status, data }` or, on any thrown error, `{ ok: false, status: 0, error: String(err?.message ?? err) }`. Never includes request headers in any returned string.

**`verifyStep`**:
1. `!config.isConfigured` returns deny (`verdict: "unavailable"`, `fatal: false`, reason `ArmorIQ is not configured (missing ARMORIQ_API_KEY). Fail-closed policy applies.`) with no `fetch`.
2. Request per AC-B1. This is the load bearing place for index Q1: pass `toBackendToolName(toolName)` here and nowhere else; the one line to flip is `tool_name:`.
3. Map the response per the table in the index and AC-B2, AC-B3, in this order: `status === 401 || 403`, then `status === 400`, then `!ok`, then body checks. The 400 branch includes the backend message (string or joined array) in the reason, trimmed to 300 characters.

**`sendAudit`**: transport, return `{ ok, status }`. Spread `entry` first, then `source`.

**`fetchPolicy`**: transport, then defensive extraction with `typeof` guards (the body is external data). Do not trust the shape.

**Builders**, ported with the changes below:

- `buildStatement({ verb, target })` (private): `id: policyStatementId("armoropencode-" + verb, target)`, `effect` from a `Map` (`allow`: `permit`, `deny`: `forbid`, `hold`: `forbid`, unknown verb: `forbid`), `principal: { type: "agent", id: PRINCIPAL_ID }`, `action: { type: "tool", eq: toBackendToolName(target) }`, `resource: { type: "workspace", scope: "current" }`, `conditions: []`. No `description` on statements (the backend rejects it as an unknown key).
- `policyStatementId(prefix, target)`: `` `${prefix}-${String(target || "any").replace(/[^a-z0-9_-]+/gi, "-")}` `` unchanged, quirks included (`*` becomes `armoropencode-deny--`). Ids are deterministic and drafts may already depend on the shape.
- `buildPolicyForRule`: `{ schemaVersion, kind: "PolicyProfile", metadata: { name: "armoropencode-current", description: note ? "Staged from ArmorOpenCode /armor/add - <note>" : "Staged from ArmorOpenCode /armor/add" }, defaults: { decision: "allow", conflictResolution: "deny_overrides" }, statements: [buildStatement(...)] }`. (The `/armor/add` text uses opencode's slash path form; ArmorGemini wrote `/armor:add`.)
- Templates, held in a `Map<TemplateName, ...>` and built fresh per call (callers may mutate the result):
  - `lockdown`: default `deny`, statements `[deny "*"]`.
  - `strict-read-only`: default `deny`, statements `[allow read, allow glob, allow grep]` (ArmorGemini had four because `list_directory` and `glob` both map to `Glob`; opencode needs three).
  - `balanced`: default `allow`, statements `[deny webfetch, deny websearch, deny bash]`.
  - Names `armoropencode-lockdown`, `armoropencode-strict-read-only`, `armoropencode-balanced`; descriptions ported with "read only" worded plainly.
  - Documented limitation (comment): `lockdown` does not deny always allowed tools, because the engine exempts them (index Decision 5).
- `listTemplateNames()` returns the Map keys.

**`pushProposal`** (ports `draftAndPropose`): `!config.isConfigured` returns `{ ok: false, stage: "config", status: 0, error: "ArmorIQ is not configured" }`. Draft body `{ policy, orgId: config.orgId || undefined }`; propose body `{ reason: reason || "Proposed via ArmorOpenCode /armor", orgId: ... }`. A private `backendMessage(res)` turns `data.message` (string, or array of strings) into one string, else `res.error`. A `res.ok` with a 2xx status is the only success for each stage.

### Value sourcing

Every value on the wire has a named source, so the build never invents one:

| Action | Value | Source |
|---|---|---|
| `verifyStep` | `source` | constant `SOURCE = "armoropencode"` (index Q3) |
| `verifyStep` | `session_id` | `VerifyStepInput.sessionId`, supplied by the Phase 4 adapter from opencode's `input.sessionID` |
| `verifyStep` | `tool_name` | `toBackendToolName(input.toolName)`; `toolName` is opencode's `input.tool` (index Q1) |
| `verifyStep` | `tool_input` | `VerifyStepInput.toolInput`, from opencode's `output.args` in `tool.execute.before` (note: not on `input`, see research notes section 2); the adapter owns any sanitizing |
| `verifyStep` | `description` | `VerifyStepInput.description`, derived by the Phase 4 engine from `toolInput.description` when it is a string |
| `verifyStep`, `pushProposal` | `org_id` / `orgId` | `config.orgId` (`ARMORIQ_ORG_ID` or `credentials.json`), omitted when unset |
| `verifyStep`, `sendAudit`, `fetchPolicy`, `pushProposal` | Bearer key, client header, base URL, timeout | `authHeaders(config)`, `config.backendEndpoint`, `config.timeoutMs` from `config.ts` |
| `sendAudit` | `event`, `at`, `session_id`, `tool_name`, `tool_input`, `result_summary` | the `AuditEntry` the Phase 4 engine builds (`tool_name` is the raw opencode name; `result_summary` comes from `tool.execute.after`'s `output.title` and `output.output`, truncated by the engine) |
| `buildPolicyForRule` | `principal.id` | constant `PRINCIPAL_ID = "opencode"` (index Q3) |
| `buildPolicyForRule` | `action.eq` | `toBackendToolName(rule.target)` |
| `pushProposal` | `reason` | caller argument, else the default string in AC-B7 |

### Fail closed notes for the implementer

- Do not add a `try/catch` that returns `allowed: true` anywhere. The only `allowed: true` return is the one in the verdict mapping, reachable only through `data.allowed === true && data.action !== "deny"`.
- `verifyStep` has no "monitor" mode. The `Verdict` type still lists `"monitor"` because the backend might return it as an `action` string; this client does not special case it.
- Keep the 8 second default; `config.timeoutMs` already covers it.

## Test plan

Framework: `bun:test`. Replace the network with `spyOn(globalThis, "fetch").mockImplementation(...)` (restore in `afterEach`), returning real `Response` objects (`new Response(JSON.stringify(body), { status })`) so `res.json()` and `res.ok` behave as in production; do not hand roll response look-alikes. Build configs with a small `makeConfig(overrides)` helper that returns a literal `BackendConfig` (`apiKey: "sk-test-secret"`, `backendEndpoint: "https://api.test"`, `timeoutMs: 50`, `orgId: "org-1"`, `isConfigured: true`); no env or home directory access.

`test/backend-client.test.ts` (about 550 lines), in `describe` blocks:
- `verifyStep request`: URL, method, headers (Bearer, `X-ArmorIQ-Client` matches `/^armoropencode\//`), `redirect: "error"`, body keys exactly the AC-B1 set, `bash` is sent as `Bash`, unknown tool name sent verbatim, `org_id` and `description` omitted when absent.
- `verifyStep verdicts`: allow, deny with reason, deny with empty reason gets the default, `allowed: true` plus `action: "deny"` denies, `allowed` missing denies, `allowed: "true"` (string) denies, `matched_policy` passthrough, `{}` denies, `null`, `[]`, `"ok"`, empty body, HTML body, 204.
- `verifyStep failures` (table driven over status codes 400, 401, 403, 404, 429, 500, 503): allowed false, `fatal` only for 401 and 403, reasons as in AC-B3; the 400 case includes the backend message; fetch rejecting; timeout (the mock returns a promise that rejects when `init.signal` aborts, with `timeoutMs: 20`); a mock simulating a redirect error; not configured makes zero fetch calls.
- `no secret leakage` (AC-B8): run every failure case and assert `JSON.stringify(result)` does not contain `sk-test-secret`, including when the mocked rejection message contains an unrelated string.
- `sendAudit`: shape, `source` cannot be overridden, ok and failed statuses, rejection and not configured return `{ ok: false, status: 0 }`.
- `fetchPolicy`: mapping with full data; defaults on empty policy; `statements` as a non array; non object statements skipped; non 2xx; 2xx without `policy`; rejection.
- `builders`: `buildPolicyForRule` exact object for allow, deny, hold; unknown verb cast to `forbid`; target mapping (`webfetch` becomes `WebFetch`, `apply_patch` becomes `Edit`, unknown verbatim, `*` stays `*`); note in the description; ids for `*` and for names with odd characters; templates exact statement lists; `listTemplateNames` order; `constructor` and `__proto__` return `null`; fresh object per call (mutate one, request again); every output passes `validatePolicyProfile`; every output renders through `policyToYaml` without throwing (cheap contract check against Phase 2).
- `pushProposal`: both stages succeed with exact bodies and order (assert call order), draft failure means exactly one fetch call, propose failure, message string and array forms, org id handling, not configured returns the `config` stage with zero fetch calls.
- `bridge to local policy` (AC-B9): save and load each template into a scratch dir; `lockdown` denies `read` and `bash`; `strict-read-only` allows `read`, `glob`, `grep` and denies `bash`, `webfetch`, and an unknown `foo` (default deny); `balanced` denies `bash`, `webfetch`, `websearch`, allows `read` and `edit`; `buildPolicyForRule({ verb: "deny", target: "webfetch" })` denies `webfetch` and allows `read`; rule `deny edit` also denies `apply_patch`.

Mutation evidence to capture during `/check`: change the strict `allowed === true` to the ArmorGemini `!== false` test and show the malformed body tests fail; change the 400 branch back to allow and show the matrix test fails; remove `redirect: "error"` and show the request test fails.

## Build plan

1. Write the request and verdict tests (red), then the transport and `verifyStep` (green), satisfies **AC-B1**, **AC-B2**, **AC-B3**, **AC-B8**, **AC-X2**, **AC-X3**.
2. Write `sendAudit` and `fetchPolicy` tests (red), then both functions (green), satisfies **AC-B4**, **AC-B5**, **AC-B8**.
3. Write the builder tests (red), then `buildPolicyForRule`, templates, `listTemplateNames`, `buildPolicyForTemplate` (green), satisfies **AC-B6**.
4. Write the `pushProposal` tests (red), then `pushProposal` (green), satisfies **AC-B7**, **AC-B8**.
5. Write the bridge tests against 3a modules (green immediately, they pin the contract), satisfies **AC-B9**.
6. `bun test`, `tsc`, bundle smoke (`bun build src/backend-client.ts --target node --outdir <tmp>`, also `src/local-policy.ts`), diff size under 1,000 lines, satisfies **AC-X4**.
7. `/test`, `/check verify`, `/check review` per the index handoff, then commit.

If the file passes 900 lines, `fetchPolicy` (and its tests) is the first thing to defer: it has no caller in ArmorGemini's CLI. Tell the human rather than dropping it silently.

## Consequences

See the umbrella. Specific to 3b: the module is the only place that knows the backend wire contract, so Q1 (tool name vocabulary), Q2 (400 handling), and Q3 (new `source` and principal values) are one line edits here if the live backend disagrees. Phase 4 calls `verifyStep` and `sendAudit` and must treat `fatal: true` as a hard deny with a user visible explanation.
