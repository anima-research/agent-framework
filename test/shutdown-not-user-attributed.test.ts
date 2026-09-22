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
 * A graceful framework shutdown with an active stream is neither the user's
 * act nor a failure. Membrane reports every `stream.cancel()` as reason
 * `user` — it names the call, not the actor — so `AgentFramework.stop()`
 * would otherwise take the deliberate-cancellation branch and write a
 * "[turn-interrupted]" marker into the agent's durable context. A resident
 * reading that after restart would learn that they were stopped; nobody
 * stopped them, the host went away.
 *
 * stop() records shutdown provenance in `frameworkCancelledStreams` before
 * the cancel, as endTurn / budget restarts / quiesce do, and driveStream's
 * tracked branch settles the turn like a quiesce: no marker, no
 * inference:exhausted, one inference:aborted with reason 'shutdown', and the
 * agent settled — so an ephemeral run's promise rejects now instead of
 * riding out its 15-minute idle watchdog (the first cut of this fix returned
 * without settling; Sol's review repro, lifted below).
 */

/** Module whose tool call hangs — keeps the stream open so the shutdown
 *  arrives mid-turn. */
class HangingToolModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'hang', description: 'Hangs', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    await new Promise(() => {});
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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function hungMembrane(): MockMembrane {
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse(
    [{ type: 'tool_use', id: 't1', name: 'test--hang', input: {} } as never],
    'tool_use',
  ));
  return membrane;
}

describe('graceful shutdown is not attributed to the user', () => {
  it('stop() with an active resident stream: no marker, one inference:aborted (reason shutdown), agent settled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'shutdown-provenance-'));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: hungMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
      modules: [new HangingToolModule()],
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((t) => { traces.push(t); });
    let stopped = false;
    try {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
      framework.start();
      const agent = framework.getAgent('assistant')!;
      await waitFor(() => agent.state.status === 'waiting_for_tools');

      // Intercept context writes: the store is closed by the time stop()
      // returns, so capture any marker at write time.
      const cm = agent.getContextManager();
      const written: string[] = [];
      const orig = cm.addMessage.bind(cm);
      (cm as unknown as { addMessage: unknown }).addMessage = (role: never, content: Array<{ type: string; text?: string }>, meta: never) => {
        for (const b of content) if (b.type === 'text' && b.text) written.push(b.text);
        return orig(role, content as never, meta);
      };

      // No user action anywhere: the host process is shutting down while
      // the stream is still active.
      stopped = true;
      await framework.stop();

      const markers = written.filter((t) => t.includes('[turn-interrupted]') || t.includes('[inference-failed]'));
      assert.deepEqual(markers, [], `graceful shutdown wrote a marker: ${JSON.stringify(markers)}`);

      const aborted = traces.filter((t): t is Extract<TraceEvent, { type: 'inference:aborted' }> => t.type === 'inference:aborted');
      assert.equal(aborted.length, 1, `expected exactly one inference:aborted trace, got ${JSON.stringify(aborted)}`);
      assert.equal(aborted[0].reason, 'shutdown', 'the trace carries the recorded provenance, not the wire reason');
      assert.equal(traces.filter((t) => t.type === 'inference:exhausted').length, 0,
        'a shutdown is not a failure: no inference:exhausted');
      assert.equal(agent.state.status, 'idle', 'the shutdown settles the agent instead of leaving it waiting_for_tools');
    } finally {
      if (!stopped) await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Review repro by Sol (Codex, via Anarchid) on #134, 2026-09-21: the first
  // shutdown branch emitted its trace and returned without settling, so the
  // ephemeral run stayed pending until its 15-minute idle watchdog rejected
  // it with a false "stalled" error after the framework was gone.
  it('stop() settles an in-flight ephemeral run promptly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'rws-eph-'));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: hungMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
      modules: [new HangingToolModule()],
    });
    let stopped = false;
    try {
      framework.start();
      const created = await framework.createEphemeralAgent({ name: 'eph', model: 'test-model', systemPrompt: 'Run.' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
      let outcome = 'pending';
      const run = framework.runEphemeralToCompletion(created.agent, created.contextManager)
        .then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${(e as Error).message}`; });
      await waitFor(() => created.agent.state.status === 'waiting_for_tools');

      stopped = true;
      await framework.stop();
      await Promise.race([run, new Promise((r) => setTimeout(r, 1500))]);

      assert.notEqual(outcome, 'pending', 'ephemeral run still pending after stop()');
      assert.match(outcome, /^rejected: Framework shutting down/, `expected the shutdown terminal, got "${outcome}"`);
      assert.equal(created.agent.state.status, 'idle');
    } finally {
      if (!stopped) await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
