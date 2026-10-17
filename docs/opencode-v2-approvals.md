# Approvals on OpenCode 2

On OpenCode 2, a call that ArmorIQ holds for approval is denied, the same as on OpenCode 1. The model sees:

```
ArmorIQ: approval required (<reason>). This call was not run.
```

The plugin option `approvals` exists so the installer can record a choice, but every value denies a hold:

| `approvals` | Result |
|---|---|
| unset or `"deny"` | Hold denied |
| `"ask"` | Hold denied; the V2 log records why `ask` is not honored |
| anything else | Hold denied; the V2 log records the unknown value |

## Why holds are not sent to OpenCode's permission prompt

OpenCode 2's `permission.evaluate` hook can set `effect: "ask"`, and the TUI then shows a real "Permission required" prompt. It is not safe to use for holds, because the reply comes from the client, not from OpenCode's server, and some clients approve every ask without the user:

- `opencode run --auto` subscribes to `permission.asked` and replies `once` to each one, in about 2 ms.
- The TUI approves every ask when it is started with `--auto`, or when its `session.permissions` setting is `autoaccept`. The user can change that setting during a session.

The plugin sees the same `permission.replied` event (`{ sessionID, requestID, reply: "once" }`) whether a person or an auto-accepting client answered. Nothing in the `evaluate` event, the plugin context, or the server says whether auto-accept is on. If holds were asks, any of these clients would run a held call.

Evidence, from OpenCode 2.0.29:

- Auto and manual replies are identical: `spike/v2/payloads/16-eval-ask-shell-auto`, `21-tui-ask-shell` and `23-tui-ask-shell-auto` on branch `spike/v2-plugin-contract`.
- The client-side approval code, in the `@opencode/cli-darwin-arm64` 2.0.29 binary: the headless runner calls `permission.reply({ decision: e.auto ? "once" : "reject" })`, and the TUI replies `once` whenever `permission.mode === "autoaccept"`, where `mode` is `t.auto ? "autoaccept" : session.permissions`.

## When this can change

Holds can become prompts if OpenCode gives plugins a way to ask the user that auto-accept cannot answer, or tells the plugin which client replied. Until then, approving a held call happens outside OpenCode, for example by changing the policy.
