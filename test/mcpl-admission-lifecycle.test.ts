import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { RequiredAdmission, MAX_PENDING_ADMISSIONS, type InboundAdmissionConfig, type AdmissionVerdict } from '../src/mcpl/inbound-admission.js';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { MockMembrane } from './helpers/mock-membrane.js';
const peer = fileURLToPath(new URL('./fixtures/required-admission-server.mjs', import.meta.url));
const deny = { store: false, mayWake: false, reason: 'admission_denied' } as const;
const allow = { store: true, mayWake: false } as const;
const config = (admit: (input: any) => any, timeoutMs = 5000): InboundAdmissionConfig => ({
  timeoutMs, bind: connection => ({ connection, admit }), isReplyIntent: () => true,
});
const channel = (id = 'one') => ({ channelId: 'chat', messageId: id, timestamp: TS, content: [{ type: 'text', text: 'sensitive_body' }], tags: ['chat:mention'], metadata: { tags: ['untrusted'], replyIntent: { forged: true } } });

for (const change of ['revoke', 'pause', 'remove-binding', 'remove-entry', 'replace-entry', 'replace-connection', 'stop'] as const) {
  test(`channel late allow after ${change} admits nothing, including siblings`, async t => {
    let release!: (v: AdmissionVerdict) => void; let entered = false; let calls = 0;
    const f = await fixture({ server: { inboundAdmission: config(() => { entered = true; calls++; return new Promise(r => { release = r; }); }) } }); t.after(f.close); await f.register();
    const inner = f.framework as any;
    const connection = inner.mcplServerRegistry.getServer('editor');
    const response = f.send('channels/incoming', { messages: [channel(), channel('two')] });
    await eventually(() => entered);
    const registry = inner.channelRegistry;
    const entries: Map<string, any> = registry.channels;
    const entry = [...entries.entries()].find(([, e]) => e.descriptor.id === 'chat')!;
    let restore = () => {};
    if (change === 'revoke') connection.establishGrant(CapabilityGrant.empty());
    if (change === 'pause') connection.pauseDataPlane();
    if (change === 'remove-binding') connection.requiredAdmission.invalidate();
    if (change === 'remove-entry') entries.delete(entry[0]);
    if (change === 'replace-entry') entries.set(entry[0], { ...entry[1] });
    if (change === 'replace-connection') {
      const get = inner.mcplServerRegistry.getServer.bind(inner.mcplServerRegistry);
      inner.mcplServerRegistry.getServer = () => ({}); restore = () => { inner.mcplServerRegistry.getServer = get; };
    }
    if (change === 'stop') { const queue = inner.queue; inner.queue = { isClosed: true }; restore = () => { inner.queue = queue; }; }
    release(allow);
    const r = await response; restore();
    assert(r.result.results.every((v: any) => v.accepted === false));
    const reasons = { revoke: 'admission_stale', pause: 'admission_not_ready', 'remove-binding': 'admission_missing', 'remove-entry': 'admission_stale', 'replace-entry': 'admission_stale', 'replace-connection': 'admission_stale', stop: 'admission_not_ready' };
    assert.equal(r.result.results[0].reason, reasons[change]);
    if (change === 'replace-connection' || change === 'stop') assert.equal(calls, 1, 'stale siblings never reach the hook');
    assert(!f.context().includes('sensitive_body'));
    assert.equal(f.membrane.calls.length, 0);
  });
}

test('overload refuses without a queue; another connection retains its budget', async t => {
  const releases: Array<(v: AdmissionVerdict) => void> = [];
  const a = await fixture({ server: { inboundAdmission: config(() => new Promise(r => releases.push(r)), 60000) } }); t.after(a.close); await a.register();
  const b = await fixture({ server: { inboundAdmission: config(() => allow) } }); t.after(b.close); await b.register();
  const pending = Array.from({ length: MAX_PENDING_ADMISSIONS }, (_, i) => a.send('channels/incoming', { messages: [channel(String(i))] }));
  await eventually(() => releases.length === MAX_PENDING_ADMISSIONS);
  assert.equal((await a.send('channels/incoming', { messages: [channel('overload')] })).result.results[0].reason, 'admission_denied');
  assert.equal((await b.send('channels/incoming', { messages: [channel('independent')] })).result.results[0].accepted, true);
  releases.forEach(r => r(deny)); await Promise.all(pending);
});

