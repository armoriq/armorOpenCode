# ArmorOpenCode

## Install the OpenCode plugin

Requires OpenCode 1.18 or later or OpenCode 2, and Node.js 20+ or Bun.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
```

The installer clones the newest `v<version>` release of this repository into `~/.armoriq/armoropencode/plugin` (or `main` before the first release), installs its runtime dependencies, adds that directory to the `plugin` array of your global OpenCode config (`~/.config/opencode/opencode.json` or `.jsonc`), and signs you in with `armoriq login --product armoropencode` from `@armoriq/sdk`. Comments and other settings in the config are preserved. Running the same command again updates an existing install to the newest release, keeps its backend, and skips sign-in when a login already exists. It exits non-zero and reports that nothing was installed if any step fails.

OpenCode 1 and OpenCode 2 read the same config and both load that one `plugin` entry, so the installer writes the same entry whichever major you have. It finds every OpenCode it can (`opencode` and `opencode2` on `PATH`, and `~/.opencode/bin`) and reports each version. When OpenCode 2 is installed, it starts a private OpenCode 2 server on a free port, with a throwaway data directory, and fails if that server does not load the plugin (it only warns when the check itself cannot run). A release without an OpenCode 2 entry is refused when OpenCode 2 is the only OpenCode present; next to OpenCode 1, it installs for OpenCode 1 and warns that OpenCode 2 is not guarded. OpenCode 2 does not read `config.json`, so with OpenCode 2 present the entry goes to `opencode.json` instead; if `config.json` is your only config and lists other plugins, the installer asks you to rename it to `opencode.json` first, because OpenCode 1 would otherwise stop loading them.

| Variable | Default | Purpose |
|---|---|---|
| `ARMORIQ_BACKEND_URL` | the installed backend, else `https://api.armoriq.ai` | Backend to sign in to and pass to the plugin. Staging is `https://staging-api.armoriq.ai`. |
| `ARMOROPENCODE_GIT_REF` | the newest release tag | Branch or tag to install instead. |

To uninstall, run `uninstall_armoropencode.sh` (or the installer with `--uninstall`). It removes only the plugin entry, from both the `plugin` and the OpenCode 2 `plugins` arrays, and keeps your ArmorIQ login. Add `--purge` to also delete `~/.armoriq/armoropencode`.

### Upgrading to OpenCode 2

`opencode upgrade --major` replaces OpenCode 1 with OpenCode 2 and leaves your config as it was. OpenCode 2 reads the same ArmorOpenCode entry, but it loads it only from a release with OpenCode 2 support, and it skips an older one without any message. After upgrading, run the installer again:

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
```

It moves your install to the newest release, keeps your backend and login, and checks with OpenCode 2 that the plugin loads. Start a new OpenCode session afterwards.

From the release that adds this check, when OpenCode 1 and OpenCode 2 are both installed and the install has no OpenCode 2 entry, the OpenCode 1 plugin warns about it (older releases do not): a line in the OpenCode log at startup and a toast in the first session. To check by hand, re-run the installer, which reports `OpenCode 2.x.y loads ArmorOpenCode: active`, or look for a `loading plugin` line naming `armoropencode` in `~/.local/share/opencode/log/opencode.log` after starting OpenCode 2. `opencode plugin list` does not list local plugins.

For the ArmorIQ console update banner shown to OpenCode users:

> OpenCode 2 needs the latest ArmorOpenCode. If you upgraded with `opencode upgrade --major`, run `curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash` again, then start a new session. Until you do, OpenCode 2 sessions are not guarded.

The OpenCode 1 plugin exports the same check as `findOpenCode2Gap()` and the warning text as `OPENCODE2_UNGUARDED` in `src/io/opencode2.ts`.

To release, a maintainer merges a pull request that sets `version` in `package.json` and gives that version a section in [CHANGELOG.md](CHANGELOG.md). On the push to `main`, the `Release` workflow tags `v<version>` and publishes a GitHub release with that section as its notes.

## Local usage reports

Inspect OpenCode token usage and tool calls across retained sessions and models. Compare actual usage with per-session and overall token budgets. Run everything locally without changing OpenCode's configuration.

## Run a report

For the Python collector and the verified website flow, read [the onboarding guide](docs/onboarding.md).

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

The intended production website is `https://tools.armoriq.ai`. The Python telemetry collector runs independently and does not modify OpenCode settings.

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
