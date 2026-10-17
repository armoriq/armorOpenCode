#!/usr/bin/env bash
# Usage: setup-sandbox.sh [SANDBOX_DIR]. Never touches the real HOME.
set -euo pipefail
SPIKE=$(cd "$(dirname "$0")/.." && pwd)
SB=${1:-$(mktemp -d /tmp/oc2spike.XXXX)}
mkdir -p "$SB/home" "$SB/pkg" "$SB/proj"
[ -x "$SB/pkg/node_modules/.bin/opencode2" ] || (cd "$SB/pkg" && npm init -y >/dev/null && npm i @opencode/cli@2.0.29 >/dev/null)
cat > "$SB/env.sh" <<ENV
export HOME=$SB/home XDG_CONFIG_HOME=$SB/home/.config XDG_DATA_HOME=$SB/home/.local/share XDG_STATE_HOME=$SB/home/.local/state XDG_CACHE_HOME=$SB/home/.cache
export PATH=$SB/pkg/node_modules/.bin:\$PATH
unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR ANTHROPIC_API_KEY OPENAI_API_KEY
export SB=$SB SPIKE=$SPIKE
ENV
cat > "$SB/proj/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle",
  "plugins": [
    { "package": "$SPIKE/plugin", "options": { "out": "$SB/events.jsonl", "mode": "$SB/mode.json" } }
  ],
  "mcp": {
    "servers": { "spike": { "type": "local", "command": ["node", "$SPIKE/scripts/mcp-echo.mjs"] } }
  }
}
JSON
printf 'line one\nline two\n' > "$SB/proj/notes.txt"
echo '{}' > "$SB/mode.json"
[ -d "$SB/proj/.git" ] || git -C "$SB/proj" init -q
echo "$SB"
