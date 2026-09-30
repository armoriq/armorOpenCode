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

## Future website boundary

The metadata-only JSON report has a schema version. The current project does not upload it. Prompt text, reasoning text, tool arguments, tool outputs, titles, and project paths are excluded from the export.

The checked-in ArmorIQ backend and tokenstat upload contracts differ. Website integration must add an OpenCode product identity and settle dated token, reasoning, tool, and device fields before upload can be implemented correctly.

## Inspected upstream sources

- [OpenCode plugins](https://opencode.ai/docs/plugins/).
- [OpenCode 1.18.31 usage normalization and fork implementation](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/opencode/src/session/session.ts).
- [OpenCode 1.18.31 model-step processor](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.31/packages/opencode/src/session/processor.ts).
- [ccusage OpenCode reporting](https://ccusage.com/guide/opencode/).
