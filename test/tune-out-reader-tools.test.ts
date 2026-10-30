/**
 * What a reader fork can do with channel speech off (docs/dendrite.md,
 * "What a reader fork can do"): its own three tools; every other tool the
 * resident has — speak_in_channel among them — stays in the block it is
 * shown, the shared prefix, and is refused at dispatch, so the fork can
 * post nowhere (connectome-host#334, scout's condition).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, rig, publishCall, speakCall, toolNames } from './helpers/reader-fork-rig.js';
import { createMockResponse } from './helpers/mock-membrane.js';

describe('reader forks with channel speech off', () => {
  const r = rig('speech-off', false);

  it("the resident's tools stay in the fork's block and are refused at dispatch; nothing is published", async () => {
    const before = await r.tuneOut();
    // The fork tries the resident's publish tool, then speak_in_channel, then reports.
    r.state.membrane.push('reader', publishCall('c1'), speakCall('c2'), createMockResponse([{ type: 'text', text: 'nothing urgent' }]));
    // The fork's report wakes scout the moment the fork ends, so scout's reply is queued now, not after.
    r.state.membrane.push('resident', createMockResponse([{ type: 'text', text: 'thanks' }]));
    r.emit('addressed', 'm1', 'hey scout, quick question');
    await r.waitFor(() => r.forkTraces().length >= 1, 'a reader fork is derived');
    const fork = r.forkTraces()[0]!.agentName;
    await r.waitFor(() => r.refusals().length >= 2, 'both calls are refused at dispatch');
    assert.deepEqual(
      r.refusals().map((t) => [t.tool, t.error]),
      [['channel_publish', `channel_publish is not available to ${fork}`], ['speak_in_channel', `speak_in_channel is not available to ${fork}`]],
    );
    await r.waitFor(() => r.state.framework!.getAgentRecord(fork)?.ended !== undefined, 'the fork ends');
    const readerRequest = r.state.membrane.calls.find((c) => JSON.stringify(c.messages).includes('[Tune-out reader'))!;
    assert.ok(toolNames(readerRequest).includes('channel_publish'), 'still advertised: the block is the resident\'s, for the shared prefix');
    assert.equal(r.published().length - before, 0, 'nothing of the fork\'s reached the channel');
    // Its report still goes to scout.
    await r.waitFor(() => r.state.framework!.getAgent('scout')!.getContextManager().getAllMessages().some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-result'), 'the report reaches scout');
    await r.state.framework!.runUntilIdle();
  });
});

