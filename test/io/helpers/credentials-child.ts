// Child process for credentials tests; the SDK resolves ~/.armoriq from HOME at process start.
// argv = mode, optional profile JSON saved through the SDK's own writer before reading.
import { saveLoginProfile } from "@armoriq/sdk-dev/dist/credentials.js";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCredentials } from "../../../src/io/credentials.ts";

const mode = process.argv[2];
const quiet = { info() {}, warn() {}, error() {} };
if (process.argv[3]) saveLoginProfile(JSON.parse(process.argv[3]));
const creds = createCredentials(quiet, {
  dataDir: process.env.TEST_DATA_DIR,
  backend: process.env.TEST_CONFIGURED_BACKEND,
  pollMs: Number(process.env.TEST_POLL_MS) || undefined,
});
const out: unknown[] = [creds.current()];

const login = () =>
  saveLoginProfile({
    backend: process.env.ARMORIQ_BACKEND_URL!,
    product: "armoropencode",
    apiKey: "ak_live_after_login",
    email: "new@example.com",
    userId: "user-new",
    orgId: "org-new",
  });
const loggedIn = async () => {
  const end = Date.now() + 3000;
  while (Date.now() < end && (creds.current() as { apiKey?: string } | null)?.apiKey !== "ak_live_after_login") await Bun.sleep(20);
  out.push(creds.current());
};

if (mode === "watch") {
  login();
  await loggedIn();
}
if (mode === "rewatch") {
  const dir = join(homedir(), ".armoriq");
  rmSync(dir, { recursive: true, force: true });
  await Bun.sleep(200);
  mkdirSync(dir);
  await Bun.sleep(200);
  login();
  await loggedIn();
}
if (mode === "relogin") {
  creds.markRelogin("relogin_required");
  out.push(readdirSync(process.env.TEST_DATA_DIR!));
}
creds.stop();
console.log(JSON.stringify(out));
