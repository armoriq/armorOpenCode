# Spike findings: V2 events, token usage, storage, packaging and upgrade

Issues: https://github.com/armoriq/armorOpenCode/issues/126 and https://github.com/armoriq/armorOpenCode/issues/128 (tracking https://github.com/armoriq/armorOpenCode/issues/141).

Everything below comes from real runs on 2026-10-14 in sandbox HOMEs under `/tmp/ocv2-spike`. The real `~/.config/opencode`, `~/.local/share/opencode` and `~/.armoriq` were not touched, and the real V2 background service on port 49374 was left running.

Versions: OpenCode 2.0.29 (`@opencode/cli`, `@opencode/plugin`, `@opencode/client`), OpenCode 1.19.0 and 1.18.35 (`opencode-ai`). Model: `opencode/big-pickle` (free tier, so cost is always 0 and cache write is always 0; see "Not verified").

Capture paths are relative to `spike/v2/`. The local checkout path is replaced with `<repo>` in captures.

## Layout

| Path | What it is |
|---|---|
| `plugin/index.mjs` | Logging plugin. One default export with `id`, `server` (V1) and `setup` (V2). Writes every event to `$SPIKE_LOG`. |
| `scripts/v2-sessions.sh` | Drives two real V2 sessions (tools, subagent, auto title), compares token sums, deletes a session. |
| `scripts/session-usage.mjs` | Reads V2's own per-session usage through `@opencode/client`. |
| `scripts/v2-config-forms.sh` | Loads the logger through each V2 config entry form. |
| `scripts/upgrade-major.sh` | V1 sandbox, `install_armoropencode.sh` from a local checkout, then `opencode upgrade --major`. |
| `scripts/v2-entry-resolution.sh` | Which file V2 loads for a local directory entry; what it logs for a V1-only export. |
| `scripts/coexist.sh` | V1 and V2 on one HOME: binaries, shared config, shared database. |
| `scripts/stub-login.sh` | Offline stand-in for `armoriq login` so the installer can run in a sandbox. Writes a placeholder key. |
| `captures/` | Raw outputs, one directory per question. |

---

## #126 V2 events, token usage and session storage

### 1. Event names and payloads for session created, idle, deleted, message and step finished

**Answer.** `ctx.event.subscribe()` returns an async iterable of every server event for the location the plugin was set up in. Envelope: `{ id, created, type, durable?: { aggregateID, seq, version }, location?, data }`. The V1 names map like this:

| Need | V1 event | V2 event (observed) | Payload `data` |
|---|---|---|---|
| Session start | `session.created` | `session.created` | `sessionID, projectID, location, subpath, slug, model {id, providerID}, version`, plus `parentID, title, agent` for subagents |
| Turn finished, session idle | `session.status` idle, `session.idle` | `session.execution.succeeded` | `sessionID`. Its `created` equals `time.idle` on the session record to the millisecond. |
| Turn started | `session.status` busy | `session.execution.started` | `sessionID` |
| Step finished, tokens | `message.part.updated` step-finish | `session.step.ended` | `sessionID, assistantMessageID, finish, rawFinish, cost, tokens {input, output, reasoning, cache {read, write}}, snapshot, files` |
| Step started, model | `message.updated` | `session.step.started` | `sessionID, assistantMessageID, agent, model {id, providerID, variant}, snapshot, started` |
| Running session totals | none | `session.usage.updated` | `sessionID, cost, tokens` (cumulative for that session only, no `location`, no `durable`) |
| Title | `session.updated` | `session.renamed` | `sessionID, title` |
| Deleted | `session.deleted` | `session.deleted` | `sessionID`, no `location` |
| Tool calls | `message.part.updated` tool | `session.tool.called`, `.success`, `.failed`, `.progress`, `.input.*` | not analysed here, see https://github.com/armoriq/armorOpenCode/issues/125 |

`session.idle` and `session.status` exist in the generated client types but were **never emitted** in any V2 run (4 sessions with prompts, 2 subagent sessions, 2 deletions). The `created` time of `session.execution.succeeded` matched `time.idle` for all 6 sessions checked. A V2 port must use `session.execution.succeeded` (and presumably `.failed` and `.interrupted`, which are typed but were not triggered).

Other behaviour seen:
- A retried step emits `session.step.started` once per attempt with the same `assistantMessageID` (3 times in run 2, after `session.retry.scheduled` with `provider.transport` errors), and `session.step.ended` once. Count steps by `step.ended` or by unique `assistantMessageID`, never by `step.started`.
- Deleting a parent deletes its subagent sessions: one `session.deleted` per session, child first, then parent.
- `setup` runs lazily when a location boots (first request for that directory), once per location. The returned cleanup ran when the service restarted.

