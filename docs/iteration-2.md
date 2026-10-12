# Website ownership and model metadata

This is a historical iteration record. For the current collector and Armor Tools integration, use [README](../README.md).
The collector remains in `armorOpenCode`. The dashboard belongs to `tools-frontend`, whose Cloud Build configuration deploys the website and names `tools.armoriq.ai`. Live domain ownership could not be independently inspected through the available network tools. No deployment was performed.

## Design choice

| Design | User ownership | Scope | Decision |
| --- | --- | --- | --- |
| Website imports a selected local JSON report into memory | Each browser page starts empty and displays only its selected file. Account changes invalidate imports. | Frontend validation and UI, offline collector export. | Use now. |
| Authenticated cloud ingestion with owner and device records | Server derives ownership from verified credentials and scopes every query. | New storage, ingestion, migrations, device authorization, retention. | Later iteration. |

The imported file is user-selected. Login does not prove who generated it. This iteration provides no shared telemetry store, browser persistence, default sample, or automatic upload. This prevents another visitor from receiving the developer's local report as website data.

The existing backend token record has an organization ID but no owner user ID. Its summary uses fixed input and output rates regardless of model. The OpenCode dashboard does not use that summary or those rates.

## Workflow checkpoint

- Blocking first steps. Verify the deployed website's repository configuration, trace authentication and existing telemetry ownership, and inspect the collector's report contract.
- Independent workstreams. One owner changes the website importer and dashboard. Another changes the collector's catalog metadata and removes HTML output. Documentation and independent verification follow those contracts.
- Shared mutable state. Telemetry stays in the website page's memory. The collector opens OpenCode history read-only. Website and collector owners edit separate repositories.
- Smallest safe decomposition. Keep one owner for each repository to avoid competing changes to report validation and accounting. An independent reviewer checks ownership and asynchronous imports.

Model the Domain makes raw provider/model IDs the accounting identity and keeps catalog metadata separate. Boundary Discipline validates imported files before rendering them. Make Operations Idempotent keeps refreshed snapshots from accumulating usage or changing recorded spending.

## Current model and price verification

On September 30, 2026, the official [Models.dev provider API](https://models.dev/api.json?type=all) returned a catalog containing 225 providers. Its current exact `opencode/big-pickle` and `opencode/muse-spark-1.3-contributor-free` entries contain zero input, output, and cache-read rates. The Muse entry does not publish a cache-write rate. Exact entries for `opencode/union-alpha` and `tensormux/gemma-4-31b` were absent.

The [OpenCode Zen price documentation](https://opencode.ai/docs/zen/#pricing) also lists Big Pickle and Muse Spark Contributor Free as free for a limited time. These observations describe the catalog and documentation on that date. They do not establish historical charges or guarantee future prices.

The collector's catalog refresh is explicit. Reports use the saved snapshot offline and include its provenance. Snapshots older than seven days are marked stale. That age threshold is a refresh reminder, not a guarantee that prices remain unchanged within seven days. An unmatched model has unknown rates. A paid variant does not supply rates for a free alias or a different provider. Catalog refresh cannot change OpenCode's recorded cost. No estimated invoice is implemented.

Current-rate metadata describes base token components only. Context tiers, reasoning rates, and audio rates can differ. The report flags additional rate fields without applying them to history. Missing component rates remain null, including cache-write rates that a provider does not publish.

## Future server ownership

Authenticate the ingest caller and derive the owner on the server. Register and authorize each device. Use owner, device, session, message, and step or call identities for deduplication. Replayed complete snapshots should produce the same state. An older snapshot must not replace a newer one, and incomplete scans must not erase valid retained records.

Each read, export, and deletion must include the authenticated owner in its query. Membership in the same organization is insufficient. Legacy organization totals cannot be assigned to people without ownership evidence. Validate telemetry facts and recompute aggregates instead of trusting uploaded summary totals.

## Verification

The collector passed 33 integration tests and Python compilation on the local Python 3.9 runtime. An independent verifier ran the public catalog refresh against the actual provider API, generated a report from the retained local OpenCode database, and ran the independent SQL reconciliation. Usage, tools, budgets, and recorded costs matched the report produced without catalog enrichment. Two exact metadata matches and two missing matches remained visible.

The website passed 93 tests, including 30 OpenCode import, accounting, preview, and account-boundary tests. The coverage command and production TypeScript/Vite build passed. Repository-wide lint reports nine errors and 240 warnings. A temporary archive of the unchanged frontend HEAD reproduced the same counts and error files. The new OpenCode files have no lint findings.

The actual website route opened in the in-app browser at `http://127.0.0.1:5174/tools/armoropencode/dashboard`. It displayed the empty report state and local development preview notice. A screenshot is saved in ignored `output/dashboard-website.jpg`. There is no developer telemetry loaded by default.

The documented file-chooser API timed out after clicking the actual file input. Native picker fallback was blocked because computer-use tools cannot control the Codex application. Actual browser import, model filtering, traces, clear, and refresh after import remain unverified. The real generated report and real missing-source export both passed the frontend's parser through an independent executable check. Synthetic UI tests cover imports, filters, account changes, and stale reads separately.

Production login, production cross-account transitions, cloud synchronization, and deployment remain unverified. No repository was pushed and no site was deployed. The local preview server remains running for review.
