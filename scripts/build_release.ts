#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RELEASE_FILES = [
  "scripts/install.ts",
  "telemetry/aggregate.ts",
  "telemetry/cli.ts",
  "telemetry/index.ts",
  "telemetry/live.ts",
  "telemetry/source.ts",
  "telemetry/state.ts",
  "telemetry/transport.ts",
  "telemetry/types.ts",
] as const;

export interface ReleaseAsset {
  path: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface StagedRelease {
  version: string;
  releaseId: string;
  publicBase: string;
  assets: ReleaseAsset[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validatePublicBase(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new Error("Public base must not contain credentials, query, or fragment");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.port)) {
    throw new Error("Public base requires HTTPS or explicit loopback HTTP");
  }
  const rawPath = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").split(/[?#]/, 1)[0] ?? "";
  if (rawPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Public base contains path traversal");
  }
  return value.replace(/\/$/, "");
}

function packageVersion(repoRoot: string): string {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    throw new Error("package.json must declare a numeric major.minor.patch version");
  }
  return packageJson.version;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installerTemplate(version: string, bundleName: string, bundleSha: string, releaseId: string, releaseBase: string): string {
  return `#!/bin/sh
set -eu
VERSION=${shellQuote(version)}
BUNDLE=${shellQuote(bundleName)}
BUNDLE_SHA256=${shellQuote(bundleSha)}
RELEASE_ID=${shellQuote(releaseId)}
RELEASE_BASE=${shellQuote(releaseBase)}
OWNER='armoriq:armor-opencode:release-v1'
ROOT="\${HOME:?HOME is required}/.local/share/armor-opencode"
RELEASE="$ROOT/releases/\${VERSION}-\${RELEASE_ID}"
CURRENT="$ROOT/current"
TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
case "$RELEASE_BASE" in
  https://*) DOWNLOAD_PROTOCOL='=https' ;;
  http://127.0.0.1:*|http://localhost:*) DOWNLOAD_PROTOCOL='=http,https' ;;
  *) echo 'ArmorOpenCode installation failed: release base must use HTTPS or explicit loopback HTTP' >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo 'ArmorOpenCode installation failed: curl is required' >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo 'ArmorOpenCode installation failed: Bun is required' >&2; exit 1; }
mkdir -p "$ROOT/releases"
mkdir "$ROOT/.install-lock" 2>/dev/null || { echo 'ArmorOpenCode installation failed: another install is running' >&2; exit 1; }
trap 'rmdir "$ROOT/.install-lock" 2>/dev/null || true; cleanup' EXIT INT TERM
if [ -f "$RELEASE/ready" ]; then
  [ "$(cat "$RELEASE/ready")" = "$RELEASE_ID" ] || { echo 'ArmorOpenCode installation failed: invalid ready marker' >&2; exit 1; }
else
  [ ! -e "$RELEASE" ] || { [ -f "$RELEASE/.owner" ] && [ "$(cat "$RELEASE/.owner")" = "$OWNER" ] || { echo 'ArmorOpenCode installation failed: unowned release directory' >&2; exit 1; }; rm -rf "$RELEASE"; }
  TMP="$(mktemp -d "$ROOT/.download.XXXXXX")"
  BUNDLE_FILE="$TMP/$(basename "$BUNDLE")"
  curl --connect-timeout 20 --max-time 600 --proto "$DOWNLOAD_PROTOCOL" --proto-redir '=https' -fsSL "$RELEASE_BASE/$BUNDLE" -o "$BUNDLE_FILE"
  if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')"; else ACTUAL="$(sha256sum "$BUNDLE_FILE" | awk '{print $1}')"; fi
  [ "$ACTUAL" = "$BUNDLE_SHA256" ] || { echo 'ArmorOpenCode installation failed: release checksum mismatch' >&2; exit 1; }
  mkdir -p "$RELEASE"
  printf '%s\\n' "$OWNER" > "$RELEASE/.owner"
  tar -xzf "$BUNDLE_FILE" -C "$RELEASE"
  [ -f "$RELEASE/scripts/install.ts" ] || { echo 'ArmorOpenCode installation failed: release is missing scripts/install.ts' >&2; exit 1; }
  printf '%s\\n' "$RELEASE_ID" > "$RELEASE/ready"
fi
if [ "\${1-}" = '--uninstall' ]; then
  bun "$RELEASE/scripts/install.ts" "$@"
else
  bun "$RELEASE/scripts/install.ts" "$@"
  printf '%s\\n' "$RELEASE" > "$CURRENT.tmp"
  mv "$CURRENT.tmp" "$CURRENT"
fi
`;
}

function runTar(source: string, destination: string): void {
  const result = Bun.spawnSync(["tar", "-czf", destination, "-C", source, "."], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

export function stageRelease(repoRoot: string, output: string, publicBaseInput: string, version = packageVersion(repoRoot)): StagedRelease {
  const publicBase = validatePublicBase(publicBaseInput);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release version must be numeric major.minor.patch");
  if (existsSync(output)) throw new Error("Release output already exists");
  mkdirSync(join(output, "public"), { recursive: true });
  const work = mkdtempSync(join(output, ".bundle-"));
  try {
    for (const file of RELEASE_FILES) {
      const source = join(repoRoot, file);
      if (!existsSync(source)) throw new Error(`Release file is missing: ${file}`);
      const target = join(work, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(source, target);
    }
    const bundleName = `releases/armor-opencode/${version}/armoropencode-${version}.tar.gz`;
    const bundlePath = join(output, "public", bundleName);
    mkdirSync(resolve(bundlePath, ".."), { recursive: true });
    runTar(work, bundlePath);
    const bundleBytes = readFileSync(bundlePath);
    const installerPath = join(output, "public", `releases/armor-opencode/${version}/install_armoropencode.sh`);
    const templateHash = sha256(readFileSync(join(repoRoot, "scripts/build_release.ts")));
    const releaseId = sha256(JSON.stringify({ version, bundleSha256: sha256(bundleBytes), templateHash, publicBase }));
    const installer = installerTemplate(version, bundleName, sha256(bundleBytes), releaseId, publicBase);
    writeFileSync(installerPath, installer, { mode: 0o755 });
    const stablePath = join(output, "public", "install_armoropencode.sh");
    writeFileSync(stablePath, installer, { mode: 0o755 });
    const assets: ReleaseAsset[] = [
      { path: bundleName, contentType: "application/gzip", bytes: bundleBytes },
      { path: `releases/armor-opencode/${version}/install_armoropencode.sh`, contentType: "text/x-shellscript", bytes: Buffer.from(installer) },
      { path: "install_armoropencode.sh", contentType: "text/x-shellscript", bytes: Buffer.from(installer) },
    ];
    const manifest = { schemaVersion: 1, package: "@armoriq/armoropencode", version, releaseId, publicBase, assets: Object.fromEntries(assets.map((asset) => [asset.path, { sha256: sha256(asset.bytes), contentType: asset.contentType }])) };
    const manifestPath = join(output, "public", `releases/armor-opencode/${version}/release.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestAsset: ReleaseAsset = { path: `releases/armor-opencode/${version}/release.json`, contentType: "application/json", bytes: readFileSync(manifestPath) };
    const allAssets = [...assets, manifestAsset];
    writeFileSync(join(output, "safety-manifest.json"), `${JSON.stringify({ package: manifest.package, version, releaseId, assets: Object.fromEntries(allAssets.map((asset) => [asset.path, { sha256: sha256(asset.bytes), contentType: asset.contentType }])) }, null, 2)}\n`);
    return { version, releaseId, publicBase, assets: allAssets };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const argument = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const output = argument("--output");
  const publicBase = argument("--public-base") ?? "https://armoriq.ai";
  const version = argument("--version");
  if (!output) throw new Error("Usage: bun scripts/build_release.ts --output <dir> [--public-base <url>]");
  const release = stageRelease(resolve("."), resolve(output), publicBase, version);
  console.log(`Staged ${release.version} (${release.releaseId}) in ${output}`);
}