test('hook input is detached raw data and frozen; optional intent validator is inside preflight', async t => {
  let observed = false;
  const admission = config(input => {
    observed = true;
    assert(Object.isFrozen(input)); assert(Object.isFrozen(input.item)); assert(Object.isFrozen(input.item.metadata.tags));
    assert.deepEqual([...input.item.tags], ['chat:mention'], 'pre-expansion tags');
    assert.equal(input.item.metadata.replyIntent.forged, true, 'raw claim is merely evidence');
    assert.throws(() => { input.item.tags.push('changed'); });
    return { store: true, mayWake: false, replyIntent: { private: true } };
  });
  const f = await fixture({ server: { inboundAdmission: { ...admission, isReplyIntent: () => { throw Error('secret validator'); } } } }); t.after(f.close); await f.register();
  const r = await f.send('channels/incoming', { messages: [channel()] });
  assert.equal(r.result.results[0].reason, 'admission_threw'); assert(observed);
});

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) {
  test(`required quiesced ${lane} is held and admitted on resume`, async t => {
    let calls = 0;
    const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['pushEvents', 'inferenceRequest'] } }, server: { inboundAdmission: config(() => { calls++; return lane === 'inference/request' ? deny : allow; }) } });
    t.after(f.close); await f.register();
    const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
    await f.framework.quiesce({ reason: 'test' });
    const params = lane === 'channels/incoming' ? { messages: [channel()] } : lane === 'push/event' ? { ...f.params('p', 'held_body'), coalesce: undefined } : { featureSet: 'doc', messages: [] };
    let answered = false;
    const pending = f.send(lane, params).then(r => { answered = true; return r; });
    await eventually(() => connection.bufferedEvents.length > 0);
    assert.equal(calls, 0); assert.equal(answered, false);
    await f.framework.resume();
    const r = await pending;
    assert.equal(calls, 1);
    if (lane === 'inference/request') assert.equal(r.error.message, 'admission_denied');
    else {
      assert.equal(lane === 'channels/incoming' ? r.result.results[0].accepted : r.result.accepted, true);
      await f.framework.runUntilIdle();
      assert(f.context().includes(lane === 'channels/incoming' ? 'sensitive_body' : 'held_body'));
    }
  });
}

for (const outcome of ['match', 'absent', 'mismatch', 'throw', 'timeout', 'malformed', 'wrong-key', 'missing-bind', 'protocol'] as const) {
  test(`real stdio initialize ${outcome}: terminal and before initialized`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'admission-init-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let read = 0; let binds = 0;
    const admission: InboundAdmissionConfig = {
      ...config(() => allow, outcome === 'timeout' ? 1 : 5000),
      bind: key => { binds++; return outcome === 'missing-bind' ? undefined : { connection: outcome === 'wrong-key' ? { ...key } : key, admit: () => allow }; },
      initializeAttestation: { read: (result: any) => { read++; if (outcome === 'throw') throw Error('secret'); if (outcome === 'timeout') { const until = performance.now() + 5; while (performance.now() < until) {} } if (outcome === 'malformed') return () => {}; return outcome === 'absent' ? undefined : result.proof; }, matches: () => outcome !== 'mismatch' },
    };
    const transcript = join(dir, 'wire');
    const connecting = McplServerConnection.connectWithReconnect({ id: 'endpoint-a', command: process.execPath, args: [peer], reconnect: true,
      env: { TRANSCRIPT: transcript, ...(outcome === 'protocol' ? { PROTOCOL: 'wrong' } : {}) }, inboundAdmission: admission }, { version: '0.5' });
    if (outcome === 'match') { const c = await connecting; t.after(() => c.close()); await c.sendToolsCall('seen', {}); assert.equal(binds, 1); }
    else {
      await assert.rejects(connecting, e => outcome === 'protocol' ? /protocolVersion/.test(String(e)) : /^(AdmissionConnectError: (initialize_attestation_refused|admission_missing))$/.test(String(e)));
      const lines = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
      assert(!lines.includes('notifications/initialized'));
    }
    if (outcome === 'protocol') assert.equal(read, 0);
  });
}

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) {
  test(`real stdio framework ${lane} refuses before effects`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'admission-stdio-'));
    const membrane = new MockMembrane(); let calls = 0;
    const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
      mcplServers: [{ id: 'endpoint-a', command: process.execPath, args: [peer], enabledFeatureSets: ['feed'], inboundAdmission: config(() => { calls++; return deny; }) }],
    });
    t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
    const connection = (framework as any).mcplServerRegistry.getServer('endpoint-a');
    const send = (method: string, params: unknown) => connection.sendToolsCall('send', { method, params });
    await send('channels/register', { channels: [{ id: 'chat', type: 'synthetic', label: 'Room' }] });
    const params = lane === 'channels/incoming' ? { messages: [channel()] } : lane === 'push/event' ? { featureSet: 'feed', eventId: 'p', timestamp: TS, payload: { content: [{ type: 'text', text: 'sensitive_body' }] } } : { featureSet: 'feed', messages: [{ role: 'user', content: 'sensitive_body' }], stream: true };
    const r = await send(lane, params);
    assert.equal(lane === 'channels/incoming' ? r.result.results[0].reason : lane === 'push/event' ? r.result.reason : r.error.message, 'admission_denied');
    assert.equal(calls, 1); await framework.runUntilIdle(); assert.equal(membrane.calls.length, 0);
    assert(!JSON.stringify(framework.getAgent('agent')!.getContextManager().getAllMessages()).includes('sensitive_body'));
    const seen = await connection.sendToolsCall('seen', {});
    assert(!seen.some((m: string) => ['channels/typing', 'inference/chunk', 'inference/started'].includes(m)));
  });
}

