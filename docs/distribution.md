# Public distribution

ArmorOpenCode is a Python CLI named `armor-opencode`, at version `0.1.0`. The installed command is `armor-opencode`. Adding that command to one person's `PATH` makes it available in that person's shell. Public release assets or a registry make the package available for other people to install on their own computers. Each installation reads that user's local OpenCode data.

The package is not published by this change. An authorized ArmorIQ publisher must confirm ownership of the PyPI package name before registry publication. The curl installer at the repository root installs the OpenCode plugin, not this collector.

Python is the primary distribution format because the existing collector already runs on Python and has no third-party runtime dependencies. An npm wrapper would require both Node.js and Python for the same command.

## Proposed commands after publication

These commands are proposed until ArmorIQ publishes and verifies the package. Do not present them as working public installation commands yet.

```sh
pipx install armor-opencode
armor-opencode report
```

An alternative uses uv to manage the Python runtime.

```sh
uv tool install --python 3.14 armor-opencode
armor-opencode report
```

The package declares Python 3.9 or later. A local report passed with Homebrew Python 3.14 and SQLite 3.53. The Apple Python 3.9 build with SQLite 3.54 failed a read-only database scan when WAL sidecars were absent. Python version alone does not establish SQLite compatibility. The collector does not use an `immutable` fallback because that mode can miss committed data in a live WAL. Windows installation and database reads have not been verified.

## Build and verify before publication

Run these commands from the collector checkout.

```sh
uv build
uvx twine check dist/*
```

The wheel contains the `armor_opencode` modules, package metadata, and the MIT license. The source archive adds `README.md` and `pyproject.toml`. `MANIFEST.in` starts with an exclusion and then includes the required files. Package data is disabled in `pyproject.toml`.

Inspect both archives before publication. Confirm that they contain no generated reports, screenshots, databases, virtual environments, credentials, or private configuration. A successful metadata check does not verify archive privacy.

Install the built wheel in isolated uv tool directories to test the exact release artifact. Replace the example paths with an empty verification directory and the wheel's actual path.

```sh
UV_TOOL_DIR=/path/to/verification/tools UV_TOOL_BIN_DIR=/path/to/verification/bin uv tool install --python 3.14 /path/to/checkout/dist/armor_opencode-0.1.0-py3-none-any.whl
/path/to/verification/bin/armor-opencode --version
/path/to/verification/bin/armor-opencode report
/path/to/verification/bin/armor-opencode report --format json --output /path/to/verification/report.json
```

The version command must print `0.1.0`. Verify the report against the machine's retained history. Keep generated telemetry outside release archives. Test source archive installation as well because registry users may build from source.

## Publication requirements

Publication requires an ArmorIQ-authorized PyPI publisher, confirmed package-name ownership, and verified archive contents. Build and installation checks can run before publisher authorization. Publishing, pushing repository changes, and changing repository visibility are separate actions.

The distribution package does not connect an account or upload telemetry. The configured local backend collector can ingest reports into authenticated Armor Tools sessions and analytics. The CLI alone does not establish account ownership. Public account pairing and automatic plugin synchronization still require separate release verification.

## Local artifact verification

On September 30, 2026, both built artifacts passed Twine metadata checks. Fresh isolated installations of the wheel and source archive returned version `0.1.0` and read actual retained OpenCode history from outside the checkout. Both session and total budgets passed. An explicit empty source directory returned `source_missing`, unknown tokens, and zero sessions.

The final wheel contains 13 files. The final source archive contains 14 files, including `MANIFEST.in`. Inspection checked every archive member and found no telemetry exports, databases, screenshots, credentials, machine-specific paths, or retained private identifiers. Prove It Works required verification of the installed release artifacts.

Public registry installation, remote artifact download, other platforms, and production account synchronization remain unverified. No package was published. No repository visibility changed.
