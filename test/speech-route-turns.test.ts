/**
 * The turn's speech route across a logical turn (shelf-355): decided once at
 * a true new turn, kept by continuations and retries (including a route the
 * resident chose with channel_open), and decided afresh — never inherited —
 * by the next true new turn. A local surface route shows speech there and
 * publishes nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest, ProcessEvent, Module, ModuleContext, ProcessState, EventResponse, ToolDefinition, ToolCall, ToolResult } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { RouteCandidate, SpeechRoute } from '../src/speech-routes.js';

type Route = { route: { kind: string; channelId?: string; surface?: string; origin?: string } | null; hold?: unknown };

function internals(framework: AgentFramework) {
  return framework as unknown as {
    turnRoutes: Map<string, Route>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest, attempt?: number): Promise<void>;
    channelRegistry: unknown;
    conversationAgentHomes: Map<string, string>;
  };
}

class SurfaceModule implements Module {
  readonly name = 'console';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'Operator', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
      requestInference: true,
    };
  }
}

describe('speech route across a logical turn', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'speech-route-turns-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeFramework = (modules: Module[] = []) => AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
    modules,
  });

  /** A channel subsystem whose channels declare an MCPL RFC-011 publish
   *  target (a route is only ever a place the framework publishes to
   *  exactly), and whose channel_open succeeds, recording what it opened. */
  const channelsThatOpen = (opens: string[] = []) => new Proxy({
    publishTarget: () => 'root',
    resolveLocus: () => null,
    routeSpeech: async () => ({ delivered: true, channelId: 'x' }),
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'discord', channelId } }),
    handleChannelToolCall: async (name: string, input: { channelId?: string }) => {
      if (name !== 'channel_open') return { success: true };
      opens.push(input.channelId!);
      return { success: true, data: { channelId: input.channelId, opened: true } };
    },
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });

  const fromChannel = (channelId: string): InferenceRequest => ({
    agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
    routeCandidates: [{ conversation: { kind: 'channel', serverId: 'discord', channelId }, addressed: true, messageId: 'm1', at: Date.now() }],
  });

  it('continuations and retries keep the route — including one chosen with channel_open — and a new turn decides afresh', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;
    // A channel subsystem whose channels declare an MCPL RFC-011 publish
    // target: a route is only ever a place the framework publishes to exactly.
    i.channelRegistry = channelsThatOpen();

    // The turn starts routed to its wake, and the resident opens another
    // channel during it, through the tool.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'one' },
      { type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: 'chan-open' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'opened' }]));
    await i.startAgentStream(scout, fromChannel('chan-A'));
    await framework.runUntilIdle();
    const opened = i.turnRoutes.get('scout')!;
    assert.equal(opened.route?.channelId, 'chan-open');
    assert.equal(opened.route?.origin, 'open', 'channel_open set the route');

    // A context-budget restart, a guard retry and a framework retry continue
    // the same logical turn: none of them re-decides the route, even with
    // candidates from elsewhere in hand.
    for (const [trigger, attempt] of [
      [{ ...fromChannel('chan-B'), reason: 'context_budget_restart' }, 0],
      [{ ...fromChannel('chan-B'), reason: 'tool_result_guard_retry' }, 0],
      [fromChannel('chan-B'), 1],
    ] as Array<[InferenceRequest, number]>) {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'continuing' }]));
      await i.startAgentStream(scout, trigger, attempt);
      await framework.runUntilIdle();
      assert.equal(i.turnRoutes.get('scout'), opened, `${trigger.reason} (attempt ${attempt}) kept the route`);
    }

    // A true new turn decides from its own wake: another conversation's.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    await i.startAgentStream(scout, fromChannel('chan-C'));
    await framework.runUntilIdle();
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'chan-C', 'the new turn routes to its own wake');
    assert.equal(i.turnRoutes.get('scout')?.route?.origin, 'trigger');
    await framework.stop();
  });

  it("a silent wake's channel_open opens the channel and sets no route, and its result says so", async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;
    const opens: string[] = [];
    i.channelRegistry = channelsThatOpen(opens);
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: 'chan-open' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    await i.startAgentStream(scout, { agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now(), suppressProse: true });
    await framework.runUntilIdle();
    assert.deepEqual(opens, ['chan-open'], 'the channel was opened');
    assert.deepEqual(i.turnRoutes.get('scout'), { route: null, silent: {} }, 'and no route set');
    const result = JSON.stringify(membrane.lastStream?.receivedToolResults ?? []);
    assert.match(result, /This is a silent wake, so your plain speech stays private this turn; to post there, use a send tool\./);
    await framework.stop();
  });

  it('a channel_open into a channel a conversation fork owns opens it but takes no route, and its result says so', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;
    const opens: string[] = [];
    i.channelRegistry = channelsThatOpen(opens);
    i.conversationAgentHomes.set('fork-1', 'chan-fork');
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: 'chan-fork' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'still here' }]));
    await i.startAgentStream(scout, fromChannel('chan-A'));
    await framework.runUntilIdle();
    assert.deepEqual(opens, ['chan-fork'], 'the channel was opened');
    assert.equal(i.turnRoutes.get('scout')?.route?.channelId, 'chan-A', 'the route stayed');
    const result = JSON.stringify(membrane.lastStream?.receivedToolResults ?? []);
    assert.match(result, /Opened, but your plain speech can't go there: a conversation fork owns that channel\. Your plain speech still goes to/);
    await framework.stop();
  });

  it('a local surface wake routes speech to that surface: shown there, published nowhere, receipted as such', async () => {
    const framework = await makeFramework([new SurfaceModule()]);
    const i = internals(framework);
    const published: string[] = [];
    i.channelRegistry = new Proxy({
      resolveLocus: () => null,
      routeSpeech: async (_a: string, text: string) => { published.push(text); return { delivered: true, channelId: 'x' }; },
      getDescriptor: () => undefined,
      getChannelTools: () => [],
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });

    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello, operator.' }]));
    framework.pushEvent({ type: 'external-message', source: 'tui', content: 'hi scout', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    assert.deepEqual(i.turnRoutes.get('scout')?.route, { kind: 'surface', surface: 'tui', origin: 'trigger' });
    assert.deepEqual(published, [], 'surface speech is not published to any channel');
    const texts = framework.getAgent('scout')!.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    assert.ok(texts.includes('[delivered] plain speech → tui (the local surface that messaged you; not published to any channel)'));
    assert.ok(texts.some((t) => t.startsWith('[routing] Your plain speech now goes to tui (the local surface that messaged you)')));
    await framework.stop();
  });

  it('a channel id no single server registers gets no guessed server: unroutable as a candidate, unresolved as a home', async () => {
    const framework = await makeFramework();
    const registrants: Record<string, string[]> = { solo: ['alpha'], shared: ['alpha', 'beta'] };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getChannelServerId: (id: string) => (registrants[id]?.length === 1 ? registrants[id]![0] : null),
      resolveDestination: (c: { serverId?: string; channelId: string }) =>
        (c.serverId || registrants[c.channelId]?.length === 1)
          ? { destination: { serverId: c.serverId ?? registrants[c.channelId]![0], channelId: c.channelId } }
          : { error: 'shared or unknown' },
      // As the registry reads it: a declaration only for exactly one registration.
      publishTarget: (c: { serverId?: string; channelId: string }) =>
        (c.serverId || registrants[c.channelId]?.length === 1 ? 'root' : undefined),
      // The first registrant's label, as a bare-id lookup finds it: never the
      // label of a conversation whose server is another one.
      getDescriptor: () => ({ label: '#alpha-room' }),
      getChannelLabel: (serverId: string, id: string) => (registrants[id]?.includes(serverId) ? `#${serverId}-room` : undefined),
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
    const f = framework as unknown as {
      candidateForChannel(channelId: string, addressed: boolean, at: number, serverId?: string): RouteCandidate;
      homeRoute(agentName: string): SpeechRoute | null;
      publishTargetOf(c: { serverId?: string; channelId: string }): string | undefined;
      conversationAgentHomes: Map<string, string>;
    };
    const solo = f.candidateForChannel('solo', true, 1);
    assert.equal(solo.conversation.kind === 'channel' ? solo.conversation.serverId : '', 'alpha', 'a sole registrant is the server');
    assert.equal(solo.unroutable, undefined);
    const shared = f.candidateForChannel('shared', true, 1);
    assert.equal(shared.conversation.kind === 'channel' ? shared.conversation.serverId : '', undefined, 'never the first registrant');
    assert.equal(shared.unroutable, true, 'it competes, but is no route');
    assert.equal(shared.conversation.kind === 'channel' ? shared.conversation.label : '', undefined,
      'and no label: with no server, any label would be a guess');
    const named = f.candidateForChannel('shared', true, 1, 'beta');
    assert.equal(named.conversation.kind === 'channel' ? named.conversation.serverId : '', 'beta', "the event's own server stands");
    assert.equal(named.conversation.kind === 'channel' ? named.conversation.label : '', '#beta-room', 'with its own label, not the first registrant\'s');
    assert.equal(named.unroutable, undefined);
    assert.equal(solo.conversation.kind === 'channel' ? solo.conversation.label : '', '#alpha-room');
    f.conversationAgentHomes.set('scout', 'shared');
    const home = f.homeRoute('scout');
    assert.equal(home?.kind === 'channel' ? home.serverId : '', undefined, 'a shared home gets no server');
    assert.equal(home?.kind === 'channel' ? home.label : '', undefined, 'nor a label');
    assert.equal(f.publishTargetOf({ channelId: 'shared' }), 'unresolved', 'and is unresolved, not undeclared');
    assert.equal(f.publishTargetOf({ channelId: 'solo' }), 'root');
    await framework.stop();
  });

  it('a hold between two servers\' conversations with one channel id and label names each server', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    const scout = framework.getAgent('scout')!;
    i.channelRegistry = new Proxy({
      publishTarget: () => 'root',
      resolveLocus: () => null,
      getDescriptor: () => ({ label: '#general' }),
      getChannelTools: () => [],
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
    const from = (serverId: string, messageId: string, at: number): RouteCandidate => ({
      conversation: { kind: 'channel', serverId, channelId: 'general', label: '#general' }, addressed: true, messageId, at,
    });
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'which general?' }]));
    await i.startAgentStream(scout, {
      agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: Date.now(),
      routeCandidates: [from('alpha', 'm1', 1), from('beta', 'm2', 2)],
    });
    await framework.runUntilIdle();
    const notice = scout.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      .find((t) => t.startsWith('[routing]'));
    assert.match(notice ?? '', /^\[routing\] More than one conversation is waiting for you: /);
    for (const address of ['#general (alpha / general)', '#general (beta / general)']) {
      assert.ok(notice?.includes(address), `${address} is an address the resident can send to, server included: ${notice}`);
    }
    await framework.stop();
  });

  it('the [delivered] receipt names each destination as delivered: server, label then, and thread', async () => {
    const framework = await makeFramework();
    const scout = framework.getAgent('scout')!;
    let currentLabel = '#Alpha (renamed later)';
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      getDescriptor: () => ({ label: currentLabel }),
      resolveDestination: () => ({ error: 'shared id' }),
      getChannelTools: () => [],
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
    const f = framework as unknown as {
      recordProseDelivery(agent: string, outcome: unknown): void;
      appendProseDeliveryReceipt(agent: unknown): void;
    };
    // The same channel id and thread on two servers, then a repeat of the first.
    f.recordProseDelivery('scout', { delivered: true, serverId: 'alpha', channelId: 'shared', label: '#Alpha', threadId: 'topic' });
    f.recordProseDelivery('scout', { delivered: true, serverId: 'beta', channelId: 'shared', label: '#Beta', threadId: 'topic' });
    f.recordProseDelivery('scout', { delivered: true, serverId: 'alpha', channelId: 'shared', label: '#Alpha', threadId: 'topic' });
    currentLabel = '#Renamed';
    f.appendProseDeliveryReceipt(scout);
    const receipt = scout.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      .find((t) => t.startsWith('[delivered]'));
    assert.equal(receipt, '[delivered] plain speech → #Alpha (alpha / shared, thread topic) · #Beta (beta / shared, thread topic)',
      'two servers stay two destinations, each with the label it had when the words went out');
    // A single delivery names its server too: the receipt is self-contained.
    f.recordProseDelivery('scout', { delivered: true, serverId: 'beta', channelId: 'shared', label: '#Beta', threadId: 'topic' });
    f.appendProseDeliveryReceipt(scout);
    const second = scout.getContextManager().getAllMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      .filter((t) => t.startsWith('[delivered]')).at(-1);
    assert.equal(second, '[delivered] plain speech → #Beta (beta / shared, thread topic)');
    await framework.stop();
  });

  it('the sleep announcement is unaddressed speech: a held, a routeless and a surface turn each keep it as such, publishing nothing', async () => {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      gate: { config: { policies: [], default: 'always' } },
    });
    const i = framework as unknown as {
      turnRoutes: Map<string, Route>;
      channelRegistry: unknown;
      speechChains?: Map<string, Promise<void>>;
      dispatchSleepToolCall(agent: string, call: unknown): void;
      proseDrafts: { open(agent: string): Array<{ reason: string; text: string }> };
    };
    const published: unknown[] = [];
    i.channelRegistry = new Proxy({
      publishTarget: () => 'root',
      resolveLocus: () => null,
      routeSpeech: async (...args: unknown[]) => { published.push(args); return null; },
      getDescriptor: () => undefined,
      getChannelTools: () => [],
    } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
    const sleepUnder = async (turn: Route, id: string) => {
      i.turnRoutes.set('scout', turn);
      i.dispatchSleepToolCall('scout', { id, name: 'sleep', input: { seconds: 60 } });
      await (i.speechChains?.get('scout') ?? Promise.resolve());
    };
    await sleepUnder({ route: null, hold: { conversations: [
      { kind: 'channel', serverId: 'discord', channelId: 'a' },
      { kind: 'channel', serverId: 'discord', channelId: 'b' },
    ], since: 'turn-start' } }, 's1');
    await sleepUnder({ route: null }, 's2');
    await sleepUnder({ route: { kind: 'surface', surface: 'tui', origin: 'trigger' } }, 's3');
    assert.deepEqual(published, [], 'nothing was published, so no failure can be reported');
    const held = i.proseDrafts.open('scout');
    assert.deepEqual(held.map((d) => d.reason).sort(), ['ambiguous', 'no-destination'], 'held, then routeless; the surface shows it');
    assert.ok(held.every((d) => d.text.startsWith('💤 Going quiet for 1m')));
    await framework.stop();
  });
});
