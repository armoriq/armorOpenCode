// These are the success forms returned by src/tools/intent.ts. Unknown
// replies fail closed; the tests pin every current success and refusal family.
export function isPlanSuccess(reply: string): boolean {
  return /^Plan recorded locally, not registered \(logged_out\)\.$/.test(reply)
    || /^Intent registered: plan \S+ \((?:new|revision|refresh)\), \d+ steps\. Token valid until [^\n]+\.(?:\nDenied by policy: [^\n]+\.)?(?:\nRequires approval: [^\n]+\.)?$/.test(reply);
}
