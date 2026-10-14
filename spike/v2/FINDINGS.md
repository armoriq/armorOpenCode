# OpenCode V2 spike: plugin contract and approvals

Issues: https://github.com/armoriq/armorOpenCode/issues/125 and https://github.com/armoriq/armorOpenCode/issues/127.
Tracking: https://github.com/armoriq/armorOpenCode/issues/141.

Every answer below comes from a real OpenCode run captured on 2026-10-14. Nothing was mocked.

## Setup

- OpenCode `@opencode/cli` 2.0.29 (npm `latest`), `@opencode/plugin` 2.0.29, macOS arm64.
- Sandbox HOME and XDG dirs from `mktemp -d`; the real `~/.config/opencode`, `~/.local/share/opencode` and `~/.armoriq` were not used. See `scripts/setup-sandbox.sh`.
- Model: `opencode/big-pickle` (OpenCode free tier). It works headless and in the TUI with no credentials. `opencode2 models` also lists ten other `*-free` models; only big-pickle was used.
- Plugin: `plugin/index.ts`, a `Plugin.define({ id, setup })` plugin loaded from a local path through the `plugins` object form. It logs `tool.hook("execute.before")`, `tool.hook("execute.after")`, `permission.hook("evaluate")`, `session.hook("context")` (last two messages, to see exactly what the model receives) and `permission.*` events from `ctx.event.subscribe()`. A per-run `mode.json` switches it into block, mutate, sleep, hang, crash and evaluate-override behavior.
- MCP: `scripts/mcp-echo.mjs`, a real stdio MCP server built on `@modelcontextprotocol/sdk`, configured as `mcp.servers.spike`.
- Headless runs: `scripts/run.sh` (`opencode2 run --standalone --format json`). TUI runs: `scripts/tui.sh` (tmux, `opencode2 --standalone --prompt`).
- Each run is in `payloads/<run>/`: `plugin.jsonl` (hook log), `run.jsonl` (CLI event stream), `stderr.txt`, `mode.json`, `prompt.txt`, `meta.json`; TUI runs have `pane-*.txt` screen captures. Sandbox paths are rewritten to `$SB`, spike paths to `$SPIKE`.

Coexistence note for https://github.com/armoriq/armorOpenCode/issues/128: the V2 background service listens on a fixed port, 127.0.0.1:49374. A second HOME on the same machine refuses to start ("Managed service port 49374 ... is already in use") until it is given another port with `opencode service set port`. All runs here used `--standalone` or a separate port.

## Real signatures (`@opencode/plugin` 2.0.29)

Copied verbatim into `types/` from `dist/promise/`. The parts that matter:

```ts
interface Plugin { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void }
type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>

interface ToolHooks {
  "execute.before": { tool: string; readonly sessionID; readonly agent; readonly messageID; readonly id: Tool.CallID; input: unknown }
  "execute.after": { readonly tool; readonly sessionID; readonly agent; readonly messageID; readonly id; readonly input: unknown }
    & ({ readonly status: "completed"; result: Tool.Result } | { readonly status: "error"; error: Tool.Error })
}

interface PermissionEvaluation {
  readonly sessionID; readonly agent?; readonly action: string; readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>; readonly source?: { type: "tool"; messageID: string; id: string }
  effect: "allow" | "deny" | "ask"; message?: string
}
```

Callbacks return `void`; a hook changes behavior only by mutating the non-readonly fields of its event or by throwing. `ctx.permission` also exposes `assert(input)` (prompts and waits) and `reply`, not exercised here.

## #125: execute.before and execute.after fields

Answer: both hooks fire for every tool family. Fields are exactly the typed ones.

- `execute.before`: `tool`, `sessionID`, `agent`, `messageID`, `id` (call id), `input`.
- `execute.after`: the same plus `status` and either `result` (`{ output, content, metadata? }`) or `error` (`{ _tag: "Tool.Error", message, error? }`).
- Order for a normal call: `execute.before`, then `permission.evaluate`, then the tool, then `execute.after`.

| Family | V2 tool name | `input` shape | Evidence |
|---|---|---|---|
| read | `read` | `{ path, limit? }` (V1 was `filePath`) | `payloads/01-read` |
| write / edit | `write`, `edit` | `{ path, content }`, `{ path, oldString, newString }` | `payloads/02-write-edit` |
| shell | `shell` (V1 `bash`) | `{ command }` | `payloads/03-shell` |
| MCP | `<server>_<tool>`, e.g. `spike_echo`, called inside code mode `execute` | `{ text }` | `payloads/04-mcp` |
| subagent | `subagent` (V1 `task`) | `{ agent, description, prompt }` | `payloads/05-subagent` |

