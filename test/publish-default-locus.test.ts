/**
 * `channel_publish` without a channelId goes where the turn's plain speech
 * would: the frozen turn locus (the waking delivery, or a channel opened
 * this turn). First live run, 2026-10-12: under `speech.locus: 'delivery'`
 * the registry's own default is null, and the tool failed on the very turn
 * a delivery on that channel woke the agent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { registerOpen, incoming, MENTION } from './helpers/admission.js';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), what);
};
const publishOf = (f: { published: Array<Record<string, unknown>> }, text: string) =>
  f.published.find((p) => JSON.stringify(p.content).includes(text));

describe('channel_publish without channelId', () => {
  it('defaults to the turn locus: the waking delivery, then a channel opened this turn', async () => {
    const f = await fixture();
    try {
      await registerOpen(f, 'work', 'other');
      f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'on my way' } }], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: 'other' } },
      ], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p2', name: 'channel_publish', input: { content: 'and here' } }], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await until(() => !!publishOf(f, 'and here'), 'both publishes landed');
      assert.equal(publishOf(f, 'on my way')!.channelId, 'work', 'the waking delivery\'s channel');
      assert.equal(publishOf(f, 'and here')!.channelId, 'other', 'the channel opened this turn');
    } finally { await f.close(); }
  });
});
