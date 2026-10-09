#!/usr/bin/env python3
"""Publish immutable release files, verify public bytes, then promote the installer."""
import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.request import urlopen

if __package__:
    from .build_curl_release import Asset, Release, load_staged_release
else:
    from build_curl_release import Asset, Release, load_staged_release


@dataclass(frozen=True)
class Destination:
    bucket: str
    project: str
    account: str

    def __post_init__(self):
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", self.bucket):
            raise ValueError("Invalid bucket name")
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", self.project):
            raise ValueError("Invalid project ID")
        if not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+", self.account):
            raise ValueError("Supply an explicit publisher account email")

    @property
    def public_base(self) -> str:
        return f"https://storage.googleapis.com/{self.bucket}"

    def uri(self, asset: Asset) -> str:
        return f"gs://{self.bucket}/{asset.path}"


@dataclass(frozen=True)
class ObjectMetadata:
    generation: int
    content_type: str
    cache_control: str


class Gcloud:
    def __init__(self, destination: Destination):
        self.destination = destination

    def run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["gcloud", *args, f"--account={self.destination.account}",
                               f"--project={self.destination.project}", "--quiet"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)

    def verify_destination(self) -> str:
        project = self.run("projects", "describe", self.destination.project, "--format=json")
        if project.returncode:
            raise RuntimeError(f"Cannot inspect the explicit project. Authentication and permission errors stop publication.\n{project.stderr.decode(errors='replace').strip()}")
        project_metadata = json.loads(project.stdout)
        if not isinstance(project_metadata, dict):
            raise ValueError("Project metadata must be an object")
        project_number = str(project_metadata.get("projectNumber", ""))
        if not re.fullmatch(r"[1-9][0-9]*", project_number):
            raise ValueError("Project metadata lacks a valid projectNumber")
        bucket = self.run("storage", "buckets", "describe", f"gs://{self.destination.bucket}", "--raw", "--format=json")
        if bucket.returncode:
            raise RuntimeError(f"Cannot inspect the release bucket. Authentication and permission errors stop publication.\n{bucket.stderr.decode(errors='replace').strip()}")
        bucket_metadata = json.loads(bucket.stdout)
        if not isinstance(bucket_metadata, dict):
            raise ValueError("Bucket metadata must be an object")
        bucket_project_number = str(bucket_metadata.get("projectNumber", ""))
        if not re.fullmatch(r"[1-9][0-9]*", bucket_project_number):
            raise ValueError("Bucket metadata lacks a valid projectNumber")
        if bucket_project_number != project_number:
            raise ValueError("Release bucket belongs to a different project; no objects were inspected or changed")
        labels = bucket_metadata.get("labels", {})
        if not isinstance(labels, dict) or labels.get("armor-opencode-releases") != "true":
            raise ValueError("Bucket lacks armor-opencode-releases=true label; no objects were inspected or changed")
        return project_number

    def metadata(self, asset: Asset):
        uri = self.destination.uri(asset)
        result = self.run("storage", "objects", "describe", uri, "--raw", "--format=json")
        if result.returncode:
            message = result.stderr.decode(errors="replace")
            not_found = (re.search(r"(?:HTTPError|NotFoundException):?\s*404\b", message)
                         or re.search(rf"{re.escape(uri)} not found: 404\.(?:\s|$)", message))
            if not_found:
                return None
            raise RuntimeError(f"Cannot inspect {uri}. Authentication and permission errors stop publication.\n{message.strip()}")
        metadata = json.loads(result.stdout)
        generation = str(metadata.get("generation", ""))
        if not re.fullmatch(r"[1-9][0-9]*", generation):
            raise ValueError(f"Cloud metadata lacks a valid generation for {uri}")
        return ObjectMetadata(int(generation), metadata.get("contentType", ""), metadata.get("cacheControl", ""))

    def payload(self, asset: Asset) -> bytes:
        result = self.run("storage", "cat", self.destination.uri(asset))
        if result.returncode:
            raise RuntimeError(f"Cannot read existing {asset.path}: {result.stderr.decode(errors='replace').strip()}")
        return result.stdout

    def upload(self, asset: Asset, source: Path, generation: int, stable: bool = False) -> None:
        result = self.run("storage", "cp", str(source), self.destination.uri(asset),
                          f"--if-generation-match={generation}", f"--content-type={asset.content_type}",
                          "--cache-control=no-store" if stable else "--cache-control=public,max-age=31536000,immutable")
        if result.returncode:
            raise RuntimeError(f"Upload refused for {asset.path}: {result.stderr.decode(errors='replace').strip()}")


def verify_public(asset: Asset, public_base: str) -> None:
    with urlopen(f"{public_base}/{asset.path}", timeout=30) as response:
        if response.status != 200 or response.headers.get_content_type() != asset.content_type:
            raise RuntimeError(f"Public asset returned a wrong status or content type: {asset.path}")
        if asset.path == "install_armoropencode.sh" and response.headers.get("Cache-Control", "").strip() != "no-store":
            raise RuntimeError("Public stable installer must return Cache-Control: no-store")
        actual = response.read(len(asset.payload) + 1)
        if actual != asset.payload:
            raise RuntimeError(f"Public asset bytes do not match the captured release: {asset.path}")


