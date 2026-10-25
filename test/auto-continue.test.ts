/**
 * autoContinue (docs/auto-continue.md): a turn the model ends itself, with
 * prose or with nothing, is followed by another turn, unless it ended on a
 * skip (the skip_reply tool, or a `>>skip_reply` / `>>>skip_reply`
 * envelope). The next turn reads a `[continue]` notice; a run is capped.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentConfig,
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  InferenceRequest,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { resolveAutoContinue } from '../src/agent.js';
import { autoContinueNotice } from '../src/auto-continue.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedResponse } from '@animalabs/membrane';

class TriggerModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [
      { name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: {} } },
      // A send tool by its bare name: a turn that calls it holds its later prose.
      { name: 'send_message', description: 'Explicitly send a message', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { ok: true } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const text = String((event as { content?: unknown }).content);
      return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }], requestInference: true };
    }
    return {};
  }
}

/** Registry stub, as main's prose-routing tests build it: a locus of
 *  world:commons on the stub server, two named channels, and a log of what
 *  was routed where (by channel id). */
function stubRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const known: Record<string, { channelId: string; label: string }> = {
    '#alpha': { channelId: 'chan-alpha', label: '#alpha' },
    'world:commons': { channelId: 'world:commons', label: 'world:commons' },
  };
  const deliverSpeech = async (_agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
    routed.push({ text, locus: locus?.channelId ?? null });
    return {
      status: 'delivered' as const,
      destination: { serverId: locus?.serverId ?? 'stub', channelId: locus?.channelId ?? '' },
      at: Date.now(),
    };
  };
  const registry: Record<string, unknown> = {
    resolveProseTarget: (spec: string) =>
      known[spec] ? { serverId: 'stub', ...known[spec] } : { error: 'no channel matches "' + spec + '"' },
    deliverSpeech,
    routeSpeech: async (agent: string, text: string, locus?: { serverId?: string; channelId: string } | null) => {
      const outcome = await deliverSpeech(agent, text, locus);
      return { delivered: true, serverId: outcome.destination.serverId, channelId: outcome.destination.channelId };
    },
    resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
    // As the registry's resolver does through the framework's turn state: a
    // turn whose wake named no resolvable channel (noChannel) has no locus
    // and takes no fallback.
    resolveLocus: (agentName: string) =>
      (framework as unknown as { turnRouting: Map<string, { noChannel?: true }> }).turnRouting.get(agentName)?.noChannel
        ? null
        : { serverId: 'stub', channelId: 'world:commons' },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
    // 'ghost' names no registered channel, as a host's unresolvable id would.
    channelsNamed: (name: string) => (name === 'ghost' ? [] : [{ serverId: 'stub', channelId: name }]),
    nameShown: (channel: { channelId: string }) => channel.channelId,
    // skip_reply ends the turn, as the registry's own handler does.
    handleChannelToolCall: async () => ({ success: true, endTurn: true, data: { skipped: true } }),
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(registry, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
/** The row the test agent reads for a continuation. */
const row = (last: boolean, stop = 'call skip_reply', heldAfterSend = false): string =>
  autoContinueNotice({ agentName: 'assistant', stop, last, heldAfterSend });
const prose = (t: string): NormalizedResponse => createMockResponse([text(t)]);
const empty = (): NormalizedResponse => createMockResponse([]);
const skipReply = (id = 'sr'): NormalizedResponse =>
  createMockResponse([{ type: 'tool_use', id, name: 'skip_reply', input: {} } as ContentBlock], 'tool_use');

async function within<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('autoContinue', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: TriggerModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'auto-continue-test-'));
    membrane = new MockMembrane();
    module = new TriggerModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(
    autoContinue: AgentConfig['autoContinue'],
    proseRouting: AgentConfig['proseRouting'] = 'locus',
    allowedTools?: AgentConfig['allowedTools'],
    others: AgentConfig[] = [],
  ): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'assistant', model: 'test-model', systemPrompt: 'You are a test agent.', proseRouting, autoContinue,
        ...(allowedTools ? { allowedTools } : {}),
      }, ...others],
      modules: [module],
    });
    module.framework = framework;
    return framework;
  }

  /**
   * Answer the Nth turn with responses[N-1] the moment it starts (the mock
   * hands every queued response to the first stream otherwise). A turn past
   * the script calls skip_reply, so a stray continuation ends instead of
   * hanging and the test fails on its count. Returns each turn's trigger.
   */
  function script(framework: AgentFramework, responses: Array<NormalizedResponse | NormalizedResponse[]>): InferenceRequest[] {
    const triggers: InferenceRequest[] = [];
    const internals = framework as unknown as { activeTurnTriggers: Map<string, InferenceRequest> };
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started') return;
      const turn = triggers.length;
      const trigger = internals.activeTurnTriggers?.get('assistant');
      triggers.push(trigger ?? ({ reason: 'unknown' } as InferenceRequest));
      // A turn with tool rounds takes all its responses at its start.
      for (const response of [responses[turn] ?? skipReply(`stray-${turn}`)].flat()) membrane.pushResponse(response);
    });
    return triggers;
  }

  function trigger(framework: AgentFramework, content = 'hello'): void {
    framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
  }

  /** The window's rows: text and kind. */
  function rows(framework: AgentFramework): Array<{ text: string; kind?: string }> {
    const messages = framework.getAgent('assistant')!.getContextManager().getAllMessages() as Array<{
      content: Array<{ type: string; text?: string }>;
      metadata?: { kind?: string };
    }>;
    return messages.map((m) => ({
      text: m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      kind: m.metadata?.kind,
    }));
  }

  const notices = (framework: AgentFramework) => rows(framework).filter((r) => r.kind === 'auto-continue').map((r) => r.text);

  it('continues a turn that ends in prose, after its receipt, in the same channel, until skip_reply', async () => {
    const framework = await createFramework(true);
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('First thought.'), prose('Second thought.'), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');

      assert.equal(triggers.length, 3, 'two continuations, then skip_reply ends the run');
      assert.deepEqual(triggers.slice(1).map((t) => t.reason), ['auto-continue', 'auto-continue']);
      assert.ok(triggers.slice(1).every((t) => t.channelId === 'world:commons' && t.channelServerId === 'stub'), 'each continuation keeps the locus, server and id');
      assert.deepEqual(routed, [
        { text: 'First thought.', locus: 'world:commons' },
        { text: 'Second thought.', locus: 'world:commons' },
      ]);
      const all = rows(framework);
      const firstNotice = all.findIndex((r) => r.kind === 'auto-continue');
      assert.equal(all[firstNotice - 1]?.kind, 'delivery-receipt', 'the notice follows the turn\'s receipt');
      assert.deepEqual(notices(framework), [row(false), row(false)]);
      assert.equal(notices(framework)[0], "[continue] assistant, another turn starts now. If you're done, call skip_reply; anything you write without it is sent as usual.", 'it names the agent');
    } finally {
      await framework.stop();
    }
  });

  it('continues a turn that ends with no text', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [empty(), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'auto-continue');
      assert.equal(notices(framework).length, 1);
    } finally {
      await framework.stop();
    }
  });

  it("a continuation's request ends on a changed context injection, stored after its [continue] row", async () => {
    let gathered = 0;
    (module as unknown as { gatherContext: () => Promise<unknown[]> }).gatherContext = async () =>
      [{ namespace: 'lessons', position: 'afterUser', content: [text(`LESSON ${++gathered}`)] }];
    const framework = await createFramework(true);
    stubRegistry(framework);
    script(framework, [empty(), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      const textOf = (m: { content: unknown } | undefined) =>
        ((m?.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const continued = membrane.calls[1]!.messages;
      assert.equal(textOf(continued.at(-1)), 'LESSON 2', 'it ends on the injection');
      assert.ok(textOf(continued.at(-2)).startsWith('[continue] assistant'), 'right after the [continue] row');
      assert.ok(continued.some((m) => textOf(m) === 'LESSON 1'), 'the first turn\'s copy stays where it was');
    } finally {
      await framework.stop();
    }
  });

  it('stops at maxConsecutive, and says so on the last continuation', async () => {
    const framework = await createFramework({ maxConsecutive: 2 });
    stubRegistry(framework);
    // The model never skips: the cap ends the run.
    const triggers = script(framework, [prose('one'), prose('two'), prose('three'), prose('four')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 3, 'the turn and two continuations');
      assert.deepEqual(notices(framework), [row(false), row(true)], 'only the last says it is the last');
      assert.match(notices(framework)[1]!, / This is the last continuation in a row: after this turn you wait for the next event either way\.$/);
    } finally {
      await framework.stop();
    }
  });

  it('starts a fresh run when a message wakes the agent after the cap', async () => {
    const framework = await createFramework({ maxConsecutive: 1 });
    stubRegistry(framework);
    const triggers = script(framework, [prose('a'), prose('b'), prose('c'), prose('d')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the first run');
      assert.equal(triggers.length, 2, 'one continuation, then the cap');
      trigger(framework, 'again');
      await within(framework.runUntilIdle(), 'the second run');
      assert.equal(triggers.length, 4, 'the message starts a turn, and its run continues once more');
      assert.equal(triggers[3]!.reason, 'auto-continue');
    } finally {
      await framework.stop();
    }
  });

  it('does nothing when autoContinue is off', async () => {
    const framework = await createFramework(undefined);
    stubRegistry(framework);
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the turn');
      assert.equal(triggers.length, 1);
      assert.equal(notices(framework).length, 0);
    } finally {
      await framework.stop();
    }
  });

  it('continues a turn that ends on a stop sequence', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [createMockResponse([text('stopped at the sequence')], 'stop_sequence'), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'auto-continue');
    } finally {
      await framework.stop();
    }
  });

  for (const stop of ['max_tokens', 'refusal', 'no_progress', 'round_limit'] as const) {
    it(`does not continue a turn that ended with ${stop}`, async () => {
      const framework = await createFramework(true);
      stubRegistry(framework);
      const triggers = script(framework, [createMockResponse([text('cut off')], stop)]);
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the turn');
        assert.equal(triggers.length, 1);
        assert.equal(notices(framework).length, 0);
      } finally {
        await framework.stop();
      }
    });
  }

  it('does not continue a silent heartbeat tick', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const triggers = script(framework, [prose('private check')]);
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    try {
      // As a real tick arrives: from its MCPL server, not the framework.
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'heartbeat', source: 'heartbeat', timestamp: Date.now(), suppressProse: true } as InferenceRequest);
      await within(framework.runUntilIdle(), 'the silent turn');
      assert.equal(triggers.length, 1);
      assert.equal(notices(framework).length, 0);
    } finally {
      await framework.stop();
    }
  });

  it('a tool-ended turn clears the run, so the next run counts from one', async () => {
    const framework = await createFramework({ maxConsecutive: 2 });
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number>; pendingRequests: InferenceRequest[] };
    const triggers = script(framework, [skipReply(), prose('after'), skipReply('sr2')]);
    try {
      // A run already at its cap, then a framework wake (not a cause of its
      // own) whose turn ends with skip_reply.
      internals.autoContinueStreaks.set('assistant', 2);
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'prose-bounce', source: 'framework', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the skip');
      assert.equal(triggers.length, 1);
      assert.equal(internals.autoContinueStreaks.has('assistant'), false, 'skip_reply cleared the run');
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'prose-bounce', source: 'framework', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the next run');
      assert.equal(triggers.length, 3, 'a prose end continues again');
      assert.deepEqual(notices(framework), [row(false)]);
    } finally {
      await framework.stop();
    }
  });

  it("a message that arrives during the turn takes the next turn: its channel, no notice, a fresh run", async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as { pendingRequests: InferenceRequest[]; autoContinueStreaks: Map<string, number> };
    const triggers = script(framework, [prose('Working in the commons.'), skipReply()]);
    // An ambient message in another channel, queued while the first turn
    // runs: it waits for that turn, then batches with the continuation.
    let injected = false;
    framework.onTrace((e) => {
      if ((e as { type: string }).type !== 'inference:started' || injected) return;
      injected = true;
      internals.pendingRequests.push({
        agentName: 'assistant', reason: 'channel-message', source: 'stub', timestamp: Date.now(),
        channelId: 'chan-b', channelServerId: 'stub',
      });
    });
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2, 'one more turn, not two');
      assert.equal(triggers[1]!.reason, 'channel-message', 'the message, queued first, is the turn\'s trigger');
      assert.equal(triggers[1]!.channelId, 'chan-b', "the message's channel outranks the continuation's, though queued first");
      assert.deepEqual(notices(framework), [], 'the message is the turn\'s cause: no [continue] row');
      assert.equal(internals.autoContinueStreaks.has('assistant'), false, 'and the run starts again');
    } finally {
      await framework.stop();
    }
  });

  for (const [what, extra] of [
    ['a silent heartbeat tick', { reason: 'heartbeat', source: 'heartbeat', suppressProse: true }],
    // Not a prose-bounce: a queued bounce wake takes the place of a continuation.
    ['another framework wake', { reason: 'framework-test-wake', source: 'framework' }],
  ] as const) {
    it(`${what} batched with a continuation neither restarts the run nor takes its notice`, async () => {
      // Cap 1: if the batched wake restarted the run, the second turn's end
      // would continue a third time.
      const framework = await createFramework({ maxConsecutive: 1 });
      stubRegistry(framework);
      const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
      const triggers = script(framework, [prose('one'), prose('two'), prose('three')]);
      let injected = false;
      framework.onTrace((e) => {
        if ((e as { type: string }).type !== 'inference:started' || injected) return;
        injected = true;
        internals.pendingRequests.push({ agentName: 'assistant', timestamp: Date.now(), ...extra } as InferenceRequest);
      });
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the run to settle');
        assert.equal(triggers.length, 2, 'the cap still holds');
        assert.deepEqual(notices(framework), [row(true)], 'the continuation\'s notice is written');
      } finally {
        await framework.stop();
      }
    });
  }

  it('a continuation the inference policy drops writes no notice and gives back its count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      inferencePolicy: { shouldInfer(agent: string, requests: InferenceRequest[]): boolean };
      autoContinueStreaks: Map<string, number>;
    };
    internals.inferencePolicy = { shouldInfer: (_agent, requests) => !requests.some((r) => r.reason === 'auto-continue') };
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 1);
      assert.deepEqual(notices(framework), [], 'no notice claims a turn that never ran');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0, 'the count is given back');
    } finally {
      await framework.stop();
    }
  });

  it('a notice that cannot be stored starts no continuation and gives back its count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number> };
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage(role: string, content: unknown, metadata?: { kind?: string }): unknown;
    };
    const original = cm.addMessage.bind(cm);
    cm.addMessage = (role, content, metadata) => {
      if (metadata?.kind === 'auto-continue') throw new Error('synthetic store failure');
      return original(role, content, metadata);
    };
    const triggers = script(framework, [prose('Only this.')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 1, 'no turn wakes without its notice');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0);
    } finally {
      await framework.stop();
    }
  });

  for (const [mode, first, stop] of [
    ['explicit', '>>#alpha hello', 'end with a >>skip_reply envelope'],
    ['hybrid', 'hello', 'end with a >>>skip_reply envelope'],
  ] as const) {
    it(`${mode}: an agent that can't call skip_reply is told its envelope`, async () => {
      const framework = await createFramework({ maxConsecutive: 1 }, mode, ['robot--move']);
      stubRegistry(framework);
      // Without skip_reply, the cap ends the run.
      const triggers = script(framework, [prose(first), prose(first), prose(first)]);
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the run to settle');
        assert.equal(triggers.length, 2);
        assert.deepEqual(notices(framework), [row(true, stop)]);
      } finally {
        await framework.stop();
      }
    });
  }

  for (const [what, allowed, registry] of [
    ['may not call skip_reply', ['robot--move'], true],
    ['has no channel registry offering skip_reply', undefined, false],
  ] as const) {
    it(`locus: an agent that ${what} is not continued: it would have no way to stop`, async () => {
      const framework = await createFramework(true, 'locus', allowed ? [...allowed] : undefined);
      if (registry) stubRegistry(framework);
      const triggers = script(framework, [prose('hello'), prose('again')]);
      try {
        trigger(framework);
        await within(framework.runUntilIdle(), 'the run to settle');
        assert.equal(triggers.length, 1);
        assert.deepEqual(notices(framework), []);
      } finally {
        await framework.stop();
      }
    });
  }

  it('queues nothing for an ephemeral run, a conversation fork, a stopping framework or an agent no longer registered', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string, opts?: unknown): void;
      pendingRequests: InferenceRequest[];
      ephemeralRuns: Map<string, unknown>;
      conversationAgentHomes: Map<string, unknown>;
      providerAdmissionClosed: boolean;
      autoContinueStreaks: Map<string, number>;
    };
    const agent = framework.getAgent('assistant')!;
    const queued = () => internals.pendingRequests.filter((r) => r.reason === 'auto-continue');
    try {
      internals.ephemeralRuns.set('assistant', {});
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      internals.ephemeralRuns.delete('assistant');
      assert.equal(queued().length, 0, 'an ephemeral run ends with its result');

      internals.conversationAgentHomes.set('assistant', 'chan-alpha');
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      internals.conversationAgentHomes.delete('assistant');
      assert.equal(queued().length, 0, 'a conversation fork answers its home');

      internals.providerAdmissionClosed = true;
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn');
      internals.providerAdmissionClosed = false;
      assert.equal(queued().length, 0, 'a stopping framework starts nothing');

      internals.autoContinueAfterTurn(Object.create(agent), {}, undefined, 'end_turn');
      assert.equal(queued().length, 0, 'an agent object no longer the registered one starts nothing');

      // The same call for the registered agent does queue one, marked.
      internals.autoContinueAfterTurn(agent, {}, undefined, 'end_turn', { heldAfterSend: true });
      assert.equal(queued().length, 1);
      assert.deepEqual(queued()[0]!.autoContinueRun, { stop: 'call skip_reply', heldAfterSend: true });
    } finally {
      internals.pendingRequests.length = 0;
      internals.autoContinueStreaks.clear();
      await framework.stop();
    }
  });

  it("the row says the last turn's closing words were held when it had already sent", async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string, opts?: unknown): void;
    };
    const triggers = script(framework, [skipReply()]);
    try {
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn', { heldAfterSend: true });
      await within(framework.runUntilIdle(), 'the continuation');
      assert.equal(triggers.length, 1);
      assert.deepEqual(notices(framework), [row(false, 'call skip_reply', true)]);
    } finally {
      await framework.stop();
    }
  });

  it("a turn that sent and then closed in prose continues, and its row says those words were held", async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const sendRound = createMockResponse([
      text('Posting the summary.'),
      { type: 'tool_use', id: 's1', name: 'robot--send_message', input: { text: 'the summary' } } as ContentBlock,
    ], 'tool_use');
    const triggers = script(framework, [[sendRound, prose('Done.')], skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2, 'it still continues: a held "Done." can\'t be told from unfinished work');
      assert.deepEqual(notices(framework), [row(false, 'call skip_reply', true)]);
    } finally {
      await framework.stop();
    }
  });

  it("a message batched after a queued continuation still takes the turn: no row, a fresh run", async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      pendingRequests: InferenceRequest[];
      autoContinueStreaks: Map<string, number>;
    };
    const triggers = script(framework, [skipReply()]);
    try {
      // The continuation is queued first, so it is the batch's first request.
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn');
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'channel-message', source: 'stub', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the turn');
      assert.equal(triggers.length, 1);
      assert.equal(triggers[0]!.reason, 'auto-continue', 'the first request names the trigger');
      assert.equal(triggers[0]!.autoContinueRun, undefined, 'but the turn carries no continuation mark');
      assert.deepEqual(notices(framework), []);
      assert.equal(internals.autoContinueStreaks.has('assistant'), false);
    } finally {
      await framework.stop();
    }
  });

  it("waits for another resident's turn before writing its row into the shared slot", async () => {
    const framework = await createFramework(true, 'locus', undefined, [{ name: 'other', model: 'test-model', systemPrompt: 'Another resident.' }]);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      processInferenceRequests(): Promise<void>;
      pendingRequests: InferenceRequest[];
      activeTurnTokens: Map<string, number>;
    };
    const triggers = script(framework, [skipReply()]);
    try {
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn');
      internals.activeTurnTokens.set('other', 424242);
      await internals.processInferenceRequests();
      assert.equal(triggers.length, 0, 'no turn while the other resident\'s turn is alive');
      assert.deepEqual(notices(framework), [], 'and no row in the middle of it');
      assert.equal(internals.pendingRequests.filter((r) => r.reason === 'auto-continue').length, 1, 'the continuation waits');
      internals.activeTurnTokens.delete('other');
      await within(framework.runUntilIdle(), 'the continuation');
      assert.equal(triggers.length, 1);
      assert.deepEqual(notices(framework), [row(false)]);
    } finally {
      internals.activeTurnTokens.delete('other');
      await framework.stop();
    }
  });

  it('a row whose write threw after it landed counts as written: the turn runs, with one row', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage(role: string, content: unknown, metadata?: { kind?: string }): unknown;
    };
    const original = cm.addMessage.bind(cm);
    cm.addMessage = (role, content, metadata) => {
      const id = original(role, content, metadata);
      if (metadata?.kind === 'auto-continue') throw new Error('synthetic propagation failure after the write');
      return id;
    };
    const triggers = script(framework, [prose('one'), skipReply()]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2, 'the continuation runs');
      assert.deepEqual(notices(framework), [row(false)], 'its one row is there');
    } finally {
      await framework.stop();
    }
  });

  it('a row that fails for a continuation batched with another framework wake gives back its count; the turn runs', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      pendingRequests: InferenceRequest[];
      autoContinueStreaks: Map<string, number>;
    };
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      addMessage(role: string, content: unknown, metadata?: { kind?: string }): unknown;
    };
    const original = cm.addMessage.bind(cm);
    cm.addMessage = (role, content, metadata) => {
      if (metadata?.kind === 'auto-continue') throw new Error('synthetic store failure');
      return original(role, content, metadata);
    };
    const triggers = script(framework, [skipReply()]);
    try {
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn');
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'framework-test-wake', source: 'framework', timestamp: Date.now() });
      await within(framework.runUntilIdle(), 'the turn');
      assert.equal(triggers.length, 1, 'the other wake still has its turn');
      assert.deepEqual(notices(framework), []);
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0, 'the count is given back');
    } finally {
      await framework.stop();
    }
  });

  it('a quiesce parks a requeued trigger without its continuation mark, and gives back the count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      processInferenceRequests(): Promise<void>;
      pendingRequests: InferenceRequest[];
      quiesced: boolean;
      autoContinueStreaks: Map<string, number>;
    };
    try {
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn');
      // Swap the bare wake for a requeued turn trigger that carried the mark
      // (as a provider park's requeue hands back), with a cause of its own.
      const wake = internals.pendingRequests.find((r) => r.reason === 'auto-continue')!;
      internals.pendingRequests.length = 0;
      internals.pendingRequests.push({ ...wake, reason: 'framework-test-wake' });
      internals.quiesced = true;
      await internals.processInferenceRequests();
      const parked = internals.pendingRequests.filter((r) => r.agentName === 'assistant');
      assert.equal(parked.length, 1, 'the trigger parks for resume');
      assert.equal(parked[0]!.reason, 'framework-test-wake');
      assert.equal(parked[0]!.autoContinueRun, undefined, 'without the mark, so resume writes no stale row');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0);
    } finally {
      internals.quiesced = false;
      internals.pendingRequests.length = 0;
      await framework.stop();
    }
  });

  it('a quiesce drops a queued continuation and gives back its count', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as {
      autoContinueAfterTurn(agent: unknown, routing: unknown, trigger: unknown, stopReason: string): void;
      processInferenceRequests(): Promise<void>;
      pendingRequests: InferenceRequest[];
      quiesced: boolean;
      autoContinueStreaks: Map<string, number>;
    };
    try {
      internals.autoContinueAfterTurn(framework.getAgent('assistant')!, {}, undefined, 'end_turn');
      assert.equal(internals.autoContinueStreaks.get('assistant'), 1);
      internals.quiesced = true;
      await internals.processInferenceRequests();
      assert.equal(internals.pendingRequests.filter((r) => r.reason === 'auto-continue').length, 0, 'not parked for resume');
      assert.equal(internals.autoContinueStreaks.get('assistant') ?? 0, 0, 'its count is given back');
      assert.deepEqual(notices(framework), []);
    } finally {
      internals.quiesced = false;
      await framework.stop();
    }
  });

  it("explicit: a turn whose closing prose bounced is left to the bounce, past its cap too", async () => {
    const framework = await createFramework(true, 'explicit');
    stubRegistry(framework);
    // Every turn ends in unprefixed prose: the message's turn, then the two
    // bounce wakes the cap allows. With the setting off it is the same 3.
    const triggers = script(framework, [prose('no prefix'), prose('still none'), prose('none again'), prose('and again')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.deepEqual(triggers.slice(1).map((t) => t.reason), ['prose-bounce', 'prose-bounce'], 'no continuation, before or after the bounce cap is spent');
      assert.deepEqual(notices(framework), []);
    } finally {
      await framework.stop();
    }
  });

  it('a turn that had no channel passes that on: its continuation takes no fallback either', async () => {
    const framework = await createFramework(true);
    stubRegistry(framework);
    const internals = framework as unknown as { pendingRequests: InferenceRequest[] };
    const triggers = script(framework, [prose('nowhere to say this'), skipReply()]);
    try {
      internals.pendingRequests.push({ agentName: 'assistant', reason: 'channel-message', source: 'stub', timestamp: Date.now(), channelId: 'ghost' });
      await within(framework.runUntilIdle(), 'the run to settle');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'auto-continue');
      assert.equal(triggers[1]!.channelId, 'ghost', 'the continuation names the same unresolved channel');
    } finally {
      await framework.stop();
    }
  });

  it('explicit: a turn whose last envelope is >>skip_reply waits; one that ends on a delivery continues', async () => {
    const framework = await createFramework(true, 'explicit');
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('>>#alpha posted'), prose('>>#alpha more\n>>skip_reply thinking it over')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2, 'the delivery continues; the >>skip_reply ending waits');
      assert.deepEqual(routed.map((r) => r.text), ['posted', 'more']);
      assert.deepEqual(notices(framework), [row(false)]);
    } finally {
      await framework.stop();
    }
  });

  it('hybrid: a turn left private by >>>skip_reply waits', async () => {
    const framework = await createFramework(true, 'hybrid');
    const routed = stubRegistry(framework);
    const triggers = script(framework, [prose('Out loud.'), prose('>>>skip_reply\nkeeping this to myself')]);
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.channelId, 'world:commons', 'the continuation keeps the hybrid locus');
      assert.equal(triggers[1]!.channelServerId, 'stub');
      assert.deepEqual(routed.map((r) => r.text), ['Out loud.']);
      assert.equal(notices(framework).length, 1);
    } finally {
      await framework.stop();
    }
  });

  it("a turn's ' !' continuation runs instead, with no notice and no count", async () => {
    const framework = await createFramework(true, 'explicit');
    stubRegistry(framework);
    const internals = framework as unknown as { autoContinueStreaks: Map<string, number> };
    const triggers = script(framework, [prose('>>#alpha ! step one'), prose('>>skip_reply done')]);
    // The count as the ' !' continuation's turn starts: before its own end
    // (a skip, which clears it anyway) can hide anything.
    const countAtStart: Array<number | undefined> = [];
    framework.onTrace((e) => {
      if ((e as { type: string }).type === 'inference:started') countAtStart.push(internals.autoContinueStreaks.get('assistant'));
    });
    try {
      trigger(framework);
      await within(framework.runUntilIdle(), 'the run');
      assert.equal(triggers.length, 2);
      assert.equal(triggers[1]!.reason, 'prose-continuation');
      assert.equal(notices(framework).length, 0);
      assert.equal(countAtStart[1], undefined, "the ' !' continuation counted toward nothing");
    } finally {
      await framework.stop();
    }
  });
});

