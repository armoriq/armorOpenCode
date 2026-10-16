// Package entry. Installed configs point here, so the exports and the plugin id must stay stable.
// The OpenCode 2 host will live in src/hosts/v2, driving the same ArmorHost contract (src/host.ts) as V1.
export { ArmorOpenCode, default } from "./hosts/v1/plugin.ts";
