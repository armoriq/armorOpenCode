# Iteration 1

Create an independent local repository in `armor-iq/armorOpenCode`. Read OpenCode history without changing the agent, display session and total usage, and expose a versioned metadata-only JSON report for future website integration.

## Workflow

- [x] `how` over the affected subsystem.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent with a specific scope and named data shape.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Stack follow-ups. The new repository has an implementation commit followed by documentation. No existing history needs rebasing.
- [x] If the design is contested, `interrogate` before shipping. Independent review selected the history design and caught accounting and output-protection defects before delivery.
- [x] Run Opening a PR. Skip remote publication because this iteration is requested inside the local workspace only.

## Throughput checkpoint

- Blocking first steps. Inspect the installed OpenCode schema and token semantics before implementation.
- Independent workstreams. Compare history-first and plugin-first designs. Keep one implementation owner for the importer, report, and CLI contract.
- Shared mutable state. OpenCode owns its database. The collector opens it read-only and computes a fresh snapshot. Design candidates do not write production files.
- Smallest safe decomposition. One implementation owner avoids competing changes to token accounting. A separate verifier checks real local history and the finished CLI.

## Scope

- All retained sessions and all provider/model identities, including unknown models.
- Tool counts, tool names, outcomes, durations, and session trace metadata.
- Input, output, reasoning, cache-read, and cache-write tokens with recorded totals kept distinct from component totals.
- Daily, model, session, and overall reports.
- Optional per-session and overall token budgets. Unset budgets stay unknown.
- SQLite history plus older JSON storage, with explicit data-quality warnings.
- Local report and JSON export. Cloud upload and intent policy enforcement are later iterations.

## Observations

The installed OpenCode version is 1.18.31. Its local database initially contains 11 sessions, 937 assistant messages, and 944 tool parts. Four recorded provider/model identities exist. The retained session creation range begins on September 2, 2026. No conclusion about deleted or archived history follows from those counts.

ArmorClaude captures intent before tools execute and keeps tool observability separate from token accounting. The existing tokenstat tool imports Claude and Codex history. Its cloud payload differs from the checked-in backend DTO, so this repository must keep the future upload contract explicit.

The user requested both session and overall comparison. Iteration 1 accepts explicit budgets for each. It does not claim that a budget predicts optimal task usage.