for (const timeoutMs of [0, -1, 1.5, 60001, Infinity, NaN]) test(`invalid admission timeout ${timeoutMs} refuses before launch`, async () => {
  await assert.rejects(McplServerConnection.connect({ id: 'endpoint', command: '/must/not/spawn', inboundAdmission: config(() => allow, timeoutMs) }, { version: '0.5' }), /inboundAdmission requires/);
});

test('replacement objects with equal id and numeric epoch never share a binder key', () => {
  const keys: unknown[] = [];
  const cfg = { ...config(() => allow), bind: (key: any) => { keys.push(key); return { connection: key, admit: () => allow }; } };
  const a = new RequiredAdmission(cfg, 'endpoint'); const b = new RequiredAdmission(cfg, 'endpoint');
  a.bind(0); b.bind(0); assert.notEqual((keys[0] as any).instance, (keys[1] as any).instance);
  const old = a.capture(() => undefined); a.bind(1); assert.equal(old.check(), 'admission_stale');
});

for (const lane of ['push/event', 'inference/request'] as const) for (const change of ['revoke', 'pause', 'remove-binding', 'replace-connection', 'feature', 'loop'] as const) {
  if (lane === 'push/event' && change === 'loop') continue;
  test(`${lane} awaited verdict invalidated by ${change}`, async t => {
    let release!: (v: AdmissionVerdict) => void; let entered = false;
    const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['pushEvents', 'inferenceRequest'] } }, server: { inboundAdmission: config(() => { entered = true; return new Promise(r => { release = r; }); }) } }); t.after(f.close);
    const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
    let models = 0; inner.inferenceRouter.resolveModel = () => { models++; return 'test'; };
    const response = f.send(lane, lane === 'push/event' ? { ...f.params('one', 'sensitive_body'), coalesce: undefined } : { featureSet: 'doc', messages: [], stream: true });
    await eventually(() => entered); let restore = () => {};
    if (change === 'revoke') connection.establishGrant(CapabilityGrant.empty());
    if (change === 'pause') connection.pauseDataPlane();
    if (change === 'remove-binding') connection.requiredAdmission.invalidate();
    if (change === 'replace-connection') { const get = inner.mcplServerRegistry.getServer.bind(inner.mcplServerRegistry); inner.mcplServerRegistry.getServer = () => ({}); restore = () => { inner.mcplServerRegistry.getServer = get; }; }
    if (change === 'feature') { const validate = inner.featureSetManager.validateInbound; inner.featureSetManager.validateInbound = () => { throw Error('revoked'); }; restore = () => { inner.featureSetManager.validateInbound = validate; }; }
    if (change === 'loop') { const hooks = inner.inferenceRouter.hookOrchestrator; inner.inferenceRouter.hookOrchestrator = { isInHook: true }; restore = () => { inner.inferenceRouter.hookOrchestrator = hooks; }; }
    release({ store: true, mayWake: true }); const r = await response; restore();
    assert(lane === 'push/event' ? r.result.accepted === false : r.error.code === -32600);
    assert.equal(models, 0); assert.equal(f.membrane.calls.length, 0); assert(!f.context().includes('sensitive_body'));
  });
}

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) test(`${lane}: authorization wins without a hook call`, async t => {
  let calls = 0;
  const f = await fixture({ server: { inboundAdmission: config(() => { calls++; return allow; }) } }); t.after(f.close); await f.register();
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor'); connection.establishGrant(CapabilityGrant.empty());
  const r = await f.send(lane, lane === 'channels/incoming' ? { messages: [channel()] } : lane === 'push/event' ? f.params('one', 'no') : { featureSet: 'doc', messages: [] });
  const cap = lane === 'channels/incoming' ? 'channels.incoming' : lane === 'push/event' ? 'pushEvents' : 'inferenceRequest';
  const name = lane.replace('/', '-');
  assert.deepEqual(r.error, { code: -32002, message: `${name} rejected: capability "${cap}" not in the effective grant`, data: { capability: cap } });
  assert.equal(calls, 0);
  // Notification diagnostic at the shared emit boundary; transport ingress is exercised above.
  const lines: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
  connection.emit(name, {});
  assert(lines.some(line => line === `[mcpl] editor: discarded ${name} — "${cap}" not in the effective grant`));
});

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) test(`${lane}: late success after timeout is ignored and signal is aborted`, async t => {
  let release!: (v: AdmissionVerdict) => void; let signal!: AbortSignal;
  const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['pushEvents', 'inferenceRequest'] } }, server: { inboundAdmission: config(input => { signal = input.signal; return new Promise(r => { release = r; }); }, 50) } }); t.after(f.close); await f.register();
  const r = await f.send(lane, lane === 'channels/incoming' ? { messages: [channel()] } : lane === 'push/event' ? { ...f.params('one', 'sensitive_body'), coalesce: undefined } : { featureSet: 'doc', messages: [] });
  assert.equal(lane === 'channels/incoming' ? r.result.results[0].reason : lane === 'push/event' ? r.result.reason : r.error.message, 'admission_timeout');
  assert(signal.aborted); release({ store: true, mayWake: true }); await new Promise(r => setImmediate(r));
  await f.framework.runUntilIdle(); assert.equal(f.membrane.calls.length, 0); assert(!f.context().includes('sensitive_body'));
});

