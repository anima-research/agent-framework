import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { RequiredAdmission, type InboundAdmissionConfig } from '../src/mcpl/inbound-admission.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';

const allow = { store: true, mayWake: false } as const;
const cfg = (admit: (input: any) => any = () => allow): InboundAdmissionConfig => ({ timeoutMs: 5000, bind: connection => ({ connection, admit }), isReplyIntent: () => true });

for (const factory of ['connect', 'connectWithReconnect'] as const) test(`#3 direct ${factory} refuses framework-only admission before launch`, async () => {
  await assert.rejects(McplServerConnection[factory]({ id: 'direct', command: '/must/not/spawn', inboundAdmission: cfg() }, { version: '0.5' }), /inboundAdmission is supported only through AgentFramework/);
});

test('#1 channel grant is rechecked after the coalescer mutex wait', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close); await f.register();
  const inner = f.framework as any;
  let unlock!: () => void;
  const lock = inner.pushCoalescer.locked(() => new Promise<void>(r => { unlock = r; }));
  t.after(() => unlock());
  await eventually(() => !!unlock);
  let waiting = false;
  const accept = inner.pushCoalescer.accept.bind(inner.pushCoalescer);
  inner.pushCoalescer.accept = (...args: any[]) => { waiting = true; return accept(...args); };
  const response = f.send('push/event', f.params('one', 'not_stored', { channelId: 'chat', initial: true }));
  await eventually(() => waiting);
  inner.mcplServerRegistry.getServer('editor').grant = new CapabilityGrant(new Set(['pushEvents']), []);
  unlock(); await lock;
  assert.deepEqual((await response).result, { accepted: false, reason: 'admission_stale' });
  assert(!f.context().includes('not_stored'));
});

test('#2 reservation throw retires earlier batch tickets', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close);
  let retired = 0; let calls = 0;
  const admission = { ...new RequiredAdmission(cfg(), 'test').capture(() => undefined), orderCoalesced: () => {
    if (++calls === 2) throw Error('reservation failed');
    return { ready: Promise.resolve(), retire: () => { retired++; } };
  } };
  await assert.rejects((f.framework as any).channelRegistry.handleIncoming('editor', { messages: [f.channel('a', 'a'), f.channel('b', 'b')] }, undefined, admission), /reservation failed/);
  assert.equal(retired, 1);
});

for (const mode of ['hang', 'throw'] as const) test(`#4 required coalesced module ${mode} cannot stall held delivery/ack; dispatch FIFO`, async t => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const seen: string[] = [];
  const spy = { name: 'spy', async start() {}, async stop() {}, async onProcess(event: any) {
    if (event.type !== 'mcpl:push-event') return {};
    seen.push(event.eventId);
    if (event.eventId === 'one') { if (mode === 'throw') throw Error('module test'); await held; }
    return {};
  } };
  const f = await fixture({ server: { inboundAdmission: cfg() }, framework: { modules: [spy] } as never });
  t.after(async () => { release(); await f.close(); });
  const c = (f.framework as any).mcplServerRegistry.getServer('editor');
  c.pauseDataPlane();
  const one = f.send('push/event', f.params('one', 'first', { initial: true }));
  const two = f.send('push/event', f.params('two', 'second'));
  await eventually(() => c.bufferedEvents.length === 2);
  c.ready();
  assert.equal((await one).result.accepted, true);
  assert.equal((await two).result.accepted, true);
  await eventually(() => seen.length >= 1);
  if (mode === 'hang') assert.deepEqual(seen, ['one']);
  release(); await eventually(() => seen.length === 2);
  assert.deepEqual(seen, ['one', 'two']);
});

test('#5 feature rejection remains visible on required push preflight', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close);
  const lines: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
  const r = await f.send('push/event', { ...f.params('bad', 'no'), featureSet: 'undeclared' });
  assert(r.error);
  assert(lines.some(l => l.includes('[push-event-rejected] server=editor') && l.includes('eventId=bad') && l.includes('reason=')));
});

for (const lane of ['push/event', 'channels/incoming'] as const) test(`#6 ${lane} tickets are bounded behind a slow predecessor`, async t => {
  let release!: (v: any) => void; let calls = 0;
  const f = await fixture({ server: { inboundAdmission: cfg(() => { calls++; return new Promise(r => { release ??= r; }); }) } });
  t.after(f.close); await f.register();
  const inner = f.framework as any;
  const first = f.send(lane, lane === 'push/event' ? f.params('slow', 'x') : { messages: [f.channel('slow', 'x')] });
  await eventually(() => !!release);
  // Saturate the occurrence budget with retired tails, as refused live ingress
  // used to do. They still wait for their predecessor, but have a fixed bound.
  const tickets = Array.from({ length: 63 }, () => inner.takeCoalescingTicket('editor', lane === 'push/event' ? { kind: 'featureSet', id: 'doc' } : { kind: 'channel', id: 'chat' }, lane === 'push/event' ? 'document' : 'message:m'));
  const refused = await f.send(lane, lane === 'push/event' ? f.params('overflow', 'no') : { messages: [f.channel('overflow', 'no')] });
  assert.equal(lane === 'push/event' ? refused.result.reason : refused.result.results[0].reason, 'admission_denied');
  assert.equal(calls, 1);
  assert.equal(inner.coalescingTicketCounts.get('editor'), 64);
  for (const ticket of tickets) ticket.retire();
  release(allow); await first;
  await eventually(() => inner.coalescingTicketCounts.size === 0);
});

