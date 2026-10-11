// O_EXCL lockfile with stale-owner recovery, as ArmorClaude dev scripts/lib/live-usage.mjs.
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  throw new Error("not implemented");
}
