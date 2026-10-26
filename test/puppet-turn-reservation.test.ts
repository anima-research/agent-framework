/**
 * #145 end-to-end: a wake that arrives while a puppeted tool is executing
 * must not start a turn. Before the fix the scheduler saw an idle agent with
 * no turn alive, started streaming, and the puppet's tool_use/tool_result
 * pair then landed inside that turn.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type Internals = {
  pendingRequests: InferenceRequest[];
  processInferenceRequests(): Promise<void>;
  activeTurnTokens: Map<string, number>;
  executeToolCall: (call: Record<string, unknown>) => Promise<unknown>;
  withAuxiliaryAdmission<T>(name: string, run: () => Promise<T>): Promise<T>;
  providerGates: Map<string, { primaryDepth: number; auxiliaryInFlight: number }>;
};
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('puppetToolCall vs a concurrent wake (#145)', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'puppet-reservation-'));
    membrane = new MockMembrane();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a wake during a held puppet execution is requeued; the pair lands before the turn it would have corrupted', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ok, I see it' }]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const i = framework as unknown as Internals;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    i.executeToolCall = async () => {
      await gate;
      return { success: true, data: 'settings snapshot', isError: false };
    };
    const quiet = console.log;
    console.log = () => {};
    try {
      const puppet = framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
      await new Promise((r) => setImmediate(r));
      assert.equal(i.activeTurnTokens.has('scout'), true, 'reserved while the tool runs');

      // the race: a wake arrives mid-execution and the scheduler runs
      i.pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() });
      await i.processInferenceRequests();
      assert.equal(membrane.calls.length, 0, 'no turn started under the puppet');
      assert.equal(i.pendingRequests.length, 1, 'the wake is requeued, not dropped');

      release();
      await puppet;
      assert.equal(i.activeTurnTokens.has('scout'), false, 'reservation released');

      await i.processInferenceRequests();
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'the requeued wake ran once the puppet was done');

      const all = framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string }> }>;
      const types = all.map((m) => m.content[0]?.type);
      const use = types.indexOf('tool_use');
      assert.ok(use >= 0, 'pair stored');
      assert.equal(types[use + 1], 'tool_result', 'pair adjacent');
      const turnText = types.lastIndexOf('text');
      assert.ok(turnText > use + 1, 'the turn the wake started comes AFTER the pair, and saw it');
    } finally {
      console.log = quiet;
      await framework.stop();
    }
  });

  it('a turn parked on provider admission that resumes during a puppet is requeued, not started over the reservation (review of #148)', async () => {
    // The one gap the scheduler's busy test does not cover: a wake passed it,
    // acquired primary admission, and parked behind an auxiliary call. If the
    // auxiliary settles while a puppet holds the agent, the continuation used
    // to re-enter startAgentStream and replace the puppet's token; a fast
    // replacement turn then ended (and flushed) before the puppeted tool
    // returned, and the pair queued behind it was never stored. The public
    // promise still resolved "ok".
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'replacement turn' }]));
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
    });
    const i = framework as unknown as Internals;
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => { releaseTool = r; });
    i.executeToolCall = async () => { await toolGate; return { success: true, data: 'settings snapshot', isError: false }; };
    let releaseAux!: () => void;
    const auxiliary = i.withAuxiliaryAdmission('scout', () => new Promise<void>((r) => { releaseAux = r; }));
    const quiet = console.log, quietErr = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      // 1. a wake passes the busy test and parks on provider admission
      i.pendingRequests.push({ agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'test', timestamp: Date.now() });
      await i.processInferenceRequests();
      await settle();
      assert.equal(membrane.calls.length, 0, 'parked behind the auxiliary call');
      assert.equal(i.providerGates.get('scout')?.primaryDepth, 1, 'admission held while parked');
      assert.equal(i.activeTurnTokens.has('scout'), false, 'no token yet — the park is before the token');

      // 2. a puppet takes the agent while the turn is parked
      const puppet = framework.puppetToolCall('scout', 'agent_settings', { action: 'get' });
      await settle();
      assert.equal(i.activeTurnTokens.has('scout'), true, 'puppet holds the reservation');
      const puppetToken = i.activeTurnTokens.get('scout');

      // 3. the auxiliary settles: the parked turn would now resume
      releaseAux();
      await auxiliary;
      await settle();
      assert.equal(membrane.calls.length, 0, 'no provider call starts during the puppeted tool');
      assert.equal(i.activeTurnTokens.get('scout'), puppetToken, 'the reservation is not replaced');
      assert.equal(i.pendingRequests.length, 1, 'the wake is requeued for the scheduler, not dropped');
      assert.equal(i.providerGates.get('scout')?.primaryDepth, 0, 'admission given back');

      // 4. the tool returns: the pair is persisted before the promise resolves
      releaseTool();
      await puppet;
      const stored = () => (framework.getAgent('scout')!.getContextManager().getAllMessages() as Array<{ content: Array<{ type: string }> }>)
        .map((m) => m.content[0]?.type);
      assert.deepEqual(stored().filter((t) => t === 'tool_use' || t === 'tool_result'), ['tool_use', 'tool_result'], 'pair persisted when puppetToolCall resolves');
      // Since #291 the pair is stored at once, so nothing waits in a
      // deferral queue (this line once checked that queue was empty): it is
      // in the window once the puppet has let go.
      const cm = framework.getAgent('scout')!.getContextManager();
      const pair = cm.getAllMessages().filter((m) => m.content[0]?.type === 'tool_use' || m.content[0]?.type === 'tool_result');
      assert.ok(pair.every((m) => cm.ordinalOf(m.id) !== undefined), 'the pair is in the window');
      assert.equal(i.activeTurnTokens.has('scout'), false, 'reservation released');

      // 5. the retained wake runs afterwards and sees the pair
      await i.processInferenceRequests();
      await framework.runUntilIdle();
      assert.equal(membrane.calls.length, 1, 'the requeued wake ran once the puppet was done');
      const types = stored();
      assert.ok(types.lastIndexOf('text') > types.indexOf('tool_result'), 'the turn comes after the pair');
    } finally {
      console.log = quiet; console.error = quietErr;
      releaseAux(); releaseTool();
      await framework.stop();
    }
  });
});
