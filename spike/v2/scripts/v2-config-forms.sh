#!/usr/bin/env bash
# Writes each candidate plugin entry into a sandbox V2 config, restarts the sandbox service,
# boots a location, and reports whether setup ran and which options it received.
# Usage: SANDBOX=/tmp/ocv2-spike bash v2-config-forms.sh <plugin-dir>
set -uo pipefail
S="${SANDBOX:?set SANDBOX}"
DIR="${1:?plugin dir}"
. "$S/env-v2.sh"
CFG="$HOME/.config/opencode/opencode.json"
WORK="$S/work-forms"
LOG="$HOME/.local/share/opencode/log/opencode.log"
mkdir -p "$WORK" && (cd "$WORK" && git init -q . 2>/dev/null)
cp "$CFG" "$S/opencode.json.bak"

run_form() {
  local name="$1" body="$2"
  export SPIKE_LOG="$S/form-$name.jsonl"
  rm -f "$SPIKE_LOG" "$WORK/.opencode" -r
  printf '%s\n' "$body" > "$CFG"
  local mark; mark=$(wc -l < "$LOG")
  opencode service restart </dev/null >/dev/null 2>&1
  (cd "$WORK" && opencode plugin list </dev/null >/dev/null 2>&1)
  sleep 2
  local setup; setup=$(jq -c 'select(.kind=="setup")|.payload.options' "$SPIKE_LOG" 2>/dev/null | head -1)
  printf '%-22s setup=%s\n' "$name" "${setup:-none}"
  tail -n +"$((mark + 1))" "$LOG" | grep -iE 'plugin' | grep -v watcher | sed 's/^/    /' | cut -c1-400
}

run_form plugins-path "{\"plugins\": [\"$DIR\"]}"
run_form plugins-fileurl "{\"plugins\": [\"file://$DIR\"]}"
run_form plugins-object "{\"plugins\": [{\"package\": \"$DIR\", \"options\": {\"backendUrl\": \"http://127.0.0.1:9\"}}]}"
run_form v1-plugin-string "{\"plugin\": [\"$DIR\"]}"
run_form v1-plugin-tuple "{\"plugin\": [[\"file://$DIR\", {\"backendUrl\": \"http://127.0.0.1:9\"}]]}"
mkdir -p "$WORK/.opencode/plugins"
export SPIKE_LOG="$S/form-project-dir.jsonl"; rm -f "$SPIKE_LOG"
cp "$DIR/index.mjs" "$WORK/.opencode/plugins/spike-logger.mjs"
printf '{}\n' > "$CFG"
mark=$(wc -l < "$LOG")
opencode service restart </dev/null >/dev/null 2>&1
(cd "$WORK" && opencode plugin list </dev/null >/dev/null 2>&1); sleep 2
printf '%-22s setup=%s\n' project-dir "$(jq -c 'select(.kind=="setup")|.payload.options' "$SPIKE_LOG" 2>/dev/null | head -1)"
tail -n +"$((mark + 1))" "$LOG" | grep -iE 'plugin' | grep -v watcher | sed 's/^/    /' | cut -c1-400
rm -rf "$WORK/.opencode"
# Stop first: a running service hot-reloads the restored config into the last SPIKE_LOG.
opencode service stop </dev/null >/dev/null 2>&1
cp "$S/opencode.json.bak" "$CFG"
