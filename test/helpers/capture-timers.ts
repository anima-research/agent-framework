export type CapturedTimer = { handle: ReturnType<typeof setTimeout>; due: () => void };

/**
 * Runs `fn`, one synchronous stretch of the runner's code, with setTimeout
 * passing through to the real one and recording each timer of `ms` it sets,
 * and restores setTimeout in a finally. Firing a captured timer early is
 * clearing its handle and running its callback, the runner's own.
 */
export function captureTimers<T>(ms: number, fn: () => T): { result: T; timers: CapturedTimer[] } {
  const realSetTimeout = globalThis.setTimeout;
  const timers: CapturedTimer[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(callback, delay, ...args);
    if (delay === ms) timers.push({ handle, due: () => callback(...args) });
    return handle;
  }) as typeof setTimeout;
  try {
    return { result: fn(), timers };
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

export function fireTimer({ handle, due }: CapturedTimer): void {
  clearTimeout(handle);
  due();
}

type ObservedRun = { wait(ms: number): Promise<unknown> };
type ObservingScripts = { observe(script: { run: ObservedRun }, ms: number, watch: unknown): Promise<unknown> };

export function fireNextYieldAsSet(scripts: object, ms: number): { fired: boolean; refusal?: string } {
  const manager = scripts as ObservingScripts;
  const observe = manager.observe;
  const yields: { fired: boolean; refusal?: string } = { fired: false };
  manager.observe = (script, askedMs, watch) => {
    if (askedMs !== ms) return observe.call(manager, script, askedMs, watch);
    manager.observe = observe;
    const run = script.run;
    const wait = run.wait;
    run.wait = (waitMs: number) => {
      run.wait = wait;
      const { result: waited, timers } = captureTimers(waitMs, () => wait.call(run, waitMs));
      if (timers.length !== 1) {
        yields.refusal = `the run's wait set ${timers.length} timers of its ${waitMs} ms yield, not one`;
        throw new Error(yields.refusal);
      }
      // Node can run even a 0 ms timer after I/O that is already waiting, so a
      // yield left to its timer can let the child's first call reach the host
      // while the run call still watches. Fired here, as it is set, the run call
      // stops watching before any I/O callback runs.
      fireTimer(timers[0]);
      yields.fired = true;
      return waited;
    };
    return observe.call(manager, script, askedMs, watch);
  };
  return yields;
}
