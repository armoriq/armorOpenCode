# Publish ArmorOpenCode manually on GCP

Set up hosting once. For each later release, change the code, increase the version, build, test, and run the publisher. Routine publication uploads software into a dedicated bucket. It does not deploy Cloud Run, change IAM, change DNS, or update website secrets.

The production installer is not published as of September 30, 2026. The current machine needs work-account reauthentication and the real hosting project ID. The commands below contain placeholders. Replace them before running them.

## Choose the project and software bucket

Use a new bucket for public software. Do not reuse a bucket containing customer data, reports, screenshots, or credentials. Bucket names are globally unique.

```sh
export ARMOR_GCP_PROJECT='YOUR_PROJECT_ID'
export ARMOR_RELEASE_BUCKET='YOUR_UNIQUE_SOFTWARE_BUCKET'
export ARMOR_ADMIN_ACCOUNT='YOUR_GCP_ADMIN_EMAIL'
export ARMOR_PUBLISH_ACCOUNT='YOUR_RESTRICTED_PUBLISHER_EMAIL'
export ARMOR_OPENCODE_ROOT='/Users/psudokit/armor-iq/armorOpenCode'
gcloud auth login "$ARMOR_ADMIN_ACCOUNT"
gcloud projects describe "$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT"
```

To reauthenticate this laptop's existing work account, run `gcloud auth login pulkit@armoriq.io`. The examples use explicit account and project flags and do not change your default gcloud configuration.

## Create public software hosting once

Run these commands with the administrator account.

```sh
gcloud storage buckets create "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" --versioning \
	--update-labels=armor-opencode-releases=true
gcloud storage buckets add-iam-policy-binding "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--member=allUsers --role=roles/storage.objectViewer
```

If public access prevention blocks the read grant, stop. Have the administrator approve a public software delivery method. Do not disable an organization policy or make an existing customer bucket public. Google's [public access prevention guide](https://docs.cloud.google.com/storage/docs/public-access-prevention) describes inherited restrictions.

