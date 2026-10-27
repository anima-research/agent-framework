/**
 * A count of the scheduler's passes over the queued requests, for a negative
 * check that has to know a pass has looked at a request before it asserts
 * what that pass didn't do.
 */

import type { AgentFramework } from '../../src/index.js';

/**
 * Wraps the framework's `processInferenceRequests` and returns a wait that
 * ends once a pass that began after it was called has completed, by the
 * caller's own `waitFor`, so its bound is the test file's.
 *
 * A pass is done with each request it took when it completes, and a turn it
 * starts has asked the membrane for its stream by then, unless an auxiliary
 * call holds the agent's provider gate as it starts. A test that relies on
 * this has no auxiliary call in flight at the passes it waits for. A pass
 * that throws doesn't count, since it may have stopped before the request a
 * test waits on.
 */
export function schedulerPasses(
  framework: AgentFramework,
  waitFor: (what: string, cond: () => boolean) => Promise<void>,
): () => Promise<void> {
  const owner = framework as unknown as { processInferenceRequests: () => Promise<void> };
  const pass = owner.processInferenceRequests.bind(framework);
  let begun = 0;
  let completed = 0;
  owner.processInferenceRequests = async () => {
    const n = ++begun;
    await pass();
    completed = Math.max(completed, n);
  };
  return () => {
    const after = begun + 1;
    return waitFor('a scheduler pass to complete', () => completed >= after);
  };
}
