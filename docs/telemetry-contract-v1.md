# ArmorIQ telemetry ingestion envelope v1

This document defines the small ingestion envelope that ArmorClaude, ArmorCodex, and ArmorOpenCode may send to `tools.armoriq.ai`. Each product keeps its own runtime, installer, collector, and release cycle. The envelope keeps dashboard fields and ownership rules consistent.

The contract answers three questions for every session:

- what was recorded: token usage and tool-call counts, grouped by exact model;
- what was expected: the configured session and account totals;
- how complete the record is: coverage and unknown-value diagnostics.

A producer may collect richer local data, but the v1 export must not contain prompt text, model reasoning, tool arguments, tool results, repository paths, API keys, or raw machine identifiers.

## Envelope

Each record is a JSON object with these required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | Contract version, currently `telemetry.v1`. |
| `product` | enum | `armorclaude`, `armorcodex`, or `armoropencode`. |
| `sessionId` | string | Stable producer session identifier. It is not a user identity. |
| `usageDate` | string | UTC date (`YYYY-MM-DD`) used for daily aggregation. |
| `models` | array | One entry per exact provider/model name observed in the session. |
| `tools` | object | Metadata-only tool-call counts and coverage. |
| `budgets` | object | Configured session and account totals, when configured. |
| `coverage` | object | Explicit completeness and unknown-value counters. |

`ownerId`, email addresses, and account credentials are deliberately absent from the producer payload. The ingestion service derives the owner from the authenticated account or API key and rejects caller-supplied owner fields.

### Model entries

Each `models` entry has an exact `model` string and a `tokens` object. Token values are integers when known and `null` when the source did not expose that counter. A producer must not convert missing values to zero.

```json
{
  "model": "provider/model-name",
  "tokens": {
    "input": 1200,
    "output": 340,
    "reasoning": null,
    "cacheRead": 0,
    "cacheWrite": 0,
    "total": 1540
  },
  "recordedCost": null,
  "currency": "USD",
  "pricing": {
    "status": "unknown",
    "source": null,
    "asOf": null
  }
}
```

`total` is the producer-reported total when available. Consumers may calculate a displayed total only from non-null components and must label it as calculated. `recordedCost` is never inferred from a stale hard-coded price table. If pricing is unavailable or the model is unknown, `pricing.status` is `unknown` and the UI shows usage without a fabricated price.

### Tool metadata

The v1 tool object is intentionally aggregate and metadata-only:

```json
{
  "calls": 7,
  "completed": 6,
  "failed": 1,
  "unknown": 0,
  "byName": {
    "read": 3,
    "write": 2,
    "search": 2
  }
}
```

A future live-event contract may add opaque `traceId`, `turnId`, and `toolCallId` values. It must not add arguments or results. A call is counted once, even when a producer retries a sync operation.

### Budgets

Budgets distinguish configured targets from observed usage:

```json
{
  "session": { "limit": 10000, "actual": 1540, "remaining": 8460, "status": "within" },
  "account": { "limit": null, "actual": 1540, "remaining": null, "status": "unconfigured" }
}
```

`actual` is the sum of known token totals for the record. A `null` limit means no budget was configured; it is not an unlimited promise. `status` is one of `within`, `exceeded`, `unconfigured`, or `unknown`.

### Coverage and diagnostics

Coverage is part of the contract so dashboards cannot imply that an absent counter was observed as zero:

```json
{
  "source": "opencode.sqlite",
  "sessionsScanned": 1,
  "turnsScanned": 14,
  "modelsObserved": 2,
  "unknownModels": 0,
  "missingTokenFields": 3,
  "historyComplete": true,
  "warnings": []
}
```

A producer that cannot prove complete history sets `historyComplete` to `false` and explains why in `warnings`. Inherited sessions, unknown models, and unsupported tool events are counted explicitly.

## Producer mapping

| Producer | Local source | Canonical mapping | Current boundary |
| --- | --- | --- | --- |
| ArmorClaude | Hook transcript and SDK observability bridge | One model entry per exact model; token fields from the authoritative usage event; aggregate tool metadata | Existing production payloads need an adapter and privacy review before ingestion. |
| ArmorCodex | Hook transcript and disk-backed observability replay | Same model and token fields; replay must remain idempotent | Existing product payload is org-scoped and does not yet carry OpenCode-compatible coverage. |
| ArmorOpenCode | Read-only OpenCode history plus supported live hook events | One model entry per exact provider/model; historical unknowns remain unknown | The TypeScript policy installer and Python history collector are separate components until issue #15 is resolved. |

The remote ArmorOpenCode policy installer remains the owner of OpenCode configuration, intent policy, and MCP/plugin setup. The local Python collector is a candidate telemetry implementation. It must be ported into an isolated package or published as a separate artifact before it can be included in the curl installer. No PR may replace the policy installer with the collector by changing the package root, installer entrypoint, or release artifact without an explicit migration decision.

## Invariants

1. **Per-model preservation.** A session with model switches produces one entry for every exact model observed; later events never overwrite an earlier model.
2. **Idempotent aggregation.** Replaying the same source produces the same record. Sync keys are `(product, sessionId, model, usageDate)` plus the authenticated owner at ingestion.
3. **Missing is not zero.** Unknown token or tool counters remain `null` or increment `unknown`.
4. **Owner is server-derived.** The producer never chooses the dashboard owner, and a dashboard query cannot request another owner by ID.
5. **Privacy by construction.** Prompt/reasoning text, tool payloads, project paths, secrets, and raw device identifiers are excluded from the v1 export.
6. **Pricing provenance.** Every displayed price is tied to a versioned source and effective date. Unknown models have no estimated price.
7. **Compatibility is explicit.** Producers send `schemaVersion`; consumers reject unsupported major versions with an actionable error.

## Compatibility and rollout

Phase P0 freezes this document and the example fixture. Phase P1 adds opt-in OpenCode historical sync against this shape. Phase P2 adds metadata-only live tool events. Phase P3 adds owner-scoped ingestion and dashboard reads. Phase P4 packages the selected implementation into a versioned, checksum-protected release. Existing Claude and Codex payloads are adapted at the ingestion boundary until their producers emit v1 directly.

The contract does not authorize network collection by itself. Collection remains opt-in, credentials are user-specific, and a local report must continue to work without network access.
