import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// This is the released implementation from origin/main, not a model of its storage behavior.
const pinned = "29c836e9a10f43ebefd5092f993b3c541d9abd48";
const source = spawnSync("git", ["show", `${pinned}:src/io/outbox.ts`], { cwd: join(import.meta.dir, "../../.."), encoding: "utf8" });
if (source.status !== 0) throw new Error("Cannot read the pinned released outbox");
const sharedLock = join(import.meta.dir, "../../../src/io/shared-lock.ts");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.stdout.replace('"./shared-lock.ts"', JSON.stringify(sharedLock)));
const released = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const dir = process.argv[2]!;
const box = released.createOutbox(dir, "audit", { info() {}, warn() {}, error() {} });
box.enqueue({ tool: "released-before" });
await Bun.sleep(150);
console.log("ready");
const deadline = Date.now() + 5_000;
while (!existsSync(join(dir, "continue"))) {
  if (Date.now() > deadline) throw new Error("The parent did not resume the released writer");
  await Bun.sleep(5);
}
box.enqueue({ tool: "released-after" });
await box.drain(async (rows: any[]) => {
  appendFileSync(join(dir, "released-deliveries.jsonl"), JSON.stringify(rows.map(row => row.tool)) + "\n");
  return { ok: true, rejected: [] };
}, 200);
await box.persist();
