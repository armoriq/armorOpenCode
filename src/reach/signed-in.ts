import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { PRODUCT, readLogin } from "../io/credentials.ts";
import type { ReachDependencies } from "./ping.ts";
import type { Env } from "./state.ts";

// ArmorHost does not expose credentials.current(). Use the persisted relogin posture for this key.
export async function isSignedIn(ctx: { env: Env; home: string; backend: string }, deps: ReachDependencies): Promise<boolean> {
  const login = (deps.readLogin ?? readLogin)(ctx.env, ctx.backend);
  if (!login) return false;
  const binding = createHash("sha256").update(`${login.backend}\n${login.apiKey}`).digest("hex").slice(0, 16);
  const dataDir = path.join(ctx.env.ARMORIQ_HOME ?? path.join(ctx.home, ".armoriq"), PRODUCT);
  try {
    await lstat(path.join(dataDir, `relogin-required-${binding}`));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
