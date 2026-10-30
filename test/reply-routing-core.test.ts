import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequiredAdmission } from '../src/mcpl/inbound-admission.js';
import { withReplyConsumer, admissionRoutingFields } from '../src/mcpl/reply-admission.js';
import { replyConsumer, isReplyBinding, replyBindingCurrent, sameDestination, turnReply, shareReplyTurn, replyWork, type ReplyBinding, type ReplyAuthorityConfig } from '../src/mcpl/reply-routing.js';
import { serverConfigProblems } from '../src/mcpl/protocol-family.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';

function fixture(overrides: Partial<ReplyAuthorityConfig> = {}, mayWake = true) {
  const admission = new RequiredAdmission({ timeoutMs: 1000, bind: connection => ({ connection, admit: () => ({ store: true, mayWake, replyIntent: 'private' }) }), isReplyIntent: () => true }, 'endpoint:a/β');
  admission.bind(1);
  const transport = new AbortController();
  const consumer = replyConsumer({ timeoutMs: 30, resolve: () => ({ channelId: 'room|one' }), authorize: () => true, ...overrides }, key => admission.isCurrent(key));
  const ingress = withReplyConsumer(admission.capture(() => undefined), consumer, transport.signal);
  const run = async () => {
    const verdict = await ingress.admit('channels/incoming', {});
    return { verdict, binding: admissionRoutingFields(verdict).routing as ReplyBinding };
  };
  return { admission, transport, ingress, run };
}

test('core: destination is detached, frozen, connection-qualified and cannot be forged', async () => {
  const raw = { channelId: 'room|one' };
  let live = true;
  const x = await fixture({ resolve: () => raw, authorize: () => live }).run();
  assert.equal(x.verdict.store, true); assert(isReplyBinding(x.binding));
  raw.channelId = 'elsewhere';
  assert.deepEqual(x.binding.destination, { serverId: 'endpoint:a/β', channelId: 'room|one' });
  assert(Object.isFrozen(x.binding)); assert(Object.isFrozen(x.binding.destination));
  assert.equal(isReplyBinding({ ...x.binding }), false);
  assert(replyBindingCurrent(x.binding)); live = false; assert.equal(replyBindingCurrent(x.binding), false);
});

test('core: destination equality checks instance, epoch, connection, server and channel', async () => {
  const { binding: a } = await fixture().run();
  assert(sameDestination(a, { ...a }));
  for (const b of [
    { ...a, connection: { ...a.connection, instance: Symbol('replacement') } },
    { ...a, connection: { ...a.connection, transportEpoch: 2 } },
    { ...a, connection: { ...a.connection, connectionId: 'another' } },
    { ...a, destination: { ...a.destination!, serverId: 'another' } },
    { ...a, destination: { ...a.destination!, channelId: 'another' } },
  ]) assert.equal(sameDestination(a, b), false);
});

test('core: missing/malformed route stays admitted and private, without accessor effects', async () => {
  let reads = 0;
  for (const raw of [null, [], { channelId: '' }, { channelId: 'room', serverId: 'another' },
    Object.defineProperty({}, 'channelId', { get: () => { reads++; return 'room'; }, enumerable: true })]) {
    const x = await fixture({ resolve: () => raw as any }).run();
    assert.equal(x.verdict.store, true); assert(isReplyBinding(x.binding)); assert.equal(x.binding.destination, undefined);
    assert.equal(replyBindingCurrent(x.binding), false);
    assert.deepEqual(Reflect.ownKeys(x.verdict), ['store', 'mayWake', 'replyIntent']);
  }
  assert.equal(reads, 0);
});

for (const mode of ['throw', 'timeout', 'denied'] as const) test(`core: ${mode} is a private route, not an admission refusal`, async () => {
  let signal: AbortSignal | undefined;
  const x = fixture({ resolve: input => { signal = input.signal; if (mode === 'throw') throw Error('private exception'); return mode === 'timeout' ? new Promise(() => {}) : { channelId: 'room' }; }, authorize: () => mode !== 'denied' });
  const result = await x.run();
  assert.equal(result.verdict.store, true); assert.equal(result.binding.destination, undefined);
  assert.equal((x.admission as any).pending.size, 0);
  if (mode === 'timeout') assert(signal?.aborted);
});

