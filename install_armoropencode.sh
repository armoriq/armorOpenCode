#!/usr/bin/env bash
set -euo pipefail

# ArmorOpenCode installer for OpenCode.
#
# Usage:
#   curl -fsSL <url>/install_armoropencode.sh | bash
#   bash install_armoropencode.sh [--uninstall [--purge]]
#
# Clones github.com/armoriq/armorOpenCode into ~/.armoriq/armoropencode/plugin,
# installs its runtime dependencies, and adds that directory to the plugin
# array of the global OpenCode config (~/.config/opencode/opencode.json or
# .jsonc). Comments and every other key are preserved, and re-running updates
# the checkout and its dependencies. Then signs in with the ArmorIQ CLI unless a login for
# the armoropencode product on the chosen backend already exists.
#
# Flags:
#   --uninstall   remove the ArmorOpenCode plugin entry (keeps the login)
#   --purge       with --uninstall, also delete ~/.armoriq/armoropencode
#   --force-login sign in again even when a login exists
#
# Environment:
#   ARMORIQ_BACKEND_URL      backend (default: the installed entry's backendUrl,
#                            else https://api.armoriq.ai; staging is
#                            https://staging-api.armoriq.ai)
#   ARMOROPENCODE_GIT_REF    branch or tag to install (default the newest
#                            v<version> release tag, else main)
#   ARMOROPENCODE_REPO_URL   git source (default the public GitHub repo)

PACKAGE="@armoriq/armoropencode"
PRODUCT="armoropencode"
SDK_SPEC="@armoriq/sdk-dev@^0.8.17"
MIN_OPENCODE_MINOR=18
DEFAULT_BACKEND="https://api.armoriq.ai"

BACKEND="${ARMORIQ_BACKEND_URL:-}"
REPO_URL="${ARMOROPENCODE_REPO_URL:-https://github.com/armoriq/armorOpenCode.git}"
GIT_REF="${ARMOROPENCODE_GIT_REF:-}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
CONFIG_NAMES=(opencode.jsonc opencode.json config.json)
CREDENTIALS="${HOME}/.armoriq/credentials.json"
DATA_DIR="${HOME}/.armoriq/armoropencode"
PLUGIN_DIR="${DATA_DIR}/plugin"

if [[ -t 1 ]]; then
  R=$'\033[1;31m' G=$'\033[32m' Y=$'\033[33m' B=$'\033[1m' D=$'\033[0;90m' N=$'\033[0m'
else
  R="" G="" Y="" B="" D="" N=""
fi
ok()      { printf "%s[ok]%s %s\n" "${G}" "${N}" "$*"; }
warn()    { printf "%s[warn]%s %s\n" "${Y}" "${N}" "$*" >&2; }
err()     { printf "%s[error]%s %s\n" "${R}" "${N}" "$*" >&2; }
info()    { printf "%s-%s %s\n" "${D}" "${N}" "$*"; }
section() { printf "\n%s%s%s\n" "${B}" "$*" "${N}"; }
die()     { err "$*"; printf "\n%sArmorOpenCode was NOT installed.%s\n" "${R}" "${N}" >&2; exit 1; }

pwd >/dev/null 2>&1 || cd "${HOME:-/}"

DO_UNINSTALL=0
PURGE=0
FORCE_LOGIN=0
for arg in "$@"; do
  case "${arg}" in
    --uninstall) DO_UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --force-login) FORCE_LOGIN=1 ;;
    -h|--help) sed -n '4,25p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
    *) err "unknown argument: ${arg}"; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/armoropencode.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

# >>> config-editor (keep identical in install_armoropencode.sh and uninstall_armoropencode.sh)
write_config_editor() {
  cat > "${WORK}/config-editor.mjs" <<'JS'
import { accessSync, chmodSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [mode, file, pkg, spec, optionsJson] = process.argv.slice(2);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 2;
      continue;
    }
    if ("{}[]:,".includes(c)) { tokens.push({ t: c, s: i, e: i + 1 }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new Error("unterminated string");
      tokens.push({ t: "str", s: i, e: j + 1, v: JSON.parse(src.slice(i, j + 1)) });
      i = j + 1;
      continue;
    }
    const m = /^(-?\d[\d.eE+-]*|true|false|null)/.exec(src.slice(i));
    if (!m) throw new Error(`unexpected character at offset ${i}`);
    tokens.push({ t: "lit", s: i, e: i + m[0].length });
    i += m[0].length;
  }
  return tokens;
}

