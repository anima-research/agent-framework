/**
 * Signed thinking blocks are stamped with their replay price at persist time.
 *
 * On keep-all models the hidden chain of thought behind a signed thinking
 * block is replayed and billed as input on every later call; the only exact
 * measure of its size is this call's `usage.output_tokens` minus the visible
 * blocks. The framework stamps that residual as `tokenEstimate` on the
 * signed blocks (context-manager prefers the stamp over any heuristic), per
 * round for tool-use turns and on the trailing content at completion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AnthropicAdapter, Membrane, NativeFormatter } from '@animalabs/membrane';
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
import { stampThinkingTokenEstimates, withoutTokenEstimates } from '../src/thinking-token-stamp.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SIG_A = 'A'.repeat(4_000);
const SIG_B = 'B'.repeat(3_000);

type Stamped = ContentBlock & { tokenEstimate?: number; signature?: string };

describe('stampThinkingTokenEstimates (pure)', () => {
  it('stamps the residual of output tokens over visible blocks on the signed block', () => {
    const signed = { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock;
    // With nothing visible beside it, the signed block carries every output token.
    assert.equal((stampThinkingTokenEstimates([signed], 3_000)[0] as Stamped).tokenEstimate, 3_000);
    const blocks: ContentBlock[] = [signed, { type: 'text', text: 'hello' }];
    const out = stampThinkingTokenEstimates(blocks, 3_000) as Stamped[];
    const fewer = stampThinkingTokenEstimates(blocks, 2_000) as Stamped[];
    assert.ok(out[0]!.tokenEstimate! < 3_000, 'the visible text is taken out of the residual');
    assert.equal(out[0]!.tokenEstimate! - fewer[0]!.tokenEstimate!, 1_000, 'and the rest of the output tokens are the residual');
    assert.equal(out[0]!.signature, SIG_A);
    assert.equal(out[1]!.tokenEstimate, undefined, 'the text block carries no stamp');
    assert.equal((blocks[0] as Stamped).tokenEstimate, undefined, 'input block is not mutated');
  });

  it('splits the residual across several carriers by signature length', () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'A'.repeat(3_000) } as ContentBlock;
    const redacted = { type: 'redacted_thinking', data: 'B'.repeat(1_000) } as ContentBlock;
    // Nothing visible: the whole 4,000 is the residual, split 3:1.
    const alone = stampThinkingTokenEstimates([thinking, redacted], 4_000) as Stamped[];
    assert.deepEqual(alone.map((b) => b.tokenEstimate), [3_000, 1_000]);
    // A visible block between them takes no share, and the carriers still split what's left 3:1.
    const out = stampThinkingTokenEstimates([thinking, { type: 'tool_use', id: 't1', name: 'x', input: {} }, redacted], 4_000) as Stamped[];
    assert.equal(out[1]!.tokenEstimate, undefined);
    assert.ok(Math.abs(out[0]!.tokenEstimate! - 3 * out[2]!.tokenEstimate!) <= 3, `${out[0]!.tokenEstimate} and ${out[2]!.tokenEstimate}`);
    assert.ok(out[0]!.tokenEstimate! + out[2]!.tokenEstimate! < 4_000, "the tool_use's estimate is taken out first");
  });

  it('leaves unsigned thinking, already-stamped blocks and non-positive residuals alone', () => {
    const unsigned: ContentBlock[] = [{ type: 'thinking', thinking: 'visible reasoning' } as ContentBlock];
    assert.deepEqual(stampThinkingTokenEstimates(unsigned, 500), unsigned);

    const stamped: ContentBlock[] = [{ type: 'thinking', thinking: '', signature: SIG_A, tokenEstimate: 42 } as ContentBlock];
    assert.equal((stampThinkingTokenEstimates(stamped, 5_000)[0] as Stamped).tokenEstimate, 42);

    const overshoot: ContentBlock[] = [
      { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock,
      { type: 'text', text: 'x'.repeat(10_000) },
    ];
    assert.deepEqual(stampThinkingTokenEstimates(overshoot, 100), overshoot);
    assert.deepEqual(stampThinkingTokenEstimates(overshoot, 0), overshoot);
  });
});

class EchoModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'echo',
      description: 'Echoes the input',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { echoed: (call.input as { message: string }).message } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text' as const, text: String(event.content) }] }],
      requestInference: true,
    };
  }
}

describe('thinking token stamp through the stream loop', () => {
  it('stamps each round from that call\'s own output tokens (membrane usage is cumulative)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thinking-stamp-'));
    const membrane = new MockMembrane();
    const round1 = createMockResponse([
      { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock,
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'call_1', name: 'test--echo', input: { message: 'one' } },
    ], 'tool_use');
    round1.usage = { inputTokens: 100, outputTokens: 2_000 };
    const round2 = createMockResponse([
      { type: 'thinking', thinking: '', signature: SIG_B } as ContentBlock,
      { type: 'text', text: 'done' },
    ]);
    // Membrane reports usage CUMULATIVELY across the tool loop.
    round2.usage = { inputTokens: 250, outputTokens: 3_500 };
    membrane.pushResponse(round1);
    membrane.pushResponse(round2);

    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
      modules: [new EchoModule()],
    });
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();

      const cm = framework.getAgent('assistant')!.getContextManager();
      const msgs = (cm.queryMessages({}).messages ?? []) as unknown as Array<{ content: Stamped[] }>;
      const thinking = msgs.flatMap((m) => m.content).filter((b) => b.type === 'thinking');
      assert.equal(thinking.length, 2, 'both rounds persisted their thinking block');

      const [t1, t2] = thinking as [Stamped, Stamped];
      assert.equal(t1.signature, SIG_A);
      assert.equal(t2.signature, SIG_B);
      // Each round as the stamp computes it from that call's own output
      // tokens: round 2's are 3500 - 2000, not the cumulative 3500.
      const expected = (blocks: ContentBlock[], outputTokens: number) =>
        (stampThinkingTokenEstimates(blocks, outputTokens)[0] as Stamped).tokenEstimate;
      assert.equal(t1.tokenEstimate, expected(round1.content, 2_000));
      assert.equal(t2.tokenEstimate, expected(round2.content, 1_500));
      assert.notEqual(t2.tokenEstimate, expected(round2.content, 3_500), 'the cumulative count would stamp more');

      const others = msgs.flatMap((m) => m.content).filter((b) => b.type !== 'thinking');
      for (const b of others) assert.equal(b.tokenEstimate, undefined, `${b.type} must not be stamped`);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('withoutTokenEstimates (pure)', () => {
  it('drops the stamp from each top-level block, copying only what held one', () => {
    const thinking = { type: 'thinking', thinking: '', signature: SIG_A, tokenEstimate: 7 } as ContentBlock;
    const redacted = { type: 'redacted_thinking', data: 'R', tokenEstimate: 9 } as ContentBlock;
    const plain = { type: 'text', text: 'hi' } as ContentBlock;
    // Stored history the helper doesn't recognize goes on as it is, for
    // membrane to judge, rather than failing every request here.
    const untouched = { participant: 'User', content: [plain, null, 'odd'] as unknown as ContentBlock[] };
    const holder = { participant: 'assistant', content: [thinking, redacted, plain] };
    const out = withoutTokenEstimates([untouched, holder]);
    assert.deepEqual(out[0], untouched, 'a message with no stamp is passed on as it is');
    assert.deepEqual(out[1]!.content, [
      { type: 'thinking', thinking: '', signature: SIG_A },
      { type: 'redacted_thinking', data: 'R' },
      plain,
    ]);
    assert.equal((thinking as Stamped).tokenEstimate, 7, 'each block handed in keeps its stamp');
    assert.equal((redacted as Stamped).tokenEstimate, 9, 'each block handed in keeps its stamp');
    assert.deepEqual(holder.content.map((b) => (b as Stamped).tokenEstimate), [7, 9, undefined], 'the message handed in is unchanged');
  });
});

/**
 * Membrane's real Anthropic request builder, each reply scripted: what each
 * request would put on the wire is kept in `sent`.
 */
