import { describe, expect, test } from "bun:test";
import fixtures from "../fixtures/plan-capture-v1.json";
import { canonicalJson, planHash, requestKey, intentValiditySeconds, planRequest } from "../../src/core/plan-request.ts";

describe("plan capture contract vectors", () => {
  for (const vector of fixtures.canonicalJson) test(vector.name, () => expect(canonicalJson(vector.input)).toBe(vector.expected));
  for (const vector of fixtures.planHash) test(vector.name, () => expect(planHash(vector.plan)).toBe(vector.expected));
  for (const vector of fixtures.idempotencyKey) test(vector.name, () => expect(requestKey(vector.input)).toBe(vector.expected));
  for (const vector of fixtures.idempotencyKey) test(`descriptor headers: ${vector.name}`, () => {
    const request = planRequest(vector.input, {});
    const input = vector.input as { kind: string; promptId?: string; parentPlanId?: string | null; countedPlanId?: string };
    expect(fixtures.kinds.wire).toContain(input.kind);
    expect(request.headers[fixtures.headers.idempotencyKey]).toBe(vector.expected);
    expect(request.headers[fixtures.headers.kind]).toBe(input.kind);
    expect(request.headers[fixtures.headers.promptId]).toBe(input.promptId);
    expect(request.headers[fixtures.headers.parentPlanId]).toBe((input.countedPlanId ?? input.parentPlanId) || undefined);
  });
  test("canonical JSON uses ECMAScript numbers and rejects values outside JSON", () => {
    expect(canonicalJson([-0, 1e30, 0.000001])).toBe("[0,1e+30,0.000001]");
    for (const value of [NaN, Infinity, undefined, { a: undefined }, "\ud800"]) expect(() => canonicalJson(value)).toThrow();
  });
});

test("intent validity defaults to 3600 and the shared variable wins over the local value", () => {
  expect(intentValiditySeconds({})).toBe(3600);
  expect(intentValiditySeconds({}, 600)).toBe(600);
  expect(intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: "180" }, 600)).toBe(180);
  expect(intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: "3600" })).toBe(3600);
  for (const value of ["", "179", "3601", "NaN", "300.5", "1e3", " 300 "]) {
    expect(() => intentValiditySeconds({ ARMORIQ_INTENT_VALIDITY_SECONDS: value })).toThrow("ARMORIQ_INTENT_VALIDITY_SECONDS");
  }
});
