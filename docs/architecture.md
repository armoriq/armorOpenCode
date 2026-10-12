# ArmorOpenCode architecture

Status: proposed, revision 2, 2026-10-11. Tracking: https://github.com/armoriq/armorOpenCode/issues/37

ArmorOpenCode is an OpenCode plugin. It enforces ArmorIQ policy and intent plans on every tool call. It reports the same data as ArmorClaude and ArmorCodex to the same backend through the same SDK: audit rows, intent plans and tokens, traces, and token usage.

Where ArmorClaude and ArmorCodex differ, this design follows ArmorClaude. Section 8 lists where it goes further than both.

Revision 2 folds in a code fact-check, a hostile design review, and a side-by-side run of the intent paths of both reference plugins against a logging stub backend. Every latency number is measured. Every behavior claim about other code cites what was read or run.

## 1. Constraints

### 1.1 Backend contract (conmap-auto `dev` b53bdf61)

| Data | Endpoint | Client |
|---|---|---|
| Intent token | `POST /iap/sdk/token`. Returns 401 for a revoked key and 402 for no subscription or over quota. The token carries `policy_validation` with `denied_tools` and `held_tools`. | SDK `capturePlan` + `getIntentToken` |
| Plan lifecycle | `POST /iap/trust/reanchor`, `POST /iap/trust/revoke` | SDK, as ArmorClaude does |
| Audit rows | `POST /iap/audit/batch` `{rows}`, at most 200 rows. Always 200, with `{written, orphan, failures: [{index, error}]}`. An invalid row is a `failures` entry, not a 400. | Plain fetch, as both reference plugins do |
| Traces | `GET /observability/policy/lease`, then OTLP `POST /v1/traces` | SDK `ArmorIQTelemetryRuntime` |
| Token usage | `POST /dashboard/token-usage/stream` and `/batch`, `PUT /dashboard/token-usage/runs/:id`. `/batch` answers 409 when the stream generation changed. | SDK `initializeUsageStream`, `recordTokenUsageBatch`, `reportUsageRun` |
| History request | `GET /api-keys/device-history-sync` | Plain fetch |
| Credentials | `~/.armoriq/credentials.json` v2, `profiles` keyed `product@host` | SDK `loadLoginContext` |
| Relogin | Any route can answer 403 `relogin_required` | SDK `isReloginRequired` |

Not used:
- `POST /dashboard/token-usage`: legacy. It answers 409 once the user, org, device and product scope has a stream.
- `POST /observability/spans`: SDK 0.6 only.
- `/dashboard/telemetry` and `/dashboard/session-sync`: removed.
- `POST /iap/enforce`: deleted.
- `/iap/verify-step`: it writes nothing, and both reference plugins leave it off by default.

SDK: `@armoriq/sdk-dev@^0.8.17`, which is what ArmorClaude and ArmorCodex `dev` use. Their production `main` branches are on `@armoriq/sdk` 0.6. See Q1.

### 1.2 OpenCode v1.18.31

Verified by reading `anomalyco/opencode` at `v1.18.31`. The latency rows in 1.3 were measured inside real `opencode run`.

- **Execution model.** Plugins run in the agent's own Bun process and JS thread (`plugin/loader.ts:139`).
  - Hooks are awaited one plugin after another, with no timeout (`plugin/index.ts:291-295`).
  - The plugin is instantiated once per directory, not once per process (`effect/instance-state.ts`). `PATCH /config` disposes the instance and rebuilds it.
- **`tool.execute.before`.** A throw here blocks the call. The model sees the message as a tool error and continues.
  - This covers built-in, plugin, MCP, MCP resource, `task` and code-mode tools (`session/tools.ts:106,175,258,338,402`; `tool/code-mode.ts:141`).
  - MCP tools are named `sanitize(server) + "_" + sanitize(tool)` (`mcp/catalog.ts:117-119`), and they are written into the tool map after built-ins.
  - The `output` object passes through every plugin in turn, and the tool runs with that same `args` object. A later plugin can therefore change the arguments after this one allowed them.
- **`tool.execute.after`.** It runs only when the tool succeeded (`session/tools.ts:111-125`). Thrown errors, permission rejections and our own denies skip it. Terminal tool state, including `error`, arrives on `message.part.updated`.
- **`event` handlers.** They are not awaited.
  - A synchronous throw from a handler on a non-durable event propagates to the publisher, and later plugins then miss that event (`core/event.ts:389-411`).
  - Streaming deltas arrive as `message.part.delta`. `message.part.updated` fires only at part start and end.