test('core: routing starts after required admission completes and frees its pending slot; abort discards a late route', async () => {
  let entered!: () => void, finish!: (v: any) => void, signal!: AbortSignal;
  const started = new Promise<void>(done => { entered = done; });
  const x = fixture({ timeoutMs: 1000, resolve: input => {
    assert.equal((x.admission as any).pending.size, 0);
    signal = input.signal; entered(); return new Promise(done => { finish = done; });
  } });
  const pending = x.run(); await started;
  x.admission.invalidate(); x.transport.abort();
  const result = await pending;
  assert(signal.aborted); assert.equal(result.verdict.store, true); assert.equal(result.binding.destination, undefined);
  finish({ channelId: 'room' }); await new Promise(done => setImmediate(done));
  assert.equal(result.binding.destination, undefined);
});

test('core: the 65th pending route is private, never admission_denied', async () => {
  let entered = 0;
  const x = fixture({ timeoutMs: 1000, resolve: () => { entered++; return new Promise(() => {}); } });
  const waiting = Array.from({ length: 64 }, () => x.run());
  while (entered < 64) await new Promise(done => setImmediate(done));
  const extra = await x.run();
  assert.equal(extra.verdict.store, true); assert.equal(extra.binding.destination, undefined); assert.equal(entered, 64);
  x.transport.abort(); await Promise.all(waiting);
});

test('core: refusal and read-only verdict never call the reply consumer', async () => {
  const x = fixture({ resolve: () => { throw Error('must not resolve'); } }, false);
  const result = await x.run(); assert.equal(result.verdict.store, true); assert.equal(result.binding, undefined);
  const admission = new RequiredAdmission({ timeoutMs: 100, bind: connection => ({ connection, admit: () => ({ store: false, mayWake: false, reason: 'admission_denied' }) }), isReplyIntent: () => true }, 'endpoint');
  admission.bind(1);
  const ingress = withReplyConsumer(admission.capture(() => undefined), async () => { assert.fail('refusal cannot resolve'); }, x.transport.signal);
  assert.equal((await ingress.admit('push/event', {})).store, false);
});

test('core: reply authority is optional but when present requires bounded resolve and synchronous authorize', () => {
  const base = { id: 'endpoint', command: 'peer' };
  assert.equal(serverConfigProblems(base).length, 0);
  assert(serverConfigProblems({ ...base, replyAuthority: { resolve: () => null } as any }).length > 0);
});

test('core: reconnect retains the snapshotted host authority', async () => {
  const host = McplServerConnection as any, handshake = host.handshake;
  host.handshake = async () => { throw Error('offline transport'); };
  let connection: McplServerConnection | undefined;
  try {
    const profile = { timeoutMs: 100, resolve: () => ({ channelId: 'room' }), authorize: () => true };
    connection = await McplServerConnection.connectWithReconnect({ id: 'endpoint', command: 'peer', reconnect: true,
      inboundAdmission: { timeoutMs: 1000, bind: connection => ({ connection, admit: () => ({ store: true, mayWake: true }) }), isReplyIntent: () => true }, replyAuthority: profile,
    }, { version: '0.5' });
    profile.authorize = () => false; profile.timeoutMs = 1;
    assert.equal((connection as any).config.replyAuthority.timeoutMs, 100);
    assert.equal((connection as any).config.replyAuthority.authorize(), true);
  } finally { host.handshake = handshake; await connection?.close(); }
});

test('core: a route resolved under an invalidated epoch is discarded without rerouting', async () => {
  let entered!: () => void, finish!: (value: any) => void;
  const started = new Promise<void>(done => { entered = done; });
  let resolves = 0;
  const x = fixture({ timeoutMs: 1000, resolve: () => { resolves++; entered(); return new Promise(done => { finish = done; }); } });
  const pending = x.run(); await started;
  x.admission.bind(2); finish({ channelId: 'room' });
  const result = await pending;
  assert.equal(result.verdict.store, true); assert.equal(result.binding.destination, undefined); assert.equal(resolves, 1);
});