for (const change of ['pause', 'grant'] as const) test(`#9 restored ${change} does not revive a pending verdict`, async t => {
  let release!: (v: any) => void;
  const f = await fixture({ server: { inboundAdmission: cfg(() => new Promise(r => { release = r; })) } }); t.after(f.close);
  const c = (f.framework as any).mcplServerRegistry.getServer('editor');
  const response = f.send('push/event', { ...f.params('one', 'never'), coalesce: undefined });
  await eventually(() => !!release);
  if (change === 'pause') { c.pauseDataPlane(); c.ready(); }
  else { const old = c.grant; c.establishGrant(CapabilityGrant.empty()); c.establishGrant(old); }
  release(allow);
  assert.deepEqual((await response).result, { accepted: false, reason: 'admission_stale' });
  assert(!f.context().includes('never'));
});

test('#11 inherited callback and attestation configuration is snapshotted explicitly', async () => {
  let binds = 0; let attests = 0; let admits = 0;
  const config = Object.create({ bind(connection: any) { binds++; return { connection, admit: () => { admits++; return allow; } }; }, isReplyIntent: () => true,
    initializeAttestation: Object.create({ read: () => { attests++; return 'proof'; }, matches: (v: any) => v === 'proof' }) });
  config.timeoutMs = 5000;
  const a = new RequiredAdmission(config, 'test'); await a.attest({}); a.bind(0);
  assert.equal((await a.capture(() => undefined).admit('push/event', {})).store, true);
  assert.deepEqual([binds, attests, admits], [1, 1, 1]);
});

test('#12 deferred push refuses before receipt replay', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close);
  const p = f.params('same', 'accepted', { initial: true });
  assert.equal((await f.send('push/event', p)).result.accepted, true);
  assert.deepEqual((await f.send('push/event', { ...p, coalesce: { ...p.coalesce, deferred: true } })).result, { accepted: false, reason: 'admission_unsupported' });
});

test('#13 receipt queued before suspension refuses when it acquires the mutex', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close);
  const p = f.params('same', 'accepted', { initial: true });
  await f.send('push/event', p);
  const inner = f.framework as any; const coalescer = inner.pushCoalescer;
  let unlock!: () => void;
  const lock = coalescer.locked(() => new Promise<void>(r => { unlock = r; }));
  await eventually(() => !!unlock);
  const replay = inner.replayCoalescedPush('editor', p);
  const rejected = assert.rejects(replay, /host is stopping/);
  coalescer.suspended = true;
  unlock(); await lock; await rejected;
});

test('#15 sparse arrays keep their original length through attestation snapshots', async () => {
  let length = -1;
  const a = new RequiredAdmission({ ...cfg(), initializeAttestation: { read: () => new Array(2), matches: (v: any) => { length = v.length; return true; } } }, 'test');
  await a.attest({}); assert.equal(length, 2);
});

test('#16 held inference is traced stale at the transport boundary', async t => {
  const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['inferenceRequest'] } }, server: { inboundAdmission: cfg() } }); t.after(f.close);
  const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
  const c = (f.framework as any).mcplServerRegistry.getServer('editor'); c.pauseDataPlane();
  f.notify('inference/request', { featureSet: 'doc', messages: [] });
  await eventually(() => c.bufferedEvents.length === 1);
  f.disconnect();
  await eventually(() => traces.some(e => e.type === 'mcpl:inference_fail' && e.error === 'admission_stale'));
});

test('#10 inherited stdio inboundAdmission survives the framework environment copy', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { AgentFramework } = await import('../src/framework.js');
  const { MockMembrane } = await import('./helpers/mock-membrane.js');
  const dir = mkdtempSync(join(tmpdir(), 'admission-inherited-'));
  let calls = 0;
  const admission = cfg(() => { calls++; return { store: false, mayWake: false, reason: 'admission_denied' }; });
  const server = Object.assign(Object.create({ get inboundAdmission() { return admission; } }), {
    id: 'endpoint-a', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/required-admission-server.mjs', import.meta.url))], enabledFeatureSets: ['feed'],
  });
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [server] });
  t.after(async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); });
  const c = (framework as any).mcplServerRegistry.getServer('endpoint-a');
  const r = await c.sendToolsCall('send', { method: 'push/event', params: { featureSet: 'feed', eventId: 'one', payload: { content: [{ type: 'text', text: 'no' }] } } });
  assert.equal(r.result.reason, 'admission_denied'); assert.equal(calls, 1);
});


test('R3-3 required WebSocket retains caller config identity', async t => {
  const f = await fixture({ server: { inboundAdmission: cfg() } }); t.after(f.close);
  const inner = f.framework as any;
  const config = inner.mcplServerConfigs.get('editor');
  const c = inner.mcplServerRegistry.getServer('editor');
  assert.equal(c.config, config);
  for (const factory of ['connect', 'connectWithReconnect'] as const)
    await assert.rejects(McplServerConnection[factory](config, { version: '0.5' }), /inboundAdmission is supported only through AgentFramework/);
});

test('R3-3 framework server-text trace redacts the accessProvider dial token', async t => {
  const token = 'synthetic-provider-secret-R3';
  const f = await fixture({ server: { inboundAdmission: cfg(), accessProvider: () => token } }); t.after(f.close);
  const inner = f.framework as any; const traces: any[] = []; f.framework.onTrace(e => traces.push(e));
  inner.mcplServerRegistry.getServer('editor').emit('orphaned-response', {
    id: 123, method: 'tools/call', hadState: false, hadCheckpoint: false, error: { code: -32000, message: `quoted ${token}` },
  });
  const record = traces.find(e => e.type === 'mcpl:orphaned-response');
  assert(record); assert(!JSON.stringify(record).includes(token));
  assert(record.error.includes('quoted'), 'the server text was recorded, not discarded');
});
