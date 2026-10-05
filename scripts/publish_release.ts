#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ManifestAsset { sha256: string; contentType: string }
interface SafetyManifest { package: string; version: string; releaseId: string; assets: Record<string, ManifestAsset> }

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function publicationPlan(manifest: SafetyManifest, bucket: string): string[] {
  if (manifest.package !== "@armoriq/armoropencode" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid release manifest");
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error("Invalid bucket name");
  return Object.keys(manifest.assets).sort((a, b) => Number(a === "install_armoropencode.sh") - Number(b === "install_armoropencode.sh") || a.localeCompare(b)).map((path) => `gs://${bucket}/${path}`);
}

function parseArgs(argv: string[]): { release: string; bucket: string; project: string; account: string; apply: boolean } {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index === -1 || !argv[index + 1]) throw new Error(`${flag} requires a value`);
    return argv[index + 1]!;
  };
  return {
    release: resolve(value("--release")),
    bucket: value("--bucket"),
    project: value("--project"),
    account: value("--account"),
    apply: argv.includes("--apply"),
  };
}

function text(value: Uint8Array): string { return new TextDecoder().decode(value); }

function cloud(args: string[], project: string, account: string): { success: boolean; stdout: Uint8Array; stderr: Uint8Array } {
  return Bun.spawnSync(["gcloud", ...args, `--project=${project}`, `--account=${account}`, "--quiet"], { stdout: "pipe", stderr: "pipe" });
}

function objectGeneration(bucket: string, path: string, project: string, account: string): number | null {
  const result = cloud(["storage", "objects", "describe", `gs://${bucket}/${path}`, "--raw", "--format=json"], project, account);
  if (!result.success) {
    if (/\b404\b|not found/i.test(text(result.stderr))) return null;
    throw new Error(`Cannot inspect ${path}: ${text(result.stderr).trim()}`);
  }
  const metadata = JSON.parse(text(result.stdout)) as { generation?: unknown };
  if (typeof metadata.generation !== "string" || !/^\d+$/.test(metadata.generation)) throw new Error(`Object metadata lacks a generation: ${path}`);
  return Number(metadata.generation);
}

function objectBytes(bucket: string, path: string, project: string, account: string): Uint8Array {
  const result = cloud(["storage", "cat", `gs://${bucket}/${path}`], project, account);
  if (!result.success) throw new Error(`Cannot read existing ${path}: ${text(result.stderr).trim()}`);
  return result.stdout;
}

export function main(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(join(options.release, "safety-manifest.json"), "utf8")) as SafetyManifest;
  const targets = publicationPlan(manifest, options.bucket);
  for (const [path, expected] of Object.entries(manifest.assets)) {
    if (path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) throw new Error(`Unsafe release asset path: ${path}`);
    const local = readFileSync(join(options.release, "public", path));
    if (sha256(local) !== expected.sha256) throw new Error(`Release checksum mismatch: ${path}`);
  }
  console.log(`Validated ${manifest.package} ${manifest.version} (${manifest.releaseId})`);
  for (const target of targets) console.log(target);
  if (!options.apply) {
    console.log("Dry run. No cloud commands were called. Add --apply only after reviewing this release.");
    return;
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(options.project)) throw new Error("Invalid project ID");
  if (!/^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+$/.test(options.account)) throw new Error("Invalid publisher account");
  const project = cloud(["projects", "describe", options.project, "--format=json"], options.project, options.account);
  if (!project.success) throw new Error(`Project inspection failed: ${text(project.stderr)}`);
  const projectMetadata = JSON.parse(text(project.stdout)) as { projectNumber?: unknown };
  if (typeof projectMetadata.projectNumber !== "string" || !/^\d+$/.test(projectMetadata.projectNumber)) throw new Error("Project metadata lacks a project number");
  const bucket = cloud(["storage", "buckets", "describe", `gs://${options.bucket}`, "--raw", "--format=json"], options.project, options.account);
  if (!bucket.success) throw new Error(`Bucket inspection failed: ${text(bucket.stderr)}`);
  const bucketMetadata = JSON.parse(text(bucket.stdout)) as { projectNumber?: unknown; labels?: Record<string, string> };
  if (bucketMetadata.projectNumber !== projectMetadata.projectNumber) throw new Error("Release bucket belongs to a different project");
  if (bucketMetadata.labels?.["armor-opencode-releases"] !== "true") throw new Error("Bucket lacks armor-opencode-releases=true label");
  for (const path of targets.map((target) => target.replace(`gs://${options.bucket}/`, ""))) {
    const expected = manifest.assets[path]!;
    const stable = path === "install_armoropencode.sh";
    const local = readFileSync(join(options.release, "public", path));
    const generation = objectGeneration(options.bucket, path, options.project, options.account);
    if (!stable && generation !== null) {
      if (sha256(objectBytes(options.bucket, path, options.project, options.account)) !== expected.sha256) throw new Error(`Immutable release asset already exists with different bytes: ${path}`);
      continue;
    }
    const precondition = generation ?? 0;
    const uploaded = cloud(["storage", "cp", join(options.release, "public", path), `gs://${options.bucket}/${path}`, `--if-generation-match=${precondition}`, `--content-type=${expected.contentType}`, `--cache-control=${stable ? "no-store" : "public,max-age=31536000,immutable"}`], options.project, options.account);
    if (!uploaded.success) throw new Error(`Upload failed for ${path}: ${text(uploaded.stderr)}`);
    if (sha256(local) !== expected.sha256) throw new Error(`Local release changed during upload: ${path}`);
  }
}

if (import.meta.main) main();
