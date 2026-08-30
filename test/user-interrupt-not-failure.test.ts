import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

/**
 * A user pressing Stop is a deliberate cancellation, not a model failure.
 * Before the fix, the host's cancelStream() path fell through driveStream's
 * generic abort handling into the failure pipeline: an inference:exhausted
 * trace, a bumped consecutive-failure streak (three Stops → hard-down ops
 * alert), and an "[inference-failed] the model call failed and produced no
 * response … drop an oversized attachment" chronicle marker attributed to
 * the user — three inaccuracies (wrong cause, wrong speaker, irrelevant
 * advice) accumulating as false self-knowledge in a resident's transcript.
 */

/** Module whose tool call hangs until released — keeps the stream open so
 *  the test can cancel mid-turn, exactly as the TUI/WebUI Stop button does. */
class HangingToolModule implements Module {
  readonly name = 'test';
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'hang',
      description: 'Hangs until released',
      inputSchema: { type: 'object', properties: {} },
    }];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    await this.gate;
    return { success: true, data: {} };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('user interrupt is not recorded as a failure', () => {
  it('cancelStream mid-turn → [turn-interrupted] marker, inference:aborted trace, no failure streak', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'interrupt-'));
    const membrane = new MockMembrane();
    // One response with a hanging tool call: the stream stays alive in
    // waiting_for_tools until we cancel it.
    membrane.pushResponse(createMockResponse(
      [{ type: 'tool_use', id: 't1', name: 'test--hang', input: {} } as never],
      'tool_use',
    ));

    const module = new HangingToolModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
      modules: [module],
    });

    const traces: TraceEvent[] = [];
    framework.onTrace((t) => { traces.push(t); });

    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();

      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // What the TUI / WebUI Stop button does.
      agent.cancelStream();

      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      // Let the abort settle fully (chronicle marker write).
      await waitFor(() => {
        const { messages } = agent.getContextManager().queryMessages({});
        return messages.some((m) =>
          m.content.some((b) => b.type === 'text' && b.text.includes('[turn-interrupted]')));
      });

      const { messages } = agent.getContextManager().queryMessages({});
      const texts = messages.flatMap((m) =>
        m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text));

      // Honest marker present…
      const marker = texts.find((t) => t.includes('[turn-interrupted]'));
      assert.ok(marker, 'expected a [turn-interrupted] chronicle marker');
      assert.match(marker!, /deliberate cancellation, not a failure/);
      // …and no failure framing anywhere.
      assert.ok(!texts.some((t) => t.includes('[inference-failed]')),
        'a user stop must not produce an [inference-failed] marker');

      // Trace: aborted (with the honest reason), not exhausted.
      const aborted = traces.find((t) => t.type === 'inference:aborted') as { reason?: string };
      assert.equal(aborted?.reason, 'user');
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'),
        'a user stop must not emit inference:exhausted (feeds streak + ops alerts)');
    } finally {
      // Release the hung tool BEFORE stopping: its completion pushes a
      // tool-result event, which must land while the queue is still open.
      module.release();
      await new Promise((r) => setTimeout(r, 50));
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a real provider abort (non-user reason) still goes through the failure pipeline', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'interrupt-real-'));
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(
      [{ type: 'tool_use', id: 't1', name: 'test--hang', input: {} } as never],
      'tool_use',
    ));

    const module = new HangingToolModule();
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
      modules: [module],
    });

    const traces: TraceEvent[] = [];
    framework.onTrace((t) => { traces.push(t); });

    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();

      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // Simulate a provider-side abort: emit the event with a non-user
      // reason directly on the live mock stream.
      const stream = membrane.lastStream!;
      (stream as unknown as { events: unknown[]; pendingResolve: (() => void) | null }).events.push(
        { type: 'aborted', reason: 'connection_lost' });
      const pr = (stream as unknown as { pendingResolve: (() => void) | null }).pendingResolve;
      if (pr) { (stream as unknown as { pendingResolve: null }).pendingResolve = null; pr(); }

      await waitFor(() => traces.some((t) => t.type === 'inference:exhausted'));
      const exhausted = traces.find((t) => t.type === 'inference:exhausted') as { error?: string };
      assert.match(exhausted?.error ?? '', /connection_lost/);
    } finally {
      // Release the hung tool BEFORE stopping: its completion pushes a
      // tool-result event, which must land while the queue is still open.
      module.release();
      await new Promise((r) => setTimeout(r, 50));
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
