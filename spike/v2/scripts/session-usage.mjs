// Prints V2's own per-session usage via @opencode/client, for comparison with the plugin's event capture.
// Usage: HOME=<sandbox> node session-usage.mjs <sessionID>...
// The background service requires the password it writes to ~/.local/state/opencode/service.json.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"

const service = JSON.parse(readFileSync(join(homedir(), ".local/state/opencode/service.json"), "utf8"))
const auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64")
const client = OpenCode.make({ baseUrl: service.url, headers: { authorization: auth } })
for (const sessionID of process.argv.slice(2)) {
  const s = await client.session.get({ sessionID })
  console.log(JSON.stringify(s))
}
