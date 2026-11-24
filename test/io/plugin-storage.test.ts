import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditLogin } from "../../src/pumps/audit.ts";
import { login, scratch } from "./helpers/stub.ts";

// regression: #0010
for (const fault of ["torn", "blocked-directory", "result"] as const) test(`real V1 and V2 entry points keep guarding with ${fault} storage`, async () => {
  const dir = scratch("armor-plugin-storage-");
  const home = join(dir, "armoriq");
  const data = join(home, "armoropencode");
  mkdirSync(data, { recursive: true });
  const auth = login("http://127.0.0.1:9", "ak_test_storage");
  if (fault === "torn") {
    const root = join(data, "outbox", "audit-v2");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "queue-99999999-aabb.jsonl"), JSON.stringify({ t: "b", login: auditLogin(auth) }) + '\nnot JSON\n{"t":"a"');
  } else if (fault === "blocked-directory") writeFileSync(join(data, "outbox"), "storage is blocked");
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/plugin-storage-child.ts"), fault], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, ARMORIQ_HOME: home, ARMORIQ_ORG_MODE: "enforce", ARMORIQ_BACKEND_URL: auth.backend, ARMORIQ_API_KEY: auth.apiKey }, stdout: "pipe", stderr: "inherit",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const result = JSON.parse(output);
    if (fault === "result") expect(result.outputKept).toBe(true);
    else expect(result).toMatchObject({ v1: true, v2: true });
    if (fault === "torn") expect(result.corruptRecords).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
