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
 * A cancelled stream is a deliberate stop, not a model failure.
 *
 * Before the fix, every cancel (the host's Stop button, an admin abort, a
 * subagent reclaim — all `agent.cancelStream()`) fell through driveStream's
 * generic abort handling into the failure pipeline: an inference:exhausted
 * trace, a bumped consecutive-failure streak (three Stops → hard-down ops
 * alert), and an "[inference-failed] the model call failed and produced no
 * response … drop an oversized attachment" chronicle marker attributed to
 * the user — three inaccuracies (wrong cause, wrong speaker, irrelevant
 * advice) accumulating as false self-knowledge in a resident's transcript.
 *
 * Membrane's wire reason 'user' means "the request's signal was aborted";
 * it does not say who did it. So the marker names the act, not an actor,
 * and the caller's own reason (cancelStream(reason) / abortInference(reason))
 * is what the trace carries.
 *
 * Originally by Lari (#134); reworked after review (Sol, 2026-09-21).
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

/** Boot a framework whose one agent is parked in waiting_for_tools on a
 *  hanging tool call. Everything after create() runs under the caller's
 *  try/finally so a waitFor timeout still stops the framework. */
async function bootHung(prefix: string) {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
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
  const teardown = async () => {
    // Release the hung tool BEFORE stopping: its completion pushes a
    // tool-result event, which must land while the queue is still open.
    module.release();
    await new Promise((r) => setTimeout(r, 50));
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  return { framework, membrane, module, traces, teardown };
}

function contextTexts(framework: AgentFramework): string[] {
  const { messages } = framework.getAgent('assistant')!.getContextManager().queryMessages({});
  return messages.flatMap((m) =>
    m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text));
}

describe('a cancelled stream is not recorded as a failure', () => {
  it('cancelStream() mid-turn → neutral [turn-interrupted] marker, one inference:aborted (reason user), no failure streak', async () => {
    const { framework, traces, teardown } = await bootHung('interrupt-');
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();
      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // What the TUI / WebUI Stop button does.
      agent.cancelStream();

      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));

      const texts = contextTexts(framework);
      const marker = texts.find((t) => t.includes('[turn-interrupted]'))!;
      assert.match(marker, /deliberate stop, not a failure/);
      // The wire reason names the call, not the actor: the marker must not
      // attribute the stop to anyone …
      assert.doesNotMatch(marker, /by the user|the user stopped/i, 'marker must not name an actor');
      // … and must not claim non-delivery: earlier rounds may have been
      // live-routed, and the agent would be baited into a duplicate send.
      assert.doesNotMatch(marker, /not delivered|did not receive/i, 'marker must not assert non-delivery');
      assert.ok(!texts.some((t) => t.includes('[inference-failed]')),
        'a cancel must not produce an [inference-failed] marker');

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.equal(aborted.length, 1, `expected exactly one inference:aborted, got ${JSON.stringify(aborted)}`);
      assert.equal(aborted[0].reason, 'user');
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'),
        'a cancel must not emit inference:exhausted (feeds streak + ops alerts)');
      assert.equal(agent.state.status, 'idle', 'the agent settles to idle');
    } finally {
      await teardown();
    }
  });

  it('framework.abortInference(reason) mid-stream → ONE inference:aborted carrying the caller\'s reason', async () => {
    const { framework, traces, teardown } = await bootHung('interrupt-abort-');
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();
      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // A host-side abort with its own provenance (zombie reclaim, subagent
      // cancel, operator). Before: abortInference emitted inference:aborted
      // with this reason AND driveStream emitted a second one as 'user'.
      assert.equal(framework.abortInference('assistant', 'operator_reclaim'), true);

      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
      // Give a second (wrong) trace every chance to show up.
      await new Promise((r) => setTimeout(r, 100));

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.deepEqual(aborted.map((t) => t.reason), ['operator_reclaim'],
        `expected exactly one inference:aborted with the caller's reason, got ${JSON.stringify(aborted)}`);
      assert.ok(!traces.some((t) => t.type === 'inference:exhausted'));

      // The marker's metadata carries the reason; its text stays neutral.
      const { messages } = agent.getContextManager().queryMessages({});
      const markerMsg = messages.find((m) =>
        m.content.some((b) => b.type === 'text' && b.text.includes('[turn-interrupted]')))!;
      assert.equal((markerMsg.metadata as { reason?: string } | undefined)?.reason, 'operator_reclaim');
      const markerText = contextTexts(framework).find((t) => t.includes('[turn-interrupted]'))!;
      assert.doesNotMatch(markerText, /operator_reclaim|by the user/);
    } finally {
      await teardown();
    }
  });

  it('a provider-side abort (reason error) still goes through the failure pipeline', async () => {
    const { framework, membrane, traces, teardown } = await bootHung('interrupt-real-');
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();
      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // Membrane's abort reasons are 'user' | 'timeout' | 'error'; only
      // 'user' is a cancel. Emit a provider-side one directly on the live
      // mock stream.
      const stream = membrane.lastStream!;
      (stream as unknown as { events: unknown[] }).events.push({ type: 'aborted', reason: 'error' });
      const pr = (stream as unknown as { pendingResolve: (() => void) | null }).pendingResolve;
      if (pr) { (stream as unknown as { pendingResolve: null }).pendingResolve = null; pr(); }

      await waitFor(() => traces.some((t) => t.type === 'inference:exhausted'));
      const exhausted = traces.find((t) => t.type === 'inference:exhausted') as { error?: string };
      assert.match(exhausted?.error ?? '', /Stream aborted: error/);
      assert.ok(!traces.some((t) => t.type === 'inference:aborted'),
        'a provider abort is not a deliberate cancellation');
      assert.ok(!contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
    } finally {
      await teardown();
    }
  });
});
