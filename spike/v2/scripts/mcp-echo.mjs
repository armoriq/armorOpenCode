import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "spike-echo", version: "1.0.0" })
server.tool("echo", "Echo text back with a fixed prefix", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `spike-echo: ${text}` }],
}))
await server.connect(new StdioServerTransport())
