# OpenCode historical telemetry

This package is separate from `scripts/install.ts`. It never edits `opencode.json`,
`AGENTS.md`, MCP configuration, or ArmorIQ credentials. It reads one or more
OpenCode SQLite databases with a read-only connection and produces the
`telemetry.v1` ingestion envelope documented in `docs/telemetry-contract-v1.md`.

P1 is deliberately local and opt-in. The sync command is disabled unless both
`--enable` and a non-empty `ARMORIQ_API_KEY` are present. Credentials are only
used as an enablement signal; no network transport exists in this phase. The
result is written to an append-only local NDJSON queue for a future owner-scoped
transport. P1 never uploads; the transport seam is owned by P3. Selecting
multiple databases is supported only when their OpenCode row IDs do not collide.

```sh
ARMORIQ_API_KEY=... bun telemetry/cli.ts sync \
  --source ~/.local/share/opencode/opencode.db \
  --enable
```

Use `--dry-run` to scan and validate without changing the queue. Re-running a
scan with unchanged data is idempotent. A changed session/day payload replaces
the pending record for that batch key; model-level keys are retained in the
queue for the future server ingest layer.

P2 adds a pure live metadata adapter for a future OpenCode hook integration.
It accepts only lifecycle fields such as session ID, turn ID, exact model,
tool name, call ID, status, timestamp, and token counters. Prompt text,
reasoning text, tool arguments, tool results, repository paths, and credentials
are not part of the event type and are discarded when an untyped input is
normalized. Duplicate event IDs are ignored so retries do not inflate counts.
The adapter produces the same `telemetry.v1` shape with `coverage.source`
set to `opencode.live`; it remains local until the authenticated transport
phase is implemented.
