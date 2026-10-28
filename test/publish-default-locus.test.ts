/**
 * `channel_publish` without a channelId goes where the turn's plain speech
 * would: the frozen turn locus (the waking delivery, or a channel opened
 * this turn). First live run, 2026-10-12: under `speech.locus: 'delivery'`
 * the registry's own default is null, and the tool failed on the very turn
 * a delivery on that channel woke the agent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { registerOpen, incoming, MENTION } from './helpers/admission.js';

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), what);
};
const publishOf = (f: { published: Array<Record<string, unknown>> }, text: string) =>
  f.published.find((p) => JSON.stringify(p.content).includes(text));

describe('channel_publish without channelId', () => {
  it('an empty channelId is refused as empty, not read as left out', async () => {
    const f = await fixture();
    try {
      await registerOpen(f, 'work');
      f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'p1', name: 'channel_publish', input: { channelId: '', content: 'zz-empty' } }], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      await eventually(() => !!publishOf(f, 'done') || !!publishOf(f, 'zz-empty'), 'the turn spoke');
      assert.equal(publishOf(f, 'zz-empty'), undefined, 'nothing was posted for an empty channelId');
      const answered = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .some((m) => JSON.stringify(m.content).includes('Nothing was posted: channelId is empty.'));
      assert.ok(answered, 'the refusal says the channelId is empty');
    } finally { await f.close(); }
  });

  it("a call made outside the turn takes none of the turn's channels: after a turn woken in work it's refused, and under a focus it goes to the excepted channel", async () => {
    const f = await fixture({ framework: { tuneOut: { enabled: true } } as never });
    try {
      await registerOpen(f, 'work', 'other');
      const before = await f.framework.executeToolCall({ id: 'p0', name: 'channel_publish', input: { content: 'zz-script-0' }, callerAgentName: 'agent' } as never);
      assert.equal(before.success, false, 'with no turn yet, refused');
      f.alwaysRespond();
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      const kept = (f.framework as unknown as { turnRouting: Map<string, { locus?: { channelId: string } | null }> }).turnRouting.get('agent');
      assert.equal(kept?.locus?.channelId, 'work', "premise: the agent's latest routing still names work");
      const result = await f.framework.executeToolCall({ id: 'p1', name: 'channel_publish', input: { content: 'zz-script' }, callerAgentName: 'agent' } as never);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /no channel to default to/);
      assert.equal(publishOf(f, 'zz-script'), undefined, 'nothing was posted');
      const coordinator = (f.framework as unknown as { tuneOutCoordinator: { enterAllExcept(ref: unknown, opts: unknown, source: string): { ok: boolean } } }).tuneOutCoordinator;
      assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'other' }, { durationSeconds: 120 }, 'agent-tool').ok, 'premise: a focus on other');
      const again = await f.framework.executeToolCall({ id: 'p2', name: 'channel_publish', input: { content: 'zz-script-2' }, callerAgentName: 'agent' } as never);
      assert.ok(again.success, again.error);
      await eventually(() => !!publishOf(f, 'zz-script-2'), 'the second call posted');
      assert.equal(publishOf(f, 'zz-script-2')!.channelId, 'other', 'the registry default: the excepted channel');
    } finally { await f.close(); }
  });

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
