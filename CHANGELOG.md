# Changelog

All notable changes to the ArmorOpenCode plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To release, open a pull request that sets `version` in `package.json` and renames `Unreleased` to `[x.y.z] - YYYY-MM-DD`. When it reaches `main`, the Release workflow tags `vx.y.z` and publishes a GitHub release with that section as its notes.

## [Unreleased]

### Changed
- Moves to the stable channel: depends on `@armoriq/sdk` 0.8.23 instead of `@armoriq/sdk-dev`, and the installer signs in with `@armoriq/sdk`'s `armoriq` CLI. Production (`https://api.armoriq.ai`) stays the default; `ARMORIQ_BACKEND_URL=https://staging-api.armoriq.ai` still selects staging (https://github.com/armoriq/armorOpenCode/issues/166).

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
