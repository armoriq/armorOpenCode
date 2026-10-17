#!/usr/bin/env bash
# Usage: tui.sh NAME 'MODE_JSON' 'PROMPT' [extra flags]. Starts the TUI in tmux and leaves it running;
# drive with tmux send-keys -t oc2spike and capture with tmux capture-pane -p -t oc2spike.
set -euo pipefail
. "${SB:?source the sandbox env.sh first}/env.sh"
NAME=$1 MODE=$2 PROMPT=$3; shift 3
OUT="$SPIKE/payloads/$NAME"; mkdir -p "$OUT"
echo "$MODE" > "$SB/mode.json"; : > "$SB/events.jsonl"
echo "$MODE" > "$OUT/mode.json"; printf '%s\n' "$PROMPT" > "$OUT/prompt.txt"
tmux kill-session -t oc2spike 2>/dev/null || true
tmux new-session -d -s oc2spike -x 160 -y 50 -c "$SB/proj" \
  "env HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_DATA_HOME=$XDG_DATA_HOME XDG_STATE_HOME=$XDG_STATE_HOME XDG_CACHE_HOME=$XDG_CACHE_HOME PATH=$PATH opencode2 --standalone $* --prompt $(printf %q "$PROMPT")"
