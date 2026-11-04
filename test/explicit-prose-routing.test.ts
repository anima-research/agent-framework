/**
 * Explicit prose routing (docs/explicit-prose-routing.md).
 *
 * The model names every destination in-band (`>>` prefixes); unprefixed prose
 * is NEVER delivered — it bounces to a held draft for a prefixed resend. The
 * laria regression (2026-07-24): a DM reply generated while the host-inferred
 * locus pointed at a guild channel was misdelivered there. In explicit mode
 * that class is structurally impossible: the worst case is a bounce.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  InferenceRequest,
  ErrorPolicy,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { destinationKey, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { draftState, type ProseDraftStore } from '../src/prose-drafts.js';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

class ToolboxModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'move',
      description: 'Move the robot',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    }, {
      name: 'say',
      description: 'Publish speech into the world',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    return { success: true, data: { ok: true, published: call.name.endsWith('--say') } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      return {
        addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }],
        requestInference: text === 'go',
      };
    }
    return {};
  }
}

/**
 * A stream message's channel as the test records it. Each delivery hands its
 * stream the destination its publish went to, here the stub's server: one
 * for any other server is recorded with it, so a delivery that loses its
 * server fails the test.
 */
const streamedAt = (to: { serverId: string; channelId: string }) =>
  (to.serverId === 'stub' ? to.channelId : `${to.channelId} (server ${to.serverId})`);

/** The server a stub channel is on: the body's for its own channels, the stub's for the rest. */
const serverOf = (channelId: string) => (channelId.startsWith('body:') ? 'body' : 'stub');
/** A stub channel, with its server. */
const stub = (channelId: string): ChannelRef => ({ serverId: serverOf(channelId), channelId });

