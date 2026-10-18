/** The longest delay one setTimeout holds (2^31 - 1 ms, about 24.8 days).
 *  Node fires a longer one almost at once, with a TimeoutOverflowWarning. */
const MAX_TIMER_MS = 2_147_483_647;

type Hold = (timer: ReturnType<typeof setTimeout>) => void;

/**
 * Call `fire` at `deadlineMs` (epoch ms) by the wall clock, through timers no
 * longer than one holds, so a deadline weeks away fires then rather than at
 * once. When a step ends, it reads the wall clock against the deadline and
 * arms the next for what's left, so the steps' own delays don't add up, and a
 * process that restarts and arms the same stored deadline aims at the same
 * time. A step's own wait runs on Node's monotonic clock, so a change to the
 * wall clock during a step is seen when that step ends. `hold` gets each
 * step's timer: clearing the latest one stops the rest.
 */
export function armAt(deadlineMs: number, hold: Hold, fire: () => void): void {
  const arm = (): void => {
    // A deadline that has just passed arms a 0 ms step rather than a negative
    // one, which Node 23 and later warn about.
    hold(setTimeout(step, Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMER_MS)));
  };
  const step = (): void => {
    if (deadlineMs - Date.now() > 0) arm();
    else fire();
  };
  arm();
}

/**
 * Call `fire` after `delayMs`, counted on timers no longer than one holds, so
 * a delay weeks long fires then rather than at once. The timers count the
 * time, so setting the wall clock doesn't move it. `hold` gets each step's
 * timer: clearing the latest one stops the rest.
 */
export function armAfter(delayMs: number, hold: Hold, fire: () => void): void {
  let left = delayMs;
  const arm = (): void => {
    const step = Math.min(left, MAX_TIMER_MS);
    left -= step;
    hold(setTimeout(left > 0 ? arm : fire, step));
  };
  arm();
}
