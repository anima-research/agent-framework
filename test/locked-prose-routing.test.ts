/**
 * Locked prose routing (AgentConfig.proseRouting 'locked'): an agent's plain
 * speech goes to one destination it chose, on every turn but a private one, and nothing moves it
 * but its own prose_locus call — not the channel a turn came from, an
 * addressed message mid-turn, a heartbeat, or the host's locus rule. Pointed
 * at drafts (or with no destination yet), plain speech is held as drafts,
 * but for a private turn's, which is held as none.
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
  AgentConfig,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, YieldingStream } from '@animalabs/membrane';

/** A tool module whose `move` can push a message mid-turn, as a chat reply arriving while a tool runs. */
class RobotModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  interjection: { text: string; metadata: Record<string, unknown> } | null = null;
  /** Runs inside the next `move` call, while the turn waits on it. */
  during: (() => Promise<void>) | null = null;
  /** Every call this module ran, by tool name. */
  ran: string[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      { name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
      // A send tool by its bare name, as the framework reads it (SILENCING_TOOLS).
      { name: 'send_message', description: 'Send a message', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.ran.push(call.name);
    const during = this.during;
    this.during = null;
    if (during) await during();
    if (this.interjection) {
      const { text, metadata } = this.interjection;
      this.interjection = null;
      this.framework!.pushEvent({ type: 'external-message', source: 'test', content: text, metadata } as unknown as ProcessEvent);
    }
    return { success: true, data: { ok: true, tool: call.name } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content);
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    return {
      addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) }],
      requestInference: text === 'go',
    };
  }
}

const CHANNELS: Record<string, string> = {
  '#main': 'discord:g:main',
  '#ops': 'discord:g:ops',
  '@antra': 'discord:dm:antra',
};

