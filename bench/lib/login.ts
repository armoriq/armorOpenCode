import path from "node:path";
import { REPO_ROOT, type Sandbox } from "./opencode.ts";

export const TEST_API_KEY = "ak_test_e2e";

// Writes the login through the SDK's own writer, so the file is exactly what `armoriq login` produces.
export async function seedCredentials(sandbox: Sandbox, backend: string): Promise<void> {
  const sdk = JSON.stringify(path.join(REPO_ROOT, "node_modules", "@armoriq", "sdk-dev", "dist", "index.js"));
  const scope = JSON.stringify({ backend, product: "armoropencode" });
  const profile = JSON.stringify({ backend, product: "armoropencode", apiKey: TEST_API_KEY, email: "e2e@example.com", userId: "user-e2e", orgId: "org-e2e" });
  const script = `
    const { saveLoginProfile, loadLoginContext } = await import(${sdk});
    saveLoginProfile(${profile});
    if (!loadLoginContext(${scope})) throw new Error("login not readable");
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "", HOME: sandbox.home }, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`seeding credentials failed: ${await new Response(proc.stderr).text()}`);
}
