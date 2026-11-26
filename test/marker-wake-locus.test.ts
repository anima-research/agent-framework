import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/index.js';
import { HeldStream, MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { AMBIENT, MENTION, incoming, internals as fixtureInternals, registerOpen } from './helpers/admission.js';

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const serverError = () => new MembraneError({
  type: 'server', retryable: true, httpStatus: 502, message: 'zz server failure', rawError: undefined,
} as never);
const statedWait = () => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 20 * 60_000,
  message: 'zz rate limit reached for requests', rawError: { status: 429 },
} as never);

class ScriptedMembrane extends MockMembrane {
  constructor(private readonly failures: Array<() => Error>) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const fail = this.failures.shift();
    if (fail) return new ErrorStream(fail());
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-reply' }])]);
  }
}

type Internals = {
  pendingRequests: InferenceRequest[];
  processInferenceRequests(): Promise<void>;
  startAgentStream(agent: unknown, trigger?: InferenceRequest, attempt?: number): Promise<unknown>;
  handleMcplChannelIncoming(event: Record<string, unknown>): Promise<unknown>;
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const MARKER_TAGS = ['chat:edited', 'chat:deleted', 'chat:reaction', 'chat:reaction-remove'] as const;

async function resident(t: TestContext, failures: Array<() => Error> = [], names: string[] = ['scout']) {
  const dir = mkdtempSync(join(tmpdir(), 'marker-wake-locus-'));
  const membrane = new ScriptedMembrane(failures);
  const fw = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: names.map((name) => ({ name, model: 'test-model', systemPrompt: `You are ${name}.` })),
    modules: [],
    errorPolicy: {
      maxRetries: 2,
      onInferenceError: (error, _agent, attempt) =>
        (error as { retryable?: boolean }).retryable !== false && attempt < 2 ? { retry: true, delayMs: 5 } : { retry: false },
    },
    exhaustedTurnRearmMs: [60_000],
  });
  t.after(async () => {
    await fw.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const i = fw as unknown as Internals;
  const starts: InferenceRequest[] = [];
  const start = i.startAgentStream.bind(fw);
  i.startAgentStream = async (agent, trigger, attempt) => {
    if (trigger && !attempt) starts.push(trigger);
    return start(agent, trigger, attempt);
  };
  let n = 0;
  const arrive = (channelId: string, tags: readonly string[], extra: Record<string, unknown> = {}) => i.handleMcplChannelIncoming({
    type: 'mcpl:channel-incoming', serverId: 'zulip', channelId, messageId: `m-${++n}`,
    author: { id: `u-${n}`, name: 'someone' }, content: [{ type: 'text', text: `zz-${channelId} ${n}` }],
    timestamp: new Date().toISOString(), metadata: {}, tags: [...tags], triggerInference: true, ...extra,
  });
  const queue = (request: Omit<InferenceRequest, 'agentName' | 'timestamp'> & { agentName?: string; timestamp?: number }) =>
    i.pendingRequests.push({ agentName: 'scout', timestamp: Date.now(), ...request });
  const parked = (agentName: string) => i.pendingRequests.filter((p) => p.agentName === agentName).length;
  const held = (agentName = 'scout') => (fw.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { heldRequests: number } }> })
    .agents.find((a) => a.name === agentName)!.providerAdmission.heldRequests;
  const release = async (agentName = 'scout') => {
    const released = await i.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName, model: 'test-model', requesterName: 'zz-operator' });
    assert.equal(released.ok, true, 'premise: the operator released the wait');
  };
  return { fw, starts, arrive, queue, parked, held, release, run: () => fw.runUntilIdle(), pass: () => i.processInferenceRequests() };
}

