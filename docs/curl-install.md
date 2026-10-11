# Build and test curl installation assets

The public URL `https://armoriq.ai/install_armoropencode.sh` returned 404 on September 30, 2026. This checkout prepares installers and publication tooling. It has not published them.

Use [the manual GCP publishing guide](gcp-publishing.md) for bucket setup and publication. After one landing-site bootstrap deployment, collector releases change only dedicated Storage objects. They do not redeploy the website or replace Cloud Run environment variables.

## Prepare the release

Bump `version` in `pyproject.toml` for every public release, including runtime or installer changes. Installed CLI version comes from its distribution metadata. A published version path cannot be reused with different bytes.

Run from the collector checkout. Replace the bucket name with the dedicated release bucket. Choose a new staging directory.

```sh
uv build
python3 scripts/build_curl_release.py --output /private/tmp/armor-opencode-curl-release --public-base https://storage.googleapis.com/YOUR_RELEASE_BUCKET
bash -n /private/tmp/armor-opencode-curl-release/public/install_armoropencode.sh
python3 -m unittest discover -s tests -v
```

`--wheel` is optional. The builder derives the current wheel filename from `pyproject.toml`. Supply `--wheel /absolute/path/to/wheel.whl` to select an explicit artifact. `--public-base` defaults to `https://armoriq.ai`; the GCP publisher requires the bucket's exact HTTPS base instead.

The builder captures, validates, hashes, and stages the same wheel bytes. Normal module additions under `armor_opencode/` work without updating a file count. Module and package names must be ASCII Python identifiers. Only Python source and the six expected distribution metadata files are allowed. Root `__init__.py` and `__main__.py` are required.

The builder refuses duplicate paths, traversal, symlinks, archive comments, entry comments, ZIP extras, non-Python package data, private machine paths, and private-key patterns. These pattern checks do not detect every possible credential. Inspect your source before publication. Dependencies are refused with a locked-wheelhouse requirement, because the current installer uses `--no-index --no-deps`.

The `public/` directory contains exactly four files. The package version replaces `VERSION` below.

```text
install_armoropencode.sh
releases/armor-opencode/VERSION/install_armoropencode.sh
releases/armor-opencode/VERSION/armor_opencode-VERSION-py3-none-any.whl
releases/armor-opencode/VERSION/release.json
```

The stable and versioned installers contain identical bytes. `release.json` records the wheel and versioned installer hashes. `safety-manifest.json` records all four hashes outside `public/`. For an HTTPS base, `landing/install_armoropencode.sh` is a separate small bootstrap for the marketing site. It downloads the stable bucket installer to a temporary file, checks curl success, and forwards arguments to Bash. It never sources manifest fields.

The release identity hashes the package version, wheel digest, original installer template digest, and public base. Runtime pins are inside the template, so changing a runtime pin creates a new local environment identity. The public version still must increase, because public version paths are immutable.

## Test the staged installer

For local testing, stage a separate loopback bundle. Loopback bundles do not generate a landing-site bootstrap.

```sh
python3 scripts/build_curl_release.py --output /private/tmp/armor-opencode-loopback --public-base http://127.0.0.1:8769
python3 -m http.server 8769 --bind 127.0.0.1 --directory /private/tmp/armor-opencode-loopback/public
```

In another terminal, choose unused private installation and launcher directories. Keep your actual `HOME` so the report reads your retained history.

```sh
curl -fsSL http://127.0.0.1:8769/install_armoropencode.sh | bash -s -- --install-dir /private/tmp/armor-opencode-test-install --bin-dir /private/tmp/armor-opencode-test-bin --no-modify-path
/private/tmp/armor-opencode-test-bin/armor-opencode --version
/private/tmp/armor-opencode-test-bin/armor-opencode report
```

Keep reports outside `public/`. Exercise repeat installation, unavailable assets, checksum failures, owned and foreign launchers, and a held lock. Public GCP verification also requires a fresh install from the published HTTPS URLs.

