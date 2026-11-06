import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeFormatter, type ContentBlock, type NormalizedRequest } from '@animalabs/membrane';
import * as packageEntry from '../src/index.js';
import { Agent, AgentFramework, type AgentConfig, type Module, type ProcessEvent } from '../src/index.js';
import { ContextManager, PassthroughStrategy, AutobiographicalStrategy } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { GateModule, until, waitCall, say } from './helpers/dendrite.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const text = (text: string): ContentBlock => ({ type: 'text', text });
const notice = '[reasoning] is no longer in your context';
class MarkedPrefix extends PassthroughStrategy {
  override select(...args: Parameters<PassthroughStrategy['select']>) {
    return super.select(...args).map((entry, i) => i === 0 ? { ...entry, cacheMarker: true } : entry);
  }
}
const flags = { system: true, kind: 'reasoning-loss' };
async function fixture(conversations = false, settings: Partial<AgentConfig> = {}, membrane = new MockMembrane(), modules: Module[] = [], subconscious = false) {
  const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), syncIntervalMs: 0, maintenanceIntervalMs: 0, modules,
    ...(conversations ? { conversations: { templateAgent: 'assistant' } } : {}),
    ...(subconscious ? { subconscious: { enabled: true, reader: 'persistent' as const, systemPrompt: 'Read held traffic.' } } : {}),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.', strategy: new MarkedPrefix(), ...settings }],
  });
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  await framework.start();
  const agent = framework.getAgent('assistant')!;
  const cm = agent.getContextManager();
  const add = (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => cm.addMessage(participant, content, metadata);
  const request = () => agent.buildActivationRequest([]);
  return { framework, agent, cm, add, request, membrane, storePath: join(dir, 'store') };
}
const wire = (r: NormalizedRequest) => new NativeFormatter().buildMessages(r.messages, {
  participantMode: 'multiuser', assistantParticipant: 'assistant', promptCaching: true,
}).messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;

it('omits stored notices including deferred writes, without changing the store or the earlier request prefix', async () => {
  const x = await fixture();
  await x.add('user', [text('before')]);
  const before = await x.request();
  await x.add('user', [text(notice)], flags);
  await x.add('user', [text('arbitrary body')], { ...flags, deferredWriteId: 'deferred' });
  await x.add('user', [text('after')]);
  const stored = JSON.stringify(x.cm.getAllMessages());
  const request = await x.request();
  assert.deepEqual(request.messages.map(m => m.content), [[text('before')], [text('after')]]);
  assert.equal(before.messages[0]!.cacheBreakpoint, true);
  assert.equal(JSON.stringify(request.messages.slice(0, 1)), JSON.stringify(before.messages));
  assert.equal(JSON.stringify(wire(request)[0]!.content.slice(0, 1)), JSON.stringify(wire(before)[0]!.content));
  assert.equal(JSON.stringify(x.cm.getAllMessages()), stored);
  assert.equal(x.cm.getAllMessages().length, 4);
  assert.equal(wire(request).length, 1, 'the existing formatter merges adjacent user roles');
});

it('keeps quoted text and rows with only one flag, or non-boolean system', async () => {
  const x = await fixture();
  for (const metadata of [undefined, { system: true }, { kind: 'reasoning-loss' }, { kind: 'reasoning-loss', system: 'true' }]) {
    await x.add('user', [text(notice)], metadata);
  }
  const compiled = await x.cm.compile();
  const request = await x.request();
  assert.equal(JSON.stringify(request.messages), JSON.stringify(compiled.messages));
  assert.equal(request.messages.length, 4);
});

