import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequiredAdmission } from '../src/mcpl/inbound-admission.js';
import { withReplyConsumer, admissionRoutingFields } from '../src/mcpl/reply-admission.js';
import { replyConsumer, isReplyBinding, replyBindingCurrent, sameDestination, turnReply, shareReplyTurn, replyWork, type ReplyBinding, type ReplyAuthorityConfig } from '../src/mcpl/reply-routing.js';
import { serverConfigProblems } from '../src/mcpl/protocol-family.js';
import { McplServerConnection, FRAMEWORK_INBOUND_ADMISSION } from '../src/mcpl/server-connection.js';

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
  let consumed = 0;
  const ingress = withReplyConsumer(admission.capture(() => undefined), async () => { consumed++; return {}; }, x.transport.signal);
  assert.equal((await ingress.admit('push/event', {})).store, false);
  assert.equal(consumed, 0);
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
    const approved = profile.authorize;
    const config = { id: 'endpoint', command: 'peer', reconnect: true,
      inboundAdmission: { timeoutMs: 1000, bind: (connection: any) => ({ connection, admit: () => ({ store: true as const, mayWake: true }) }), isReplyIntent: () => true }, replyAuthority: profile,
    };
    connection = await McplServerConnection.connectWithReconnect(config, { version: '0.5' }, undefined, FRAMEWORK_INBOUND_ADMISSION);
    assert.equal((connection as any).config, config);
    profile.authorize = () => false; profile.timeoutMs = 1;
    assert.equal(connection.replyAuthority!.timeoutMs, 100);
    assert.equal(connection.replyAuthority!.authorize({} as any, {} as any), approved());
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

test('core: persistent authority throws log once per minute without exception details', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let monotonic = 100_000; t.mock.method(performance, 'now', () => monotonic);
  const original = console.error, logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const x = fixture({ authorize: () => { throw Error('sensitive detail'.repeat(1000)); } });
    const run = async () => {
      const result = await x.run();
      assert.equal(result.verdict.store, true); assert.equal(result.binding.destination, undefined);
    };
    await run(); await run();
    assert.equal(logs.length, 1);
    monotonic += 59_999; t.mock.timers.tick(59_999); await run();
    assert.equal(logs.length, 1);
    monotonic += 1; t.mock.timers.tick(1); await run();
    assert.equal(logs.length, 2);
    assert(logs.every(line => JSON.stringify(line).length < 200));
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

test('core: failure diagnostics share a connection window across paths and reconnects, not connections', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let monotonic = 100_000; t.mock.method(performance, 'now', () => monotonic);
  const a = fixture(), b = fixture(), scope = {}, original = console.error, logs: unknown[][] = [];
  const throwing = async () => { throw Error('private failure'); };
  const authority = replyConsumer({ timeoutMs: 100, resolve: throwing, authorize: () => true }, () => true, scope);
  const runAuthority = () => authority({ connection: a.ingress.key, lane: 'channels/incoming', item: {} as any, signal: a.transport.signal }, { store: true, mayWake: true });
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    await runAuthority();
    await withReplyConsumer(a.ingress, throwing, a.transport.signal, scope).admit('channels/incoming', {});
    assert.equal(logs.length, 1, 'both failure paths share the same connection throttle');
    a.admission.bind(2);
    await withReplyConsumer(a.admission.capture(() => undefined), throwing, a.transport.signal, scope).admit('channels/incoming', {});
    assert.equal(logs.length, 1, 'a reconnect does not reset the connection diagnostic window');
    await withReplyConsumer(b.ingress, throwing, b.transport.signal, {}).admit('channels/incoming', {});
    assert.equal(logs.length, 2, 'another connection has an independent window');
    monotonic += 60_000; t.mock.timers.tick(60_000);
    await withReplyConsumer(a.admission.capture(() => undefined), throwing, a.transport.signal, scope).admit('channels/incoming', {});
    await runAuthority();
    assert.equal(logs.length, 3, 'one new line for the still-failing connection');
  } finally { console.error = original; }
});

test('#6 synchronous resolver results after the elapsed deadline are private', async () => {
  let signal!: AbortSignal;
  const x = fixture({ timeoutMs: 1, resolve: input => {
    signal = input.signal;
    const until = performance.now() + 10; while (performance.now() < until) {}
    return { channelId: 'room' };
  } });
  const result = await x.run();
  assert.equal(result.verdict.store, true);
  assert.equal(result.binding.destination, undefined);
  assert.equal(signal.aborted, true);
});

