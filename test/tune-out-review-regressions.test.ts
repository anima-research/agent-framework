import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Agent, type Module, type GateConfig, type InferenceRequest } from '../src/index.js';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import type { EventGate } from '../src/gate/event-gate.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

type QueuedMessage = Pick<StoredMessage, 'participant' | 'content' | 'metadata'> & {
  id: string; seq: number; forAgent?: string;
};
type IncomingEvent = {
  type: 'mcpl:channel-incoming'; serverId: string; channelId: string;
  messageId: string; author: { id: string; name: string }; timestamp: string;
  content: Array<{ type: 'text'; text: string }>; tags: string[]; triggerInference: boolean;
};
type CoordinatorInternals = Pick<TuneOutCoordinator, 'enter' | 'cancel' | 'handleSubconsciousTool'> & {
  invokeSubconscious(server: string, channel: string, trigger: 'cadence' | 'wake', count: number): void;
  cadenceTimers: Map<string, unknown>; expiryTimers: Map<string, unknown>;
  pendingWakes: Map<string, unknown>;
};
interface FrameworkInternals {
  channelRegistry: ChannelRegistry; tuneOutCoordinator: CoordinatorInternals;
  agents: Map<string, Agent>; eventGate: EventGate;
  pendingRequests: InferenceRequest[]; deferredMessages: QueuedMessage[];
  activeTurnTokens: Map<string, number>; quiesced: boolean;
  store: { sync(): void };
  handleMcplChannelIncoming(event: IncomingEvent): Promise<void>;
  reserveStoreForSurgery(verb: string, agentName: string): () => void;
}
const internals = (f: AgentFramework) => f as unknown as FrameworkInternals;
const OTHER_CHANNEL = 'disc:guild:other';
const DEBOUNCE_CONFIG: GateConfig = {
  policies: [{ name: 'chat', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 100 } }],
  default: 'always',
};

const CHANNEL = 'disc:guild:noisy';
const FIXTURE = join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs');
async function waitFor(cond: () => boolean, label: string) {
  const until = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
async function setup(t: TestContext, modules: Module[] = [], gateConfig?: GateConfig, allowChannelSpeech = false) {
  const dir = mkdtempSync(join(tmpdir(), 'tuneout-review-'));
  const status = join(dir, 'status.jsonl');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), modules,
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'disabled' }],
    subconscious: { enabled: true, systemPrompt: 'Observe and report.', allowChannelSpeech },
    ...(gateConfig ? { gate: { configPath: join(dir, 'gate.json'), config: gateConfig } } : {}),
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { STATUS_PATH: status, EXTRA_CHANNEL: OTHER_CHANNEL } }],
  });
  const f = internals(framework);
  const cleanup = [framework];
  t.after(async () => { for (const item of cleanup) await item.stop(); rmSync(dir, { recursive: true, force: true }); });
  await waitFor(() => f.channelRegistry.listChannelsRaw().length > 0, 'channel');
  const incoming = (text: string) => f.handleMcplChannelIncoming({
    type: 'mcpl:channel-incoming', serverId: 'disc', channelId: CHANNEL,
    messageId: text, author: { id: 'human', name: 'Human' },
    timestamp: new Date().toISOString(), content: [{ type: 'text', text }],
    tags: ['chat:ambient'], triggerInference: true,
  });
  return { framework, f, membrane, incoming, status, dir, cleanup };
}

for (const frozen of [false, true]) {
test(`diverted traffic stays out of live continuations (deferred=${frozen})`, async t => {
  let inject: () => Promise<void>;
  const module: Module = {
    name: 'review', start: async () => {}, stop: async () => {},
    getTools: () => [{ name: 'work', description: 'Work', inputSchema: { type: 'object', properties: {} } }],
    onProcess: async () => ({}),
    handleToolCall: async () => { await inject(); return { success: true, data: 'done' }; },
  };
  const { framework, f, membrane, incoming } = await setup(t, [module]);
  inject = async () => {
    f.quiesced = frozen;
    try { await incoming('DIVERTED_SECRET'); }
    finally { f.quiesced = false; }
    if (!frozen) {
      const subContext = await f.agents.get('Subconscious')!.getContextManager().compile();
      assert.ok(JSON.stringify(subContext.messages).includes('DIVERTED_SECRET'),
        'subconscious sees the original without waiting for the resident tool to finish');
    } else {
      assert.ok(f.deferredMessages.some(m => m.metadata?.tuneOut), 'exercise the deferred injection guard');
    }
  };
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'work1', name: 'review--work', input: {} }], 'tool_use'));
  membrane.pushResponse(createMockResponse([]));
  f.pendingRequests.push({ agentName: 'resident', reason: 'review', source: 'review', timestamp: Date.now() });
  await framework.runUntilIdle();
  const injections = JSON.stringify(membrane.lastStream?.receivedToolResultOptions);
  assert.ok(!injections.includes('DIVERTED_SECRET'), 'tuned-out traffic leaked into the live resident stream');
  const compiled = await f.agents.get('resident')!.getContextManager().compile();
  assert.ok(!JSON.stringify(compiled.messages).includes('DIVERTED_SECRET'));
});
}

