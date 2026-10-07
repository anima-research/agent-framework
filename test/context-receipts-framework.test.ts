/**
 * Receipt clocks end to end over a real MCPL child and a scripted provider:
 * a channel item is received at acceptance, a provider round that fails
 * delivers nothing, and the next round that stands delivers the body — with
 * channel_list reporting each step. Also: history--folds answers from the
 * fold journal the same rounds wrote.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import { createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/speech-route-mcpl-server.mjs');
const ROOM = 'discord:g1:room';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type Script = 'fail' | 'ok';

/** One provider stream per script: a failure, or a round that stands. */
class ScriptedStream implements YieldingStream {
  private done = false;
  constructor(private readonly events: StreamEvent[]) {}
  provideToolResults(): void { throw new Error('no tools in this fixture'); }
  cancel(): void { this.done = true; }
  get isWaitingForTools() { return false; }
  get pendingToolCallIds() { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for (const event of this.events) {
      if (this.done) return;
      yield event;
    }
  }
}

class ScriptedMembrane {
  scripts: Script[] = [];
  requests: NormalizedRequest[] = [];
  streamYielding(request: NormalizedRequest): YieldingStream {
    this.requests.push(request);
    const script = this.scripts.shift() ?? 'ok';
    if (script === 'fail') {
      return new ScriptedStream([{ type: 'error', error: new Error('provider unavailable') } as unknown as StreamEvent]);
    }
    const usage = { inputTokens: 40, outputTokens: 3, cacheReadTokens: 0 };
    return new ScriptedStream([
      { type: 'usage', usage, round: { index: 0, stopReason: 'end_turn', usage, fidelity: 'established' } } as unknown as StreamEvent,
      { type: 'complete', response: createMockResponse([{ type: 'text', text: 'heard you' }]) } as unknown as StreamEvent,
    ]);
  }
  async complete(): Promise<never> { throw new Error('not used'); }
}

describe('receipt clocks through the framework', () => {
  let tempDir: string;
  let commandPath: string;
  let framework: AgentFramework;
  let membrane: ScriptedMembrane;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'receipt-clocks-'));
    commandPath = join(tempDir, 'commands.jsonl');
    writeFileSync(commandPath, '');
    membrane = new ScriptedMembrane();
    const history = new HistoryModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane as never,
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: join(tempDir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [history],
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    });
    history.bind(framework.getAgent('scout')!.getContextManager());
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (c: Record<string, unknown>): void => appendFileSync(commandPath, JSON.stringify(c) + '\n');

  async function channelList(): Promise<{ channels: Array<{ id: string; clocks?: Record<string, unknown> }>; receiptClocks: Record<string, unknown> }> {
    const result = await framework.executeToolCall({ id: `t-${Math.random()}`, name: 'channel_list', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(result.success, JSON.stringify(result));
    return result.data as never;
  }
  const roomClocks = async () => (await channelList()).channels.find((c) => c.id === ROOM)!.clocks as {
    lastReceivedAt: number | null; received?: { messageId?: string };
    lastDeliveredAt: number | null; delivered?: { messageId?: string; basis: string };
  };

  it('advances received while a failing round delivers nothing, then delivers at the round that stands', async () => {
    membrane.scripts = ['fail', 'ok'];
    command({ op: 'incoming', channelId: ROOM, messageId: 'm-1', mode: 'addressed', text: 'are you there?' });
    await waitFor(() => membrane.requests.length >= 1, 'first provider request');
    await waitFor(() => framework.getAgent('scout')!.state.status === 'idle', 'failed turn settles');

    let clocks = await roomClocks();
    assert.ok(clocks.lastReceivedAt, 'received at acceptance');
    assert.equal(clocks.received?.messageId, 'm-1');
    assert.equal(clocks.lastDeliveredAt, null, 'a failed round delivers nothing');

    command({ op: 'incoming', channelId: ROOM, messageId: 'm-2', mode: 'addressed', text: 'hello?' });
    await waitFor(() => membrane.requests.length >= 2, 'second provider request');
    await waitFor(() => framework.getAgent('scout')!.state.status === 'idle', 'second turn settles');

    clocks = await roomClocks();
    assert.ok(clocks.lastDeliveredAt, 'delivered at the round that stood');
    assert.equal(clocks.delivered?.messageId, 'm-2');
    assert.equal(clocks.delivered?.basis, 'message-digest', 'an ordinary channels/incoming item: platform id plus digest');
    const scope = (await channelList()).receiptClocks as { agent: string; storeId: string; trackingSince: number; degraded: boolean };
    assert.equal(scope.agent, 'scout');
    assert.match(scope.storeId, /^[0-9a-f-]{36}$/);
    assert.ok(scope.trackingSince > 0);
    assert.equal(scope.degraded, false);

    // The same round accepted the compile: history--folds has a baseline.
    const folds = await framework.executeToolCall({ id: 'f1', name: 'history--folds', input: {}, callerAgentName: 'scout' } as never);
    assert.ok(folds.success, JSON.stringify(folds));
    const data = folds.data as { receipts: Array<{ kind: string }>; folding: string };
    assert.equal(data.receipts[0]?.kind, 'baseline');
    assert.match(data.folding, /passthrough|strategy/);
  });
});