Do not configure deletion rules for retained releases. Object Versioning preserves older generations of the stable installer. Versioned release paths remain separate objects. See [Object Versioning](https://docs.cloud.google.com/storage/docs/using-object-versioning).

The label identifies this as the dedicated software bucket. Before any object inspection or upload, the publisher compares the bucket's owning project number with the explicit project and requires this label. A wrong project, missing label, or metadata permission failure stops publication. The administrator sets the label once using [bucket update](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/update).

## Restrict the publisher once

Keep infrastructure administration separate from routine publication. Give the publisher creation rights on versioned objects and replacement rights on the exact stable installer object.

Give the publisher read access to project and bucket metadata so it can verify the destination. This custom role grants metadata inspection across the selected project; it grants no object writes, IAM changes, or Cloud Run changes. Run these setup commands once with the administrator account. See [custom role creation](https://docs.cloud.google.com/sdk/gcloud/reference/iam/roles/create).

```sh
gcloud iam roles create armorOpenCodeReleaseInspector \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--title='ArmorOpenCode release destination inspection' \
	--permissions=storage.buckets.get,resourcemanager.projects.get --stage=GA
gcloud projects add-iam-policy-binding "$ARMOR_GCP_PROJECT" \
	--account="$ARMOR_ADMIN_ACCOUNT" \
	--member="user:$ARMOR_PUBLISH_ACCOUNT" \
	--role="projects/$ARMOR_GCP_PROJECT/roles/armorOpenCodeReleaseInspector"
```

Create two local condition files outside the public release bundle.

```sh
export ARMOR_IAM_WORK="$(mktemp -d)"
cat > "$ARMOR_IAM_WORK/releases.json" <<EOF
{
  "title": "armor-opencode-release-create",
  "expression": "resource.name.startsWith('projects/_/buckets/$ARMOR_RELEASE_BUCKET/objects/releases/armor-opencode/')"
}
EOF
cat > "$ARMOR_IAM_WORK/installer.json" <<EOF
{
  "title": "armor-opencode-installer-promote",
  "expression": "resource.name == 'projects/_/buckets/$ARMOR_RELEASE_BUCKET/objects/install_armoropencode.sh'"
}
EOF
gcloud storage buckets add-iam-policy-binding "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--member="user:$ARMOR_PUBLISH_ACCOUNT" --role=roles/storage.objectCreator \
	--condition-from-file="$ARMOR_IAM_WORK/releases.json"
gcloud storage buckets add-iam-policy-binding "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--member="user:$ARMOR_PUBLISH_ACCOUNT" --role=roles/storage.objectUser \
	--condition-from-file="$ARMOR_IAM_WORK/installer.json"
gcloud storage buckets get-iam-policy "gs://$ARMOR_RELEASE_BUCKET" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT"
gcloud projects get-iam-policy "$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT"
```

Review inherited project, folder, organization, and group permissions too. A publisher that also has project Owner or broad Storage Admin access can still overwrite releases. These conditional bucket grants do not remove inherited permissions. Restrict membership and review repository access for people who maintain the bootstrap and release scripts.

Only public read access belongs to `allUsers`. Google's [Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles) define the difference between creation and replacement rights.

## Build and publish the first release

Authenticate the selected publisher account and build from the collector checkout.

```sh
gcloud auth login "$ARMOR_PUBLISH_ACCOUNT"
cd "$ARMOR_OPENCODE_ROOT"
uv build
export ARMOR_RELEASE_OUTPUT="$(mktemp -d)/release"
python3 scripts/build_curl_release.py \
	--output "$ARMOR_RELEASE_OUTPUT" \
	--public-base "https://storage.googleapis.com/$ARMOR_RELEASE_BUCKET"
python3 -m unittest discover -s tests -v
cat "$ARMOR_RELEASE_OUTPUT/safety-manifest.json"
python3 scripts/publish_curl_release.py \
	--release "$ARMOR_RELEASE_OUTPUT" --bucket "$ARMOR_RELEASE_BUCKET" \
	--project "$ARMOR_GCP_PROJECT" --account "$ARMOR_PUBLISH_ACCOUNT"
```

The last command validates local files and prints a plan. It makes no cloud calls without `--apply`. Test the exact staged installer using [the local installation procedure](curl-install.md#test-the-staged-installer) before applying the plan.

Publish the reviewed bundle.

```sh
python3 scripts/publish_curl_release.py \
	--release "$ARMOR_RELEASE_OUTPUT" --bucket "$ARMOR_RELEASE_BUCKET" \
	--project "$ARMOR_GCP_PROJECT" --account "$ARMOR_PUBLISH_ACCOUNT" --apply
```

The publisher first verifies the bucket's owning project and dedicated release label. It then creates versioned files, compares existing files on retry, and fetches their public HTTPS URLs to verify the captured bytes. It promotes the stable installer only after those checks. A different file under an existing version fails and requires a version increase. Concurrent stable promotion fails rather than silently replacing another publisher's update. Google's [generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions) provide these checks.

Do not upload the repository or use a recursive synchronization command. Publish the reviewed bundle through this command. Keep the bundle and publication output as the release record.

## Connect the website once

The builder produces `landing/install_armoropencode.sh` outside the public bucket assets. This small file downloads the current installer from the fixed software bucket into a temporary file and then runs it. Its bucket address stays fixed across later releases.

Copy that file to `public/install_armoropencode.sh` in a separate checkout of `armoriq/armorIQ-landing`. Use the source revision that matches the current deployed website. Review the single-file change. Preserve this bootstrap in future website deployments.

The existing landing `cloudbuild.yaml` deploys `armoriq-landing` in `us-central1` and uses `--set-env-vars` with empty manual defaults for credentials. Do not run a blind manual `gcloud builds submit` with that configuration. The collector includes a build-only configuration at `deploy/gcp/cloudbuild.bootstrap.yaml`. It builds and pushes an image and contains no Cloud Run deployment step.

Set the path to your reviewed landing checkout. Confirm the service and region against the actual project before continuing.

```sh
export ARMOR_LANDING_CHECKOUT='/absolute/path/to/reviewed/armorIQ-landing'
export ARMOR_LANDING_SERVICE='armoriq-landing'
export ARMOR_LANDING_REGION='us-central1'
cp "$ARMOR_RELEASE_OUTPUT/landing/install_armoropencode.sh" \
	"$ARMOR_LANDING_CHECKOUT/public/install_armoropencode.sh"
export ARMOR_SERVICE_BACKUP="$(mktemp -d)"
gcloud run services describe "$ARMOR_LANDING_SERVICE" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--region="$ARMOR_LANDING_REGION" --format=export \
	> "$ARMOR_SERVICE_BACKUP/before.yaml"
export ARMOR_CURRENT_IMAGE="$(gcloud run services describe "$ARMOR_LANDING_SERVICE" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--region="$ARMOR_LANDING_REGION" \
	--format='value(spec.template.spec.containers[0].image)')"
export ARMOR_IMAGE_REPOSITORY="${ARMOR_CURRENT_IMAGE%%@*}"
export ARMOR_IMAGE_REPOSITORY="${ARMOR_IMAGE_REPOSITORY%:*}"
export ARMOR_BOOTSTRAP_IMAGE="$ARMOR_IMAGE_REPOSITORY:opencode-bootstrap-$(date -u +%Y%m%d%H%M%S)"
gcloud builds submit "$ARMOR_LANDING_CHECKOUT" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--config="$ARMOR_OPENCODE_ROOT/deploy/gcp/cloudbuild.bootstrap.yaml" \
	--substitutions="_BOOTSTRAP_IMAGE=$ARMOR_BOOTSTRAP_IMAGE"
gcloud run services update "$ARMOR_LANDING_SERVICE" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--region="$ARMOR_LANDING_REGION" --image="$ARMOR_BOOTSTRAP_IMAGE" \
	--no-traffic --tag=armoropencode-bootstrap
gcloud run services describe "$ARMOR_LANDING_SERVICE" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--region="$ARMOR_LANDING_REGION" --format=export \
	> "$ARMOR_SERVICE_BACKUP/candidate.yaml"
```

Keep the exported service files private. They can contain existing application configuration. Compare the before and candidate files. Confirm that environment values, secret references, identity, network settings, scaling, and existing traffic remain correct. The intended change is the image plus the test revision/tag. The build-only file does not guarantee the deployed application is unchanged if the checkout contains other code changes.

Read the tagged candidate URL from the service's traffic entries. Fetch its `/install_armoropencode.sh` and compare it with the staged landing file. Run the complete installer from that URL using isolated installation paths. Test the landing site's affected navigation, forms, and error states. If any path fails or cannot be tested, leave production traffic unchanged.

After those checks, promote the tested revision.

```sh
gcloud run services update-traffic "$ARMOR_LANDING_SERVICE" \
	--project="$ARMOR_GCP_PROJECT" --account="$ARMOR_ADMIN_ACCOUNT" \
	--region="$ARMOR_LANDING_REGION" --to-tags=armoropencode-bootstrap=100
```

This command deliberately sends all service traffic to the tested revision. If the service uses a deliberate traffic split, preserve that policy instead. Record the previous revision percentages before promotion so you can restore them if needed. See the official [service update](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update) and [traffic update](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update-traffic) references.

Verify `https://armoriq.ai/install_armoropencode.sh` returns the exact bootstrap. Complete a fresh installation through that public URL and read an actual retained-history report. Only then advertise the public curl command.

## Publish later code changes

Increase `version` in `pyproject.toml` for every published code, installer, or runtime change. Add ordinary Python modules under `armor_opencode/`. Reuse the same project, bucket, and account variables.

Run the build, tests, staging, and publisher commands from the first-release section with a new output directory. You publish each new release once. You do not repeat bucket setup, IAM changes, website builds, or Cloud Run deployment.

New dependencies, JavaScript plugins, native binaries, and non-Python resources need a reviewed packaging contract. The current installer supports a dependency-free pure Python wheel. A dependency must ship with a complete pinned dependency set before the builder can accept it. Do not remove the guard while leaving `--no-deps` installation in place.

Future plugin setup must merge its owned entry into existing OpenCode settings and test preservation of unrelated settings. Future pairing must authenticate each user and store their credentials privately. Publication tooling does not implement those features or prove their account isolation.

## Update, roll back, or remove the command

After public verification, users install or update with the same command.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash
armor-opencode report
```

To roll back a user's installation, run the retained installer for the desired published version. Replace `VERSION` with the actual release version.

```sh
curl -fsSL "https://storage.googleapis.com/$ARMOR_RELEASE_BUCKET/releases/armor-opencode/VERSION/install_armoropencode.sh" | bash
```

To remove the installed command, run the stable installer with `--uninstall`.

```sh
curl -fsSL https://armoriq.ai/install_armoropencode.sh | bash -s -- --uninstall
```

Removal deletes only the owned launcher. It retains runtime files, previous releases, shell PATH blocks, reports, credentials, and OpenCode history. Custom installation and launcher paths require the same `--install-dir` and `--bin-dir` arguments used during installation.

To change the version offered to everyone, apply a retained validated bundle with the same publisher. This promotes its installer with the current generation check and keeps every newer release file available. A user who has already updated keeps their installed version until they explicitly update or roll back.

## Verification status

On September 30, 2026, all 69 local tests passed. Independent macOS arm64 checks exercised the actual served curl installer, repeat installation, update, retained-version rollback, and launcher removal twice. A separate source copy changed only `pyproject.toml` to `0.1.1`; the installed CLI reported `0.1.1` and rolled back to `0.1.0`. Actual retained-history reports stayed equal, including both budget scopes. Missing downloads and checksum failures preserved the working command. Launcher removal preserved existing runtime files and the original OpenCode database.

Cloud publication, bucket IAM inheritance, the tagged website revision, and public HTTPS installation have not been tested in this task. Work-account reauthentication and the actual hosting project are required. Local protocol tests cannot establish those cloud outcomes. Other supported installer platforms, future plugin configuration merges, and account pairing still require their own real integration checks. The public installer URL still returns 404.
