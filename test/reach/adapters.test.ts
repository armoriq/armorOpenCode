import { expect, test } from "bun:test";
import { home } from "./helpers.ts";

async function run(major: string, enabled: boolean, response: string) {
  const dir = home();
  const proc = Bun.spawn([process.execPath, `${import.meta.dir}/adapter-child.ts`, major, enabled ? "on" : "off", response, dir], {
    env: { ...process.env, HOME: dir, ARMORIQ_HOME: `${dir}/.armoriq`, ARMORIQ_API_KEY: "", ARMORIQ_BACKEND_URL: "", DO_NOT_TRACK: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, err).toBe(0);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}
for (const major of ["1", "2"]) {
  test(`host ${major} load and hooks preserve their results with ping disabled, down, slow or refused`, async () => {
    const off = await run(major, false, "204");
    expect(off.requests).toBe(0);
    let slowestP95 = 0;
    for (const response of ["204", "offline", "slow", "400", "500"]) {
      const on = await run(major, true, response);
      expect(on.replies).toEqual(off.replies);
      expect(on.errors).toEqual(off.errors);
      expect(on.promptOutput).toEqual(off.promptOutput);
      expect(on.immediate).toBe(0);
      expect(on.requests).toBe(1);
      expect(on.leaks).toEqual([]);
      expect(on.version).toBe(major === "1" ? null : "2.0.29");
      expect(on.loadMs).toBeLessThan(1500);
      expect(on.p95).toBeLessThan(20);
      slowestP95 = Math.max(slowestP95, on.p95);
    }
    console.log(`Host ${major}: worst hook p95 ${slowestP95.toFixed(3)} ms across prompt, plan and held tool hooks.`);
  }, 15000);
}

test("an unreferenced reach timer cannot keep an otherwise idle process alive", async () => {
  const dir = home();
  const proc = Bun.spawn([process.execPath, "-e", 'import {withReach} from "./src/reach/index.ts"; const host={event(){},ownTools:{}}; withReach(host as any,{backend:"https://api.armoriq.ai"},{home:process.argv[1],env:{},readLogin:()=>null,fetch:()=>new Promise(()=>{})}).event({kind:"session_created"} as any);'], { env: { ...process.env, HOME: dir }, stdout: "pipe", stderr: "pipe" });
  const start = performance.now();
  expect(await proc.exited).toBe(0);
  expect(performance.now() - start).toBeLessThan(1500);
});
