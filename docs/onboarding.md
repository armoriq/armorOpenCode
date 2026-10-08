# Install the local collector and view your history

This is a historical iteration record. For the current collector and Armor Tools integration, use [README](../README.md).
This guide requires an existing checkout of ArmorOpenCode and Python 3.9 or later. The package and plugin have not been published. The collector is now included in `armoriq/armorOpenCode` on `main`.

## Check OpenCode

Run `opencode --version`. Verification on September 30, 2026 used an existing OpenCode 1.18.31 installation. A fresh OpenCode installation was not tested.

For a new installation, use the [official OpenCode instructions](https://opencode.ai/docs/#install). They list `npm install -g opencode-ai` and `brew install anomalyco/tap/opencode`. The documentation now advertises OpenCode v2. This verification does not establish compatibility with v2.

## Install ArmorOpenCode from the checkout

Run these commands in the ArmorOpenCode repository.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/armor-opencode --version
```

The expected version is `0.1.0`. The package has no runtime dependencies. Building it can download setuptools from PyPI.

To use the short command in that shell, activate the environment.

```sh
source .venv/bin/activate
armor-opencode report
```

Without activation, use `.venv/bin/armor-opencode`. Creating a virtual environment alone does not put its commands on your shell's search path.

On this Mac, Apple Python 3.9.6 with SQLite 3.54.0 failed to open a WAL-format OpenCode database without existing sidecar files. The same actual source read successfully with Homebrew Python 3.14.6 and SQLite 3.53.3. If you encounter that combination and `source_unreadable`, create the virtual environment with your existing Homebrew Python, `/opt/homebrew/bin/python3`. The collector retains its ordinary read-only connection. Do not bypass live WAL handling with an immutable connection.

An isolated temporary virtual environment successfully installed this checkout. The installed command returned `0.1.0` when invoked outside the checkout. The verification did not change the user's global Python installation or OpenCode configuration.

## Export your retained history

```sh
.venv/bin/armor-opencode report --format json --output output/opencode-report.json
```

The collector reads the executing user's OpenCode data directory. A plugin is unnecessary for this historical report.

To include both budget scopes, add `--session-budget` and `--total-budget` with your chosen token limits. These are configured targets, not estimates of the ideal usage for a task.

To include current model metadata, refresh a catalog snapshot before exporting.

```sh
.venv/bin/armor-opencode catalog refresh --output output/models.json
.venv/bin/armor-opencode report --model-catalog output/models.json --format json --output output/opencode-report.json
```

Catalog metadata uses exact provider and model IDs. Unknown models remain visible. Current rates do not replace historical recorded costs.

## Open the website and import the report

The intended destination is [the OpenCode dashboard](https://tools.armoriq.ai/tools/armoropencode/dashboard). On September 30, the public URL reached the live sign-in page at `/auth`. The observed redirect did not retain a visible `returnTo` parameter. Post-login navigation was not tested. These dashboard changes have not been deployed.

In the local website preview, click **Import report** and select the exported JSON. The page starts empty and displays only the selected file. It keeps the report in page memory without uploading telemetry or saving it in browser storage.

Actual browser verification passed for real-history import, the model list, a model filter, session selection, tool traces, exact catalog matches, unknown catalog models, invalid-file rejection, clearing the error, and reload after a valid import. Real production login, real account switching, and automatic synchronization remain unverified.

## Plugin and account connection requirements

[OpenCode supports local and npm plugins](https://opencode.ai/docs/plugins/). The ArmorOpenCode plugin does not exist yet. No automatic browser-opening or account-connection command exists in this collector.

The intended next flow is installation, account sign-in, explicit device authorization, historical import, and dashboard navigation. A plugin can then trigger updates after supported session events. Browser navigation alone cannot transfer a report or establish its owner.

Server synchronization must derive the owner from verified authentication and enforce that owner for ingestion and reads. Existing organization-wide token aggregate routes do not establish individual ownership. Verify the complete flow with two real accounts before claiming personal isolation.

Private report screenshots remain in ignored local output. They are not website fixtures or public repository assets.
