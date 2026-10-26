/**
 * Child process for the deferred-write crash-recovery regressions
 * (host-quiesce.test.ts). It stages a host with deferred writes and then
 * HARD-EXITS (process.exit, no stop(), no sync) at the point named by
 * argv[3]. Exit code 0 means the intended exit point was hit; anything else
 * means the scenario could not be staged.
 *
 *   after-ack      quiesce, defer ACKED-BUT-NOT-SYNCED + STILL-PENDING, sync,
 *                  resume(); exit right after the first durable ack of the
 *                  resume flush completed.
 *   before-sync    same staging; exit inside the first chronicle sync() of
 *                  the resume flush (appended in memory, nothing on disk).
 *   turn-start-ack quiesce, defer ONCE-ONLY, sync; resume while the target
 *                  holds a turn token (message kept for its own boundary);
 *                  release the token and drive an ORDINARY wake; exit after
 *                  the turn-start flush's ack synced the chronicle but
 *                  before it rewrote the recovery queue.
 *   redefer        hanging turn; quiesce({abandon}); defer REDEFER-FIRST and
 *                  REDEFER-SECOND while quiesced; the abandonment teardown
 *                  drains and re-defers them; exit at the FIRST re-deferral's
 *                  recovery-file write (queue split across un-acked/pending).
 *   big-batch      quiesce; defer 2,101 small messages (larger than any fixed
 *                  scan tail); sync; resume(); exit after the batch's
 *                  chronicle sync but BEFORE the queue rewrite that acks it.
 *
 * argv[2] = store path.
 */
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../../src/index.js';
import { MockMembrane, createMockResponse } from './mock-membrane.js';

const MODES = ['after-ack', 'before-sync', 'turn-start-ack', 'redefer', 'big-batch'] as const;
type Mode = typeof MODES[number];
const [storePath, modeArg] = process.argv.slice(2);
if (!storePath || !MODES.includes(modeArg as Mode)) {
  console.error(`usage: quiesce-crash-child <storePath> ${MODES.join('|')}`);
  process.exit(2);
}
const mode = modeArg as Mode;

class HangingStream implements YieldingStream {
  private pendingResolve: (() => void) | null = null;
  private aborted = false;
  cancel(): void { this.aborted = true; this.pendingResolve?.(); }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.aborted) await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
  }
}
class HangingMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new HangingStream();
  }
}

const membrane = mode === 'redefer' ? new HangingMembrane() : new MockMembrane();
const framework = await AgentFramework.create({
  storePath,
  membrane: membrane.asMembrane(),
  agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
  modules: [],
});
const internals = framework as unknown as {
  addMessage(p: string, c: unknown[]): unknown;
  store: { sync(): void };
  persistDeferredWrites(): void;
  activeTurnTokens: Map<string, number>;
};
const say = (text: string) => internals.addMessage('user', [{ type: 'text', text }]);
const waitFor = async (pred: () => boolean): Promise<void> => {
  while (!pred()) await new Promise((r) => setTimeout(r, 20));
};
const realPersist = internals.persistDeferredWrites.bind(framework);
const exitAfterNextPersist = (): void => {
  let armed = true;
  internals.persistDeferredWrites = () => {
    realPersist();
    if (armed) { armed = false; process.exit(0); }
  };
};
/** Exit at the START of the n-th persist from now (before it rewrites anything). */
const exitBeforePersist = (n: number): void => {
  let seen = 0;
  internals.persistDeferredWrites = () => {
    seen++;
    if (seen === n) process.exit(0);
    realPersist();
  };
};

if (mode === 'after-ack' || mode === 'before-sync') {
  await framework.quiesce({ reason: 'crash probe' });
  say('ACKED-BUT-NOT-SYNCED');
  say('STILL-PENDING');
  if (framework.getHostModeStatus().deferredWrites !== 2) process.exit(3);
  internals.store.sync();
  if (mode === 'after-ack') {
    exitAfterNextPersist();
  } else {
    const realSync = internals.store.sync.bind(internals.store);
    let armed = true;
    internals.store.sync = () => {
      if (armed) { armed = false; process.exit(0); }
      realSync();
    };
  }
  await framework.resume();
  process.exit(4);
}

if (mode === 'turn-start-ack') {
  await framework.quiesce({ reason: 'crash probe' });
  say('ONCE-ONLY');
  internals.store.sync();
  // The target "holds a turn" across resume: its message is kept for its
  // own boundary, the durable queue still lists it, the flag is cleared.
  internals.activeTurnTokens.set('agent', 1);
  await framework.resume();
  if (framework.getHostModeStatus().deferredWrites !== 1) process.exit(3);
  internals.activeTurnTokens.delete('agent');
  // An ORDINARY wake: the turn-start flush writes ONCE-ONLY, then acks
  // (sync, then queue rewrite). Exit between the two.
  exitAfterNextPersist();
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok' }]));
  framework.start();
  framework.nudgeAgent('agent', 'operator');
  await framework.runUntilIdle();
  process.exit(4);
}

if (mode === 'redefer') {
  framework.start();
  framework.nudgeAgent('agent', 'operator');
  await waitFor(() => membrane.calls.length === 1);
  const quiescing = framework.quiesce({ timeoutMs: 1_000, abandon: true });
  await waitFor(() => framework.getHostModeStatus().quiesced);
  say('REDEFER-FIRST'); // deferred (quiesced) and persisted
  say('REDEFER-SECOND');
  if (framework.getHostModeStatus().deferredWrites !== 2) process.exit(3);
  // The abandonment teardown drains both (→ un-acked; the hand-off persists
  // a receipt), tries to write them, and — still quiesced — re-defers each.
  // Exit at the FIRST re-deferral's recovery-file write: at that instant
  // FIRST is pending and SECOND still un-acked, the case that used to be
  // written out of order.
  // Exit right after the first recovery-file write made while the batch is
  // SPLIT — one entry re-deferred (pending) while the other is still
  // un-acked. That is the write whose order used to be wrong, whatever the
  // number of persists that precede it.
  const split = internals as unknown as { unackedDeferredWrites: unknown[]; deferredMessages: unknown[] };
  internals.persistDeferredWrites = () => {
    realPersist();
    if (split.unackedDeferredWrites.length > 0 && split.deferredMessages.length > 0) process.exit(0);
  };
  await quiescing;
  await new Promise(() => {});
}

if (mode === 'big-batch') {
  const N = 2_101;
  await framework.quiesce({ reason: 'crash probe' });
  // Stage the queue without 2,101 growing rewrites of the recovery file.
  internals.persistDeferredWrites = () => {};
  for (let i = 0; i < N; i++) say(`BIG-${i}`);
  internals.persistDeferredWrites = realPersist;
  realPersist();
  if (framework.getHostModeStatus().deferredWrites !== N) process.exit(3);
  internals.store.sync();
  // Resume flush: persist #1 = hand-off receipt (before any write),
  // persist #2 = the ack after the batch's chronicle sync. Exit at the start
  // of #2: everything is in the synced store, nothing is acked.
  exitBeforePersist(2);
  await framework.resume();
  process.exit(4);
}
