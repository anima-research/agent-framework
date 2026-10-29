/**
 * A reader fork's `deliver_summary` counts as its report only once the mail
 * is held. If the delivery throws, the fork gets an error result and is not
 * marked as having reported, so its final prose is still delivered as its
 * report when it ends (#546, probe R14). Before, it was marked first, and a
 * failed mail write lost both the summary and the prose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

const CHANNEL = 'disc:guild:noisy';
const READER = 'reader/scout/e1/1';

function coordinatorWith(deliver: () => void) {
  const registry = {
    nameShown: (ref: { channelId: string }) => ref.channelId,
    ownChannelFor: () => null,
    sharedNameRefusalFor: () => undefined,
    channelsNamed: (id: string) => [{ serverId: 'disc', channelId: id }],
    readCoordinatorState: () => null,
  } as unknown as ChannelRegistry;
  const hooks = {
    subconsciousName: () => null,
    invokeReader: () => {},
    deliverFromReader: deliver,
    primaryName: () => 'scout',
    emitTrace: () => {},
  } as unknown as TuneOutFrameworkHooks;
  return new TuneOutCoordinator(registry, {} as McplServerRegistry, hooks);
}

const summary = { text: 'two people asked about the build', channelId: CHANNEL };

describe("a reader fork's deliver_summary", () => {
  it('marks the fork as having reported once the mail is held', async () => {
    const delivered: unknown[] = [];
    const c = coordinatorWith(() => { delivered.push(1); });
    const result = await c.handleSubconsciousTool('deliver_summary', summary, [], READER);
    assert.equal(result.success, true);
    assert.equal(delivered.length, 1);
    assert.equal(c.readerReported(READER), true, 'so its trailing prose is not a second report');
  });

  it('does not mark it when the delivery throws, so its prose is still its report', async () => {
    const c = coordinatorWith(() => { throw new Error('durable mail write failed'); });
    await assert.rejects(c.handleSubconsciousTool('deliver_summary', summary, [], READER), /durable mail write failed/,
      'the fork gets the failure as its tool result');
    assert.equal(c.readerReported(READER), false, 'not reported: the framework delivers its final prose instead');
  });
});
