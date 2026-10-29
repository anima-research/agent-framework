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

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) {
  test(`required pre-ready ${lane} is refused, not held`, async t => {
    let calls = 0;
    const f = await fixture({ server: { inboundAdmission: config(() => { calls++; return allow; }) } }); t.after(f.close); await f.register();
    const connection = (f.framework as any).mcplServerRegistry.getServer('editor');
    connection.pauseDataPlane();
    const before = connection.bufferedEvents.length;
    const params = lane === 'channels/incoming' ? { messages: [channel()] } : lane === 'push/event' ? f.params('p', 'body') : { featureSet: 'doc', messages: [] };
    const r = await f.send(lane, params);
    assert.equal(lane === 'channels/incoming' ? r.result.results[0].reason : lane === 'push/event' ? r.result.reason : r.error.message, 'admission_not_ready');
    assert.equal(connection.bufferedEvents.length, before); assert.equal(calls, 0);
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

test('framework startup does not degrade when a required binder is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-startup-'));
  let framework: AgentFramework | undefined;
  try {
    await assert.rejects(async () => {
      framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [], mcplServers: [{ id: 'endpoint-a', command: process.execPath, args: [peer], reconnect: true, inboundAdmission: { ...config(() => allow), bind: () => undefined } }] });
    }, /admission_missing/);
  } finally { await framework?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const required of [true, false]) test(`standalone tools/hints: required=${required} preserves the opt-in boundary over WebSocket`, async t => {
  let hooks = 0;
  const f = await fixture({
    mcpl: { toolHints: true, toolsets: { workspace: { title: 'Workspace', default: 'closed' } } },
    server: required ? { inboundAdmission: config(() => { hooks++; return allow; }) } : {},
  }); t.after(f.close);
  const inner = f.framework as any;
  const connection = inner.mcplServerRegistry.getServer('editor');
  const controller = inner.toolsets().get('editor');
  assert(controller?.presents, 'a declaring peer has active toolset state, not a no-op tap');
  connection.establishGrant(CapabilityGrant.empty());
  const before = controller.presence.rev;
  const tap = connection.readTap; let taps = 0;
  connection.setReadTap((...args: any[]) => { taps++; tap(...args); });
  const response = await f.send('tools/hints', { rev: before + 7, tools: [] });
  assert.equal(hooks, 0);
  if (required) {
    assert.deepEqual(response.error, { code: -32600, message: 'admission_unsupported' });
    assert.equal(taps, 0); assert.equal(controller.presence.rev, before);
    assert.equal(controller.recoveryTimer, null);
  } else {
    assert.deepEqual(response.result, {});
    assert.equal(taps, 1); assert.equal(controller.presence.rev, before + 7);
    assert.notEqual(controller.recoveryTimer, null, 'legacy skipped-revision recovery is unchanged');
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
