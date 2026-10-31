import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

const message = { channelId: 'chat', messageId: 'one', timestamp: TS, content: [{ type: 'text', text: 'legacy' }], metadata: { tags: ['legacy-nested'], replyIntent: 'sender-value', stamp: 'sender-value' } };
for (const lane of ['channels/incoming', 'push/event'] as const) for (const coalesced of [false, true]) {
  for (const mayWake of [false, true]) for (const gate of [false, true]) test(`${lane} coalesced=${coalesced}: wake ceiling ${mayWake} intersects gate ${gate}`, async t => {
    let gates = 0;
    const f = await fixture({ server: { inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake }) }), isReplyIntent: () => true }, shouldTriggerInference: () => { gates++; return gate; } } });
    t.after(f.close); f.alwaysRespond(); await f.register();
    const item = lane === 'channels/incoming' ? f.channel('one', 'hello', { initial: true }) : f.params('one', 'hello', { initial: true });
    if (!coalesced) delete (item as any).coalesce;
    const result = await f.send(lane, lane === 'channels/incoming' ? { messages: [item] } : item);
    if (coalesced) {
      assert.equal(lane === 'channels/incoming' ? result.result.results[0].reason : result.result.reason, 'admission_unsupported');
      assert.equal(gates, 0); return;
    }
    assert.equal(lane === 'channels/incoming' ? result.result.results[0].accepted : result.result.accepted, true);
    await f.framework.runUntilIdle();
    assert.equal(gates, mayWake ? 1 : 0);
    assert.equal(f.membrane.calls.length > 0, mayWake && gate);
  });
}

for (const lane of ['channels/incoming', 'push/event'] as const) for (const coalesced of [false, true]) test(`required ${lane} coalesced=${coalesced}: module cannot promote false wake`, async t => {
  let modules = 0;
  const requester: any = { name: 'requester', start: async () => {}, stop: async () => {}, getTools: () => [], handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => { if (!event.type.startsWith('mcpl:')) return {}; modules++; return { requestInference: true }; } };
  const f = await fixture({ framework: { modules: [requester] }, server: { inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake: false }) }), isReplyIntent: () => true } } }); t.after(f.close); f.alwaysRespond(); await f.register();
  const item = lane === 'channels/incoming' ? f.channel('one', 'stored', { initial: true }) : f.params('one', 'stored', { initial: true });
  if (!coalesced) delete (item as any).coalesce;
  await f.send(lane, lane === 'channels/incoming' ? { messages: [item] } : item);
  await f.framework.runUntilIdle(); assert.equal(modules > 0, !coalesced); assert.equal(f.membrane.calls.length, 0);
});

test('required admission runtime AST has no connector vocabulary or platform grammar', () => {
  const source = readFileSync('src/mcpl/inbound-admission.ts', 'utf8');
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const forbidden = /slack|telegram|discord|zulip|eidoverse|supportRecipientBridge|supportRecipientReplyRoot|supportRecipientTurnId/i;
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (['Identifier', 'StringLiteral', 'RegExpLiteral', 'TemplateElement'].includes(node.type)) {
      const value = node.name ?? node.value?.raw ?? node.value ?? node.pattern;
      assert(!forbidden.test(String(value)), String(value));
    }
    for (const [key, value] of Object.entries(node)) {
      if (['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(tree);
});

for (const lane of ['channels/incoming', 'push/event'] as const) test(`required ${lane}: mayWake true preserves module wakes despite an existing false gate`, async t => {
  const requester: any = { name: 'requester', start: async () => {}, stop: async () => {}, getTools: () => [], handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => event.type.startsWith('mcpl:') ? { requestInference: true } : {} };
  const f = await fixture({ framework: { modules: [requester] }, server: { shouldTriggerInference: () => false, inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake: true }) }), isReplyIntent: () => true } } }); t.after(f.close); f.alwaysRespond(); await f.register();
  await f.send(lane, lane === 'channels/incoming' ? { messages: [message] } : { ...f.params('one', 'stored'), coalesce: undefined });
  await f.framework.runUntilIdle(); assert(f.membrane.calls.length > 0);
});

for (const mayWake of [true, false]) for (const lane of ['channels/incoming', 'push/event'] as const) test(`required ${lane}: later gate decline stays visible, only mayWake=${mayWake} caps modules`, async t => {
  let observed: boolean | undefined;
  const requester: any = { name: 'requester', start: async () => {}, stop: async () => {}, getTools: () => [], handleToolCall: async () => ({ success: true }), onProcess: async (event: any) => {
    if (!event.type.startsWith('mcpl:')) return {};
    observed = event.triggerInference; return { requestInference: true };
  } };
  const f = await fixture({ framework: { modules: [requester] }, server: { shouldTriggerInference: () => true, inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake }) }), isReplyIntent: () => true } } }); t.after(f.close); f.alwaysRespond(); await f.register();
  // Labelled policy-boundary scaffold: the later gate decision is visible to modules,
  // but only the admission ceiling can prohibit a module-driven wake.
  const inner = f.framework as any; const admit = inner.admitInbound.bind(inner);
  let decisions = 0;
  inner.admitInbound = (env: any) => { assert.equal(env.vetoed, !mayWake); decisions++; return { ...admit(env), wake: false }; };
  await f.send(lane, lane === 'channels/incoming' ? { messages: [message] } : { ...f.params('one', 'stored'), coalesce: undefined });
  await f.framework.runUntilIdle();
  assert.equal(decisions, 1); assert.equal(observed, false); assert.equal(f.membrane.calls.length > 0, mayWake);
});
