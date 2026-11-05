import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeFormatter, type ContentBlock, type NormalizedRequest } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { PassthroughStrategy } from '@animalabs/context-manager';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

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
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-reasoning-loss-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), syncIntervalMs: 0, modules: [],
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test.', strategy: new MarkedPrefix() }],
  });
  cleanups.push(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  await framework.start();
  const agent = framework.getAgent('assistant')!;
  const cm = agent.getContextManager();
  const add = (participant: string, content: ContentBlock[], metadata?: Record<string, unknown>) => cm.addMessage(participant, content, metadata);
  const request = () => agent.buildActivationRequest([]);
  return { agent, cm, add, request, membrane };
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
