/**
 * GateOptions.messageQuietPeriod: a burst of messages (a caption and its
 * images, a reply split across several Discord messages) wakes the agent once,
 * after its channel goes quiet — not once per message.
 *
 * The held wake goes the way a `debounce` policy's batch does (#179's review):
 *   - an agent mid-turn when the hold ends gets the wake after the turn, not
 *     never (bufferForInference, flushed at onInferenceEnded);
 *   - the wake carries the burst's route (routeChannelId), so a held DM's
 *     reply goes back to the DM;
 *   - holds are per channel; dispose() ends them; sleep drops them; the
 *     heartbeat is never held; maxWaitMs is the operator's cap even below
 *     quietMs; a part the policies didn't trigger extends an open hold.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';
import type { WakeProvenance } from '../src/gate/event-gate.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const TMP = join(import.meta.dirname, '../.test-tmp-gate-quiet');

type Wake = { agent: string; reason: string; provenance?: WakeProvenance };

function makeGate(
  quiet?: { quietMs: number; maxWaitMs?: number },
  extra: { config?: GateConfig; resolveRouteChannel?: (info: GateEventInfo) => string | undefined } = {},
) {
  mkdirSync(TMP, { recursive: true });
  const wakes: Wake[] = [];
  const messages: unknown[] = [];
  const gate = new EventGate({
    configPath: join(TMP, `gate-${Math.random().toString(36).slice(2)}.json`),
    initialConfig: extra.config ?? { default: 'always', policies: [] },
    emitTrace: () => {},
    addMessage: (...args) => { messages.push(args); return ''; },
    requestInference: (agent, reason, _source, provenance) => wakes.push({ agent, reason, provenance }),
    getAgentNames: () => ['agent'],
    ...(quiet ? { messageQuietPeriod: quiet } : {}),
    ...(extra.resolveRouteChannel ? { resolveRouteChannel: extra.resolveRouteChannel } : {}),
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

  it('holds a burst and wakes once after the channel goes quiet, with no line in context', async () => {
    const { gate, wakes, messages } = makeGate({ quietMs: 60 });
    const first = gate.evaluate(msg('caption'));
    assert.equal(first.trigger, false);
    assert.equal(first.quietHeld, true);
    await sleep(20);
    assert.equal(gate.evaluate(msg('image 1')).trigger, false);
    await sleep(20);
    assert.equal(gate.evaluate(msg('image 2')).trigger, false);
    assert.equal(wakes.length, 0, 'no wake while messages keep arriving');
    await sleep(90);
    assert.equal(wakes.length, 1, 'one wake for the whole burst');
    assert.equal(wakes[0].reason, 'gate:quiet-period');
    assert.equal(wakes[0].provenance?.channelId, 'discord:g:salon');
    assert.equal(messages.length, 0, 'no batch summary is added to context');
    gate.dispose();
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
    gate.dispose();
  });

  it('a maxWaitMs below quietMs is the cap, not raised to quietMs', async () => {
    const { gate, wakes } = makeGate({ quietMs: 300, maxWaitMs: 40 });
    gate.evaluate(msg('one'));
    await sleep(100);
    assert.equal(wakes.length, 1, 'the hold ended at maxWaitMs');
    gate.dispose();
  });

  it('an agent mid-turn when the hold ends gets the wake after its turn', async () => {
    const { gate, wakes } = makeGate({ quietMs: 40 });
    gate.evaluate(msg('arrives during a turn'));
    gate.onInferenceStarted('agent');
    await sleep(70);
    assert.equal(wakes.length, 0, 'nothing wakes a turn in flight');
    gate.onInferenceEnded('agent');
    await sleep(10); // the flush runs in a microtask
    assert.equal(wakes.length, 1, 'the held wake follows the turn');
    assert.equal(wakes[0].reason, 'gate:quiet-period');
    assert.equal(wakes[0].provenance?.channelId, 'discord:g:salon');
    gate.dispose();
  });

  it('a quiesced host gets the held wake at resume', async () => {
    const { gate, wakes } = makeGate({ quietMs: 30 });
    gate.setQuiesced(true);
    gate.evaluate(msg('while quiesced'));
    await sleep(60);
    assert.equal(wakes.length, 0, 'held through the quiesce');
    gate.setQuiesced(false);
    await sleep(10);
    assert.equal(wakes.length, 1, 'delivered at resume');
    gate.dispose();
  });

  it("a held addressed message's wake carries its route, so a DM's reply goes back to the DM", async () => {
    const { gate, wakes } = makeGate({ quietMs: 30 }, {
      resolveRouteChannel: (info) => (info.channelId === 'raw-dm' ? 'discord:dm:u1' : undefined),
    });
    gate.evaluate(msg('hello?', { channelId: 'raw-dm', tags: ['chat:addressed'] }));
    await sleep(60);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].provenance?.routeChannelId, 'discord:dm:u1');
    assert.equal(wakes[0].provenance?.routeServerId, 'discord');
    assert.equal(wakes[0].provenance?.addressed, true);
    gate.dispose();
  });

  it("holds are per channel: chatter in one channel doesn't delay another's wake", async () => {
    const { gate, wakes } = makeGate({ quietMs: 60, maxWaitMs: 1000 });
    gate.evaluate(msg('dm', { channelId: 'discord:dm:u2', tags: ['chat:addressed'] }));
    const start = Date.now();
    // The salon keeps talking past the DM's quiet period.
    while (Date.now() - start < 150) {
      gate.evaluate(msg('salon chatter'));
      await sleep(20);
    }
    assert.ok(wakes.length >= 1, "the DM's wake came while the salon was still talking");
    assert.equal(wakes[0].provenance?.channelId, 'discord:dm:u2');
    await sleep(120);
    assert.equal(wakes.length, 2, "then the salon's, once it went quiet");
    assert.equal(wakes[1].provenance?.channelId, 'discord:g:salon');
    gate.dispose();
  });

  it('a part the policies did not trigger extends an open hold but opens none', async () => {
    // One token, slow refill: the caption triggers, the image is denied.
    const config: GateConfig = {
      default: 'always',
      policies: [{ name: 'one-per-window', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 60_000 } } }],
    };
    const { gate, wakes } = makeGate({ quietMs: 60 }, { config });
    const caption = gate.evaluate(msg('caption'));
    assert.equal(caption.quietHeld, true);
    await sleep(40);
    const image = gate.evaluate(msg('image'));
    assert.equal(image.trigger, false);
    assert.notEqual(image.quietHeld, true, 'a denied part is not a held wake of its own');
    await sleep(35); // 75 ms after the caption: past its own quietMs, within the image's
    assert.equal(wakes.length, 0, 'the image extended the hold');
    await sleep(40);
    assert.equal(wakes.length, 1, 'one wake once the burst is quiet');
    gate.dispose();

    const alone = makeGate({ quietMs: 30 }, { config });
    alone.gate.evaluate(msg('a'));
    await sleep(60);
    assert.equal(alone.wakes.length, 1);
    alone.gate.evaluate(msg('denied, no hold open'));
    await sleep(60);
    assert.equal(alone.wakes.length, 1, 'a denied message opens no hold');
    alone.gate.dispose();
  });

  it('the heartbeat is not held', () => {
    const { gate } = makeGate({ quietMs: 60 });
    const tick = gate.evaluate(msg('tick', { eventType: 'mcpl:push-event', serverId: 'heartbeat', channelId: '' }));
    assert.equal(tick.trigger, true);
    assert.notEqual(tick.quietHeld, true);
    gate.dispose();
  });

  it('an agent asleep when the hold ends gets no wake', async () => {
    const { gate, wakes } = makeGate({ quietMs: 30 });
    gate.evaluate(msg('before sleep'));
    gate.setSleep(10, 'resting', 'agent');
    await sleep(60);
    assert.equal(wakes.length, 0, 'sleep suppresses the held wake as it would the message\'s own');
    assert.equal(gate.getSleepState()?.suppressed, 1);
    gate.clearSleep();
    gate.dispose();
  });

  it('dispose() ends a pending hold', async () => {
    const { gate, wakes } = makeGate({ quietMs: 30 });
    gate.evaluate(msg('held'));
    gate.dispose();
    await sleep(60);
    assert.equal(wakes.length, 0, 'no wake reaches a disposed gate');
  });

  it('does not delay non-message wakes, and is off by default', () => {
    const { gate } = makeGate({ quietMs: 60 });
    assert.equal(gate.evaluate(msg('tick', { eventType: 'external-message' })).trigger, true);
    gate.dispose();
    const plain = makeGate();
    assert.equal(plain.gate.evaluate(msg('hello')).trigger, true);
    plain.gate.dispose();
  });

  it('the framework passes gate.messageQuietPeriod through to its gate', async () => {
    mkdirSync(TMP, { recursive: true });
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath: join(TMP, 'store-passthrough'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
      gate: {
        config: { policies: [], default: 'always' },
        configPath: join(TMP, 'gate-passthrough.json'),
        messageQuietPeriod: { quietMs: 40 },
      },
      modules: [],
    });
    const gate = (framework as unknown as { eventGate: EventGate }).eventGate;
    try {
      const held = gate.evaluate(msg('through the framework'));
      assert.equal(held.quietHeld, true, 'the option reached the gate');
    } finally {
      gate.dispose();
      await framework.stop();
    }
  });
});
