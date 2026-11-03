/**
 * What a reader fork can do with channel speech on: speak_in_channel is
 * its, and goes out through the resident's publish path — the channel sees
 * the post under the resident's account, in the fork's words; the
 * resident's own channel_publish is still refused at dispatch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, rig, publishCall, speakCall } from './helpers/reader-fork-rig.js';
import { createMockResponse } from './helpers/mock-membrane.js';

describe('reader forks with channel speech on', () => {
  const r = rig('speech-on', true);

  it("speak_in_channel is the fork's and goes out through the resident's publish path; channel_publish is still refused", async () => {
    const before = await r.tuneOut();
    r.state.membrane.push('reader', publishCall('c1'), speakCall('c2'), createMockResponse([{ type: 'text', text: 'said my piece' }]));
    // The fork's report wakes scout the moment the fork ends, so scout's reply is queued now, not after.
    r.state.membrane.push('resident', createMockResponse([{ type: 'text', text: 'thanks' }]));
    r.emit('addressed', 'm1', 'hey scout, quick question');
    await r.waitFor(() => r.forkTraces().length >= 1, 'a reader fork is derived');
    const fork = r.forkTraces()[0]!.agentName;
    await r.waitFor(() => r.published().length > before, 'the post reaches the channel');
    assert.deepEqual(r.refusals().map((t) => t.tool), ['channel_publish']);
    assert.equal(r.published().length - before, 1);
    assert.equal(r.published().at(-1)!.channelId, CHANNEL);
    await r.waitFor(() => r.state.framework!.getAgentRecord(fork)?.ended !== undefined, 'the fork ends');
    await r.state.framework!.runUntilIdle();
  });
});