describe("a marker's wake and the turn's channel", () => {
  for (const tag of MARKER_TAGS) {
    it(`an ambient message on A, then a ${tag} marker on B that does not address the agent, in one batch: the turn's channel is A`, async (t) => {
      const r = await resident(t);
      await r.arrive('stream:A', ['chat:ambient']);
      await r.arrive('stream:B', ['chat:ambient', tag]);
      await r.run();
      assert.equal(r.starts.length, 1, 'premise: one turn, from one batch');
      assert.equal(r.starts[0]!.channelId, 'stream:A');
      assert.equal(r.starts[0]!.channelServerId, 'zulip');
    });
  }

  it("a marker alone names the turn's channel, as before", async (t) => {
    const r = await resident(t);
    await r.arrive('stream:B', ['chat:ambient', 'chat:edited']);
    await r.run();
    assert.equal(r.starts[0]!.channelId, 'stream:B');
  });

  it("an edit the host delivers as the agent's first view of its message is that message: it takes the channel as a newer message does", async (t) => {
    const r = await resident(t);
    await r.arrive('stream:A', ['chat:ambient']);
    await r.arrive('stream:B', ['chat:ambient', 'chat:edited'], { firstView: true });
    await r.run();
    assert.equal(r.starts[0]!.channelId, 'stream:B');
  });

  it('an edit that addresses the agent ranks as an addressed message: a newer ambient message does not take the channel from it', async (t) => {
    const r = await resident(t);
    await r.arrive('stream:B', ['chat:edited', 'chat:mention', 'chat:addressed']);
    await r.arrive('stream:A', ['chat:ambient']);
    await r.run();
    assert.equal(r.starts[0]!.channelId, 'stream:B');
  });

  it("an autoContinue wake's channel outranks a newer marker's", async (t) => {
    const r = await resident(t);
    r.queue({ reason: 'auto-continue', source: 'framework', channelId: 'stream:A', channelServerId: 'zulip', autoContinueRun: { stop: 'call skip_reply' } });
    await r.arrive('stream:B', ['chat:ambient', 'chat:reaction']);
    await r.run();
    assert.equal(r.starts[0]!.channelId, 'stream:A');
  });

  it('a marker on B, then a newer ambient message on A: the turn speaks in A', async (t) => {
    const r = await resident(t);
    await r.arrive('stream:B', ['chat:ambient', 'chat:deleted']);
    await r.arrive('stream:A', ['chat:ambient']);
    await r.run();
    assert.equal(r.starts[0]!.channelId, 'stream:A');
  });

  it("a heartbeat's wake and a marker on B in one batch make a heartbeat's turn, with no channel", async (t) => {
    const r = await resident(t);
    r.queue({ reason: 'heartbeat', source: 'heartbeat' });
    await r.arrive('stream:B', ['chat:ambient', 'chat:reaction']);
    await r.run();
    assert.equal(r.starts[0]!.channelId, undefined);
    assert.equal(r.starts[0]!.heartbeatTurn, true);
  });

  it("while the host is quiesced, a marker parked after a message doesn't take the message's place: resumed, the turn speaks in A", async (t) => {
    const r = await resident(t, [], ['scout', 'second']);
    await r.fw.quiesce();
    await r.arrive('stream:A', ['chat:ambient']);
    await r.arrive('stream:B', ['chat:ambient', 'chat:reaction']);
    await r.pass();
    assert.equal(r.starts.length, 0, 'premise: nothing starts while quiesced');
    assert.ok(r.parked('second') >= 1, "premise: the second resident's wakes are parked");
    await r.fw.resume();
    await r.run();
    const second = r.starts.filter((s) => s.agentName === 'second');
    assert.equal(second.length, 1, "premise: the second resident's wakes, which read no row, start one turn");
    assert.equal(second[0]!.channelId, 'stream:A');
  });

  describe('a turn queued again keeps the rank of the request that named its channel', () => {
    it("a marker alone starts a turn, a stated wait holds its retry, and a heartbeat's wake joins it: the turn is a heartbeat's", async (t) => {
      const r = await resident(t, [statedWait]);
      await r.arrive('stream:B', ['chat:ambient', 'chat:edited']);
      await r.run();
      assert.equal(r.starts[0]!.channelId, 'stream:B', "premise: the marker named its own turn's channel");
      r.queue({ reason: 'heartbeat', source: 'heartbeat' });
      await r.run();
      assert.equal(r.held(), 2, "premise: the hold keeps the turn's retry and the heartbeat's wake");
      await r.release();
      await r.run();
      assert.equal(r.starts.length, 2);
      assert.equal(r.starts[1]!.channelId, undefined);
      assert.equal(r.starts[1]!.heartbeatTurn, true);
    });

    it('a marker on B leads a batch with an ambient message on A; its retry, held, meets a newer marker on C: the turn speaks in A', async (t) => {
      const r = await resident(t, [statedWait]);
      await r.arrive('stream:B', ['chat:ambient', 'chat:reaction']);
      await r.arrive('stream:A', ['chat:ambient']);
      await r.run();
      assert.equal(r.starts[0]!.channelId, 'stream:A', 'premise: the message named the first start');
      await r.arrive('stream:C', ['chat:ambient', 'chat:reaction']);
      await r.run();
      assert.equal(r.held(), 2, "premise: the hold keeps the turn's retry and the marker's wake");
      await r.release();
      await r.run();
      assert.equal(r.starts.length, 2);
      assert.equal(r.starts[1]!.channelId, 'stream:A');
    });

    it('a message and a marker on one channel A start a turn; its retry, held, meets a newer marker on B: the turn speaks in A', async (t) => {
      const r = await resident(t, [statedWait]);
      await r.arrive('stream:A', ['chat:ambient']);
      await r.arrive('stream:A', ['chat:ambient', 'chat:edited']);
      await r.run();
      assert.equal(r.starts[0]!.channelId, 'stream:A', 'premise: the first start is on A');
      await r.arrive('stream:B', ['chat:ambient', 'chat:edited']);
      await r.run();
      assert.equal(r.held(), 2, "premise: the hold keeps the turn's retry and the marker's wake");
      await r.release();
      await r.run();
      assert.equal(r.starts.length, 2);
      assert.equal(r.starts[1]!.channelId, 'stream:A');
    });

    it("a stated wait's hold keeps a marker and a message on one channel apart, though they share a time: released with a heartbeat's held retry, the second resident speaks in A", async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const r = await resident(t, [statedWait], ['scout', 'second']);
      r.queue({ agentName: 'second', reason: 'heartbeat', source: 'heartbeat' });
      await r.run();
      const second = () => r.starts.filter((s) => s.agentName === 'second');
      assert.equal(second()[0]?.heartbeatTurn, true, "premise: the second resident's heartbeat turn started");
      await r.arrive('stream:A', ['chat:ambient', 'chat:edited']);
      await r.arrive('stream:A', ['chat:ambient']);
      await r.run();
      assert.ok(r.held('second') >= 2, "premise: the hold keeps the turn's retry and what arrived");
      await r.release('second');
      await r.run();
      assert.equal(second().length, 2);
      assert.equal(second()[1]!.channelId, 'stream:A');
    });

    it("a marker alone starts a turn whose retries run out; re-armed, it meets an ambient message on A: it keeps its channel B", async (t) => {
      const r = await resident(t, [serverError, serverError, serverError]);
      await r.arrive('stream:B', ['chat:ambient', 'chat:edited']);
      await r.run();
      assert.equal(r.held(), 1, 'premise: the turn is re-armed and waits');
      await r.arrive('stream:A', ['chat:ambient']);
      await r.run();
      assert.equal(r.starts.length, 2);
      assert.equal(r.starts[1]!.channelId, 'stream:B');
    });
  });
});