function parse(src) {
  const tokens = tokenize(src);
  let k = 0;
  const peek = () => tokens[k];
  const take = (t) => {
    const tok = tokens[k];
    if (!tok || (t && tok.t !== t)) throw new Error(`expected ${t} at offset ${tok ? tok.s : src.length}`);
    k++;
    return tok;
  };
  function value() {
    const tok = peek();
    if (!tok) throw new Error("unexpected end of input");
    if (tok.t === "{") {
      take("{");
      const props = [];
      while (peek() && peek().t !== "}") {
        const key = take("str");
        take(":");
        const v = value();
        props.push({ key: key.v, s: key.s, e: v.e, value: v });
        if (peek() && peek().t === ",") take(",");
        else break;
      }
      const close = take("}");
      return { type: "object", s: tok.s, e: close.e, props };
    }
    if (tok.t === "[") {
      take("[");
      const items = [];
      while (peek() && peek().t !== "]") {
        items.push(value());
        if (peek() && peek().t === ",") take(",");
        else break;
      }
      const close = take("]");
      return { type: "array", s: tok.s, e: close.e, items };
    }
    if (tok.t === "str") { take(); return { type: "string", s: tok.s, e: tok.e, v: tok.v }; }
    if (tok.t === "lit") { take(); return { type: "literal", s: tok.s, e: tok.e }; }
    throw new Error(`unexpected ${tok.t} at offset ${tok.s}`);
  }
  const root = value();
  if (k !== tokens.length) throw new Error(`trailing content at offset ${tokens[k].s}`);
  if (root.type !== "object") throw new Error("top level must be an object");
  return root;
}

function packageOf(entry) {
  if (/^(file:\/\/|\/)/.test(entry) && /[\\/]armoropencode[\\/]plugin[\\/]?$/.test(entry)) return "@armoriq/armoropencode";
  const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0);
  return at < 0 ? entry : entry.slice(0, at);
}

function entrySpec(node) {
  if (node.type === "string") return node.v;
  if (node.type === "array" && node.items[0]?.type === "string") return node.items[0].v;
  return null;
}

function pluginArray(root) {
  const props = root.props.filter((p) => p.key === "plugin");
  if (props.length > 1) throw new Error('"plugin" is declared more than once');
  if (props.length === 0) return { prop: null, arr: null };
  if (props[0].value.type !== "array") throw new Error('"plugin" must be an array');
  return { prop: props[0], arr: props[0].value };
}

const isBlank = (text) => text.trim() === "";
const splice = (src, s, e, text = "") => src.slice(0, s) + text + src.slice(e);

function indentBefore(src, offset) {
  const lineStart = src.lastIndexOf("\n", offset - 1) + 1;
  return src.slice(lineStart, offset).match(/^[ \t]*/)[0];
}

function appendMember(src, open, close, members, text) {
  if (members.length === 0) {
    if (!isBlank(src.slice(open + 1, close - 1))) return splice(src, close - 1, close - 1, text);
    return splice(src, open + 1, close - 1, src[open] === "{" ? `\n  ${text}\n` : text);
  }
  const last = members[members.length - 1];
  const multiline = src.slice(open, members[0].s).includes("\n");
  const sep = multiline ? `,\n${indentBefore(src, members[0].s)}` : ", ";
  return splice(src, last.e, last.e, sep + text);
}

function removeMember(src, members, index, open, close) {
  const node = members[index];
  if (index > 0) {
    const prev = members[index - 1];
    const gap = src.slice(prev.e, node.s);
    if (/^\s*,\s*$/.test(gap)) return splice(src, prev.e, node.e);
    const comma = prev.e + tokenize(gap)[0].s;
    return splice(splice(src, node.s, node.e), comma, comma + 1);
  }
  if (members.length > 1) {
    const next = members[1];
    const gap = src.slice(node.e, next.s);
    if (/^\s*,\s*$/.test(gap)) return splice(src, node.s, next.s);
    const comma = node.e + tokenize(gap)[0].s;
    const lineStart = src.lastIndexOf("\n", node.s - 1) + 1;
    const lineEnd = src.indexOf("\n", comma);
    if (isBlank(src.slice(lineStart, node.s)) && lineEnd >= 0 && lineEnd < next.s) {
      return splice(src, lineStart, lineEnd + 1);
    }
    const tail = /^[ \t]*/.exec(src.slice(comma + 1))[0].length;
    return splice(splice(src, comma, comma + 1 + tail), node.s, node.e);
  }
  const after = src.slice(node.e, close - 1);
  const trailing = /^\s*,/.exec(after);
  if (isBlank(src.slice(open + 1, node.s)) && isBlank(after.replace(/^\s*,/, ""))) {
    return splice(src, open + 1, close - 1);
  }
  return splice(src, node.s, node.e + (trailing ? trailing[0].length : 0));
}

