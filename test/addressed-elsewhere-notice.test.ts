/**
 * The addressed-elsewhere notice (docs/dendrite.md, `speech.locus:
 * 'delivery'`): one per channel per turn, and a notice whose store failed is
 * still owed to the next message from that channel in the turn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';

type Channel = { serverId: string; channelId: string };

describe('the addressed-elsewhere notice', () => {
  it('is stored once per channel per turn, and one whose store failed is still owed', async () => {
    const f = await fixture();
    try {
      const fw = f.framework as unknown as {
        routingOf(agentName: string): unknown;
        addressedElsewhereNotice(agent: unknown, routing: unknown, channel: Channel, who: string): unknown;
      };
      const agent = f.framework.getAgent('agent')!;
      const cm = agent.getContextManager() as unknown as { addMessage(...args: unknown[]): string };
      const add = cm.addMessage.bind(cm);
      let refuse = 1;
      cm.addMessage = (...args: unknown[]) => {
        if (refuse > 0) { refuse -= 1; throw new Error('store refused'); }
        return add(...args);
      };
      const routing = fw.routingOf('agent');
      const dm = { serverId: 'editor', channelId: 'dm:antra' };
      const other = { serverId: 'editor', channelId: 'general' };
      const notice = (channel: Channel) => fw.addressedElsewhereNotice(agent, routing, channel, 'antra');

      assert.equal(notice(dm), undefined, 'the first store was refused, so nothing was stored');
      assert.ok(notice(dm), "the next message from that channel still gets the turn's notice");
      assert.equal(notice(dm), undefined, 'and only once in the turn');
      assert.ok(notice(other), 'another channel gets its own');
    } finally { await f.close(); }
  });

  it('one whose write threw after it landed is the turn\'s notice for that channel, and is not stored twice', async () => {
    const f = await fixture();
    try {
      const fw = f.framework as unknown as {
        routingOf(agentName: string): unknown;
        addressedElsewhereNotice(agent: unknown, routing: unknown, channel: Channel, who: string): unknown;
      };
      const agent = f.framework.getAgent('agent')!;
      const cm = agent.getContextManager() as unknown as { addMessage(...args: unknown[]): string };
      const add = cm.addMessage.bind(cm);
      let landThenThrow = 1;
      cm.addMessage = (...args: unknown[]) => {
        const id = add(...args);
        if (landThenThrow > 0) { landThenThrow -= 1; throw new Error('propagation failed after the row landed'); }
        return id;
      };
      const routing = fw.routingOf('agent');
      const dm = { serverId: 'editor', channelId: 'dm:antra' };
      assert.ok(fw.addressedElsewhereNotice(agent, routing, dm, 'antra'), 'the notice landed, so it is returned');
      assert.equal(fw.addressedElsewhereNotice(agent, routing, dm, 'antra'), undefined, 'and is the turn\'s one for that channel');
      const notices = agent.getContextManager().getAllMessages()
        .filter((m) => JSON.stringify(m.content).includes('addressed you from'));
      assert.equal(notices.length, 1, 'stored once');
    } finally { await f.close(); }
  });
});