for (const next of ['fresh', 'missing', 'attestation'] as const) test(`real reconnect ${next}: fresh key or terminal refusal, never old binding`, async t => {
  const keys: any[] = []; let checks = 0;
  const admission: InboundAdmissionConfig = {
    ...config(() => allow),
    bind: key => { keys.push(key); return next === 'missing' && keys.length > 1 ? undefined : { connection: key, admit: () => allow }; },
    initializeAttestation: { read: (result: unknown) => result, matches: () => { checks++; return next !== 'attestation' || checks === 1; } },
  };
  const f = await fixture({ server: { inboundAdmission: admission, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 } }); t.after(f.close); await f.register();
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  const old = connection.requiredAdmission.capture(() => undefined);
  f.disconnect();
  if (next === 'fresh') {
    await eventually(() => keys.length > 1 && connection.isConnected && connection.dataPlaneReady);
    assert.equal(keys[0].instance, keys[1].instance); assert.notEqual(keys[0].transportEpoch, keys[1].transportEpoch);
    assert.equal(old.check(), 'admission_stale'); await f.register();
    assert.equal((await f.send('channels/incoming', { messages: [channel('new')] })).result.results[0].accepted, true);
  } else {
    await eventually(() => checks > 1 && !connection.willReconnect);
    assert.equal(connection.isConnected, false); assert.notEqual(old.check(), undefined);
  }
});

test('required coalesced work cannot inherit a replacement epoch or a removed binding', async t => {
  const f = await fixture({ server: { inboundAdmission: config(() => allow) } }); t.after(f.close);
  const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
  let occurrence: any;
  const accept = inner.pushCoalescer.accept.bind(inner.pushCoalescer);
  inner.pushCoalescer.accept = (value: any) => { occurrence = value; return accept(value); };
  await f.send('push/event', f.params('one', 'pending', { deferred: true }));
  assert(occurrence); assert.equal(inner.coalescedAuthorized(occurrence), true);
  connection.requiredAdmission.invalidate();
  assert.equal(inner.coalescedAuthorized(occurrence), false, 'removed admission binding cannot authorize a later coalesced effect');
});

