# ArmorOpenCode release flow

The release flow packages the reviewed TypeScript installer and telemetry
sources into an immutable versioned bundle. It publishes a stable installer
only after the versioned files exist. Every release has a new identity derived
from its version, bundle bytes, builder revision, and public base.

The public command will be:

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
```

That URL must remain unpublished until the GCP bucket and website redirect are
verified. The release scripts do not bundle credentials, prompts, tool
arguments, tool results, paths, or machine identifiers.

## Stage and verify a release

Run from a clean checkout with Bun installed:

```sh
export RELEASE_DIR="$(mktemp -d)/release"
npx --yes bun scripts/build_release.ts \
  --output "$RELEASE_DIR" \
  --public-base "https://storage.googleapis.com/YOUR_SOFTWARE_BUCKET"
npx --yes bun scripts/publish_release.ts \
  --release "$RELEASE_DIR" \
  --bucket YOUR_SOFTWARE_BUCKET \
  --project YOUR_GCP_PROJECT \
  --account YOUR_PUBLISHER_ACCOUNT
```

The second command is a dry run. It validates every local checksum and prints
the versioned objects before making cloud calls. Add `--apply` only after
reviewing the staged manifest.

The stable installer has `Cache-Control: no-store`. Versioned bundles and
versioned installers are immutable and use long-lived immutable caching. A
versioned object that already exists with different bytes is rejected. Stable
promotion uses a generation precondition so concurrent publishers cannot
silently overwrite one another.

## GCP destination requirements

Use a dedicated public software bucket. The publisher requires the explicit
project and account, verifies the bucket's owning project number, and requires
the label `armor-opencode-releases=true` before it inspects or writes objects.
The publisher account must not have broad project administration rights.

```sh
export ARMOR_GCP_PROJECT='YOUR_PROJECT_ID'
export ARMOR_RELEASE_BUCKET='YOUR_UNIQUE_SOFTWARE_BUCKET'
export ARMOR_PUBLISH_ACCOUNT='YOUR_PUBLISHER_ACCOUNT'

gcloud storage buckets create "gs://$ARMOR_RELEASE_BUCKET" \
  --project="$ARMOR_GCP_PROJECT" --location=us-central1 \
  --uniform-bucket-level-access
gcloud storage buckets update "gs://$ARMOR_RELEASE_BUCKET" \
  --project="$ARMOR_GCP_PROJECT" --versioning \
  --update-labels=armor-opencode-releases=true
gcloud storage buckets add-iam-policy-binding "gs://$ARMOR_RELEASE_BUCKET" \
  --project="$ARMOR_GCP_PROJECT" --member=allUsers \
  --role=roles/storage.objectViewer
```

Do not disable an organization public-access policy or reuse a customer-data
bucket. Configure the restricted publisher account separately and review
inherited IAM grants before the first publication.

## Update, rollback, and uninstall

Updating runs the stable installer again. A rollback runs the retained
versioned installer directly:

```sh
curl -fsSL "https://storage.googleapis.com/YOUR_SOFTWARE_BUCKET/releases/armor-opencode/VERSION/install_armoropencode.sh" | bash
```

Uninstall keeps the user's OpenCode configuration and history:

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash -s -- --uninstall
```

The installer stores release bundles under
`~/.local/share/armor-opencode/releases`. It only edits the managed
ArmorOpenCode entries in `opencode.json` and the marked section in `AGENTS.md`.
Unrelated settings, credentials, reports, and history remain untouched.

The repository still needs the real plugin and MCP package paths before a
public release is advertised. The current installer preserves the existing
placeholder boundary from the earlier policy work.
