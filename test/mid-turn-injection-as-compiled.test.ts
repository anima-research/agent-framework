/**
 * A message injected at a tool boundary goes into the live stream as the next
 * compile sends it: the agent's strategy renders the boundary's batch as the
 * newest of its window (ContextManager.renderAsNewest), cut by the per-message
 * cap and with the image limits applied across the batch. One the next compile
 * won't send among its newest isn't injected, which is logged, and a notice
 * after the batch tells the agent of it.
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
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import { AutobiographicalStrategy, WindowedPassthroughStrategy, type ContextInjection, type MessageId } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const image = (): ContentBlock => ({ type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } } as ContentBlock);
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);

/** A tool whose call stores messages while it runs, as chat arriving mid-turn does. */
class InterjectingModule implements Module {
  readonly name = 'robot';
  framework: AgentFramework | null = null;
  /** The next `move` pushes each of these as an external message before it returns. */
  interjections: ContentBlock[][] = [];
  /** Metadata for the interjection at the same index, if any. */
  interjectionMetadata: Array<Record<string, unknown> | undefined> = [];
  /** Whom each interjection is from; the message that starts a turn is Antra's. */
  participant = 'Antra';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  async gatherContext(): Promise<ContextInjection[]> { return []; }

  getTools(): ToolDefinition[] {
    return [{ name: 'move', description: 'Move the robot', inputSchema: { type: 'object', properties: {} } }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const batch = this.interjections;
    const metadata = this.interjectionMetadata;
    this.interjections = [];
    this.interjectionMetadata = [];
    batch.forEach((blocks, i) => {
      this.framework!.pushEvent({ type: 'external-message', source: 'test', content: '', blocks, metadata: {}, rowMetadata: metadata[i] } as unknown as ProcessEvent);
    });
    // A beat for the run loop to defer them while this round's tools are pending.
    if (batch.length > 0) await new Promise((r) => setTimeout(r, 30));
    return { success: true, data: { ok: true, tool: call.name } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const blocks = (event as { blocks?: ContentBlock[] }).blocks;
    const rowMetadata = (event as { rowMetadata?: Record<string, unknown> }).rowMetadata;
    const go = (event as { content?: unknown }).content === 'go';
    return {
      addMessages: [{
        participant: blocks ? this.participant : 'Antra',
        content: blocks ?? [text(String((event as { content?: unknown }).content))],
        ...(rowMetadata ? { metadata: rowMetadata } : {}),
      }],
      requestInference: go,
    };
  }
}

describe('a message injected at a tool boundary', () => {
  let tempDir: string;
  let membrane: MockMembrane;
  let module: InterjectingModule;
  let framework: AgentFramework;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'injection-as-compiled-'));
    membrane = new MockMembrane();
    module = new InterjectingModule();
  });

  afterEach(async () => {
    await framework?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function create(strategy: unknown, modules: Module[] = [], agentName = 'assistant'): Promise<AgentFramework> {
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: agentName, model: 'test-model', systemPrompt: 'You are a robot pilot.', strategy: strategy as never }],
      modules: [module, ...modules],
    });
    module.framework = framework;
    return framework;
  }

  const go = (): void => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
  };

  /** One turn: a round that calls `move`, during which `interjections` arrive, then an answer. */
  async function turnWith(interjections: ContentBlock[][]): Promise<Array<{ participant?: string; content: unknown[] }>> {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'c1', name: 'robot--move', input: {} }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([text('Moved.')]));
    module.interjections = interjections;
    go();
    await framework.runUntilIdle();
    return (membrane.lastStream?.receivedToolResultOptions ?? []).flatMap((o) => o?.injectedMessages ?? []);
  }

  /** The next turn's request, as the strategy compiles it: each message's content, by a marker it holds. */
  async function nextRequest(): Promise<(marker: string) => string> {
    membrane.pushResponse(createMockResponse([text('Again.')]));
    go();
    await framework.runUntilIdle();
    const sent = membrane.calls[membrane.calls.length - 1]!.messages.map((m) => JSON.stringify(m.content));
    return (marker) => sent.find((s) => s.includes(marker)) ?? '';
  }

  const holding = (injected: Array<{ content: unknown[] }>, marker: string): string =>
    injected.map((m) => JSON.stringify(m.content)).find((s) => s.includes(marker)) ?? '';

  it('goes in cut by the per-message cap, as the next request sends it', async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    const long = 'LONGMSG ' + Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const injected = await turnWith([[text(long)]]);
    const live = holding(injected, 'LONGMSG');
    assert.ok(live.length > 0 && live.length < long.length, `the live round carries it cut (${live.length} of ${long.length} characters)`);
    assert.deepEqual(JSON.parse((await nextRequest())('LONGMSG')), JSON.parse(live));
  });

  it("goes in with the batch's images counted newest-first across it, as the next request counts them", async () => {
    await create(new WindowedPassthroughStrategy({ maxLiveImages: 1 }));
    const injected = await turnWith([[text('FIRSTPIC'), image()], [text('SECONDPIC'), image()]]);
    const first = holding(injected, 'FIRSTPIC');
    const second = holding(injected, 'SECONDPIC');
    assert.ok(!first.includes(PNG), 'the older message goes in without its image');
    assert.ok(second.includes(PNG), 'the newest keeps its image');
    const next = await nextRequest();
    assert.deepEqual(JSON.parse(next('FIRSTPIC')), JSON.parse(first));
    assert.deepEqual(JSON.parse(next('SECONDPIC')), JSON.parse(second));
  });

  /** Replaces the agent's ContextManager.renderAsNewest for the test. */
  function renderWith(impl: (ids: readonly MessageId[], real: (ids: readonly MessageId[]) => Array<ContentBlock[] | null> | undefined) => Array<ContentBlock[] | null> | undefined): { calls: number } {
    const cm = framework.getAgent('assistant')!.getContextManager();
    const real = cm.renderAsNewest.bind(cm);
    const seen = { calls: 0 };
    (cm as { renderAsNewest: unknown }).renderAsNewest = (ids: readonly MessageId[]) => { seen.calls++; return impl(ids, real); };
    return seen;
  }

  it("isn't injected where the next compile won't send it among its newest, which is logged, and a notice after the batch tells the agent of it", async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    // The first of the batch comes back null, as for a message the view leaves out.
    const seen = renderWith((ids, real) => real(ids)!.map((c, i) => (i === 0 ? null : c)));
    const agent = framework.getAgent('assistant')!;
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let injected: Array<{ content: unknown[] }>;
    try {
      injected = await turnWith([[text('LEFTOUT')], [text('HEARD')]]);
    } finally {
      console.error = original;
    }
    assert.equal(seen.calls, 1, 'the batch is rendered in one call');
    const row = agent.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes('LEFTOUT'))!;
    assert.ok(row, 'the premise: the boundary stored it');
    // Who sent it, its size, and its id where the agent has no history--extract; none of its words.
    const notice = text(
      "[not shown] For assistant: A message arrived during your turn that isn't shown here, since your context doesn't keep it among your newest messages:\n" +
      `- From Antra, 7 characters. Its id is ${row.id}.`,
    );
    assert.deepEqual(injected.map((m) => m.content), [[text('HEARD')], [notice]]);
    assert.ok(logged.some((l) => l.includes('[injection]') && l.includes('left out') && l.includes(row.id)), `the log names it: ${JSON.stringify(logged)}`);
    // As anything stored at a boundary that marks: the text says what that costs.
    assert.ok(agent.getConsumedWatermark()!.sequence >= row.sequence, 'the consumed mark covers it');
    // Stored after the batch, so the next request carries it where the live round heard it.
    const stored = agent.getContextManager().getAllMessages();
    const heardAt = stored.findIndex((m) => JSON.stringify(m.content).includes('HEARD'));
    assert.equal(stored[heardAt + 1]?.metadata?.system, true, 'the notice is stored right after the batch, as a system line');
    assert.deepEqual(JSON.parse((await nextRequest())('[not shown]')), [notice]);
  });

  it("names a left-out message's sender in its notice as the store keeps the name, a lone surrogate as U+FFFD", async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    renderWith((ids, real) => real(ids)!.map((c, i) => (i === 0 ? null : c)));
    module.participant = 'An \ud83d tra';
    const injected = await turnWith([[text('LEFTOUT')], [text('HEARD')]]);
    const notice = JSON.parse(holding(injected, '[not shown]') || '[]') as Array<{ text?: string }>;
    assert.ok(notice[0]?.text, 'the premise: the boundary injected its notice');
    assert.ok(notice[0]!.text!.isWellFormed() && notice[0]!.text!.includes('From An \ufffd tra'), `the notice names the sender well formed: ${JSON.stringify(notice[0]!.text)}`);
    assert.deepEqual(JSON.parse((await nextRequest())('[not shown]')), notice, 'as the next request sends it');
  });

  it('tells the agent of a boundary whose whole batch is left out, with each one\'s images, and names no message a tune-out holds', async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    renderWith((ids) => ids.map(() => null));
    const agent = framework.getAgent('assistant')!;
    module.interjectionMetadata = [{ tuneOut: { epochId: 'epoch-1' } }];
    const original = console.error;
    console.error = () => {};
    let injected: Array<{ content: unknown[] }>;
    try {
      injected = await turnWith([[text('TUNEDOUT')], [text('PICTURED'), image()]]);
    } finally {
      console.error = original;
    }
    const rows = agent.getContextManager().getAllMessages();
    const tuned = rows.find((m) => JSON.stringify(m.content).includes('TUNEDOUT'))!;
    const pictured = rows.find((m) => JSON.stringify(m.content).includes('PICTURED'))!;
    assert.ok(tuned && (tuned.metadata as { tuneOut?: unknown } | undefined)?.tuneOut, 'the premise: the boundary stored the tuned-out message, stamped');
    assert.deepEqual(injected.map((m) => m.content), [[text(
      "[not shown] For assistant: A message arrived during your turn that isn't shown here, since your context doesn't keep it among your newest messages:\n" +
      `- From Antra, 8 characters and 1 image. Its id is ${pictured.id}.`,
    )]]);
    // The notice is what the boundary injects, so its mark covers what it left out.
    assert.ok(agent.getConsumedWatermark()!.sequence >= pictured.sequence, 'the consumed mark covers it');
  });

  it('under the memory strategy, a batch bigger than the recent window: the message before it is left out, and the rest goes in as the next request carries it', async () => {
    // No stand-in: the strategy's own render decides. A recent window smaller than the batch puts the
    // batch's first message before it, and a small shard size stores that message as several, as a
    // resident's long message is.
    const history = new HistoryModule();
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 300, kvStableReachTokens: 8_000,
      targetChunkTokens: 200,
    }), [history]);
    history.bind(framework.getAgent('assistant')!.getContextManager());
    // About 1,000 tokens, more than the recent window holds, then a short message that fits in it.
    const long = 'FIRSTLONG ' + Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let injected: Array<{ content: unknown[] }>;
    try {
      injected = await turnWith([[text(long)], [text('SECONDSHORT and a few words more')]]);
    } finally {
      console.error = original;
    }
    assert.equal(holding(injected, 'FIRSTLONG'), '', 'the message before the recent window is left out');
    const second = holding(injected, 'SECONDSHORT');
    assert.ok(second.length > 0, 'the rest of the batch goes in');
    assert.ok(logged.some((l) => l.includes('[injection]') && l.includes('left out')), `the log names it: ${JSON.stringify(logged.filter((l) => l.includes('[injection]')))}`);
    const rows = framework.getAgent('assistant')!.getContextManager().getAllMessages();
    const row = rows.find((m) => JSON.stringify(m.content).includes('FIRSTLONG'))!;
    const parts = rows.filter((m) => m.bodyGroupId !== undefined && m.bodyGroupId === row.bodyGroupId).length;
    assert.ok(parts > 1, `the premise: the long message is stored as several parts (${parts})`);
    // The agent is shown history--extract, so the notice gives the call that reads just that message, every part.
    const call = `history--extract with aroundId "${row.id}", before 0 and after ${parts - 1} reads it, stored as ${parts} parts.`;
    const notice = holding(injected, '[not shown]');
    const said = (JSON.parse(notice) as Array<{ text: string }>)[0]!.text;
    assert.ok(said.endsWith(`\n- From Antra, ${long.length.toLocaleString('en-US')} characters. ${call}`), said);
    assert.ok(!said.includes('FIRSTLONG') && !said.includes('word0'), 'none of its words');
    const next = await nextRequest();
    assert.deepEqual(JSON.parse(next('SECONDSHORT')), JSON.parse(second));
    assert.deepEqual(JSON.parse(next('[not shown]')), JSON.parse(notice));
    // The call the notice gives reads the message.
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'x1', name: 'history--extract', input: { aroundId: row.id, before: 0, after: parts - 1 } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([text('Read it.')]));
    go();
    await framework.runUntilIdle();
    const result = JSON.stringify(membrane.lastStream!.receivedToolResults);
    assert.ok(result.includes('FIRSTLONG') && result.includes('word599') && !result.includes('SECONDSHORT'), `that message, whole, alone: ${result.slice(0, 300)}`);
  });

  it('goes in as stored where the strategy has no render', async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    renderWith(() => undefined);
    const long = 'LONGMSG ' + Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const injected = await turnWith([[text(long)]]);
    assert.deepEqual(JSON.parse(holding(injected, 'LONGMSG')), [text(long)]);
  });

  it("goes in with its sender's name as the store keeps it, a lone surrogate as U+FFFD", async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    module.participant = 'An \ud83d tra';
    const injected = await turnWith([[text('NAMEDMSG')]]);
    const live = injected.find((m) => JSON.stringify(m.content).includes('NAMEDMSG'));
    assert.equal(live?.participant, 'An \ufffd tra', 'the live round names its sender well formed');
    membrane.pushResponse(createMockResponse([text('Again.')]));
    go();
    await framework.runUntilIdle();
    const stored = membrane.calls[membrane.calls.length - 1]!.messages.find((m) => JSON.stringify(m.content).includes('NAMEDMSG'));
    assert.equal(live?.participant, stored?.participant, 'as the next request names it');
  });

  it("isn't injected where its sender's name, as the store keeps it, is the agent's own", async () => {
    // It would render as the agent's own turn mid-round, a prefill.
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }), [], 'Robo \ufffd');
    module.participant = 'Robo \ud83d';
    const injected = await turnWith([[text('SELFMSG')]]);
    assert.equal(holding(injected, 'SELFMSG'), '', 'the live round leaves it out');
  });

  it("gives the round's results to the stream when a queued sender's name isn't a string", { timeout: 20_000 }, async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    module.participant = 42 as unknown as string;
    // A turn whose results never reach the stream never ends, so the wait is
    // bounded and the assertion says what happened. On main it passes: this
    // pins that the boundary's name step keeps main's handling.
    await Promise.race([turnWith([[text('NUMMSG')]]), new Promise((r) => setTimeout(r, 10_000))]);
    assert.ok((membrane.lastStream?.receivedToolResults ?? []).length > 0, "the round's results reach the stream");
  });

  it('goes in with its text as the store keeps it where the strategy has no render, a lone surrogate as U+FFFD', async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    renderWith(() => undefined);
    const injected = await turnWith([[text('LONEMSG cut \ud83d here')]]);
    assert.deepEqual(JSON.parse(holding(injected, 'LONEMSG')), [text('LONEMSG cut \ufffd here')]);
    assert.equal(JSON.parse((await nextRequest())('LONEMSG'))[0].text, 'LONEMSG cut \ufffd here', 'as the next request sends it');
  });

  it('goes in as stored where the render throws, which is logged', async () => {
    await create(new WindowedPassthroughStrategy({ maxMessageTokens: 50 }));
    renderWith(() => { throw new Error('render broke'); });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let injected: Array<{ content: unknown[] }>;
    try {
      injected = await turnWith([[text('THROWNMSG and more')]]);
    } finally {
      console.error = original;
    }
    assert.deepEqual(JSON.parse(holding(injected, 'THROWNMSG')), [text('THROWNMSG and more')]);
    assert.ok(logged.some((l) => l.includes('[injection]') && l.includes('render broke')), 'the failure is logged');
  });

  it('renders nothing at a boundary with nothing to inject', async () => {
    await create(new WindowedPassthroughStrategy({}));
    const seen = renderWith((ids, real) => real(ids));
    await turnWith([]);
    assert.equal(membrane.lastStream!.receivedToolResults.length, 1, 'the premise: a tool boundary passed');
    assert.equal(seen.calls, 0);
  });
});