test('#8 setup failures identify the server without callback details', async () => {
  for (const stage of ['bind', 'attest']) {
    const admission = new RequiredAdmission({ timeoutMs: 100,
      bind: () => { throw Error('secret bind detail'); }, isReplyIntent: () => true,
      initializeAttestation: { read: () => { throw Error('secret attest detail'); }, matches: () => true },
    }, 'second-server');
    let failure: any;
    try { if (stage === 'bind') admission.bind(1); else await admission.attest({}); } catch (error) { failure = error; }
    assert(failure); assert.match(failure.message, /second-server/);
    assert(!failure.message.includes('secret'));
  }
});

test('#11 validated intent reaches only the optional reply resolver', async () => {
  let intent: unknown;
  const result = await fixture({ resolve: input => { intent = input.replyIntent; return { channelId: 'room' }; } }).run();
  assert.equal(intent, 'private'); assert.equal(result.verdict.store, true);
  assert.equal(result.binding.destination?.channelId, 'room');
});

test('#12 timeout and overload have fixed bounded diagnostics', async t => {
  const logs: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  const timed = fixture({ timeoutMs: 1, resolve: () => new Promise(() => {}) });
  assert.equal((await timed.run()).binding.destination, undefined);
  assert(logs.some(line => line.includes('timeout')));
  logs.length = 0;
  let entered = 0;
  const x = fixture({ timeoutMs: 5000, resolve: () => { entered++; return new Promise(() => {}); } });
  const pending = Array.from({ length: 64 }, () => x.run());
  try {
    while (entered < 64) await new Promise(done => setImmediate(done));
    assert.equal((await x.run()).binding.destination, undefined);
    await x.run();
    assert.equal(logs.length, 1); assert(logs[0].includes('overload'));
    assert(logs.every(line => line.length < 200));
  } finally { x.transport.abort(); await Promise.all(pending); }
});

test('#13 diagnostic throttling ignores backward wall-clock steps', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let monotonic = 100_000; t.mock.method(performance, 'now', () => monotonic);
  const logs: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  const x = fixture({ resolve: () => { throw Error('secret'); } });
  await x.run(); assert.equal(logs.length, 1);
  t.mock.timers.setTime(1); monotonic += 60_000;
  await x.run(); assert.equal(logs.length, 2);
});

test('R1-5 class authority callbacks retain the configured receiver through snapshotting', async () => {
  class HostRouter {
    channel = 'room|one';
    timeoutMs = 100;
    resolve() { return { channelId: this.channel }; }
    authorize(_input: unknown, destination: { channelId: string }) { return destination.channelId === this.channel; }
  }
  const host = new HostRouter();
  const config = (McplServerConnection as any).snapshotReplyAuthority({ replyAuthority: host });
  const x = fixture(config);
  const result = await x.run();
  assert.equal(result.binding.destination?.channelId, host.channel);
  assert.equal(replyBindingCurrent(result.binding), true);
  host.channel = 'changed';
  assert.equal(replyBindingCurrent(result.binding), false);
});

test('R1-5 private fault trace is bounded with fixed codes and no callback details', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const traces: any[] = [], scope = {}, x = fixture();
  const consumer = replyConsumer({ timeoutMs: 100, resolve: () => { throw Error('secret'); }, authorize: () => true },
    () => true, scope, reason => traces.push({ type: 'reply:private', serverId: 'endpoint:a/β', reason }));
  const run = () => consumer({ connection: x.ingress.key, lane: 'push/event', item: {} as any, signal: x.transport.signal }, { store: true, mayWake: true });
  await run(); await run();
  assert.deepEqual(traces, [{ type: 'reply:private', serverId: 'endpoint:a/β', reason: 'authority' }]);
  now += 60_000; await run(); assert.equal(traces.length, 2);
  assert(!JSON.stringify(traces).includes('secret'));
});

test('R1-6 blocking authorize cannot mint after the monotonic deadline', async () => {
  let signal!: AbortSignal;
  const x = fixture({ timeoutMs: 5, resolve: input => { signal = input.signal; return { channelId: 'room' }; }, authorize: () => {
    const until = performance.now() + 15; while (performance.now() < until) {}
    return true;
  } });
  const result = await x.run();
  assert.equal(result.verdict.store, true);
  assert.equal(result.binding.destination, undefined);
  assert.equal(signal.aborted, true);
});
