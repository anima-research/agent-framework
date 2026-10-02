/**
 * GateOptions.messageQuietPeriod: a burst of messages (a caption and its
 * images, a reply split across several Discord messages) wakes the agent once,
 * after the senders go quiet — not once per message.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateEventInfo } from '../src/gate/types.js';

const TMP = join(import.meta.dirname, '../.test-tmp-gate-quiet');

function makeGate(quiet?: { quietMs: number; maxWaitMs?: number }) {
  mkdirSync(TMP, { recursive: true });
  const wakes: Array<{ reason: string; channelId?: string }> = [];
  const messages: unknown[] = [];
  const gate = new EventGate({
    configPath: join(TMP, `gate-${Math.random().toString(36).slice(2)}.json`),
    initialConfig: { default: 'always', policies: [] },
    emitTrace: () => {},
    addMessage: (...args) => { messages.push(args); return ''; },
    requestInference: (_agent, reason, _source, provenance) => wakes.push({ reason, channelId: provenance?.channelId }),
    getAgentNames: () => ['agent'],
    ...(quiet ? { messageQuietPeriod: quiet } : {}),
  });
  return { gate, wakes, messages };
}

const msg = (text: string, extra: Partial<GateEventInfo> = {}): GateEventInfo => ({
  content: text,
  eventType: 'mcpl:channel-incoming',
  serverId: 'discord',
  channelId: 'discord:g:salon',
  metadata: { authorId: 'u1' },
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('message quiet period', () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('holds a burst and wakes once after the senders go quiet', async () => {
    const { gate, wakes, messages } = makeGate({ quietMs: 60 });
    assert.equal(gate.evaluate(msg('caption')).trigger, false);
    await sleep(20);
    assert.equal(gate.evaluate(msg('image 1')).trigger, false);
    await sleep(20);
    assert.equal(gate.evaluate(msg('image 2')).trigger, false);
    assert.equal(wakes.length, 0, 'no wake while messages keep arriving');
    await sleep(90);
    assert.equal(wakes.length, 1, 'one wake for the whole burst');
    assert.equal(wakes[0].reason, 'gate:quiet-period');
    assert.equal(wakes[0].channelId, 'discord:g:salon');
    assert.equal(messages.length, 0, 'no batch summary is added to context');
  });

  it('caps the hold at maxWaitMs under a continuous stream', async () => {
    const { gate, wakes } = makeGate({ quietMs: 50, maxWaitMs: 120 });
    const start = Date.now();
    while (Date.now() - start < 200) {
      gate.evaluate(msg('chatter'));
      await sleep(25);
      if (wakes.length > 0) break;
    }
    assert.equal(wakes.length, 1, 'woke despite continuous messages');
    assert.ok(Date.now() - start < 190, 'within roughly the cap');
  });

  it('does not re-wake an agent that is already mid-turn when the hold ends', async () => {
    const { gate, wakes } = makeGate({ quietMs: 40 });
    gate.evaluate(msg('arrives during a turn'));
    gate.onInferenceStarted('agent');
    await sleep(70);
    assert.equal(wakes.length, 0);
    gate.onInferenceEnded('agent');
  });

  it('does not delay non-message wakes, and is off by default', () => {
    const { gate } = makeGate({ quietMs: 60 });
    assert.equal(gate.evaluate(msg('tick', { eventType: 'external-message' })).trigger, true);
    const plain = makeGate();
    assert.equal(plain.gate.evaluate(msg('hello')).trigger, true);
  });
});