## Install, update, roll back, and remove the launcher

After public deployment and HTTPS verification, installation and update use the same command.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
armor-opencode report
```

Updating the hosted script does not change an installed copy. Each user runs that command again to select the current stable release. The installer verifies the new environment before switching the launcher and retains older environments.

To roll back a user's installation, run the exact retained versioned script. Replace the bucket and version with an existing published release.

```sh
curl -fsSL https://storage.googleapis.com/YOUR_RELEASE_BUCKET/releases/armor-opencode/VERSION/install_armoropencode.sh | bash
```

To remove the command, run the installer with `--uninstall`.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash -s -- --uninstall
```

Removal deletes only a positively owned launcher under the installation and launcher locks. It performs no wheel, uv, or Python download. Running it when the command is absent changes no files. It preserves environments, shell profile blocks, OpenCode configuration, credentials, reports, and history. A foreign launcher is refused. This is launcher removal, not a complete disk cleanup. The `armor-opencode` CLI itself has no `update`, `rollback`, or `uninstall` subcommands.

## Installation boundaries

Defaults are `~/.local/share/armor-opencode` and `~/.local/bin/armor-opencode`. The local environment path includes the version and complete release identity. Its ready marker records that identity. Earlier installer-owned launchers are accepted, and old release directories remain available.

The installer pins uv `0.11.32`, its official bootstrap SHA-256, and managed Python `3.14.6`. It ignores inherited uv configuration and download overrides. A private checksum adapter supports systems that provide `shasum` instead of `sha256sum`.

Launcher replacement is atomic after version and help checks. A failure before replacement preserves the previous launcher. Both installation-root and launcher-directory locks serialize cooperating installers. Ownership is checked again immediately before replacement. SIGTERM cleans up locks. After SIGKILL or a machine crash, remove stale locks only after confirming the earlier installer stopped.

When the launcher directory is absent from PATH, the installer adds a marked shell block. Zsh uses its startup file. Bash uses `.bashrc` and the selected login profile, preferring `.bash_profile`, then `.bash_login`, then `.profile`. Blocks avoid duplicate PATH entries. Symlinks and existing markers preserve the profile. Custom installation paths disable profile changes unless `--profile /absolute/path` is supplied. `--no-modify-path` always disables changes.

Installation does not read telemetry, modify OpenCode settings, register a live plugin, pair an account, upload reports, or redirect a browser. Future plugin setup must merge only ArmorOpenCode's owned settings and use each user's own identity. Publisher credentials and telemetry must never enter release assets.

The installer supports macOS and Linux on arm64 and x86_64. It requires curl and `shasum` or `sha256sum`. Windows is unsupported. Earlier loopback installation was exercised on macOS arm64. Other platforms, real GCP publication, public HTTPS installation, and production account pairing remain unverified.

## Publisher behavior

The publisher validates and captures the whole staged release before any cloud call. Without `--apply`, it prints a plan and performs no cloud calls. On application, it first compares the bucket's owning project number with the explicit project's number. The bucket must also have the `armor-opencode-releases=true` label. Inspection errors stop publication before object reads or writes. It then refuses changed bytes or metadata at existing versioned paths, creates missing objects with generation zero, and verifies each object through unauthenticated HTTPS.

Only after versioned verification does it promote the stable installer using the generation observed at startup. The stable object uses `Cache-Control: no-store`. Identical retries preserve immutable objects. A concurrent stable writer causes a conflict, never an unconditional overwrite. A timeout after upload is reconciled against remote bytes and metadata. A verification failure after promotion reports that the live installer may already have changed.

The publisher uses explicit account and project flags on every gcloud call. It does not change global gcloud configuration, delete older releases, synchronize directories, mutate IAM, or call Cloud Run. Its local receipt records the verified project, project number, bucket, generations, and hashes outside `public/`. Boundary tests simulate gcloud and HTTP responses to check destination checks, ordering, retries, conflicts, and failures. Those protocol tests are not proof of real GCP publication.
