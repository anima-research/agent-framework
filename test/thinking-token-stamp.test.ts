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
import { stampThinkingTokenEstimates } from '../src/thinking-token-stamp.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const SIG_A = 'A'.repeat(4_000);
const SIG_B = 'B'.repeat(3_000);

type Stamped = ContentBlock & { tokenEstimate?: number; signature?: string };

describe('stampThinkingTokenEstimates (pure)', () => {
  it('stamps the residual of output tokens over visible blocks on the signed block', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock,
      { type: 'text', text: 'hello' },
    ];
    const out = stampThinkingTokenEstimates(blocks, 3_000) as Stamped[];
    assert.equal(out[0]!.tokenEstimate, 3_000 - Math.ceil(5 / 2.9));
    assert.equal(out[0]!.signature, SIG_A);
    assert.equal(out[1], blocks[1], 'non-carrier blocks are the same object');
    assert.equal((blocks[0] as Stamped).tokenEstimate, undefined, 'input block is not mutated');
  });

  it('splits the residual across several carriers by signature length', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: '', signature: 'A'.repeat(3_000) } as ContentBlock,
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'redacted_thinking', data: 'B'.repeat(1_000) } as ContentBlock,
    ];
    const out = stampThinkingTokenEstimates(blocks, 4_021) as Stamped[]; // tool_use {} = 1 + 20 tokens
    assert.equal(out[0]!.tokenEstimate, 3_000);
    assert.equal(out[2]!.tokenEstimate, 1_000);
  });

  it('leaves unsigned thinking, already-stamped blocks and non-positive residuals alone', () => {
    const unsigned: ContentBlock[] = [{ type: 'thinking', thinking: 'visible reasoning' } as ContentBlock];
    assert.equal(stampThinkingTokenEstimates(unsigned, 500), unsigned);

    const stamped: ContentBlock[] = [{ type: 'thinking', thinking: '', signature: SIG_A, tokenEstimate: 42 } as ContentBlock];
    assert.equal((stampThinkingTokenEstimates(stamped, 5_000)[0] as Stamped).tokenEstimate, 42);

    const overshoot: ContentBlock[] = [
      { type: 'thinking', thinking: '', signature: SIG_A } as ContentBlock,
      { type: 'text', text: 'x'.repeat(10_000) },
    ];
    assert.equal(stampThinkingTokenEstimates(overshoot, 100), overshoot);
    assert.equal(stampThinkingTokenEstimates(overshoot, 0), overshoot);
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
      // Round 1: 2000 output tokens minus 'looking' and the tool_use JSON.
      const toolJson = JSON.stringify({ message: 'one' }).length;
      const visible1 = Math.ceil('looking'.length / 2.9) + Math.ceil(toolJson / 2.3) + 20;
      assert.equal(t1.tokenEstimate, 2_000 - visible1);
      // Round 2: (3500 - 2000) output tokens minus 'done' — not the cumulative 3500.
      assert.equal(t2.tokenEstimate, 1_500 - Math.ceil('done'.length / 2.9));

      const others = msgs.flatMap((m) => m.content).filter((b) => b.type !== 'thinking');
      for (const b of others) assert.equal(b.tokenEstimate, undefined, `${b.type} must not be stamped`);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
