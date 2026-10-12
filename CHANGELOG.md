# Changelog

All notable changes to the ArmorOpenCode plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

To release, open a pull request that sets `version` in `package.json` and renames `Unreleased` to `[x.y.z] - YYYY-MM-DD`. When it reaches `main`, the Release workflow tags `vx.y.z` and publishes a GitHub release with that section as its notes.

## [Unreleased]

### Added
- The ArmorOpenCode plugin for OpenCode 1.18: per-session intent plans with tokens from the ArmorIQ backend, local and remote policy on every tool call, audit rows, hourly token usage and traces, and the `/armor` command.
- The intent token carries the OpenCode session id as the plan's context id, so the dashboard joins a plan to its session's usage (#94).
- The usage upload carries one call record per model call (#95).

### Changed
- Requires `@armoriq/sdk-dev` 0.8.16 (#93).
- The installer installs the newest release tag instead of `main` (#98).

### Removed
- The installer's npm mode (`ARMOROPENCODE_VERSION`): the package was never published to npm (#98).
