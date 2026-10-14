#!/usr/bin/env bash
# V1 1.19.0 and V2 2.0.29 under one sandbox HOME: binaries, shared config, shared data.
# Usage: SANDBOX=/tmp/ocv2-spike/both PLUGIN=<dual-export plugin dir> [PORT=49393] bash coexist.sh
set -uo pipefail
S="${SANDBOX:?}"; PLUGIN="${PLUGIN:?}"
mkdir -p "$S/home" "$S/work"
export HOME="$S/home"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
NODE_DIR="$(dirname "$(command -v node)")"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$NODE_DIR"
(cd "$S/work" && git init -q . 2>/dev/null)
step() { printf '\n===== %s\n' "$*"; }

step "one npm prefix: opencode-ai@1.19.0 then @opencode/cli@2.0.29"
export NPM_CONFIG_PREFIX="$S/home/.npm-shared"
npm install -g --no-audit --no-fund opencode-ai@1.19.0 2>&1 | tail -1
npm install -g --no-audit --no-fund @opencode/cli@2.0.29 2>&1 | grep -E "EEXIST|ERR|added|changed" | head -5
ls -la "$NPM_CONFIG_PREFIX/bin"
"$NPM_CONFIG_PREFIX/bin/opencode" --version

step "separate prefixes"
V1="$S/home/.npm-v1/bin/opencode"; V2="$S/home/.npm-v2/bin/opencode"
NPM_CONFIG_PREFIX="$S/home/.npm-v1" npm install -g --no-audit --no-fund opencode-ai@1.19.0 2>&1 | tail -1
NPM_CONFIG_PREFIX="$S/home/.npm-v2" npm install -g --no-audit --no-fund @opencode/cli@2.0.29 2>&1 | tail -1
unset NPM_CONFIG_PREFIX
"$V1" --version; "$V2" --version; "$S/home/.npm-v2/bin/opencode2" --version
"$V2" service set port "${PORT:-49393}" >/dev/null

mkdir -p "$HOME/.config/opencode"
CFG="$HOME/.config/opencode/opencode.json"
V1_ENTRY="\"plugin\": [[\"file://$PLUGIN\", {\"backendUrl\": \"http://127.0.0.1:9\"}]]"
V2_ENTRY="\"plugins\": [{\"package\": \"file://$PLUGIN\", \"options\": {\"backendUrl\": \"http://127.0.0.1:9\"}}]"
for case in v1-key v2-key both-keys; do
  case "$case" in
    v1-key) body="{$V1_ENTRY}" ;;
    v2-key) body="{$V2_ENTRY}" ;;
    both-keys) body="{$V1_ENTRY, $V2_ENTRY}" ;;
  esac
  step "shared config, $case: $body"
  # Stop first: a running service hot-reloads config edits into the previous SPIKE_LOG.
  "$V2" service stop </dev/null >/dev/null 2>&1
  printf '%s\n' "$body" > "$CFG"
  export SPIKE_LOG="$S/coexist-$case.jsonl"; rm -f "$SPIKE_LOG"
  (cd "$S/work" && "$V1" run -m opencode/big-pickle "Reply with the single word done." </dev/null 2>&1 | tail -1)
  (cd "$S/work" && "$V2" service start </dev/null >/dev/null 2>&1; "$V2" run --auto -m opencode/big-pickle "Reply with the single word done." </dev/null 2>&1 | tail -1)
  sleep 2
  "$V2" service stop </dev/null >/dev/null 2>&1
  # V1 1.18/1.19 also call setup, with a partial context; only V2 passes the event domain.
  jq -r 'if .kind=="init" then "V1 server() called"
         elif .kind=="setup" and (.payload.contextKeys|index("event")) then "V2 setup() called (full context)"
         elif .kind=="setup" then "V1 setup() called (partial context)"
         else empty end' "$SPIKE_LOG" 2>/dev/null | sort | uniq -c
done

step "shared data dir after both ran"
ls "$HOME/.local/share/opencode"
sqlite3 -readonly "$HOME/.local/share/opencode/opencode.db" "select 'v1 session rows', count(*) from session; select 'v2 session_v2 rows', count(*) from session_v2;"
(cd "$S/work" && "$V2" session list </dev/null 2>&1 | head -10)
(cd "$S/work" && "$V1" session list </dev/null 2>&1 | head -10)
