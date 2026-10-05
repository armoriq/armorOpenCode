#!/usr/bin/env bun
import { clearPendingPolicy, loadPendingPolicy, saveActivePolicy } from "../src/local-policy.ts";

const dataDir = process.env.ARMOROPENCODE_DATA_DIR ?? `${process.env.HOME ?? "."}/.armoriq/armoropencode`;
if (process.argv.includes("--help")) {
  console.log("Usage: bun scripts/policy-confirm.ts --yes\n\nActivates a staged policy after explicit terminal confirmation.");
  process.exit(0);
}
if (!process.stdin.isTTY || !process.argv.includes("--yes")) {
  console.error("Refusing to activate policy. Run this command from a terminal with --yes after reviewing policy_read output.");
  process.exit(2);
}
const pending = loadPendingPolicy(dataDir);
if (!pending.ok) {
  console.error(pending.error === "none" ? "No staged policy exists." : pending.error);
  process.exit(1);
}
saveActivePolicy(dataDir, pending.policy);
clearPendingPolicy(dataDir);
console.log("ArmorOpenCode policy activated.");
