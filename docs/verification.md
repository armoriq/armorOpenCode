# Iteration 1 verification

This is a historical iteration record. For the current collector and Armor Tools integration, use [README](../README.md).
Verification used the actual retained OpenCode database on this MacBook and separate synthetic fixtures for cases absent from that database. No model request was needed to read historical telemetry.

## Real history

Run from the repository root.

```sh
python3 scripts/verify_local.py "$HOME/.local/share/opencode/opencode.db"
```

The CLI matched an independent SQL calculation.

The independent SQL reconciliation passed for the retained local database, repeated scans, every model filter, and both budget scopes. Private totals are deliberately omitted from this repository. The retained history does not establish two months of coverage.

The real corpus has no multi-step assistant messages or inherited fork messages. Those accounting cases require synthetic tests rather than claims of real-session coverage.

## Synthetic integration tests

```sh
python3 -m unittest discover -s tests -v
```

The original 22 tests passed on the local Python 3.9 runtime. They exercise the public CLI with temporary SQLite and legacy JSON sources. Coverage includes multiple finish steps, updated and deleted records, repeated sources, forks, zero and exceeded budgets, per-session overrides, cache and reasoning counts, inclusive dates, unknown identities, partial sources, orphan tools, output files, and content exclusion. Output-collision tests verify that source databases, WAL and SHM files, legacy history, aliases, and budget configuration remain unchanged.

Separate read-only review reproduced and retested the legacy date fallback and incomplete-source budget cases. Its fixtures also checked newest legacy records across source order, multiple finish steps, inherited usage, tool states, and excluded content.

## Original browser checks

The iteration 1 standalone dashboard was served only on `127.0.0.1` for verification. Browser checks covered model selection, session traces, empty search results, both budget scopes, and a missing source. CLI JSON export passed. Browser-download completion remained unverified because the in-app browser did not expose its download event.

Iteration 2 removes this renderer from the collector and places the dashboard in the website repository. See [the website boundary](iteration-2.md) for the current design and validation record.

## Limits

Cloud upload, live plugin events, intent hooks, and policy enforcement remain outside this iteration. No backend deployment or remote repository publication was performed. The checked-in CI workflow runs tests on Python 3.9, 3.11, and 3.13 after a future push. Only Python 3.9 was executed locally.

No prompt, reasoning, tool-input, or tool-output content is needed in the report. The generated local artifacts are ignored by Git.
