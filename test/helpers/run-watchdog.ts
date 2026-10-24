/**
 * An ephemeral run's completion watchdog, fired when the test says.
 *
 * Once a run's inference has started, the watchdog ends it when its last
 * stream-driver activity is older than `idleTimeoutMs`. A short limit races
 * the run's own progress, so on a loaded host it can fire before the round the
 * test waits for, and the test fails on the host's load. A test gives the run
 * UNREACHED_WATCHDOG instead, a limit no run in a test reaches by itself, and
 * calls silenceRun() once it has what it waits for: the run's last activity
 * moves back past the limit, and the watchdog fires at its next poll, unless
 * the stream driver is active again before then.
 */
export const UNREACHED_WATCHDOG = { idleTimeoutMs: 60_000, idlePollMs: 20 };

/**
 * The completion watchdog of the run named `name` fires at its next poll. It
 * throws if no run of that name is registered or its inference hasn't started,
 * since the start would undo it.
 */
export function silenceRun(framework: object, name: string): void {
  const run = (framework as { ephemeralRuns?: Map<string, { lastActivity: number; inferenceStarted: boolean }> })
    .ephemeralRuns?.get(name);
  if (!run) throw new Error(`silenceRun: no ephemeral run named ${name} is registered`);
  if (!run.inferenceStarted) throw new Error(`silenceRun: the run ${name}'s inference hasn't started`);
  run.lastActivity -= UNREACHED_WATCHDOG.idleTimeoutMs + 1_000;
}