test('core: authority throws log once with bounded detail and never expose the exception', async () => {
  const original = console.error, logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const x = fixture({ authorize: () => { throw Error('sensitive detail'.repeat(1000)); } });
    for (let i = 0; i < 2; i++) {
      const result = await x.run();
      assert.equal(result.verdict.store, true); assert.equal(result.binding.destination, undefined);
    }
    assert.equal(logs.length, 1); assert(JSON.stringify(logs).length < 200);
    assert(!JSON.stringify(logs).includes('sensitive detail'));
  } finally { console.error = original; }
});

for (const [label, value] of [['number', 1], ['string', 'true'], ['object', {}], ['undefined', undefined], ['null', null], ['zero', 0]] as const) {
  test(`core: authorize ${label} is private unless it is literal true`, async () => {
    const result = await fixture({ authorize: (() => value) as any }).run();
    assert.equal(result.verdict.store, true);
    assert(isReplyBinding(result.binding)); assert.equal(result.binding.destination, undefined);
    assert.equal(replyBindingCurrent(result.binding), false);
  });
}

test('core: mixed-destination turnReply has no publication destination', async () => {
  const x = fixture({ resolve: input => ({ channelId: (input.item as any).channelId ?? 'one' }) });
  const a = await x.run();
  const verdict = await x.ingress.admit('channels/incoming', { channelId: 'two' });
  const b = admissionRoutingFields(verdict).routing as ReplyBinding;
  assert.notEqual(a.binding.destination?.channelId, b.destination?.channelId);
  assert.equal(turnReply([a.binding, b])?.destination, undefined);
  assert.equal(replyBindingCurrent(turnReply([a.binding, b])), false);
  assert.equal(turnReply([a.binding]), a.binding);
  assert.equal(turnReply([]), undefined);
});

test('core: shareReplyTurn checks every destination in both cause sets', async () => {
  const x = fixture();
  const a = (await x.run()).binding, same = (await x.run()).binding;
  const b = (await fixture({ resolve: () => ({ channelId: 'another' }) }).run()).binding;
  const work = (...bindings: ReplyBinding[]) => ({ [replyWork]: bindings });
  assert.equal(shareReplyTurn(work(a), work(same)), true);
  for (const [left, right] of [[work(a, b), work(same)], [work(a), work(same, b)], [work(a), work(b)]]) {
    assert.equal(shareReplyTurn(left, right), false);
  }
});

test('core: a read-only verdict skips the resolver at the consumer boundary', async () => {
  let resolves = 0;
  const x = fixture();
  const consume = replyConsumer({ timeoutMs: 100, resolve: () => { resolves++; return { channelId: 'room' }; }, authorize: () => true }, () => true);
  assert.deepEqual(await consume({ connection: x.ingress.key, lane: 'channels/incoming', item: {} as any, signal: x.transport.signal }, { store: true, mayWake: false }), {});
  assert.equal(resolves, 0);
});

test('core: setup throws release the reply consumer pending slot', async () => {
  const x = fixture();
  let resolves = 0;
  const consume = replyConsumer({ timeoutMs: 100, resolve: () => { resolves++; return { channelId: 'room' }; }, authorize: () => true }, () => true);
  const signal = new AbortController().signal;
  Object.defineProperty(signal, 'addEventListener', { value: () => { throw Error('setup failed'); } });
  for (let i = 0; i < 64; i++) {
    const result = await consume({ connection: x.ingress.key, lane: 'channels/incoming', item: {} as any, signal }, { store: true, mayWake: true });
    assert(isReplyBinding(result.routing)); assert.equal(result.routing.destination, undefined);
  }
  const live = await consume({ connection: x.ingress.key, lane: 'channels/incoming', item: {} as any, signal: x.transport.signal }, { store: true, mayWake: true });
  assert.equal(resolves, 1); assert(isReplyBinding(live.routing)); assert.equal(replyBindingCurrent(live.routing), true);
});
