#!/usr/bin/env bash
# Which file does V2 load for a local directory entry, and what does it log for a V1-only export?
# Runs in the sandbox left by upgrade-major.sh (V2 on its npm prefix, ArmorOpenCode installed).
# Usage: SANDBOX=/tmp/ocv2-spike/up LOGGER=<repo>/spike/v2/plugin/index.mjs [PORT=49392] bash v2-entry-resolution.sh
set -uo pipefail
S="${SANDBOX:?}"; LOGGER="${LOGGER:?}"
export HOME="$S/home"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
export PATH="$S/home/.npm-global/bin:/usr/bin:/bin:$(dirname "$(command -v node)")"
CFG="$HOME/.config/opencode/opencode.json"; LOG="$HOME/.local/share/opencode/log/opencode.log"
INSTALLED="$HOME/.armoriq/armoropencode/plugin"
opencode service set port "${PORT:-49392}" >/dev/null
cp "$CFG" "$S/cfg.orig"

probe() {
  local dir="$1" name="$2" mark
  opencode service stop </dev/null >/dev/null 2>&1
  printf '{"plugin": [["file://%s", {"backendUrl": "http://127.0.0.1:9"}]]}\n' "$dir" > "$CFG"
  mark=$(wc -l < "$LOG")
  export SPIKE_LOG="$S/probe-$name.jsonl"; rm -f "$SPIKE_LOG"
  (cd "$S/work" && opencode service start </dev/null >/dev/null 2>&1; opencode plugin list </dev/null >/dev/null 2>&1)
  sleep 3
  printf '\n## %s: %s\n' "$name" "$(cd "$dir" && ls -R | tr '\n' ' ')"
  [[ -f "$dir/package.json" ]] && printf 'package.json: %s\n' "$(tr -d '\n' < "$dir/package.json")"
  printf 'setup ran: %s\n' "$([[ -s "$SPIKE_LOG" ]] && echo yes || echo no)"
  tail -n +"$((mark + 1))" "$LOG" | grep -E 'loading plugin|failed to load|configured plugin path' | cut -c1-600
}

mk() {
  local name="$1" entry="$2" pkg="$3" d="$S/$1"
  rm -rf "$d"; mkdir -p "$d/$(dirname "$entry")"; cp "$LOGGER" "$d/$entry"
  [[ -n "$pkg" ]] && printf '%s\n' "$pkg" > "$d/package.json"
  probe "$d" "$name"
}

mk index-mjs index.mjs '{"name":"x","type":"module","main":"./index.mjs","exports":{".":"./index.mjs"}}'
mk index-ts-no-package index.ts ''
mk main-src-plugin-ts src/plugin.ts '{"name":"@armoriq/armoropencode","type":"module","main":"src/plugin.ts","exports":{".":"./src/plugin.ts"}}'
mk main-root-plugin-ts plugin.ts '{"name":"x","type":"module","main":"plugin.ts","exports":{".":"./plugin.ts"}}'
mk main-foo-mjs foo.mjs '{"name":"x","type":"module","main":"foo.mjs"}'

v1only="$S/v1-only"; rm -rf "$v1only"; mkdir -p "$v1only"
printf 'export default { id: "armoropencode", server: async () => ({}) }\n' > "$v1only/index.ts"
probe "$v1only" v1-only-export

probe "$INSTALLED" installed-armoropencode-as-is
printf 'export { default } from "./src/plugin.ts"\n' > "$INSTALLED/index.ts"
probe "$INSTALLED" installed-armoropencode-with-root-index
rm "$INSTALLED/index.ts"

opencode service stop </dev/null >/dev/null 2>&1
cp "$S/cfg.orig" "$CFG"