it('preserves tool use/result pairing across an omitted notice', async () => {
  const x = await fixture();
  await x.add('user', [text('start')]);
  await x.add('assistant', [{ type: 'tool_use', id: 'call', name: 'test', input: {} }]);
  await x.add('user', [text(notice)], flags);
  await x.add('user', [{ type: 'tool_result', toolUseId: 'call', content: [text('ok')], isError: false }]);
  const request = await x.request();
  assert.equal(request.messages.length, 3);
  const built = wire(request) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(built.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(built[1]!.content[0]!.id, 'call');
  assert.equal(built[2]!.content[0]!.tool_use_id, 'call');
});

it('handles a sole omitted row like an empty row and retains the existing trailing-assistant cue', async () => {
  const x = await fixture();
  await x.add('user', [text(notice)], flags);
  assert.deepEqual((await x.request()).messages, []);
  await x.add('assistant', [text('reply')]);
  await x.add('user', [text(notice)], flags);
  const request = await x.request();
  assert.deepEqual(request.messages.map(m => m.content), [[text('reply')], [text('[Continue]')]]);
});

it('omits notices on the non-streaming inference path too', async () => {
  const x = await fixture();
  await x.add('user', [text('before')]);
  await x.add('user', [text(notice)], flags);
  x.membrane.pushResponse(createMockResponse([text('reply')]));
  await x.agent.runInference([]);
  assert.deepEqual(x.membrane.calls[0]!.messages.map(m => m.content), [[text('before')]]);
});

it('leaves the entire no-notice request byte-identical to the baseline shape', async () => {
  const x = await fixture();
  await x.add('user', [text('ordinary')]);
  const request = await x.request();
  assert.equal(JSON.stringify(request), JSON.stringify({
    messages: [{ participant: 'user', content: [text('ordinary')], cacheBreakpoint: true }],
    system: 'Test.', config: { model: 'test-model', maxTokens: 4096 },
    promptCaching: true, cacheTtl: '1h', assistantParticipant: 'assistant',
  }));
});

async function inheritanceHistory(x: Awaited<ReturnType<typeof fixture>>) {
  await x.add('user', [text('before')]);
  await x.add('user', [text(notice)], flags);
  await x.add('user', [text('arbitrary body')], { ...flags, deferredWriteId: 'deferred' });
  // Identical content is not identity: only the flagged copy is omitted.
  for (const metadata of [undefined, { system: true }, { kind: 'reasoning-loss' }]) {
    await x.add('user', [text(notice)], metadata);
  }
  await x.add('user', [text('after')]);
  return [[text('before')], [text(notice)], [text(notice)], [text(notice)], [text('after')]];
}

for (const mode of ['copy', 'shared'] as const) {
  it(`${mode} inheritance omits only qualifying notices and leaves parent history and request unchanged`, async () => {
    const x = await fixture();
    const expected = await inheritanceHistory(x);
    const stored = JSON.stringify(x.cm.getAllMessages());
    const before = JSON.stringify(await x.request());
    const fork = await x.framework.deriveAgent({ name: 'child', from: 'assistant', mode });
    cleanups.push(async () => fork.cleanup());
    const request = await fork.agent.buildActivationRequest([]);
    assert.deepEqual(request.messages.map(m => m.content), expected);
    assert.equal(JSON.stringify(x.cm.getAllMessages()), stored);
    assert.equal(JSON.stringify(await x.request()), before);
    assert.equal((await x.agent.compileContext()).messages.length, 5, 'compiled views exclude notices; raw history remains available');
    if (mode === 'copy') assert.deepEqual(fork.contextManager.getAllMessages().map(m => m.content), expected);
  });
}

it('conversation-template inheritance omits notices before metadata is lost, without changing the template', async () => {
  const x = await fixture(true);
  const expected = await inheritanceHistory(x);
  const stored = JSON.stringify(x.cm.getAllMessages());
  const before = JSON.stringify(await x.request());
  x.membrane.pushResponse(createMockResponse([text('reply')]));
  const channel = { serverId: 'test', channelId: 'channel' };
  x.framework.pushEvent({
    type: 'mcpl:channel-incoming', ...channel, messageId: 'message',
    author: { id: 'user', name: 'user' }, content: [text('wake')],
    timestamp: new Date().toISOString(), metadata: { channel_type: 'im' }, triggerInference: true,
  } as unknown as ProcessEvent);
  await x.framework.runUntilIdle();
  const binding = x.framework.getConversationRouter()!.getBinding(channel);
  assert.ok(binding, 'the real router spawned and bound a conversation');
  const child = x.framework.getAgent(binding.agentName)!;
  assert.deepEqual(child.getContextManager().getAllMessages().slice(0, expected.length).map(m => m.content), expected);
  assert.deepEqual(x.membrane.calls[0]!.messages.slice(0, expected.length).map(m => m.content), expected);
  assert.equal(JSON.stringify(x.cm.getAllMessages()), stored);
  assert.equal(JSON.stringify(await x.request()), before);
  child.getContextManager().addMessage('user', [text('child notice')], flags);
  child.getContextManager().addMessage('user', [text('child quote')]);
  const next = await child.buildActivationRequest([]);
  assert.ok(!JSON.stringify(next.messages).includes('child notice'), 'conversation contexts filter their own new rows too');
  assert.ok(JSON.stringify(next.messages).includes('child quote'));
});

class LastMarker extends PassthroughStrategy {
  override select(...args: Parameters<PassthroughStrategy['select']>) {
    const entries = super.select(...args);
    return entries.map((entry, i) => i === entries.length - 1 ? { ...entry, cacheMarker: true } : entry);
  }
}
it('places a cache marker on the surviving prefix when the last stored row is a notice, and after it', async () => {
  const x = await fixture(false, { strategy: new LastMarker() });
  await x.add('user', [text('before')]);
  await x.add('user', [text(notice)], flags);
  const prefix = await x.request();
  assert.deepEqual(prefix.messages, [{ participant: 'user', content: [text('before')], cacheBreakpoint: true }]);
  assert.ok(wire(prefix)[0]!.content.at(-1)!.cache_control, 'the surviving prefix is cacheable on the wire');
  await x.add('user', [text('after')]);
  const request = await x.request();
  assert.equal(request.messages.at(-1)!.cacheBreakpoint, true);
  assert.deepEqual(request.messages.at(-1)!.content, [text('after')]);
});

it('strips signed thinking minted under the legacy notice prefix before sending the changed prefix', async () => {
  const x = await fixture(false, { thinkingBinding: { binds: true, dropBlock: true } });
  const legacy = await ContextManager.open({ store: x.framework.getStore(), namespace: 'agents/assistant', strategy: new MarkedPrefix() });
  cleanups.push(async () => { legacy.close(); });
  const old = new Agent({ name: 'assistant', model: 'test-model', systemPrompt: 'Test.', thinkingBinding: { binds: true, dropBlock: true } }, legacy, x.membrane.asMembrane());
  legacy.addMessage('user', [text('before')]);
  legacy.addMessage('user', [text(notice)], flags);
  const start = await old.startStream([]);
  const reply = old.addAssistantResponse([{ type: 'thinking', thinking: 'private', signature: 'signed' }, text('reply')])!;
  assert.equal(start.noteRequestSent!([reply]), true);
  const original = await old.buildActivationRequest([]);
  assert.ok(original.messages.some(m => m.content.some(b => b.type === 'thinking')), 'legacy prefix really retained the signature');
  const strips: unknown[] = [];
  x.agent.onThinkingStrip = (strip) => strips.push(strip);
  const seen: unknown[][] = [];
  x.agent.onCompiledToSend = (rows) => seen.push([...rows]);
  const request = await x.request();
  assert.ok(!request.messages.some(m => m.content.some(b => b.type === 'thinking')));
  assert.ok(!JSON.stringify(request.messages).includes(notice));
  assert.equal(strips.length, 1);
  assert.ok(!JSON.stringify(seen).includes(notice), 'sent-context observer sees the same filtered compile');
  assert.ok(legacy.getAllMessages().some(m => m.content.some(b => b.type === 'thinking')), 'stored signed blocks remain untouched');
});

class CompressionRecorder extends MockMembrane {
  auxiliary: NormalizedRequest[] = [];
  override async complete(request: NormalizedRequest) {
    this.auxiliary.push(request);
    return createMockResponse([text('A summary of the ordinary conversation.')]);
  }
}
const folding = () => new AutobiographicalStrategy({
  compressionModel: 'test-compression-model', adaptiveResolution: true, targetChunkTokens: 50,
  headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
});
it('excludes real sharded notices from selection and auxiliary compression without altering stored shards', async () => {
  const membrane = new CompressionRecorder();
  const x = await fixture(false, { strategy: folding() }, membrane);
  const id = await x.add('user', [text((notice + ' ').repeat(300))], flags);
  const shards = x.cm.getAllMessages().filter(m => m.id === id || m.bodyGroupId === x.cm.getMessage(id)!.bodyGroupId);
  assert.ok(shards.length > 1, 'real adaptive ingress split the notice');
  assert.ok(shards.every(m => m.metadata?.kind === 'reasoning-loss' && m.metadata.system === true));
  for (let i = 0; i < 10; i++) await x.add(i % 2 ? 'assistant' : 'user', [text('ordinary conversation '.repeat(40))]);
  const stored = JSON.stringify(x.cm.getAllMessages());
  for (let i = 0; i < 100 && (!membrane.auxiliary.length || !x.cm.isReady()); i++) await x.cm.tick();
  assert.ok(membrane.auxiliary.length > 0, 'actual compression reached the fake auxiliary membrane');
  assert.ok(!JSON.stringify(membrane.auxiliary).includes(notice));
  assert.ok(!JSON.stringify((await x.agent.compileContext()).messages).includes(notice));
  assert.equal(JSON.stringify(x.cm.getAllMessages()), stored);
});

it('stores genuine deferred notices but never injects them at the next tool boundary', async () => {
  let framework: AgentFramework;
  let queued = 0;
  const module: Module = {
    name: 'defer', async start() {}, async stop() {},
    getTools: () => [{ name: 'step', description: 'step', inputSchema: { type: 'object', properties: {} } }],
    async handleToolCall() {
      const before = (framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length;
      (framework as unknown as { addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>): void }).addMessage('user', [text(notice)], flags);
      (framework as unknown as { addMessage(p: string, c: ContentBlock[], m?: Record<string, unknown>): void }).addMessage('user', [text(notice)]);
      queued = (framework as unknown as { deferredMessages: unknown[] }).deferredMessages.length - before;
      return { success: true, data: 'ok' };
    },
    async onProcess(event) { return event.type === 'external-message' ? { addMessages: [{ participant: 'user', content: [text('start')] }], requestInference: true } : {}; },
  };
  const x = await fixture(false, {}, new MockMembrane(), [module]);
  framework = x.framework;
  x.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call', name: 'defer--step', input: {} }], 'tool_use'));
  x.membrane.pushResponse(createMockResponse([text('reply')]));
  framework.pushEvent({ type: 'external-message', source: 'test' } as ProcessEvent);
  await framework.runUntilIdle();
  assert.equal(queued, 2, 'both writes were really queued during the tool call');
  const stored = x.cm.getAllMessages().filter(m => m.metadata?.kind === 'reasoning-loss');
  assert.equal(stored.length, 1);
  assert.equal(typeof stored[0]!.metadata?.deferredWriteId, 'string');
  const injected = x.membrane.lastStream!.receivedToolResultOptions.flatMap(o => o?.injectedMessages ?? []);
  assert.equal(injected.filter(m => JSON.stringify(m.content).includes(notice)).length, 1, 'only the unflagged identical quote is injected');
  assert.equal((await x.request()).messages.filter(m => JSON.stringify(m.content).includes(notice)).length, 1);
});

it('excludes notices before a strategy composites ordinary and notice rows', async () => {
  class Composite extends PassthroughStrategy {
    override select(...args: Parameters<PassthroughStrategy['select']>) {
      const entries = super.select(...args);
      return entries.length ? [{ ...entries[0]!, content: entries.flatMap(e => e.content) }] : [];
    }
  }
  const x = await fixture(false, { strategy: new Composite() });
  await x.add('user', [text('before')]);
  await x.add('user', [text('flagged arbitrary body')], flags);
  await x.add('user', [text('after')]);
  assert.deepEqual((await x.request()).messages.map(m => m.content), [[text('before'), text('after')]]);
});

it('applies the same exclusion to an isolated ephemeral context', async () => {
  const x = await fixture();
  const isolated = await x.framework.createEphemeralAgent({ name: 'isolated', model: 'test-model', systemPrompt: 'Test.' });
  cleanups.push(async () => isolated.cleanup());
  isolated.contextManager.addMessage('user', [text('before')]);
  isolated.contextManager.addMessage('user', [text(notice)], flags);
  assert.deepEqual((await isolated.agent.buildActivationRequest([])).messages.map(m => m.content), [[text('before')]]);
  assert.equal((await isolated.agent.compileContext()).messages.length, 1);
});

it('documents the native wire shape when omission makes two signed assistant turns adjacent', async () => {
  const x = await fixture();
  await x.add('user', [text('start')]);
  await x.add('assistant', [{ type: 'thinking', thinking: 'first', signature: 'T1' }, text('first reply')]);
  await x.add('user', [text(notice)], flags);
  await x.add('assistant', [{ type: 'thinking', thinking: 'second', signature: 'T2' }, text('second reply')]);
  const request = await x.request();
  assert.deepEqual(request.messages.map(m => m.participant), ['user', 'assistant', 'assistant', 'user']);
  const built = wire(request);
  assert.deepEqual(built.map(m => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(built[1]!.content.map(b => b.type), ['thinking', 'text', 'thinking', 'text']);
  assert.deepEqual(built[1]!.content.filter(b => b.type === 'thinking').map(b => b.signature), ['T1', 'T2']);
  // No binding setting in this case: preserve the formatter's existing merge,
  // including T2 after text. This is a wire-shape assertion, not provider validation.
});

it('omits stored shared-slot notices from a subconscious provider request', async () => {
  const x = await fixture(false, {}, new MockMembrane(), [], true);
  await x.add('user', [text('before')]);
  await x.add('user', [text(notice)], flags);
  await x.add('user', [text('after')]);
  const subconscious = x.framework.getAgent('Subconscious')!;
  assert.ok(subconscious);
  assert.ok(x.cm.getAllMessages().some(m => m.metadata?.kind === 'reasoning-loss'),
    'the flagged row is stored in the resident shared slot');
  x.membrane.pushResponse(createMockResponse([text('reply')]));
  await subconscious.runInference([]);
  assert.deepEqual(x.membrane.calls.at(-1)!.messages.map(m => m.content), [[text('before')], [text('after')]]);
  assert.ok(x.cm.getAllMessages().some(m => m.metadata?.kind === 'reasoning-loss'), 'the stored notice remains');
});

it('omits stored notices when an ended isolated agent resumes', async () => {
  const x = await fixture();
  const config = { model: 'test-model', systemPrompt: 'Test.' };
  const first = await x.framework.createEphemeralAgent({ name: 'isolated', ...config });
  cleanups.push(async () => first.cleanup());
  first.contextManager.addMessage('user', [text('before')]);
  first.contextManager.addMessage('user', [text(notice)], flags);
  first.contextManager.addMessage('user', [text('after')]);
  x.membrane.pushResponse(createMockResponse([text('first reply')]));
  await x.framework.runEphemeralToCompletion(first.agent, first.contextManager);
  const ended = x.framework.getAgentRecord('isolated')!;
  assert.equal(ended.ended?.reason, 'completed');
  assert.equal(ended.readsSharedSlot, false);
  const resumed = await x.framework.resumeAgent('isolated', config);
  cleanups.push(async () => resumed.cleanup());
  assert.ok(resumed.contextManager.getAllMessages().some(m => m.metadata?.kind === 'reasoning-loss'),
    'resume reopens the stored notice, not a filtered copy');
  x.membrane.pushResponse(createMockResponse([text('resumed reply')]));
  await x.framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
  const contents = x.membrane.calls.at(-1)!.messages.map(m => m.content);
  assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('before')])));
  assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('after')])));
  assert.ok(!JSON.stringify(contents).includes(notice));
  assert.equal(x.framework.getAgentRecord('isolated')!.incarnation, 2);
});