- **Tokens and cost.** On a completed assistant message, `cost` accumulates across steps, but `tokens` holds only the last step's numbers (`processor.ts:458-459`). Usage must therefore be summed from each `step-finish` part.
- **Session lifecycle.**
  - `session.deleted` fires only on explicit deletion, never on shutdown (`session/session.ts:622`).
  - `dispose` exists and runs at instance teardown (`plugin/index.ts:265-277`).
  - `session.idle` is deprecated; `session.status` with status `idle` is current.
- **`chat.message`.** It can add parts only by changing `output.parts` in place, and each added part needs its own `id`, `messageID` and `sessionID` (`session/prompt.ts:694,1008-1047`).
- **Custom tools.** Plugin custom tools receive `sessionID` in their context (`plugin/src/tool.ts:4`).
- **Permissions.** `permission.ask` is declared but never called. The runtime event is `permission.asked`. The plugin's v1 client can answer it only through a deprecated route (`/session/{id}/permissions/{permissionID}`).
- **Subagents.** The `task` tool creates a child session with `parentID` (`tool/task.ts:158`).

### 1.3 Measured latency per tool call

| Path | p50 | Where the time goes |
|---|---|---|
| ArmorClaude `dev`, warm daemon | 215 ms | Node start plus SDK import, about 180 ms. Guard work is 0.5 ms. |
| ArmorCodex `dev` | 186 ms | Node start plus SDK import, about 130 ms. Guard work is 0.46 ms. |
| In OpenCode, in-memory 50-rule match | 9 µs (p95 21 µs) | Real `opencode run`, 117 samples |
| Same, plus one synchronous file append | 129 µs (p95 226 µs) | Blocks the whole thread |
| Same, plus one awaited localhost fetch | 1.69 ms (p95 3.1 ms, max 9 ms) | Queued behind streaming |
| PR #35 `before`, Bun microbenchmark | 47 µs | 90% of it is reloading the policy file on every call |
| 50 lowercase passes over a 1 MB argument (Node) | 13.8 ms | Scanning every argument per rule |
| `/^(a+)+$/` against 29 characters (Node) | 9.9 s | Catastrophic backtracking freezes the agent thread |

Conclusion: an in-process plugin can be about a thousand times faster than ArmorClaude and ArmorCodex. That holds only if the tool-call path never waits on disk or network, and matching cost is bounded by construction.

## 2. Design rules

1. **The tool-call path never awaits I/O.** `tool.execute.before` reads memory and enqueues to memory. Nothing else.
2. **The backend keeps its veto, paid once per plan, never per call.** `register_intent_plan` mints the token before it returns, as ArmorClaude does. A plan without a valid token is not active. Expiry, 401 and 402 are checked from memory on the hot path.
3. **Decisions are policy AND plan.** A plan only narrows what policy allows, so registering a plan can never grant a tool.
4. **Per-session state, one owner.** Plans, tokens and counters live in one `Map<SessionID, Session>`, owned by `state/sessions.ts`. There is no global plan file.
5. **Parse at the boundary, then trust types.** Hook payloads, the policy, credentials and backend responses are parsed once. `core/` is pure.
6. **Every decision is audited, including denies.** `before` enqueues the blocked row itself.
7. **Durable within 100 ms, deleted only after the backend accepts that row.** The loss window is stated in section 6, not hidden.
8. **Matching cost is bounded by construction.** Only declared fields are matched, each is lowercased once, and patterns are validated linear at compile time.
9. **The agent cannot touch the guard.** Built-in rules that config cannot override deny reads and writes under `~/.armoriq`. A policy is swapped in only after it parses and verifies.

## 3. Module map