describe("a marker's wake and where the reply is published, over the wire", () => {
  const EARLIER = 'earlier-room';
  const LUNCH = 'lunch-room';
  const TYPO = 'typo-room';
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function busyThenBatch(f: Fixture, during: () => Promise<void>) {
    await registerOpen(f, EARLIER, LUNCH, TYPO);
    let letGo!: () => void;
    const released = new Promise<void>((resolve) => { letGo = resolve; });
    let opened = 0;
    f.membrane.streamYielding = (request: NormalizedRequest): YieldingStream => {
      f.membrane.calls.push(request);
      opened++;
      if (opened === 1) return new HeldStream(released, [createMockResponse([{ type: 'text', text: 'zz-on-earlier' }])]);
      return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-lunch at one works' }])]);
    };
    await incoming(f, EARLIER, 'e1', 'zz-are you there?', MENTION);
    const idle = f.framework.runUntilIdle();
    try {
      await eventually(() => opened === 1, 'the turn on the earlier channel started');
      await during();
      await eventually(() => fixtureInternals(f).pendingRequests.filter((r) => r.agentName === 'agent').length === 2,
        'both wakes wait for the turn to end');
    } finally {
      letGo();
      await idle;
    }
    await eventually(() => opened >= 2, 'the batch started a turn');
    await f.framework.runUntilIdle();
    const published = (text: string) => f.published.filter((p) => JSON.stringify(p.content).includes(text)).map((p) => p.channelId);
    const routing = f.membrane.calls[1]!.messages.flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .filter((text) => text.startsWith('[routing] Your plain speech now lands in'));
    return { published, routing };
  }

  const assertSpokeInLunch = ({ published, routing }: Awaited<ReturnType<typeof busyThenBatch>>) => {
    assert.deepEqual(published('zz-on-earlier'), [EARLIER], 'premise: the earlier turn spoke where it was asked');
    assert.deepEqual(published('zz-lunch at one works'), [LUNCH]);
    assert.equal(routing.length, 2, `the earlier turn's notice and this turn's: ${JSON.stringify(routing)}`);
    assert.ok(routing[1]!.includes(LUNCH) && !routing[1]!.includes(TYPO), routing[1]);
  };

  it("an ambient message on A and an edit on B wait together: the resident is told its speech lands in A, and its reply is published in A", async () => {
    const f = await fixture();
    try {
      assertSpokeInLunch(await busyThenBatch(f, async () => {
        await incoming(f, LUNCH, 'l1', 'zz-lunch at one?', AMBIENT);
        await incoming(f, TYPO, 't1', 'zz-typo fixed', ['chat:ambient', 'chat:edited']);
      }));
    } finally { await f.close(); }
  });

  it('an ambient message on A and a reaction pushed on B, as discord-mcpl sends one, wait together: the resident is told its speech lands in A, and its reply is published in A', async () => {
    const f = await fixture();
    try {
      assertSpokeInLunch(await busyThenBatch(f, async () => {
        await incoming(f, LUNCH, 'l1', 'zz-lunch at one?', AMBIENT);
        await f.send('push/event', {
          featureSet: 'doc', eventId: 'r1', timestamp: TS,
          payload: { content: [{ type: 'text', text: 'zz-pat reacted 👍' }] },
          origin: { source: 'discord', mcplChannelId: TYPO, authorId: 'U2', authorName: 'pat', messageId: 't0' },
          tags: ['chat:reaction'],
        });
      }));
    } finally { await f.close(); }
  });
});