it('omits stored notices when a shared child of an isolated parent resumes', async () => {
  const gates = new GateModule();
  const x = await fixture(false, {}, new MockMembrane(), [gates]);
  const config = { model: 'test-model', systemPrompt: 'Test.' };
  const parent = await x.framework.createEphemeralAgent({ name: 'isolated-parent', ...config });
  cleanups.push(async () => parent.cleanup());
  parent.contextManager.addMessage('user', [text('before')]);
  parent.contextManager.addMessage('user', [text(notice)], flags);
  parent.contextManager.addMessage('user', [text('after')]);
  x.membrane.pushResponse(waitCall('parent'));
  x.membrane.pushResponse(say('parent reply'));
  const parentRun = x.framework.runEphemeralToCompletion(parent.agent, parent.contextManager);
  try {
    await until(() => gates.entered.has('parent'), 'isolated parent to block mid-turn');
    const child = await x.framework.deriveAgent({ name: 'shared-child', from: 'isolated-parent', mode: 'shared' });
    cleanups.push(async () => child.cleanup());
    x.membrane.pushResponse(say('child reply'));
    await x.framework.runEphemeralToCompletion(child.agent, child.contextManager);
    const ended = x.framework.getAgentRecord('shared-child')!;
    assert.equal(ended.ended?.reason, 'completed');
    assert.equal(ended.inherit?.mode, 'shared');
    const derivation = ended.inherit?.derivation as { slots: { messageNamespace: string | null } };
    assert.equal(typeof derivation.slots.messageNamespace, 'string', 'the child reopens an isolated source namespace');
    const resumed = await x.framework.resumeAgent('shared-child', config);
    cleanups.push(async () => resumed.cleanup());
    const stored = structuredClone(resumed.contextManager.getAllMessages());
    assert.ok(stored.some(m => m.metadata?.kind === 'reasoning-loss'), 'the notice before the checkpoint remains stored');
    x.membrane.pushResponse(say('resumed reply'));
    await x.framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
    const contents = x.membrane.calls.at(-1)!.messages.map(m => m.content);
    assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('before')])));
    assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('after')])));
    assert.ok(!JSON.stringify(contents).includes(notice));
    assert.deepEqual(resumed.contextManager.getAllMessages().slice(0, stored.length), stored);
    assert.equal(x.framework.getAgentRecord('shared-child')!.incarnation, 2);
  } finally {
    gates.release('parent');
    await parentRun;
  }
});