```
src/
  plugin.ts            Per-directory adapter. Maps OpenCode hooks to runtime calls. No logic.
  runtime.ts           One per process, module scope, reference-counted by directory.
                       Survives instance reloads. The only thing hooks call into.
  core/                Pure: no I/O, no clock, no globals.
    decide.ts          decide(policy, session, call) -> Decision
    policy.ts          compile(raw) -> CompiledPolicy | CompileError; evaluate(...)
                       ArmorClaude armor.policy.v1 IR: permit / forbid / require_approval,
                       canonicalPolicyHash. Linear-pattern validation.
    builtin-rules.ts   Non-overridable rules: ~/.armoriq protection, own-tool integrity
    intent.ts          parsePlan (ArmorClaude's lenient schema), checkCall, stepIndexFor
    sanitize.ts        truncate each string to 2000, redact secrets
    audit.ts           toAuditRow(...) -> AuditRow
    usage.ts           stepTokens(part), hourBuckets, changedSnapshots, packBatches
  state/
    sessions.ts        Session map, per-session snapshot file, parent/child links
    policy-source.ts   Load, compile and verify. Watch the file. Keep the last good policy.
  io/
    outbox.ts          Per-process append log. Ack by row. Orphan adoption under a lock.
    backend.ts         The only network module. SDK client plus two plain fetches. 5 s timeouts.
    credentials.ts     loadLoginContext, the device-id file, the relogin marker
    shared-lock.ts     O_EXCL lockfile helper, ported from ArmorClaude live-usage
  pumps/
    audit.ts           Every 5 s and on idle: outbox -> /iap/audit/batch
    usage.ts           On idle and every 60 s: step tokens -> session-hour snapshots -> batch
    traces.ts          One telemetry runtime per process, one root span per turn
    history.ts         device-history-sync -> opencode.db -> history run
    token.ts           Refresh before expiry, reanchor, revoke
  tools/intent.ts      register_intent_plan, policy_read, trust_reanchor, trust_revoke
  commands/armor.ts    /armor commands, intercepted before the model
bench/                 Real-OpenCode latency harness with a stub model. Enforced in CI.
```

Pure modules are ported from ArmorClaude `dev`. Parity tests run its fixtures through both implementations. The process-per-hook machinery of both reference plugins has no equivalent here, because the plugin is already a long-lived process: the daemon, socket, PID file and version ping, `runtime.json`, pending-plan files, and the detached usage workers.

## 4. Data shapes

```ts
type SessionID = string & { readonly __brand: 'SessionID' };
type Mode = 'enforce' | 'monitor';          // enforce when logged in, as ArmorClaude config.mjs:174

type ToolCall = {
  sessionId: SessionID;
  callId: string;
  tool: string;                             // OpenCode name; MCP tools are `server_tool`
  args: Readonly<Record<string, unknown>>;  // frozen after decide()
};

type Decision =
  | { kind: 'allow'; stepIndex: number | null }
  | { kind: 'deny'; code: DenyCode; reason: string; ruleId: string | null }
  | { kind: 'hold'; ruleId: string; reason: string };   // require_approval; v1 runtime denies

type DenyCode =
  | 'policy_forbid' | 'builtin_protected'
  | 'intent_plan_missing' | 'intent_drift' | 'intent_token_expired'
  | 'backend_denied_tool' | 'account_revoked' | 'billing_blocked'
  | 'own_tool_shadowed' | 'internal_error';

type Plan = {
  id: string;                    // plan_id from the backend
  hash: string;
  steps: readonly PlanStep[];
  revision: number;              // 1 on first registration
  registeredInMessage: string;   // messageID of the user turn that registered it
};

type Token =
  | { status: 'active'; jwt: string; expiresAt: number;
      deniedTools: ReadonlySet<string>; heldTools: ReadonlySet<string> }
  | { status: 'refused'; code: 'account_revoked' | 'billing_blocked' };

type Session = {
  id: SessionID;
  parentId: SessionID | null;    // task subagents
  mode: Mode;
  plan: Plan | null;             // children read the root's plan; never their own
  token: Token | null;
  stepCursor: number;
};

type AuditRow = {                // CreateAuditLogDto, conmap-auto dev src/iap/dto/audit-log.dto.ts
  plan_id?: string;              // ArmorClaude style: plan_id, never the raw token
  session_id: SessionID;         // root session for subagents
  agent_id?: string;             // child session id for subagent calls
  user_id?: string;
  client_id?: string;
  step_index: number;            // -1 when the call matches no plan step; never a fake 0
  action: string;
  tool: string;
  input: Record<string, unknown>;    // sanitized: strings truncated to 2000, secrets redacted
  output?: Record<string, unknown>;  // always an object
  status: 'success' | 'failed' | 'error' | 'blocked' | 'held';
  error_message?: string;            // the DenyCode and reason for blocked and held rows
  duration_ms?: number;
  executed_at: string;
};

type BatchAck = {                // per row; the backend answers 200 even when rows fail
  written: number;
  failures: readonly { index: number; error: string }[];
};
```

Why these shapes:

- `Decision` carries a `DenyCode`, so the audit row, the trace span and the message to the model all name the same reason. Drift is `intent_drift` on every path, never `intent_token_blocked`.
- `step_index: -1` fixes a defect in both reference plugins. They record an off-plan action as step 0 with status `success`, and the backend then counts it as plan progress.
- `Token` has no "minting" state, because minting finishes inside `register_intent_plan` before the plan becomes active. The hot path can only see an active plan with a token, a refused account, or no plan.

## 5. Intent plans and drift

The model sees the same contract as in ArmorClaude: the directive text, a `register_intent_plan` tool with lenient argument parsing, and drift denials that explain how to recover.

**Tools.** They are plugin custom tools, not an MCP server:

- `register_intent_plan`
- `policy_read`
- `trust_reanchor`
- `trust_revoke`

OpenCode passes `sessionID` straight into a custom tool's context. That removes the reason ArmorClaude needs a session pointer file, and the global-file bug ArmorCodex has. It also drops a separate process.

ArmorCodex's `policy_update` and `policy_command` are not exposed. The model must not be able to stage policy changes.

**Registration** (`tools/intent.ts`):

1. Parse the plan with ArmorClaude's lenient schema. Reject it if it names a tool the current policy forbids, so a plan only narrows.
2. Mint through `/iap/sdk/token` with the plan attached (5 s timeout, 1 retry), then apply `denied_tools` and `held_tools` from `policy_validation`. A first registration takes about the same time as ArmorClaude's, which mints the same way. It is paid once per plan and runs inside a tool call the model is already waiting on.
3. On success, store `plan` and `token` on the session and return. On 401, mark the session `account_revoked`. On 402, mark it `billing_blocked`. On a timeout or 5xx, return an error and leave any previous plan in place. Never mint from a tool call. That fallback is the ArmorCodex bypass that was reproduced.
4. A revision of an existing plan calls `/iap/trust/reanchor` with a `reason` the model must supply. It is audited as a `held` row carrying the old and new plan hashes.
5. Revisions are limited to a fixed number per user message (default 2). The counter resets in `chat.message`. The model can still recover from a mistaken plan, but it cannot loop on the drift hint.

**Detection** (`core/decide.ts`), in order:

1. Built-in rules.
2. Policy.
3. Plan, with these sub-checks:
   - **No plan while enforcing:** `intent_plan_missing` for side-effecting tools.
   - **Read-only tools** (`read`, `grep`, `glob`, `list`, `webfetch`, `websearch`, `todoread`, `todowrite`) skip the plan check. Policy still applies to them.
   - **Tool not in the plan:** `intent_drift`.
   - **Parameters:** advisory, as in ArmorClaude (`strictParamCheck: false`). A mismatch is recorded on the span and the row, not denied. ArmorCodex denies any overlap, which misfires on ordinary edits.
   - **Token checks:** the token must be unexpired, and the tool must not be in `deniedTools` (a `heldTools` match becomes `hold`). These are memory checks.

**Subagents.** A child session has no plan of its own. It is checked against its root session's plan and token, and cannot register a wider one. Its rows carry the root `session_id`, with the child id in `agent_id`.

**Lifecycle.**
- `pumps/token.ts` refreshes 60 s before expiry. A failed refresh lets the token lapse, and side-effecting calls then deny with `intent_token_expired`.
- `session.deleted` revokes the token. On shutdown, tokens simply expire (3600 s).

**Reporting.** This goes further than both reference plugins. Today neither one makes drift visible in the console.

| Event | Audit row | Span |
|---|---|---|
| Allowed, in plan | `success` or `failed`, `step_index` from the plan | decision `allow` |
| Drift | `blocked`, `step_index: -1`, `error_message: "intent_drift: <tool> not in plan"` | decision `block`, reason `intent_drift` |
| No plan while enforcing | `blocked`, `intent_plan_missing` | same pattern |
| Hold or `require_approval` | `held` | decision `hold` |
| Plan revision | `held`, old and new plan hash | `reanchor` event |

The console's Runs view already shows `blocked` and `held` from the audit status. The backend currently marks a whole plan failed when it receives a `blocked` row. See Q2.

## 6. Hook map and latency budget

Budgets are time spent inside the hook, measured by `bench/` in real OpenCode. They are not end to end, because GC pauses on shared CI runners would make end-to-end budgets flaky.