Evidence: `captures/v2-events/plugin-events-all-runs.jsonl` (runs 1, 2 and the deletion), `captures/v2-events/plugin-events-run2.jsonl`, `captures/v2-events/delete-log-lines.txt`, and the scripted rerun in `captures/v2-events/scripted/`.

Not verified: `session.execution.failed` and `.interrupted` payloads; events from the TUI (all runs were `opencode run` through the background service, which is the same server, so emission should not differ, but it was not checked); compaction events.

### 2. Where model id and token counts appear, checked against V2's own totals

**Answer.**
- Model: `session.step.started.data.model` (`id`, `providerID`, `variant`), one per step, keyed by `assistantMessageID`. `session.created.data.model` carries the session's selected model (no `variant` on top-level sessions). Persisted per message in `session_message.data.model`.
- Tokens per step: `session.step.ended.data.tokens` with `input`, `output`, `reasoning`, `cache.read`, `cache.write`, plus `cost`. Unlike V1 step-finish there is no `tokens.total`.
- Running totals per session: `session.usage.updated.data.tokens` and `cost`.

Checked against V2's own numbers:

| Run | Source | input | output | reasoning | cache read | cache write | steps |
|---|---|---|---|---|---|---|---|
| Run 1 parent `ses_ec5471193ffeF1DjYk3kExJNmP` | sum of `step.ended` | 4519 | 119 | 123 | 17088 | 0 | 4 |
| | last `usage.updated` | 4519 | 119 | 123 | 17088 | 0 | |
| | `client.session.get` | 4519 | 119 | 123 | 17088 | 0 | |
| Run 1 subagent `ses_ec546d50fffeJ3CciwWWaIIARC` | sum of `step.ended` | 2214 | 84 | 11 | 6208 | 0 | 2 |
| | `client.session.get` | 2214 | 84 | 11 | 6208 | 0 | |
| Run 1 total | `opencode stats --json --full` | 6733 | 203 | 134 | 23296 | 0 | 6 |
| Run 2 `ses_ec5328bbaffekXZmHKeKHgO5r1` (auto title) | sum of `step.ended` | 4139 | 33 | 90 | 4312 | 0 | 2 |
| | last `usage.updated` and `client.session.get` | 4604 | 43 | 692 | 4380 | 0 | |
| Runs 1 and 2 | `opencode stats --days 0` | 10872 | 236 | 224 | 27608 | 0 | 8 |
| Scripted rerun, parent (titled) | sum of `step.ended` = last `usage.updated` = `session.get` | 8386 | 166 | 64 | 13440 | 0 | 4 |
| Scripted rerun, subagent | sum of `step.ended` = last `usage.updated` = `session.get` | 2763 | 128 | 0 | 6144 | 0 | 2 |
| Scripted rerun, auto title | sum of `step.ended` | 272 | 30 | 15 | 10048 | 0 | 2 |
| | last `usage.updated` and `session.get` | 298 | 36 | 42 | 10560 | 0 | |
| Scripted rerun, all | `opencode stats --json --full` | 11421 | 324 | 79 | 29632 | 0 | 8 |

So:
- Sessions given `--title` (and subagents, which take the task description as title) generate no title: all four sources agree exactly, and the step sums add up to the `stats` total. The scripted rerun reproduced this on new sessions.
- Run 2 let V2 generate a title. The session record and `usage.updated` include the title call (an extra `usage.updated` lands just before `session.renamed`: +465 input, +10 output, +602 reasoning, +68 cache read). `opencode stats` does not: it counts steps only (10872 = 6733 + 4139). **V2's two "own totals" disagree whenever a title is generated.**
- `stats` is per model and per step. `usage.updated` is not attributed to a model and the title call emits no `step.*` event, so its model is unknown from events.

Recommendation for https://github.com/armoriq/armorOpenCode/issues/135: build usage rows from `session.step.ended` joined to `session.step.started` by `assistantMessageID` (model per step). That matches `opencode stats` and gives model attribution. Decide explicitly whether the console should also show title-generation tokens (the `session.get` number); if so, record the difference between the last `usage.updated` and the step sum as an unattributed line.

