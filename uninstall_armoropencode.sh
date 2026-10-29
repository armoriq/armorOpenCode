#!/usr/bin/env bash
set -euo pipefail

# ArmorOpenCode uninstaller.
#
# Usage:
#   curl -fsSL <url>/uninstall_armoropencode.sh | bash
#   bash uninstall_armoropencode.sh [--purge]
#
# Removes only the "@armoriq/armoropencode" entries from the "plugin" (OpenCode 1
# and 2) and "plugins" (OpenCode 2) arrays of the global OpenCode config. Comments, other plugins and every other key are left
# as they were. The ArmorIQ login profile is kept.
#
# Flags:
#   --purge   also delete ~/.armoriq/armoropencode (local plugin data)

PACKAGE="@armoriq/armoropencode"
PRODUCT="armoropencode"
SDK_SPEC="@armoriq/sdk@^0.8.23"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
CONFIG_NAMES=(opencode.jsonc opencode.json config.json)
DATA_DIR="${HOME}/.armoriq/armoropencode"

if [[ -t 1 ]]; then
  R=$'\033[1;31m' G=$'\033[32m' D=$'\033[0;90m' B=$'\033[1m' N=$'\033[0m'
else
  R="" G="" D="" B="" N=""
fi
ok()      { printf "%s[ok]%s %s\n" "${G}" "${N}" "$*"; }
err()     { printf "%s[error]%s %s\n" "${R}" "${N}" "$*" >&2; }
info()    { printf "%s-%s %s\n" "${D}" "${N}" "$*"; }
section() { printf "\n%s%s%s\n" "${B}" "$*" "${N}"; }
die()     { err "$*"; exit 1; }

PURGE=0
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=1 ;;
    -h|--help) sed -n '4,15p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
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

// OpenCode 2 also reads "plugins", whose entries may be {"package": spec, "options": {...}}.
// The installer only writes the "plugin" tuple: OpenCode 1 skips our server hook when only "plugins" names us.
const KEYS = ["plugin", "plugins"];

function objectProp(node, key) {
  return node.type === "object" ? node.props.find((p) => p.key === key)?.value : undefined;
}

function entrySpec(node) {
  if (node.type === "string") return node.v;
  if (node.type === "array" && node.items[0]?.type === "string") return node.items[0].v;
  const pkgNode = objectProp(node, "package");
  return pkgNode?.type === "string" ? pkgNode.v : null;
}

function pluginArray(root, key = "plugin") {
  const props = root.props.filter((p) => p.key === key);
  if (props.length > 1) throw new Error(`"${key}" is declared more than once`);
  if (props.length === 0) return { prop: null, arr: null };
  if (props[0].value.type !== "array") throw new Error(`"${key}" must be an array`);
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
  const opts = node.type === "array" ? node.items[1] : objectProp(node, "options");
  return opts?.type === "object" ? toValue(src, opts) : null;
}

function oursIn(src, key) {
  return ours(pluginArray(parse(src), key).arr);
}

function removeFrom(src, key) {
  let removed = 0;
  for (;;) {
    const { arr } = pluginArray(parse(src), key);
    const found = ours(arr);
    if (found.length === 0) break;
    src = removeMember(src, arr.items, found[found.length - 1].i, arr.s, arr.e);
    removed++;
  }
  if (removed > 0) {
    const root = parse(src);
    const { prop, arr } = pluginArray(root, key);
    if (arr && arr.items.length === 0 && isBlank(src.slice(arr.s + 1, arr.e - 1))) {
      src = removeMember(src, root.props, root.props.indexOf(prop), root.s, root.e);
    }
  }
  return { src, removed };
}

function add(src) {
  const original = src;
  const fromV2 = oursIn(src, "plugins");
  const stale = removeFrom(src, "plugins");
  src = stale.src;
  let root = parse(src);
  let { arr } = pluginArray(root);
  let found = ours(arr);
  const existing = found.length > 0 ? entryOptions(src, found[0].node)
    : fromV2.length > 0 ? entryOptions(original, fromV2[0].node) : null;
  const text = render(spec, { ...existing, ...(optionsJson ? JSON.parse(optionsJson) : null) });
  if (found.length === 1 && sameEntry(src, found[0].node, text)) return { src, status: stale.removed > 0 ? "updated" : "present" };
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
  for (const key of KEYS) {
    const result = removeFrom(src, key);
    src = result.src;
    removed += result.removed;
  }
  return { src, status: removed > 0 ? "removed" : "absent" };
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
    if (src !== null) for (const key of KEYS) pluginArray(parse(src), key);
    process.stdout.write("valid");
  } else if (mode === "others") {
    const arr = src === null ? null : pluginArray(parse(src)).arr;
    process.stdout.write(String(arr ? arr.items.length - ours(arr).length : 0));
  } else if (mode === "count") {
    process.stdout.write(String(src === null ? 0 : KEYS.reduce((n, key) => n + oursIn(src, key).length, 0)));
  } else if (mode === "backend") {
    const found = src === null ? [] : KEYS.flatMap((key) => oursIn(src, key));
    const opts = found.length > 0 ? entryOptions(src, found[0].node) : null;
    process.stdout.write(typeof opts?.backendUrl === "string" ? opts.backendUrl : "");
  } else if (mode === "expect") {
    const found = src === null ? [] : ours(pluginArray(parse(src)).arr);
    const want = JSON.parse(optionsJson || "{}");
    const opts = found.length === 1 ? entryOptions(src, found[0].node) ?? {} : {};
    const match = found.length === 1 && entrySpec(found[0].node) === spec && oursIn(src, "plugins").length === 0
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

uninstall