| Hook | Synchronous work | Deferred work | Budget p50 / p95 |
|---|---|---|---|
| setup (per directory) | Attach to the process runtime. The first attach loads and compiles policy, reads credentials and restores session snapshots. | Dynamic SDK import (130 to 175 ms, off the hot path). Start pumps. Adopt orphaned outboxes. | 20 ms / 50 ms, no network |
| `tool.execute.before` | `decide()`, freeze `args`. On deny or hold, enqueue the row, then throw. | none | 250 µs / 1 ms for arguments up to 16 KB. 2 ms per MB above that. |
| `tool.execute.after` | Build and sanitize the `success` row, enqueue it | outbox | 250 µs / 1 ms up to 16 KB |
| `chat.message` | Intercept `/armor`. Add the directive part on a session's first user message. Reset the revision counter. | user-prompt span | 1 ms / 2 ms |
| `event`, `message.part.updated` | Check `type === 'tool'` and a terminal status first, then enqueue `failed` or `error`. For `step-finish` parts, add tokens to the hour bucket. | outbox, usage | non-blocking, guarded |
| `event`, `session.created` | Create the `Session`, link `parentID` | snapshot | non-blocking |
| `event`, `session.status` idle | Close the turn | flush traces, usage, audit | non-blocking |
| `event`, `session.deleted` | Mark closed | revoke, final flush | non-blocking |
| `register_intent_plan` | Parse, check against policy, mint (network, bounded at 5 s) | reanchor if a revision | One backend round trip, once per plan |
| `dispose` (last directory) | Stop timers, write pending rows to disk | none; the next start ships them | 200 ms cap, no network |

Every `event` handler body runs inside `try/catch` and never throws.

Hot-path guarantees:
- `args` is frozen after `decide()`, so a later plugin cannot rewrite an allowed call. Step 1 runs every built-in tool with frozen arguments to confirm none of them mutates its own args.
- If an MCP tool's OpenCode name equals one of the plugin's tools, every call to that name is denied with `own_tool_shadowed`, and the user is told once.

Durability: rows are appended to disk within 100 ms (coalesced). A process killed inside that window can lose up to 100 ms of rows. Nothing that reached disk is lost.

## 7. Background pumps

Every pump has these properties:
- One in-flight loop.
- Backoff from 5 s to 10 min with jitter. `retryAfterMs` is honored.
- `relogin_required` sets the relogin marker once and stops that pump until the next login.
- No pump ever blocks a hook.

- **Audit.** Each process writes its own outbox file, named by pid plus a start nonce. At startup, a process adopts the outbox of any dead process under an `O_EXCL` lock. The pump sends up to 200 rows per batch.
  - Rows listed in `failures` are logged with their error and retried twice before being dropped.
  - Rows not listed are acknowledged.
  - This fixes PR #35, which ignored `failures` and lost every success row.
- **Usage.**
  - Tokens are summed from `step-finish` parts into session-hour buckets, with `armored: true`, `repo`, `deviceId` and `deviceName` set as ArmorClaude does.
  - The stream generation and every snapshot `revision` are allocated through the shared locked `stream.json` (ported from ArmorClaude `live-usage.mjs`), so two OpenCode processes cannot reuse a revision.
  - Batches respect `MAX_BATCH_SNAPSHOTS`, `MAX_BATCH_ENTRIES` and `MAX_BATCH_BYTES`. A 409 "generation changed" clears the queue, re-initializes the stream and recaptures, as both reference plugins do.
- **Traces.** One `ArmorIQTelemetryRuntime` per process. Each turn is a root span. Decisions, tool calls and results are child spans carrying the `DenyCode`, with sanitized attributes.
- **History.** When `device-history-sync` has an open request, the pump reads `opencode.db` read-only through a port of the Python `source.py`.
  - It produces snapshots with the same key and digest as live usage, so already-sent hours are skipped.
  - It skips sessions owned by a live OpenCode process.
- **Token.** Refreshes, reanchors and revokes, as described in section 5.

## 8. Defects this design does not inherit

