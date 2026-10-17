#!/usr/bin/env bash
# Usage: run.sh NAME 'MODE_JSON' 'PROMPT' [extra opencode run flags]
# Saves the plugin log, the CLI json stream and stderr under payloads/NAME/.
set -uo pipefail
. "${SB:?source the sandbox env.sh first}/env.sh"
NAME=$1 MODE=$2 PROMPT=$3; shift 3
OUT="$SPIKE/payloads/$NAME"; mkdir -p "$OUT"
echo "$MODE" > "$SB/mode.json"; : > "$SB/events.jsonl"
cd "$SB/proj" && find . -maxdepth 1 -type f ! -name opencode.json -delete && printf "line one\nline two\n" > notes.txt
start=$(date +%s)
perl -e 'alarm $ENV{ALARM}||300; exec @ARGV' opencode2 run --standalone -m "${MODEL:-opencode/big-pickle}" --format json "$@" "$PROMPT" \
  > "$OUT/run.jsonl" 2> "$OUT/stderr.txt"
code=$?
cp "$SB/events.jsonl" "$OUT/plugin.jsonl"
printf '{"name":"%s","exit":%s,"seconds":%s,"flags":"%s"}\n' "$NAME" "$code" "$(( $(date +%s)-start ))" "$*" > "$OUT/meta.json"
echo "$MODE" > "$OUT/mode.json"; printf '%s\n' "$PROMPT" > "$OUT/prompt.txt"
sed -i "" -e "s#$SB#\$SB#g" -e "s#$SPIKE#\$SPIKE#g" "$OUT"/*.jsonl "$OUT"/*.txt 2>/dev/null
cat "$OUT/meta.json"
