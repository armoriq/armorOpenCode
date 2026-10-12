#!/usr/bin/env bash
# Exports ArmorClaude's policy and intent modules at a pinned commit so the
# parity tests can import the original code. Usage:
#   ARMORCLAUDE_REPO=/path/to/armorClaude test/parity/export-armorclaude.sh
set -euo pipefail
repo="${ARMORCLAUDE_REPO:?set ARMORCLAUDE_REPO to an armorClaude checkout}"
ref="${ARMORCLAUDE_REF:-8e1b57f4be520037e4201a325196ffd2b65c2a2c}"
out="${ARMORCLAUDE_LIB:-/tmp/armorclaude-ref}"
here="$(cd "$(dirname "$0")/../.." && pwd)"

git -C "$repo" cat-file -e "$ref^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin dev
mkdir -p "$out/scripts/lib"
for f in $(git -C "$repo" ls-tree --name-only "$ref" scripts/lib/); do
  git -C "$repo" show "$ref:$f" > "$out/$f"
done
ln -sfn "$here/node_modules" "$out/node_modules"
echo "exported armorClaude $ref to $out"