test('real stdio notification awaiting admission cannot cross a replacement connection with the same id', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-notification-'));
  const membrane = new MockMembrane();
  let release!: (v: AdmissionVerdict) => void; let signal!: AbortSignal; const keys: any[] = [];
  const admission = config(input => { signal = input.signal; return new Promise(r => { release = r; }); });
  const bound = admission.bind;
  const server = { id: 'endpoint-a', command: process.execPath, args: [peer], enabledFeatureSets: ['feed'], inboundAdmission: { ...admission, bind: (key: any) => { keys.push(key); return bound(key); } } };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [server] });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const inner = framework as any; const old = inner.mcplServerRegistry.getServer('endpoint-a');
  let queued = 0; const queue = inner.pushHandler.pushEventFn;
  inner.pushHandler.pushEventFn = (...args: any[]) => { queued++; return queue(...args); };
  await old.sendToolsCall('send', { notify: true, method: 'push/event', params: { featureSet: 'feed', eventId: 'old', timestamp: TS, payload: { content: [{ type: 'text', text: 'old_notification' }] } } });
  await eventually(() => !!signal);
  await framework.disconnectMcplServer('endpoint-a'); assert(signal.aborted);
  await framework.connectMcplServer(server);
  assert.notEqual(keys[0].instance, keys[1].instance); assert.equal(keys[0].transportEpoch, keys[1].transportEpoch);
  release({ store: true, mayWake: true }); await new Promise(r => setImmediate(r));
  await framework.runUntilIdle(); assert.equal(queued, 0); assert.equal(membrane.calls.length, 0);
  assert(!JSON.stringify(framework.getAgent('agent')!.getContextManager().getAllMessages()).includes('old_notification'));
});

test('two stdio connections with colliding channel ids keep required and unconfigured paths separate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-mixed-')); const membrane = new MockMembrane(); let hooks = 0;
  const base = { command: process.execPath, args: [peer], enabledFeatureSets: ['feed'], shouldTriggerInference: () => false };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [
    { ...base, id: 'endpoint-a', inboundAdmission: config(() => { hooks++; return deny; }) },
    { ...base, id: 'endpoint-b' },
  ] });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['endpoint-a', 'endpoint-b']) {
    const connection = (framework as any).mcplServerRegistry.getServer(id);
    await connection.sendToolsCall('send', { method: 'channels/register', params: { channels: [{ id: 'room/one', type: 'synthetic', label: 'Room' }] } });
    const r = await connection.sendToolsCall('send', { method: 'channels/incoming', params: { messages: [{ ...channel(), channelId: 'room/one', threadId: 'topic:alpha/β' }] } });
    assert.equal(r.result.results[0].accepted, id === 'endpoint-b');
  }
  assert.equal(hooks, 1); await framework.runUntilIdle(); assert.equal(membrane.calls.length, 0);
});

test('framework startup does not degrade when a required binder is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-startup-'));
  let framework: AgentFramework | undefined;
  try {
    await assert.rejects(async () => {
      framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [{ id: 'endpoint-a', command: process.execPath, args: [peer], reconnect: true, inboundAdmission: { ...config(() => allow), bind: () => undefined } }] });
    }, /admission_missing/);
  } finally { await framework?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const required of [true, false]) test(`standalone tools/hints: required=${required} follows negotiated support`, async t => {
  const f = await fixture({ mcpl: { toolHints: true, toolsets: { workspace: { title: 'Workspace', default: 'closed' } } }, server: required ? { inboundAdmission: config(() => allow) } : {} }); t.after(f.close);
  const inner = f.framework as any;
  const controller = inner.toolsets().get('editor');
  assert.equal(f.hostCaps[0]!.toolHints === true, !required);
  const response = await f.send('tools/hints', { rev: 7, tools: [] });
  if (required) {
    assert.equal(controller, undefined, 'no RFC-014 controller on a hint-less connection');
    assert.equal(response.error.code, -32601);
  } else {
    assert.deepEqual(response.result, {});
    assert.equal(controller.presence.rev, 7);
    assert.notEqual(controller.recoveryTimer, null);
  }
});

