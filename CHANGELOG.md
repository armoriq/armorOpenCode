# Changelog

All notable changes to the ArmorOpenCode plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To release, open a pull request that sets `version` in `package.json` and renames `Unreleased` to `[x.y.z] - YYYY-MM-DD`. When it reaches `main`, the Release workflow tags `vx.y.z` and publishes a GitHub release with that section as its notes.

## [Unreleased]

### Added
- Workspace Monitor. Signed in, the plugin follows the mode set on the Tools Monitor page: Quiet (the default) runs every call and records on its audit row what Block would have done (`would_be`, `would_be_code`, `would_be_reason`); Show in chat also shows a notice for each such call; Block enforces as before. In Quiet and Show in chat no intent plan is required, no approval request is filed and a backend outage blocks nothing. `ARMORIQ_ORG_MODE=enforce` forces Block on one machine. Requests send `X-ArmorIQ-Monitor-Aware: 1`.

### Fixed
- The ArmorIQ directory is now protected by resolved path rather than by spelling: shell quoting, escapes, globs, `cd`, symlinks and relative paths are resolved before the check, and glob and grep patterns are resolved against their root. A `task` prompt that names a protected path is blocked as well.
- The OpenCode config that loads the plugin (`opencode.json`, `opencode.jsonc`, any `.opencode` folder and the global OpenCode config directory) can no longer be changed by the agent's write, edit or patch calls, or by shell commands that write files. Reading it, with the read tool or a read-only shell command, still works.
- Protected-path blocks now apply in every mode, including workspace Monitor and signed out.

## [0.2.2] - 2026-11-17

A release with no functional change, cut to carry the first self-update: every 0.2.1 install moves to it by itself.

### Changed
- Version 0.2.2. The plugin and installer are the same as in 0.2.1.

## [0.2.1] - 2026-11-16

Self-update. From this release on, ArmorOpenCode installs newer releases by itself. Installs on 0.2.0 cannot update themselves, so run the installer once more to move to 0.2.1; after that, releases arrive without it.

### Added
- The plugin updates itself (#186). Once a day it checks the repository it was installed from; a stable install moves to the newest release tag and a dev channel install follows the `dev` branch. The new build is staged beside the install, swapped in when OpenCode exits, and runs from the next start; a build that has waited three days for a clean exit is applied at the next start instead. `ARMOROPENCODE_NO_AUTO_UPDATE=1` turns it off.
- An anonymous daily usage ping, local counts of plans and blocks while signed out, and a daily sign-in reminder, each with its own off switch (#182, #183, #184).
- The installer shows the ArmorIQ wordmark, including on a piped install (#178, #179).
- The installer's `--skip-login` flag and `ARMOROPENCODE_SKIP_LOGIN=1` install without signing in.

### Fixed
- A skipped, declined or failed sign-in no longer aborts the install. The plugin is installed in monitor mode, which records tool calls without blocking any, and the installer prints the command to sign in later.
- Re-running the installer kept a branch install on a detached commit and a release install without its tag, so neither could tell what to update to. It now keeps the branch checked out and fetches the tag (#186).
- A stable install that an earlier dev install had pointed at the staging backend is moved to production (#175).

## [0.2.0] - 2026-10-15

OpenCode 2 support. OpenCode 2 drops plugins written for OpenCode 1 without an error, so a user who ran `opencode upgrade --major` kept working with no ArmorIQ guardrails and no telemetry. This release guards both majors from the same package and the same `armoropencode` product: same login, console, policies and billing. OpenCode 1 stays supported.

### Added
- OpenCode 2 support: the plugin loads in OpenCode 2.0 through a root `index.ts`, and one default export serves both majors (OpenCode 1 calls `server`, OpenCode 2 calls `setup`) (#130). The OpenCode 1 hooks moved behind a host-neutral interface with no behavior change (#143).
- OpenCode 2 guard: tool calls are allowed, blocked and audited as on OpenCode 1, with the same deny text, the same audit rows and the same `~/.armoriq` built-in block (#130).
- OpenCode 2 intent plans, drift blocks and the `/armor` command, answered locally without a model turn (#131, #132).
- OpenCode 2 session lifecycle: policy is in force on the first tool call, the intent token is revoked when a session is deleted, and the outbox flushes on unload (#133).
- OpenCode 2 token usage, model ids and traces, built from OpenCode 2's step events so console totals equal `opencode stats` (#135).
- The installer detects OpenCode 1, OpenCode 2 or both and writes an entry both majors load; after `opencode upgrade --major` the existing entry keeps working (#136, #137).
- CI runs the unit suite and a real headless session on OpenCode 1.19 and 2.0, on Linux and macOS (#138).
- The ArmorOpenCode plugin for OpenCode 1.18: per-session intent plans with tokens from the ArmorIQ backend, local and remote policy on every tool call, audit rows, hourly token usage and traces, and the `/armor` command.
- The intent token carries the OpenCode session id as the plan's context id, so the dashboard joins a plan to its session's usage (#94).
- The usage upload carries one call record per model call (#95).

### Changed
- Requires `@armoriq/sdk-dev` 0.8.16 (#93).
- The installer installs the newest release tag instead of `main` (#98).

### Removed
- The installer's npm mode (`ARMOROPENCODE_VERSION`): the package was never published to npm (#98).
