/**
 * Voice relay connection tests.
 *
 * Channel identity on inference:* traces: a channel-triggered turn
 * stamps its channelId on the whole trace family; a channel-less wake
 * leaves the field undefined; a stale locus pin from a previous turn does
 * not leak into the next turn's traces.
 *
 * abortInference(agentName, { keepText }): a user abort mid-turn
 * persists the spoken prefix as the assistant's turn (and routes it to the
 * turn's locus); an abort without keepText preserves the historical
 * discard; the string overload still works.
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
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

/** Module with a `hold` tool that parks the stream in waiting_for_tools until released. */
class HoldModule implements Module {
  readonly name = 'hold';
  toolStarted: Promise<void>;
  private signalToolStarted!: () => void;
  private release!: (r: ToolResult) => void;
  private held: Promise<ToolResult>;

  constructor() {
    this.toolStarted = new Promise((resolve) => (this.signalToolStarted = resolve));
    this.held = new Promise((resolve) => (this.release = resolve));
  }

  releaseTool(): void {
    this.release({ success: true, data: { ok: true } });
  }

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'hold',
        description: 'Blocks until released',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    this.signalToolStarted();
    return this.held;
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [
          {
            participant: 'Nick',
            content: [{ type: 'text', text: String((event as { content?: unknown }).content) }],
          },
        ],
        requestInference: true,
      };
    }
    return {};
  }
}

function channelIncoming(channelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'test-server',
    channelId,
    messageId: `m-${Math.floor(Math.random() * 1e9)}`,
    author: { id: 'u1', name: 'Nick' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** Minimal ChannelRegistry stub capturing routeSpeech calls (Proxy no-ops the rest). */
function stubChannelRegistry(framework: AgentFramework) {
  const routed: Array<{ text: string; locus: string | null }> = [];
  const explicit: Record<string, unknown> = {
    // The real registry resolves home → active trigger channel → default;
    // these scenarios trigger via chan-live, so a faithful stub pins it.
    resolveLocus: () => 'chan-live',
    routeSpeech: async (_agent: string, text: string, locus?: string | null) => {
      routed.push({ text, locus: locus ?? null });
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
    getChannelTools: () => [],
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return routed;
}

describe('channel identity on inference traces', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'channel-identity-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(modules: Module[] = []): Promise<AgentFramework> {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.' }],
      modules,
    });
  }

  it('stamps the triggering channel on the whole inference trace family', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hello there' }] as ContentBlock[]));
    const framework = await createFramework();
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));

    framework.pushEvent(channelIncoming('chan-voice-1', 'hey assistant'));
    await framework.runUntilIdle();

    const byType = (t: string) => traces.filter((e) => e.type === t);
    for (const type of [
      'inference:started',
      'inference:tokens',
      'inference:content_block',
      'inference:completed',
    ]) {
      const events = byType(type);
      assert.ok(events.length > 0, `expected at least one ${type} trace`);
      for (const e of events) {
        assert.equal(
          (e as { channelId?: string }).channelId,
          'chan-voice-1',
          `${type} carries the triggering channelId`,
        );
      }
    }

    await framework.stop();
  });

  it('leaves channelId undefined on channel-less wakes and clears stale pins between turns', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'First (channel) turn' }] as ContentBlock[]));
    const holdModule = new HoldModule();
    const framework = await createFramework([holdModule]);
    const traces: TraceEvent[] = [];
    framework.onTrace((e) => traces.push(e));

    // Turn 1: channel-triggered.
    framework.pushEvent(channelIncoming('chan-old', 'hello'));
    await framework.runUntilIdle();

    // Turn 2: module-triggered external message, no channel anywhere.
    // (Pushed only now: the mock membrane hands ALL queued responses to the
    // first stream, so turn 2's response must be queued after turn 1 ran.)
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Second (no channel) turn' }] as ContentBlock[]));
    const turn1Count = traces.length;
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'wake up',
      metadata: {},
    } as unknown as ProcessEvent);
    await framework.runUntilIdle();

    const turn2 = traces.slice(turn1Count).filter((e) => e.type.startsWith('inference:'));
    assert.ok(turn2.length > 0, 'second turn produced inference traces');
    for (const e of turn2) {
      assert.equal(
        (e as { channelId?: string }).channelId,
        undefined,
        `${e.type} on a channel-less turn must not inherit chan-old`,
      );
    }

    await framework.stop();
  });
});