| Defect | Where | How it is avoided |
|---|---|---|
| About 200 ms per tool call | ArmorClaude, ArmorCodex (measured) | In-process, memory-only hot path |
| Off-plan call allowed while the background mint is slow | ArmorCodex (reproduced) | Mint finishes inside registration. Never mint from a tool call. |
| One global plan file leaks across sessions | ArmorCodex (reproduced) | Plan held on `Session`, keyed by OpenCode `sessionID` |
| No plan plus login means the call is allowed | ArmorCodex (reproduced) | `intent_plan_missing` |
| Drift never recorded as an audit row, so invisible in the console | Both (run) | `blocked` row with `intent_drift` |
| Off-plan action recorded as step 0, `success` | Both (run) | `step_index: -1` |
| Re-registering silently escapes drift | Both (run) | Revision limit per message, reason required, audited, reanchored |
| Model can stage policy changes | ArmorCodex | No policy-mutation tool exposed |
| `policy_validation.denied_tools` ignored | Both (read) | Enforced from the token |
| Policy re-read on every call | ArmorClaude, PR #35 | Compiled once, swapped after verification |
| Unlocked read-modify-write of `runtime.json` | Both (read) | One owner, in memory |
| Audit success rows dropped (string `output`, `failures` ignored) | PR #35 (validated against the DTO) | Object `output`, per-row ack |
| No `session_id`, `plan_id` or real duration on rows | ArmorCodex, PR #35 | Required fields |
| Credentials v1 only | PR #35 | SDK `loadLoginContext` |
| Token request can wait about 61 s inside a hook | Both (read) | Only in registration and pumps, with a 5 s timeout |
| `INTENT_DEADLINE_MS` written but never read | ArmorCodex #176 | No such knob. Timeouts are tested constants. |

## 9. Verification

- **Parity.** ArmorClaude `dev` fixtures run through `core/` and the original. Decisions and rows must be identical, except for the deliberate differences in section 8, which have their own tests.
- **Latency.** `bench/` runs real `opencode run` against a stub model. It uses 40 tool calls per session and 3 sessions per case, plus a 1 MB `write` case and a 50-rule policy. CI enforces the section 6 budgets.
- **Intent.** The scenario from the comparison run is replayed against the plugin with a logging stub. It covers register, an in-plan call, drift, a revision, a planless session, a slow backend (3 s delay), 401, 402, and a subagent. It asserts the exact decisions and rows.
- **Backend contract.** Integration tests run against a local conmap-auto `dev` with a real database. They assert stored audit, usage and span rows, not just status codes.
- **Concurrency.** Two OpenCode processes on one machine share `~/.armoriq`. The test asserts no duplicate rows and no revision reuse.
- **End to end.** One recorded staging run per release (https://github.com/armoriq/armorOpenCode/issues/49).

## 10. Delivery

Each step is one PR under 1000 lines and ends with its own check. Steps 2 and 3 release together, because enforcement must not ship without auditing.

1. **Scaffold.** Types, `bench/` with budgets, the parity fixture harness, and the frozen-args check across built-in tools. Check: `bench/` green on a no-op plugin.
2. **Hot path.** `core/policy`, `core/decide`, `core/builtin-rules`, `state/policy-source`, `state/sessions`, `runtime.ts`, `plugin.ts`. This replaces the hot path of #35 and #36, keeping their policy port and redaction tests. Check: parity plus the `before` budget.
3. **Audit.** `io/credentials`, `io/backend`, `io/outbox`, `io/shared-lock`, `core/audit`, `pumps/audit`. Check: rows stored in a local conmap, including blocked rows.
4. **Intent.** `tools/intent`, `core/intent`, `pumps/token` (#40, #41). Check: the intent scenario run.
5. **Usage** (#43).
6. **Traces** (#42).
7. **`/armor` commands, MCP tool naming, lifecycle** (#44 to #46).
8. **History backfill** (#53).
9. **Approvals** (#47). Deferred: the only reply route the v1 client has is deprecated.

## 11. Open questions

- **Q1. SDK line.** This targets `@armoriq/sdk-dev` 0.8.17, which only the `dev` branches use. Is `dev` reaching production before OpenCode launches? If not, OpenCode would be the first product in production on the newer protocol.
- **Q2. Blocked rows and plan state.** The backend marks a whole plan failed when it receives a `blocked` row. For drift, that ends the plan on the first denied call. Should the backend treat `blocked` with `step_index: -1` as not affecting plan state? This is a backend change, needed before drift rows ship. ArmorClaude would need it too, to fix its own invisibility.
- **Q3. Intent enforcement by default.** ArmorClaude's default policy is all-allow, so drift there is only recorded, even though its tool description says calls will be blocked. This design enforces the plan for side-effecting tools whenever the user is logged in. Product should confirm that default.

## 12. Follow-up issues for the reference plugins

These are drafts, not posted.

- **armorCodex.** The drift bypass under a slow backend (reproduction in section 8). Also the planless allow, the global plan file, and the missing `plan_id`, `session_id` and duration on rows.
- **armorClaude.** No blocked or held audit rows. Off-plan actions recorded as step 0 with `success`. `policy_validation` ignored. The tool description promises blocking under the default policy.
- **armoriq-tools.** Show drift and reanchor events in the session view once rows carry them.
