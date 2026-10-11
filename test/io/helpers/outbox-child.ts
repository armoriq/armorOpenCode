// Child process for multi-process outbox tests: argv = dir, prefix, count, backend | "none".
import { createOutbox } from "../../../src/io/outbox.ts";

const [dir, prefix, count, backend] = process.argv.slice(2) as [string, string, string, string];
const quiet = { info() {}, warn() {}, error() {} };
const outbox = createOutbox<{ id: string }>(dir, "audit", quiet);
for (let i = 0; i < Number(count); i++) outbox.enqueue({ id: `${prefix}-${i}` });

if (backend === "none") {
  await outbox.persist();
  process.exit(0);
}

const send = async (batch: readonly { id: string }[]) => {
  const res = await fetch(backend, { method: "POST", body: JSON.stringify({ rows: batch }) });
  return res.ok ? { ok: true as const, rejected: [] } : { ok: false as const };
};
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const state = await outbox.drain(send, 3);
  if (state === "empty") break;
}
await outbox.persist();
process.exit(0);
