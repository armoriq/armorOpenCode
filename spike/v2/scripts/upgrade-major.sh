#!/usr/bin/env bash
# V1 sandbox with ArmorOpenCode installed by install_armoropencode.sh, then `opencode upgrade --major`.
# Everything lives under $SANDBOX: HOME, the npm global prefix, the OpenCode config and data.
# Usage: SANDBOX=/tmp/ocv2-spike/up REPO=/path/to/armorOpenCode REF=<branch> bash upgrade-major.sh
set -uo pipefail
S="${SANDBOX:?}"; REPO="${REPO:?}"; REF="${REF:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$S/home" "$S/work"
export HOME="$S/home" NPM_CONFIG_PREFIX="$S/home/.npm-global"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
export PATH="$NPM_CONFIG_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"
(cd "$S/work" && git init -q . 2>/dev/null)

step() { printf '\n===== %s\n' "$*"; }

step "install OpenCode 1.19.0 into the sandbox npm prefix"
npm install -g --no-audit --no-fund opencode-ai@1.19.0 2>&1 | tail -2
command -v opencode; opencode --version

step "install ArmorOpenCode from the local checkout"
ARMOROPENCODE_REPO_URL="$REPO" ARMOROPENCODE_GIT_REF="$REF" ARMORIQ_BACKEND_URL=http://127.0.0.1:9 \
  ARMOROPENCODE_LOGIN_CLI="bash $HERE/stub-login.sh" \
  bash "$REPO/install_armoropencode.sh" </dev/null 2>&1
step "config after install"
cat "$HOME/.config/opencode/opencode.json"
cp "$HOME/.config/opencode/opencode.json" "$S/config-before.json"

step "V1 session with the installed plugin"
(cd "$S/work" && opencode run -m opencode/big-pickle --print-logs --log-level INFO "Reply with the single word done." </dev/null 2>"$S/v1-session.log" | tail -3)
grep -iE 'plugin' "$S/v1-session.log" | grep -iE 'armor|loading|error|warn' | cut -c1-400 | head -10

step "opencode upgrade --major --method npm"
opencode upgrade --major --method npm </dev/null 2>&1 | tr "\r" "\n" | grep -v "Installing OpenCode 2" | tail -12
hash -r
command -v opencode opencode2; opencode --version
ls "$NPM_CONFIG_PREFIX/lib/node_modules"

step "config after upgrade"
cat "$HOME/.config/opencode/opencode.json"
diff "$S/config-before.json" "$HOME/.config/opencode/opencode.json" && echo "config unchanged by the upgrade"
