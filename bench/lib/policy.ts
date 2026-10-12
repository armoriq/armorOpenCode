// armor.policy.v1 documents for the bench and e2e runs (statement shape from ArmorClaude scripts/lib/policy-ir.mjs).

type Statement = {
  id: string;
  effect: "permit" | "forbid" | "require_approval";
  action: { type: "tool"; eq?: string; in?: string[] };
  conditions: { field: string; op: string; value: unknown }[];
};

export function policyWithRules(count: number): { version: string; statements: Statement[] } {
  const statements: Statement[] = [];
  for (let i = 0; statements.length < count - 1; i++) {
    statements.push(
      i % 2 === 0
        ? { id: `forbid-path-${i}`, effect: "forbid", action: { type: "tool", in: ["read", "write", "edit"] }, conditions: [{ field: "file.path", op: "starts_with", value: `/srv/restricted-${i}/` }] }
        : { id: `forbid-bash-${i}`, effect: "forbid", action: { type: "tool", eq: "bash" }, conditions: [{ field: "bash.program", op: "eq", value: `forbidden-${i}` }] },
    );
  }
  statements.push({ id: "permit-rest", effect: "permit", action: { type: "tool", eq: "*" }, conditions: [] });
  return { version: "armor.policy.v1", statements };
}