describe('autoContinue config', () => {
  const at = (autoContinue: unknown) => ({ name: 'a', model: 'm', systemPrompt: '', autoContinue } as AgentConfig);

  it('reads off, true, and a cap', () => {
    assert.equal(resolveAutoContinue(at(undefined)), undefined);
    assert.equal(resolveAutoContinue(at(false)), undefined);
    assert.equal(resolveAutoContinue(at(null)), undefined);
    assert.deepEqual(resolveAutoContinue(at(true)), { maxConsecutive: 3 });
    assert.deepEqual(resolveAutoContinue(at({})), { maxConsecutive: 3 });
    assert.deepEqual(resolveAutoContinue(at({ maxConsecutive: 7 })), { maxConsecutive: 7 });
  });

  it('tells a string or number it can be true, false or an object', () => {
    assert.throws(() => resolveAutoContinue(at('true')), /must be true, false or an object such as \{ maxConsecutive: 3 \}, not a string \(true and false go unquoted\)/);
    assert.throws(() => resolveAutoContinue(at(1)), /must be true, false or an object/);
  });

  it('refuses anything else', () => {
    for (const bad of ['yes', 1, [], { maxConsecutive: 0 }, { maxConsecutive: 21 }, { maxConsecutive: 2.5 }, { maxConsecutive: '3' }]) {
      assert.throws(() => resolveAutoContinue(at(bad)), /Agent "a" autoContinue/, JSON.stringify(bad));
    }
  });

  it('names the value\'s kind, never the value, which could be a secret', () => {
    const secret = 'sk-ant-not-a-real-key';
    const message = (bad: unknown): string => {
      try { resolveAutoContinue(at(bad)); } catch (err) { return (err as Error).message; }
      return '';
    };
    assert.match(message({ maxConsecutive: secret }), /not a string:/);
    assert.ok(!message({ maxConsecutive: secret }).includes(secret));
    assert.ok(!message(secret).includes(secret));
    assert.match(message({ maxConsecutive: 0 }), /not a number below 1:/);
    assert.match(message({ maxConsecutive: 21 }), /not a number above 20:/);
    assert.match(message({ maxConsecutive: 2.5 }), /not a number that isn't whole:/);
  });
});

describe('autoContinueNotice', () => {
  it('names the agent and the way to stop, says what unmarked words do, and the cap only on the last', () => {
    assert.equal(
      autoContinueNotice({ agentName: 'lena', stop: 'call skip_reply', last: false }),
      "[continue] lena, another turn starts now. If you're done, call skip_reply; anything you write without it is sent as usual.",
    );
    assert.equal(
      autoContinueNotice({ agentName: 'lena', stop: 'end with a >>skip_reply envelope', last: true }),
      "[continue] lena, another turn starts now. If you're done, end with a >>skip_reply envelope; anything you write without it is sent as usual. " +
        'This is the last continuation in a row: after this turn you wait for the next event either way.',
    );
    assert.equal(
      autoContinueNotice({ agentName: 'lena', stop: 'call skip_reply', last: false, heldAfterSend: true }),
      '[continue] lena, another turn starts now. Your closing words last turn were held, not sent: that turn had already sent with a send tool. ' +
        "If you're done, call skip_reply; anything you write without it is sent as usual.",
    );
  });
});
