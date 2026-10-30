/**
 * A message injected at a tool boundary goes into the live stream as the next
 * compile sends it: the agent's strategy renders the boundary's batch as the
 * newest of its window (ContextManager.renderAsNewest), cut by the per-message
 * cap and with the image limits applied across the batch. One the render
 * can't place among the newest, such as one before the recent window under
 * context-manager 0.23.0's memory strategy, goes in as stored, which is how
 * the next compile sends it.
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
    const pending = new Set<unknown>();
    const processed = new Promise<void>((resolve) => {
      if (batch.length === 0) { resolve(); return; }
      const off = this.framework!.onTrace((t) => {
        if (t.type !== 'process:completed' || !pending.delete(t.processEvent)) return;
        if (pending.size === 0) { off(); resolve(); }
      });
    });
    batch.forEach((blocks, i) => {
      const event = { type: 'external-message', source: 'test', content: '', blocks, metadata: {}, rowMetadata: metadata[i] } as unknown as ProcessEvent;
      pending.add(event);
      this.framework!.pushEvent(event);
    });
    await Promise.race([
      processed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the run loop never processed the interjections')), 10_000).unref()),
    ]);
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

  it('goes in as stored where the render gives null, in its place in the batch', async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    // The first of the batch comes back null, as for a message the render places before its window.
    const seen = renderWith((ids, real) => real(ids)!.map((c, i) => (i === 0 ? null : c)));
    const agent = framework.getAgent('assistant')!;
    const injected = await turnWith([[text('PLACEDBEFORE')], [text('HEARD')]]);
    assert.equal(seen.calls, 1, 'the batch is rendered in one call');
    assert.deepEqual(injected.map((m) => m.content), [[text('PLACEDBEFORE')], [text('HEARD')]]);
    const row = agent.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes('PLACEDBEFORE'))!;
    assert.ok(agent.getConsumedWatermark()!.sequence >= row.sequence, 'the consumed mark covers it, as anything injected');
  });

  it("each message goes in as its own render gives it, in its place in the batch", async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    // A stand-in render that marks each id's answer with its position, so a
    // message given another's render shows.
    renderWith((ids) => ids.map((_, i) => [text(`RENDERED${i}`)]));
    const injected = await turnWith([[text('FIRST')], [text('SECOND')]]);
    assert.deepEqual(injected.map((m) => m.content), [[text('RENDERED0')], [text('RENDERED1')]]);
  });

  it('a whole batch the render gives null goes in as stored, images and all, and nothing a tune-out holds', async () => {
    await create(new WindowedPassthroughStrategy({}));
    membrane.supportsInjectedMessages = true;
    const seen = renderWith((ids) => ids.map(() => null));
    const agent = framework.getAgent('assistant')!;
    module.interjectionMetadata = [{ tuneOut: { epochId: 'epoch-1' } }];
    const injected = await turnWith([[text('TUNEDOUT')], [text('PICTURED'), image()]]);
    const tuned = agent.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes('TUNEDOUT'))!;
    assert.ok(tuned && (tuned.metadata as { tuneOut?: unknown } | undefined)?.tuneOut, 'the premise: the boundary stored the tuned-out message, stamped');
    assert.equal(seen.calls, 1, 'the premise: the render ran');
    assert.deepEqual(injected.map((m) => m.content), [[text('PICTURED'), image()]]);
  });

  it("isn't injected where the agent's own view leaves it out, as it leaves out another agent's stored context injection, and the next request leaves it out too", async () => {
    await create(new AutobiographicalStrategy({ recentWindowTokens: 30_000 } as never));
    const agent = framework.getAgent('assistant')!;
    module.interjectionMetadata = [{ contextInjection: { agent: 'another', namespace: 'test', contentHash: 'h', part: 0, parts: 1 } }];
    const injected = await turnWith([[text('OTHERSCONTEXT')], [text('HEARD')]]);
    const row = agent.getContextManager().getAllMessages().find((m) => JSON.stringify(m.content).includes('OTHERSCONTEXT'));
    assert.ok(row, 'the premise: the boundary stored it');
    assert.equal(holding(injected, 'OTHERSCONTEXT'), '');
    assert.notEqual(holding(injected, 'HEARD'), '', 'the message beside it goes in');
    const next = await nextRequest();
    assert.equal(next('OTHERSCONTEXT'), '');
    assert.notEqual(next('HEARD'), '');
  });

  it("at the subconscious's boundary, its own view decides: a row written for it with a tune-out's stamp goes in, and another agent's stored context injection stays out, as its next request has them", async () => {
    let ctx: ModuleContext | null = null;
    const writer: Module = {
      name: 'writer',
      async start(c: ModuleContext) { ctx = c; },
      async stop() {},
      getTools: () => [],
      async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; },
      async onProcess() { return {}; },
    };
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'You are a robot pilot.' }],
      modules: [writer],
      subconscious: { enabled: true, systemPrompt: 'notice' },
    });
    framework.start();
    // Written for the subconscious as its turn's stream opens, so they wait for its tool boundary.
    const streams: Array<{ receivedToolResultOptions: Array<{ injectedMessages?: Array<{ content: unknown[] }> } | undefined> }> = [];
    const open = membrane.streamYielding.bind(membrane);
    let wrote = false;
    membrane.streamYielding = ((request: never, options: never) => {
      const stream = open(request, options);
      streams.push(stream as never);
      if (!wrote) {
        wrote = true;
        ctx!.addMessage('Antra', [text('TUNEDOUT')], { tuneOut: { epochId: 'epoch-1' } } as never, { forAgent: 'Subconscious' });
        ctx!.addMessage('Antra', [text('OTHERSCONTEXT')], { contextInjection: { agent: 'another', namespace: 'test', contentHash: 'h', part: 0, parts: 1 } } as never, { forAgent: 'Subconscious' });
      }
      return stream;
    }) as never;
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 't1', name: 'think', input: { content: 'hm' } }] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([text('Noted.')]));
    assert.equal(framework.nudgeAgent('Subconscious').ok, true);
    await framework.runUntilIdle();
    const injected = streams.flatMap((s) => s.receivedToolResultOptions).flatMap((o) => o?.injectedMessages ?? []);
    assert.ok(wrote, 'the premise: the writes were made while its turn ran');
    const stored = framework.getAgent('Subconscious')!.getContextManager().getAllMessages();
    assert.ok(stored.some((m) => JSON.stringify(m.content).includes('OTHERSCONTEXT')), 'the marked row is stored, not dropped');
    assert.notEqual(holding(injected, 'TUNEDOUT'), '', "its view holds a row with a tune-out's stamp, so it goes in");
    assert.equal(holding(injected, 'OTHERSCONTEXT'), '');
    membrane.pushResponse(createMockResponse([text('Again.')]));
    assert.equal(framework.nudgeAgent('Subconscious').ok, true);
    await framework.runUntilIdle();
    const sent = JSON.stringify(membrane.calls[membrane.calls.length - 1]!.messages);
    assert.ok(sent.includes('TUNEDOUT') && !sent.includes('OTHERSCONTEXT'), 'its next request has the one and not the other');
  });

  it('under the memory strategy, a batch bigger than the recent window whose oldest the render gives null goes in whole, as the next request sends it (context-manager#275, R1-1)', async () => {
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 4000, kvStableReachTokens: 8_000,
      compressionModel: 'mock', targetChunkTokens: 100, autoTickOnNewMessage: false,
    } as never));
    const cm = framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 3; i++) {
      cm.addMessage(i % 2 ? 'assistant' : 'user', [text(`hist${i} ` + Array.from({ length: 40 }, (_, k) => `word${k}`).join(' '))]);
    }
    const seen = renderWith((ids, real) => real(ids)!.map((c, i) => (i < 2 ? null : c)));
    const shots = [1, 2, 3, 4].map((i) => `SCREENSHOT${i}`);
    const injected = await turnWith(shots.map((s) => [text(s), image()]));
    assert.equal(seen.calls, 1, 'the premise: the boundary rendered the batch');
    // Every screenshot went into the live round, in the order it arrived.
    const live = injected.map((m) => JSON.stringify(m.content));
    assert.deepEqual(live.map((c) => shots.findIndex((s) => c.includes(s))), [0, 1, 2, 3], JSON.stringify(live.map((c) => c.slice(0, 60))));
    // The next request carries them where the live round did, right after the
    // tool result, in the same form.
    membrane.pushResponse(createMockResponse([text('Again.')]));
    go();
    await framework.runUntilIdle();
    const sentNext = membrane.calls[membrane.calls.length - 1]!.messages.map((m) => JSON.stringify(m.content));
    const at = shots.map((s) => sentNext.findIndex((c) => c.includes(s)));
    assert.deepEqual(at, at.map((_, k) => at[0]! + k), `in order, one after another: ${JSON.stringify(at)}`);
    assert.ok(sentNext[at[0]! - 1]!.includes('"tool_result"'), `right after the tool result: ${sentNext[at[0]! - 1]!.slice(0, 120)}`);
    assert.deepEqual(at.map((k) => JSON.parse(sentNext[k]!)), live.map((c) => JSON.parse(c)));
  });

  it('under the memory strategy, after a head window reset, a message the head has not filled up to and the render gives null goes in as the next request sends it', async () => {
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', headWindowTokens: 4000, compressionModel: 'mock',
      autoTickOnNewMessage: false,
    } as never));
    const cm = framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 3; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', [text(`hist${i} before the new topic`)]);
    await cm.resetHeadWindow('A new topic.');
    const seen = renderWith((ids) => ids.map(() => null));
    const injected = await turnWith([[text('AFTERRESET a short message')]]);
    assert.equal(seen.calls, 1, 'the premise: the boundary rendered the batch');
    const live = holding(injected, 'AFTERRESET');
    assert.deepEqual(JSON.parse(live), [text('AFTERRESET a short message')], 'it goes in as stored');
    assert.deepEqual(JSON.parse((await nextRequest())('AFTERRESET')), JSON.parse(live), 'as the next request sends it');
  });

  it('under the memory strategy, a body bigger than the recent window that the render gives null goes in as stored, and the rest as the next request sends it', async () => {
    // The strategy stores the long message as several shards. As stored, it
    // goes in whole, as the store reads it back, which may differ from the
    // blocks as they were queued.
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 300, kvStableReachTokens: 8_000,
      targetChunkTokens: 200,
    }));
    const long = 'FIRSTLONG ' + Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const seen = renderWith((ids, real) => real(ids)!.map((c, i) => (i === 0 ? null : c)));
    const injected = await turnWith([[text('Intro. '), image(), text(long)], [text('SECONDSHORT and a few words more')]]);
    assert.equal(seen.calls, 1, 'the premise: the boundary rendered the batch');
    const rows = framework.getAgent('assistant')!.getContextManager().getAllMessages();
    const row = rows.find((m) => JSON.stringify(m.content).includes('FIRSTLONG'))!;
    assert.ok(rows.filter((m) => m.bodyGroupId !== undefined && m.bodyGroupId === row.bodyGroupId).length > 1, 'the premise: it is stored in parts');
    const first = JSON.parse(holding(injected, 'FIRSTLONG')) as Array<{ type: string; text?: string }>;
    assert.equal(first.filter((b) => b.type === 'image').length, 1, 'its image, once');
    assert.equal(first.filter((b) => b.type === 'text').map((b) => b.text).join(''), `Intro. ${long}`, 'its text, whole and in order');
    const second = holding(injected, 'SECONDSHORT');
    assert.deepEqual(JSON.parse((await nextRequest())('SECONDSHORT')), JSON.parse(second));
  });

  it("under the memory strategy's own render, a batch bigger than the recent window goes in whole, as the next request sends it", async () => {
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 4000, kvStableReachTokens: 8_000,
      compressionModel: 'mock', targetChunkTokens: 100, autoTickOnNewMessage: false,
    } as never));
    const cm = framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 3; i++) {
      cm.addMessage(i % 2 ? 'assistant' : 'user', [text(`hist${i} ` + Array.from({ length: 40 }, (_, k) => `word${k}`).join(' '))]);
    }
    const shots = [1, 2, 3, 4].map((i) => `SCREENSHOT${i}`);
    const injected = await turnWith(shots.map((s) => [text(s), image()]));
    const live = shots.map((s) => holding(injected, s));
    assert.ok(live.every((c) => c !== ''), 'the premise: every screenshot went into the live round');
    const next = await nextRequest();
    assert.deepEqual(shots.map((s) => JSON.parse(next(s) || 'null')), live.map((c) => JSON.parse(c || 'null')));
  });

  it("under the memory strategy's own render, after a head window reset, a message the head has not filled up to goes in as the next request sends it", async () => {
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', headWindowTokens: 4000, compressionModel: 'mock',
      autoTickOnNewMessage: false,
    } as never));
    const cm = framework.getAgent('assistant')!.getContextManager();
    for (let i = 0; i < 3; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', [text(`hist${i} before the new topic`)]);
    await cm.resetHeadWindow('A new topic.');
    const injected = await turnWith([[text('AFTERRESET a short message')]]);
    const live = holding(injected, 'AFTERRESET');
    assert.notEqual(live, '', 'the premise: it went into the live round');
    assert.deepEqual(JSON.parse((await nextRequest())('AFTERRESET')), JSON.parse(live));
  });

  it("under the memory strategy's own render, the message after a body bigger than the recent window goes in as the next request sends it", async () => {
    await create(new AutobiographicalStrategy({
      adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 300, kvStableReachTokens: 8_000,
      targetChunkTokens: 200,
    }));
    const long = 'FIRSTLONG ' + Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const injected = await turnWith([[text('Intro. '), image(), text(long)], [text('SECONDSHORT and a few words more')]]);
    const live = holding(injected, 'SECONDSHORT');
    assert.notEqual(live, '', 'the premise: it went into the live round');
    assert.deepEqual(JSON.parse((await nextRequest())('SECONDSHORT')), JSON.parse(live));
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
});
