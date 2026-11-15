import { environmentFor } from "./state.ts";

// Keep this package spec in step with SDK_SPEC in the curl installer.
const SDK_SPEC = "@armoriq/sdk-dev@^0.8.17";

export function loginCommand(backend: string): string {
  const url = new URL(backend);
  if (!/^https?:$/.test(url.protocol)) throw new Error("ArmorIQ backend must be an http(s) origin");
  const origin = url.origin;
  const argument = environmentFor(origin) ? origin : `'${origin.replaceAll("'", "'\\''")}'`;
  return `npx -y ${SDK_SPEC} login --product armoropencode --backend ${argument}`;
}
