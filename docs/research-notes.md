# Phase 0 Research Spike — Findings

Ground-truth findings from installing and driving a real local `opencode` (npm
package `opencode-ai`) install, gathered 2026-09-08, to replace docs-paraphrase
assumptions before any ArmorOpenCode port code is written.

Everything below is labeled:
- **CONFIRMED** — verified directly from installed source (`.d.ts`), a live
  headless session, or the server's own runtime output.
- **PARTIALLY CONFIRMED** — verified at the protocol/data level but not
  visually confirmed in the interactive TUI specifically (see note).
- **GAP** — attempted, could not get a definitive answer in this environment;
  documented with what was tried and what would close the gap.

All raw commands below were run for real; nothing here is paraphrased from
docs.

---

## 1. Installed opencode version

```
$ npm i -g opencode-ai
$ opencode --version
1.18.29
```

**CONFIRMED**: a plain, unpinned `npm i -g opencode-ai` installs **1.18.29**
— a 1.x ("V1") release, not a "V2 beta". This is what ships as `latest` on
npm today.

Nuance worth carrying into later phases: the `@opencode-ai/sdk` dependency
that ships *inside* this same 1.18.29 install contains a parallel `v2/`
subpath (`node_modules/@opencode-ai/sdk/dist/v2/{client,server,gen}...`) with
its own generated client/types. So "V2" concepts exist as an internal/opt-in
API surface within the current package version, but the CLI's default
`--version`, default `opencode run`, and top-level `@opencode-ai/plugin`
`Hooks` type (installed and read below) are the V1 surface. Confirm which
surface is authoritative again at the start of Phase 2 in case this shifts.

---

## 2. `Hooks` type and `opencode.json` plugin field — from the installed `.d.ts`

Scratch repro: `bun init` in a scratch dir, then `bun add @opencode-ai/plugin`
(resolved `@opencode-ai/plugin@1.18.29`), then read
`node_modules/@opencode-ai/plugin/dist/index.d.ts` directly (not docs).

### Config field: `plugin` (singular) — CONFIRMED, docs disagreement resolved

From `@opencode-ai/plugin`'s own `dist/index.d.ts`:

```ts
export type PluginOptions = Record<string, unknown>;
export type Config = Omit<SDKConfig, "plugin"> & {
    plugin?: Array<string | [string, PluginOptions]>;
};
```

And from the lower-level generated SDK config type,
`@opencode-ai/sdk/dist/gen/types.gen.d.ts` (line 1067), which is what
`SDKConfig` above is `Omit`-ing from:

```ts
plugin?: Array<string>;
```

**The field is `"plugin"` (singular) everywhere in the actual shipped type
definitions — never `"plugins"`.** There is no `"plugins"` field anywhere in
either package's `.d.ts` output. This is further corroborated by the CLI
itself: `opencode plugin <module>` is a real subcommand ("install plugin and
update config") that writes into this singular `plugin` array.

Project-local dev plugins (what we used for step 3, below) don't need a
config entry at all — a file dropped at `.opencode/plugin/<name>.js`
exporting an async function matching the `Plugin` type is auto-discovered by
the CLI with no `opencode.json` changes required. That was confirmed
empirically (see step 3).

### `Hooks` interface — verbatim excerpt (the parts this project cares about)

From `@opencode-ai/plugin/dist/index.d.ts`, verbatim:

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: {
        register(type: string, adapter: WorkspaceAdapter): void;
    };
    serverUrl: URL;
    $: BunShell;
};
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;

export interface Hooks {
    dispose?: () => Promise<void>;
    event?: (input: { event: Event }) => Promise<void>;
    config?: (input: Config) => Promise<void>;
    tool?: { [key: string]: ToolDefinition };
    auth?: AuthHook;
    provider?: ProviderHook;

    "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>;

    "command.execute.before"?: (input: {
        command: string;
        sessionID: string;
        arguments: string;
    }, output: { parts: Part[] }) => Promise<void>;

