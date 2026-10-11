# ArmorOpenCode

Inspect OpenCode token usage and tool calls across retained sessions and models. Compare actual usage with per-session and overall token budgets. Run everything locally without changing OpenCode's configuration.

## Run a report

For installation and the verified website flow, read [the onboarding guide](docs/onboarding.md). The public curl installer is not deployed. Release maintainers can [build and test its hosting assets](docs/curl-install.md).

Use Python 3.9 or later. The collector has no third-party dependencies.

```sh
cd armorOpenCode
python3 -m armor_opencode report
```

The report lists overall usage, each provider and model, sessions, daily usage, and tool outcomes. It reads the default OpenCode data directory. `OPENCODE_DATA_DIR` accepts comma-separated directories. `XDG_DATA_HOME` changes the default data root.

To compare against both budget scopes, set their limits.

```sh
python3 -m armor_opencode report --session-budget 500000 --total-budget 10000000
```

These numbers are example allowances, not recommended token limits. An unset budget appears as unconfigured. Both targets compare usage in the selected report scope. A date or model filter compares each session's selected usage, not its full lifetime usage. The dashboard's search and model controls apply the same comparison to the current view.

For individual session targets, pass `--budget-config budgets.json`. The file accepts `sessionBudget`, `totalBudget`, and a `sessions` object that maps session IDs to their token limits. Each session reports its own usage. Child sessions have separate rows.

## View usage in Armor Tools

The account-scoped website pages live in `armoriq/armoriq-tools` at `/tools/opencode`, `/sessions`, and `/analytics`. The OpenCode repository owns collection, accounting, CLI reports, and the JSON contract.

Export a local report for the configured telemetry collector.

```sh
python3 -m armor_opencode report --format json --output output/report.json
```

Running this command does not upload the report or pair an account. The authenticated backend collector must be configured separately for the signed-in user and workspace. See the backend's local session sync guide. Each user must collect their own history. Generated reports and credentials must never be committed or bundled with website assets.

The intended production website is `https://tools.armoriq.ai`. These changes do not deploy the website or publish the curl installer.

The existing Bun installer remains in `scripts/install.ts`. The Python telemetry collector runs independently and does not modify OpenCode settings.

## Select historical usage

```sh
python3 -m armor_opencode report --model opencode/big-pickle
python3 -m armor_opencode report --since 2026-09-01 --until 2026-09-30 --timezone Asia/Kolkata
python3 -m armor_opencode trace --session SESSION_ID
python3 -m armor_opencode report --source /path/to/opencode --source /path/to/older-opencode
```

Replace `SESSION_ID` with an ID in the session report. Sources can be OpenCode data directories or SQLite database files. Older directories can contain `storage/session`, `storage/message`, and `storage/part` JSON records. Deleted history cannot be recovered from a current database alone.

## Export metadata

```sh
python3 -m armor_opencode report --format json --output output/report.json
```

The JSON contract has `schemaVersion` 1. It excludes prompt text, reasoning text, tool inputs and outputs, session titles. Repository directories are included when present in the local source. IDs, provider/model identities, timestamps, counts, and budgets remain in the report. Generate a new report to refresh the imported snapshot. Generated reports are ignored by Git and must not be bundled with website assets.

## Refresh model metadata

```sh
python3 -m armor_opencode catalog refresh --output output/models.json
python3 -m armor_opencode report --model-catalog output/models.json --format json --output output/report.json
```

The explicit catalog command fetches the current [Models.dev provider catalog](https://models.dev/api.json?type=all). Reports themselves stay offline. The saved snapshot records its source, fetch time, and hashes. Model names, families, limits, and current rates use an exact provider/model match. New and custom models remain in the report even when the catalog has no match. No name substring or alias supplies a price.

Catalog rates are metadata observed when the snapshot was fetched. They do not establish what a provider charged for an older session. Missing component rates remain unknown. `reportedCost` comes from OpenCode's retained records, and catalog refresh never replaces it or produces a historical cost estimate. Provider invoices remain the source for billed spending.

## Verify the collector

```sh
python3 -m unittest discover -s tests -v
python3 scripts/verify_local.py "$HOME/.local/share/opencode/opencode.db"
```

The tests cover accounting and input errors. Real local history reconciliation and browser verification are recorded in [verification.md](docs/verification.md).

## Accounting limits

The collector counts model-step usage once. It separates cached input and reasoning from other token components. Provider-reported totals remain visible when available. Forked messages with timestamps preceding their session are inherited history and do not add to new-execution totals.

The report describes retained OpenCode measurements. It does not infer billing, optimal task usage, or token costs for individual tools. Diagnostics identify incomplete or inconsistent records.

Read [the design](docs/design.md) for the source contract and future integration boundary. The next iteration can add live event collection and intent hooks after historical accounting is verified.

## OpenCode guardrail plugin (preview)

The TypeScript plugin in `src/` checks each OpenCode tool call against a local policy and records an audit row for it. It is separate from the Python report and is active only in projects that list it in `opencode.json`. It is not published to npm yet.

Build the plugin and load the local build.

```sh
bun install
bun run build
```

```json
{ "plugin": ["file:///absolute/path/to/armorOpenCode/dist/plugin.js"] }
```

The plugin runs in one of two modes.

- **Enforce.** A policy deny blocks the tool call, and the model receives the reason as the tool error. If a policy file exists but cannot be read or parsed, every tool call is blocked.
- **Watch.** Nothing is blocked. A call that enforce mode would block is logged as a warning.

The mode is enforce when an ArmorIQ API key is present, and watch when no key is present. Set `ARMOROPENCODE_MODE=enforce` or `watch` to override it. The key comes from `ARMORIQ_API_KEY` or from `~/.armoriq/credentials.json`, which `armoriq login --product armoropencode` writes.

The policy file uses the ArmorCodex format: `{ "rules": [{ "id", "action", "tool", "params"?, "anyParam"?, "dataClass"? }] }`. The first matching rule wins. `require_approval` blocks the call in this version. If one rule is malformed, the plugin rejects the whole file.

```json
{ "rules": [{ "id": "no-curl", "action": "deny", "tool": "bash", "params": { "command": { "$contains": "curl" } } }] }
```

Audit rows are written to `audit/current.jsonl` in the data directory. Secrets in tool input and output are redacted, and each string is truncated to 2000 characters. With an API key, a background timer sends queued rows to `POST /iap/audit/batch` every 5 seconds. A failed send is retried with the same rows on the next tick.

| Variable | Default |
|---|---|
| `ARMOROPENCODE_DATA_DIR` | `$XDG_DATA_HOME/opencode/armoropencode` (`~/.local/share/opencode/armoropencode`) |
| `ARMOROPENCODE_POLICY_FILE` | `<data dir>/policy.json` |
| `ARMOROPENCODE_BACKEND_ENDPOINT` | `https://api.armoriq.ai` |
| `ARMOROPENCODE_FLUSH_INTERVAL_MS` | `5000` |
