# ArmorOpenCode

## Install the OpenCode plugin

Requires OpenCode 1.18 or later or OpenCode 2, and Node.js 20+ or Bun.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
```

The installer clones the newest `v<version>` release of this repository into `~/.armoriq/armoropencode/plugin` (or `main` before the first release), installs its runtime dependencies, adds that directory to the `plugin` array of your global OpenCode config (`~/.config/opencode/opencode.json` or `.jsonc`), and signs you in with `npx -y @armoriq/sdk-dev@^0.8.17 login --product armoropencode --backend https://api.armoriq.ai`. Comments and other settings in the config are preserved. Running the same command again updates an existing install to the newest release, keeps its backend, and skips sign in when a login already exists. Signing in is optional: if you skip it (`--skip-login` or `ARMOROPENCODE_SKIP_LOGIN=1`), decline it, or it fails, the plugin is still installed and runs in monitor mode, recording tool calls without blocking any, and the installer prints the command to sign in later. Once you sign in, the plugin follows your workspace's mode (see [Workspace mode](#workspace-mode)). Any other failed step exits nonzero and reports that nothing was installed.

For staging, use `npx -y @armoriq/sdk-dev@^0.8.17 login --product armoropencode --backend https://staging-api.armoriq.ai`. With `ARMORIQ_BACKEND_URL` or a `backendUrl` plugin option, replace the origin after `--backend` with the backend you use. Quote a custom origin with single quotes.

OpenCode 1 and OpenCode 2 read the same config and both load that one `plugin` entry, so the installer writes the same entry whichever major you have. It finds every OpenCode it can (`opencode` and `opencode2` on `PATH`, and `~/.opencode/bin`) and reports each version. When OpenCode 2 is installed, it starts a private OpenCode 2 server on a free port, with a throwaway data directory, and fails if that server does not load the plugin (it only warns when the check itself cannot run). A release without an OpenCode 2 entry is refused when OpenCode 2 is the only OpenCode present; next to OpenCode 1, it installs for OpenCode 1 and warns that OpenCode 2 is not guarded. OpenCode 2 does not read `config.json`, so with OpenCode 2 present the entry goes to `opencode.json` instead; if `config.json` is your only config and lists other plugins, the installer asks you to rename it to `opencode.json` first, because OpenCode 1 would otherwise stop loading them.

| Variable | Default | Purpose |
|---|---|---|
| `ARMORIQ_BACKEND_URL` | the installed backend, else `https://api.armoriq.ai` | Backend to sign in to and pass to the plugin. Staging is `https://staging-api.armoriq.ai`. |
| `ARMOROPENCODE_GIT_REF` | the newest release tag | Branch or tag to install instead. |
| `ARMOROPENCODE_SKIP_LOGIN` | unset | `1`, `true` or `yes` installs without signing in, like `--skip-login`. |
| `ARMOROPENCODE_NO_AUTO_UPDATE` | unset | `1` turns off the plugin's self-update. Set it where OpenCode runs. |
| `ARMORIQ_USAGE_PING_DISABLED` | unset | `1`, `true` or `yes` disables the anonymous daily ping, ignoring case. |
| `DO_NOT_TRACK` | unset | `1` or `true` disables the anonymous daily ping, ignoring case. |
| `ARMORIQ_SIGNIN_REMINDER_DISABLED` | unset | `1`, `true` or `yes` hides the daily sign in reminder, ignoring case. |
| `ARMORIQ_INTENT_VALIDITY_SECONDS` | `3600` | Intent token lifetime in seconds, from `180` to `3600`. Set it in the environment that starts OpenCode. Invalid values stop plugin startup and name this variable in the error. |
| `ARMORIQ_RUN_REPORTING_ENABLED` | `false` | Set to `true` in the environment that starts OpenCode to report prompt runs. Enable it only after every serving backend revision supports prompt ids. |

Run reporting persists each root prompt from its start, including authenticated monitor sessions. Reports contain ids, times, tool counts and plan outcomes. They contain no prompt text or tool arguments. A run keeps the login it started under. Delivery waits while you are logged out or using another login. Runs started while logged out are never uploaded. Older backends that return 404 pause delivery and keep reports locally, with probes starting at 5 minutes and backing off to 1 hour. `/armor status` shows pending and paused run reports. Reporting is off by default during the backend rollout. OpenCode 2 counts every nested pre hook, so a repeated hook for one nested call counts twice.

Health reporting is on by default and sends diagnostic counts to `/iap/client-events`. `/armor status` shows its pending and dead letter counts on the `Health:` line. A backend `org_required` response keeps health events and run reports locally and shows `local hold (org_required)` in status. The hold retries after 5 minutes, backing off to 1 hour, and lifts when a send succeeds.

To uninstall, run `uninstall_armoropencode.sh` (or the installer with `--uninstall`). It removes only the plugin entry, from both the `plugin` and the OpenCode 2 `plugins` arrays, and keeps your ArmorIQ login. Add `--purge` to also delete `~/.armoriq/armoropencode`.

### Workspace mode

Signed in, the plugin follows the mode your workspace picks under **Tool calls in the chat** on the Monitor page of ArmorIQ Tools. The plugin asks for it when a session opens and keeps the last answer in `~/.armoriq/armoropencode/org-mode.json`; until it has one, it runs Quiet.

