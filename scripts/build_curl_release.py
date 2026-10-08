#!/usr/bin/env python3
"""Validate and stage a captured wheel and immutable curl release assets."""
import argparse
import configparser
from dataclasses import dataclass, field
from email.parser import BytesParser
import hashlib
import json
from io import BytesIO
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import urlsplit
import zipfile


@dataclass(frozen=True)
class Wheel:
    version: str
    filename: str
    sha256: str
    payload: bytes = field(repr=False)


@dataclass(frozen=True)
class Asset:
    path: str
    payload: bytes = field(repr=False)
    content_type: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.payload).hexdigest()


@dataclass(frozen=True)
class Release:
    wheel: Wheel
    release_id: str
    public_base: str
    assets: tuple[Asset, ...]

    @property
    def version(self) -> str:
        return self.wheel.version


def private_data_check(data: bytes, name: str) -> None:
    if b"/Users/" in data or b"/home/" in data or re.search(rb"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY", data):
        raise ValueError(f"Asset contains private machine data in {name}")


def inspect_wheel(wheel: Path) -> Wheel:
    return inspect_wheel_bytes(wheel.name, wheel.read_bytes())


def inspect_wheel_bytes(filename: str, data: bytes) -> Wheel:
    with zipfile.ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if archive.comment or any(entry.comment or entry.extra for entry in entries):
            raise ValueError("Wheel archive comments and extra metadata are not allowed")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Wheel contains duplicate paths")
        if any(stat.S_ISLNK(entry.external_attr >> 16) for entry in entries):
            raise ValueError("Wheel contains symlinks")
        metadata_names = [name for name in names if name.endswith(".dist-info/METADATA")]
        if len(metadata_names) != 1:
            raise ValueError("Wheel must have exactly one METADATA file")
        metadata = BytesParser().parsebytes(archive.read(metadata_names[0]))
        version = metadata.get("Version", "")
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
            raise ValueError("Release requires a numeric major.minor.patch version")
        prefix = f"armor_opencode-{version}.dist-info/"
        metadata_files = {prefix + name for name in (
            "licenses/LICENSE", "METADATA", "WHEEL", "entry_points.txt", "top_level.txt", "RECORD")}
        modules = set()
        for name in names:
            path = PurePosixPath(name)
            if str(path) != name or any(part in (".", "..") for part in path.parts):
                raise ValueError("Wheel contains an unsafe path")
            if name in metadata_files:
                continue
            if (len(path.parts) < 2 or path.parts[0] != "armor_opencode"
                    or path.suffix != ".py" or not path.stem.isidentifier()
                    or not path.stem.isascii()
                    or any(not part.isidentifier() or not part.isascii() for part in path.parts[1:-1])):
                raise ValueError("Wheel contains unexpected or missing files; only package Python source is allowed")
            modules.add(name)
        if not {"armor_opencode/__init__.py", "armor_opencode/__main__.py"} <= modules or not metadata_files <= set(names):
            raise ValueError("Wheel contains unexpected or missing files")
        expected_filename = f"armor_opencode-{version}-py3-none-any.whl"
        if filename != expected_filename or metadata.get("Name") != "armor-opencode":
            raise ValueError("Wheel filename and package metadata do not agree")
        if metadata.get_all("Requires-Dist"):
            raise ValueError("Dependencies require a reviewed locked wheelhouse; this installer accepts no dependencies")
        if metadata.get("Requires-Python") != ">=3.9":
            raise ValueError("Wheel must require Python >=3.9")
        wheel_metadata = BytesParser().parsebytes(archive.read(prefix + "WHEEL"))
        if wheel_metadata.get_all("Tag") != ["py3-none-any"] or wheel_metadata.get("Root-Is-Purelib") != "true":
            raise ValueError("Wheel must be pure Python")
        points = configparser.ConfigParser()
        points.read_string(archive.read(prefix + "entry_points.txt").decode())
        if dict(points.items("console_scripts")) != {"armor-opencode": "armor_opencode.__main__:main"}:
            raise ValueError("Wheel must expose the expected CLI")
        for name in names:
            private_data_check(archive.read(name), name)
    return Wheel(version, filename, hashlib.sha256(data).hexdigest(), data)


