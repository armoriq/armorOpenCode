import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";

// The sandbox suppresses file watch events. Deliver those notifications explicitly while the
// SDK writes real profiles and the credential reader reads those files normally.
const notifications: (() => void)[] = [];
mock.module("node:fs", () => ({ ...fs, watch: (_path: unknown, _options: unknown, listener: () => void) => {
  notifications.push(listener);
  return { on() { return this; }, close() {} };
} }));
const { saveLoginProfile } = await import("@armoriq/sdk-dev/dist/credentials.js");
const { createCredentials } = await import("../../../src/io/credentials.ts");
const profile = { backend: "https://renewal.invalid", product: "armoropencode", apiKey: "test-credential", userId: "user", orgId: "org", email: "test@example.com" };
saveLoginProfile(profile);
const changes: boolean[] = [];
const credentials = createCredentials({ info() {}, warn() {}, error() {} }, { backend: profile.backend, dataDir: join(process.env.HOME!, "data"), onChange: renewed => changes.push(renewed) });
const notify = async () => { for (const notification of notifications) notification(); await Bun.sleep(150); };
assert.ok(credentials.current());
saveLoginProfile({ ...profile, product: "armorclaude" });
await notify();
assert.deepEqual(changes, [false]);
credentials.markSignedOut("test refusal");
assert.equal(credentials.current(), null);
saveLoginProfile(profile);
await notify();
assert.equal(changes.at(-1), true);
assert.equal(credentials.current()?.apiKey, profile.apiKey);
credentials.stop();
console.log("scoped credential renewal verified");
