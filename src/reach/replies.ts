// These are the three success forms returned by src/tools/intent.ts. Unknown
// replies fail closed; the tests pin every current success and refusal family.
export function isPlanSuccess(reply: string): boolean {
  return /^Intent recorded locally: \d+ steps\. ArmorIQ is not logged in, so calls are monitored, not enforced\.$/.test(reply)
    || /^Intent (?:registered|revised \(revision \d+\)): \d+ steps\.(?: Token valid until [^\n]+\.)?(?: Denied by policy: [^\n]+\.)?(?: Requires approval: [^\n]+\.)?$/.test(reply);
}