def validate_public_base(value: str) -> str:
    parsed = urlsplit(value)
    parsed.port
    if (parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname
            or any(char.isspace() or ord(char) < 32 for char in value)
            or not re.fullmatch(r"[A-Za-z0-9:/._-]+", value)):
        raise ValueError("Invalid public base URL")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1") and parsed.port):
        raise ValueError("Public base requires HTTPS or explicit loopback HTTP")
    if any(part in (".", "..") for part in parsed.path.split("/")):
        raise ValueError("Public base contains path traversal")
    return value.rstrip("/")


def release_identity(wheel: Wheel, template_hash: str, public_base: str) -> str:
    contract = {"version": wheel.version, "wheel_sha256": wheel.sha256,
                "template_sha256": template_hash, "public_base": public_base}
    return hashlib.sha256(json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def landing_bootstrap(public_base: str) -> bytes:
    return ("#!/bin/bash\nset -euo pipefail\numask 077\n"
            "installer=$(mktemp \"${TMPDIR:-/tmp}/armor-opencode-bootstrap.XXXXXX\")\n"
            "trap 'rm -f \"$installer\"' EXIT\ntrap 'exit 130' INT\ntrap 'exit 143' TERM\n"
            "curl --connect-timeout 20 --max-time 600 --proto '=https' --proto-redir '=https' -fsSL "
            f"'{public_base}/install_armoropencode.sh' -o \"$installer\"\n"
            "bash \"$installer\" \"$@\"\n").encode()


def stage_release(wheel: Path, output: Path, public_base: str = "https://armoriq.ai") -> Release:
    captured = inspect_wheel(wheel)
    public_base = validate_public_base(public_base)
    template = Path(__file__).with_name("install_armoropencode.sh.in").read_text()
    template_hash = hashlib.sha256(template.encode()).hexdigest()
    identity = release_identity(captured, template_hash, public_base)
    prefix = f"releases/armor-opencode/{captured.version}"
    script = template
    for key, value in {"VERSION": captured.version, "WHEEL": captured.filename,
                       "SHA256": captured.sha256, "RELEASE_ID": identity,
                       "RELEASE_BASE": f"{public_base}/{prefix}"}.items():
        script = script.replace(f"@@{key}@@", value)
    if "@@" in script:
        raise ValueError("Installer contains unresolved template constants")
    installer = Asset("install_armoropencode.sh", script.encode(), "text/x-shellscript")
    version_script = Asset(f"{prefix}/install_armoropencode.sh", installer.payload, installer.content_type)
    wheel_asset = Asset(f"{prefix}/{captured.filename}", captured.payload, "application/octet-stream")
    document = {"schema_version": 1, "package": "armor-opencode", "version": captured.version,
                "release_id": identity, "public_base": public_base, "template_sha256": template_hash,
                "assets": {asset.path: asset.sha256 for asset in (wheel_asset, version_script)}}
    manifest_asset = Asset(f"{prefix}/release.json", (json.dumps(document, indent=2) + "\n").encode(), "application/json")
    release = Release(captured, identity, public_base, (wheel_asset, version_script, manifest_asset, installer))
    for asset in release.assets:
        private_data_check(asset.payload, asset.path)
    output.mkdir(parents=True, exist_ok=False)
    for asset in release.assets:
        path = output / "public" / asset.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(asset.payload)
        if path.suffix == ".sh":
            path.chmod(0o755)
    manifest = {"package": "armor-opencode", "version": captured.version,
                "assets": {f"public/{asset.path}": asset.sha256 for asset in release.assets}}
    (output / "safety-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if urlsplit(public_base).scheme == "https":
        landing = output / "landing" / "install_armoropencode.sh"
        landing.parent.mkdir()
        landing.write_bytes(landing_bootstrap(public_base))
        landing.chmod(0o755)
    return release


def load_staged_release(output: Path) -> Release:
    if output.is_symlink() or not output.is_dir():
        raise ValueError("Release must be a regular staging directory")
    manifest_path = output / "safety-manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Safety manifest must not be a symlink")
    manifest = json.loads(manifest_path.read_bytes())
    version = manifest.get("version", "")
    if manifest.get("package") != "armor-opencode" or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid safety manifest package or version")
    prefix = f"releases/armor-opencode/{version}"
    filename = f"armor_opencode-{version}-py3-none-any.whl"
    paths = {f"{prefix}/{filename}": "application/octet-stream", f"{prefix}/install_armoropencode.sh": "text/x-shellscript",
             f"{prefix}/release.json": "application/json", "install_armoropencode.sh": "text/x-shellscript"}
    expected = {f"public/{path}" for path in paths}
    public = output / "public"
    if public.is_symlink() or not public.is_dir():
        raise ValueError("Public assets must be a regular directory")
    found = set()
    for path in public.rglob("*"):
        if path.is_symlink():
            raise ValueError("Release contains a symlink")
        if path.is_file():
            found.add(str(path.relative_to(output)))
        elif not path.is_dir():
            raise ValueError("Release contains a nonregular asset")
    if found != expected or set(manifest.get("assets", {})) != expected:
        raise ValueError("Release contains unexpected or missing public assets")
    assets = tuple(Asset(path, (public / path).read_bytes(), content_type) for path, content_type in paths.items())
    for asset in assets:
        if asset.sha256 != manifest["assets"][f"public/{asset.path}"]:
            raise ValueError(f"Safety manifest checksum mismatch for {asset.path}")
        private_data_check(asset.payload, asset.path)
    captured = inspect_wheel_bytes(filename, assets[0].payload)
    document = json.loads(assets[2].payload)
    if set(document) != {"schema_version", "package", "version", "release_id", "public_base", "template_sha256", "assets"}:
        raise ValueError("Unexpected release manifest fields")
    public_base = validate_public_base(document["public_base"])
    template_hash = document["template_sha256"]
    if not isinstance(template_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", template_hash):
        raise ValueError("Invalid installer template digest")
    identity = release_identity(captured, template_hash, public_base)
    if (document["schema_version"] != 1 or document["package"] != "armor-opencode" or document["version"] != version
            or document["release_id"] != identity or document["assets"] != {asset.path: asset.sha256 for asset in assets[:2]}
            or assets[1].payload != assets[3].payload):
        raise ValueError("Release manifest and captured assets do not agree")
    script = assets[1].payload.decode()
    constants = {"VERSION": version, "WHEEL": filename, "WHEEL_SHA256": captured.sha256,
                 "RELEASE_ID": identity, "RELEASE_BASE": f"{public_base}/{prefix}"}
    if any(f"{key}='{value}'\n" not in script for key, value in constants.items()) or "@@" in script:
        raise ValueError("Installer and release manifest do not agree")
    return Release(captured, identity, public_base, assets)


def current_wheel() -> Path:
    checkout = Path(__file__).resolve().parents[1]
    project = (checkout / "pyproject.toml").read_text().split("[project]", 1)[1].split("\n[", 1)[0]
    match = re.search(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$', project, re.MULTILINE)
    if not match:
        raise ValueError("Project must declare a numeric release version")
    return checkout / "dist" / f"armor_opencode-{match.group(1)}-py3-none-any.whl"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, help="Defaults to the current project version in dist/")
    parser.add_argument("--output", required=True, type=Path, help="New staging directory; existing directories are refused")
    parser.add_argument("--public-base", default="https://armoriq.ai")
    args = parser.parse_args()
    try:
        release = stage_release(args.wheel or current_wheel(), args.output, args.public_base)
    except (OSError, ValueError, zipfile.BadZipFile, configparser.Error) as error:
        parser.exit(1, f"Release refused: {error}\n")
    print(f"Staged armor-opencode {release.version} ({release.release_id}) in {args.output}")


if __name__ == "__main__":
    main()
