/**
 * Locked prose routing (AgentConfig.proseRouting 'locked'): an agent's plain
 * speech goes to one destination it chose, on every turn, and nothing moves it
 * but its own prose_locus call — not the channel a turn came from, an
 * addressed message mid-turn, a heartbeat, or the host's locus rule. Pointed
 * at drafts (or with no destination yet), plain speech is held as drafts.
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

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{ name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
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
      '[prose-routing] Locked routing: your plain speech goes to discord:g:main, on every turn, until you move it with prose_locus. ' +
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
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Something private.' },
      { type: 'tool_use', id: 'pl1', name: 'prose_locus', input: { to: '#ops' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Now for ops.' }] as ContentBlock[]));
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
    const receipt = windowTexts(framework).find((t) => t.startsWith('[delivered]'));
    assert.match(receipt ?? '', /^\[delivered\] nothing — \d+ plain-speech segment\(s\) held as drafts? d-/);

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
      // (a move from outside the turn leaves it where it was).
      await framework.executeToolCall({ id: 'h', name: 'prose_locus', input: { to: '#ops' }, callerAgentName: 'assistant' } as ToolCall);
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

  it("a locked agent's ephemeral run and conversation fork route as locus mode and aren't offered prose_locus", async () => {
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
    assert.equal(internals.proseRoutingOf(agent), 'locus', 'an ephemeral run');
    assert.ok(!offered().includes('prose_locus'));
    internals.usedEphemeralAgentNames.delete('assistant');

    const homeOf = internals.homeOf;
    internals.homeOf = () => ({ serverId: 'stub', channelId: 'discord:g:home' });
    assert.equal(internals.proseRoutingOf(agent), 'locus', 'a conversation fork');
    assert.ok(!offered().includes('prose_locus'));
    internals.homeOf = homeOf;
    await framework.stop();
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