| Mode | A call your policy blocks or holds | What OpenCode shows |
|---|---|---|
| Quiet (the default) | Runs, and is listed under Would have blocked on the Monitor page | Nothing from ArmorIQ |
| Show in chat | Runs, and is listed on the Monitor page | One notice per call: `ArmorIQ would block this call in Enforce (<reason>). Monitor let it run.` (a toast on OpenCode 1, a session notice on OpenCode 2) |
| Block | Is blocked, and a held call waits for a workspace approval | The block reason |

In Quiet and Show in chat no intent plan is asked for, no approval request is filed and an unreachable backend blocks nothing. Your local and workspace policies still run on every call, which is how the Monitor page knows what Block would have done. `ARMORIQ_ORG_MODE=enforce` makes one machine block whatever the workspace says.

### Updates

The plugin updates itself, so a new release reaches every install without re-running the installer. Once a day, when OpenCode loads it, the plugin asks the repository it was installed from (the checkout's `origin`) what it should be running, using `git ls-remote`, the same lookup the installer uses:

- A stable install sits on a release tag, `vX.Y.Z`. It moves to the newest `vX.Y.Z` tag when that tag is newer. Prerelease tags are never offered.
- A dev channel install (`install_armoropencode_dev.sh`, which sets `ARMOROPENCODE_GIT_REF=dev`) sits on the `dev` branch. It moves to the branch's newest commit whenever that commit differs from the installed one, whether or not the version changed.
- Any other checkout, such as a detached commit or a plugin loaded from a development clone, does not update itself.

The newer build is cloned and its dependencies installed in `~/.armoriq/armoropencode/plugin.staged`, off the startup path, while the running install stays untouched. When that OpenCode process exits, the staged tree is renamed into place and the replaced one is kept as `plugin.previous`, so the next start runs the new code. The swap waits for the exit because a running process would otherwise load parts of the new tree under the old code. A process ended by a signal it does not handle skips that step, so a build that has waited three days for a clean exit is applied at the next start instead. On OpenCode 2 the plugin runs in the background service (`opencode service`), so the new code runs once that service restarts; `opencode run --standalone` uses a private server that exits with the run. The swap is refused, and the staged tree kept, when the installed checkout has local changes. A failure at any step leaves the current version running. OpenCode 1 shows a toast for each step; OpenCode 2 writes them to `~/.armoriq/armoropencode/logs/opencode-v2.log`.

Releases are cut from `main`: a pull request that bumps `version` in `package.json` and dates its `CHANGELOG.md` section makes the Release workflow tag `vX.Y.Z` at the merge commit.

### Privacy and sign in reminders

ArmorOpenCode makes at most one anonymous usage ping attempt per UTC day, whether you are signed in or not, to a recognized production or staging backend. Delivery is best effort. It sends a random install id, the plugin and host names and versions, OS, whether you are signed in, the environment, and daily totals of plans, blocks and approval requests counted while signed out. Totals cover up to seven earlier days. The random id lives in `~/.armoriq/install-id`, is shared by ArmorIQ plugins, is separate from your sign in device id, and is sent only with these pings.

The ping never contains prompts, plans, tool names or arguments, paths, repository names, hostnames, emails, keys, device ids or IP addresses. ArmorIQ's app never stores the sender's IP address. Google Cloud's request logs record it at the infrastructure level.

To disable the ping, set `ARMORIQ_USAGE_PING_DISABLED=1` or `DO_NOT_TRACK=1`, put `"usagePing": false` in `~/.armoriq/settings.json`, or set `"usagePing": false` in the ArmorOpenCode plugin options. Any off switch wins. Malformed or unreadable shared settings disable the ping and the reminder for that run. Other backend origins send no ping and show no daily reminder. The installer prints the notice once and respects the ping environment switches and shared settings.

When you are not signed in, a daily reminder gives you the command for your backend so you can see your plans and blocks on your dashboard. It appears at most once per UTC day per environment. OpenCode 1 shows a 20 second toast, with the privacy notice in a separate toast on the first run. OpenCode 2 shows one local notice, with its text excluded from model context. Hide the reminder with `ARMORIQ_SIGNIN_REMINDER_DISABLED=1`, `"signInReminder": false` in `~/.armoriq/settings.json`, or `"signInReminder": false` in the plugin options. Ping switches, including `DO_NOT_TRACK`, do not hide the reminder. The reminder sends nothing and creates no install id.

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

## Durable audit storage

New audit journals use `~/.armoriq/armoropencode/outbox/audit-v2/` and names beginning with `queue-`. Released v0.2.x sessions keep using their own `outbox/audit/` files. This version never rewrites, renames or deletes those released files, and never reads their rows for delivery. Those rows contain neither a backend and credential binding nor a stable backend row id, so sending them under your current login could misattribute or duplicate them. `/armor status` counts them as "written by an older version, not sent by this version". A released session that is still running keeps delivering its own rows.

Journals remain bound to the backend and credential that captured them. Network outages and temporary backend errors keep rows pending without consuming the refusal allowance. Authentication pauses recover through an authenticated probe every two minutes while the original credential remains available, or through a successful authenticated call with that same backend and credential. Tool content keeps the released capture limits.

Damaged journal lines are preserved in `corrupt/` and counted in `/armor status`; readable rows continue to drain and both OpenCode hosts keep guarding. Settled journals from stopped writers move to `archive/`, and compaction keeps earlier journals in `history/`. Dead letters remain in their journal and in private files under `dead/`. Keep these folders if you need the retained audit history.

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
