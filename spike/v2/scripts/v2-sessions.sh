#!/usr/bin/env bash
# Drives real V2 sessions with the logging plugin loaded and records V2's own usage numbers next to them.
# Usage: SANDBOX=/tmp/ocv2-spike/sessions V2PKG=<dir with @opencode/cli and @opencode/client installed>
#        PLUGIN=<repo>/spike/v2/plugin [PORT=49395] [MODEL=opencode/big-pickle] bash v2-sessions.sh
set -uo pipefail
S="${SANDBOX:?}"; V2PKG="${V2PKG:?}"; PLUGIN="${PLUGIN:?}"; MODEL="${MODEL:-opencode/big-pickle}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$S/out"; mkdir -p "$S/home/.config/opencode" "$S/work" "$OUT"
export HOME="$S/home" SPIKE_LOG="$OUT/plugin-events.jsonl"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
export PATH="$V2PKG/node_modules/.bin:/usr/bin:/bin:$(dirname "$(command -v node)")"
(cd "$S/work" && git init -q . 2>/dev/null)
cp "$HERE/session-usage.mjs" "$V2PKG/"
printf '{"plugins": ["%s"]}\n' "$PLUGIN" > "$HOME/.config/opencode/opencode.json"
opencode service set port "${PORT:-49395}" >/dev/null
opencode debug paths > "$OUT/debug-paths.txt"
cd "$S/work"
opencode service start </dev/null >/dev/null 2>&1

# `opencode run` waits for EOF on a non-TTY stdin, so every call closes it.
opencode run --auto -m "$MODEL" --format json --title "spike run 1" \
  "Do these steps in order using tools: 1) write a file notes.txt containing the word hello. 2) run the shell command 'ls -la' . 3) use the task tool to launch a general subagent that reads notes.txt and reports its contents. 4) reply with the single word done." \
  </dev/null > "$OUT/run1-cli.jsonl" 2> "$OUT/run1-cli.err"
opencode run --auto -m "$MODEL" --format json \
  "Read notes.txt with the read tool, then tell me in one sentence what it says." \
  </dev/null > "$OUT/run2-cli.jsonl" 2> "$OUT/run2-cli.err"
sleep 3

ids=$(jq -r 'select(.kind=="event" and .payload.type=="session.created") | .payload.data.sessionID' "$SPIKE_LOG")
(cd "$V2PKG" && node session-usage.mjs $ids) > "$OUT/session-get.jsonl"
opencode stats --json --full </dev/null > "$OUT/stats-full.json" 2>/dev/null

echo "== per session: sum of session.step.ended vs last session.usage.updated vs session.get vs stats"
jq -s '
  [.[] | select(.kind=="event") | .payload] as $e
  | ($e | map(select(.type=="session.step.ended") | .data) | group_by(.sessionID)
      | map({key: .[0].sessionID, value: {steps: length, input: (map(.tokens.input)|add), output: (map(.tokens.output)|add),
             reasoning: (map(.tokens.reasoning)|add), cacheRead: (map(.tokens.cache.read)|add), cacheWrite: (map(.tokens.cache.write)|add)}})
      | from_entries) as $steps
  | ($e | map(select(.type=="session.usage.updated") | .data) | group_by(.sessionID) | map({key: .[0].sessionID, value: last.tokens}) | from_entries) as $usage
  | ($e | map(select(.type=="session.created") | .data) | map({id: .sessionID, parentID}))
  | map(. + {stepSum: $steps[.id], lastUsageUpdated: $usage[.id]})' "$SPIKE_LOG"
jq -c '{id, parentID, title, model, tokens, cost, outcome, idle: .time.idle}' "$OUT/session-get.jsonl"
jq -c '{sessions, subagents, prompts, steps, tokens, cost}' "$OUT/stats-full.json"

echo "== delete the first top-level session"
first=$(jq -r 'select(.parentID == null) | .id' "$OUT/session-get.jsonl" | head -1)
mark=$(wc -l < "$SPIKE_LOG")
opencode session delete "$first" </dev/null
sleep 2
tail -n +"$((mark + 1))" "$SPIKE_LOG" | jq -c 'select(.payload.type=="session.deleted") | .payload'

echo "== event types seen"
jq -r 'select(.kind=="event") | .payload.type' "$SPIKE_LOG" | sort | uniq -c | sort -rn
DB="$HOME/.local/share/opencode/opencode.db"
sqlite3 -readonly -json "$DB" "select id, parent_id, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_idle, idle_outcome from session_v2" > "$OUT/session_v2-after-delete.json"
opencode service stop </dev/null >/dev/null 2>&1
