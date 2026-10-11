#!/usr/bin/env bash
set -euo pipefail

# ArmorOpenCode installer for OpenCode.
#
# Usage:
#   curl -fsSL <url>/install_armoropencode.sh | bash
#   bash install_armoropencode.sh [--uninstall [--purge]]
#
# Adds "@armoriq/armoropencode@<version>" to the plugin array of the global
# OpenCode config (~/.config/opencode/opencode.json or .jsonc). OpenCode
# installs npm plugins itself. Comments and every other key are preserved, and
# re-running is a no-op. Then signs in with the ArmorIQ CLI unless a login for
# the armoropencode product on the chosen backend already exists.
#
# Flags:
#   --uninstall   remove the ArmorOpenCode plugin entry (keeps the login)
#   --purge       with --uninstall, also delete ~/.armoriq/armoropencode
#   --force-login sign in again even when a login exists
#
# Environment:
#   ARMORIQ_BACKEND_URL      backend (default https://api.armoriq.ai,
#                            staging https://staging-api.armoriq.ai)
#   ARMOROPENCODE_VERSION    exact version, dist-tag, or file: spec (default latest)

PACKAGE="@armoriq/armoropencode"
PRODUCT="armoropencode"
SDK_SPEC="@armoriq/sdk-dev@^0.8.13"
MIN_OPENCODE_MINOR=18
DEFAULT_BACKEND="https://api.armoriq.ai"
NPM_REGISTRY="${ARMOROPENCODE_NPM_REGISTRY:-https://registry.npmjs.org}"

BACKEND="${ARMORIQ_BACKEND_URL:-${DEFAULT_BACKEND}}"
BACKEND="${BACKEND%/}"
VERSION_REQ="${ARMOROPENCODE_VERSION:-latest}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
CONFIG_NAMES=(opencode.jsonc opencode.json config.json)
CREDENTIALS="${HOME}/.armoriq/credentials.json"
DATA_DIR="${HOME}/.armoriq/armoropencode"

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
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  if (members.length > 1) return splice(src, node.s, members[1].s);
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

function add(src) {
  const options = optionsJson ? JSON.parse(optionsJson) : null;
  const text = render(spec, options);
  let root = parse(src);
  let { arr, prop } = pluginArray(root);
  let found = ours(arr);
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
  } else if (mode === "list") {
    const out = src === null ? [] : ours(pluginArray(parse(src)).arr).map(({ node }) => JSON.stringify({
      spec: entrySpec(node),
      options: node.type === "array" && node.items[1] ? JSON.parse(src.slice(node.items[1].s, node.items[1].e)) : null,
    }));
    process.stdout.write(out.join("\n"));
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
  fi
  [[ "${failed}" -eq 0 ]] || { err "uninstall incomplete"; exit 1; }
  ok "ArmorOpenCode uninstalled. Your ArmorIQ login was kept."
  info "to sign out: npx -y ${SDK_SPEC} logout --profile ${PRODUCT}@$(backend_host)"
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

backend_host() {
  local rest="${BACKEND#*://}"
  printf '%s' "${rest%%/*}"
}

resolve_spec() {
  if [[ "${VERSION_REQ}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ || "${VERSION_REQ}" == file:* ]]; then
    PLUGIN_SPEC="${PACKAGE}@${VERSION_REQ}"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required to resolve ${PACKAGE}@${VERSION_REQ}"
  local body version
  body="$(curl -fsSL "${NPM_REGISTRY}/${PACKAGE/\//%2f}/${VERSION_REQ}" 2>/dev/null)" \
    || die "could not resolve ${PACKAGE}@${VERSION_REQ} from ${NPM_REGISTRY} (is it published?)"
  version="$(printf '%s' "${body}" | grep -Eo '"version" *: *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  [[ -n "${version}" ]] || die "registry answer for ${PACKAGE}@${VERSION_REQ} has no version"
  PLUGIN_SPEC="${PACKAGE}@${version}"
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
  elif command -v bunx >/dev/null 2>&1; then
    LOGIN_CMD=(bunx "${SDK_SPEC}")
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
  local entries expected file
  expected="{\"spec\":\"${PLUGIN_SPEC}\",\"options\":${PLUGIN_OPTIONS}}"
  entries="$(editor list "${CONFIG_FILE}" "${PACKAGE}")" || die "could not read back ${CONFIG_FILE}"
  [[ "${entries}" == "${expected}" ]] || die "${CONFIG_FILE} does not contain exactly one ${PLUGIN_SPEC} entry (found: ${entries:-none})"
  while IFS= read -r file; do
    [[ -n "${file}" && "${file}" != "${CONFIG_FILE}" ]] || continue
    [[ -z "$(editor list "${file}" "${PACKAGE}")" ]] || die "${file} still has a ${PACKAGE} entry"
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
  [[ "${BACKEND}" =~ ^https?://[^/]+$ ]] || die "ARMORIQ_BACKEND_URL must be an http(s) origin, got ${BACKEND}"
  write_config_editor
  editor validate "$(target_config)" >/dev/null || die "fix the OpenCode config above and re-run"
  resolve_spec
  PLUGIN_OPTIONS="{\"backendUrl\":\"${BACKEND}\"}"
  ok "OpenCode ${OPENCODE_VERSION} at ${OPENCODE_BIN}, ${JS_RUNTIME}, backend ${BACKEND}"

  section "Connecting to ArmorIQ"
  login

  section "Configuring OpenCode"
  configure

  verify
  printf "\n%sArmorOpenCode is installed.%s OpenCode downloads %s on its next start.\n" "${G}${B}" "${N}" "${PLUGIN_SPEC}"
  info "uninstall: bash uninstall_armoropencode.sh (or this script with --uninstall)"
}

main "$@"