    "tool.execute.before"?: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: { args: any }) => Promise<void>;

    "tool.execute.after"?: (input: {
        tool: string;
        sessionID: string;
        callID: string;
        args: any;
    }, output: { title: string; output: string; metadata: any }) => Promise<void>;

    "tool.definition"?: (input: { toolID: string }, output: {
        description: string;
        parameters: any;
    }) => Promise<void>;

    // ... plus chat.message, chat.params, chat.headers, shell.env, and several
    // "experimental.*" hooks (session compaction, message/system transforms,
    // small-model override, text completion) — see full file for exhaustive
    // list if a later phase needs them.
}
```

**CONFIRMED** exact shapes for the two hooks this project's policy engine
will hang off of:

- `"tool.execute.before"`: `input: { tool: string; sessionID: string; callID: string }`, `output: { args: any }`. Note: **no `args` on `input`** — the mutable/inspectable args live on `output.args`, not `input.args`. This matters for how a policy plugin reads/blocks tool calls.
- `"tool.execute.after"`: `input: { tool: string; sessionID: string; callID: string; args: any }`, `output: { title: string; output: string; metadata: any }`. Here `input.args` **does** exist (post-execution), plus `output.title`/`output.output`/`output.metadata` describing the result.

This resolves an important asymmetry that wasn't obvious from docs: the
`.before` and `.after` hooks have different `input` shapes (args live in
different places on each).

---

## 3. Real runtime tool-name strings — CONFIRMED via a live headless session

opencode is **not** TUI-only — it has a genuine non-interactive/scriptable
entry point: `opencode run [message..]`, with `--format json` for raw JSON
event output and `--auto` to auto-approve permissions (required for
non-interactive tool use; without it, tool calls get rejected with "The user
rejected permission to use this specific tool call" since there's no TUI to
approve them).

No product LLM API key was available in this sandbox (the one configured
Google credential was invalid — `AI_APICALLError: API key not valid`), but
`opencode/big-pickle` (one of opencode's own hosted free-tier models, no
login/config required) worked out of the box and was used for all live runs
below. This is worth remembering for Phase 2+ CI: **`opencode/big-pickle`
(or another `opencode/*` free model) is a viable zero-config model for
automated/CI testing of plugin hooks**, no secrets needed.

### Throwaway plugin

Dropped at `.opencode/plugin/log-tools.js` in the scratch project (auto-
discovered, no config needed — see field-name note above). It hooked both
`tool.execute.before` and `tool.execute.after` and appended every call to a
log file. Confirmed the plugin loaded and fired by cross-checking its log
file against the `opencode run --format json` event stream for the same
session — they matched exactly.

### Confirmed real built-in tool names (each actually invoked by the model
in a live session and captured both in the plugin's `tool.execute.after`
log and in the `--format json` event stream):

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `glob`
- `todowrite`
- `websearch`
- `webfetch`

### MCP-sourced tool name prefixing — CONFIRMED

Configured a real MCP server (`npx -y @modelcontextprotocol/server-everything`,
the official MCP reference/test server) via `.opencode/opencode.json`:

```json
{ "mcp": { "everything": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-everything"], "enabled": true } } }
```

`opencode mcp list` showed it connected. Asked the model to call its `echo`
tool; the tool name that showed up in **both** the plugin log and the JSON
event stream was:

```
everything_echo
```

**CONFIRMED format: `<mcpServerName>_<toolName>` — underscore-separated**,
not the `mcp__server__tool` (double-underscore, Claude-style) or `server:tool`
(colon) formats this project might otherwise have assumed by analogy to
other agent ecosystems.

### Tool names NOT directly confirmed by live invocation (GAP)

- `todoread` — never observed, even when explicitly asked for by name in a
  prompt ("use your todoread tool ..."); the model always used `todowrite`
  only and apparently didn't have or didn't choose a separate read tool.
  Genuinely inconclusive whether this exists as a distinct tool in 1.18.29.
- `apply_patch` — never observed or requested successfully.
- `lsp`-backed tooling — this sandbox logged `"all LSPs are disabled"` and
  `"all formatters are disabled"` at startup, so there was nothing for an
  LSP tool to attach to; not exercised.
- `question` — not invoked live, but **indirectly corroborated**: every
  session's startup log includes a real `permission` array with an entry
  `{"permission":"question","pattern":"*","action":"deny"}`, confirming
  `question` is a real first-class permission/tool key in this opencode
  version, just not one we drove end-to-end.
- `skill` — not invoked live as a `tool.execute.*` event, but **indirectly
  corroborated**: `opencode debug skill` is a real subcommand, and every run
  in this environment logged dozens of `"duplicate skill name"` warnings
  while loading skills from `~/.claude/skills`, `~/.config/opencode/skills`,
  and `~/.agents/skills` — confirming skills are a real, actively-loaded
  first-class opencode concept in this version, just not confirmed as the
  exact literal tool-call name string.

**Recommendation for Phase 2+**: treat `read, write, edit, bash, grep, glob,
todowrite, websearch, webfetch` plus the `<mcpServer>_<tool>` MCP pattern as
confirmed ground truth for the policy engine's tool-name matching. Treat
`todoread`, `apply_patch`, `lsp`, `question`, `skill` as "probably real, name
unconfirmed" — re-verify each specifically (via a live run naming it
explicitly, or by grepping the compiled `opencode` binary's embedded JS if
one is ever unpacked) before hardcoding policy rules against them.

---

## 4. `tool.execute.before` blocking behavior — CONFIRMED (with one caveat)

Modified the throwaway plugin so that `tool.execute.before` throws a plain
`Error` when `input.tool === "bash"` and the command contains a marker
string:

```js
if (input.tool === "bash" && output?.args?.command?.includes("FORBIDDEN_MARKER")) {
  throw new Error("ArmorOpenCode research probe: this bash command is blocked by policy.");
}
```

Ran (headless): `opencode run "Run the exact shell command: echo
FORBIDDEN_MARKER using your bash tool. Report back exactly what happened,
including any error message you received, verbatim." --auto --format json`

Result, straight from the JSON event stream:

```json
{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"...",
  "state":{"status":"error","input":{"command":"echo FORBIDDEN_MARKER"},
  "error":"ArmorOpenCode research probe: this bash command is blocked by policy.",
  "time":{"start":...,"end":...}}}}
```

and the model's own follow-up text: *"The command was blocked. ... The
command did not execute — it was intercepted and blocked by a policy rule."*

**CONFIRMED**: throwing a JS `Error` inside `tool.execute.before` genuinely
prevents the tool from running — there is no corresponding
`tool.execute.after` event for that call, and no side effect occurred (the
shell command never ran). The thrown message is passed through verbatim as
the tool part's `error` field, which becomes part of the session's message
history and is what the model (and, presumably, the TUI) sees.

**Caveat / partial gap**: this was confirmed via headless `opencode run
--format json`, not by literally watching the interactive TUI render the
error. I could not drive a real interactive TUI session non-interactively in
this environment (no pty/expect-style automation was attempted — `opencode
run` was sufficient to answer the functional question and is the correct
tool for this repo's own automated tests anyway). Since the TUI renders
directly from these same message parts, it's a reasonable inference that it
displays this error too, but that specific visual claim is not itself
independently verified. Flag this as "functionally confirmed, TUI rendering
not visually confirmed" if a later phase's docs/marketing copy wants to make
a claim about the TUI specifically.

---

## 5. Namespaced slash-command syntax — CONFIRMED, and it **corrects** a prior assumption

Dropped `.opencode/commands/armor/list.md`:

```markdown
---
description: ArmorOpenCode research-spike test command
---

This is a throwaway test command for Phase 0 research. If you are seeing this
executed, respond with exactly: ARMOR_LIST_COMMAND_RAN
```

First tried `opencode run --command "armor:list"` (the plan's prior belief:
colon-separated). This **failed** with a real server error that, usefully,
listed every command opencode actually knows about:

```
Command not found: "armor:list". Available commands: init, review,
armor/list, everything:simple-prompt, everything:args-prompt,
everything:completable-prompt, everything:resource-prompt, ...
```

**The registered command name is `armor/list` — forward-slash separated,
matching the directory path — not `armor:list`.** Confirmed by then running:

```
$ opencode run --command "armor/list" --format json
```

which executed the command file's body for real and the model responded
with the exact literal string from the command file: `ARMOR_LIST_COMMAND_RAN`.

**This directly corrects the plan's stated prior belief** ("format
`commands/armor/list.md` → `/armor:list` (colon-separated)"). The real
separator is `/`, not `:`.

Bonus finding while resolving this: the colon-separated names visible in the
same "Available commands" list (`everything:simple-prompt`,
`everything:args-prompt`, etc.) are **not** file-based commands at all —
they're MCP-server-provided *prompts* (from the same `everything` MCP test
server configured for step 3), namespaced as `<mcpServerName>:<promptName>`.
So both separators are real in opencode, but they mean different things:

| Source                                   | Separator | Example                        |
|-------------------------------------------|-----------|---------------------------------|
| File under `.opencode/commands/<ns>/<f>.md` | `/`       | `armor/list`                    |
| MCP server-provided prompt                 | `:`       | `everything:simple-prompt`      |

Later phases building ArmorOpenCode's `/armor:*`-style commands (per the
original ArmorGemini naming convention) need to either (a) accept the real
`/armor/list`-style slash-path syntax opencode actually uses for file-based
commands, or (b) deliberately design around this if colon-namespacing is a
hard product requirement — that's a product decision for whoever picks up
the commands work in a later phase, not something to guess at now.

---

## Summary table

| Item | Status | Verified value |
|---|---|---|
| Default `npm i -g opencode-ai` version | CONFIRMED | `1.18.29` (V1-series stable; V2 SDK types present internally but not the default surface) |
| `opencode.json` plugin field name | CONFIRMED | `"plugin"` (singular), `Array<string \| [string, PluginOptions]>` |
| `tool.execute.before` input/output shape | CONFIRMED | `input: {tool, sessionID, callID}`, `output: {args}` (no `args` on input) |
| `tool.execute.after` input/output shape | CONFIRMED | `input: {tool, sessionID, callID, args}`, `output: {title, output, metadata}` |
| Built-in tool names | CONFIRMED (9) | `read, write, edit, bash, grep, glob, todowrite, websearch, webfetch` |
| Built-in tool names | GAP | `todoread, apply_patch, lsp` unconfirmed; `question, skill` indirectly corroborated but not captured as a literal tool-call name |
| MCP tool-name prefix format | CONFIRMED | `<mcpServerName>_<toolName>` (underscore), e.g. `everything_echo` |
| Throwing `Error` in `tool.execute.before` blocks the call | CONFIRMED (headless) | Verified via JSON event stream; TUI rendering itself not visually confirmed |
| Namespaced command syntax for `.opencode/commands/<ns>/<file>.md` | CONFIRMED — corrects prior assumption | `<ns>/<file>` (`armor/list`), **not** `<ns>:<file>` |
| MCP-provided prompt namespacing | CONFIRMED (bonus finding) | `<mcpServerName>:<promptName>` (colon) — different mechanism than file-based commands |

## Environment notes for reproducing this spike

- `opencode --version` → `1.18.29`
- `@opencode-ai/plugin@1.18.29`, `@opencode-ai/sdk@1.18.29` (resolved via `bun add @opencode-ai/plugin` in a scratch dir)
- Free, zero-config model usable for headless testing: `opencode/big-pickle` (`--model opencode/big-pickle`)
- Headless entry point: `opencode run [message..] --format json --auto` (JSON events on stdout; `--auto` required to avoid interactive-permission rejection)
- Project-local plugin auto-discovery path: `.opencode/plugin/*.js` (no config entry needed)
- Project-local namespaced command path: `.opencode/commands/<namespace>/<file>.md`
