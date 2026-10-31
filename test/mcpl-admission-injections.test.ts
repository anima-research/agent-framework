/** Required admission also governs messages deferred by a running tool round. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Module, ModuleContext } from '../src/index.js';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { createMockResponse } from './helpers/mock-membrane.js';

for (const lane of ['channels/incoming', 'push/event'] as const) {
  for (const carries of [true, false, 'undeclared'] as const) {
    test(`required ${lane}: deferred delivery with injection support ${carries} keeps admission and wake limits`, async t => {
      let context!: ModuleContext;
      let entered = false;
      let observed = 0;
      let hooks = 0;
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const probe: Module = {
        name: 'probe',
        async start(ctx) { context = ctx; },
        async stop() {},
        getTools: () => [{ name: 'wait', description: 'Wait for input', inputSchema: { type: 'object', properties: {} } }],
        async handleToolCall() { entered = true; await blocked; return { success: true }; },
        async onProcess(event) {
          if (event.type === 'external-message') return { requestInference: true };
          if (event.type === 'mcpl:channel-incoming' || event.type === 'mcpl:push-event') {
            observed++;
            // Even a module's explicit request must not promote mayWake:false.
            return { requestInference: true };
          }
          return {};
        },
      };
      const f = await fixture({ framework: { modules: [probe] }, server: {
        inboundAdmission: {
          timeoutMs: 5000,
          bind: (connection: unknown) => ({ connection, admit: (input: any) => {
            hooks++;
            return (input.item.messageId ?? input.item.eventId) === 'denied'
              ? { store: false, mayWake: false, reason: 'admission_denied' }
              : { store: true, mayWake: false };
          } }),
          isReplyIntent: () => true,
        },
      } });
      let running: Promise<void> | undefined;
      t.after(async () => { release(); await running; await f.close(); });
      await f.register();
      f.membrane.supportsInjectedMessages = carries;
      f.membrane.responses.length = 0;
      f.membrane.pushResponse(createMockResponse([
        { type: 'tool_use', id: 'wait-1', name: 'probe--wait', input: {} },
      ], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'round_finished' }]));
      f.framework.pushEvent({ type: 'external-message', source: 'test', content: 'start', metadata: {} });
      running = f.framework.runUntilIdle();
      await eventually(() => entered);

      const send = (id: string) => f.send(lane, lane === 'channels/incoming'
        ? { messages: [{ channelId: 'chat', messageId: id, timestamp: TS, content: [{ type: 'text', text: `${id}_body` }] }] }
        : { featureSet: 'doc', eventId: id, timestamp: TS, payload: { content: [{ type: 'text', text: `${id}_body` }] } });
      const denied = await send('denied');
      assert.equal(lane === 'channels/incoming' ? denied.result.results[0].reason : denied.result.reason, 'admission_denied');
      const admitted = await send('admitted');
      assert.equal(lane === 'channels/incoming' ? admitted.result.results[0].accepted : admitted.result.accepted, true);
      await eventually(() => context.queryMessages({}).messages.some(m => m.held && JSON.stringify(m.content).includes('admitted_body')));
      assert.equal(hooks, 2);
      assert.equal(observed, 1, 'denied work never reaches a module');
      assert(!f.context().includes('admitted_body'), 'the active turn defers storage');

      release();
      await running;
      assert.equal(f.membrane.calls.length, 1, 'neither refusal nor deferred module request starts another turn');
      const injected = JSON.stringify(f.membrane.lastStream!.receivedToolResultOptions);
      assert.equal(injected.includes('admitted_body'), carries === true, 'only declared support permits a mid-turn injection');
      assert(!injected.includes('denied_body'));
      assert(!f.context().includes('denied_body'));
      assert(f.context().includes('admitted_body'));
      assert.equal(hooks, 2, 'flushing admitted work does not run another ingress preflight');
      if (carries !== true) {
        assert(f.context().indexOf('round_finished') < f.context().indexOf('admitted_body'), 'undeclared and non-carrying streams store at turn end');
      }
    });
  }
}
