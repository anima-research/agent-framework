/**
 * Issue #92 — mid-turn physical-window projection.
 *
 * A turn's continuation rounds append tool results to the compiled request
 * without recompiling, so a turn that starts near the compile target can
 * walk past the provider's HARD context cap mid-turn and take a wire 400.
 * When AgentConfig.physicalWindowTokens is set, the framework projects each
 * continuation round's real size (cache-INCLUSIVE prior input + blocks about
 * to be appended + reserve for response) and breaks the stream through the
 * budget-restart path — fresh compile — instead of dispatching a doomed
 * request. Unset → behavior unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type {
  EventResponse,
  Module,
  ProcessEvent,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

/** Each streamYielding call consumes exactly ONE queued response — the
 *  restart must open a fresh stream rather than continue the first. */
class SequentialStreamMembrane extends MockMembrane {
  private streamIdx = 0;
  override streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const stream = new MockYieldingStream(this.responses.slice(this.streamIdx, ++this.streamIdx));
    this.lastStream = stream;
    return stream;
  }
}

class BlobToolModule implements Module {
  readonly name = 'canned';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'blob', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return { success: true, data: { blob: 'x'.repeat(30_000) } };
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

/** Tool round whose usage reports a near-cap REAL prefix: only 5k fresh
 *  input (far under maxStreamTokens) but 195k cache-read — the projection
 *  must count cached tokens or it misses the window entirely. */
function nearCapToolResponse(): NormalizedResponse {
  const r = createMockResponse([
    { type: 'text', text: 'Working…' },
    { type: 'tool_use', id: 'call_1', name: 'canned--fetch', input: {} },
  ], 'tool_use');
  (r as { usage: unknown }).usage = {
    inputTokens: 5_000,
    outputTokens: 5,
    cacheReadTokens: 195_000,
  };
  return r;
}

async function pollUntil(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

function storedTexts(framework: AgentFramework): string {
  const cm = framework.getAgent('prime')?.getContextManager();
  const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{
    content: Array<{ type: string; text?: string }>;
  }>;
  return msgs
    .flatMap((m) => m.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function runTurn(
  physicalWindowTokens: number | undefined,
  /** Sequential = one response per stream (restart opens stream 2); plain
   *  MockMembrane feeds the whole queue to stream 1 (no-restart continues). */
  membrane: MockMembrane,
): Promise<{
  framework: AgentFramework;
  membrane: MockMembrane;
  traces: TraceEvent[];
  tempDir: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'phys-window-'));
  membrane.pushResponse(nearCapToolResponse());
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Recovered final answer' }]));

  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime',
      model: 'test-model',
      systemPrompt: 'You are prime.',
      allowedTools: 'all',
      maxTokens: 4_000,
      ...(physicalWindowTokens !== undefined ? { physicalWindowTokens } : {}),
    }],
    modules: [new BlobToolModule()],
    syncIntervalMs: 0,
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((e) => traces.push(e));
  framework.start();
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: [{ type: 'text', text: 'fetch it' }],
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent);
  return { framework, membrane, traces, tempDir };
}

describe('physical-window mid-turn restart (issue #92)', () => {
  it('restarts through a fresh compile instead of dispatching past the hard cap', async () => {
    // Projection: 200k real prefix (5k fresh + 195k cached) + appended tool
    // result + 4k reserve > 200k window → restart. The fresh-input-only
    // check (5k vs maxStreamTokens 150k) would have sent the doomed request.
    const h = await runTurn(200_000, new SequentialStreamMembrane());
    try {
      const done = await pollUntil(() => storedTexts(h.framework).includes('Recovered final answer'));
      assert.ok(done, 'turn should complete with the post-restart answer');
      assert.strictEqual(h.membrane.calls.length, 2, 'restart should open a second stream');
      const restarted = h.traces.find((e) => e.type === 'inference:stream_restarted') as
        { reason?: string; inputTokens?: number; budget?: number } | undefined;
      assert.ok(restarted, 'a stream_restarted trace should be emitted');
      assert.strictEqual(restarted.reason, 'physical_window');
      assert.strictEqual(restarted.budget, 200_000);
      assert.ok((restarted.inputTokens ?? 0) > 200_000, 'trace should carry the projected size');
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });

  it('leaves behavior unchanged when physicalWindowTokens is unset', async () => {
    const h = await runTurn(undefined, new MockMembrane());
    try {
      // Same near-cap usage, no declared window: the stream resumes in place
      // and the SECOND queued response is never consumed by a restart —
      // MockYieldingStream continues the first stream instead.
      const done = await pollUntil(() => storedTexts(h.framework).includes('Recovered final answer'));
      assert.ok(done, 'turn should complete on the original stream');
      assert.strictEqual(h.membrane.calls.length, 1, 'no second stream without a declared window');
      assert.ok(
        !h.traces.some((e) => e.type === 'inference:stream_restarted'),
        'no restart trace without a declared window',
      );
    } finally {
      await h.framework.stop();
      rmSync(h.tempDir, { recursive: true, force: true });
    }
  });
});