function ours(arr) {
  return arr ? arr.items.map((node, i) => ({ node, i })).filter(({ node }) => {
    const s = entrySpec(node);
    return s !== null && packageOf(s) === pkg;
  }) : [];
}

function render(desiredSpec, options) {
  return options && Object.keys(options).length > 0
    ? `[${JSON.stringify(desiredSpec)}, ${JSON.stringify(options)}]`
    : JSON.stringify(desiredSpec);
}

function sameEntry(src, node, text) {
  return src.slice(node.s, node.e).replace(/\s+/g, "") === text.replace(/\s+/g, "");
}

function toValue(src, node) {
  if (node.type === "object") return Object.fromEntries(node.props.map((p) => [p.key, toValue(src, p.value)]));
  if (node.type === "array") return node.items.map((item) => toValue(src, item));
  if (node.type === "string") return node.v;
  return JSON.parse(src.slice(node.s, node.e));
}

function entryOptions(src, node) {
  return node.type === "array" && node.items[1]?.type === "object" ? toValue(src, node.items[1]) : null;
}

function add(src) {
  let root = parse(src);
  let { arr } = pluginArray(root);
  let found = ours(arr);
  const existing = found.length > 0 ? entryOptions(src, found[0].node) : null;
  const text = render(spec, { ...existing, ...(optionsJson ? JSON.parse(optionsJson) : null) });
  if (found.length === 1 && sameEntry(src, found[0].node, text)) return { src, status: "present" };
  let status = "added";
  if (found.length > 0) {
    status = "updated";
    for (let n = found.length - 1; n >= 1; n--) {
      src = removeMember(src, arr.items, found[n].i, arr.s, arr.e);
      ({ arr } = pluginArray(parse(src)));
    }
    found = ours(arr);
    src = splice(src, found[0].node.s, found[0].node.e, text);
  } else if (arr) {
    src = appendMember(src, arr.s, arr.e, arr.items, text);
  } else {
    src = appendMember(src, root.s, root.e, root.props, `"plugin": [${text}]`);
  }
  return { src, status };
}

function remove(src) {
  let removed = 0;
  for (;;) {
    const { arr } = pluginArray(parse(src));
    const found = ours(arr);
    if (found.length === 0) break;
    src = removeMember(src, arr.items, found[found.length - 1].i, arr.s, arr.e);
    removed++;
  }
  if (removed === 0) return { src, status: "absent" };
  const root = parse(src);
  const { prop, arr } = pluginArray(root);
  if (arr && arr.items.length === 0 && isBlank(src.slice(arr.s + 1, arr.e - 1))) {
    src = removeMember(src, root.props, root.props.indexOf(prop), root.s, root.e);
  }
  return { src, status: "removed" };
}

