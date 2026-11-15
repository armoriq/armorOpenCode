import { afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import contract from "../fixtures/install-ping-v1.json";
import { createCredentials } from "../../src/io/credentials.ts";
import type { Login } from "../../src/types.ts";

export { contract };
export { manualTimers } from "./manual-timers.ts";
export const origin = "https://api.armoriq.ai";
export const today = Date.parse("2026-11-14T23:59:59.999Z");
export const homes: string[] = [];
export function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "aoc-reach-"));
  homes.push(dir);
  return dir;
}
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export const countsDir = (dir: string, environment = "production") => path.join(dir, ".armoriq/reach/v1/armoropencode", environment);
export const countsFile = (dir: string, day = "2026-11-13") => path.join(countsDir(dir), `counts-${day}.ndjson`);
export function settings(dir: string, value: unknown) {
  mkdirSync(path.join(dir, ".armoriq"), { recursive: true });
  writeFileSync(path.join(dir, ".armoriq/settings.json"), value === "malformed" ? "{" : JSON.stringify(value));
}
export async function until(check: () => boolean, ms = 2000) {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}

export const savedLogin: Login = { backend: origin, apiKey: "fixture-key", userId: "", orgId: "", email: "", deviceId: "", deviceName: "" };
export function relogin(dir: string, login = savedLogin, armoriqDir = path.join(dir, ".armoriq")) {
  const credentials = createCredentials({ info() {}, warn() {}, error() {} }, {
    env: { ARMORIQ_API_KEY: login.apiKey }, backend: login.backend, dataDir: path.join(armoriqDir, "armoropencode"),
  });
  try { credentials.markRelogin("rejected"); } finally { credentials.stop(); }
}

// The subset of JSON Schema used by the shared contract, plus its three extra rules.
function matches(value: any, schema: any): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.some((t: string) => t === type || (t === "integer" && Number.isInteger(value)))) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "string" && ((schema.pattern && !new RegExp(schema.pattern).test(value)) || value.length > (schema.maxLength ?? Infinity))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) return value.length <= (schema.maxItems ?? Infinity) && value.every(v => matches(v, schema.items));
  if (type === "object") {
    if (schema.required.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, v]) => matches(v, schema.properties[key]));
  }
  return true;
}
export function validBody(body: any): boolean {
  if (!matches(body, contract.schema)) return false;
  const pairs: Record<string, string> = { armorclaude: "claude-code", armorcodex: "codex", armoropencode: "opencode", armorantigravity: "antigravity" };
  if (pairs[body.plugin] !== body.hostAgent) return false;
  const days = body.localCounts.map((c: any) => c.day);
  return new Set(days).size === days.length && days.every((d: string) => {
    const time = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === d;
  });
}