it('omits persisted notices from a reopened resident after a framework restart', async () => {
  const x = await fixture();
  await x.add('user', [text('before')]);
  await x.add('user', [text(notice)], flags);
  await x.add('user', [text('after')]);
  await x.framework.stop();
  // Leaving the original resident out of the next configuration ends it;
  // inspection must reopen its shared-slot context rather than derive a live one.
  const restarted = await AgentFramework.create({
    storePath: x.storePath, membrane: x.membrane.asMembrane(), syncIntervalMs: 0, maintenanceIntervalMs: 0, modules: [],
    agents: [{ name: 'replacement', model: 'test-model', systemPrompt: 'Test.', strategy: new PassthroughStrategy() }],
  });
  cleanups.push(async () => restarted.stop());
  const ended = restarted.getAgentRecord('assistant')!;
  assert.ok(ended.ended);
  assert.equal(ended.readsSharedSlot, true);
  assert.equal(restarted.getAgent('assistant'), null);
  const reopened = await restarted.inspectAgentContext('assistant');
  cleanups.push(async () => { reopened.close(); });
  assert.ok(reopened.getAllMessages().some(m => m.metadata?.kind === 'reasoning-loss'),
    'the flagged row survived a real store close and reopen');
  const stored = structuredClone(reopened.getAllMessages());
  const agent = new Agent({ name: 'assistant', model: 'test-model', systemPrompt: 'Test.' }, reopened, x.membrane.asMembrane());
  x.membrane.pushResponse(createMockResponse([text('reply')]));
  await agent.runInference([]);
  const contents = x.membrane.calls.at(-1)!.messages.map(m => m.content);
  assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('before')])));
  assert.ok(contents.some(c => JSON.stringify(c) === JSON.stringify([text('after')])));
  assert.ok(!JSON.stringify(contents).includes(notice));
  assert.deepEqual(reopened.getAllMessages().slice(0, stored.length), stored, 'inference leaves existing stored rows untouched');
});