function save(path, text) {
  const target = existsSync(path) ? realpathSync(path) : path;
  if (existsSync(target)) {
    try { accessSync(target, constants.W_OK); } catch { throw new Error("is read-only, refusing to edit it"); }
  }
  const tmp = join(dirname(target), `.${basename(target)}.armoropencode-${process.pid}`);
  writeFileSync(tmp, text, { flag: "wx" });
  try {
    if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o7777);
    parse(readFileSync(tmp, "utf8"));
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

try {
  const exists = existsSync(file);
  const src = exists ? readFileSync(file, "utf8") : null;
  if (mode === "validate") {
    if (src !== null) pluginArray(parse(src));
    process.stdout.write("valid");
  } else if (mode === "count") {
    process.stdout.write(String(src === null ? 0 : ours(pluginArray(parse(src)).arr).length));
  } else if (mode === "backend") {
    const found = src === null ? [] : ours(pluginArray(parse(src)).arr);
    const opts = found.length > 0 ? entryOptions(src, found[0].node) : null;
    process.stdout.write(typeof opts?.backendUrl === "string" ? opts.backendUrl : "");
  } else if (mode === "expect") {
    const found = src === null ? [] : ours(pluginArray(parse(src)).arr);
    const want = JSON.parse(optionsJson || "{}");
    const opts = found.length === 1 ? entryOptions(src, found[0].node) ?? {} : {};
    const match = found.length === 1 && entrySpec(found[0].node) === spec
      && Object.entries(want).every(([k, v]) => JSON.stringify(opts[k]) === JSON.stringify(v));
    if (!match) {
      const seen = found.map(({ node }) => src.slice(node.s, node.e)).join(", ") || "none";
      throw new Error(`expected exactly one ${spec} entry with ${JSON.stringify(want)}, found: ${seen}`);
    }
    process.stdout.write("ok");
  } else if (mode === "add") {
    if (src === null) {
      const options = optionsJson ? JSON.parse(optionsJson) : null;
      save(file, `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": [${render(spec, options)}]\n}\n`);
      process.stdout.write("created");
    } else {
      const result = add(src);
      if (result.status !== "present") save(file, result.src);
      process.stdout.write(result.status);
    }
  } else if (mode === "remove") {
    if (src === null) { process.stdout.write("absent"); }
    else {
      const result = remove(src);
      if (result.status === "removed") save(file, result.src);
      process.stdout.write(result.status);
    }
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (error) {
  console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
JS
}
# <<< config-editor

JS_RUNTIME=""
find_js_runtime() {
  if command -v node >/dev/null 2>&1; then JS_RUNTIME="node"
  elif command -v bun >/dev/null 2>&1; then JS_RUNTIME="bun"
  elif [[ -x "${HOME}/.bun/bin/bun" ]]; then JS_RUNTIME="${HOME}/.bun/bin/bun"
  else return 1
  fi
}

editor() {
  "${JS_RUNTIME}" "${WORK}/config-editor.mjs" "$@"
}

existing_configs() {
  local name
  for name in "${CONFIG_NAMES[@]}"; do
    [[ -f "${CONFIG_DIR}/${name}" ]] && printf '%s\n' "${CONFIG_DIR}/${name}"
  done
  return 0
}

target_config() {
  local first
  first="$(existing_configs | head -1)"
  printf '%s' "${first:-${CONFIG_DIR}/opencode.json}"
}

uninstall() {
  section "Uninstalling ArmorOpenCode"
  find_js_runtime || die "node or bun is required to edit the OpenCode config"
  write_config_editor
  local file status failed=0
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    if status="$(editor remove "${file}" "${PACKAGE}")"; then
      [[ "${status}" == "removed" ]] && ok "removed ${PACKAGE} from ${file}"
    else
      err "could not edit ${file}; it was left unchanged"
      failed=1
    fi
  done < <(existing_configs)
  if [[ "${PURGE}" -eq 1 && -d "${DATA_DIR}" ]]; then
    rm -rf "${DATA_DIR}"
    ok "deleted ${DATA_DIR}"
  elif [[ -d "${DATA_DIR}/plugin" ]]; then
    rm -rf "${DATA_DIR}/plugin"
    ok "deleted the plugin code in ${DATA_DIR}/plugin"
  fi
  [[ "${failed}" -eq 0 ]] || { err "uninstall incomplete"; exit 1; }
  ok "ArmorOpenCode uninstalled. Your ArmorIQ login was kept."
  info "to sign out: npx -y ${SDK_SPEC} logout --profile ${PRODUCT}@<backend host>"
}

# ---------------------------------------------------------------------------

OPENCODE_BIN=""
find_opencode() {
  if command -v opencode >/dev/null 2>&1; then OPENCODE_BIN="$(command -v opencode)"
  elif [[ -x "${HOME}/.opencode/bin/opencode" ]]; then OPENCODE_BIN="${HOME}/.opencode/bin/opencode"
  else return 1
  fi
}

check_opencode_version() {
  local raw major minor
  raw="$("${OPENCODE_BIN}" --version 2>/dev/null | head -1 || true)"
  raw="$(printf '%s' "${raw}" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [[ -n "${raw}" ]] || die "could not read the OpenCode version from ${OPENCODE_BIN} --version"
  major="${raw%%.*}"
  minor="${raw#*.}"; minor="${minor%%.*}"
  if [[ "${major}" -lt 1 || ( "${major}" -eq 1 && "${minor}" -lt "${MIN_OPENCODE_MINOR}" ) ]]; then
    die "OpenCode >= 1.${MIN_OPENCODE_MINOR} is required (found ${raw}). Update with: opencode upgrade"
  fi
  OPENCODE_VERSION="${raw}"
}

# Profile names use the URL host exactly as the SDK computes it: lowercased,
# default port dropped.
normalize_backend() {
  local origin
  origin="$("${JS_RUNTIME}" -e '
    const u = new URL(process.argv[1]);
    const bare = /^https?:$/.test(u.protocol) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
    if (!bare) process.exit(1);
    console.log(`${u.origin}\n${u.host}`);
  ' "${BACKEND}" 2>/dev/null)" || die "ARMORIQ_BACKEND_URL must be an http(s) origin such as ${DEFAULT_BACKEND}, got ${BACKEND}"
  BACKEND="${origin%%$'\n'*}"
  BACKEND_HOST="${origin#*$'\n'}"
}

backend_host() {
  printf '%s' "${BACKEND_HOST}"
}

choose_backend() {
  local file found=""
  if [[ -z "${BACKEND}" ]]; then
    while IFS= read -r file; do
      [[ -n "${file}" && -z "${found}" ]] || continue
      found="$(editor backend "${file}" "${PACKAGE}")" || found=""
    done < <(existing_configs)
    BACKEND="${found:-${DEFAULT_BACKEND}}"
    [[ -n "${found}" ]] && info "keeping the installed backend ${found} (set ARMORIQ_BACKEND_URL to change it)"
  fi
  normalize_backend
}

latest_release_tag() {
  local tags
  tags="$(git ls-remote --tags --refs "${REPO_URL}" 'v*')" || die "could not list the releases of ${REPO_URL}"
  printf '%s\n' "${tags}" \
    | sed -n 's|.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n \
    | tail -1
}

fetch_source() {
  command -v git >/dev/null 2>&1 || die "git is required to download ArmorOpenCode"
  if [[ -z "${GIT_REF}" ]]; then
    GIT_REF="$(latest_release_tag)"
    GIT_REF="${GIT_REF:-main}"
  fi
  mkdir -p "${DATA_DIR}"
  if [[ -d "${PLUGIN_DIR}/.git" ]]; then
    info "updating ${PLUGIN_DIR} to ${GIT_REF}"
    git -C "${PLUGIN_DIR}" remote set-url origin "${REPO_URL}"
    git -C "${PLUGIN_DIR}" fetch --quiet --depth 1 origin "${GIT_REF}" \
      || die "could not fetch ${GIT_REF} from ${REPO_URL}"
    git -C "${PLUGIN_DIR}" checkout --quiet --force FETCH_HEAD || die "could not check out ${GIT_REF}"
  else
    info "downloading ${REPO_URL} (${GIT_REF})"
    rm -rf "${PLUGIN_DIR}"
    git clone --quiet --depth 1 --branch "${GIT_REF}" "${REPO_URL}" "${PLUGIN_DIR}" \
      || die "could not download ${GIT_REF} from ${REPO_URL}"
  fi
  # Always reinstall: an existing node_modules may hold an SDK too old for this checkout.
  info "installing runtime dependencies"
  if [[ "${JS_RUNTIME}" == *bun ]]; then
    (cd "${PLUGIN_DIR}" && "${JS_RUNTIME}" install --production --silent) >/dev/null \
      || die "bun install failed in ${PLUGIN_DIR}"
  else
    command -v npm >/dev/null 2>&1 || die "npm is required next to node to install dependencies"
    (cd "${PLUGIN_DIR}" && npm install --omit=dev --no-audit --no-fund --silent) >/dev/null \
      || die "npm install failed in ${PLUGIN_DIR}"
  fi
  local dep
  for dep in @armoriq/sdk-dev @opencode-ai/plugin; do
    [[ -f "${PLUGIN_DIR}/node_modules/${dep}/package.json" ]] || die "${dep} is missing from ${PLUGIN_DIR}/node_modules"
  done
  PLUGIN_SPEC="file://${PLUGIN_DIR}"
  ok "ArmorOpenCode $(git -C "${PLUGIN_DIR}" rev-parse --short HEAD) from ${GIT_REF}"
}

has_login_profile() {
  [[ -f "${CREDENTIALS}" ]] || return 1
  "${JS_RUNTIME}" -e '
    const fs = require("node:fs");
    const [file, name, backend] = process.argv.slice(1);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = doc && doc.profiles && doc.profiles[name];
    const ok = p && typeof p.apiKey === "string" && p.apiKey.length > 0
      && new URL(p.backend).origin === new URL(backend).origin;
    process.exit(ok ? 0 : 1);
  ' "${CREDENTIALS}" "${PRODUCT}@$(backend_host)" "${BACKEND}" >/dev/null 2>&1
}

login_command() {
  if [[ -n "${ARMOROPENCODE_LOGIN_CLI:-}" ]]; then
    # shellcheck disable=SC2206
    LOGIN_CMD=(${ARMOROPENCODE_LOGIN_CLI})
  elif command -v npx >/dev/null 2>&1; then
    LOGIN_CMD=(npx -y "${SDK_SPEC}")
  elif [[ "${JS_RUNTIME}" == *bun ]]; then
    LOGIN_CMD=("${JS_RUNTIME}" x "${SDK_SPEC}")
  else
    return 1
  fi
}

login() {
  if [[ "${FORCE_LOGIN}" -eq 0 ]] && has_login_profile; then
    ok "ArmorIQ login for ${PRODUCT}@$(backend_host) found, skipping sign-in"
    return 0
  fi
  login_command || die "npx (Node.js) or bunx (Bun) is required to run the ArmorIQ login"
  info "signing in with ${LOGIN_CMD[*]} login --product ${PRODUCT}"
  local args=(login --product "${PRODUCT}")
  [[ "${FORCE_LOGIN}" -eq 1 ]] && args+=(--force)
  if ! ARMORIQ_BACKEND_URL="${BACKEND}" "${LOGIN_CMD[@]}" "${args[@]}" </dev/null; then
    die "ArmorIQ login failed"
  fi
  has_login_profile || die "login finished but no ${PRODUCT} profile for ${BACKEND} is in ${CREDENTIALS}"
  ok "signed in to ArmorIQ (${BACKEND})"
}

configure() {
  local target file status
  target="$(target_config)"
  mkdir -p "${CONFIG_DIR}"
  status="$(editor add "${target}" "${PACKAGE}" "${PLUGIN_SPEC}" "${PLUGIN_OPTIONS}")" \
    || die "could not update ${target}; it was left unchanged"
  case "${status}" in
    present) ok "${target} already loads ${PLUGIN_SPEC}" ;;
    *) ok "${status} ${PLUGIN_SPEC} in ${target}" ;;
  esac
  while IFS= read -r file; do
    [[ -n "${file}" && "${file}" != "${target}" ]] || continue
    status="$(editor remove "${file}" "${PACKAGE}")" || die "could not remove a stale entry from ${file}"
    [[ "${status}" == "removed" ]] && info "removed a stale ${PACKAGE} entry from ${file}"
  done < <(existing_configs)
  CONFIG_FILE="${target}"
}

verify() {
  section "Verifying"
  local file
  editor expect "${CONFIG_FILE}" "${PACKAGE}" "${PLUGIN_SPEC}" "${PLUGIN_OPTIONS}" >/dev/null \
    || die "the OpenCode config does not load ArmorOpenCode"
  while IFS= read -r file; do
    [[ -n "${file}" && "${file}" != "${CONFIG_FILE}" ]] || continue
    [[ "$(editor count "${file}" "${PACKAGE}")" == "0" ]] || die "${file} still has a ${PACKAGE} entry"
  done < <(existing_configs)
  ok "OpenCode config loads ${PLUGIN_SPEC}"
  has_login_profile || die "no ${PRODUCT} login profile for ${BACKEND} in ${CREDENTIALS}"
  ok "ArmorIQ login profile ${PRODUCT}@$(backend_host) present"
}

main() {
  if [[ "${DO_UNINSTALL}" -eq 1 ]]; then
    uninstall
    exit 0
  fi

  printf "%sArmorOpenCode installer%s\n" "${B}" "${N}"

  section "Checking prerequisites"
  find_opencode || die "opencode was not found on PATH or in ~/.opencode/bin. Install it from https://opencode.ai/docs/#install"
  check_opencode_version
  find_js_runtime || die "node or bun is required. Install Node.js >= 20 from https://nodejs.org or Bun from https://bun.sh"
  write_config_editor
  local file
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    editor validate "${file}" >/dev/null || die "fix the OpenCode config above and re-run"
  done < <(existing_configs)
  choose_backend
  fetch_source
  PLUGIN_OPTIONS="{\"backendUrl\":\"${BACKEND}\"}"
  ok "OpenCode ${OPENCODE_VERSION} at ${OPENCODE_BIN}, ${JS_RUNTIME}, backend ${BACKEND}"

  section "Connecting to ArmorIQ"
  login

  section "Configuring OpenCode"
  configure

  verify
  printf "\n%sArmorOpenCode is installed.%s Restart OpenCode to load %s.\n" "${G}${B}" "${N}" "${PLUGIN_SPEC}"
  info "uninstall: bash uninstall_armoropencode.sh (or this script with --uninstall)"
}

main "$@"
