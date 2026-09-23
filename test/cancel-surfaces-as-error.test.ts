import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { TraceEvent } from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/**
 * A cancel that the stream reports as `error` is still a deliberate stop.
 *
 * Membrane's yielding stream answers cancel() with an `aborted` event, but
 * that is one implementation's choice: host-quiesce.test.ts already pins
 * that a stream may report cancel() through `error` instead, and driveStream
 * honours quiesce/shutdown provenance on that twin. The caller-cancel twin
 * was missed (Sol's review of #172, 2026-09-23): abortInference(reason) /
 * cancelStream() on an error-surfacing stream fell through the failure
 * pipeline — inference:failed, errorPolicy, and a retry that relaunched the
 * very inference someone had just stopped:
 *
 *   inference:started → inference:failed → inference:started
 *
 * Both twins must reach the same terminal: one inference:aborted carrying
 * the caller's reason, the [turn-interrupted] marker, no inference:failed,
 * no inference:exhausted, no retry.
 */

/** Parks until cancel(), then reports the cancel as an error event. */
class ErroringOnCancelStream implements YieldingStream {
  private release: (() => void) | null = null;
  private cancelled = false;
  cancel(): void { this.cancelled = true; this.release?.(); }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.cancelled) await new Promise<void>((resolve) => { this.release = resolve; });
    yield { type: 'error', error: new Error('stream cancelled') } as StreamEvent;
  }
}

/** Fails spontaneously — the genuine provider error the failure pipeline is for. */
class SpontaneouslyErroringStream extends ErroringOnCancelStream {
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await new Promise((r) => setTimeout(r, 20));
    yield { type: 'error', error: new Error('provider exploded') } as StreamEvent;
  }
}

class ErroringMembrane extends MockMembrane {
  constructor(private readonly make: () => YieldingStream) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return this.make();
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot(prefix: string, make: () => YieldingStream) {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const membrane = new ErroringMembrane(make);
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Assist.' }],
    modules: [],
  });
  const traces: TraceEvent[] = [];
  framework.onTrace((t) => { traces.push(t); });
  framework.start();
  framework.nudgeAgent('assistant', 'operator');
  await waitFor(() => membrane.calls.length === 1);
  const agent = framework.getAgent('assistant')!;
  await waitFor(() => agent.state.status === 'streaming');
  const teardown = async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  };
  return { framework, membrane, agent, traces, teardown };
}

function contextTexts(framework: AgentFramework): string[] {
  const { messages } = framework.getAgent('assistant')!.getContextManager().queryMessages({});
  return messages.flatMap((m) =>
    m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text));
}

function types(traces: TraceEvent[], ...wanted: string[]): string[] {
  return traces.map((t) => String(t.type)).filter((t) => wanted.includes(t));
}

describe('a cancel that the stream reports as `error` is still a deliberate stop', () => {
  it('abortInference(reason) → ONE inference:aborted with the reason; no inference:failed, no retry', async () => {
    const { framework, membrane, agent, traces, teardown } =
      await boot('cancel-error-abort-', () => new ErroringOnCancelStream());
    try {
      assert.equal(framework.abortInference('assistant', 'operator_reclaim'), true);
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      // Give the failure pipeline's retry every chance to show up (the
      // observed relaunch landed ~1.2s after the stop).
      await new Promise((r) => setTimeout(r, 1500));

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.deepEqual(aborted.map((t) => t.reason), ['operator_reclaim'],
        `expected exactly one inference:aborted with the caller's reason, got ${JSON.stringify(aborted)}`);
      assert.deepEqual(types(traces, 'inference:failed', 'inference:exhausted'), [],
        `a deliberate stop is neither a failure nor an exhaustion: ${JSON.stringify(types(traces, 'inference:started', 'inference:failed', 'inference:exhausted', 'inference:aborted'))}`);
      assert.equal(membrane.calls.length, 1, 'the stopped inference must not be relaunched by errorPolicy');
      assert.equal(types(traces, 'inference:started').length, 1);
      assert.equal(agent.state.status, 'idle');

      // Same marker as the `aborted` twin: neutral text, reason in metadata.
      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
      const { messages } = agent.getContextManager().queryMessages({});
      const markerMsg = messages.find((m) =>
        m.content.some((b) => b.type === 'text' && b.text.includes('[turn-interrupted]')))!;
      assert.equal((markerMsg.metadata as { reason?: string } | undefined)?.reason, 'operator_reclaim');
      assert.ok(!contextTexts(framework).some((t) => t.includes('[inference-failed]')));
    } finally {
      await teardown();
    }
  });

  it('cancelStream() with no reason → inference:aborted reason user, marker, no failure accounting', async () => {
    const { framework, membrane, agent, traces, teardown } =
      await boot('cancel-error-plain-', () => new ErroringOnCancelStream());
    try {
      agent.cancelStream();
      await waitFor(() => traces.some((t) => t.type === 'inference:aborted'));
      await new Promise((r) => setTimeout(r, 1500));

      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.deepEqual(aborted.map((t) => t.reason), ['user']);
      assert.deepEqual(types(traces, 'inference:failed', 'inference:exhausted'), []);
      assert.equal(membrane.calls.length, 1);
      await waitFor(() => contextTexts(framework).some((t) => t.includes('[turn-interrupted]')));
    } finally {
      await teardown();
    }
  });

  it('a stream that errors on its own (nobody cancelled) still takes the failure pipeline', async () => {
    const { membrane, traces, teardown } =
      await boot('cancel-error-genuine-', () => new SpontaneouslyErroringStream());
    try {
      await waitFor(() => traces.some((t) => t.type === 'inference:failed'));
      // errorPolicy decides retry vs exhausted; either way it is a failure,
      // never a deliberate stop.
      await waitFor(() => traces.some((t) => t.type === 'inference:exhausted') || membrane.calls.length > 1, 3000);
      assert.deepEqual(types(traces, 'inference:aborted'), [], 'a provider error is not a cancellation');
    } finally {
      await teardown();
    }
  });

  it('the reason of a cancel is consumed by the stream it ended, never by the next one', async () => {
    // A cancel whose stream reports NO terminal event at all (iterator just
    // ends) leaves the pending reason uncollected. The next stream must
    // start clean: an error there is a genuine failure, not a stale stop.
    class SilentlyEndingStream extends ErroringOnCancelStream {
      override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        await new Promise<void>((resolve) => { (this as unknown as { release: () => void }).release = resolve; });
      }
    }
    let n = 0;
    const { framework, membrane, agent, traces, teardown } = await boot('cancel-error-stale-', () =>
      n++ === 0 ? new SilentlyEndingStream() : new SpontaneouslyErroringStream());
    try {
      agent.cancelStream('stale_reason');
      await waitFor(() => agent.state.status === 'idle');
      await new Promise((r) => setTimeout(r, 100));
      framework.nudgeAgent('assistant', 'operator');
      await waitFor(() => membrane.calls.length === 2);
      await waitFor(() => traces.some((t) => t.type === 'inference:failed'), 3000);
      const aborted = traces.filter((t) => t.type === 'inference:aborted') as Array<{ reason?: string }>;
      assert.ok(!aborted.some((t) => t.reason === 'stale_reason'),
        `the first stream's reason leaked into the second: ${JSON.stringify(aborted)}`);
    } finally {
      await teardown();
    }
  });
});