Things the host layer must handle:

- Code mode: the model reaches MCP tools (and sometimes `shell`) through an `execute` tool that runs JS. Each inner call fires its own before/evaluate/after with the inner tool name, nested inside the outer `execute` pair. The inner calls carry the same `id` and `messageID` as the outer `execute` call (`payloads/04-mcp`). The call id alone does not pair before with after; pair on `(id, tool)` and expect nesting.
- Subagents run in a new session. Child hooks carry the child `sessionID` and `agent: "general"`; they do not name the parent. The parent's `subagent` after-event has `result.output.sessionID` = child session, which is the only link seen (`payloads/05-subagent`).
- `execute.after` does not fire when `execute.before` throws, when `permission.evaluate` throws, or when the user rejects in the TUI (`payloads/06-block-throw`, `18-eval-throw-shell`, `22-tui-ask-shell-reject`). It does fire with `status: "error"` for a plugin deny, a config deny, a headless auto-reject and a normal tool failure (`14`, `17a`, `15`, `19`). An audit row for a block must be written from `execute.before`, not `execute.after`.
- `permission.evaluate` for `edit` and `write` carries the diff in `metadata.files[].patch` (`payloads/02-write-edit`).

Not verified: tools other than the five families (glob, grep, webfetch, websearch, skill); Linux.

## #125: throwing in execute.before blocks the call

Answer: yes. The tool does not run, and the model receives this tool result (captured from the next `session.hook("context")` request, `payloads/06-block-throw/plugin.jsonl`):

```json
{"type":"tool-result","id":"call_751254b74ebc4bb3ae0da897","name":"shell",
 "result":{"type":"error","value":{"error":{"type":"unknown","message":"ArmorIQ blocked: spike policy denies shell"},"content":[]}}}
```

Only the `Error.message` reaches the model, with no `Error:` prefix and no stack. The run stream records the part as `state.status: "error"`, `state.error: "<message>"`. Throwing a string or returning a rejected promise with a string gives the same shape with the string as the message (`payloads/09-crash-throw-string`, `10-crash-reject-string`).

## #125: is event.input mutable in execute.before

Answer: yes. Assigning `event.input = { command: "echo MUTATED-BY-PLUGIN" }` changed what ran: the shell printed `MUTATED-BY-PLUGIN`, `permission.evaluate` saw the mutated command in `resources`, and `execute.after.input` is the mutated value (`payloads/07-mutate-input`). The session's stored tool part keeps the original input (`run.jsonl` `state.input` is `echo spike-shell-ok`), so the UI and history show something other than what ran.

Not verified: whether mutating `event.tool` (also typed as writable) reroutes a call.

## #125: hook timeout and crash behavior

Answer: no timeout was observed, and every in-hook failure fails closed. A plugin that fails to load fails open.

| Case | Result | Evidence |
|---|---|---|
| `execute.before` awaits 90 s | Call waits 90 s, then runs normally | `payloads/08-before-sleep-90s` |
| `execute.before` never resolves | Session stalls; the call never runs; no output after 296 s, run killed at 300 s | `payloads/20-before-hang-300s` |
| `execute.before` throws an Error, a string, or rejects | Call blocked, model sees the message | `06`, `09`, `10` |
| `execute.after` throws | The tool already ran (side effect done), but the model gets an error result with the thrown message instead of the output | `payloads/11-after-throw` |
| `permission.evaluate` throws | Call blocked, model sees the thrown message, no `execute.after` | `payloads/18-eval-throw-shell` |
| `setup` throws | No hooks registered; session runs unguarded with no message in stderr | `payloads/12-setup-throw` |

So a backend outage inside a hook must be bounded by our own timeout: OpenCode will wait forever. A crash in setup silently disables the guard.

Not verified: whether interrupting the stalled session from the TUI recovers it; sleep or hang inside `permission.evaluate`.

## #127: permission.evaluate fields and allow, deny, ask

Answer: the hook fires once per tool call (after `execute.before`) with `sessionID`, `agent`, `action` (the tool permission name: `read`, `edit`, `shell`, `subagent`, `spike_echo`, ...), `resources` (path, command text, agent name, MCP server or `*`), `metadata` (diff for edits, `{}` for MCP), `source` (`{ type: "tool", messageID, id }`, which matches the call id from `execute.before`), and `effect`. With the default config the incoming `effect` is `allow` for every tool tested, including shell without `--auto` (`payloads/13-default-shell-noauto`); the default ruleset is `[{ action: "*", resource: "*", effect: "allow" }]` (seen in `17a` error rules).