/** Registry stub: two known channels (#alpha guild, laria's DM) + capture. */
function stubRegistry(framework: AgentFramework, plan: Array<'delivered' | 'false' | 'unknown' | 'throw'> = []) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const known: Record<string, { channelId: string; label: string }> = {
    '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '#cafe': { channelId: 'discord:g:cafe', label: '#cafe' },
    'world:commons': { channelId: 'world:commons', label: 'world:commons' },
    'alpha': { channelId: 'chan-alpha', label: '#alpha' },
    'chan-alpha': { channelId: 'chan-alpha', label: '#alpha' },
    '@laria': { channelId: 'discord:dm:99', label: 'DM: laria' },
    'discord:dm:99': { channelId: 'discord:dm:99', label: 'DM: laria' },
  };
  // The framework hands delivery the channel with its server; the test
  // records the channel id, and the stub's server is the only one.
  const deliverSpeech = async (_agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
    routed.push({ text, locus: locus?.channelId ?? null });
    const behavior = plan.shift() ?? 'delivered';
    if (behavior === 'throw') throw new Error('synthetic publication failure');
    const destination = { serverId: locus?.serverId ?? 'stub', channelId: locus?.channelId ?? '' };
    if (behavior === 'unknown') {
      return { status: 'unknown' as const, destination, reason: 'stub delivery uncertain', at: Date.now() };
    }
    return behavior === 'delivered'
      ? { status: 'delivered' as const, destination, at: Date.now() }
      : { status: 'failed' as const, destination, reason: 'stub reported delivered:false', at: Date.now() };
  };
  const explicit: Record<string, unknown> = {
    // As the registry does, a channel its server declared inbound-only
    // resolves for reading but not as a target for speech.
    resolveProseTarget: (spec: string, opts?: { forSpeech?: boolean }) =>
      spec === '#ears'
        ? opts?.forSpeech
          ? { error: 'body:ears is inbound-only: server "body" declared this channel\'s direction "inbound", so the host publishes nothing into it; to speak there, use that server\'s own tools', refusedChannelId: 'body:ears' }
          : { channelId: 'body:ears', serverId: 'body', label: 'Body · ears' }
        : known[spec] ? { serverId: 'stub', ...known[spec] } : { error: 'no channel matches "' + spec + '"' },
    deliverSpeech,
    routeSpeech: async (agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
      const outcome = await deliverSpeech(agent, text, locus);
      return outcome.status === 'delivered'
        ? { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId }
        : null;
    },
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
    resolveLocus: () => ({ serverId: 'stub', channelId: 'world:commons' }),
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    // A channel id names one channel here, on the server it belongs to.
    channelsNamed: (name: string) => [{ serverId: serverOf(name), channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

describe('explicit prose routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: ToolboxModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'epr-test-'));
    membrane = new MockMembrane();
    module = new ToolboxModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const retryAtOnce: ErrorPolicy = {
    maxRetries: 1,
    onInferenceError: (_error, _agentName, attempt) => (attempt < 1 ? { retry: true, delayMs: 0 } : { retry: false }),
  };

  async function createFramework(mode: 'explicit' | 'hybrid' | 'disabled' = 'explicit', settings: Record<string, unknown> = {}, errorPolicy?: ErrorPolicy): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      ...(errorPolicy ? { errorPolicy } : {}),
      agents: [{
        name: 'assistant',
        model: 'test-model',
        systemPrompt: 'You are a test agent.',
        proseRouting: mode,
        ...settings,
      }],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  function trigger(framework: AgentFramework): void {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: {},
    } as unknown as ProcessEvent);
  }

  /** Feed a response for the Nth turn (1-based) the moment it starts —
   *  MockMembrane hands ALL remaining responses to the first stream, so
   *  later turns must receive theirs at inference:started time. */
  function feedTurn(framework: AgentFramework, turn: number, blocks: ContentBlock[], stop?: string): void {
    let count = 0;
    const off = framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      count++;
      if (count === turn) {
        membrane.pushResponse(createMockResponse(blocks, stop as never));
        off();
      }
    });
  }

  it('unprefixed prose NEVER delivers — bounces to a held draft, then a prefixed {{unsent}} resend delivers verbatim (laria regression)', async () => {
    const original = 'laria.\n\nYes, I remember. Two words through the keyhole.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: original }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    // Turn 2 = the bounce-wake: model resends with a destination.
    feedTurn(framework, 2, [{ type: 'text', text: '>>@laria {{unsent}}' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(bounceNotices.length, 1, 'exactly one bounce notice');
    assert.equal(routed.length, 1, 'only the prefixed resend delivered');
    assert.equal(routed[0]!.locus, 'discord:dm:99', 'delivered to the DM the model named');
    assert.equal(routed[0]!.text, original, '{{unsent}} substitution is verbatim');
    const notices = context(framework).texts.filter((t) => t.startsWith('[prose-routing]'));
    assert.ok(notices.length > 0, 'the bounce notice is in the context');
    assert.ok(notices.every((t) => !t.includes('Two words through the keyhole')), `the bounce notice quotes none of the words: ${notices.join(' | ')}`);

    await framework.stop();
  });

  it('resolves label prefixes and applies the sticky turn target to later unprefixed segments', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first segment' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'chan-alpha' },
      { text: 'second segment, no prefix', locus: 'chan-alpha' },
    ], 'prefix stripped on wire; sticky target carries the second segment');

    await framework.stop();
  });

  it('>>skip_reply keeps the text in context — nothing delivered, no bounce', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>skip_reply\nWorking through the plan here.' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    const bounceNotices: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-bounce') bounceNotices.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(routed.length, 0, 'skip_reply text is never delivered');
    assert.equal(bounceNotices.length, 0, 'skip_reply text never bounces');

    await framework.stop();
  });

  /** The registry stub answers skip_reply as the real registry does: the turn ends, and nothing is sent. */
  function answerSkipReply(framework: AgentFramework): { calls: number } {
    const answered = { calls: 0 };
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async (name: string) => {
      if (name === 'skip_reply') answered.calls++;
      return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
    };
    return answered;
  }

  /** What the registry stub's streaming surface receives (MCPL Spec 14.3 chunk and complete). */
  function captureStream(framework: AgentFramework) {
    const chunks: Array<{ channelId: string; delta: string }> = [];
    const completes: Array<{ channelId: string; text: string }> = [];
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.sendOutgoingChunk = (to: { serverId: string; channelId: string }, _agent: string, _id: string, _index: number, delta: string) => {
      chunks.push({ channelId: streamedAt(to), delta });
    };
    registry.sendOutgoingComplete = (to: { serverId: string; channelId: string }, _agent: string, _id: string, text: string) => {
      completes.push({ channelId: streamedAt(to), text });
    };
    return { chunks, completes };
  }

  /** The texts of the agent's context, and the bounce notices among them. */
  function context(framework: AgentFramework): { texts: string[]; bounces: number } {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { kind?: string };
    }>;
    return {
      texts: messages.flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')),
      bounces: messages.filter((m) => m.metadata?.kind === 'prose-bounce').length,
    };
  }

  /** The metadata of the newest message whose text starts with `prefix`. */
  function noticeOf(framework: AgentFramework, prefix: string): { draftOwner?: string; draftIds?: string[] } | undefined {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { draftOwner?: string; draftIds?: string[] };
    }>;
    return messages.filter((m) => m.content.some((b) => b.type === 'text' && (b.text ?? '').startsWith(prefix))).at(-1)?.metadata;
  }

  type DraftsView = ProseDraftStore;
  const draftsOf = (framework: AgentFramework): DraftsView =>
    (framework as unknown as { proseDrafts: DraftsView }).proseDrafts;

  for (const failure of ['false', 'throw'] as const) {
    it('an explicit ' + failure + ' delivery holds its body as a bounce and names it privately, unless the send threw', async () => {
      const framework = await createFramework();
      try {
        const routed = stubRegistry(framework, [failure]);
        const agent = framework.getAgent('assistant')!;
        const gateway = framework as unknown as {
          deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
        };
        await gateway.deliverProse(agent, '>>#alpha keep these words', { notice: 'later' });
        assert.deepEqual(routed, [{ text: 'keep these words', locus: 'chan-alpha' }]);
        const held = draftsOf(framework).open('assistant');
        if (failure === 'throw') {
          // The send threw, so the words may have gone out: marker-only, as
          // an unknown outcome is, with no draft to resend.
          assert.deepEqual(held, [], 'words whose send threw are not held');
          const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing]'))!;
          assert.match(notice, /may not have been delivered/);
          assert.match(notice, /isn't held as a draft, since a resend could post it twice/);
          assert.ok(notice.endsWith('the words remain in your history.'), notice);
          assert.doesNotMatch(notice, /\{\{unsent\}\}|was not delivered/);
          return;
        }
        assert.equal(held.length, 1, 'the failed envelope became one draft');
        assert.equal(held[0]!.reason, 'bounced');
        assert.equal(held[0]!.text, 'keep these words');
        assert.ok(context(framework).texts.some((t) => t.includes('[prose-routing]') && t.includes(held[0]!.id)));
      } finally {
        await framework.stop();
      }
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it('an unknown ' + mode + ' delivery is not offered as a fresh bounce draft', async () => {
      const framework = await createFramework(mode);
      try {
        const routed = stubRegistry(framework, ['unknown']);
        const agent = framework.getAgent('assistant')!;
        const gateway = framework as unknown as {
          deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
          deliverHybridProse(a: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: unknown; notice: 'later' }): Promise<void>;
          routingOf(name: string): unknown;
        };
        if (mode === 'explicit') await gateway.deliverProse(agent, '>>#alpha uncertain words', { notice: 'later' });
        else await gateway.deliverHybridProse(agent, '>>>#alpha uncertain words', null, true, { routing: gateway.routingOf('assistant'), notice: 'later' });
        assert.deepEqual(routed, [{ text: 'uncertain words', locus: 'chan-alpha' }], 'the uncertain attempt was made');
        assert.deepEqual(draftsOf(framework).open('assistant'), []);
        assert.equal(context(framework).bounces, 0);
      } finally {
        await framework.stop();
      }
    });
  }

  it('{{unsent}} that names no held draft sends nothing, and holds the envelope\'s other words', async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      const agent = framework.getAgent('assistant')!;
      // Nothing was ever bounced: a bare {{unsent}} sends nothing and says so.
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed, [], 'nothing is sent');
      assert.deepEqual(store.open('assistant'), [], 'and nothing is held');
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing] {{unsent}} names no held bounce draft') && t.includes('nothing was sent')));
      // With words of its own, those are held as a bounce draft rather than
      // posted as a fragment.
      await gateway.deliverProse(agent, '>>#alpha Here it is again: {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed, [], 'still nothing is sent');
      const [held] = store.open('assistant');
      assert.equal(held?.text, 'Here it is again:');
      assert.equal(store.latestBounce('assistant')?.id, held?.id);
    } finally {
      await framework.stop();
    }
  });

  it('{{unsent}} after its draft was sent names nothing, so the envelope sends nothing', async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      const agent = framework.getAgent('assistant')!;
      await gateway.deliverProse(agent, '>>#nowhere the words', { notice: 'later' });
      const bounce = store.latestBounce('assistant')!;
      assert.equal(bounce.text, 'the words');
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['the words'], 'the first {{unsent}} sends the bounce');
      await gateway.deliverProse(agent, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['the words'], 'a second one, with the draft delivered, sends nothing');
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing] {{unsent}} names no held bounce draft')),
        'and says why');
    } finally {
      await framework.stop();
    }
  });

  for (const sent of ['{{unsent}} plus a line', '{{unsent}}'] as const) {
  it(`a later turn's bounce waits behind an earlier turn's held '${sent}' send, which holds the words it attempted when it fails`, async () => {
    // Turn one queues '>>#alpha ${sent}' and skip_reply ends it while that
    // publish is held. Turn two's speech queues behind it (each stream's
    // deliveries wait for the agent's earlier ones), so turn two's bounce
    // can't land first: turn one's failed send holds the words it
    // attempted, and turn two's bounce, the latest, follows it.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `>>#alpha ${sent}` },
      { type: 'tool_use', id: 'delayed-1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'delayed-2', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));
    const framework = await createFramework();
    const routed = stubRegistry(framework, ['false']);
    answerSkipReply(framework);
    const store = draftsOf(framework);
    const original = store.hold('assistant', [{ text: 'ORIGINAL WORDS' }], 'bounced').held[0]!;
    const internals = framework as unknown as {
      channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> };
    };
    const deliver = internals.channelRegistry.deliverSpeech;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    internals.channelRegistry.deliverSpeech = async (...args: unknown[]) => {
      const outcome = await deliver(...args);
      entered();
      await held;
      return outcome;
    };
    let starts = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      starts++;
      if (starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>#nowhere NEW WORDS' }]));
      if (starts >= 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }]));
    });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      await reached;
      const attempted = sent === '{{unsent}}' ? 'ORIGINAL WORDS' : 'ORIGINAL WORDS plus a line';
      assert.deepEqual(routed.map((r) => r.text), [attempted]);
      trigger(framework);
      const settled = framework.runUntilIdle();
      for (const end = Date.now() + 5000; starts < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(starts, 2, 'the next turn has started');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(store.latestBounce('assistant')?.id, original.id, "the next turn's bounce waits behind the held send");
      release();
      await within(settled, 'the next turn to settle');
      await framework.runUntilIdle();
      const heldTexts = store.open('assistant').map((d) => d.text);
      assert.ok(heldTexts.includes(attempted), `the failed send holds the words it attempted: ${JSON.stringify(heldTexts)}`);
      const copy = store.open('assistant').find((d) => d.text === attempted)!;
      assert.equal(copy.inheritedRisk, undefined, 'a definite failure leaves no risk to inherit');
      if (sent === '{{unsent}}') {
        assert.equal(copy.id, original.id, 'the bare send re-bounces the draft it sent');
        // Independent of timing: the re-bounce notice offers {{unsent}} only
        // when its draft is the latest bounce, so it does only if the next
        // turn's bounce waited for this failure.
        const notice = context(framework).texts.filter((t) => t.startsWith('[prose-routing]') && t.includes(original.id)).at(-1)!;
        assert.ok(notice.includes('{{unsent}}'), `the failure came back before the next turn's bounce: ${notice}`);
      } else {
        // Held after the failure's copy, the next turn's bounce is the latest.
        assert.notEqual(copy.id, original.id);
      }
      assert.equal(store.latestBounce('assistant')?.text, 'NEW WORDS', "the next turn's bounce came after it, and is the latest");
    } finally {
      release();
      await framework.stop();
    }
  });
  }

  it('a thrown explicit unsent delivery re-bounces the authored body with its unresolved attempt risk', async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework, ['throw']);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{
        text: 'earlier words',
      }], 'bounced').held[0]!;
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}} plus a line', { notice: 'later' });
      const copy = store.open('assistant').find((d) => d.id !== original.id)!;
      assert.ok(copy, 'the failed envelope is retained');
      assert.equal(copy.text, 'earlier words plus a line');
      assert.equal(copy.inheritedRisk?.draftId, original.id);
      assert.equal(draftState(copy), 'unconfirmed', 'a fresh draft cannot erase its source attempt risk');
      const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing]') && t.includes(copy.id))!;
      assert.doesNotMatch(notice, /was not delivered/, 'an unconfirmed send is not also declared undelivered');
      assert.ok(notice.includes(`draftIds: ["${copy.id}"], destination: "#<channel>", confirmDuplicate: true`), notice);
      assert.ok(!notice.includes('{{unsent}}'), `{{unsent}} would refuse it, so the notice doesn't offer it: ${notice}`);
    } finally {
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    for (const failure of ['false', 'throw'] as const) {
      it(`${mode}: a ${failure === 'false' ? 'failed' : 'thrown'} {{unsent}} send re-holds the draft it substituted, though a newer bounce landed while it waited`, async () => {
        const framework = await createFramework(mode);
        try {
          stubRegistry(framework, [failure]);
          const store = draftsOf(framework);
          const original = store.hold('assistant', [{ text: 'ORIGINAL WORDS' }], 'bounced').held[0]!;
          const internals = framework as unknown as {
            channelRegistry: { deliverSpeech: (...args: unknown[]) => Promise<unknown> };
            deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
            deliverHybridProse(a: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: unknown; notice: 'later' }): Promise<void>;
            routingOf(name: string): unknown;
          };
          const deliver = internals.channelRegistry.deliverSpeech;
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          let entered!: () => void;
          const reached = new Promise<void>((resolve) => { entered = resolve; });
          internals.channelRegistry.deliverSpeech = async (...args: unknown[]) => {
            entered();
            await held;
            return deliver(...args);
          };
          const agent = framework.getAgent('assistant')!;
          const sending = mode === 'explicit'
            ? internals.deliverProse(agent, '>>#alpha {{unsent}} plus a line', { notice: 'later' })
            : internals.deliverHybridProse(agent, '>>>#alpha {{unsent}} plus a line', null, true, { routing: internals.routingOf('assistant'), notice: 'later' });
          await reached;
          // A newer bounce becomes the latest while the send waits, and the
          // store reloads its projection (as after an ambiguous append), so
          // the draft captured before the send is no longer the stored one.
          store.hold('assistant', [{ text: 'NEW WORDS' }], 'bounced');
          store.reload();
          assert.notEqual(store.get('assistant', original.id), original, 'the reload replaced the stored draft');
          release();
          await sending;
          const texts = store.open('assistant').map((d) => d.text);
          assert.ok(texts.includes('ORIGINAL WORDS plus a line'), `it re-holds the words it attempted: ${JSON.stringify(texts)}`);
          assert.ok(!texts.includes('NEW WORDS plus a line'), 'not the newer bounce');
          const copy = store.open('assistant').find((d) => d.text === 'ORIGINAL WORDS plus a line')!;
          if (failure === 'throw') assert.equal(copy.inheritedRisk?.draftId, original.id, "a thrown send's copy carries its source's risk");
          else assert.equal(copy.inheritedRisk, undefined, 'read after the attempt, the failed draft carries no risk to inherit');
        } finally {
          await framework.stop();
        }
      });
    }
  }

  it("{{unsent}} puts a draft's words in exactly, `$&` and `$$` included", async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      store.hold('assistant', [{ text: 'costs $$5, see $& and $1' }], 'bounced');
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}} (again)', { notice: 'later' });
      assert.deepEqual(routed.map((r) => r.text), ['costs $$5, see $& and $1 (again)']);
    } finally {
      await framework.stop();
    }
  });

  it('a thrown bare {{unsent}} delivery says sending its draft again could post it twice', async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework, ['throw']);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{
        text: 'earlier words',
      }], 'bounced').held[0]!;
      const gateway = framework as unknown as {
        deliverProse(a: unknown, text: string, hold: { notice: 'later' }): Promise<void>;
      };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}}', { notice: 'later' });
      assert.deepEqual(store.open('assistant').map((d) => d.id), [original.id], 'a bare {{unsent}} holds no copy');
      assert.equal(draftState(store.get('assistant', original.id)!), 'unconfirmed');
      const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing]') && t.includes(original.id))!;
      assert.match(notice, /Its last send's outcome isn't known, so sending it again could post it twice: resend it only with confirmDuplicate: true\./);
      assert.doesNotMatch(notice, /was not delivered/, 'an unconfirmed send is not also declared undelivered');
      assert.match(notice, /may not have been delivered/);
      assert.ok(notice.includes(`draftIds: ["${original.id}"], destination: "#<channel>", confirmDuplicate: true`), notice);
      assert.ok(notice.includes('resend it only with confirmDuplicate: true.'), notice);
      assert.ok(!notice.includes('{{unsent}}'), notice);
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a >>> envelope whose {{unsent}} names no held bounce sends nothing, and holds its other words', async () => {
    const framework = await createFramework('hybrid');
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const gateway = framework as unknown as {
        deliverHybridProse(a: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: unknown; notice: 'later' }): Promise<void>;
        routingOf(name: string): unknown;
      };
      await gateway.deliverHybridProse(framework.getAgent('assistant')!, '>>>#alpha {{unsent}} and a note', null, true, { routing: gateway.routingOf('assistant'), notice: 'later' });
      assert.deepEqual(routed, [], 'no fragment goes out');
      assert.deepEqual(store.open('assistant').map((d) => d.text), ['and a note']);
      assert.ok(context(framework).texts.some((t) => t.startsWith('[prose-routing]') && t.includes('{{unsent}} names no held bounce draft')));
    } finally {
      await framework.stop();
    }
  });

  it('a round that calls skip_reply keeps its unprefixed prose private: nothing delivered, bounced, retained or woken for', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Weighing whether this needs an answer from me.' },
      { type: 'tool_use', id: 'sr1', name: 'skip_reply', input: { reason: 'nothing to add' } },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // Were the text bounced, its wake would start a second turn: give that
    // turn a response, so the test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'nothing is delivered');
    const seen = context(framework);
    assert.equal(seen.bounces, 0, 'no bounce notice reaches the context');
    assert.ok(seen.texts.some((t) => t.includes('Weighing whether this needs an answer')), 'the text stays in the context');
    assert.deepEqual(draftsOf(framework).open('assistant'), [], 'no draft is held');
    assert.equal(draftsOf(framework).latestBounce('assistant'), undefined, 'and {{unsent}} names nothing');
    assert.equal(turns, 1, 'no bounce wake starts another turn');

    await framework.stop();
  });

  it('a round whose skip_reply the output limit cut off keeps its prose private after an earlier round delivered', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first, deliberately' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: '>>#alpha thoughts I keep to myself' },
        { type: 'tool_use', id: 'sr3', name: 'skip_reply', input: {}, unparseableInput: '{"wake_in_sec' },
      ] as ContentBlock[], 'max_tokens'),
      toolCalls: [],
    });

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 0, 'the cut-off skip_reply never ran');
    assert.deepEqual(routed, [{ text: 'first, deliberately', locus: 'chan-alpha' }], 'only the earlier round\'s words go out');
    assert.ok(context(framework).texts.some((t) => t.includes('thoughts I keep to myself')), 'the text stays in the context');

    await framework.stop();
  });

  it('a round with a private think that the output limit cut off keeps its prose after an earlier round delivered', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first, deliberately' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse({
      ...createMockResponse([
        { type: 'text', text: '>>#alpha musing I keep to myself' },
        { type: 'tool_use', id: 't3', name: 'think', input: {}, unparseableInput: '{"thought": "is it' },
      ] as ContentBlock[], 'max_tokens'),
      toolCalls: [],
    });

    const framework = await createFramework('explicit', { sameRoundThinkTextPolicy: 'private' });
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'first, deliberately', locus: 'chan-alpha' }], 'only the earlier round\'s words go out');
    assert.ok(context(framework).texts.some((t) => t.includes('musing I keep to myself')), 'the text stays in the context');

    await framework.stop();
  });

  it('a round that calls skip_reply keeps its unprefixed prose from a sticky destination', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first, deliberately' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Second thoughts I keep to myself.' },
      { type: 'tool_use', id: 'sr2', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.deepEqual(routed, [{ text: 'first, deliberately', locus: 'chan-alpha' }],
      'only the earlier, deliberately addressed segment goes out');
    assert.ok(context(framework).texts.some((t) => t.includes('Second thoughts I keep to myself.')), 'the text stays in the context');

    await framework.stop();
  });

  it('a round that calls skip_reply sends nothing, a prefixed segment included, and asks for no continuation', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! addressed, then thought better of' },
      { type: 'tool_use', id: 'sr3', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    // A continuation would start a second turn: give it a response, so the
    // test fails on its count instead of hanging.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the skip_reply round ran');
    assert.equal(routed.length, 0, 'skip_reply ends the turn without sending anything');
    assert.equal(context(framework).bounces, 0);
    assert.equal(turns, 1, "the round's ' !' starts no continuation after skip_reply ended the turn");

    await framework.stop();
  });


  type RoutingState = {
    pin?: ChannelRef; hybridHold?: 'private' | 'failed';
    continuation: boolean; deliveries: ChannelRef[]; suppressed: number; drafts: Array<{ id: string; text: string }>; keptPrivate: number;
    triggerChannel?: ChannelRef; locus?: ChannelRef; engaged: Set<string>; wasIn: ChannelRef[]; arrivals: Array<{ messageId: string; channel: ChannelRef }>;
  };
  /** A turn's routing state, as the framework makes a fresh one. */
  const routingState = (fields: Partial<RoutingState> = {}): RoutingState => ({
    continuation: false, deliveries: [], suppressed: 0, drafts: [], keptPrivate: 0,
    engaged: new Set(), wasIn: [], arrivals: [], ...fields,
  });

  /**
   * Run `around` on each post the stub registry takes, on both paths a post
   * can take (routeSpeech for locus prose, deliverSpeech for a named or
   * sticky destination), after the stub records it and before its outcome
   * returns: a test holds a post by awaiting there.
   */
  function aroundPosts(framework: AgentFramework, around: (text: string) => Promise<void>): void {
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    for (const key of ['routeSpeech', 'deliverSpeech'] as const) {
      const post = registry[key] as (...args: unknown[]) => Promise<unknown>;
      registry[key] = async (...args: unknown[]) => {
        const outcome = await post(...args);
        await around(String(args[1]));
        return outcome;
      };
    }
  }

  async function within<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), ms);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  function nextTrace(framework: AgentFramework, type: string) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const off = framework.onTrace((event) => {
      if (event.type === type && (event as { agentName?: string }).agentName === 'assistant') {
        off();
        resolve();
      }
    });
    return { promise, dispose: off };
  }

  async function withQueuedTurns(
    mode: 'explicit' | 'hybrid',
    lateText: string,
    nextResponses: ReturnType<typeof createMockResponse>[],
    inspect: (fixture: {
      framework: AgentFramework; routed: Array<{ text: string; locus: string | null }>;
      earlier: RoutingState; next: RoutingState; turns: () => number;
      release: () => void; drain: () => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const arrows = mode === 'explicit' ? '>>' : '>>>';
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: arrows + '#alpha first' },
      { type: 'tool_use', id: 'q1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: lateText },
      { type: 'tool_use', id: 'q2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'q3', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use'));

    const framework = await createFramework(mode);
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    aroundPosts(framework, async (text) => {
      if (text.trim() === 'first') await held;
    });
    let turns = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      turns++;
      if (turns === 2) for (const response of nextResponses) membrane.pushResponse(response);
      // Serve a bounce wake or an unexpected continuation without hanging.
      if (turns === 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: arrows + 'skip_reply' }]));
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    const processRequests = internals.processInferenceRequests.bind(framework);
    let nextWakeQueued = false;
    let resolveBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { resolveBlocked = resolve; });
    internals.processInferenceRequests = async () => {
      await processRequests();
      if (nextWakeQueued && turns === 1 && internals.pendingRequests.some((r) => r.agentName === 'assistant')) {
        resolveBlocked();
      }
    };
    const ended = nextTrace(framework, 'inference:turn_ended');
    let completed: ReturnType<typeof nextTrace> | undefined;
    let started: ReturnType<typeof nextTrace> | undefined;
    let stopped = false;
    let driving: Promise<void> | undefined;
    const drain = async () => {
      stopped = true;
      if (driving) await within(driving, 'the queued turns to drain', 10000);
    };
    try {
      trigger(framework);
      driving = (async () => {
        while (!stopped) {
          await framework.runUntilIdle();
          if (!stopped) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      void driving.catch(() => {});
      await within(ended.promise, 'the first turn to end');
      assert.equal(skip.calls, 1, 'skip_reply ended the first turn');
      const earlier = internals.turnRouting.get('assistant')!;
      completed = nextTrace(framework, 'inference:completed');
      started = nextTrace(framework, 'inference:started');
      nextWakeQueued = true;
      trigger(framework);
      if (mode === 'hybrid') {
        const disposition = await within(Promise.race([
          blocked.then(() => 'blocked'), started.promise.then(() => 'started'),
        ]), 'the next wake to reach scheduling');
        assert.equal(disposition, 'blocked', 'hybrid retains the earlier turn token until its receipt tail drains');
        assert.equal(internals.turnRouting.get('assistant'), earlier, 'the earlier turn still owns routing');
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first']);
        release();
        await within(completed.promise, 'the next inference after release');
        assert.equal(turns, 2, 'hybrid starts the next turn after the earlier teardown');
      } else {
        await within(completed.promise, 'the next inference to complete');
        assert.equal(turns, 2, 'explicit starts the next turn without waiting');
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first'],
          "only the first post has entered routing while its confirmation is held");
      }
      await inspect({ framework, routed, earlier, next: internals.turnRouting.get('assistant')!,
        turns: () => turns, release, drain });
    } finally {
      ended.dispose();
      completed?.dispose();
      started?.dispose();
      internals.processInferenceRequests = processRequests;
      release();
      try { await drain(); } finally { await framework.stop(); }
    }
  }


  async function withHeldHybridCallback(
    lateText: string | null,
    inspect: (fixture: {
      framework: AgentFramework; routed: Array<{ text: string; locus: string | null }>;
      gateway: {
        deliverHybridProse(agent: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: RoutingState; notice: 'later' }): Promise<void>;
        appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void;
      };
      earlier: RoutingState; next: RoutingState; agent: unknown;
      pending: Promise<void>; release: () => void;
    }) => Promise<void>,
  ): Promise<void> {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      turnRouting: Map<string, RoutingState>;
      deliverHybridProse(agent: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: RoutingState; notice: 'later' }): Promise<void>;
      appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void;
    };
    const agent = framework.getAgent('assistant')!;
    const earlier: RoutingState = routingState();
    const next: RoutingState = routingState();
    gateway.turnRouting.set('assistant', earlier);
    let release!: () => void;
    let resolveEntered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    aroundPosts(framework, async () => {
      resolveEntered();
      await held;
    });
    const first = gateway.deliverHybridProse(agent, '>>>#alpha first', stub('world:commons'), true, { routing: earlier, notice: 'later' });
    const pending = lateText === null ? first
      : first.then(() => gateway.deliverHybridProse(agent, lateText, stub('world:commons'), true, { routing: earlier, notice: 'later' }));
    void pending.catch(() => {});
    try {
      await within(entered, 'the earlier callback to enter routing');
      // Exercise callback ownership directly. Normal hybrid scheduling keeps
      // its turn token until the receipt tail drains, so fresh turns serialize.
      gateway.turnRouting.set('assistant', next);
      await inspect({ framework, routed, gateway, earlier, next, agent, pending, release });
    } finally {
      release();
      try { await within(pending, 'the held callback to drain'); } finally { await framework.stop(); }
    }
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    const title = mode === 'explicit'
      ? "explicit: prose a turn leaves queued follows that turn's destination, and the next turn's posts wait behind it"
      : "hybrid: the next turn waits for the ended turn's receipt tail, and posts keep their destinations and order";
    it(title, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      await withQueuedTurns(mode, 'and then this', [
        createMockResponse([{ type: 'text', text: arrows + '#cafe next' }]),
      ], async ({ framework, routed, release, drain }) => {
        release();
        await drain();
        assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [
          { text: 'first', locus: 'chan-alpha' },
          { text: 'and then this', locus: 'chan-alpha' },
          { text: 'next', locus: 'discord:g:cafe' },
        ], "each post follows its own turn's destination, in delivery order");
        assert.equal(context(framework).bounces, 0, 'nothing bounces into the next turn');
      });
    });
  }

  it("explicit: a drafts-round line held behind a publish still in flight when a tool ends its turn is held, and a later turn's catch-up names it", async () => {
    await withQueuedTurns('explicit', '>>#alpha second', [
      createMockResponse([
        { type: 'text', text: 'narration beside the call' },
        { type: 'tool_use', id: 'd1', name: 'drafts', input: { action: 'list' } },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'tool_use', id: 'd2', name: 'skip_reply', input: {} }] as ContentBlock[], 'tool_use'),
    ], async ({ framework, release, turns }) => {
      const internals = framework as unknown as { proseDrafts: ProseDraftStore };
      let started = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type !== 'inference:started') return;
        started++;
        if (started >= 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]));
      });
      const line = () => internals.proseDrafts.open('assistant').filter((d) => d.text === 'narration beside the call');
      const naming = () => {
        const ids = line().map((d) => d.id);
        return context(framework).texts.filter((t) => ids.some((id) => t.includes(id)));
      };
      const until = async (done: () => boolean, label: string) => {
        for (const end = Date.now() + 5000; !done();) {
          if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const before = turns();
      trigger(framework);
      await until(() => turns() > before, 'a turn to start while the publish is held');
      assert.deepEqual(line(), [], 'the line waits behind the publish');
      release();
      await until(() => line().length === 1, 'the line to be held');
      assert.equal(line()[0]!.reason, 'no-destination');
      assert.equal(context(framework).bounces, 0, 'it does not bounce');
      const after = turns();
      trigger(framework);
      await until(() => turns() > after && naming().length > 0, 'a later turn to name it');
      assert.equal(naming().length, 1);
      assert.match(naming()[0]!, /no recent notice on this branch names/);
    });
  });

  it("a queued round's late continuation starts once its tool-ended turn's deliveries have run", async () => {
    await withQueuedTurns('explicit', '>>#alpha ! late', [
      createMockResponse([{ type: 'text', text: '>>#cafe next' }]),
    ], async ({ earlier, next, turns, release, drain }) => {
      assert.equal(earlier.continuation, false, 'the continuation has not run before release');
      release();
      for (const end = Date.now() + 5000; turns() < 3 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await drain();
      assert.equal(turns(), 3, 'the continuation starts its own turn, once');
      assert.equal(earlier.continuation, false, "the earlier turn's request was taken from its own object");
      assert.equal(next.continuation, false, 'the next turn never receives that continuation');
    });
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: a ' !' an earlier round asked for starts its continuation when skip_reply ends the turn`, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: arrows + '#alpha ! keep going' },
        { type: 'tool_use', id: 'k1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'k2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));

      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      const skip = answerSkipReply(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: arrows + 'skip_reply' }] as ContentBlock[]);
      const reasons: string[] = [];
      const internals = framework as unknown as { pendingRequests: InferenceRequest[]; processInferenceRequests(): Promise<void> };
      const process = internals.processInferenceRequests.bind(framework);
      internals.processInferenceRequests = async () => {
        for (const request of internals.pendingRequests) reasons.push(request.reason);
        await process();
      };

      trigger(framework);
      await framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        await framework.runUntilIdle();
      }

      assert.equal(skip.calls, 1, 'skip_reply ended the first turn');
      assert.deepEqual(routed.map((r) => r.text.trim()), ['keep going']);
      assert.ok(reasons.includes('prose-continuation'), 'the continuation was requested');
      assert.equal(turns, 2, 'and it started one more turn');

      await framework.stop();
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: a tool-ended turn's ' !' queued behind a held post starts its continuation once that post settles`, async () => {
      const arrows = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `${arrows}#alpha first\n${arrows}#alpha ! second` },
        { type: 'tool_use', id: 'w1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'w2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));
      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      answerSkipReply(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: arrows + 'skip_reply' }] as ContentBlock[]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      aroundPosts(framework, async (text) => {
        if (text.trim() === 'first') { entered(); await held; }
      });
      const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
      const ended = nextTrace(framework, 'inference:turn_ended');
      trigger(framework);
      const running = framework.runUntilIdle();
      try {
        await within(reached, "the first envelope's post to start");
        await within(ended.promise, 'skip_reply to end the turn');
        assert.equal(turns, 1);
        assert.ok(!internals.pendingRequests.some((r) => r.reason === 'prose-continuation'),
          "no continuation while the ' !' envelope waits behind the held post");
        release();
        await within(running, 'the turn to settle');
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.deepEqual(routed.map((r) => r.text.trim()), ['first', 'second']);
        assert.equal(turns, 2, 'the continuation starts once the queued envelope has run');
      } finally {
        ended.dispose();
        release();
        await framework.stop();
      }
    });
  }

  for (const when of ['already set', 'set late'] as const) {
    it(`hybrid: a ' !' an earlier stream asked for (${when}) still starts its continuation after a re-inference on unstreamed tool results`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
      const framework = await createFramework('hybrid');
      const routed = stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
        proseSpeechChains: Map<string, Promise<void>>;
        openLogical: Map<string, RoutingState>;
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      try {
        // The turn's earlier stream asked for a continuation, or will once
        // its queued delivery runs; the turn goes on in a re-inference, which
        // starts a new stream with a fresh routing state while the earlier
        // stream's logical turn is still open.
        const earlier: RoutingState = routingState({ continuation: when === 'already set', locus: stub('world:commons') });
        internals.turnRouting.set('assistant', earlier);
        internals.openLogical.set('assistant', earlier);
        if (when === 'set late') {
          internals.proseSpeechChains.set('assistant', held.then(() => { earlier.continuation = true; }));
        }
        internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
        const running = framework.runUntilIdle();
        if (when === 'set late') {
          for (const end = Date.now() + 5000; turns < 1 && Date.now() < end;) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
          assert.equal(turns, 1, 'the re-inference has started');
          assert.equal(earlier.continuation, false, 'the earlier delivery has not run as the re-inference starts');
          release();
        }
        await within(running, 'the re-inference to settle');
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.deepEqual(routed.map((r) => r.text.trim()), ['carrying on']);
        assert.equal(turns, 2, 'the re-inference completes, then the continuation it carried starts');
        assert.equal(earlier.continuation, false, "the check took the earlier stream's flag");
      } finally {
        release();
        await framework.stop();
      }
    });
  }

  it("hybrid: a re-inference on unstreamed tool results receipts the earlier stream's late delivery with its own", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      proseSpeechChains: Map<string, Promise<void>>;
      openLogical: Map<string, RoutingState>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      // The earlier stream left its tool results pending, its logical turn
      // still open; its delivery lands only after the re-inference has
      // begun, into the logical turn the two share. The turn froze the
      // registry's locus when it opened.
      const earlier: RoutingState = routingState({ locus: stub('world:commons') });
      internals.turnRouting.set('assistant', earlier);
      internals.openLogical.set('assistant', earlier);
      internals.proseSpeechChains.set('assistant', held.then(() => { earlier.deliveries.push(stub('chan-alpha')); }));
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
      const running = framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 1 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(turns, 1, 'the re-inference has started');
      assert.deepEqual(earlier.deliveries, [], 'the earlier delivery has not landed yet');
      release();
      await within(running, 'the re-inference to settle');
      assert.deepEqual(routed.map((r) => r.text.trim()), ['carrying on']);
      const receipt = context(framework).texts.filter((t) => t.startsWith('[delivered]'));
      assert.equal(receipt.length, 1, `one receipt for the logical turn: ${receipt.join(' | ')}`);
      assert.match(receipt[0]!, /chan-alpha/, "it reports the earlier stream's late delivery");
      assert.match(receipt[0]!, /world:commons/, "and the re-inference's own");
    } finally {
      release();
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
  const p = mode === 'explicit' ? '>>' : '>>>';
  it(`${mode}: an error retry keeps a ' !' whose envelope is delivered after the retry starts`, async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: `${p}#alpha first\n${p}#alpha ! second` },
      { type: 'tool_use', id: 'retry-held', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework(mode, {}, retryAtOnce);
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      proseSpeechChains: Map<string, Promise<void>>;
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    aroundPosts(framework, async (text) => {
      if (text.trim() === 'first') { reached(); await held; }
    });
    let firstChain: Promise<void> | undefined;
    let restarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => { restarted = resolve; });
    let starts = 0;
    framework.onTrace((event) => {
      if (event.type === 'inference:failed') firstChain = internals.proseSpeechChains.get('assistant');
      if (event.type === 'inference:started') {
        starts++;
        if (starts === 2) {
          membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply retry done` }]));
          restarted();
        }
        if (starts === 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply continuation done` }]));
      }
    });
    // The first stream ends in a retryable error instead of completing; the
    // retry's own end waits for the first stream's queued deliveries, so the
    // held ' !' envelope runs after the retry has started.
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const index = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && index === 1) {
            yield { type: 'error' as const, error: new Error('synthetic transient stream error') };
            return;
          }
          if (event.type === 'complete' && index === 2) {
            assert.ok(firstChain, 'the first stream queued a delivery chain');
            await firstChain;
          }
          yield event;
        }
      };
      return stream;
    };
    let running: Promise<void> | undefined;
    try {
      trigger(framework);
      running = framework.runUntilIdle();
      void running.catch(() => {});
      await within(entered, 'the held first post');
      await within(retryStarted, 'the error retry to start', 10000);
      assert.equal(starts, 2);
      release();
      await within(running, 'the retry and continuation to finish', 10000);
      assert.deepEqual(routed.map((r) => r.text.trim()), ['first', 'second']);
      assert.equal(membrane.calls.length, 3, "the late ' !' survives the error retry and starts a continuation");
    } finally {
      release();
      if (running) await running;
      await framework.stop();
    }
  });
  }

  it("hybrid: a capacity-held turn's later compile receipts the drafts its first stream held, and the catch-up leaves them to it", async () => {
    // Stream one bounces an envelope into a draft, then its next request
    // meets an organization acceleration 429: the turn is held and its later
    // compile continues the same logical turn, whose receipt names the draft.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#nowhere held words' },
      { type: 'tool_use', id: 'capacity-1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const internals = framework as unknown as {
      providerAccelerationDefaultCooldownMs: number;
      providerAccelerationJitterMs: number;
      openLogical: Map<string, RoutingState>;
    };
    internals.providerAccelerationDefaultCooldownMs = 50;
    internals.providerAccelerationJitterMs = 0;
    let starts = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      starts++;
      if (starts === 2) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }]));
      if (starts >= 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply' }]));
    });
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const index = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && index === 1) {
            yield {
              type: 'error' as const,
              error: new MembraneError({
                type: 'rate_limit', retryable: true, httpStatus: 429,
                message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
                rawError: { status: 429 },
              }),
            };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    try {
      trigger(framework);
      await framework.runUntilIdle();
      const draft = draftsOf(framework).open('assistant').find((d) => d.text === 'held words');
      assert.ok(draft, 'the bounced envelope is held as a draft');
      const open = internals.openLogical.get('assistant');
      assert.ok(open?.drafts.some((d) => d.id === draft.id), "the held turn's logical turn is open, its draft unsettled");
      for (const end = Date.now() + 5000; starts < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        await framework.runUntilIdle();
      }
      assert.equal(starts, 2, 'the held turn was compiled again after its cooldown');
      await framework.runUntilIdle();
      const texts = context(framework).texts;
      const receipts = texts.filter((t) => t.startsWith('[delivered]'));
      assert.equal(receipts.length, 1, `one receipt for the logical turn: ${receipts.join(' | ')}`);
      assert.ok(receipts[0]!.includes(draft.id), `it names the draft the first stream held: ${receipts[0]}`);
      // The later compile continues the logical turn and keeps its routing,
      // the bounce's hold included, so its unprefixed text is held too.
      const later = draftsOf(framework).open('assistant').find((d) => d.text === 'carrying on');
      assert.ok(later, "the later compile's unprefixed text is held under the turn's hold");
      assert.ok(receipts[0]!.includes(later.id), `and the receipt names that draft as well: ${receipts[0]}`);
      assert.ok(!texts.some((t) => t.includes('that no recent notice on this branch names')), 'the catch-up left the draft to the receipt');
      assert.equal(internals.openLogical.has('assistant'), false, 'the logical turn settled');
    } finally {
      await framework.stop();
    }
  });

  it("explicit: a draft bounced after a tool ended its turn is recorded from its notice, not named again by the catch-up", async () => {
    // The ended turn's queued envelope bounces once the held post before it
    // settles, after that turn's drafts were settled. Its bounce notice names
    // it; the next turn's catch-up records that notice rather than naming
    // the draft as unnamed.
    await withQueuedTurns('explicit', '>>#nowhere late words', [
      createMockResponse([{ type: 'text', text: '>>#cafe next' }]),
    ], async ({ framework, release, drain, turns }) => {
      release();
      for (const end = Date.now() + 5000; turns() < 3 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await drain();
      assert.equal(turns(), 3, "the bounce's wake started a turn");
      const store = draftsOf(framework);
      const late = store.open('assistant').find((d) => d.text === 'late words');
      assert.ok(late, 'the late envelope bounced into a draft');
      const texts = context(framework).texts;
      assert.ok(texts.some((t) => t.startsWith('[prose-routing]') && t.includes(late.id)), 'its bounce notice names it');
      assert.ok(!texts.some((t) => t.includes('that no recent notice on this branch names')), "the catch-up doesn't name it again");
      assert.ok((store.get('assistant', late.id)?.noticedIn ?? []).length > 0, 'it is recorded as noticed');
    });
  });

  it("the non-streaming fallback leaves the scheduling turn's logical turn open for the re-inference", async () => {
    // Adapted from a reviewer's producer test: the agent's direct inference
    // API leaves tools pending with no yielding stream, and the tool result
    // goes through the framework's real event handling.
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const agent = framework.getAgent('assistant')!;
    const internals = framework as unknown as {
      routingOf(name: string): RoutingState;
      openLogical: Map<string, unknown>;
      pendingRequests: InferenceRequest[];
      handleProcessEvent(event: ProcessEvent): Promise<void>;
    };
    const origin = internals.routingOf('assistant');
    origin.continuation = true;
    origin.deliveries.push(stub('chan-alpha'));
    // The turn that ran the tools is open, as its fresh start left it.
    internals.openLogical.set('assistant', origin);
    const response = createMockResponse([
      { type: 'tool_use', id: 'unstreamed-one', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use');
    (membrane as unknown as { stream: () => Promise<typeof response> }).stream = async () => response;
    try {
      agent.getContextManager().addMessage('user', [{ type: 'text', text: 'Take the direct inference path.' }]);
      await agent.runInference(framework.getAllTools());
      assert.equal(agent.state.status, 'waiting_for_tools');
      assert.equal((agent.state as { stream?: unknown }).stream, undefined, 'the direct API has no yielding stream');
      agent.addAssistantResponse(response.content);
      await internals.handleProcessEvent({
        type: 'tool-result', source: 'robot', moduleName: 'robot', agentName: 'assistant', callId: 'unstreamed-one',
        result: { success: true, data: { ok: true } },
      } as ProcessEvent);
      assert.ok(internals.pendingRequests.some((r) => r.reason === 'tool_results_ready'), 'the fallback scheduled the re-inference');
      assert.equal(internals.openLogical.get('assistant'), origin, 'without settling the turn it continues');
    } finally {
      await framework.stop();
    }
  });

  it("a settle closes the open logical turn only when it is the settling stream's own", async () => {
    const framework = await createFramework('hybrid');
    const internals = framework as unknown as {
      openLogical: Map<string, RoutingState>;
      settleAgent(name: string, outcome: { stopReason: 'completed'; speech: string }, closes: RoutingState | undefined): void;
    };
    const open: RoutingState = routingState({ continuation: true });
    const stale: RoutingState = routingState();
    internals.openLogical.set('assistant', open);
    // A settle from a stream a newer one replaced passes its own logical
    // turn, or none; neither closes the open one.
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, stale);
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, undefined);
    assert.equal(internals.openLogical.get('assistant'), open, "a stale settle leaves the newer turn open");
    internals.settleAgent('assistant', { stopReason: 'completed', speech: '' }, open);
    assert.equal(internals.openLogical.has('assistant'), false, "the turn's own settle closes it");
    await framework.stop();
  });

  it('a silent start neither takes nor disturbs an open logical turn, and leaves it to the next start that routes prose', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'quiet' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') turns++;
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
      openLogical: Map<string, RoutingState>;
    };
    try {
      // Everything the open turn has decided about where its speech goes.
      const decided = (): RoutingState => routingState({
        continuation: true, pin: stub('chan-alpha'), hybridHold: 'failed', triggerChannel: stub('chan-alpha'),
        locus: stub('world:commons'), engaged: new Set([destinationKey(stub('discord:g:cafe'))]), wasIn: [],
        arrivals: [{ messageId: 'cafe-message', channel: stub('discord:g:cafe') }],
      });
      const open = decided();
      internals.openLogical.set('assistant', open);
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'heartbeat', source: 'framework', timestamp: Date.now(), suppressProse: true } as InferenceRequest);
      // Bounded: a silent start that took the open turn's ' !' would start a
      // continuation with no response queued, and this would wait for good.
      await within(framework.runUntilIdle(), 'the silent turn to settle', 3000);
      assert.equal(turns, 1);
      const silent = internals.turnRouting.get('assistant');
      assert.notEqual(silent, open, 'the silent start kept a logical turn of its own');
      assert.equal(silent?.locus, undefined, 'with no locus');
      assert.equal(internals.openLogical.get('assistant'), open, 'and neither took nor closed the open one');
      assert.deepEqual(open, decided(), "everything the open turn decided is untouched, its ' !' included");
      // The next start that routes prose continues it, and its ' !' runs.
      // (feedTurn counts starts from here: the prose turn is 1, the
      // continuation 2.)
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]));
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 3 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        await framework.runUntilIdle();
      }
      assert.equal(turns, 3, "the next prose turn continued the open turn and took its ' !'");
    } finally {
      await framework.stop();
    }
  });

  it("a silent turn's resume shows no locus, whatever a channel_open in that turn left on its routing state", async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'quiet' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const typing: string[] = [];
    registry.startTyping = (channel: { channelId: string }) => { typing.push(channel.channelId); };
    const started: Array<string | undefined> = [];
    framework.onTrace((event) => {
      if (event.type === 'inference:started') started.push((event as { channelId?: string }).channelId);
    });
    const internals = framework as unknown as {
      turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
    };
    try {
      // A silent turn opened a channel, which moved its routing state's
      // locus, and its stream then crossed the budget.
      internals.turnRouting.set('assistant', routingState({ locus: stub('discord:g:cafe') }));
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'context_budget_restart', source: 'framework', timestamp: Date.now(), suppressProse: true } as InferenceRequest);
      await within(framework.runUntilIdle(), 'the silent restart', 3000);
      assert.deepEqual(started, [undefined], 'the restart reports no locus');
      assert.deepEqual(typing, [], 'and shows no typing anywhere');
    } finally {
      await framework.stop();
    }
  });

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: the wake that consumes unstreamed tool results continues the turn that scheduled them`, async () => {
      const p = mode === 'explicit' ? '>>' : '>>>';
      membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply carrying on` }] as ContentBlock[]));
      const framework = await createFramework(mode);
      stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 2, [{ type: 'text', text: `${p}skip_reply` }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>;
        openLogical: Map<string, RoutingState>;
      };
      try {
        // The scheduling turn asked for a continuation and left its tool
        // results pending; the scheduler then starts the agent with another
        // wake, which consumes them.
        const scheduling: RoutingState = routingState({ continuation: true });
        internals.openLogical.set('assistant', scheduling);
        internals.turnRouting.set('assistant', routingState());
        trigger(framework);
        await framework.runUntilIdle();
        for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await framework.runUntilIdle();
        }
        assert.equal(turns, 2, "the consuming turn took the scheduling turn's ' !'");
        assert.equal(scheduling.continuation, false);
        assert.equal(internals.openLogical.has('assistant'), false, 'and the turns it ran have settled');
      } finally {
        await framework.stop();
      }
    });
  }

  for (const boundary of ['stop', 'dispose'] as const) {
    it(`a tool-ended explicit turn's late ' !' takes no new turn after ${boundary === 'stop' ? 'stop()' : 'its agent is disposed'}`, async () => {
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: '>>#alpha ! first' },
        { type: 'tool_use', id: 'p1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'p2', name: 'skip_reply', input: {} },
      ] as ContentBlock[], 'tool_use'));
      const framework = await createFramework();
      stubRegistry(framework);
      answerSkipReply(framework);
      const internals = framework as unknown as {
        proseSpeechChains: Map<string, Promise<void>>;
        turnRouting: Map<string, RoutingState>;
        pendingRequests: InferenceRequest[];
        disposeConversationAgent(name: string): void;
      };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      aroundPosts(framework, async () => {
        entered();
        await held;
      });
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the tool-ended turn to settle');
        await within(reached, 'the queued delivery to reach routing');
        const chain = internals.proseSpeechChains.get('assistant')!;
        const routing = internals.turnRouting.get('assistant')!;
        assert.equal(routing.continuation, true, "the held delivery's ' !' is on its turn's object");
        assert.equal(internals.pendingRequests.length, 0);
        if (boundary === 'stop') await framework.stop();
        else internals.disposeConversationAgent('assistant');
        release();
        await within(chain, 'the queued delivery');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(internals.pendingRequests.filter((r) => r.reason === 'prose-continuation').length, 0,
          'the late check adds no request');
        assert.equal(routing.continuation, false, 'it took the flag and dropped it');
      } finally {
        release();
        await framework.stop();
      }
    });
  }

  it("hybrid: a held callback's late malformed envelope holds only its supplied turn", async () => {
    await withHeldHybridCallback('>>>', async ({ earlier, next, routed, gateway, agent, pending, release }) => {
      assert.equal(earlier.hybridHold, undefined, 'the malformed envelope has not run before release');
      release();
      await within(pending, 'the late malformed envelope');
      assert.equal(earlier.hybridHold, 'failed', 'the late hold belongs to the supplied earlier turn');
      assert.equal(next.hybridHold, undefined, 'the newer object stays unheld');
      await gateway.deliverHybridProse(agent, 'next', stub('world:commons'), true, { routing: next, notice: 'later' });
      assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [
        { text: 'first', locus: 'chan-alpha' },
        { text: 'next', locus: 'world:commons' },
      ], 'the newer callback still publishes to its own locus');
    });
  });

  it("hybrid callbacks and receipts keep each turn's counts while a post is held", async () => {
    await withHeldHybridCallback(null, async ({ framework, earlier, next, gateway, agent, pending, release }) => {
      await gateway.deliverHybridProse(agent, 'quiet without a destination', stub('world:commons'), false, { routing: next, notice: 'later' });
      release();
      await within(pending, 'the earlier delivery confirmation');
      gateway.appendProseDeliveryReceipt(agent, earlier);
      gateway.appendProseDeliveryReceipt(agent, next);
      const receipts = context(framework).texts.filter((text) => text.startsWith('[delivered]'));
      assert.equal(receipts.length, 2, 'each supplied turn gets its own receipt');
      const delivered = receipts.find((text) => text.includes('chan-alpha'));
      const held = receipts.find((text) => text.includes('held as draft'));
      assert.ok(delivered, "the earlier turn's delivery is acknowledged");
      assert.doesNotMatch(delivered, /held as draft/, "the earlier receipt excludes the newer turn's held draft");
      assert.ok(held, "the newer turn's held draft is acknowledged");
      assert.match(held, /1 plain-speech segment\(s\) held as draft/);
      assert.doesNotMatch(held, /chan-alpha/, "the newer receipt excludes the earlier delivery");
    });
  });

  it("a private round's ' !' leaves no continuation request behind", async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string, round?: { keepPrivate?: boolean }): Promise<void>;
      turnRouting: Map<string, { continuation: boolean }>;
    };
    const agent = framework.getAgent('assistant')!;

    // When skip_reply ends an explicit turn, the speech chain isn't awaited,
    // so the round's delivery can run once the next turn has begun.
    await internals.deliverProse(agent, '>>#alpha ! kept private', { keepPrivate: true });
    assert.equal(routed.length, 0, 'nothing is delivered');
    assert.equal(internals.turnRouting.get('assistant')?.continuation ?? false, false, 'and no continuation is asked for');

    // The same envelope outside a private round asks for one.
    await internals.deliverProse(agent, '>>#alpha ! sent');
    assert.equal(routed.length, 1);
    assert.equal(internals.turnRouting.get('assistant')?.continuation, true);

    await framework.stop();
  });

  it("in a drafts round, a line with no destination is held with no notice rather than bounced, while a target is delivered and a refused one still bounces (#701)", async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      deliverProse(agent: unknown, text: string, round?: { draftsRound?: boolean }): Promise<void>;
      turnRouting: Map<string, { continuation: boolean; keptPrivate: number }>;
      proseDrafts: ProseDraftStore;
    };
    const agent = framework.getAgent('assistant')!;

    await internals.deliverProse(agent, 'narration beside the call', { draftsRound: true });
    assert.equal(routed.length, 0, 'nothing is delivered');
    assert.equal(context(framework).bounces, 0, 'and nothing bounced');
    assert.deepEqual(internals.proseDrafts.open('assistant').map((d) => [d.text, d.reason]), [['narration beside the call', 'no-destination']],
      'it is held as a draft, so its words are not lost');
    const [held] = internals.proseDrafts.open('assistant');
    const read = await (framework as unknown as {
      handleDraftsTool(agent: string, input: unknown): Promise<{ success: boolean; data?: Array<{ text: string }> }>;
    }).handleDraftsTool('assistant', { action: 'read', draftIds: [held!.id] });
    const readText = (read.data ?? []).map((d) => d.text).join('\n');
    assert.ok(readText.includes('it had no destination: plain speech with no target waits for one'), readText);
    assert.ok(!readText.includes('envelope failed'), 'no envelope failed here, and the cause says none did');

    await internals.deliverProse(agent, '>>#alpha ! a deliberate send', { draftsRound: true });
    assert.deepEqual(routed.map((r) => [r.text, r.locus]), [['a deliberate send', 'chan-alpha']]);
    assert.equal(internals.turnRouting.get('assistant')?.continuation, true, 'its continuation is asked for');

    await internals.deliverProse(agent, '>>#nowhere a send to nowhere', { draftsRound: true });
    assert.equal(context(framework).bounces, 1, 'a refused target still bounces');

    await framework.stop();
  });

  it("in a drafts round, a line with no destination holds its words as a bounce would: {{unsent}} expands, and a bare one is the latest bounce itself (#701)", async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework);
      const internals = framework as unknown as {
        deliverProse(agent: unknown, text: string, round?: { draftsRound?: boolean }): Promise<void>;
        proseDrafts: ProseDraftStore;
      };
      const agent = framework.getAgent('assistant')!;
      const open = () => internals.proseDrafts.open('assistant').map((d) => [d.text, d.reason]).sort();
      await internals.deliverProse(agent, 'lost words');
      assert.deepEqual(open(), [['lost words', 'bounced']], 'outside a drafts round, the line bounces');
      await internals.deliverProse(agent, '{{unsent}}', { draftsRound: true });
      assert.deepEqual(open(), [['lost words', 'bounced']], 'a bare {{unsent}} is that bounce: nothing new is held');
      await internals.deliverProse(agent, 'again: {{unsent}}', { draftsRound: true });
      assert.deepEqual(open(), [['again: lost words', 'no-destination'], ['lost words', 'bounced']], 'the token is expanded');
    } finally {
      await framework.stop();
    }
  });

  it("in a drafts round, a line with no destination that the drafts journal can't hold bounces, and the bounce says so (#701)", async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework);
      const internals = framework as unknown as {
        deliverProse(agent: unknown, text: string, round?: { draftsRound?: boolean }): Promise<void>;
        proseDrafts: ProseDraftStore;
      };
      internals.proseDrafts.hold = () => ({ held: [], notHeld: { count: 1, error: 'ENOSPC: no space left on device' } });
      const agent = framework.getAgent('assistant')!;
      await internals.deliverProse(agent, 'narration beside the call', { draftsRound: true });
      assert.equal(context(framework).bounces, 1, 'it bounces');
      const notice = context(framework).texts.find((t) => t.includes('could not be held as a draft'));
      assert.ok(notice, 'the bounce notice says the words could not be held');
    } finally {
      await framework.stop();
    }
  });

  it("in a drafts round, a deliberate send whose delivery fails still bounces into a draft (#701)", async () => {
    const framework = await createFramework();
    try {
      stubRegistry(framework, ['false']);
      const agent = framework.getAgent('assistant')!;
      const internals = framework as unknown as {
        deliverProse(agent: unknown, text: string, round?: { draftsRound?: boolean }): Promise<void>;
        proseDrafts: ProseDraftStore;
      };
      await internals.deliverProse(agent, '>>#alpha keep these words', { draftsRound: true });
      const held = internals.proseDrafts.open('assistant');
      assert.deepEqual(held.map((d) => [d.text, d.reason]), [['keep these words', 'bounced']]);
    } finally {
      await framework.stop();
    }
  });

  it('a skip_reply round that sets the retained text aside with >>skip_reply {{unsent}} clears it', async () => {
    // Turn 1 bounces its text, which retains it and wakes turn 2.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'An answer with nowhere to go.' }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const skip = answerSkipReply(framework);
    const retained: Array<NonNullable<ReturnType<DraftsView['latestBounce']>>> = [];
    let turns = 0;
    framework.onTrace((event) => {
      if (event.type === 'inference:started' && ++turns === 2) {
        const draft = draftsOf(framework).latestBounce('assistant');
        if (draft) retained.push(draft);
      }
    });
    feedTurn(framework, 2, [
      { type: 'text', text: '>>skip_reply {{unsent}}' },
      { type: 'tool_use', id: 'sr4', name: 'skip_reply', input: {} },
    ] as ContentBlock[], 'tool_use');

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(skip.calls, 1, 'the bounce wake ran the skip_reply round');
    assert.equal(routed.length, 0);
    assert.equal(retained.length, 1, 'turn one really held a bounce before the dismissal');
    assert.equal(retained[0]!.text, 'An answer with nowhere to go.');
    assert.equal(draftState(draftsOf(framework).get('assistant', retained[0]!.id)!), 'dismissed');
    assert.equal(draftsOf(framework).latestBounce('assistant'), undefined, 'the bounced draft is set aside, as >>skip_reply {{unsent}} says');

    await framework.stop();
  });

  it("explicit mode's typing and traces stay on its trigger channel across the turn's rounds", async () => {
    // Explicit mode has no locus: its typing and traces show where the wake
    // came from, and only a locus or hybrid turn's follow a moved locus.
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 't1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>#alpha done' }] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const typing: string[] = [];
    registry.startTyping = (channel: { channelId: string }) => { typing.push(`start ${channel.channelId}`); };
    registry.stopTyping = (channel?: { channelId: string }) => { typing.push(`stop ${channel?.channelId ?? '(all)'}`); };
    const traced = new Set<string | undefined>();
    framework.onTrace((event) => {
      const e = event as { type: string; blockType?: string; channelId?: string };
      if ((e.type === 'inference:tokens' || e.type === 'inference:content_block') && e.blockType === 'text') traced.add(e.channelId);
    });
    const internals = framework as unknown as {
      pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    try {
      internals.pendingRequests.push({
        agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
        channelId: 'chan-alpha', addressed: true,
      });
      await internals.processInferenceRequests();
      await framework.runUntilIdle();

      assert.equal(module.calls.length, 1, 'control: round 1 ran its tool');
      assert.deepEqual(routed, [{ text: 'done', locus: 'chan-alpha' }], 'control: round 2 ran and was delivered');
      assert.ok(typing.includes('start chan-alpha'), `typing showed on the trigger channel: ${JSON.stringify(typing)}`);
      assert.equal(typing.includes('stop chan-alpha'), false, `and stayed there until the turn ended: ${JSON.stringify(typing)}`);
      assert.ok(typing.includes('stop (all)'), 'control: the turn\'s end stopped it');
      assert.deepEqual([...traced], ['chan-alpha'], 'round 2 is traced in the trigger channel');
    } finally {
      await framework.stop();
    }
  });

  it('explicit mode streams nothing before a destination: unprefixed text never reaches the trigger channel', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Unprefixed musing.\n>>#alpha streamed after the prefix' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);
    const stream = captureStream(framework);
    // The unprefixed line bounces, and its wake starts a second turn.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    // A turn the trigger channel woke: chan-alpha is where its typing shows.
    const internals = framework as unknown as {
      pendingRequests: InferenceRequest[];
      processInferenceRequests(): Promise<void>;
    };
    internals.pendingRequests.push({
      agentName: 'assistant', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
      channelId: 'chan-alpha', addressed: true,
    });
    await internals.processInferenceRequests();
    await framework.runUntilIdle();

    const streamed = stream.chunks.map((c) => c.delta).join('');
    assert.ok(streamed.includes('streamed after the prefix'), 'prefixed text streams to its destination');
    assert.equal(streamed.includes('Unprefixed musing.'), false, 'unprefixed text is never streamed');
    assert.equal(stream.completes.some((c) => c.text.includes('Unprefixed musing.')), false,
      'nor finalized by the stream complete');

    await framework.stop();
  });

  it("delivery reads leading whitespace and a token's end before a `>>` prefix", async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as { deliverProse(agent: unknown, text: string): Promise<void> };
    const agent = framework.getAgent('assistant')!;
    const cases = ['  >>#alpha hello', '\u00a0>>#alpha hello', '\u2003>>#alpha hello', '\r>>#alpha hello', '\t>>#alpha\r\nhello'];
    try {
      for (const text of cases) {
        routed.length = 0;
        await gateway.deliverProse(agent, text);
        assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [{ text: 'hello', locus: 'chan-alpha' }],
          `delivery sends the body of ${JSON.stringify(text)} to #alpha`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a `>>>` envelope with no target publishes nothing, so nothing streams, and holds the turn that queued it', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean,
        round: { routing: RoutingState; notice: 'later'; onPublished?: (to: { channelId: string }, text: string) => void }): Promise<void>;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    const cases = ['>>>\r\nsecret', '>>>\nsecret', '>>>\u00a0#alpha secret', '>>> \u00a0#alpha secret'];
    try {
      for (const text of cases) {
        routed.length = 0;
        const queued: RoutingState = routingState();
        const live: RoutingState = routingState();
        gateway.turnRouting.set('assistant', live);
        const streamed: string[] = [];
        await gateway.deliverHybridProse(agent, text, stub('chan-locus'), true,
          { routing: queued, notice: 'later', onPublished: (_channel, body) => streamed.push(body) });
        assert.equal(queued.hybridHold, 'failed', 'the supplied turn receives the hold');
        assert.equal(live.hybridHold, undefined, 'the live turn stays unheld');
        assert.equal(routed.length, 0, `delivery bounces ${JSON.stringify(text)}`);
        assert.deepEqual(streamed, [], `and the stream hears none of ${JSON.stringify(text)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a segment that is only `>>>`, or `>>>` and a gap, holds back the next segment, from delivery and the stream alike', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean,
        round: { routing: RoutingState; notice: 'later'; onPublished?: (to: { channelId: string }, text: string) => void }): Promise<void>;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    try {
      for (const prefix of ['>>>', '>>> ', '>>>\t']) {
        routed.length = 0;
        const queued: RoutingState = routingState();
        const live: RoutingState = routingState();
        gateway.turnRouting.set('assistant', live);
        const streamed: Array<{ channelId: string; text: string }> = [];
        const round = {
          routing: queued,
          notice: 'later' as const,
          onPublished: ({ channelId }: { channelId: string }, text: string) => { streamed.push({ channelId, text }); },
        };
        await gateway.deliverHybridProse(agent, '>>>#alpha first', stub('chan-locus'), true, round);
        await gateway.deliverHybridProse(agent, prefix, stub('chan-locus'), true, round);
        await gateway.deliverHybridProse(agent, 'secret', stub('chan-locus'), true, round);
        assert.deepEqual(queued.deliveries, [stub('chan-alpha')], 'the supplied turn records its delivery');
        assert.ok(queued.drafts.some((d) => d.text === 'secret'), 'the supplied turn holds the held-back segment as its draft');
        assert.deepEqual(live.deliveries, [], 'the live turn receives no delivery');
        assert.deepEqual(live.drafts, [], 'the live turn holds no draft');
        assert.deepEqual(routed.map((r) => r.text), ['first'], `delivery sends only first, after ${JSON.stringify(prefix)}`);
        assert.deepEqual(streamed, [{ channelId: 'chan-alpha', text: 'first' }],
          `and the stream hears first, where it was published, and holds secret back after ${JSON.stringify(prefix)}`);
      }
    } finally {
      await framework.stop();
    }
  });

  const sendWhereUnknown = { places: new Map(), unknown: { tool: 'send_message', why: 'no-channel', round: 0 } };

  it('hybrid: a hold beside a send writes the routing and drafts of its own round, not the live turn\'s', async () => {
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const gateway = framework as unknown as {
      routeSilencedHybrid(agent: unknown, segments: string[], sends: unknown, draftsCause: boolean, round: { routing: RoutingState; notice: 'later' }, locus: ChannelRef | null, when: number): Promise<boolean>;
      turnRouting: Map<string, RoutingState>;
    };
    const agent = framework.getAgent('assistant')!;
    try {
      const queued: RoutingState = routingState();
      const live: RoutingState = routingState();
      gateway.turnRouting.set('assistant', live);
      // A held round that a later start has overtaken: its envelopes move
      // its own turn's routing, and its drafts are that turn's.
      await gateway.routeSilencedHybrid(agent, ['>>>#nowhere held words', 'after it'], sendWhereUnknown, false, { routing: queued, notice: 'later' }, null, 0);
      assert.equal(queued.hybridHold, 'failed', 'the round that held it records the failed envelope');
      assert.deepEqual(queued.drafts.map((d) => d.text), ['held words', 'after it'], "and holds the round's words as its drafts");
      assert.equal(live.hybridHold, undefined, 'the live turn is untouched');
      assert.deepEqual(live.drafts, [], 'and holds no draft of that round');
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a hold beside a send refuses a >>> target its server declared inbound-only, as delivery does, and drops the pin before it', async () => {
    const framework = await createFramework('hybrid');
    stubRegistry(framework);
    const gateway = framework as unknown as {
      routeSilencedHybrid(agent: unknown, segments: string[], sends: unknown, draftsCause: boolean, round: { routing: RoutingState; notice: 'later' }, locus: ChannelRef | null, when: number): Promise<boolean>;
    };
    const agent = framework.getAgent('assistant')!;
    try {
      // An earlier round of the turn pinned #alpha.
      const routing: RoutingState = routingState({ pin: stub('chan-alpha') });
      await gateway.routeSilencedHybrid(agent, ['>>>#ears for the room', 'after it'], sendWhereUnknown, false, { routing, notice: 'later' }, null, 0);
      assert.equal(routing.pin, undefined, 'the inbound-only channel is never pinned, and the earlier pin is dropped');
      assert.equal(routing.hybridHold, 'failed', 'the envelope fails as a refused target does at delivery');
      assert.deepEqual(routing.drafts.map((d) => d.text), ['for the room', 'after it'], 'and the words are held as drafts');
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: after >>>skip_reply, the next unprefixed envelope stays in the context and counts as kept private', async () => {
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    const gateway = framework as unknown as {
      deliverHybridProse(agent: unknown, text: string, locus: ChannelRef | null, allowLocus: boolean, round: { routing: RoutingState; notice: 'later' }): Promise<void>;
    };
    const agent = framework.getAgent('assistant')!;
    try {
      const routing: RoutingState = routingState();
      await gateway.deliverHybridProse(agent, '>>>skip_reply an aside', stub('chan-locus'), true, { routing, notice: 'later' });
      await gateway.deliverHybridProse(agent, 'still private', stub('chan-locus'), true, { routing, notice: 'later' });
      assert.deepEqual(routed, [], 'nothing is sent');
      assert.equal(routing.hybridHold, 'private');
      assert.equal(routing.keptPrivate, 1, 'the unprefixed envelope after it is counted as kept private');
      assert.deepEqual(routing.drafts, [], 'and is never drafted');
      assert.deepEqual(draftsOf(framework).open('assistant'), [], 'the journal holds nothing either');
    } finally {
      await framework.stop();
    }
  });

  it("a refused {{unsent}} says when the envelope's own words couldn't be held", async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{ text: 'earlier words' }], 'bounced').held[0]!;
      // An attempt with no outcome: the latest bounce may already have been
      // posted, so {{unsent}} refuses it and holds the envelope's words.
      store.beginAttempt('assistant', original.id, { serverId: 'stub', channelId: 'chan-alpha' }, 'unsent-token', false);
      // The journal refuses the envelope's words.
      store.hold = ((_agent: string, segments: unknown[]) =>
        ({ held: [], notHeld: { count: segments.length, error: 'the journal refused the write' } })) as typeof store.hold;
      const gateway = framework as unknown as { deliverProse(a: unknown, text: string): Promise<void> };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}} and a line');
      assert.deepEqual(routed, [], 'nothing is sent');
      const notice = context(framework).texts.find((t) => t.startsWith('[prose-routing] {{unsent}} is draft'))!;
      assert.ok(notice.includes('Your message could not be held as a draft; its words remain in your history.'), notice);
      assert.deepEqual(noticeOf(framework, '[prose-routing] {{unsent}} is draft')?.draftIds, [original.id],
        'the notice names the refused draft in its metadata too, so the catch-up counts it as named');
    } finally {
      await framework.stop();
    }
  });

  it('the receipt names every draft it records, past eight', async () => {
    const framework = await createFramework('hybrid');
    try {
      stubRegistry(framework);
      const store = draftsOf(framework);
      const held = store.hold('assistant', Array.from({ length: 11 }, (_, segment) => ({
        text: `held ${segment}`,
      })), 'explicit-send').held;
      const gateway = framework as unknown as { appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void };
      const routing: RoutingState = routingState({ drafts: held });
      gateway.appendProseDeliveryReceipt(framework.getAgent('assistant')!, routing);
      const receipt = context(framework).texts.find((t) => t.startsWith('[delivered]'))!;
      for (const draft of held) assert.ok(receipt.includes(draft.id), `${draft.id} is named: ${receipt}`);
      assert.doesNotMatch(receipt, /and \d+ more/, 'none is left as a count');
      assert.deepEqual([...(noticeOf(framework, '[delivered]')?.draftIds ?? [])].sort(), held.map((d) => d.id).sort(),
        'its metadata names every draft, so settlement records each one');
    } finally {
      await framework.stop();
    }
  });

  it("words a send held back that the journal refuses are reported in the receipt", async () => {
    const framework = await createFramework('hybrid');
    try {
      stubRegistry(framework);
      const store = draftsOf(framework);
      store.hold = ((_agent: string, segments: unknown[]) =>
        ({ held: [], notHeld: { count: segments.length, error: 'the journal refused the write' } })) as typeof store.hold;
      const gateway = framework as unknown as {
        routeSilencedHybrid(agent: unknown, segments: string[], sends: unknown, draftsCause: boolean, round: { routing: RoutingState; notice: 'later' }, locus: ChannelRef | null, when: number): Promise<boolean>;
        appendProseDeliveryReceipt(agent: unknown, routing: RoutingState): void;
      };
      const agent = framework.getAgent('assistant')!;
      const routing: RoutingState = routingState();
      await gateway.routeSilencedHybrid(agent, ['first words', 'second words'], sendWhereUnknown, false, { routing, notice: 'later' }, null, 0);
      gateway.appendProseDeliveryReceipt(agent, routing);
      const receipt = context(framework).texts.find((t) => t.startsWith('[delivered]'))!;
      assert.ok(receipt.includes('2 plain-speech segment(s) suppressed and NOT held as drafts (the journal refused the write) — ' +
        'the words remain only in your history'), receipt);
    } finally {
      await framework.stop();
    }
  });

  it("an {{unsent}} send whose outcome can't be recorded says so in a notice that names its draft", async () => {
    const framework = await createFramework();
    try {
      const routed = stubRegistry(framework);
      const store = draftsOf(framework);
      const original = store.hold('assistant', [{ text: 'earlier words' }], 'bounced').held[0]!;
      store.recordOutcome = (() => { throw new Error('the journal refused the write'); }) as typeof store.recordOutcome;
      const gateway = framework as unknown as { deliverProse(a: unknown, text: string): Promise<void> };
      await gateway.deliverProse(framework.getAgent('assistant')!, '>>#alpha {{unsent}}');
      assert.deepEqual(routed.map((r) => r.text), ['earlier words'], 'the words were sent');
      const notice = context(framework).texts.find((t) => t.startsWith(`[prose-routing] {{unsent}} was draft ${original.id};`))!;
      assert.ok(notice.includes('but recording that failed'), notice);
      assert.deepEqual(noticeOf(framework, `[prose-routing] {{unsent}} was draft ${original.id};`)?.draftIds, [original.id],
        'it names the draft in its metadata, so the catch-up counts it as named');
    } finally {
      await framework.stop();
    }
  });

  it('admission turns a resolver that throws into an envelope that bounces', async () => {
    const framework = await createFramework();
    const routed = stubRegistry(framework);
    const internals = framework as unknown as {
      channelRegistry: { resolveProseTarget: (spec: string) => unknown };
      admitProse(text: string, routing: RoutingState): Array<{ text: string; resolved?: { channelId?: string; error?: string } }>;
      deliverAdmittedProse(agent: unknown, envelopes: unknown[], round: { routing: RoutingState }): Promise<void>;
      routingOf(name: string): RoutingState;
    };
    const resolve = internals.channelRegistry.resolveProseTarget.bind(internals.channelRegistry);
    internals.channelRegistry.resolveProseTarget = (spec: string) => {
      if (spec === '#boom') throw new Error('directory unavailable');
      return resolve(spec);
    };
    try {
      const admitted = internals.admitProse('>>#boom one\n>>#alpha two', internals.routingOf('assistant'));
      assert.match(admitted[0]!.resolved?.error ?? '', /directory unavailable/);
      await internals.deliverAdmittedProse(framework.getAgent('assistant')!, admitted, { routing: internals.routingOf('assistant') });
      assert.deepEqual(routed.map((r) => r.text), ['two'], 'the other envelope still goes out');
    } finally {
      await framework.stop();
    }
  });

  it("' !' continuation starts another turn immediately after prose ends the current one", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha ! step one done, continuing' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    feedTurn(framework, 2, [{ type: 'text', text: '>>#alpha step two done' }] as ContentBlock[]);

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 2, 'a second inference ran without any external event');
    assert.deepEqual(routed.map((r) => r.text), ['step one done, continuing', 'step two done']);
    assert.deepEqual(routed.map((r) => r.locus), ['chan-alpha', 'chan-alpha']);

    await framework.stop();
  });

  it('appends the mode primer exactly once across turns', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha hello' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    stubRegistry(framework);

    const primers: number[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source === 'prose-routing-primer') primers.push(1);
    });

    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'primer on first explicit turn');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha again' },
    ] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(primers.length, 1, 'no re-priming on later turns');

    await framework.stop();
  });

  it('the hybrid and locus primers say plain text goes to the locus unless its server declared that channel inbound-only', async () => {
    const framework = await createFramework('hybrid');
    const agent = framework.getAgent('assistant')!;
    const prime = (framework as unknown as { maybePrimeProseMode(agent: unknown): void }).maybePrimeProseMode.bind(framework);
    prime(agent);
    // The agent's mode is set from its config; a later config change is what
    // brings the locus primer.
    (agent as unknown as { proseRouting: string }).proseRouting = 'locus';
    prime(agent);
    const primers = agent.getContextManager().getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text)
      .filter(t => t.startsWith('[prose-routing]'));
    assert.equal(primers.length, 2, String(primers));
    assert.match(primers[0]!, /^\[prose-routing\] Hybrid routing enabled: unprefixed text still lands in the current conversational locus, unless its server declared that channel inbound-only\. /);
    assert.match(primers[1]!, /^\[prose-routing\] Mode change: your plain text auto-routes to the conversational locus again, unless its server declared that channel inbound-only\. /);
    await framework.stop();
  });

  it('prose_help tool returns the routing reference on demand', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'c1', name: 'prose_help', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha got it' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const stream = membrane.lastStream!;
    assert.equal(stream.receivedToolResults.length, 1);
    const strings: string[] = [];
    JSON.stringify(stream.receivedToolResults[0], (_key, value) => {
      if (typeof value === 'string') strings.push(value);
      return value;
    });
    // The help is the agent's only full reference for a destination's rule,
    // so each of its clauses is pinned, read across the text's line breaks.
    // The result's content is the help as a JSON string, so it's decoded first.
    const decoded = strings.map((s) => {
      try {
        const value: unknown = JSON.parse(s);
        return typeof value === 'string' ? value : s;
      } catch {
        return s;
      }
    });
    const help = decoded.join(' ').replace(/\s+/g, ' ');
    for (const clause of [
      'A destination applies to the rest of that turn, until another is named.',
      'A name that matches no channel, or several, bounces and leaves it as it was.',
      'A channel its server declared inbound-only is refused, and clears it.',
      'Where two servers register one channel id, the server goes first: >>server:service:guild:id … (a bounce lists each such name).',
      "Within a turn, the id of a channel the turn has been in means that channel, on its server, and bounces once that server no longer registers it; where two of the turn's channels have the id, it means neither and bounces.",
    ]) {
      assert.ok(help.includes(clause), `the help says: ${clause}`);
    }
    assert.deepEqual(routed, [{ text: 'got it', locus: 'chan-alpha' }]);

    await framework.stop();
  });

  /** A registry stub for the closed-channel note: the agent closed #cafe,
   *  laria's DM is closed and nobody decided about it, and #alpha is open,
   *  all on discord. */
  function closedNoteRegistry(framework: AgentFramework, held?: Promise<void> | ((locus: string | null) => Promise<void> | undefined)) {
    const routed: Array<{ text: string; locus: string | null }> = [];
    const known: Record<string, { channelId: string; label: string }> = {
      '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
      '#cafe': { channelId: 'discord:g:cafe', label: '#cafe' },
      '@laria': { channelId: 'discord:dm:99', label: 'DM: laria' },
    };
    const labels: Record<string, string> = { 'chan-alpha': '#alpha', 'discord:g:cafe': '#cafe', 'discord:dm:99': 'DM: laria' };
    type Ref = { serverId: string; channelId: string };
    const deliverSpeech = async (_agent: string, text: string, locus?: Ref | null) => {
      routed.push({ text, locus: locus?.channelId ?? null });
      const wait = typeof held === 'function' ? held(locus?.channelId ?? null) : held;
      if (wait) await wait;
      return { status: 'delivered' as const, destination: { serverId: 'discord', channelId: locus?.channelId ?? '' }, at: Date.now() };
    };
    const registry: Record<string, unknown> = {
      resolveProseTarget: (spec: string) => (known[spec] ? { serverId: 'discord', ...known[spec] } : { error: `no channel matches "${spec}"` }),
      deliverSpeech,
      routeSpeech: async (agent: string, text: string, locus?: Ref | null) => {
        const outcome = await deliverSpeech(agent, text, locus);
        return { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId };
      },
      resolveLocus: () => ({ serverId: 'discord', channelId: 'chan-alpha' }),
      getDefaultPublishChannel: () => null,
      isChannelOpen: (c: Ref) => c.channelId === 'chan-alpha',
      closedByAgent: (c: Ref) => (c.channelId === 'discord:g:cafe' ? 'closed' : undefined),
      directsLifecycle: () => true,
      nameShown: (c: Ref) => c.channelId,
      getDescriptor: (c: Ref) => (labels[c.channelId] ? { label: labels[c.channelId] } : undefined),
      getChannelServerId: () => 'discord',
      getChannelTools: () => [],
    };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
      get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
    });
    return routed;
  }

  const CAFE_NOTE = "[closed channel] #cafe (discord:g:cafe) stays closed: you closed it, and your words there don't open it. " +
    'Messages there that address you, such as an @-mention, still reach you. ' +
    'channel_open with channelId "discord:g:cafe" and serverId "discord" opens it. ' +
    'To stop this note, set closed_channel_note to false with agent_settings.';

  function windowTexts(framework: AgentFramework): string[] {
    return framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
  }

  it("speech into a channel the agent closed ends the turn with the closed-channel note alone, and anywhere else gets none", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe hello there\n>>@laria and you\n>>#alpha and everyone' },
    ] as ContentBlock[]));
    const framework = await createFramework();
    const routed = closedNoteRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed.map((r) => r.locus), ['discord:g:cafe', 'discord:dm:99', 'chan-alpha']);
    const texts = windowTexts(framework);
    assert.deepEqual(texts.filter((t) => t.startsWith('[closed channel]')), [CAFE_NOTE]);
    assert.ok(!texts.some((t) => t.startsWith('[delivered]')), 'explicit mode still has no delivery line');
    await framework.stop();
  });

  it('speech into a closed channel twice in one turn gets its note once', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe hello there\n>>#alpha and everyone\n>>#cafe and again' },
    ] as ContentBlock[]));
    const framework = await createFramework();
    const routed = closedNoteRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed.map((r) => r.locus), ['discord:g:cafe', 'chan-alpha', 'discord:g:cafe']);
    assert.deepEqual(windowTexts(framework).filter((t) => t.startsWith('[closed channel]')), [CAFE_NOTE]);
    await framework.stop();
  });

  it('a turn a tool ends gets the note once its speech has been delivered', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe heading out now' },
      { type: 'tool_use', id: 'e1', name: 'robot--move', input: { dir: 'out' } },
    ] as ContentBlock[], 'tool_use'));
    const framework = await createFramework();
    const routed = closedNoteRegistry(framework);
    // The move ends the turn, as skip_reply does, without keeping its round's prose private.
    module.handleToolCall = async (call: ToolCall): Promise<ToolResult> => {
      module.calls.push(call);
      return { success: true, endTurn: true, data: { ok: true } };
    };

    trigger(framework);
    await framework.runUntilIdle();
    for (const end = Date.now() + 5000; !windowTexts(framework).includes(CAFE_NOTE) && Date.now() < end;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(module.calls.length, 1, 'the move ended the turn');
    assert.deepEqual(routed.map((r) => r.locus), ['discord:g:cafe']);
    assert.deepEqual(windowTexts(framework).filter((t) => t.startsWith('[closed channel]')), [CAFE_NOTE]);
    await framework.stop();
  });

  it("a tool-ended turn's note waits while the next turn runs, and is written once it ends", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe heading out now' },
      { type: 'tool_use', id: 'e1', name: 'robot--move', input: { dir: 'out' } },
    ] as ContentBlock[], 'tool_use'));
    let release!: () => void;
    const framework = await createFramework();
    const routed = closedNoteRegistry(framework, new Promise<void>((resolve) => { release = resolve; }));
    module.handleToolCall = async (call: ToolCall): Promise<ToolResult> => {
      module.calls.push(call);
      return { success: true, endTurn: true, data: { ok: true } };
    };
    let turns = 0;
    framework.onTrace((e) => { if ((e as { type: string }).type === 'inference:started') turns++; });
    // The next turn answers with nothing to deliver.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);

    // A failure lets the held post go and stops the framework, so the file still ends.
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(module.calls.length, 1, 'the move ended the first turn while its speech was still being delivered');
      trigger(framework);
      // The next turn's end waits behind the held post, so it can't go idle yet.
      const idle = framework.runUntilIdle();
      for (const end = Date.now() + 5000; turns < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(turns, 2, 'the next turn has started');
      release();
      await idle;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      assert.deepEqual(routed.map((r) => r.locus), ['discord:g:cafe']);
      const texts = windowTexts(framework);
      assert.deepEqual(texts.filter((t) => t.startsWith('[closed channel]')), [CAFE_NOTE], 'the note is given once');
      assert.ok(texts.indexOf(CAFE_NOTE) > texts.lastIndexOf('>>skip_reply'),
        "it comes after the next turn's own words: that turn never saw it");
    } finally {
      release();
      await framework.stop();
    }
  });

  it("a note due while the next turn's tool call runs waits for that call, and that turn is shown it", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe heading out now' },
      { type: 'tool_use', id: 'e1', name: 'robot--move', input: { dir: 'out' } },
    ] as ContentBlock[], 'tool_use'));
    let releaseCafe!: () => void;
    const cafe = new Promise<void>((resolve) => { releaseCafe = resolve; });
    let releaseMove!: () => void;
    const secondMove = new Promise<void>((resolve) => { releaseMove = resolve; });
    const framework = await createFramework();
    closedNoteRegistry(framework, (locus) => (locus === 'discord:g:cafe' ? cafe : undefined));
    // The first move ends its turn, as skip_reply does; the next turn's move waits until released.
    module.handleToolCall = async (call: ToolCall): Promise<ToolResult> => {
      module.calls.push(call);
      if (module.calls.length === 1) return { success: true, endTurn: true, data: { ok: true } };
      await secondMove;
      return { success: true, data: { ok: true } };
    };
    let turns = 0;
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started' || ++turns !== 2) return;
      // The next turn moves back, then has nothing more to say.
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'e2', name: 'robot--move', input: { dir: 'back' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]));
    });
    const deferred = () => (framework as unknown as { deferredMessages: Array<{ content: Array<{ text?: string }> }> })
      .deferredMessages.filter((m) => m.content.some((b) => b.text === CAFE_NOTE));

    // A failure lets the held post and move go and stops the framework, so the file still ends.
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(module.calls.length, 1, 'the move ended the first turn while its speech was still being delivered');
      trigger(framework);
      const idle = framework.runUntilIdle();
      for (const end = Date.now() + 5000; module.calls.length < 2 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(module.calls.length, 2, "the next turn's move is running");
      releaseCafe();
      for (const end = Date.now() + 5000; deferred().length === 0 && Date.now() < end;) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(deferred().length, 1, 'the note is due, and held');
      assert.ok(!windowTexts(framework).includes(CAFE_NOTE), "it isn't written while that turn's move runs");
      releaseMove();
      await idle;

      assert.deepEqual(windowTexts(framework).filter((t) => t.startsWith('[closed channel]')), [CAFE_NOTE], 'the note is given once');
      const shown = membrane.lastStream!.receivedToolResultOptions
        .flatMap((options) => options?.injectedMessages ?? [])
        .some((message) => (message.content as Array<{ text?: string }>).some((block) => block.text === CAFE_NOTE));
      assert.ok(shown, "the next turn is shown it with its move's result");
    } finally {
      releaseCafe();
      releaseMove();
      await framework.stop();
    }
  });

  it("in hybrid mode, speech into a channel the agent closed ends the turn's delivery line with the note", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe hello there' },
    ] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = closedNoteRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed.map((r) => r.locus), ['discord:g:cafe']);
    const delivered = windowTexts(framework).filter((t) => t.startsWith('[delivered]'));
    assert.equal(delivered.length, 1, delivered.join('\n'));
    assert.ok(delivered[0]!.endsWith(` · ${CAFE_NOTE.slice('[closed channel] '.length)}`), delivered[0]);
    assert.ok(!windowTexts(framework).some((t) => t.startsWith('[closed channel]')), 'the delivery line carries it');
    await framework.stop();
  });

  it('multi-envelope prose: each >> line routes independently (Tilde scenario)', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha part one for the channel\n>>@laria part two, just for you\nwith a second line\n>> quoted arrow stays in body' },
    ] as ContentBlock[]));

    const framework = await createFramework();
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'part one for the channel', locus: 'chan-alpha' },
      { text: 'part two, just for you\nwith a second line\n>> quoted arrow stays in body', locus: 'discord:dm:99' },
    ], 'two envelopes, two destinations; quoted arrow not split');

    await framework.stop();
  });


  it('hybrid preserves authored >>> envelope, publishes only body cross-surface, and records canonical receipt', async () => {
    const authored = '>>>#cafe\nA message meant for the café.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'A message meant for the café.', locus: 'discord:g:cafe' }]);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'source/author view retains exact envelope');
    assert.ok(texts.includes('[delivered] plain speech → discord:g:cafe'), 'canonical destination receipt enters context');
    await framework.stop();
  });

  for (const [mode, authored] of [
    ['hybrid', '>>>#ears\nHello, room.'],
    ['explicit', '>>#ears Hello, room.'],
  ] as const) {
    it(`${mode}: a target its server declared inbound-only bounces with that reason and publishes nothing`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      feedTurn(framework, 2, [{ type: 'text', text: (mode === 'hybrid' ? '>>>' : '>>') + 'skip_reply {{unsent}}' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [], 'nothing was published');
      const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages().flatMap(m => m.content)
        .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
      const bounce = texts.find(t => t.startsWith('[prose-routing]') && t.includes('not delivered'));
      assert.ok(bounce, 'the text bounced');
      assert.ok(bounce!.includes('body:ears is inbound-only: server "body" declared'), `the bounce gives the declaration: ${bounce}`);
      assert.ok(!bounce!.includes('was not confirmed'), `the bounce doesn't call it an unconfirmed delivery: ${bounce}`);
      await framework.stop();
    });
  }

  it("explicit: a target refused for speech clears the turn's destination, so later unprefixed text bounces rather than going to the earlier one", async () => {
    // Anarchid's probe (agent-framework#350, R1-1): the turn names #alpha,
    // then #ears, which its server declared inbound-only, then writes on
    // without a prefix. That text was meant for the room, not #alpha.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#ears for the room' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'and more for the room' },
    ] as ContentBlock[]));
    const framework = await createFramework('explicit');
    const routed = stubRegistry(framework);
    // The wakes the bounces ask for set the retained text aside.
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'first', locus: 'chan-alpha' }], 'only the text before the refusal was published');
    const bounces = framework.getAgent('assistant')!.getContextManager().getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text)
      .filter(t => t.startsWith('[prose-routing]') && t.includes('not delivered'));
    assert.ok(bounces.some(t => t.includes('body:ears is inbound-only')), `the refused target bounced with its reason: ${bounces.join(' | ')}`);
    assert.ok(bounces.some(t => t.includes('this turn has no destination now')), `the later unprefixed text bounced: ${bounces.join(' | ')}`);
    await framework.stop();
  });

  it("explicit: text routed to a channel its server declared inbound-only isn't streamed there, or sent at the stream's end", async () => {
    // The round's delivery refuses #ears and bounces its text. The stream
    // took it as it was written, and its end would send it should the server
    // lift the declaration before the stream ends.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#ears for the room' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha done' },
    ] as ContentBlock[]));
    const framework = await createFramework('explicit');
    stubRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.inboundOnlyServer = (channel: { channelId: string }) => (channel.channelId === 'body:ears' ? 'body' : undefined);
    const chunks: Array<{ channelId: string; delta: string }> = [];
    const completes: Array<{ channelId: string; text: string }> = [];
    registry.sendOutgoingChunk = (to: { serverId: string; channelId: string }, _agent: string, _inference: string, _index: number, delta: string) => {
      chunks.push({ channelId: streamedAt(to), delta });
    };
    registry.sendOutgoingComplete = (to: { serverId: string; channelId: string }, _agent: string, _inference: string, text: string) => {
      completes.push({ channelId: streamedAt(to), text });
    };
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(chunks.filter((c) => c.channelId === 'body:ears'), [], 'nothing is streamed to the inbound-only channel');
    assert.deepEqual(completes, [{ channelId: 'chan-alpha', text: 'done' }], "the stream's end sends only what the stream routed and kept");
    await framework.stop();
  });

  for (const refusal of ['inbound-only', 'inbound-only, unconfirmed', 'another failure', 'another failure, unconfirmed', 'delivered, then declared'] as const) {
    const inboundOnly = refusal.startsWith('inbound-only');
    it(`explicit: a delivery that ${refusal === 'delivered, then declared' ? 'is delivered while the channel turns inbound-only' : `fails (${refusal})`} ${inboundOnly ? "clears the turn's destination, as a refusal at admission does" : 'keeps the destination, as before'}`, async () => {
      // #alpha resolves when the round is admitted. By its delivery, its
      // server has declared it inbound-only (as a channels/changed, or the
      // answer to opening it, can), or the publish fails some other way.
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: '>>#alpha first' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'and more' },
      ] as ContentBlock[]));
      const framework = await createFramework('explicit');
      const routed = stubRegistry(framework);
      const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
      const declared = new Set<string>();
      registry.inboundOnlyServer = (channel: { channelId: string }) => (declared.has(channel.channelId) ? 'body' : undefined);
      // The turn's routing, as its first delivery sees it.
      let turn: { pin?: ChannelRef } | undefined;
      registry.deliverSpeech = async (_agent: string, text: string, to?: ChannelRef | null) => {
        turn ??= (framework as unknown as { turnRouting: Map<string, { pin?: ChannelRef }> }).turnRouting.get('assistant');
        const locus = to?.channelId;
        routed.push({ text, locus: locus ?? null });
        if (inboundOnly || refusal === 'delivered, then declared') declared.add(locus ?? '');
        const destination = { serverId: to?.serverId ?? 'stub', channelId: locus ?? '' };
        if (refusal === 'delivered, then declared') return { status: 'delivered', destination, at: Date.now() };
        // A publish that may have been posted, as one that timed out may.
        if (refusal.endsWith('unconfirmed')) return { status: 'unknown', destination, reason: 'channels/publish timed out (delivery uncertain)', at: Date.now() };
        return { status: 'failed', destination, reason: inboundOnly ? 'inbound-only: server "body" declared it' : 'stub refused', at: Date.now() };
      };
      feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      const bounces = context(framework).texts.filter((t) => t.startsWith('[prose-routing]') && t.includes('not delivered'));
      if (inboundOnly) {
        assert.deepEqual(routed, [{ text: 'first', locus: 'chan-alpha' }], 'the later text never went to the refused channel');
        assert.ok(bounces.some((t) => t.includes('this turn has no destination now')), `the later text bounced: ${bounces.join(' | ')}`);
        assert.equal(turn?.pin, undefined, 'the destination later text would follow ends');
      } else {
        assert.deepEqual(routed, [{ text: 'first', locus: 'chan-alpha' }, { text: 'and more', locus: 'chan-alpha' }]);
        // Each failed delivery bounces its own words; none bounces for want of a destination.
        assert.equal(bounces.filter((t) => t.includes('delivery to chan-alpha failed')).length, refusal === 'another failure' ? 2 : 0);
        assert.equal(bounces.some((t) => t.includes('this turn has no destination now')), false);
        assert.deepEqual(turn?.pin, stub('chan-alpha'));
      }
      await framework.stop();
    });
  }

  it('explicit: a refusal at delivery leaves the pin when another delivery has moved it off the refused channel', async () => {
    // The pin ends only while it still names the refused channel. Here
    // another delivery (as a replaced stream's queued one can) moves it to
    // #cafe during #alpha's delivery, so it stays.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'and more' },
    ] as ContentBlock[]));
    const framework = await createFramework('explicit');
    const routed = stubRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const declared = new Set<string>();
    registry.inboundOnlyServer = (channel: { channelId: string }) => (declared.has(channel.channelId) ? 'body' : undefined);
    let turn: { pin?: ChannelRef } | undefined;
    let atFailure: { pin?: ChannelRef } | undefined;
    registry.deliverSpeech = async (_agent: string, text: string, to?: ChannelRef | null) => {
      turn ??= (framework as unknown as { turnRouting: Map<string, { pin?: ChannelRef }> }).turnRouting.get('assistant');
      const locus = to?.channelId;
      routed.push({ text, locus: locus ?? null });
      const destination = { serverId: to?.serverId ?? 'stub', channelId: locus ?? '' };
      if (locus === 'chan-alpha') {
        turn!.pin = stub('discord:g:cafe');
        atFailure = { pin: turn!.pin };
        declared.add('chan-alpha');
        return { status: 'failed', destination, reason: 'inbound-only: server "body" declared it', at: Date.now() };
      }
      return { status: 'delivered', destination, at: Date.now() };
    };
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(atFailure, { pin: stub('discord:g:cafe') }, 'the state the clear met');
    assert.deepEqual(turn?.pin, stub('discord:g:cafe'), 'the moved pin stays');
    assert.deepEqual(routed, [{ text: 'first', locus: 'chan-alpha' }, { text: 'and more', locus: 'discord:g:cafe' }]);
    await framework.stop();
  });

  it("explicit: a delivery refused while a later round waits behind it leaves that round its own destination", async () => {
    // Greta-2425's probe. Deliveries queue behind each other, and the turn
    // goes on without waiting, so round 2's >>#cafe is admitted before round
    // 1's delivery to #alpha fails. The clear ends only the pin #alpha set,
    // and round 2's delivery then pins #cafe for the text after it.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha first' },
      { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#cafe second' },
      { type: 'tool_use', id: 'c2', name: 'robot--move', input: { dir: 'south' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'and more' },
    ] as ContentBlock[]));
    const framework = await createFramework('explicit');
    const routed = stubRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const declared = new Set<string>();
    registry.inboundOnlyServer = (channel: { channelId: string }) => (declared.has(channel.channelId) ? 'body' : undefined);
    const turnOf = () => (framework as unknown as { turnRouting: Map<string, { pin?: ChannelRef }> }).turnRouting.get('assistant');
    let turn: { pin?: ChannelRef } | undefined;
    // MockMembrane gives a turn's rounds to its one stream, so a round's
    // tool calls, not the membrane's calls, show how far the turn has got.
    let toolRounds = 0;
    framework.onTrace((e) => { if ((e as { type: string }).type === 'inference:tool_calls_yielded') toolRounds++; });
    let roundsAtFailure = 0;
    registry.deliverSpeech = async (_agent: string, text: string, to?: ChannelRef | null) => {
      turn ??= turnOf();
      const locus = to?.channelId;
      routed.push({ text, locus: locus ?? null });
      const destination = { serverId: to?.serverId ?? 'stub', channelId: locus ?? '' };
      if (locus === 'chan-alpha') {
        // Hold #alpha's delivery until round 2 is admitted, as its tool calls
        // show, then refuse it: its server has declared it inbound-only by
        // now.
        const deadline = Date.now() + 3000;
        while (toolRounds < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        roundsAtFailure = toolRounds;
        declared.add('chan-alpha');
        return { status: 'failed', destination, reason: 'inbound-only: server "body" declared it', at: Date.now() };
      }
      return { status: 'delivered', destination, at: Date.now() };
    };
    feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(roundsAtFailure >= 2, `round 2 was admitted before #alpha refused (${roundsAtFailure} tool rounds)`);
    assert.deepEqual(routed, [
      { text: 'first', locus: 'chan-alpha' },
      { text: 'second', locus: 'discord:g:cafe' },
      { text: 'and more', locus: 'discord:g:cafe' },
    ]);
    assert.deepEqual(turn?.pin, stub('discord:g:cafe'));
    await framework.stop();
  });

  for (const [final, kept] of [['>>#ears ! for the room', false], ['>>#cafe ! for the room', true]] as const) {
    it(`explicit: a turn's final text (${kept ? 'its target kept' : 'its target refused'}) reaches nothing of its ' !' continuation, which starts a turn of its own`, async () => {
      // The turn's final text is delivered after the turn settles, so its
      // pin doesn't carry into the continuation: that's a new turn, with no
      // destination.
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: '>>#alpha first' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: final },
      ] as ContentBlock[]));
      const framework = await createFramework('explicit');
      const routed = stubRegistry(framework);
      const stream = captureStream(framework);
      feedTurn(framework, 2, [{ type: 'text', text: 'and more for the room' }] as ContentBlock[]);
      feedTurn(framework, 3, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
      feedTurn(framework, 4, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      // The first turn makes two calls, its tool round and its final text.
      assert.ok(membrane.calls.length >= 3, `the continuation ran (${membrane.calls.length} calls)`);
      assert.deepEqual(routed, kept
        ? [{ text: 'first', locus: 'chan-alpha' }, { text: 'for the room', locus: 'discord:g:cafe' }]
        : [{ text: 'first', locus: 'chan-alpha' }]);
      const continuation = stream.chunks.filter((c) => c.delta.includes('and more')).map((c) => c.channelId);
      assert.deepEqual(continuation, [], 'the continuation streamed nothing anywhere');
      assert.equal(stream.completes.some((c) => c.text.includes('and more')), false);
      const bounces = context(framework).texts.filter((t) => t.startsWith('[prose-routing]') && t.includes('not delivered'));
      assert.ok(bounces.some((t) => t.includes('this turn has no destination now')), `the continuation's text bounced: ${bounces.join(' | ')}`);
      await framework.stop();
    });
  }

  it('hybrid leaves unprefixed prose on the frozen locus', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Ordinary field speech.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Ordinary field speech.', locus: 'world:commons' }]);
    await framework.stop();
  });

  it('hybrid accepts permissive whitespace but missing targets bounce and publish nowhere', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '  >>>   #missing\nDo not guess.' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content)
      .filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('not delivered') && t.includes('>>>#<channel> {{unsent}}')));
    await framework.stop();
  });


  it('hybrid keeps an explicit target sticky across tool-round segments in the same turn', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe first segment' },
      { type: 'tool_use', id: 'hc1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'second segment, no repeated envelope' },
    ] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'first segment', locus: 'discord:g:cafe' },
      { text: 'second segment, no repeated envelope', locus: 'discord:g:cafe' },
    ]);
    await framework.stop();
  });


  it('hybrid target-only envelope establishes the sticky destination for the next tool-round segment', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>>#cafe' },
      { type: 'tool_use', id: 'hc2', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'body follows' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'body follows', locus: 'discord:g:cafe' }]);
    await framework.stop();
  });


  it('hybrid >>>skip_reply clears a sticky target until a fresh valid envelope', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'sk1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>skip_reply hidden' }, { type: 'tool_use', id: 'sk2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'sk3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
    await framework.stop();
  });

  for (const failure of ['false', 'throw'] as const) {
    it(`hybrid ${failure} delivery clears sticky authority, suppresses later prose, and a fresh target resumes`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#cafe first' }, { type: 'tool_use', id: 'fl1', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>#alpha fails' }, { type: 'tool_use', id: 'fl2', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'plain text must remain suppressed' }, { type: 'tool_use', id: 'fl3', name: 'robot--move', input: { dir: 'north' } }] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: '>>>world:commons recovered' }] as ContentBlock[]));
      const framework = await createFramework('hybrid');
      const routed = stubRegistry(framework, ['delivered', failure, 'delivered']);
      feedTurn(framework, 2, [{ type: 'text', text: '>>>skip_reply {{unsent}}' }] as ContentBlock[]);
      trigger(framework);
      await framework.runUntilIdle();
      assert.equal(routed.some(r => r.text.includes('plain text must remain suppressed')), false);
      assert.deepEqual(routed.filter(r => r.text !== 'fails'), [{ text: 'first', locus: 'discord:g:cafe' }, { text: 'recovered', locus: 'world:commons' }]);
      const cm = framework.getAgent('assistant')!.getContextManager();
      const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
      if (failure === 'throw') {
        // A plain send that threw is marker-only: nothing is held, and the
        // notice offers no {{unsent}}.
        const notice = texts.find(t => t.startsWith('[prose-routing]') && t.includes('fails'.length + ' chars'))!;
        assert.match(notice, /may not have been delivered/);
        assert.match(notice, /isn't held as a draft/);
        assert.doesNotMatch(notice, /\{\{unsent\}\}/);
        assert.equal(draftsOf(framework).open('assistant').some(d => d.text === 'fails'), false);
      } else {
        assert.ok(texts.some(t => t.includes('[prose-routing]') && t.includes('>>>#<channel> {{unsent}}')));
      }
      await framework.stop();
    });
  }


  it('hybrid same-round successful say tool outranks a contradictory prose envelope', async () => {
    const authored = '>>>#cafe wrong-locus duplicate';
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: authored },
      { type: 'tool_use', id: 'say1', name: 'robot--say', input: { text: 'Hello Sill in the world' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tool completed' }] as ContentBlock[]));
    const framework = await createFramework('hybrid');
    const routed = stubRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.equal(module.calls.filter(c => c.name === 'say' || c.name.endsWith('--say')).length, 1);
    assert.deepEqual(routed, []);
    const cm = framework.getAgent('assistant')!.getContextManager();
    const texts = cm.getAllMessages().flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored));
    assert.ok(texts.some(t => t.startsWith('[delivered] nothing') && /2 plain-speech segment\(s\) held as drafts d-[a-z2-9]{7}, d-[a-z2-9]{7}/.test(t)));
    // The held words are the envelope's body, not its routing syntax; the
    // destination the resident wrote stays with the draft as a note.
    const drafts = (framework as unknown as { proseDrafts: { open(a: string): Array<{ text: string; note?: string; reason: string }> } })
      .proseDrafts.open('assistant').reverse();
    assert.deepEqual(drafts.map(d => [d.text, d.note, d.reason]), [
      ['wrong-locus duplicate', 'written for >>>#cafe', 'explicit-send'],
      ['tool completed', 'written for discord:g:cafe', 'explicit-send'],
    ]);
    await framework.stop();
  });


  it('disabled mode suppresses text-only prose without a bounce, primer, or channel delivery', async () => {
    const authored = 'Internal continuity summary that must never publish.';
    membrane.pushResponse(createMockResponse([{ type: 'text', text: authored }] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);
    const sources: string[] = [];
    framework.onTrace((e) => {
      const ev = e as { type: string; source?: string };
      if (ev.type === 'message:added' && ev.source) sources.push(ev.source);
    });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'disabled prose never reaches a channel');
    assert.equal(sources.includes('prose-bounce'), false, 'disabled prose does not bounce');
    assert.equal(sources.includes('prose-routing-primer'), false, 'disabled mode injects no model-visible primer');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.includes(authored), 'authored prose remains in Chronicle');
    assert.ok(texts.includes('[delivered] plain speech → no channel — 1 plain-speech segment(s) kept in the transcript (proseRouting=disabled — post to a channel only with an explicit send tool)'),
      'the private receipt says the prose went to no channel and stays in the transcript');

    await framework.stop();
  });

  it('disabled mode ignores destination prefixes but explicit publish tools still execute', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: '>>#alpha this prefix must not bypass disabled mode' },
      { type: 'tool_use', id: 'd1', name: 'robot--say', input: { text: 'published explicitly' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'trailing prose must also remain private' },
    ] as ContentBlock[]));
    const framework = await createFramework('disabled');
    const routed = stubRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'neither prefixed nor trailing prose routed');
    assert.equal(module.calls.length, 1, 'explicit tool call executed');
    assert.equal(module.calls[0]!.name, 'say');
    const texts = framework.getAgent('assistant')!.getContextManager().getAllMessages()
      .flatMap(m => m.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text);
    assert.ok(texts.some(t => t.includes('[delivered] plain speech → no channel') && t.includes('2 plain-speech segment(s) kept in the transcript')),
      'one receipt accounts for mid-turn and trailing prose');

    await framework.stop();
  });

  // ---- A start that continues a logical turn keeps the turn's routing ----
  // A framework retry after a stream error, the compile a provider-capacity
  // hold defers a turn to, and the re-inference that consumes unstreamed tool
  // results each continue the turn: the sticky destination and hybrid's hold
  // carry into the new stream, which streams what its deliveries publish.

  /** An organization acceleration 429, which holds the turn for a later compile. */
  const accelerationLimit = (request: NormalizedRequest): MembraneError => new MembraneError({
    type: 'rate_limit', retryable: true, httpStatus: 429,
    message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
    rawError: { status: 429 }, rawRequest: request,
  });

  /**
   * A turn whose first stream writes `first` and calls a tool, and then
   * fails instead of completing: with a transient error, which the framework
   * retries, or with an acceleration 429, which holds the turn until a later
   * compile. That later stream answers `carrying on` with no prefix, as a
   * model continuing its turn would.
   */
  async function continueTurn(how: 'retry' | 'capacity', mode: 'explicit' | 'hybrid', first: string) {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: first },
      { type: 'tool_use', id: 'continued-tool', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const framework = await createFramework(mode, {}, how === 'retry' ? retryAtOnce : undefined);
    const routed = stubRegistry(framework);
    const { chunks } = captureStream(framework);
    const internals = framework as unknown as {
      providerAccelerationCooldowns: Map<string, { until: number }>;
      releaseProviderAccelerationCooldown(agentName: string): void;
    };
    let starts = 0;
    let laterChunks = 0;
    framework.onTrace((event) => {
      if (event.type !== 'inference:started') return;
      starts++;
      if (starts === 2) {
        laterChunks = chunks.length;
        membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }]));
      }
      // A bounce wakes the resident; that turn stays quiet.
      if (starts >= 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: mode === 'explicit' ? '>>skip_reply' : '>>>skip_reply' }]));
    });
    const makeStream = membrane.streamYielding.bind(membrane);
    let streams = 0;
    membrane.streamYielding = (request, options) => {
      const stream = makeStream(request, options);
      const index = ++streams;
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterate }) {
          if (event.type === 'complete' && index === 1) {
            yield {
              type: 'error' as const,
              error: how === 'retry' ? new Error('synthetic transient stream error') : accelerationLimit(request),
            };
            return;
          }
          yield event;
        }
      };
      return stream;
    };
    trigger(framework);
    await within(framework.runUntilIdle(), 'the first stream', 10000);
    if (how === 'capacity') {
      assert.equal(starts, 1, 'the hold defers the turn rather than retrying it at once');
      const admission = (framework.healthSnapshot() as { agents: Array<{ name: string; providerAdmission: { cooldownReason: string | null } }> })
        .agents.find((agent) => agent.name === 'assistant')!.providerAdmission;
      assert.notEqual(admission.cooldownReason, null, 'the turn is held');
      // What the cooldown's timer does when it fires, at the hold's deadline.
      internals.providerAccelerationCooldowns.get('assistant')!.until = Date.now();
      internals.releaseProviderAccelerationCooldown('assistant');
      await within(framework.runUntilIdle(), 'the deferred compile', 10000);
    }
    assert.ok(starts >= 2, 'the turn went on in a later stream');
    return { framework, routed, bounces: context(framework).bounces, laterChunks: chunks.slice(laterChunks) };
  }

  for (const how of ['retry', 'capacity'] as const) {
    const start = how === 'retry' ? 'an error retry' : 'the compile a capacity hold defers the turn to';
    for (const [label, mode, first, expected] of [
      ['hybrid >>>skip_reply keeps later unprefixed prose private', 'hybrid', '>>>skip_reply an aside', []],
      ['hybrid >>>#alpha is sticky', 'hybrid', '>>>#alpha first', [{ text: 'first', locus: 'chan-alpha' }, { text: 'carrying on', locus: 'chan-alpha' }]],
      ['explicit >>#alpha is sticky, and the later stream streams where delivery publishes', 'explicit', '>>#alpha first', [{ text: 'first', locus: 'chan-alpha' }, { text: 'carrying on', locus: 'chan-alpha' }]],
    ] as const) {
      it(`across ${start}, ${label}`, async () => {
        const { framework, routed, bounces, laterChunks } = await continueTurn(how, mode, first);
        try {
          // Publication as the registry stub saw it; bounce notices by their kind.
          assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), expected);
          assert.equal(bounces, 0, 'nothing bounced');
          // In every mode, the later stream streams what it published, where
          // it published it: nothing under a hold, and its unprefixed text at
          // the sticky destination.
          assert.deepEqual(laterChunks.map((c) => ({ text: c.delta, locus: c.channelId })),
            expected.filter((post) => post.text === 'carrying on'));
        } finally {
          await framework.stop();
        }
      });
    }
  }

  for (const [label, mode, left, expected] of [
    ['hybrid: the hold keeps later unprefixed prose private', 'hybrid', { hybridHold: 'private', locus: stub('world:commons') }, []],
    ['hybrid: the sticky destination', 'hybrid', { pin: stub('chan-alpha'), locus: stub('world:commons') }, [{ text: 'carrying on', locus: 'chan-alpha' }]],
    ['explicit: the sticky destination, and the stream streams where delivery publishes', 'explicit', { pin: stub('chan-alpha') }, [{ text: 'carrying on', locus: 'chan-alpha' }]],
  ] as const) {
    it(`a re-inference on unstreamed tool results keeps the turn's routing: ${label}`, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      const { chunks } = captureStream(framework);
      // A bounce wakes the resident; that turn stays quiet.
      feedTurn(framework, 2, [{ type: 'text', text: mode === 'explicit' ? '>>skip_reply' : '>>>skip_reply' }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
        openLogical: Map<string, RoutingState>;
      };
      try {
        // The turn's earlier stream left this routing state, and its tool
        // results pending for the non-streaming fallback's re-inference.
        const earlier = routingState(left);
        internals.turnRouting.set('assistant', earlier);
        internals.openLogical.set('assistant', earlier);
        internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
        await within(framework.runUntilIdle(), 'the re-inference', 10000);
        assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), expected);
        assert.equal(context(framework).bounces, 0, 'nothing bounced');
        // In every mode, the re-inference streams what it published, where it
        // published it.
        assert.deepEqual(chunks.map((c) => ({ text: c.delta, locus: c.channelId })), expected);
      } finally {
        await framework.stop();
      }
    });
  }

  for (const unreadable of [false, true]) {
    const name = unreadable
      ? "explicit: a turn with no locus doesn't read its arrival's message, so a store that can't be read leaves its next start alone"
      : "explicit: an addressed message between the turn's streams moves nothing, since explicit mode has no locus";
    it(name, async () => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }] as ContentBlock[]));
      const framework = await createFramework('explicit');
      const routed = stubRegistry(framework);
      feedTurn(framework, 2, [{ type: 'text', text: '>>skip_reply' }] as ContentBlock[]);
      const internals = framework as unknown as {
        turnRouting: Map<string, RoutingState>; pendingRequests: InferenceRequest[];
        openLogical: Map<string, RoutingState>;
        addMessage(participant: string, content: ContentBlock[], metadata: Record<string, unknown>): string;
      };
      const cm = framework.getAgent('assistant')!.getContextManager();
      const getMessage = cm.getMessage.bind(cm);
      try {
        const earlier = routingState({ pin: stub('chan-alpha') });
        internals.turnRouting.set('assistant', earlier);
        internals.openLogical.set('assistant', earlier);
        // Someone addresses the agent from another channel while the turn waits.
        internals.addMessage('Antra', [{ type: 'text', text: 'quick question for you' }] as ContentBlock[],
          { channelId: 'discord:g:cafe', tags: ['chat:addressed'] });
        assert.deepEqual(earlier.arrivals.map((a) => a.channel), [stub('discord:g:cafe')], 'it is the turn\'s arrival, on its server');
        if (unreadable) {
          const arrival = earlier.arrivals[0]!.messageId;
          cm.getMessage = (id) => {
            if (id === arrival) throw new Error('store unavailable');
            return getMessage(id);
          };
        }
        internals.pendingRequests.push({ agentName: 'assistant', reason: 'tool_results_ready', source: 'framework', timestamp: Date.now() } as InferenceRequest);
        await within(framework.runUntilIdle(), 'the re-inference', 10000);

        assert.deepEqual(routed.map((r) => ({ text: r.text.trim(), locus: r.locus })), [{ text: 'carrying on', locus: 'chan-alpha' }]);
        assert.equal(earlier.locus, undefined, 'no locus');
        assert.deepEqual(earlier.arrivals, [], 'the arrival is used up');
        assert.ok(!context(framework).texts.some((t) => t.includes('The conversation moved to')), 'and no routing notice');
      } finally {
        cm.getMessage = getMessage;
        await framework.stop();
      }
    });
  }

  for (const mode of ['explicit', 'hybrid'] as const) {
    it(`${mode}: a retried turn's text waits for the replaced stream's late deliveries, and follows what they set`, async () => {
      const p = mode === 'explicit' ? '>>' : '>>>';
      // The first stream's round one posts to #cafe, and the post is held.
      // Round two sets where the turn goes next (explicit: #alpha; hybrid: a
      // skip_reply hold); its delivery is queued behind the held post. Then
      // the stream errors, and its retry starts while both are pending.
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: `${p}#cafe zero` },
        { type: 'tool_use', id: 'late-one', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: mode === 'explicit' ? '>>#alpha first' : '>>>skip_reply an aside' },
        { type: 'tool_use', id: 'late-two', name: 'robot--move', input: { dir: 'south' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));
      const framework = await createFramework(mode, {}, retryAtOnce);
      const routed = stubRegistry(framework);
      const { chunks } = captureStream(framework);
      const internals = framework as unknown as { turnRouting: Map<string, RoutingState> };
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      // A named target's post goes through deliverSpeech, so hold it on both paths.
      aroundPosts(framework, async (text) => {
        if (text.trim() === 'zero') await held;
      });
      let starts = 0;
      framework.onTrace((event) => {
        if (event.type !== 'inference:started') return;
        starts++;
        if (starts === 2) {
          membrane.pushResponse(createMockResponse([{ type: 'text', text: 'carrying on' }]));
        }
        if (starts >= 3) membrane.pushResponse(createMockResponse([{ type: 'text', text: `${p}skip_reply` }]));
      });
      let retryCompleted!: () => void;
      const retryComplete = new Promise<void>((resolve) => { retryCompleted = resolve; });
      const makeStream = membrane.streamYielding.bind(membrane);
      let streams = 0;
      membrane.streamYielding = (request, options) => {
        const stream = makeStream(request, options);
        const index = ++streams;
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          for await (const event of { [Symbol.asyncIterator]: iterate }) {
            if (event.type === 'complete' && index === 1) {
              yield { type: 'error' as const, error: new Error('synthetic transient stream error') };
              return;
            }
            if (event.type === 'complete' && index === 2) retryCompleted();
            yield event;
          }
        };
        return stream;
      };
      let running: Promise<void> | undefined;
      try {
        trigger(framework);
        running = framework.runUntilIdle();
        void running.catch(() => {});
        await within(retryComplete, 'the retry to finish its response', 10000);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        assert.equal(starts, 2, 'the retry has started');
        assert.deepEqual(routed.map((r) => r.text.trim()), ['zero'], "the retry's text waits behind the held post");
        const routing = internals.turnRouting.get('assistant')!;
        if (mode === 'explicit') {
          assert.deepEqual(routing.pin, stub('discord:g:cafe'), "round two's delivery hasn't run yet");
        } else {
          assert.equal(routing.hybridHold, undefined, "round two's delivery hasn't run yet");
        }
        release();
        await within(running, 'the retried turn to settle', 10000);
        const posts = routed.map((r) => ({ text: r.text.trim(), locus: r.locus }));
        if (mode === 'explicit') {
          assert.deepEqual(posts, [
            { text: 'zero', locus: 'discord:g:cafe' },
            { text: 'first', locus: 'chan-alpha' },
            { text: 'carrying on', locus: 'chan-alpha' },
          ], "the replaced stream's posts go first, and the retry's text follows the destination they set");
          assert.deepEqual(chunks.map((c) => ({ text: c.delta.trim(), locus: c.channelId })), [
            { text: 'zero', locus: 'discord:g:cafe' },
            { text: 'first', locus: 'chan-alpha' },
            { text: 'carrying on', locus: 'chan-alpha' },
          ], "every chunk follows its publish: the replaced stream's late posts, then the retry's text at the destination they set");
        } else {
          assert.deepEqual(posts, [{ text: 'zero', locus: 'discord:g:cafe' }],
            "the retry's unprefixed text stays private under the hold the late delivery set");
          assert.deepEqual(chunks.map((c) => ({ text: c.delta.trim(), locus: c.channelId })), [{ text: 'zero', locus: 'discord:g:cafe' }],
            "only the late post streams: the retry's held text doesn't");
          const receipt = context(framework).texts.filter((t) => t.startsWith('[delivered]'));
          assert.equal(receipt.length, 1, `one receipt for the logical turn: ${receipt.join(' | ')}`);
          assert.match(receipt[0]!, /discord:g:cafe/, "it reports the replaced stream's late post");
          assert.match(receipt[0]!, /1 plain-speech segment\(s\) kept private/, "and the retry's segment the hold kept private");
        }
        assert.equal(context(framework).bounces, 0, 'nothing bounced');
      } finally {
        release();
        if (running) await running;
        await framework.stop();
      }
    });
  }

  // The bounce-wake cap (PROSE_BOUNCE_WAKE_CAP = 2) stops a bounce → wake →
  // bounce loop. Its count used to reset only when a prose envelope was
  // delivered, so a resident that recovered from each bounce some other way
  // (a send tool, setting the draft aside) kept the count across turns, and
  // from the third bounce on, a reply to a fresh message bounced with no wake.
  for (const mode of ['explicit', 'hybrid'] as const) {
    const prefix = mode === 'explicit' ? '>>' : '>>>';
    // Words that bounce in each mode: unprefixed prose in explicit mode; in
    // hybrid, where unprefixed prose goes to the locus, a target that names
    // no channel.
    const bouncing = (n: number): string => mode === 'explicit' ? `reply ${n}` : `>>>#nowhere reply ${n}`;
    const setAside = `${prefix}skip_reply {{unsent}}`;

    it(`${mode}: a turn with a cause of its own resets the bounce-wake count, so recovering without a prose delivery doesn't silence later bounces`, async () => {
      const framework = await createFramework(mode);
      const routed = stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      // Three messages. Each reply bounces; each bounce wake sets the draft
      // aside instead of delivering prose.
      feedTurn(framework, 1, [{ type: 'text', text: bouncing(1) }] as ContentBlock[]);
      feedTurn(framework, 2, [{ type: 'text', text: setAside }] as ContentBlock[]);
      feedTurn(framework, 3, [{ type: 'text', text: bouncing(2) }] as ContentBlock[]);
      feedTurn(framework, 4, [{ type: 'text', text: setAside }] as ContentBlock[]);
      feedTurn(framework, 5, [{ type: 'text', text: bouncing(3) }] as ContentBlock[]);
      feedTurn(framework, 6, [{ type: 'text', text: setAside }] as ContentBlock[]);
      try {
        for (let message = 1; message <= 3; message++) {
          trigger(framework);
          await framework.runUntilIdle();
          assert.equal(turns, message * 2, `message ${message}: its reply bounced and the bounce woke the agent`);
        }
        assert.equal(routed.length, 0, 'nothing was delivered');
        assert.equal(context(framework).bounces, 3, 'three bounce notices');
      } finally {
        await framework.stop();
      }
    });

    it(`${mode}: a bounce loop with no other cause still stops waking after two bounces`, async () => {
      const framework = await createFramework(mode);
      stubRegistry(framework);
      let turns = 0;
      framework.onTrace((e) => {
        if ((e as { type: string }).type === 'inference:started') turns++;
      });
      feedTurn(framework, 1, [{ type: 'text', text: bouncing(1) }] as ContentBlock[]);
      feedTurn(framework, 2, [{ type: 'text', text: bouncing(2) }] as ContentBlock[]);
      feedTurn(framework, 3, [{ type: 'text', text: bouncing(3) }] as ContentBlock[]);
      // Were the third bounce to wake, this turn would run: it answers, so
      // the test fails on the count rather than hanging.
      feedTurn(framework, 4, [{ type: 'text', text: setAside }] as ContentBlock[]);
      try {
        trigger(framework);
        await framework.runUntilIdle();
        assert.equal(turns, 3, 'the message, then two bounce wakes; the third bounce wakes nothing');
        assert.equal(context(framework).bounces, 3, 'every bounce still leaves its notice');
      } finally {
        await framework.stop();
      }
    });
  }

});
