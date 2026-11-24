import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers/stub.ts";

test("R9: only this profile's explicit login renewal resumes its refused credential", async () => {
  const home = scratch("armor-credential-renewal-");
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/credentials-renewal-child.ts")], { env: { HOME: home, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(out.trim()).toBe("scoped credential renewal verified");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
