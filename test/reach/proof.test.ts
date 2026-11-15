import { expect, test } from "bun:test";
import { contract } from "./helpers.ts";

import { assertCleanRequests as check } from "../../scripts/ci/reach-context-proof.ts";
test("real host proof requires captured requests", () => {
  expect(() => check([])).toThrow("No model requests were captured");
});
test("real host proof accepts ordinary model input", () => {
  expect(check([{ messages: [{ role: "user", content: "fixture prompt" }] }])).toBeUndefined();
});
for (const text of [contract.notice, "ArmorOpenCode is not signed in to ArmorIQ. Sign in", "ArmorIQ showed you a local notice. No action is needed."]) {
  test(`real host proof rejects leaked message: ${text.slice(0, 45)}`, () => {
    expect(() => check([{ messages: [{ role: "user", content: [{ type: "text", text }] }] }])).toThrow("Reach message leaked");
  });
}
