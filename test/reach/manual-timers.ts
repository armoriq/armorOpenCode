export function manualTimers() {
  type Timer = ReturnType<typeof setTimeout>;
  let clock = 0;
  const pending = new Map<Timer, { at: number; callback: () => void | Promise<void> }>();
  const unreferenced = new Set<Timer>();
  const schedule = (callback: () => void | Promise<void>, ms: number): Timer => {
    const timer = { unref() { unreferenced.add(timer); return timer; } } as Timer;
    pending.set(timer, { at: clock + ms, callback });
    return timer;
  };
  return {
    pending, unreferenced,
    setTimeout: schedule as typeof setTimeout,
    clearTimeout(timer: Timer) { pending.delete(timer); },
    async advance(ms = 0) {
      const end = clock + ms;
      for (;;) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at).find(([, work]) => work.at <= end);
        if (!next) { clock = end; return; }
        clock = next[1].at;
        pending.delete(next[0]);
        await next[1].callback();
      }
    },
  };
}
