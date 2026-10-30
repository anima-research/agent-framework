import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionRefusals, type RefusalCode } from '../src/mcpl/inbound-admission.js';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';

for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) {
  for (const reason of ['admission_denied', 'admission_threw', 'admission_invalid', 'admission_timeout'] as const) {
    test(`${lane} ${reason}: all refusals traced, notification logs rate limited`, async t => {
      const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['pushEvents', 'inferenceRequest'] } }, server: { inboundAdmission: {
        timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit: () => {
          if (reason === 'admission_threw') throw Error('private_callback_detail');
          if (reason === 'admission_invalid') return { store: 'private_verdict' };
          if (reason === 'admission_timeout') return new Promise(() => {});
          return { store: false, mayWake: false, reason };
        } }), isReplyIntent: () => true,
      } } }); t.after(f.close); await f.register();
      const traces: any[] = []; f.framework.onTrace(event => { traces.push(event); });
      const lines: string[] = []; t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
      const item = lane === 'channels/incoming' ? { messages: [{ channelId: 'chat', messageId: 'test', timestamp: TS, content: [{ type: 'text', text: 'private_payload' }] }] }
        : lane === 'push/event' ? { ...f.params('test', 'private_payload'), coalesce: undefined } : { featureSet: 'doc', messages: [], stream: true };
      for (let i = 0; i < 2; i++) {
        if (lane === 'inference/request') assert.equal((await f.send(lane, item)).error.message, reason);
        else f.notify(lane, item);
      }
      await eventually(() => traces.filter(e => (e.reason ?? e.error) === reason).length === 2);
      assert.equal(lines.filter(line => line.includes(`reason=${reason}`)).length, 1);
      assert(!lines.join('\n').includes('private_'));
      assert.equal(f.membrane.calls.length, 0);
      assert(!f.context().includes('private_payload'));
    });
  }
}

test('every fixed refusal code has a trace; rate limiting applies only to lines', t => {
  const reports = new AdmissionRefusals(); const traces: any[] = []; const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const reasons: RefusalCode[] = ['admission_denied', 'admission_threw', 'admission_timeout', 'admission_invalid', 'admission_missing', 'admission_stale', 'admission_not_ready', 'admission_unsupported', 'admission_mode_ungranted'];
  for (const lane of ['channels/incoming', 'push/event', 'inference/request'] as const) for (const reason of reasons) {
    for (let i = 0; i < 2; i++) reports.report(e => traces.push(e), 'endpoint', lane, reason, { payload: 'private_payload' });
  }
  assert.equal(traces.length, reasons.length * 3 * 2);
  assert.equal(lines.length, reasons.length * 3);
  assert(!JSON.stringify({ traces, lines }).includes('private_payload'));
});
