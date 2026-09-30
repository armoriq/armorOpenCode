# Iteration 1 verification

Verification used the actual retained OpenCode database on this MacBook and separate synthetic fixtures for cases absent from that database. No model request was needed to read historical telemetry.

## Real history

Run from the repository root.

```sh
python3 scripts/verify_local.py "$HOME/.local/share/opencode/opencode.db"
```

The CLI matched an independent SQL calculation.

| Measurement | Result |
| --- | ---: |
| Sessions | 11 |
| Provider/model identities | 4 |
| Normalized tokens | 138,204,004 |
| Tool calls | 944 |
| Completed tools | 939 |
| Failed tools | 5 |
| Fresh input tokens | 11,434,189 |
| Output tokens | 151,241 |
| Reasoning tokens | 123,148 |
| Cache reads | 126,495,426 |
| Cache writes | 0 |

The script also checked repeated scans, every model filter, and both budget scopes. The initially retained sessions begin on September 2, 2026. This database does not establish two months of coverage.

The real corpus has no multi-step assistant messages or inherited fork messages. Those accounting cases require synthetic tests rather than claims of real-session coverage.

## Synthetic integration tests

```sh
python3 -m unittest discover -s tests -v
```

All 22 tests passed on the local Python 3.9 runtime. They exercise the public CLI with temporary SQLite and legacy JSON sources. Coverage includes multiple finish steps, updated and deleted records, repeated sources, forks, zero and exceeded budgets, per-session overrides, cache and reasoning counts, inclusive dates, unknown identities, partial sources, orphan tools, output files, and content exclusion. Output-collision tests verify that source databases, WAL and SHM files, legacy history, aliases, and budget configuration remain unchanged.

Separate read-only review reproduced and retested the legacy date fallback and incomplete-source budget cases. Its fixtures also checked newest legacy records across source order, multiple finish steps, inherited usage, tool states, and excluded content.

## Browser checks

The standalone dashboard generated from real history was served only on `127.0.0.1` for verification.

- The default dashboard displayed the reconciled overall totals and four model rows.
- Selecting Union Alpha displayed 666,946 tokens, 24 tools, and two sessions.
- Selecting its session displayed model steps and tool outcomes, including failed calls and recorded durations.
- A no-match search displayed explicit empty states for models, sessions, traces, daily usage, and tools.
- A report with configured session and overall targets displayed the corresponding comparisons.
- A report from a missing source displayed unknown token usage and an incomplete target comparison.

CLI JSON export produced the expected schema and reconciled totals. The browser's JSON download could not be observed through the in-app browser automation, which timed out waiting for a download event. Chrome is unavailable to this automation environment, so browser-download completion remains unverified.

The dashboard is a static snapshot. There is no asynchronous history loading state. Pending and running tools are covered by synthetic CLI tests because the retained real corpus contains completed and failed tools only.

## Limits

Website upload, live plugin events, intent hooks, and policy enforcement are outside iteration 1. No backend deployment or remote repository publication was performed. The checked-in CI workflow runs tests on Python 3.9, 3.11, and 3.13 after a future push. Only Python 3.9 was executed locally.

No prompt, reasoning, tool-input, or tool-output content is needed in the report. The generated local artifacts are ignored by Git.