def publish(release: Release, destination: Destination) -> dict:
    if release.public_base != destination.public_base:
        raise ValueError("Staged public base must equal https://storage.googleapis.com/BUCKET")
    cloud = Gcloud(destination)
    project_number = cloud.verify_destination()
    stable = next(asset for asset in release.assets if asset.path == "install_armoropencode.sh")
    versioned = tuple(asset for asset in release.assets if asset != stable)
    previous = cloud.metadata(stable)
    previous_generation = previous.generation if previous else None
    previous_hash = hashlib.sha256(cloud.payload(stable)).hexdigest() if previous else None
    existing = {}
    for asset in versioned:
        existing[asset.path] = cloud.metadata(asset)
        metadata = existing[asset.path]
        if metadata is not None and (metadata.content_type != asset.content_type or metadata.cache_control != "public,max-age=31536000,immutable"):
            raise RuntimeError(f"Published immutable asset has unexpected metadata at {asset.path}; stable installer was not changed")
        if metadata is not None and cloud.payload(asset) != asset.payload:
            raise RuntimeError(f"Published version {release.version} has different bytes at {asset.path}. Bump the project version; stable installer was not changed.")
    with tempfile.TemporaryDirectory(prefix="armor-opencode-publish-") as scratch:
        for index, asset in enumerate(versioned):
            if existing[asset.path] is None:
                source = Path(scratch) / str(index)
                source.write_bytes(asset.payload)
                try:
                    cloud.upload(asset, source, 0)
                except (RuntimeError, subprocess.SubprocessError):
                    reconciled = cloud.metadata(asset)
                    if (reconciled is None or cloud.payload(asset) != asset.payload
                            or reconciled.content_type != asset.content_type or reconciled.cache_control != "public,max-age=31536000,immutable"):
                        raise
            verify_public(asset, destination.public_base)
        if (previous_hash != stable.sha256 or previous is None or previous.content_type != stable.content_type
                or previous.cache_control != "no-store"):
            source = Path(scratch) / "stable-installer"
            source.write_bytes(stable.payload)
            try:
                cloud.upload(stable, source, previous_generation or 0, stable=True)
            except (RuntimeError, subprocess.SubprocessError) as error:
                reconciled = cloud.metadata(stable)
                if (reconciled is None or cloud.payload(stable) != stable.payload
                        or reconciled.content_type != stable.content_type or reconciled.cache_control != "no-store"):
                    raise RuntimeError(f"Stable promotion failed or conflicted with another publisher. No unconditional overwrite was attempted. {error}") from error
        elif cloud.payload(stable) != stable.payload:
            raise RuntimeError("Stable installer changed during this publication; retry explicitly")
    resulting = cloud.metadata(stable)
    resulting_generation = resulting.generation if resulting else None
    if (resulting is None or cloud.payload(stable) != stable.payload
            or resulting.content_type != stable.content_type or resulting.cache_control != "no-store"):
        raise RuntimeError("Stable installer changed after promotion; inspect the bucket before retrying")
    try:
        verify_public(stable, destination.public_base)
    except Exception as error:
        raise RuntimeError(f"Stable installer may already be promoted at generation {resulting_generation}, but public verification failed. Inspect that generation and public URL before retrying. {error}") from error
    return {"package": "armor-opencode", "version": release.version, "release_id": release.release_id,
            "project": destination.project, "project_number": project_number, "bucket": destination.bucket,
            "previous_stable_generation": previous_generation, "stable_generation": resulting_generation,
            "previous_stable_sha256": previous_hash, "stable_sha256": stable.sha256,
            "assets": {asset.path: asset.sha256 for asset in release.assets},
            "install_url": f"{destination.public_base}/install_armoropencode.sh",
            "exact_install_url": f"{destination.public_base}/releases/armor-opencode/{release.version}/install_armoropencode.sh"}


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--apply", action="store_true", help="Upload and promote; otherwise validate locally without cloud calls")
    args = parser.parse_args(argv)
    try:
        destination = Destination(args.bucket, args.project, args.account)
        release = load_staged_release(args.release)
        if release.public_base != destination.public_base:
            raise ValueError("Staged public base must equal https://storage.googleapis.com/BUCKET")
        print(f"Validated armor-opencode {release.version} ({release.release_id})")
        for asset in release.assets:
            print(f"{destination.uri(asset)} {asset.sha256}")
        if not args.apply:
            print("Dry run. No cloud commands were called. Add --apply to publish versioned files, verify public bytes, then promote stable with a generation precondition.")
            return
        receipt = publish(release, destination)
        receipt_path = args.release / "publication-receipt.json"
        if receipt_path.is_symlink():
            raise RuntimeError("Publication succeeded, but receipt path is a symlink; refusing to write it")
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"Published. Receipt: {receipt_path}")
        print(f"Install or update: curl -fsSL {receipt['install_url']} | bash")
        print(f"Exact release: curl -fsSL {receipt['exact_install_url']} | bash")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Publication refused: {error}\n")


if __name__ == "__main__":
    main()
