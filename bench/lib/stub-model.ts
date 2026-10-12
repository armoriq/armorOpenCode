// OpenAI-compatible chat model that drives OpenCode through a fixed list of tool calls.
// Stateless per request: the next step is chosen by counting tool results already in the history.

export type ScriptedCall = { tool: string; args: Record<string, unknown> };
// `prompt` is the first user message, which tells a subagent session apart from the parent.
export type Script = (step: number, offered: readonly string[], prompt: string) => ScriptedCall | null;

export type ToolResult = { callId: string; tool: string; content: string };

export type StubModel = {
  url: string;
  setScript(script: Script): void;
  offeredTools(): readonly string[];
  toolSchemas(): Record<string, unknown>;
  results(): readonly ToolResult[];
  reset(): void;
  stop(): void;
};

type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] };

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "stub",
  object: "chat.completion.chunk",
  created: 1,
  model: "stub",
  choices: [{ index: 0, delta, finish_reason: finish }],
  // Real providers report usage on the final chunk; without it OpenCode records zero tokens and nothing is uploaded.
  ...(finish ? { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } : {}),
});

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const text = (content: string) => sse([chunk({ role: "assistant", content }), chunk({}, "stop")]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return JSON.stringify(content ?? "");
}

export function startStubModel(): StubModel {
  let script: Script = () => null;
  let offered: string[] = [];
  let schemas: Record<string, unknown> = {};
  const seen = new Map<string, ToolResult>();
  let seq = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ data: [{ id: "stub", object: "model" }] });
      const body = (await req.json()) as { messages: Message[]; tools?: { function: { name: string; parameters?: unknown } }[] };
      const tools = body.tools ?? [];
      // Title and summary requests carry no tools.
      if (tools.length === 0) return text("Stub session");
      offered = tools.map((t) => t.function.name);
      schemas = Object.fromEntries(tools.map((t) => [t.function.name, t.function.parameters]));

      const names = new Map<string, string>();
      for (const m of body.messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
      const done = body.messages.filter((m) => m.role === "tool");
      for (const m of done) {
        const callId = m.tool_call_id ?? "";
        seen.set(callId, { callId, tool: names.get(callId) ?? "", content: contentText(m.content) });
      }

      const prompt = contentText(body.messages.find((m) => m.role === "user")?.content);
      const next = script(done.length, offered, prompt);
      if (!next) return text("done");
      const id = `call_${done.length}_${++seq}`;
      return sse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: next.tool, arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] }),
        chunk({}, "tool_calls"),
      ]);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    setScript: (s) => {
      script = s;
    },
    offeredTools: () => offered,
    toolSchemas: () => schemas,
    results: () => [...seen.values()],
    reset: () => seen.clear(),
    stop: () => server.stop(true),
  };
}

export const fromList =
  (calls: readonly ScriptedCall[]): Script =>
  (step) =>
    calls[step] ?? null;