describe('abortInference keepText', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let holdModule: HoldModule;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'abort-keeptext-test-'));
    membrane = new MockMembrane();
    holdModule = new HoldModule();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createFramework(): Promise<AgentFramework> {
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.' }],
      modules: [holdModule],
    });
  }

  function assistantTexts(framework: AgentFramework): string[] {
    const cm = framework.getAgent('assistant')!.getContextManager() as unknown as {
      queryMessages: (q: { participant?: string }) => {
        messages: Array<{ participant: string; content: Array<{ type: string; text?: string }> }>;
      };
    };
    return cm
      .queryMessages({ participant: 'assistant' })
      .messages.flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
  }

  /** Drive a turn into waiting_for_tools, abort it, settle, and return routed speech. */
  async function runAbortScenario(
    abortArg: string | { reason?: string; keepText?: string } | undefined,
  ): Promise<{
    framework: AgentFramework;
    routed: Array<{ text: string; locus: string | null }>;
    aborted: boolean;
    traces: Array<{ type: string; channelId?: string }>;
  }> {
    membrane.pushResponse(
      createMockResponse(
        [
          { type: 'text', text: 'The full sentence the model intended to say' },
          { type: 'tool_use', id: 'c1', name: 'hold--hold', input: {} },
        ] as ContentBlock[],
        'tool_use',
      ),
    );
    const framework = await createFramework();
    const routed = stubChannelRegistry(framework);
    const traces: Array<{ type: string; channelId?: string }> = [];
    framework.onTrace((t) => traces.push(t as never));

    framework.pushEvent(channelIncoming('chan-live', 'talk to me'));
    const idle = framework.runUntilIdle();
    await holdModule.toolStarted;

    const aborted = framework.abortInference('assistant', abortArg as never);
    holdModule.releaseTool();
    await idle;
    return { framework, routed, aborted, traces };
  }

  it('persists the spoken prefix to context without re-posting live-routed prose', async () => {
    // The round's prose was live-routed when the round yielded its tool call,
    // so the channel already holds the full sentence. keepText is a spoken
    // prefix of that same prose: the abort path must persist it to context
    // but must NOT post it again (the double-post this guard exists for).
    const keepText = 'The full sentence the mo';
    const { framework, routed, aborted, traces } = await runAbortScenario({
      reason: 'user_speech',
      keepText,
    });

    assert.equal(aborted, true, 'abort delivered');
    const texts = assistantTexts(framework);
    assert.ok(
      texts.includes(keepText),
      `context contains the spoken prefix (got: ${JSON.stringify(texts)})`,
    );
    assert.ok(
      !texts.includes('The full sentence the model intended to say'),
      'the full undelivered sentence is NOT in context',
    );
    const livePosts = routed.filter(
      (r) => r.text === 'The full sentence the model intended to say',
    );
    assert.equal(livePosts.length, 1, 'live-routed prose posted exactly once');
    assert.ok(
      !routed.some((r) => r.text === keepText),
      'the abort path does not re-post a prefix the live path already covered',
    );

    // The aborted trace carries the channel (as does the tool-call trace).
    const abortedTrace = traces.find((t) => t.type === 'inference:aborted');
    assert.equal(abortedTrace?.channelId, 'chan-live', 'aborted trace carries channelId');
    const yielded = traces.find((t) => t.type === 'inference:tool_calls_yielded');
    assert.equal(yielded?.channelId, 'chan-live', 'tool_calls_yielded trace carries channelId');

    await framework.stop();
  });

  it('routes only the suffix of keepText beyond the live-routed prose', async () => {
    // A whole-turn-accumulating voice client: keepText spans the live-routed
    // round AND continues past it. Only the continuation may be posted.
    const keepText = 'The full sentence the model intended to say and then a bit more';
    const { framework, routed } = await runAbortScenario({ reason: 'user_speech', keepText });

    assert.ok(
      routed.some((r) => r.text === 'and then a bit more'),
      `only the undelivered suffix is posted (routed: ${JSON.stringify(routed.map((r) => r.text))})`,
    );
    assert.ok(
      !routed.some((r) => r.text === keepText),
      'the full keepText (overlapping delivered prose) is never posted verbatim',
    );
    assert.ok(
      assistantTexts(framework).includes(keepText),
      'context still records the full spoken text',
    );
    await framework.stop();
  });

  it('posts diverging keepText whole (per-block voice clients)', async () => {
    // The reference client (melodeus) resets its spoken-text accumulator at
    // every block_start, so an interruption sends only the CURRENT
    // utterance's fragment — text the live path has never posted. It must be
    // posted whole, not dropped as a failed prefix match.
    const keepText = 'A different fragment from the next block';
    const { framework, routed } = await runAbortScenario({ reason: 'user_speech', keepText });

    assert.ok(
      routed.some((r) => r.text === keepText),
      `diverging keepText posted whole (routed: ${JSON.stringify(routed.map((r) => r.text))})`,
    );
    await framework.stop();
  });

  it('without keepText the partial turn is discarded (historical behavior)', async () => {
    const { framework, routed, aborted } = await runAbortScenario({ reason: 'user_speech' });

    assert.equal(aborted, true);
    assert.deepEqual(assistantTexts(framework), [], 'no assistant turn persisted');
    // Live prose routing may have delivered round prose before the abort —
    // but nothing may be routed BY the abort path itself. The only routed
    // text can be the live-routed round prose (full sentence), never a prefix.
    for (const r of routed) {
      assert.notEqual(r.text, '', 'no empty keepText routing');
    }

    await framework.stop();
  });

  it('string overload still works (backward compatible)', async () => {
    const { framework, aborted } = await runAbortScenario('manual');
    assert.equal(aborted, true, 'string reason accepted');
    assert.deepEqual(assistantTexts(framework), [], 'string form implies no keepText');
    await framework.stop();
  });
});
