# Historical telemetry design

ArmorOpenCode reads retained OpenCode history and produces one report. It computes session, model, day, tool, and overall totals from the same snapshot. A fresh scan reflects updated tool states and usage records without accumulating earlier imports.

## Design decision

Two designs were compared before implementation.

| Design | Historical coverage | Operational cost | Decision |
| --- | --- | --- | --- |
| Read-only history snapshot | Existing sessions are available immediately. | One source adapter and pure accounting. | Use in iteration 1. |
| Live plugin and persistent event projections | Requires a separate historical backfill. | Installation, event ordering, reconnection, and reconciliation. | Add when live policies become necessary. |

Independent design review selected the history snapshot. The live-event candidate identified that an assistant message's token fields can hold only its latest model step. Its step-finish precedence rule became part of the selected design.

Model the Domain shaped the session, model identity, usage-step, and tool-call records. Boundary Discipline places input validation in the source adapter and CLI. Separate Before Serializing Shared State keeps the OpenCode database owned by OpenCode and avoids a second mutable ledger in this iteration.

## Token accounting

For each assistant message, the collector sums distinct `step-finish` parts when they exist. Otherwise it uses the assistant message's recorded usage. It never adds both representations.

OpenCode 1.18.31 normalizes input to exclude cache reads and writes, and output to exclude reasoning. The primary total adds input, output, reasoning, cache reads, and cache writes once. Provider-reported totals remain separate because providers can differ in what those totals include. Missing or invalid usage produces a diagnostic. Recorded zero remains zero.

Counts represent retained OpenCode usage. They do not establish invoice charges, context-window size, or reasoning quality. Tool calls have no independent token measurements. The report attributes tools to the model that owns their assistant message without assigning invented per-tool token costs.

## Forked history

The inspected OpenCode version copies message timestamps when it forks a session under new message IDs. Messages created before their owning session are inherited history. Their usage and tools are excluded from new-execution totals and shown separately.

This rule depends on preserved timestamps. Incomplete timestamps or a changed upstream fork format limit certainty and require diagnostics. A normal child session is not automatically inherited history.

## Budgets

Both per-session and overall targets are optional. A configured target is an allowance chosen by the operator. It is not an estimate of the minimum tokens needed for a task. The report compares actual usage with each configured target and shows remaining or excess usage. The overall budget applies to the report's selected scope.

A historical efficiency baseline needs task labels and outcome measurements. That is a separate iteration.

## Website boundary

The metadata-only JSON report has a schema version. The collector does not upload it. Prompt text, reasoning text, tool arguments, tool outputs, titles, and project paths are excluded from the export. The dashboard lives in `tools-frontend`. It imports the selected report into page memory and starts without a dataset. HTML rendering no longer belongs to the collector.

The checked-in ArmorIQ backend and tokenstat upload contracts differ. The current token store has organization ownership but no individual user ownership. It cannot provide personal OpenCode history safely. Future ingestion must derive the owner from verified authentication, authorize device ownership, and include owner and device in record identities. Every read, export, and deletion must constrain the authenticated owner. A user ID supplied inside an export is not evidence of ownership.

## Changing models and prices

Raw provider/model IDs are the accounting identity. Optional catalog snapshots enrich exact matches with current names, families, limits, and rates. Missing models stay visible. Saved catalog metadata includes its source, fetch time, and hashes, so a report can show which snapshot supplied the labels and rates.

Fetching a newer catalog changes metadata only. It never changes tokens, tools, budgets, or OpenCode's recorded cost. Current prices cannot establish historical prices. A future cost estimate must identify the applicable price snapshot and its effective period, including unknown periods and rate components.

## Inspected upstream sources

- [OpenCode plugins](https://opencode.ai/docs/plugins/).
- [OpenCode 1.18.31 usage normalization and fork implementation](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/opencode/src/session/session.ts).
- [OpenCode 1.18.31 model-step processor](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/opencode/src/session/processor.ts).
- [ccusage OpenCode reporting](https://ccusage.com/guide/opencode/).
