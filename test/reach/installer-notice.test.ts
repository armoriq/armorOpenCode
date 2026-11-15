import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { contract, home, origin } from "./helpers.ts";

const installer = path.resolve(import.meta.dir, "../../install_armoropencode.sh");
async function notice(dir: string, env: Record<string, string> = {}, backend = origin) {
  const source = readFileSync(installer, "utf8").match(/^reach_notice\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(typeof source).toBe("string");
  const proc = Bun.spawn(["bash", "-c", `${source}\nBACKEND="$1"\nreach_notice`, "installer-notice", backend], {
    env: { PATH: process.env.PATH!, HOME: dir, JS_RUNTIME: Bun.which("node")!, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
  return out;
}

for (const backend of [
  "https://api.armoriq.ai", "https://api.armoriq.ai/",
  "https://staging-api.armoriq.ai", "https://staging-api.armoriq.ai/",
  "https://staging-api.armoriq.io", "https://staging-api.armoriq.io/",
]) {
  test(`installer emits the exact contract notice once with a private marker for ${backend}`, async () => {
    const dir = home();
    expect(await notice(dir, { ARMORIQ_BACKEND_URL: "https://custom.example" }, backend)).toBe(`${contract.notice}\n`);
    const marker = path.join(dir, ".armoriq/reach/v1/armoropencode/notice-shown");
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(await notice(dir, {}, backend)).toBe("");
    expect(existsSync(path.join(dir, ".armoriq/install-id"))).toBe(false);
  });
}
for (const backend of [
  "https://custom.example", "http://localhost:3000", "http://api.armoriq.ai",
  "https://api.armoriq.ai:8443", "https://api.armoriq.ai.evil.test", "not a URL",
]) {
  test(`installer notice does nothing for backend ${backend}`, async () => {
    const dir = home();
    expect(await notice(dir, { ARMORIQ_BACKEND_URL: origin }, backend)).toBe("");
    expect(existsSync(path.join(dir, ".armoriq/reach/v1/armoropencode/notice-shown"))).toBe(false);
    expect(existsSync(path.join(dir, ".armoriq/reach"))).toBe(false);
  });
}
for (const env of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: " True " }, { ARMORIQ_USAGE_PING_DISABLED: "YES" }] as Record<string, string>[]) {
  test(`installer notice is hidden with ${JSON.stringify(env)}`, async () => {
    const dir = home(); expect(await notice(dir, env)).toBe("");
    expect(existsSync(path.join(dir, ".armoriq/reach"))).toBe(false);
  });
}
test("installer shared settings fail closed, and help lists all message switches", async () => {
  const dir = home(); mkdirSync(path.join(dir, ".armoriq"));
  writeFileSync(path.join(dir, ".armoriq/settings.json"), '{"usagePing":false}');
  expect(await notice(dir)).toBe("");
  writeFileSync(path.join(dir, ".armoriq/settings.json"), "{");
  expect(await notice(dir)).toBe("");
  const proc = Bun.spawn(["bash", installer, "--help"], { stdout: "pipe", stderr: "pipe" });
  const help = await new Response(proc.stdout).text(); expect(await proc.exited).toBe(0);
  for (const name of ["DO_NOT_TRACK", "ARMORIQ_USAGE_PING_DISABLED", "ARMORIQ_SIGNIN_REMINDER_DISABLED"]) expect(help).toContain(name);
});
