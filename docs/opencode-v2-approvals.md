# Approvals on OpenCode 2

OpenCode has no approval prompt the plugin can trust, so a call held for approval is stopped and sent to ArmorIQ for another workspace member to approve. This works the same on OpenCode 1 and 2.

When a workspace (v2) policy holds a call and the session has a signed intent plan, the plugin asks the backend for the call's verdict (`POST /iap/sdk/enforce`). If the call is still held, it files an approval request (`POST /delegation/request`) for that plan, tool and arguments, and the model sees:

```
ArmorIQ: ArmorIQ policy "<name>" holds <tool> for approval (<rule>). Approval request <id> is waiting for another workspace member. This call was not run; retry it with the same arguments after the request is approved.
```

The held call is audited as `held`, not `blocked`, so the plan stays usable. After a member approves the request, the same call under the same plan is allowed once: the backend spends the approval. A rejected or expired request blocks the retry. If the session has no plan, or the request cannot be filed, the call stays stopped and the message says why.

Holds from a local policy (`require_approval`) or from the token's held tools are not filed and are denied with:

```
ArmorIQ: approval required (<reason>). This call was not run.
```

The plugin option `approvals` exists so the installer can record a choice, but no value turns a hold into an OpenCode permission prompt:

| `approvals` | Result |
|---|---|
| unset or `"deny"` | Hold stopped and filed for approval |
| `"ask"` | Same; the V2 log records why `ask` is not honored |
| anything else | Same; the V2 log records the unknown value |

## Why holds are not sent to OpenCode's permission prompt

OpenCode 2's `permission.evaluate` hook can set `effect: "ask"`, and the TUI then shows a real "Permission required" prompt. It is not safe to use for holds, because the reply comes from the client, not from OpenCode's server, and some clients approve every ask without the user:

- `opencode run --auto` subscribes to `permission.asked` and replies `once` to each one, in about 2 ms.
- The TUI approves every ask when it is started with `--auto`, or when its `session.permissions` setting is `autoaccept`. The user can change that setting during a session.

The plugin sees the same `permission.replied` event (`{ sessionID, requestID, reply: "once" }`) whether a person or an auto-accepting client answered. Nothing in the `evaluate` event, the plugin context, or the server says whether auto-accept is on. If holds were asks, any of these clients would run a held call.

Evidence, from OpenCode 2.0.29:

- Auto and manual replies are identical: `spike/v2/payloads/16-eval-ask-shell-auto`, `21-tui-ask-shell` and `23-tui-ask-shell-auto` on branch `spike/v2-plugin-contract`.
- The client-side approval code, in the `@opencode/cli-darwin-arm64` 2.0.29 binary: the headless runner calls `permission.reply({ decision: e.auto ? "once" : "reject" })`, and the TUI replies `once` whenever `permission.mode === "autoaccept"`, where `mode` is `t.auto ? "autoaccept" : session.permissions`.

## When this can change

Holds can become prompts if OpenCode gives plugins a way to ask the user that auto-accept cannot answer, or tells the plugin which client replied. Until then, a held call is approved outside OpenCode, by another workspace member.
