// Child process for credentials tests; the SDK resolves ~/.armoriq from HOME at process start.
// argv = mode, optional profile JSON saved through the SDK's own writer before reading.
import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { readdirSync } from "node:fs";
import { createCredentials } from "../../../src/io/credentials.ts";

const mode = process.argv[2];
const quiet = { info() {}, warn() {}, error() {} };
if (process.argv[3]) saveLoginProfile(JSON.parse(process.argv[3]));
const creds = createCredentials(quiet, { dataDir: process.env.TEST_DATA_DIR });
const out: unknown[] = [creds.current()];

if (mode === "watch") {
  saveLoginProfile({
    backend: process.env.ARMORIQ_BACKEND_URL!,
    product: "armoropencode",
    apiKey: "ak_live_after_login",
    email: "new@example.com",
    userId: "user-new",
    orgId: "org-new",
  });
  const end = Date.now() + 3000;
  while (Date.now() < end && (creds.current() as { apiKey?: string } | null)?.apiKey !== "ak_live_after_login") await Bun.sleep(20);
  out.push(creds.current());
}
if (mode === "relogin") {
  creds.markRelogin("relogin_required");
  out.push(readdirSync(process.env.TEST_DATA_DIR!));
}
creds.stop();
console.log(JSON.stringify(out));