class WireAnthropic extends AnthropicAdapter {
  readonly sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  readonly replies: Array<{ content: ContentBlock[]; stopReason: string; usage: { inputTokens: number; outputTokens: number } }> = [];
  constructor() { super({ apiKey: 'test', cacheKeepalive: { enabled: false } } as never); }
  override async stream(...args: Parameters<AnthropicAdapter['stream']>): ReturnType<AnthropicAdapter['stream']> {
    const [request, callbacks, options] = args;
    const wire = (this as unknown as { buildRequest(r: unknown, onAltered?: unknown): unknown })
      .buildRequest(request, (options as { onContentAltered?: unknown } | undefined)?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)));
    const reply = this.replies.shift()
      ?? { content: [{ type: 'text', text: 'done' }] as ContentBlock[], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
    for (const block of reply.content) if (block.type === 'text') callbacks.onChunk(block.text);
    return { ...reply, model: request.model, rawRequest: wire, raw: {} } as never;
  }
}

class Speaker implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true };
  }
}

describe('the stamp stays in the store and off the wire', () => {
  const DATA = 'R'.repeat(1_000);

  /** A framework whose first reply carries a signed thinking block and a
   *  redacted_thinking block, which it stores stamped. */
  async function stampedFramework(dir: string) {
    const adapter = new WireAnthropic();
    adapter.replies.push({
      content: [
        { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock,
        { type: 'redacted_thinking', data: DATA } as ContentBlock,
        { type: 'text', text: 'hi' },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 2_000 },
    });
    const framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'assistant', model: 'claude-sonnet-4-5', systemPrompt: 'Test' }],
      modules: [new Speaker()],
    });
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    return { adapter, framework };
  }

  function storedStamps(framework: AgentFramework): Array<[string, unknown]> {
    const messages = (framework.getAgent('assistant')!.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{ content: Stamped[] }>;
    return messages.flatMap((m) => m.content)
      .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
      .map((b) => [b.type, b.tokenEstimate]);
  }

  function assertSentUnstamped(sent: WireAnthropic['sent'][number] | undefined): void {
    assert.ok(sent, 'a second request was built');
    assert.ok(!JSON.stringify(sent).includes('tokenEstimate'), 'no block on the wire carries tokenEstimate');
    const assistant = sent.messages.find((m) => m.role === 'assistant');
    assert.deepEqual(
      (assistant?.content as Array<{ type: string }>).filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
      [{ type: 'thinking', thinking: '', signature: SIG_A }, { type: 'redacted_thinking', data: DATA }],
      "each thinking block goes out with the API's own fields, as stored",
    );
  }

  it('on a framework turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thinking-stamp-wire-'));
    const { adapter, framework } = await stampedFramework(dir);
    try {
      const stamps = storedStamps(framework);
      assert.equal(stamps.length, 2);
      for (const [, stamp] of stamps) assert.equal(typeof stamp, 'number', 'the first reply stored its thinking blocks stamped');
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'again', metadata: {} } as unknown as ProcessEvent);
      await framework.runUntilIdle();
      assertSentUnstamped(adapter.sent[1]);
      assert.deepEqual(storedStamps(framework), stamps, 'the store keeps each stamp');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('through the direct API (runInference)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thinking-stamp-wire-direct-'));
    const { adapter, framework } = await stampedFramework(dir);
    try {
      const stamps = storedStamps(framework);
      assert.equal(stamps.length, 2);
      await framework.getAgent('assistant')!.runInference([]);
      assertSentUnstamped(adapter.sent[1]);
      assert.deepEqual(storedStamps(framework), stamps, 'the store keeps each stamp');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
