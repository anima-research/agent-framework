import type { ExecResult } from './py-runner.js';

export type TimeoutPolicy = 'continue' | 'end_turn';
export interface ScriptObservation {
  result?: ExecResult;
  endTurn: boolean;
}

/** A script's lifetime is independent of any one caller's observation budget.
 * One completion notice is armed when an observation times out or is released.
 * An observer present at completion receives the result directly instead.
 */
export class ScriptRun {
  result: ExecResult | undefined;
  private waiters = new Set<(endTurn?: boolean) => void>();
  private notifyOnCompletion = false;

  constructor(
    completion: Promise<ExecResult>,
    onComplete: (result: ExecResult, notify: boolean, observed: boolean) => void,
  ) {
    const settle = (result: ExecResult) => {
      this.result = result;
      const observed = this.waiters.size > 0;
      for (const finish of [...this.waiters]) finish();
      onComplete(result, this.notifyOnCompletion && !observed, observed);
    };
    void completion.then(settle, (err) => {
      // exec never rejects by contract; this is the belt-and-suspenders, so a
      // rejection can't leave the record 'running' (and the context busy) forever.
      console.error(`[pytc] exec rejected: ${String(err)}`);
      settle({ stdout: '', stderr: String(err), returnCode: 1, aborted: true });
    });
  }

  get observing(): boolean { return this.waiters.size > 0; }

  /** Wait up to `waitMs` for the result; `Infinity` waits until the script ends. */
  observe(waitMs: number, onTimeout: TimeoutPolicy): Promise<ScriptObservation> {
    if (this.result) return Promise.resolve({ result: this.result, endTurn: false });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (endTurn = false) => {
        if (!this.waiters.delete(finish)) return;
        clearTimeout(timer);
        if (!this.result) this.notifyOnCompletion = true;
        resolve({ result: this.result, endTurn: !this.result && endTurn });
      };
      this.waiters.add(finish);
      if (waitMs === 0) finish(onTimeout === 'end_turn');
      else if (Number.isFinite(waitMs)) timer = setTimeout(() => finish(onTimeout === 'end_turn'), waitMs);
    });
  }

  /** Operator rescue: end only the observation/turn, never the script. */
  release(): number {
    const count = this.waiters.size;
    for (const finish of [...this.waiters]) finish(true);
    return count;
  }
}
