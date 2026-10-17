#!/usr/bin/env bash
# Stands in for `armoriq login` so install_armoropencode.sh can run offline in a sandbox HOME.
# Writes a placeholder profile for ARMORIQ_BACKEND_URL; the key is not a real credential.
set -euo pipefail
host="$(node -e 'console.log(new URL(process.argv[1]).host)' "${ARMORIQ_BACKEND_URL}")"
mkdir -p "${HOME}/.armoriq"
node -e '
  const [file, name, backend] = process.argv.slice(1);
  require("node:fs").writeFileSync(file, JSON.stringify({ profiles: { [name]: { apiKey: "spike-stub-not-a-key", backend } } }, null, 2));
' "${HOME}/.armoriq/credentials.json" "armoropencode@${host}" "${ARMORIQ_BACKEND_URL}"
