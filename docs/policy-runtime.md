# ArmorOpenCode policy runtime

P5 closes the installer boundary that previously pointed at a placeholder
`npx` command. A staged release now contains the policy runtime itself:

- `scripts/policy-mcp.ts` speaks MCP stdio and exposes
  `register_intent_plan`, `get_intent_plan`, `reset_intent_plan`, and
  `policy_read`.
- `telemetry/plugin.ts` hooks `tool.execute.before`. It exempts ArmorOpenCode
  management tools and OpenCode's documented native helper tools, then applies
  the active local policy and the session intent plan. Missing, stale, or
  malformed plans deny by default.
- Plans are stored under the user's ArmorIQ data directory with sanitized
  session file names. No prompt, tool argument, result, repository path, or
  credential is sent by this runtime.

The remote ArmorIQ policy client and human confirmation flow are intentionally
separate follow-up work. The release is therefore safe to test locally, while
the public installer remains gated on the existing GCP and authenticated
account checks.