it('exports the composed resident and subconscious views actually applied by the framework', async () => {
  // Reflect keeps this regression runnable against an entry missing the exports.
  const residentView = Reflect.get(packageEntry, 'residentViewFilter');
  const subconsciousView = Reflect.get(packageEntry, 'subconsciousViewFilter');
  const isReasoningLoss = Reflect.get(packageEntry, 'isReasoningLoss');
  assert.equal(typeof residentView, 'function');
  assert.equal(typeof subconsciousView, 'function');
  assert.equal(typeof isReasoningLoss, 'function');
  const x = await fixture(false, {}, new MockMembrane(), [], true);
  const metadata = [
    flags, { system: true }, undefined, { kind: 'reasoning-loss' },
    { tuneOut: { epochId: 'held' } },
    { suppressed: { rule: 'test', eventType: 'test' } },
    { system: true, kind: 'context-injection', contextInjection: {
      agent: 'assistant', namespace: 'test', contentHash: 'resident', part: 0, parts: 1,
    } },
    { system: true, kind: 'context-injection', contextInjection: {
      agent: 'Subconscious', namespace: 'test', contentHash: 'subconscious', part: 0, parts: 1,
    } },
  ];
  for (const [i, mark] of metadata.entries()) await x.add('user', [text(`row-${i}`)], mark);
  const rows = x.cm.getAllMessages();
  assert.deepEqual(metadata.map(isReasoningLoss), [true, false, false, false, false, false, false, false]);
  const expected = (view: (message: typeof rows[number], name: string) => boolean, name: string) =>
    rows.filter(row => view(row, name)).map(row => row.content);
  assert.deepEqual((await x.request()).messages.map(m => m.content), expected(residentView, 'assistant'));
  const subconscious = x.framework.getAgent('Subconscious')!;
  assert.deepEqual((await subconscious.buildActivationRequest([])).messages.map(m => m.content),
    expected(subconsciousView, 'Subconscious'));
  assert.deepEqual(expected(residentView, 'assistant'), [[text('row-1')], [text('row-2')], [text('row-3')], [text('row-6')]]);
  assert.deepEqual(expected(subconsciousView, 'Subconscious'),
    [[text('row-1')], [text('row-2')], [text('row-3')], [text('row-4')], [text('row-7')]]);
});