test('required server transport outage does not abort framework startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-outage-'));
  let framework: AgentFramework | undefined;
  let binds = 0;
  try {
    framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [{ id: 'unavailable', command: join(dir, 'absent-peer'), inboundAdmission: { ...config(() => allow), bind: key => { binds++; return { connection: key, admit: () => allow }; } } }] });
    await framework.start(); assert(framework.getAgent('agent')); assert.equal(binds, 0);
  } finally { await framework?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const params of [null, 7, 'not-an-object']) test(`required receipt guard refuses non-object push params: ${JSON.stringify(params)}`, async t => {
  let hooks = 0; let routed = 0;
  const f = await fixture({ server: { inboundAdmission: config(() => { hooks++; return allow; }) } }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  connection.prependListener('push-event', () => { routed++; });
  const response = await f.send('push/event', params);
  assert.deepEqual(response.result, { accepted: false, reason: 'admission_missing' });
  assert.equal(hooks, 0); assert.equal(routed, 0, 'the transport guard, not a downstream fallback, refuses it');
});

test('required receipt-presence arm refuses an object before dispatch (labelled emit-boundary scaffold)', async t => {
  const f = await fixture({ server: { inboundAdmission: config(() => allow) } }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  let routed = 0; let response: unknown;
  connection.prependListener('push-event', () => { routed++; });
  connection.emit('push-event', f.params('no-receipt', 'body'), { respond: (r: unknown) => { response = r; } });
  assert.deepEqual(response, { accepted: false, reason: 'admission_missing' });
  assert.equal(routed, 0, 'admissionFor fallback must not mask the receipt-presence boundary');
});

for (const required of [true, false]) test(`solicited results: required=${required} preserves result taps`, async t => {
  const result = { content: [{ type: 'text', text: 'tool result' }] };
  const f = await fixture({ toolsCall: () => result, server: required ? { inboundAdmission: config(() => allow) } : {} }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  let taps = 0;
  connection.setReadTap(() => { taps++; });
  assert.deepEqual(await connection.sendToolsCall('probe', {}), result);
  assert.equal(taps, 1);
});

test('required solicited lists retain their bookkeeping tap and adopt toolsets/list results', async t => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  let rev = 0;
  let tools: any[] = [];
  const requests: string[] = [];
  wss.on('connection', ws => ws.on('message', bytes => {
    const m = JSON.parse(String(bytes));
    if (!m.method || m.id === undefined) return;
    requests.push(m.method);
    const result = m.method === 'initialize' ? {
      protocolVersion: '2024-11-05', serverInfo: { name: 'endpoint', version: '1' },
      capabilities: { tools: {}, experimental: { mcpl: { version: '0.5',
        toolHints: true, toolsets: { workspace: { title: 'Workspace', default: 'closed' } },
      } } },
    } : m.method === 'tools/list' ? { tools, _meta: { 'mcpl/rev': rev } }
      : m.method === 'toolsets/list' ? { rev, open: [{ toolset: 'workspace', title: 'Open workspace' }], tools } : { accepted: true };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  }));
  const dir = mkdtempSync(join(tmpdir(), 'required-tool-inventory-'));
  let hooks = 0;
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(), modules: [],
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    mcplServers: [{ id: 'endpoint', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      inboundAdmission: config(() => { hooks++; return deny; }) }],
  });
  t.after(async () => {
    await framework.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(r => wss.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const inner = framework as any;
  const connection = inner.mcplServerRegistry.getServer('endpoint');
  assert.equal(inner.toolsets().get('endpoint'), undefined);
  // Explicit host-side controller scaffold: negotiation installs none, but
  // required transport must not suppress solicited result bookkeeping.
  const controller = inner.toolsets().controllerFor({ id: 'endpoint' });
  controller.attach(connection);
  await connection.sendToolsList();
  assert(controller.presents);
  connection.establishGrant(CapabilityGrant.empty());
  assert.equal(controller.presence.rev, 0);
  const before = JSON.stringify(framework.getAgent('assistant')!.getContextManager().getAllMessages());
  const tap = connection.readTap; let taps = 0;
  connection.setReadTap((...args: any[]) => { taps++; tap(...args); });
  const queued: unknown[] = [];
  const push = inner.queue.push.bind(inner.queue);
  inner.queue.push = (event: unknown) => { queued.push(event); return push(event); };
  tools = [{ name: 'inventory_probe', description: 'catalogue only', inputSchema: { type: 'object' } }];
  rev = 7;
  requests.length = 0;
  assert.deepEqual((await connection.sendToolsList()).tools, tools);
  assert(taps >= 1, 'completed-inventory and solicited-result taps remain');
  assert.deepEqual(controller.presence.tool('inventory_probe'), tools[0]);
  assert.equal(controller.presence.rev, 7);
  assert.notEqual(controller.recoveryTimer, null, 'a solicited revision gap can schedule list recovery');
  await eventually(() => requests.filter(method => method === 'tools/list').length >= 2 && requests.includes('toolsets/list'));
  await eventually(() => !controller.recovering && controller.recoveryTimer === null);
  assert(requests.every(method => method === 'tools/list' || method === 'toolsets/list'));
  assert([...controller.presence.view().values()].some((v: any) => v.title === 'Open workspace'), 'toolsets/list adopted the peer’s open toolset');
  assert.equal(hooks, 0);
  assert.equal(queued.length, 0, 'catalogue recovery queues no content or wake');
  assert.equal(membrane.calls.length, 0);
  assert.equal(JSON.stringify(framework.getAgent('assistant')!.getContextManager().getAllMessages()), before);
});


test('required handshake drops null, refuses all data lanes, and buffers a same-chunk ping', async t => {
  let hooks = 0;
  const connection = await McplServerConnection.connect({
    id: 'endpoint-a', command: process.execPath, args: [peer], env: { EARLY: '1' },
    inboundAdmission: config(() => { hooks++; return allow; }),
  }, { version: '0.5' });
  t.after(() => connection.close());
  const answers = await connection.sendToolsCall('answers', {}) as any;
  for (const method of ['channels/incoming', 'push/event', 'inference/request']) {
    assert.deepEqual(answers.find((r: any) => r.id === method)?.error,
      { code: -32002, message: 'capability_denied' });
  }
  assert.deepEqual(answers.find((r: any) => r.id === 'same-chunk')?.result, {});
  assert.equal(hooks, 0);
});


test('required startup-staged push waits for ready and a current grant before admission', async t => {
  let calls = 0;
  const connection = await McplServerConnection.connect({ id: 'endpoint-a', command: process.execPath, args: [peer], inboundAdmission: config(() => { calls++; return allow; }) }, { version: '0.5' });
  t.after(() => connection.close());
  connection.on('push-event', async (params, responder) => {
    const verdict = await connection.admissionFor(params).admit('push/event', params);
    responder.respond({ accepted: verdict.store });
  });
  const pending = connection.sendToolsCall('send', { method: 'push/event', params: { featureSet: 'feed', eventId: 'staged', payload: { content: [{ type: 'text', text: 'startup' }] } } });
  await eventually(() => (connection as any).bufferedEvents.length > 0);
  assert.equal(calls, 0);
  connection.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  connection.ready();
  assert.equal((await pending as any).result.accepted, true);
  assert.equal(calls, 1);
});

test('required held notification from a superseded epoch is refused, never rebound at flush', async t => {
  let calls = 0;
  const f = await fixture({ server: { inboundAdmission: config(() => { calls++; return allow; }), reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 } }); t.after(f.close);
  const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
  await f.framework.quiesce({ reason: 'test' });
  // Read through the real transport, but as a notification so a dead responder
  // is not needed to observe the stale flush.
  f.notify('push/event', { ...f.params('old', 'old_epoch'), coalesce: undefined });
  await eventually(() => connection.bufferedEvents.length > 0);
  const epoch = connection.transportEpoch;
  f.disconnect();
  await eventually(() => connection.transportEpoch > epoch && connection.isConnected && connection.controlPlaneReady);
  let reason: string | undefined;
  const refuse = connection.refuseAdmission.bind(connection);
  connection.refuseAdmission = (...args: any[]) => { reason = args[3]; return refuse(...args); };
  await f.framework.resume();
  assert.equal(reason, 'admission_stale'); assert.equal(calls, 0);
  await f.framework.runUntilIdle(); assert(!f.context().includes('old_epoch'));
});