/** A registry stand-in: names resolve by CHANNELS, deliveries are recorded, and resolveLocus counts its calls. */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const state = {
    locusCalls: 0,
    /** Each resolveProseTarget call's options: own channels by id, and forSpeech. */
    targets: [] as Array<{ spec: string; forSpeech?: boolean; own: string[] }>,
  };
  const explicit: Record<string, unknown> = {
    resolveLocus: () => {
      state.locusCalls++;
      return { serverId: 'stub', channelId: 'discord:g:lounge' };
    },
    resolveProseTarget: (spec: string, opts?: { forSpeech?: boolean; own?: Array<{ channelId: string }> }) => {
      state.targets.push({ spec, forSpeech: opts?.forSpeech, own: (opts?.own ?? []).map((c) => c.channelId) });
      if (spec === '#dup') return { error: '"#dup" names more than one channel', candidates: ['#dup (one)', '#dup (two)'] };
      return CHANNELS[spec]
        ? { serverId: 'stub', channelId: CHANNELS[spec], label: spec }
        : { error: `no channel matches "${spec}"` };
    },
    routeSpeech: async (_agent: string, text: string, locus?: { serverId: string; channelId: string } | null) => {
      routed.push({ text, locus: locus?.channelId ?? null });
      return locus ? { delivered: true, serverId: locus.serverId, channelId: locus.channelId } : null;
    },
    // A drafts resend: the destination it names, then its delivery.
    resolveDestination: (target: { serverId: string; channelId: string }) => ({ destination: { serverId: target.serverId, channelId: target.channelId } }),
    deliverSpeech: async (_agent: string, text: string, to: { serverId: string; channelId: string }) => {
      routed.push({ text, locus: to.channelId });
      return { status: 'delivered', destination: to, messageId: `m-${routed.length}` };
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    channelsNamed: (name: string) => [{ serverId: 'stub', channelId: name }],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return { routed, state };
}

type Stored = { content: Array<{ type: string; text?: string }> };

/** The stream as membrane's XML tool path gives it: no `roundContent`, so prose is routed only at the turn's end. */
function withoutRoundContent(stream: YieldingStream): YieldingStream {
  return new Proxy(stream, {
    get(target, key) {
      if (key === Symbol.asyncIterator) {
        return async function* () {
          for await (const event of target as AsyncIterable<{ type: string; context?: object }>) {
            yield event.type === 'tool-calls' ? { ...event, context: { ...event.context, roundContent: undefined } } : event;
          }
        };
      }
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The held draft ids a receipt names, in order. */
function draftIds(receipt: string): string[] {
  return receipt.match(/d-[a-z0-9]+/g) ?? [];
}

describe('locked prose routing', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: RobotModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
    membrane = new MockMembrane();
    module = new RobotModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(
    agent: Partial<AgentConfig> = {},
    options: { speech?: { locus: 'delivery' | 'latest-inbound' } } = {},
  ): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.', proseRouting: 'locked', ...agent }],
      modules: [module],
      ...(options.speech ? { speech: options.speech } : {}),
    });
    module.framework = framework;
    return framework;
  }

  /** A turn woken by an addressed message in #lounge, which locus mode would answer there. */
  function trigger(framework: AgentFramework): void {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'go',
      metadata: { channelId: 'discord:g:lounge', serverId: 'stub', tags: ['chat:addressed'] },
    } as unknown as ProcessEvent);
  }

  function windowTexts(framework: AgentFramework): string[] {
    const cm = framework.getAgent('assistant')!.getContextManager();
    return (cm.getAllMessages() as unknown as Stored[])
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
  }

  function toolResultTexts(): string[] {
    return membrane.lastStream!.receivedToolResults.flat().map((r) => JSON.stringify(r));
  }

  it('plain speech goes to the lock, not the channel the turn came from, and the switch is primed once', async () => {
    // One stream takes every response queued, so each turn's is queued after the last turn.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello from the lock.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed, state } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still here.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [
      { text: 'Hello from the lock.', locus: 'discord:g:main' },
      { text: 'Still here.', locus: 'discord:g:main' },
    ]);
    assert.equal(state.locusCalls, 0, 'a locked turn never asks the registry for a locus');
    const primers = windowTexts(framework).filter((t) => t.startsWith('[prose-routing]'));
    assert.deepEqual(primers, [
      '[prose-routing] Locked routing: your plain speech goes to discord:g:main, on every turn, until you move it with prose_locus, ' +
        'except while a message from a surface with no channel (such as a console, the TUI or an API call) is unanswered or is the ' +
        "newest message you've had, or on a turn that continues one where that held: then it goes to no channel. " +
        'The channel a message comes from no longer moves it; other channels need an explicit send tool.',
    ]);
    assert.ok(!windowTexts(framework).some((t) => t.startsWith('[routing]')), 'no locus announcements');
    await framework.stop();
  });

  it('an addressed message mid-turn moves nothing, under either locus rule, and the agent is told', async () => {
    for (const locus of ['delivery', 'latest-inbound'] as const) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
      membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Moving north.' },
        { type: 'tool_use', id: 'c1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Arrived.' }] as ContentBlock[]));
      const framework = await createFramework({ proseLock: '#main' }, { speech: { locus } });
      const { routed } = stubChannelRegistry(framework);
      module.interjection = { text: 'psst, over here', metadata: { channelId: 'discord:dm:antra', serverId: 'stub', tags: ['chat:addressed'] } };

      trigger(framework);
      await framework.runUntilIdle();

      assert.deepEqual(routed, [
        { text: 'Moving north.', locus: 'discord:g:main' },
        { text: 'Arrived.', locus: 'discord:g:main' },
      ], `${locus}: the lock holds`);
      const wired = membrane.lastStream!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? [])
        .map((m) => JSON.stringify(m.content));
      assert.ok(
        wired.some((s) => s.includes('addressed you from discord:dm:antra while you were busy. ' +
          'Your plain speech still lands in discord:g:main; reaching them takes an explicit send.')),
        `${locus}: the addressed-elsewhere notice rode the injection batch`,
      );
      assert.ok(!wired.some((s) => s.includes('The conversation moved to')), `${locus}: no re-pin notice`);
      await framework.stop();
    }
  });

  it('prose_locus moves the lock from the next round, for later turns, and across a restart', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Heading to ops.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Now in ops.' }] as ContentBlock[]));
    let framework = await createFramework({ proseLock: '#main' });
    let { routed, state } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech now goes to discord:g:ops, on this turn') && t.includes('later turns')),
      'the result says where speech goes now',
    );
    // The target resolves as speech does, with the turn's own channels (here
    // its lock) taking precedence.
    const asked = state.targets.find((t) => t.spec === '#ops');
    assert.equal(asked?.forSpeech, true);
    assert.deepEqual(asked?.own, ['discord:g:main']);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Next turn, still ops.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'Heading to ops.', locus: 'discord:g:main' },
      { text: 'Now in ops.', locus: 'discord:g:ops' },
      { text: 'Next turn, still ops.', locus: 'discord:g:ops' },
    ]);
    // The next turn confirms where its speech lands, once: a rewind of the
    // exchange can't leave the agent untold.
    assert.deepEqual(windowTexts(framework).filter((t) => t.startsWith('[routing]')),
      ['[routing] Your plain speech now lands in discord:g:ops. Other channels need an explicit send tool.']);
    await framework.stop();

    // The choice outlives the process, and outranks the recipe's proseLock.
    membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'After the restart.' }] as ContentBlock[]));
    framework = await createFramework({ proseLock: '#main' });
    ({ routed } = stubChannelRegistry(framework));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'After the restart.', locus: 'discord:g:ops' }]);
    await framework.stop();
  });

  it('pointed at drafts, plain speech is held as drafts, posted nowhere, and named in the receipt', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Last public word.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: 'drafts' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Thinking aloud, unposted.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Last public word.', locus: 'discord:g:main' }]);
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech is now held as drafts')),
      'the result says speech is held as drafts',
    );
    const receipts = windowTexts(framework).filter((t) => t.startsWith('[delivered]'));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!, /^\[delivered\] plain speech → discord:g:main · 1 plain-speech segment\(s\) held as draft d-/);
    assert.ok(!windowTexts(framework).some((t) => t.startsWith('[drafts]')), 'no per-round draft notice');
    // The draft holds the words, open for a resend (prose-drafts.test.ts
    // covers the resend itself).
    const [id] = draftIds(receipts[0]!);
    const listed = await framework.executeToolCall({ id: 'l', name: 'drafts', input: { action: 'list' }, callerAgentName: 'assistant' } as ToolCall);
    const shown = JSON.stringify(listed);
    assert.ok(shown.includes(id!) && shown.includes('Thinking aloud, unposted.'), `the open draft holds the words: ${shown}`);
    await framework.stop();
  });

  it('with no lock chosen and no proseLock, plain speech is held as drafts', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Nowhere to go yet.' }] as ContentBlock[]));
    const framework = await createFramework();
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'nothing was posted');
    const texts = windowTexts(framework);
    assert.ok(texts.some((t) => t.startsWith('[prose-routing] Locked routing: your plain speech is held as drafts')), 'the primer says so');
    assert.ok(texts.some((t) => /^\[delivered\] nothing — 1 plain-speech segment\(s\) held as draft d-/.test(t)), 'the receipt names the draft');
    await framework.stop();
  });

  it('a heartbeat turn speaks into the lock', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Beat.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Beat.', locus: 'discord:g:main' }]);
    assert.ok(!windowTexts(framework).some((t) => t.includes('This turn came from your heartbeat')), 'no heartbeat no-channel notice');
    await framework.stop();

    // The control: the same request opens a heartbeat's turn, which locus
    // mode tells it has no channel. (This stub registry gives every locus
    // turn a channel, so what it posts proves nothing here.)
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
    membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Beat.' }] as ContentBlock[]));
    const locus = await createFramework({ proseRouting: 'locus' });
    stubChannelRegistry(locus);
    (locus as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'assistant', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(),
    });
    await locus.runUntilIdle();
    assert.ok(windowTexts(locus).some((t) => t.includes('This turn came from your heartbeat')), "it's a heartbeat's turn");
    await locus.stop();
  });

  it('a target that does not resolve moves nothing; prose_locus with no target reports the lock', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#nowhere' } },
      { type: 'tool_use', id: 'pl2', name: 'prose_locus', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    const results = toolResultTexts();
    assert.ok(results.some((t) => t.includes('\\"#nowhere\\" did not resolve') && t.includes('Your plain speech still goes to discord:g:main')), 'refused, naming the lock');
    assert.ok(results.some((t) => t.includes('Your plain speech goes to discord:g:main.')), 'reported');
    assert.deepEqual(routed, [{ text: 'Still main.', locus: 'discord:g:main' }]);
    await framework.stop();
  });

  it('channel_open moves nothing, and its result says where plain speech still goes', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'co1', name: 'channel_open', input: { channelId: 'discord:g:ops', serverId: 'stub' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Opened ops, speaking in main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async () => ({ success: true, data: { channelId: 'discord:g:ops', serverId: 'stub' } });

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [{ text: 'Opened ops, speaking in main.', locus: 'discord:g:main' }]);
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech still goes to discord:g:main. prose_locus moves it. Other channels need an explicit send tool.')),
      'the open says where speech still goes',
    );
    await framework.stop();
  });

  it('on a stream routed only at its end, a move holds the whole stream as drafts, posting nothing to either destination', async () => {
    const streamYielding = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => withoutRoundContent(streamYielding(request, options));
    membrane.supportsInjectedMessages = false; // as membrane's XML path declares
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Something private.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl2', name: 'prose_locus', input: {} },
    ] as ContentBlock[], 'tool_use'));
    // On the XML path the turn's final response carries every round's words.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Something private.' },
      { type: 'text', text: 'Now for ops.' },
    ] as ContentBlock[]));
    const framework = await createFramework({ proseLock: 'drafts' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'nothing went to #ops, nor anywhere else');
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech now goes to discord:g:ops from your next turn')
        && t.includes('routed when it ends, all of it together, so it is held as drafts instead')),
      'the move says what happens to this turn',
    );
    assert.ok(
      toolResultTexts().some((t) => t.includes('Your plain speech is held as drafts for the rest of this turn')
        && t.includes('and from your next turn it goes to discord:g:ops.')),
      'a query later in the turn says the same',
    );
    const receipt = windowTexts(framework).find((t) => t.startsWith('[delivered]'));
    assert.match(receipt ?? '', /^\[delivered\] nothing — \d+ plain-speech segment\(s\) held as drafts? d-/);
    const listed = JSON.stringify(await framework.executeToolCall({ id: 'l', name: 'drafts', input: { action: 'list' }, callerAgentName: 'assistant' } as ToolCall));
    for (const id of draftIds(receipt!)) assert.ok(listed.includes(id), `${id} is open`);
    assert.ok(listed.includes('Something private.'), 'the words written before the move are held');
    assert.ok(listed.includes('Now for ops.'), 'the words written after the move are held');

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Next turn, in ops.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [{ text: 'Next turn, in ops.', locus: 'discord:g:ops' }]);
    await framework.stop();
  });

  it('a move from outside the turn applies from the next turn, which is told where it speaks', async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'In main.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();

    const result = await framework.executeToolCall({ id: 'h', name: 'prose_locus', input: { to: '#ops' }, callerAgentName: 'assistant' } as ToolCall);
    assert.equal(result.success, true);
    assert.match(JSON.stringify(result.data), /now goes to discord:g:ops from your next turn/);

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'In ops.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed, [
      { text: 'In main.', locus: 'discord:g:main' },
      { text: 'In ops.', locus: 'discord:g:ops' },
    ]);
    assert.ok(
      windowTexts(framework).includes('[routing] Your plain speech now lands in discord:g:ops. Other channels need an explicit send tool.'),
      'the turn after the move is told where its speech lands',
    );
    await framework.stop();
  });

  it('a stored lock that names no destination holds speech as drafts rather than fall back to proseLock', async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const store = (framework as unknown as { store: { getStateJson(id: string): unknown; setStateJson(id: string, v: unknown): void } }).store;
    const state = (store.getStateJson('framework/state') ?? {}) as Record<string, unknown>;
    store.setStateJson('framework/state', { ...state, proseLocks: { assistant: { serverId: 'stub' } } });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Where does this go?' }] as ContentBlock[]));

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(routed, [], 'not posted to the recipe channel');
    assert.ok(windowTexts(framework).some((t) => /^\[delivered\] nothing — 1 plain-speech segment\(s\) held as draft d-/.test(t)));
    await framework.stop();
  });

  it('where the agent may not call prose_locus, no notice names it', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'co1', name: 'channel_open', input: { channelId: 'discord:g:ops', serverId: 'stub' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main', allowedTools: ['channel_open', 'robot--move'] });
    stubChannelRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    registry.handleChannelToolCall = async () => ({ success: true, data: { channelId: 'discord:g:ops', serverId: 'stub' } });

    trigger(framework);
    await framework.runUntilIdle();

    assert.ok(toolResultTexts().some((t) => t.includes('Your plain speech still goes to discord:g:main. Other channels need an explicit send tool.')));
    assert.ok(!toolResultTexts().some((t) => t.includes('prose_locus')), 'the open names no tool the agent lacks');
    const primer = windowTexts(framework).find((t) => t.startsWith('[prose-routing]'));
    assert.ok(primer && !primer.includes('prose_locus'), 'nor does the primer');
    await framework.stop();
  });

  it("a closed-channel invitation reads the open turn's lock, and names prose_locus only to an agent that has it", async () => {
    for (const allowed of [undefined, ['robot--move']] as const) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
      const framework = await createFramework({ proseLock: '#main', ...(allowed ? { allowedTools: [...allowed] } : {}) });
      stubChannelRegistry(framework);
      const internals = framework as unknown as {
        channelRegistry: Record<string, unknown>;
        openLogical: Map<string, unknown>;
        buildClosedChannelInvitation(opts: Record<string, unknown>): { block: { text: string } } | null;
      };
      internals.channelRegistry.isChannelOpen = () => false;
      // The stored lock says #ops, but the open turn still speaks in #main
      // (a move from outside the turn leaves it where it was). Stored
      // directly: an agent without prose_locus can't call it.
      (framework as unknown as { writeProseLock(name: string, lock: unknown): void })
        .writeProseLock('assistant', { serverId: 'stub', channelId: 'discord:g:ops' });
      internals.openLogical.set('assistant', { turnId: 1, locked: true, locus: { serverId: 'stub', channelId: 'discord:g:main' }, wasIn: [], engaged: new Set() });
      const invitation = internals.buildClosedChannelInvitation({
        serverId: 'stub', channelId: 'discord:g:ops', messageId: 'm1', authorName: 'Ann', tags: ['chat:addressed'],
      });
      const text = invitation!.block.text;
      assert.match(text, /1\. Reply — your plain speech goes to discord:g:main, not here\./);
      assert.equal(text.includes('point prose_locus here'), allowed === undefined, `prose_locus named: ${allowed ? 'not allowed' : 'allowed'}`);
      internals.openLogical.delete('assistant');
      await framework.stop();
    }
  });

  it("a closed-channel invitation in a locked agent's private turn says its speech goes to no channel, and offers no prose_locus move", async () => {
    const framework = await createFramework({ proseLock: '#main' });
    stubChannelRegistry(framework);
    const internals = framework as unknown as {
      channelRegistry: Record<string, unknown>;
      openLogical: Map<string, unknown>;
      buildClosedChannelInvitation(opts: Record<string, unknown>): { block: { text: string } } | null;
    };
    internals.channelRegistry.isChannelOpen = () => false;
    internals.openLogical.set('assistant', { turnId: 1, locked: true, private: true, wasIn: [], engaged: new Set() });
    const invitation = internals.buildClosedChannelInvitation({
      serverId: 'stub', channelId: 'discord:g:ops', messageId: 'm1', authorName: 'Ann', tags: ['chat:addressed'],
    });
    const text = invitation!.block.text;
    assert.match(text, /1\. Reply — your plain speech goes to no channel this turn, not here\./);
    assert.ok(!text.includes('held as drafts'), text);
    assert.ok(!text.includes('point prose_locus here'), text);
    internals.openLogical.delete('assistant');
    await framework.stop();
  });

  it("a locked agent's ephemeral run routes as disabled, its conversation fork as locus mode, and neither is offered prose_locus", async () => {
    const framework = await createFramework({ proseLock: '#main' });
    stubChannelRegistry(framework);
    const internals = framework as unknown as {
      usedEphemeralAgentNames: Map<string, string>;
      homeOf(name: string): unknown;
      proseRoutingOf(agent: unknown): string;
      availableToolsForPresentation(name: string): ToolDefinition[];
    };
    const agent = framework.getAgent('assistant')!;
    const offered = (): string[] => internals.availableToolsForPresentation('assistant').map((t) => t.name);
    assert.equal(internals.proseRoutingOf(agent), 'locked');

    internals.usedEphemeralAgentNames.set('assistant', 'run');
    assert.equal(internals.proseRoutingOf(agent), 'disabled', 'an ephemeral run publishes no plain speech');
    assert.ok(!offered().includes('prose_locus'));
    internals.usedEphemeralAgentNames.delete('assistant');

    const homeOf = internals.homeOf;
    internals.homeOf = () => ({ serverId: 'stub', channelId: 'discord:g:home' });
    assert.equal(internals.proseRoutingOf(agent), 'locus', 'a conversation fork');
    assert.ok(!offered().includes('prose_locus'));
    internals.homeOf = homeOf;
    await framework.stop();
  });

  it('on a stream routed only at its end, pointing the lock where it already goes holds nothing', async () => {
    const streamYielding = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request, options) => withoutRoundContent(streamYielding(request, options));
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#main' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    // Recorded as the agent's own choice (the recipe's was only a default),
    // and nothing is held, since the turn's speech didn't move.
    assert.ok(toolResultTexts().some((t) => t.includes('Your plain speech now goes to discord:g:main, on this turn')));
    assert.ok(!toolResultTexts().some((t) => t.includes('held as drafts')));
    assert.deepEqual(routed, [{ text: 'Still main.', locus: 'discord:g:main' }]);
    const store = (framework as unknown as { store: { getStateJson(id: string): unknown } }).store;
    assert.deepEqual((store.getStateJson('framework/state') as { proseLocks?: unknown }).proseLocks,
      { assistant: { serverId: 'stub', channelId: 'discord:g:main' } }, 'recorded as its own choice');
    await framework.stop();
  });

  it('a move from outside made during a turn leaves that turn where it was', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'm1', name: 'robot--move', input: { dir: 'north' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still this turn.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    let answer: ToolResult | undefined;
    module.during = async () => {
      answer = await framework.executeToolCall({ id: 'h', name: 'prose_locus', input: { to: '#ops' }, callerAgentName: 'assistant' } as ToolCall);
    };

    trigger(framework);
    await framework.runUntilIdle();
    assert.match(JSON.stringify(answer?.data), /from your next turn, until you change it\. A turn under way keeps where it was\./);
    assert.deepEqual(routed, [{ text: 'Still this turn.', locus: 'discord:g:main' }]);

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Next turn.' }] as ContentBlock[]));
    trigger(framework);
    await framework.runUntilIdle();
    assert.deepEqual(routed.at(-1), { text: 'Next turn.', locus: 'discord:g:ops' });
    assert.ok(windowTexts(framework).includes('[routing] Your plain speech now lands in discord:g:ops. Other channels need an explicit send tool.'));
    await framework.stop();
  });

  it('a send silences the plain speech aimed where it may have posted, as in locus mode', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Sending it now.' },
      { type: 'tool_use', id: 's1', name: 'robot--send_message', input: { text: 'the message' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Sent it.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);

    trigger(framework);
    await framework.runUntilIdle();

    assert.deepEqual(module.ran, ['send_message'], 'the send ran');
    assert.deepEqual(routed, [], 'neither the narration nor the postscript is posted beside the send');
    const listed = JSON.stringify(await framework.executeToolCall({ id: 'l', name: 'drafts', input: { action: 'list' }, callerAgentName: 'assistant' } as ToolCall));
    for (const words of ['Sending it now.', 'Sent it.']) assert.ok(listed.includes(words), `"${words}" is held as a draft`);
    await framework.stop();
  });

  it('pointed at drafts, a send with no channel gets no default', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'hello?' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: 'drafts' });
    stubChannelRegistry(framework);
    const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
    const asked: unknown[] = [];
    registry.handleChannelToolCall = async (_name: string, input: unknown) => {
      asked.push(input);
      return { success: false, error: 'Nothing was posted: name the channel with channelId.', isError: true };
    };

    trigger(framework);
    await framework.runUntilIdle();

    assert.equal(asked.length, 1);
    assert.equal((asked[0] as { channelId?: unknown }).channelId, undefined, 'no channel was filled in');
    await framework.stop();
  });

  it('a recipe proseLock whose channel registers later is announced at the turn it first resolves', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Before it registered.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#late' });
    const { routed } = stubChannelRegistry(framework);
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [], 'held while #late resolves to nothing');

      CHANNELS['#late'] = 'discord:g:late';
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'After it registered.' }] as ContentBlock[]));
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [{ text: 'After it registered.', locus: 'discord:g:late' }]);
      assert.ok(windowTexts(framework).includes('[routing] Your plain speech now lands in discord:g:late. Other channels need an explicit send tool.'));
    } finally {
      delete CHANNELS['#late'];
      await framework.stop();
    }
  });

  it("a lock write that fails moves nothing; state that can't be read holds speech as drafts", async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const store = (framework as unknown as { store: { getStateJson(id: string): unknown; setStateJson(id: string, v: unknown): void } }).store;
    const setStateJson = store.setStateJson.bind(store);
    store.setStateJson = (id, v) => {
      if (id === 'framework/state' && v && typeof v === 'object' && 'proseLocks' in v) throw new Error('disk full');
      setStateJson(id, v);
    };

    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(toolResultTexts().some((t) => t.includes("The change wasn't recorded (disk full), so your plain speech still goes to discord:g:main.")));
    assert.deepEqual(routed, [{ text: 'Still main.', locus: 'discord:g:main' }]);
    store.setStateJson = setStateJson;

    const getStateJson = store.getStateJson.bind(store);
    const internals = framework as unknown as { proseLockLocus(agent: unknown): unknown };
    store.getStateJson = (id) => {
      if (id === 'framework/state') throw new Error('unreadable');
      return getStateJson(id);
    };
    assert.equal(internals.proseLockLocus(framework.getAgent('assistant')), null, 'an unreadable lock holds speech as drafts');
    store.getStateJson = getStateJson;
    await framework.stop();
  });

  it("an agent locked to drafts still replies to the message that woke it (incomingFor)", async () => {
    const { ChannelRegistry } = await import('../src/mcpl/channel-registry.js');
    const make = (options: Record<string, unknown>) => {
      const registry = new ChannelRegistry({} as never, {} as never, () => {}, () => {}, options as never);
      Object.assign(registry as unknown as Record<string, unknown>, {
        defaultPublishChannel: { serverId: 'discord', channelId: 'lounge' },
        defaultPublishMessageId: 'm1',
      });
      return registry;
    };
    // A locked turn pointed at drafts: no outgoing channel, but a message to answer.
    const locked = make({ activeChannelResolver: () => null, channellessTurn: () => false });
    assert.deepEqual(locked.incomingFor('agent'), { channel: { serverId: 'discord', channelId: 'lounge' }, messageId: 'm1', threadId: undefined });
    // A heartbeat's turn answers nothing.
    assert.equal(make({ activeChannelResolver: () => null, channellessTurn: () => true }).incomingFor('agent'), undefined);
    // Without the option, a null channel still means no message to answer, as before.
    assert.equal(make({ activeChannelResolver: () => null }).incomingFor('agent'), undefined);
  });

  it('a turn whose lock moved while its words waited for its end holds its speech on every path', async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const internals = framework as unknown as {
      routeLocusSpeech(agent: unknown, round: unknown, text: string, locus: unknown): Promise<unknown>;
    };
    const routing = { turnId: 1, locked: true, heldForMove: true, locus: { serverId: 'stub', channelId: 'discord:g:ops' }, wasIn: [], engaged: new Set(), deliveries: [], drafts: [] as unknown[], suppressed: 0, keptPrivate: 0 };
    const outcome = await internals.routeLocusSpeech(framework.getAgent('assistant'), { routing, notice: 'later' }, 'A later stream, live.', routing.locus);
    assert.equal(outcome, null);
    assert.deepEqual(routed, [], 'not posted at the new lock');
    assert.equal(routing.drafts.length, 1, 'held as a draft');
    await framework.stop();
  });

  it("a turn with no channel of its own answers no message, a locked one's lock included", async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const internals = framework as unknown as { turnRouting: Map<string, unknown>; channellessTurn(name: string): boolean };
    const main = { serverId: 'stub', channelId: 'discord:g:main' };
    const cases: Array<[Record<string, unknown>, boolean, string]> = [
      [{ heartbeat: true, locked: true, locus: main }, true, "a locked heartbeat's lock is no message it answers"],
      [{ heartbeat: true }, true, 'a heartbeat with no locus'],
      [{ heartbeat: true, locus: main }, false, 'a heartbeat a re-pin or channel_open gave a channel'],
      [{ locked: true, triggerChannel: main }, false, 'a locked turn woken from a channel, drafts or not'],
      [{ noChannel: true, locked: true }, true, 'a wake for a channel that names none'],
    ];
    for (const [routing, expected, why] of cases) {
      internals.turnRouting.set('assistant', routing);
      assert.equal(internals.channellessTurn('assistant'), expected, why);
    }
    internals.turnRouting.delete('assistant');
    await framework.stop();
  });

  it('a malformed prose-lock record is never overwritten, so every agent stays held as drafts', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Held.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    const store = (framework as unknown as { store: { getStateJson(id: string): unknown; setStateJson(id: string, v: unknown): void } }).store;
    store.setStateJson('framework/state', { ...((store.getStateJson('framework/state') ?? {}) as object), proseLocks: ['damaged'] });

    trigger(framework);
    await framework.runUntilIdle();

    assert.ok(toolResultTexts().some((t) => t.includes("The change wasn't recorded (the stored prose-lock record is damaged, so the host's operator has to repair it")));
    assert.ok(!toolResultTexts().some((t) => t.includes('damaged\\"]') || t.includes('["damaged')), "the record's contents aren't repeated");
    assert.deepEqual((store.getStateJson('framework/state') as { proseLocks: unknown }).proseLocks, ['damaged'], 'left for the operator');
    assert.deepEqual(routed, [], 'still held as drafts');
    await framework.stop();
  });

  it('a prose_locus the agent is refused at dispatch is named nowhere', async () => {
    const framework = await createFramework({ proseLock: '#main', denyToolsAtDispatch: ['prose_locus', 'drafts'] });
    stubChannelRegistry(framework);
    const internals = framework as unknown as { proseLocusMoves(name: string): string; proseLockShown(lock: unknown, name: string): string };
    assert.equal(internals.proseLocusMoves('assistant'), '');
    assert.equal(internals.proseLockShown(null, 'assistant'), 'is held as drafts, posted nowhere');
    await framework.stop();
  });

  it('an ambiguous target is refused with its candidates', async () => {
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#dup' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Still main.' }] as ContentBlock[]));
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    trigger(framework);
    await framework.runUntilIdle();
    assert.ok(toolResultTexts().some((t) => t.includes('It could mean: #dup (one), #dup (two).') && t.includes('still goes to discord:g:main')));
    assert.deepEqual(routed, [{ text: 'Still main.', locus: 'discord:g:main' }]);
    await framework.stop();
  });

  it("a locked agent's ephemeral run publishes none of its narration", async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const { routed } = stubChannelRegistry(framework);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'run-1', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'locked', proseLock: '#main',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: 'Checking page 2.' },
        { type: 'tool_use', id: 'r1', name: 'robot--move', input: { dir: 'north' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Found it.' }] as ContentBlock[]));
      const run = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const outcome = await run;
      assert.deepEqual(routed, [], 'neither the narration nor the result was posted');
      assert.match(outcome.speech, /Found it\./, 'the run still answers its caller');
    } finally {
      await framework.stop();
    }
  });

  it('a sleep in a locked turn announces where its speech goes now, and nowhere while it is held', async () => {
    const framework = await createFramework({ proseLock: '#main' });
    const internals = framework as unknown as {
      eventGate: unknown; channelRegistry: unknown;
      openLogical: Map<string, unknown>; turnRouting: Map<string, unknown>; activeTurnTriggers: Map<string, unknown>;
      dispatchSleepToolCall(name: string, call: ToolCall, deliver?: (r: ToolResult) => void): void;
    };
    const announced: unknown[] = [];
    const { eventGate, channelRegistry } = internals;
    internals.eventGate = { setSleep: () => ({ until: Date.now() + 60_000 }) };
    internals.channelRegistry = {
      routeSpeech: async (_agent: string, _text: string, to: unknown) => { announced.push(to); return { delivered: true, serverId: 'stub', channelId: 'x' }; },
    };
    const ops = { serverId: 'stub', channelId: 'discord:g:ops' };
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    for (const [turn, expected] of [
      [{ turnId: 7, locked: true, locus: ops, wasIn: [], engaged: new Set() }, [ops]],
      [{ turnId: 8, locked: true, locus: ops, heldForMove: true, wasIn: [], engaged: new Set() }, []],
      [{ turnId: 9, locked: true, wasIn: [], engaged: new Set() }, []],
    ] as const) {
      announced.length = 0;
      internals.openLogical.set('assistant', turn);
      internals.turnRouting.set('assistant', turn);
      internals.activeTurnTriggers.set('assistant', {});
      const answered = new Promise<ToolResult>((resolve) => {
        internals.dispatchSleepToolCall('assistant', { id: `s-${turn.turnId}`, name: 'sleep', input: { seconds: 60 }, callerTurnId: turn.turnId } as ToolCall, resolve);
      });
      const result = await Promise.race([answered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sleep never answered')), 2000))]);
      assert.equal(result.success, true, JSON.stringify(result));
      await settle();
      assert.deepEqual(announced, expected, `turn ${turn.turnId}`);
    }
    internals.openLogical.delete('assistant');
    internals.turnRouting.delete('assistant');
    internals.activeTurnTriggers.delete('assistant');
    Object.assign(internals, { eventGate, channelRegistry });
    await framework.stop();
  });

  it("a locked heartbeat's continuation stays a heartbeat's, and names no channel it didn't come from", async () => {
    const framework = await createFramework({ proseLock: '#main', autoContinue: true });
    stubChannelRegistry(framework);
    const internals = framework as unknown as {
      pendingRequests: Array<Record<string, unknown>>;
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
    };
    const main = { serverId: 'stub', channelId: 'discord:g:main' };
    const lounge = { serverId: 'stub', channelId: 'discord:g:lounge' };
    const continueFrom = (routing: Record<string, unknown>, trigger: Record<string, unknown>): Record<string, unknown> | undefined => {
      internals.pendingRequests.length = 0;
      internals.autoContinueAfterTurn(framework.getAgent('assistant'), { turnId: 1, wasIn: [], engaged: new Set(), ...routing }, trigger, 'end_turn');
      return internals.pendingRequests.find((r) => r.reason === 'auto-continue');
    };
    const beat = continueFrom({ heartbeat: true, locked: true, locus: main }, { reason: 'heartbeat', source: 'heartbeat' });
    assert.ok(beat, 'continued');
    assert.equal(beat!.heartbeatTurn, true, 'still a heartbeat turn');
    assert.equal(beat!.channelId, undefined, 'the lock is not named as the channel it answers');
    const woken = continueFrom({ locked: true, locus: main, triggerChannel: lounge }, { reason: 'message', source: 'test', channelId: 'discord:g:lounge' });
    assert.equal(woken?.channelId, 'discord:g:lounge', 'a turn from a channel names that channel');
    assert.equal(woken?.heartbeatTurn, undefined);
    internals.pendingRequests.length = 0;
    await framework.stop();
  });

  it("a silent start of a locked agent gives a send with no channel its lock, or nothing, never the registry's default", async () => {
    for (const [proseLock, expected, fromChannel] of [
      ['#main', 'discord:g:main', false], ['drafts', undefined, false], ['drafts', undefined, true], ['#main', 'discord:g:main', true],
    ] as const) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
      membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'p1', name: 'channel_publish', input: { content: 'quietly' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));
      const framework = await createFramework({ proseLock });
      const { state } = stubChannelRegistry(framework);
      const registry = (framework as unknown as { channelRegistry: Record<string, unknown> }).channelRegistry;
      const asked: Array<{ channelId?: unknown }> = [];
      registry.handleChannelToolCall = async (_name: string, input: { channelId?: unknown }) => {
        asked.push(input);
        return { success: true, data: {} };
      };
      // A silent tick: its prose is suppressed, and the stub registry would
      // resolve #lounge as a default for any turn that asked it.
      // A silent start either from no channel or woken from #lounge, which
      // must not become its default either.
      (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'assistant', reason: fromChannel ? 'message' : 'heartbeat', source: fromChannel ? 'test' : 'heartbeat',
        timestamp: Date.now(), suppressProse: true,
        ...(fromChannel ? { channelId: 'discord:g:lounge', channelServerId: 'stub' } : {}),
      });
      await framework.runUntilIdle();
      assert.equal(asked.length, 1, proseLock);
      assert.equal(asked[0]!.channelId, expected, proseLock);
      assert.equal(state.locusCalls, 0, `${proseLock}: the registry's default wasn't asked for`);
      await framework.stop();
    }
  });

  it('prose_locus is offered only to a locked agent, and refuses any other', async () => {
    const locked = await createFramework({ proseLock: '#main' });
    stubChannelRegistry(locked);
    const offered = (f: AgentFramework): string[] =>
      (f as unknown as { availableToolsForPresentation(name: string): ToolDefinition[] })
        .availableToolsForPresentation('assistant').map((t) => t.name);
    assert.ok(offered(locked).includes('prose_locus'));
    await locked.stop();

    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'locked-prose-'));
    const plain = await createFramework({ proseRouting: 'locus' });
    stubChannelRegistry(plain);
    assert.ok(!offered(plain).includes('prose_locus'));
    const result = await plain.executeToolCall({ id: 'x', name: 'prose_locus', input: { to: '#ops' }, callerAgentName: 'assistant' } as ToolCall);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /applies only under locked prose routing/);
    await plain.stop();
  });
});