test('allowChannelSpeech=false must block prefixed subconscious prose', async t => {
  const { framework, f, membrane, status } = await setup(t);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>${CHANNEL} I can publish despite the switch.` }]));
  f.tuneOutCoordinator.invokeSubconscious('disc', CHANNEL, 'cadence', 1);
  await framework.runUntilIdle();
  const events = existsSync(status) ? readFileSync(status, 'utf8') : '';
  assert.ok(!events.includes('"event":"publish"'), 'subconscious published with channel speech disabled');
  const result = await f.tuneOutCoordinator.handleSubconsciousTool('speak_in_channel', { channelId: CHANNEL, text: 'Blocked' });
  assert.equal(result.success, false, 'the explicit tool still honors the switch');
});

test('enabled channel speech still works through the guarded tool, with prose kept private', async t => {
  const { framework, f, membrane, status } = await setup(t, [], undefined, true);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  membrane.pushResponse(createMockResponse([{
    type: 'tool_use', id: 'speak1', name: 'speak_in_channel', input: { channelId: CHANNEL, text: 'Explicit speech' },
  }], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: `>>${CHANNEL} Private prose.` }]));
  f.tuneOutCoordinator.invokeSubconscious('disc', CHANNEL, 'cadence', 1);
  await framework.runUntilIdle();
  assert.equal(readFileSync(status, 'utf8').split('\n').filter(l => l.includes('"event":"publish"')).length, 1);
});

test('cancellation must include diverted messages deferred behind a resident turn', async t => {
  const { f, incoming } = await setup(t);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  f.activeTurnTokens.set('resident', 1);
  await incoming('DEFERRED_BACKLOG');
  f.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'review');
  f.activeTurnTokens.delete('resident');
  const dump = f.deferredMessages.find((m) => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(JSON.stringify(dump?.content).includes('DEFERRED_BACKLOG'), 'cancel omits deferred backlog then permanently hides its original');
});

test('cancellation caps a combined stored and quiesced backlog in arrival order', async t => {
  const { f, incoming } = await setup(t);
  f.tuneOutCoordinator.enter('disc', CHANNEL, { backlogCap: 2 }, 'agent-tool');
  await incoming('OLDER_STORED');
  f.quiesced = true;
  await incoming('QUEUED_ONE');
  await incoming('QUEUED_TWO');
  assert.equal(f.deferredMessages.length, 2, 'quiesce still defers diverted writes');
  // Recovered/re-deferred writes may already be present in storage. They
  // must not count twice when building the backlog.
  const first = f.deferredMessages[0];
  f.agents.get('resident')!.getContextManager().addMessage(first.participant, first.content,
    { ...first.metadata, deferredWriteId: first.id });
  f.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'review');
  f.quiesced = false;
  const dump = JSON.stringify(f.deferredMessages.find(m => m.metadata?.kind === 'tune-out-cancel')?.content);
  assert.ok(dump.includes('messages=3') && dump.includes('truncated=1'));
  assert.ok(!dump.includes('OLDER_STORED'));
  assert.ok(dump.indexOf('QUEUED_ONE') < dump.indexOf('QUEUED_TWO'));
});

test('diverted writes still defer behind a store surgery reservation', async t => {
  const { f, incoming } = await setup(t);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  const cm = f.agents.get('resident')!.getContextManager();
  const release = f.reserveStoreForSurgery('review', 'resident');
  try {
    await incoming('DURING_SURGERY');
    assert.ok(!JSON.stringify(cm.getAllMessages()).includes('DURING_SURGERY'));
    assert.ok(f.deferredMessages.some(m => m.metadata?.tuneOut));
  } finally {
    release();
  }
  assert.ok(JSON.stringify(cm.getAllMessages()).includes('DURING_SURGERY'));
});

test('late channel registration after restart must restore cadence and expiry', async t => {
  const { framework, f, dir, cleanup } = await setup(t);
  f.tuneOutCoordinator.enter('disc', CHANNEL, { durationSeconds: 600 }, 'agent-tool');
  f.store.sync();
  await framework.stop();
  cleanup.pop();
  const restarted = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), modules: [],
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.' }],
    subconscious: { enabled: true, systemPrompt: 'Observe.' },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { REGISTER_DELAY_MS: '300' } }],
  });
  const r = internals(restarted);
  cleanup.push(restarted);
  await waitFor(() => r.channelRegistry.listChannelsRaw().length > 0, 'late registration');
  assert.ok(r.channelRegistry.getTuneOutState('disc', CHANNEL), 'epoch restored durably');
  assert.equal(r.tuneOutCoordinator.expiryTimers.size, 1, 'late registration leaves expiry unarmed');
  assert.equal(r.tuneOutCoordinator.cadenceTimers.size, 1, 'late registration leaves cadence unarmed');
});

test('an overdue epoch cancels at startup even if the connector has not registered', async t => {
  const { framework, f, dir, cleanup, incoming } = await setup(t);
  const entered = f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  assert.ok(entered.ok);
  await incoming('OFFLINE_BACKLOG');
  f.channelRegistry.enterTuneOut('disc', CHANNEL, { ...entered.params, expiresAtMs: Date.now() - 1 }, 'agent-tool');
  await framework.stop();
  cleanup.pop();
  const restarted = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), modules: [],
    agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.' }],
    subconscious: { enabled: true, systemPrompt: 'Observe.' },
    mcplServers: [{ id: 'disc', command: process.execPath, args: [FIXTURE], env: { REGISTER_DELAY_MS: '1000' } }],
  });
  cleanup.push(restarted);
  const r = internals(restarted);
  assert.equal(r.channelRegistry.listChannelsRaw().length, 0, 'registration is still pending');
  assert.equal(r.channelRegistry.getTuneOutState('disc', CHANNEL), null);
  const dump = r.agents.get('resident')!.getContextManager().getAllMessages().find(m => m.metadata?.kind === 'tune-out-cancel');
  assert.ok(JSON.stringify(dump?.content).includes('OFFLINE_BACKLOG'));
  assert.ok(r.pendingRequests.some(req => req.agentName === 'resident'));
});

function gatedIncoming(f: FrameworkInternals, channelId = CHANNEL, addressed = false) {
  f.channelRegistry.handleIncoming('disc', { messages: [{
    channelId, messageId: `message-${channelId}`, author: { id: 'human', name: 'Human' },
    timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'GATED_TRAFFIC' }],
    tags: [addressed ? 'chat:mention' : 'chat:ambient'],
  }] });
}

test('gate debounce must not wake the resident for tuned-out traffic', async t => {
  const { framework, f } = await setup(t, [], DEBOUNCE_CONFIG);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  f.channelRegistry.handleIncoming('disc', { messages: [{
    channelId: CHANNEL, messageId: 'debounced', author: { id: 'human', name: 'Human' },
    timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'TUNED_OUT_AMBIENT' }],
    tags: ['chat:ambient'],
  }] });
  await framework.runUntilIdle();
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!f.pendingRequests.some((r) => r.agentName === 'resident'), 'gate debounce bypasses tuneout and wakes the resident');
});

test('mixed debounce batches preserve ordinary wakes and exclude diverted notices', async t => {
  const { framework, f } = await setup(t, [], DEBOUNCE_CONFIG);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  gatedIncoming(f);
  gatedIncoming(f, OTHER_CHANNEL);
  await framework.runUntilIdle();
  await waitFor(() => f.pendingRequests.length > 0, 'ordinary debounce wake');
  assert.equal(f.pendingRequests.length, 1);
  assert.equal(f.pendingRequests[0].wakeChannelId, OTHER_CHANNEL);
  const notice = f.agents.get('resident')!.getContextManager().getAllMessages().find(m => m.metadata?.source === 'gate:debounce');
  const text = JSON.stringify(notice?.content);
  assert.ok(text.includes(OTHER_CHANNEL));
  assert.ok(!text.includes(CHANNEL));
});

test('debounced mentions acknowledge and wake only the subconscious after gate admission', async t => {
  const { framework, f, status } = await setup(t, [], DEBOUNCE_CONFIG);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  gatedIncoming(f, CHANNEL, true);
  await framework.runUntilIdle();
  assert.equal(f.tuneOutCoordinator.pendingWakes.size, 0, 'no wake before admission');
  await waitFor(() => readFileSync(status, 'utf8').includes('suppressed-tuned-out'), 'suppression acknowledgement');
  await waitFor(() => f.pendingRequests.length > 0, 'coalesced subconscious wake');
  assert.deepEqual(f.pendingRequests.map(r => r.agentName), ['Subconscious']);
  assert.equal(f.channelRegistry.getTuneOutState('disc', CHANNEL)?.wakeCount, 1);
});

for (const buffered of [false, true]) {
test(`cancel/re-enter consumes the old epoch's delayed wake (buffered=${buffered})`, async t => {
  const { framework, f, status } = await setup(t, [], DEBOUNCE_CONFIG);
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  if (buffered) f.eventGate.onInferenceStarted('resident');
  gatedIncoming(f, CHANNEL, true);
  await framework.runUntilIdle();
  if (buffered) await waitFor(() => f.eventGate.inferenceDiagnostics().bufferedEvents > 0, 'gate buffer');
  f.tuneOutCoordinator.cancel('disc', CHANNEL, 'agent-tool', 'review');
  f.pendingRequests.length = 0; // cancellation owns its own wakes; inspect only later debounce delivery
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  if (buffered) f.eventGate.onInferenceEnded('resident');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(f.pendingRequests.length, 0);
  assert.equal(f.tuneOutCoordinator.pendingWakes.size, 0, 'old mention must not debit a newer epoch');
  assert.ok(!readFileSync(status, 'utf8').includes('suppressed-tuned-out'));
});
}

test('a previously queued ordinary wake respects tuneout entered before delivery', async t => {
  const { framework, f } = await setup(t, [], DEBOUNCE_CONFIG);
  gatedIncoming(f);
  await framework.runUntilIdle();
  f.tuneOutCoordinator.enter('disc', CHANNEL, {}, 'agent-tool');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(f.pendingRequests.length, 0);
});
