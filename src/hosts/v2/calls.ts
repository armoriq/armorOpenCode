// Pairs execute.before with execute.after. V2 reuses the outer call id for every tool a code-mode `execute`
// call runs, so the id alone is not unique: calls are keyed on (id, tool) and given distinct runtime ids.
type Open = { callId: string; input: string };

const key = (id: string, tool: string) => `${id}\u0000${tool}`;

function fingerprint(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

export class CallPairs {
  private readonly open = new Map<string, Open[]>();
  private readonly live = new Set<string>();
  private seq = 0;

  // The first call under an id keeps it, so the intent tools can match their own call ids.
  begin(id: string, tool: string, input: unknown): string {
    const callId = this.live.has(id) ? `${id}#${++this.seq}` : id;
    this.live.add(callId);
    const k = key(id, tool);
    const list = this.open.get(k) ?? [];
    list.push({ callId, input: fingerprint(input) });
    this.open.set(k, list);
    return callId;
  }

  // Calls with the same id and tool are told apart by their input; same input means interchangeable.
  end(id: string, tool: string, input: unknown): string | null {
    const k = key(id, tool);
    const list = this.open.get(k);
    if (!list || list.length === 0) return null;
    const print = fingerprint(input);
    const at = Math.max(0, list.findIndex((o) => o.input === print));
    const [match] = list.splice(at, 1);
    if (list.length === 0) this.open.delete(k);
    this.live.delete(match!.callId);
    return match!.callId;
  }

  // A blocked call never reaches execute.after.
  cancel(id: string, tool: string, callId: string): void {
    const k = key(id, tool);
    const list = this.open.get(k);
    if (!list) return;
    const at = list.findIndex((o) => o.callId === callId);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.open.delete(k);
    this.live.delete(callId);
  }
}