Setting `event.effect` works for all three values:

- `deny`: call blocked; model sees `{"error":{"type":"permission.rejected","message":"<our event.message>"}}`; `execute.after` gets `Permission.BlockedError` with `reason` = our message. Holds under `--auto` (`payloads/14-eval-deny-shell`).
- `ask`: OpenCode emits `permission.asked` (with our `message`, `resources`, a suggested `save` pattern such as `echo *`, and the call `source`) and waits for a reply (`15`, `16`, `21`).
- `allow`: accepted, but it cannot override a config rule. With `permissions: [{ action: "shell", resource: "echo *", effect: "deny" }]` the hook is not called at all and the call is denied, with or without a plugin trying to allow it (`payloads/17a-config-deny-shell`, `17b-config-deny-plugin-allow`).

Side finding: a config deny of `shell` with resource `*` made the free-tier model reject every request with HTTP 403 "OpenCode's free tier can only be used from within OpenCode", so `17a` and `17b` use `echo *`.

## #127: does an ask reach the user, and what auto-approve does

| Mode | Plugin sets `ask` | Evidence |
|---|---|---|
| TUI, no `--auto` | Real "Permission required" prompt with Allow once, Always allow, Reject. Allow once: call runs. Reject: "The user declined this tool call", turn ends, no `execute.after`. | `payloads/21-tui-ask-shell`, `22-tui-ask-shell-reject` |
| Headless `run`, no `--auto` | Auto-rejected at once. stderr: `permission requested: shell (echo spike-shell-ok); auto-rejecting`. Model sees `permission.rejected` with OpenCode's text "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action." | `payloads/15-eval-ask-shell-noauto` |
| Headless `run --auto` | Auto-approved (`permission.replied` `once` 2 ms after `asked`); the shell ran | `payloads/16-eval-ask-shell-auto` |
| TUI `--auto` | Auto-approved; no prompt shown; the shell ran | `payloads/23-tui-ask-shell-auto` |

Our custom `message` travels in the `permission.asked` event but is not shown in the TUI prompt (`21/pane-1-prompt.txt`), and is not what the model sees on a headless auto-reject.

## #127: recommendation

Use `ask` for holds only where the user is present, and keep hold equals block everywhere else.

- In the TUI without `--auto`, `ask` gives real approvals for the first time: the user sees the prompt and the call waits.
- `--auto` turns an `ask` into an approval, and the `evaluate` event does not say whether auto mode is on. Shipping hold as `ask` unconditionally would let any `--auto` run (TUI or headless) bypass a hold. That is a security regression versus V1.
- Headless without `--auto` already rejects an `ask`, so hold equals block there, but the model gets OpenCode's text rather than ours.

So #134 should go ahead only with a way to tell auto mode apart. Candidates, none verified: `ctx.permission.assert` from `execute.before`, detecting an auto `permission.replied`, or a plugin option set by the installer. Until one is proven, P1 should map hold to `deny` with our message, which blocks in every mode (`payloads/14-eval-deny-shell`).

The prompt shows OpenCode's own text, not why ArmorIQ is holding the call; #134 needs another way to show the reason if that matters.

## Not verified in this spike

- Paid models and providers other than the OpenCode free tier.
- Linux and Windows.
- Two plugins hooking the same event (order, who wins).
- "Always allow": whether a saved rule stops the next `evaluate` from being able to ask again.
- `ctx.permission.assert`, `ctx.permission.reply`, and `event.tool` mutation.
- Sleep or hang inside `permission.evaluate`; interrupting a stalled hook from the TUI.

## Reproduce

```sh
cd spike/v2 && npm ci
SB=$(./scripts/setup-sandbox.sh)          # installs @opencode/cli 2.0.29 into the sandbox
. "$SB/env.sh"; opencode2 service set port 49411   # only if another OpenCode service holds 49374
./scripts/run.sh 06-block-throw '{"block":{"tool":"shell","message":"blocked"}}' 'Run echo hi with the shell tool' --auto
./scripts/tui.sh 21-tui-ask-shell '{"evaluate":{"action":"shell","effect":"ask"}}' 'Run echo hi with the shell tool'
tmux attach -t oc2spike
```