it('migration: context-manager #369 must keep a summary with a hidden first source before newer messages', {
  todo: 'context-manager #369 or equivalent: hidden summary endpoints are unresolved on 0.24.2',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-migration-'));
  const storePath = join(dir, 'store');
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const membrane = new CompressionRecorder();
  // Non-adaptive selection makes the existing summary's timeline placement
  // visible, rather than expanding it back into raw messages at a large budget.
  const strategy = () => new AutobiographicalStrategy({
    compressionModel: 'test-compression-model', adaptiveResolution: false,
    targetChunkTokens: 100, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, l1HoldbackChunks: 0,
  });
  const legacy = await ContextManager.open({ path: storePath, namespace: 'agents/assistant',
    strategy: strategy(), membrane: membrane.asMembrane() });
  cleanups.push(async () => { legacy.close(); });
  const noticeId = legacy.addMessage('user', [text(notice)], flags);
  for (let i = 0; i < 3; i++) legacy.addMessage(i % 2 ? 'assistant' : 'user', [text('old conversation '.repeat(30))]);
  for (let i = 0; i < 100 && (!legacy.getSummariesInRange({}).length || !legacy.isReady()); i++) await legacy.tick();
  const summaries = legacy.getSummariesInRange({});
  assert.equal(summaries.length, 1, 'real unfiltered compression persisted a summary');
  assert.equal(summaries[0]!.firstMessageId, noticeId, 'the notice really is the first source');
  legacy.addMessage('user', [text('newer raw message')]);
  const stored = structuredClone(legacy.getAllMessages());
  legacy.close();
  const framework = await AgentFramework.create({
    storePath, membrane: membrane.asMembrane(), syncIntervalMs: 0, maintenanceIntervalMs: 0, modules: [],
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.', strategy: strategy() }],
  });
  cleanups.push(async () => framework.stop());
  const agent = framework.getAgent('assistant')!;
  assert.deepEqual(agent.getContextManager().getAllMessages(), stored, 'migration leaves stored rows unchanged');
  const compiled = await agent.compileContext();
  const contents = compiled.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text);
  assert.ok(contents.includes(summaries[0]!.content), 'the old summary is still selected');
  assert.ok(contents.indexOf(summaries[0]!.content) < contents.indexOf('newer raw message'),
    'context-manager #369: an old summary must precede newer raw messages even when its first source is hidden');
  assert.equal(agent.getContextManager().getSummariesInRange({}).length, 1,
    'context-manager #369: the existing summary must remain in the history overview');
});
