/** Polls `fn` while the tab is visible, at `ms()` intervals (re-read each round so
 * callers can slow down when idle). Skips rounds while hidden and refreshes
 * immediately when the tab becomes visible again. Returns a cleanup function. */
export function pollWhileVisible(fn: () => void | Promise<void>, ms: () => number): () => void {
  let timer: number | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = window.setTimeout(async () => {
      if (!document.hidden) await fn();
      schedule();
    }, ms());
  };
  const onVisible = () => {
    if (document.hidden || stopped) return;
    window.clearTimeout(timer);
    void Promise.resolve(fn()).finally(schedule);
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