Deleted sessions disappear from `opencode stats` entirely (after deleting run 1, `stats --days 0` reports 1 session and only run 2's step tokens). Anything the console needs must be captured before deletion.

Evidence: `captures/v2-events/plugin-events-all-runs.jsonl`, `run1-opencode-stats-full.json`, `run1-session-get-via-client.jsonl`, `run2-session-get-via-client.jsonl`, `stats-after-run1-deleted.json`, `run1-cli-format-json.jsonl`, `run2-cli-format-json.jsonl`, and `captures/v2-events/scripted/`.

Not verified: cost and cache write. The free model reports `cost: 0` and `cache.write: 0` on every step, so spend parity and cache-write parity need one run on a paid provider with prompt caching. Reasoning tokens were non-zero and matched.

`@opencode/client` against the background service needs HTTP basic auth: user `opencode`, password from `~/.local/state/opencode/service.json` (see `scripts/session-usage.mjs`). Without it every call fails with `UnauthorizedError: Authentication required`.

### 3. Where V2 stores sessions and titles on disk

**Answer.** SQLite at `~/.local/share/opencode/opencode.db` (from `opencode debug paths`; same file V1 uses).
- Table `session_v2`: one row per session with `id, parent_id, title, slug, directory, version, agent, model` (JSON), `cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, time_idle, idle_outcome`, and more. Values equal `client.session.get`, so they include title-generation tokens.
- Table `session_message`: `(session_id, type, seq, data)` where `type` is `user`, `assistant` or `idle`. Assistant `data` holds `model`, `agent`, `finish`, `cost`, `tokens` per step, so a backfill can rebuild per-step, per-model usage from disk.
- Table `event`: exists but held no rows in these runs.
- The V1 tables (`session`, `message`, `part`) stay in the same database when both majors are used. See #128 section 4 for how V1 sessions reach `session_v2`.

For the title reader (https://github.com/armoriq/armoriq-sdk-customer-ts/issues/557): read `session_v2.title`, or `client.session.get`. Titles change through `session.renamed`.

Evidence: `captures/v2-events/storage-sqlite-dump.txt` (schema and rows), `captures/coexist/shared-db-sessions.txt`, `captures/upgrade-major/db-after-upgrade.txt`.

Not verified: workspace or worktree sessions (`workspace_id`), and whether V2 ever prunes `session_message`.

### 4. Whether subagent sessions name their parent

**Answer.** Yes. The subagent's `session.created` carries `data.parentID` (plus `title` from the task description and `agent`). The same `parentID` is returned by `client.session.get` and stored in `session_v2.parent_id`. Usage is not rolled up: the parent's `usage.updated` and record exclude the subagent's tokens, so a console total per prompt must add child sessions. `opencode stats` reports them as `subagents` and includes their tokens.

Evidence: `captures/v2-events/plugin-events-all-runs.jsonl` (second `session.created`), `run1-session-get-via-client.jsonl`.

---

## #128 Packaging, config and upgrade with both majors

### 1. Can one default export satisfy both loaders

**Answer.** Yes, with one guard. The same file (`plugin/index.mjs`, a default export with `id`, `server` and `setup`) loaded in OpenCode 2.0.29, 1.19.0 and 1.18.35:

| Host | What it called |
|---|---|
| V2 2.0.29 | `setup(ctx)` with the full context (`app, location, options, agent, aisdk, command, credential, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell`). `server` is ignored. |
| V1 1.19.0 and 1.18.35 | `server(input, options)` as today, **and also** `setup(ctx)` with a partial context: `options, agent, aisdk, catalog, command, integration, plugin, reference, skill`. No `event`, `tool` or `session`. |

So `setup` must feature-detect the real V2 host (for example `if (!ctx.event) return`). Without the guard, V1 throws `TypeError: undefined is not an object (evaluating 'ctx.event.subscribe')` inside `setup` (captured in `captures/v1-dual-export/v1-1.19-dual-unguarded.jsonl`); V1's own `server` path still worked in that run.

V2 requires a default export with `id` and either `setup` or `effect`; a V1-only export is rejected with `WARN failed to load plugin ... Plugin must export a default definition with an id and an effect or setup function`.

V2 refuses a plugin that resolves its own copy of `@opencode/plugin` or `effect` (`plugins must use the host's "effect" and "@opencode/plugin" modules`). `Plugin.define` is an identity function, so the shared entry can avoid importing it at runtime. Importing `@opencode-ai/plugin` (the V1 SDK, a different package) did not block loading: V2 imported our real `src/plugin.ts` and only failed on the export shape.

Evidence: `captures/v1-dual-export/*.jsonl`, `captures/v2-config-forms/form-plugins-path.jsonl`, `captures/upgrade-major/v2-entry-resolution-output.txt`, `captures/coexist/coexist-*.jsonl`.

### 2. V2 config file location and `plugins` entry forms

**Answer.** V2 reads the same `~/.config/opencode/opencode.json` as V1 (`opencode debug config`). It also keeps `~/.config/opencode/service.json` (port, password) and state in `~/.local/state/opencode/`. Every row below is from a real load:

| Entry | Loaded | Options reached `setup` |
|---|---|---|
| `"plugins": ["/abs/dir"]` | yes | `{}` |
| `"plugins": ["file:///abs/dir"]` | yes | `{}` |
| `"plugins": [{"package": "/abs/dir", "options": {...}}]` | yes | yes |
| `"plugin": ["/abs/dir"]` (V1 key) | yes | `{}` |
| `"plugin": [["file:///abs/dir", {...}]]` (V1 tuple, what `install_armoropencode.sh` writes) | yes | yes |
| `"plugins": [["file:///abs/dir", {...}]]` (tuple under the V2 key) | no, nothing logged | |
| `"plugins": [{"package": "name@file:/abs/x.tgz", "options": {...}}]` | yes, installed to `~/.cache/opencode/npm/<spec>/<ts>/node_modules` | yes |
| `"plugins": ["@opencode/plugin@2.0.29"]` (registry package) | fetched from npm into the same cache, then rejected because it is not a plugin | |
| `"plugins": [{"package": "/abs/x.tgz"}]` | no: `WARN configured plugin path must be a directory` | |
| `.opencode/plugins/<name>.js` or `.ts` in the project | yes | `{}` |
| `.opencode/plugins/<name>.mjs` | no, nothing logged | |

V2 normalizes the V1 `plugin` tuple into the object form in memory (`opencode debug config` shows `{"package": "file://...", "options": {...}}`) and does not rewrite the file.

Entry resolution differs by kind, which matters for our installed layout:
- **Local directory entry:** V2 ignores `package.json` `main` and `exports` and only loads `index.{ts,js,mjs}` at the directory root. A directory whose entry is `./src/plugin.ts` (our package today) is **skipped silently**: no `loading plugin`, no WARN.
- **Package entry** (installed into the cache): `exports` is honoured (`src/plugin.mjs` loaded from a tarball with no root index).

With both keys present (`plugin` tuple and `plugins` object, same path), V2 logs two loads but calls `setup` once; V1 calls `server` once. With only the V2 `plugins` key, V1 1.19 **does not call `server`** (it only runs the partial `setup`), so V1 would be unguarded.

V2 hot-reloads plugins when the config file changes under a running service (`config.updated` then `loading plugin`, no restart).

`opencode plugin list` prints `No plugins found` even while local plugins are loaded; do not use it to verify an install.

Evidence: `captures/v2-config-forms/forms-script-output.txt`, `form-*.jsonl`, `v2-plugin-load-log-lines.txt`, `captures/upgrade-major/v2-entry-resolution-output.txt`, `captures/coexist/coexist-*.jsonl`.

Not verified: loading our package from the npm registry (it is not published with a V2 entry). The registry fetch path and the package `exports` path were each exercised separately, as above.

### 3. What `opencode upgrade --major` does to an existing ArmorOpenCode entry

**Answer.** It replaces the binary and leaves the config untouched. The entry is not removed, migrated or warned about, and our plugin silently stops running.

Sequence (`scripts/upgrade-major.sh`, npm method, sandbox npm prefix):
1. `npm i -g opencode-ai@1.19.0`, then `install_armoropencode.sh` with `ARMOROPENCODE_REPO_URL` set to the local checkout, ref at commit 29bec8c, backend `http://127.0.0.1:9`, and the stub login. It wrote `"plugin": [["file://$HOME/.armoriq/armoropencode/plugin", {"backendUrl": "http://127.0.0.1:9"}]]`. A V1 session ran.
2. `opencode upgrade --major --method npm` printed `From 1.19.0 → OpenCode 2`, ran `npm uninstall -g opencode-ai` and `npm install -g @opencode/cli`, and finished with `OpenCode 2 installed`. Afterwards `opencode` and `opencode2` both point to 2.0.29, and `opencode-ai` is gone from the prefix.
3. `opencode.json` is byte-identical before and after (`diff` exit 0).
4. V2 normalizes the entry, then finds no root `index.*` in `~/.armoriq/armoropencode/plugin` and skips it **without any log line**. This is worse than the WARN the plan expected: there is nothing to grep for.
5. With a root `index.ts` re-exporting `src/plugin.ts` (V1-only export), V2 imports it and logs `WARN failed to load plugin ... must export a default definition with an id and an effect or setup function`.
6. The pre-upgrade V1 session appears in `session_v2` with its tokens and messages.

Implication for https://github.com/armoriq/armorOpenCode/issues/136 and https://github.com/armoriq/armorOpenCode/issues/137: if the package gains a root `index.ts` whose default export is the dual `{ id, server, setup }` object, the entry users already have keeps working after `opencode upgrade --major`, with no installer re-run. The rows above show each piece of that chain. The chain was not run end to end with a real dual ArmorOpenCode build, because that build does not exist yet.

Evidence: `captures/upgrade-major/upgrade-major-script-output.txt`, `opencode.json-before-upgrade`, `opencode.json-after-upgrade`, `v2-entry-resolution-output.txt`, `db-after-upgrade.txt`.

Not verified: the `curl`, `brew`, `bun`, `pnpm` upgrade methods (only `--method npm` was run, inside a sandbox prefix, to keep it off the real machine); the TUI upgrade prompt; running the real ArmorOpenCode guard on V2 (it needs the V2 host layer from https://github.com/armoriq/armorOpenCode/issues/130). The ArmorIQ login was a stub, so the V1 plugin could not reach a backend; this spike only checked loading.

### 4. Whether V1 and V2 coexist on one machine

**Answer.** Only in separate install locations, and they share all state.
- One npm global prefix cannot hold both: installing `@opencode/cli` after `opencode-ai` fails with `npm error code EEXIST` on the `opencode` bin. `upgrade --major` removes V1 for the same reason.
- Separate prefixes work: V1 1.19.0 and V2 2.0.29 both ran sessions in the same HOME. V2's `opencode2` alias comes from `@opencode/cli`; it is not a V1/V2 switch, and `opencode` resolves to whichever is first on `PATH`.
- Shared state: both read `~/.config/opencode/opencode.json`, write `~/.local/share/opencode/log/opencode.log`, and use `~/.local/share/opencode/opencode.db`. V2 adds its tables on first start. V1 sessions that existed at V2's first start were copied into `session_v2` (with `version` 1.19.0); V1 sessions created later were not, even after more V2 restarts. V1 kept working on the migrated database.
- The V2 background service uses a fixed default port, 49374. A second V2 HOME on the same machine (here, the sandbox next to the real install) fails with `Managed service port 49374 on 127.0.0.1 is already in use` until `opencode service set port` is used. It did not connect to the other HOME's service.

For one config that guards both: keep the V1 `plugin` tuple entry. V1 calls `server`, V2 calls `setup`, and both receive the options. The V2-only `plugins` form leaves V1 unguarded.

Evidence: `captures/coexist/coexist-script-output.txt`, `coexist-v1-key.jsonl`, `coexist-v2-key.jsonl`, `coexist-both-keys.jsonl`, `shared-db-sessions.txt`.

Not verified: Homebrew or curl installs side by side; Windows and Linux.

---

## Operational notes for later phases

- `opencode run` waits for EOF on a non-TTY stdin. Scripts and CI must pass `</dev/null`, or the run hangs before contacting the server.
- The free tier intermittently rejected `opencode run` with `OpenCode's free tier can only be used from within OpenCode`; reruns succeeded. CI on the free tier will be flaky.
- `--print-logs --log-level debug` does not raise the background service's log level; server logs are in `~/.local/share/opencode/log/opencode.log` at INFO.

## Reproduce

```bash
S=/tmp/ocv2-spike; mkdir -p $S/v2pkg
(cd $S/v2pkg && npm init -y >/dev/null && npm i @opencode/cli@2.0.29 @opencode/plugin@2.0.29 @opencode/client@2.0.29)
SANDBOX=$S/sessions V2PKG=$S/v2pkg PLUGIN=$PWD/spike/v2/plugin bash spike/v2/scripts/v2-sessions.sh
SANDBOX=$S/up REPO=$PWD REF=<branch> bash spike/v2/scripts/upgrade-major.sh
SANDBOX=$S/up LOGGER=$PWD/spike/v2/plugin/index.mjs bash spike/v2/scripts/v2-entry-resolution.sh
SANDBOX=$S/both PLUGIN=$PWD/spike/v2/plugin PORT=49394 bash spike/v2/scripts/coexist.sh
```

`v2-config-forms.sh` expects `$SANDBOX/env-v2.sh` (HOME, PATH to the V2 bin, `SPIKE_LOG`) and a sandbox service port set with `opencode service set port`.
