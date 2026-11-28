import { loginCommand } from "../reach/login.ts";
import type { Runtime } from "../runtime.ts";
import { orgModeForced } from "../state/org-mode.ts";
import { policyRead } from "../tools/intent.ts";
import type { BundleState } from "../state/policy-bundle.ts";
import type { SessionID } from "../types.ts";

export const ARMOR_COMMAND = "armor";

const USAGE = ["ArmorIQ commands:", "  /armor status   mode, plan, token expiry, policy hash", "  /armor policy   active policy summary"].join("\n");

// Returns the reply for an /armor command, or null when the text is not one.
export function handleArmorCommand(text: string, sessionId: string, rt: Runtime): string | null {
  const trimmed = text.trim();
  if (!/^\/armor(?:\s|$)/i.test(trimmed)) return null;
  const [sub = "status", arg, ...extra] = trimmed.slice("/armor".length).split(/\s+/).filter(Boolean);
  const id = sessionId as SessionID;
  if (extra.length > 0) return USAGE;
  const command = sub.toLowerCase();
  if (command === "status") return status(rt, id);
  if (command === "policy") return policyRead(rt, id, arg);
  return USAGE;
}

function status(rt: Runtime, id: SessionID): string {
  const lines = [`ArmorIQ mode: ${rt.mode()}`, `Policy hash: ${rt.policy.current().hash}`];
  const login = rt.login();
  if (login && !orgModeForced() && !rt.org.known(login)) lines.push("Workspace mode: not confirmed yet, so Block applies");
  const refused = login ? null : rt.credentials.refused();
  if (refused) lines.push(`Login: the saved API key was rejected, so only read calls run. Run \`${loginCommand(refused.backend)}\``);
  if (login) lines.push(bundleLine(rt.bundle.state(login)));
  const seen = login ? rt.posture.seen() : null;
  if (seen) {
    const ago = Math.round((Date.now() - seen.at) / 1000);
    lines.push(seen.state === "unreachable" ? `Backend: unreachable ${ago}s ago (${seen.reason}); only read calls run` : `Backend: reachable ${ago}s ago`);
  }
  if (!rt.sessions.has(id)) {
    lines.push("Plan: none registered");
    return lines.join("\n");
  }
  const session = rt.sessions.get(id);
  const root = rt.sessions.root(id);
  if (root.id !== session.id) lines.push(`Subagent of session ${root.id}; the parent plan applies.`);
  const plan = root.plan;
  if (!plan) lines.push("Plan: none registered");
  else {
    lines.push(`Plan: ${plan.goal} (revision ${plan.revision}${plan.id ? `, id ${plan.id}` : ""})`);
    plan.steps.forEach((s, i) => {
      const done = i < root.stepCursor ? "x" : " ";
      lines.push(`  [${done}] ${i + 1}. ${s.tool}${s.action && s.action !== s.tool ? `: ${s.action}` : ""}`);
    });
  }
  const t = root.token;
  if (!t) lines.push("Token: none");
  else if (t.status === "refused") lines.push(`Token: refused (${t.code})`);
  else {
    const left = Math.round((t.expiresAt - Date.now()) / 1000);
    lines.push(`Token: ${left > 0 ? `expires ${new Date(t.expiresAt).toISOString()} (${left}s left)` : "expired"}`);
  }
  return lines.join("\n");
}

function bundleLine(state: BundleState): string {
  if (state.status === "unavailable") return "Workspace policy (v2): not loaded, so only read calls run";
  const agent = state.agent;
  const entries = agent?.policies ?? (agent?.policy ? [{ ...agent.policy, targetType: "agent", status: "active" }] : []);
  const names = entries.map((p) => `${p.name}${p.status === "shadow" ? " (shadow)" : ""}${p.targetType === "org" ? " [workspace]" : ""}`);
  const stale = state.status === "stale" ? ", not confirmed recently, so only read calls run" : "";
  return names.length ? `Workspace policy (v2): ${names.join(", ")}${stale}` : `Workspace policy (v2): none, the local policy applies${stale}`;
}
