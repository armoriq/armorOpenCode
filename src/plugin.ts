// Package entry. Installed configs point here, so the exports and the plugin id must stay stable.
// One default export serves both majors: OpenCode 1 calls `server`, OpenCode 2 calls `setup`.
import { ArmorOpenCode } from "./hosts/v1/plugin.ts";
import { setup } from "./hosts/v2/index.ts";

export { ArmorOpenCode };

const plugin = { id: "armoropencode", server: ArmorOpenCode, setup };
export default plugin;
