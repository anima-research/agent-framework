import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
const cases: Array<[string, () => unknown, string]> = [
  ['denied', () => ({ store: false, mayWake: false, reason: 'admission_denied' }), 'admission_denied'],
  ['throw', () => { throw Error('secret'); }, 'admission_threw'],
  ['timeout', () => new Promise(() => {}), 'admission_timeout'],
  ['invalid', () => ({ store: true, mayWake: 'yes' }), 'admission_invalid'],
];
for (const coalesced of [false, true]) for (const [name, verdict, reason] of cases) {
  test(`required push ${coalesced ? 'coalesced' : 'ordinary'} ${name}: before dedup and effects`, async t => {
    let allow = false; let gates = 0; let calls = 0;
    const f = await fixture({ server: {
      inboundAdmission: { timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit: () => { calls++; return allow ? { store: true, mayWake: false } : verdict(); } }), isReplyIntent: () => true },
      shouldTriggerInference: () => { gates++; return true; },
    } }); t.after(f.close);
    const params = { ...f.params('one', 'push_content', { initial: true }), ...(!coalesced ? { coalesce: undefined } : {}) };
    const before = f.context();
    const response = await f.send('push/event', params);
    assert.deepEqual(response.result, { accepted: false, reason: reason });
    assert.equal(calls, 1); assert.equal(gates, 0);
    await f.framework.runUntilIdle();
    assert.equal(f.context(), before); assert.equal(f.membrane.calls.length, 0); assert.equal(f.renders.length, 0);
    allow = true;
    assert.equal((await f.send('push/event', params)).result.accepted, true, 'refusal did not burn eventId');
    await f.framework.runUntilIdle();
    assert(f.context().includes('push_content')); assert.equal(f.membrane.calls.length, 0); assert.equal(gates, 0);
  });
}

for (const toolHints of [undefined, true, false]) test(`required connection does not offer hints even with toolHints=${toolHints}`, async t => {
  const lines: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const f = await fixture({
    mcpl: { toolHints: true, toolsets: { workspace: { title: 'Workspace', default: 'closed' } } },
    server: { toolHints, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20, inboundAdmission: { timeoutMs: 5000, bind: (connection: unknown) => ({ connection, admit: () => ({ store: true, mayWake: false }) }), isReplyIntent: () => true } },
  }); t.after(f.close);
  const inner = f.framework as any; const connection = inner.mcplServerRegistry.getServer('editor');
  const warnings = () => lines.filter(line => line.includes('toolHints: true is disabled by inboundAdmission'));
  assert.notEqual(f.hostCaps[0]!.toolHints, true);
  assert.equal(connection.readTap, null);
  assert.equal(inner.toolsetHub?.get('editor'), undefined, 'no RFC-014 toolset presence, even for a declaring peer');
  assert.equal(warnings().length, toolHints === true ? 1 : 0);
  f.disconnect();
  await eventually(() => f.hostCaps.length === 2 && connection.isConnected && connection.dataPlaneReady);
  assert.notEqual(f.hostCaps[1]!.toolHints, true);
  assert.equal(inner.toolsetHub?.get('editor'), undefined);
  assert.equal(warnings().length, toolHints === true ? 1 : 0, 'the explicit override is surfaced once, not on automatic transport retries');
});
