import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

const message = { channelId: 'chat', messageId: 'one', timestamp: TS, content: [{ type: 'text', text: 'legacy' }], metadata: { tags: ['legacy-nested'], replyIntent: 'sender-value', stamp: 'sender-value' } };
for (const lane of ['channel', 'push'] as const) test(`no-hook ${lane}: gate, observer and queue stay synchronous and metadata unchanged`, async t => {
  const order: string[] = []; let queued: any;
  const f = await fixture({ server: { shouldTriggerInference: () => { order.push('gate'); return false; } } }); t.after(f.close); await f.register();
  const inner = f.framework as any;
  const handler = lane === 'channel' ? inner.channelRegistry : inner.pushHandler;
  handler.acceptInbound = () => { order.push('observer'); };
  handler.pushEventFn = (event: any) => { order.push('queue'); queued = event; };
  const promise = lane === 'channel'
    ? handler.handleIncoming('editor', { messages: [message] }, { respond: () => order.push('response') })
    : handler.handlePushEvent('editor', { ...f.params('one', 'legacy'), coalesce: undefined, origin: message.metadata }, { respond: () => order.push('response') });
  assert.deepEqual(order, ['gate', 'observer', 'queue', 'response'], 'no new Promise yield');
  assert.deepEqual(Object.getOwnPropertySymbols(queued), [], 'no synthetic admission envelope');
  assert.deepEqual(lane === 'channel' ? queued.metadata : queued.origin, message.metadata);
  await promise;
});

test('no-hook inference resolves the model synchronously after existing guards', async t => {
  const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['inferenceRequest'] } } }); t.after(f.close);
  const order: string[] = [];
  const router = (f.framework as any).inferenceRouter;
  router.resolveModel = () => { order.push('model'); return undefined; };
  const promise = router.handleInferenceRequest('editor', { featureSet: 'doc', messages: [] }, { respondError: () => order.push('refusal') });
  assert.deepEqual(order, ['model', 'refusal']); await promise;
});

test('no-hook real push preserves pre-grant tap and pre-ready holding/release', async t => {
  const f = await fixture(); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  let taps = 0; connection.setReadTap(() => { taps++; });
  connection.pauseDataPlane();
  const pending = f.send('push/event', { ...f.params('held', 'old_hold'), coalesce: undefined, hints: [] });
  await eventually(() => connection.bufferedEvents.length > 0);
  assert.equal(taps, 1); connection.ready(); assert.equal((await pending).result.accepted, true);
  connection.establishGrant(CapabilityGrant.empty());
  const denied = await f.send('push/event', { ...f.params('denied', 'no'), hints: [] });
  assert.equal(denied.error.code, -32002); assert.equal(taps, 2, 'legacy hint effects remain even on later refusal');
});
