import type { ArmorHost } from "../../host.ts";

export type ApprovalsSetting = "deny" | "ask";

export const ASK_REFUSED =
  'approvals "ask" is not honored on OpenCode 2: `--auto` and the TUI auto-accept setting approve permission asks in the client, ' +
  "and the plugin cannot tell those replies from a person's, so a hold stays blocked";

// Read from the plugin options the installer writes. "ask" is accepted as a value so a config that sets it
// is reported, not silently ignored, but a hold is denied either way: answering it through
// permission.evaluate would let any auto-approving client run a call ArmorIQ is holding.
export function approvalsSetting(value: unknown): { setting: ApprovalsSetting; warning: string | null } {
  if (value === undefined || value === "deny") return { setting: "deny", warning: null };
  if (value === "ask") return { setting: "ask", warning: ASK_REFUSED };
  return { setting: "deny", warning: `unknown approvals option ${JSON.stringify(value)}; holds are denied` };
}

export async function registerApprovals(ctx: { readonly options?: Readonly<Record<string, unknown>> }, host: ArmorHost): Promise<void> {
  const { setting, warning } = approvalsSetting(ctx.options?.approvals);
  if (warning) host.log.warn(warning, { approvals: setting });
}
