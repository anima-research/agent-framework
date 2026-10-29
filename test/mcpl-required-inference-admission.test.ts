import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const cases: Array<[string, () => unknown, string]> = [
  ['denied', () => ({ store: false, mayWake: false, reason: 'admission_denied' }), 'admission_denied'],
  ['false wake', () => ({ store: true, mayWake: false }), 'admission_denied'],
  ['throw', () => { throw Error('secret'); }, 'admission_threw'],
  ['timeout', () => new Promise(() => {}), 'admission_timeout'],
  ['invalid', () => ({ store: true, mayWake: 'yes' }), 'admission_invalid'],
];
for (const [name, verdict, reason] of cases) test(`required inference ${name}: no model resolution, chunks or inference`, async t => {
  let calls = 0;
  const f = await fixture({ featureSets: { doc: { description: 'doc', uses: ['inferenceRequest'] } }, server: {
    inboundAdmission: { timeoutMs: 50, bind: (connection: unknown) => ({ connection, admit: (input: any) => { calls++; assert.equal(input.lane, 'inference/request'); return verdict(); } }), isReplyIntent: () => true },
  } }); t.after(f.close);
  let resolves = 0;
  (f.framework as any).inferenceRouter.resolveModel = () => { resolves++; return 'test'; };
  const response = await f.send('inference/request', { featureSet: 'doc', messages: [{ role: 'user', content: 'never_infer' }], stream: true });
  assert.deepEqual(response.error, { code: -32600, message: reason });
  assert.equal(calls, 1); assert.equal(resolves, 0); assert.equal(f.membrane.calls.length, 0);
});

// These requests cross a real WebSocket; instrument router answer attempts too,
// since an epoch-guarded transport write alone could hide an incorrect answer.

const until = async (check: () => boolean) => {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, 'interaction did not settle');
    await new Promise(r => setTimeout(r, 5));
  }
};

const interactions = [
  ...(['stop', 'router-stop', 'close'] as const).flatMap(end => [true, false].flatMap(store =>
    [true, false].map(stream => ({ end, store, stream, phase: 'pending admission' })))),
  ...(['stop', 'close'] as const).map(end => ({ end, store: true, stream: false, phase: 'allowed provider call' })),
];
for (const { end, store, stream, phase } of interactions) {
  test(`required inference ${phase}: ${end}, late store=${store}, stream=${stream}`, async t => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    let socket!: WebSocket;
    const replies: any[] = [];
    wss.on('connection', ws => {
      socket = ws;
      ws.on('message', bytes => {
        const m = JSON.parse(String(bytes));
        if (!m.method) { replies.push(m); return; }
        if (m.id === undefined) return;
        const result = m.method === 'initialize' ? {
          protocolVersion: '2024-11-05', serverInfo: { name: 'endpoint', version: '1' },
          capabilities: { tools: {}, experimental: { mcpl: { version: '0.5', inferenceRequest: true,
            featureSets: { doc: { description: 'doc', uses: ['inferenceRequest'] } } } } },
        } : m.method === 'tools/list' ? { tools: [] } : { accepted: true };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'required-inference-end-'));
    let release!: (verdict: any) => void;
    let hookSignal: AbortSignal | undefined;
    const membrane = new MockMembrane();
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: membrane.asMembrane(), modules: [],
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
      mcplServers: [{ id: 'endpoint', url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        enabledFeatureSets: ['doc'], inboundAdmission: { timeoutMs: 60000, isReplyIntent: () => true,
          bind: connection => ({ connection, admit: input => {
            hookSignal = input.signal;
            if (phase === 'allowed provider call') return { store: true, mayWake: true };
            return new Promise(r => { release = r; });
          } }),
        } }],
    });
    t.after(async () => {
      release?.({ store: false, mayWake: false, reason: 'admission_denied' });
      await fw.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(r => wss.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });
    const inner = fw as any;
    const connection = inner.mcplServerRegistry.getServer('endpoint');
    let resolutions = 0;
    inner.inferenceRouter.resolveModel = () => { resolutions++; return 'test'; };
    const failures: any[] = [];
    fw.onTrace(event => { if ((event as { type: string }).type === 'mcpl:inference_fail') failures.push(event); });
    let providerSignal: AbortSignal | undefined;
    let providerCalls = 0;
    if (phase === 'allowed provider call') inner.inferenceRouter.membrane = {
      complete: (_request: unknown, options: { signal: AbortSignal }) => {
        providerCalls++; providerSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted')), { once: true });
        });
      },
    };
    const attempts: any[] = [];
    for (const method of ['sendResponse', 'sendErrorResponse']) {
      const original = connection[method].bind(connection);
      connection[method] = (...args: any[]) => { attempts.push({ method, args }); return original(...args); };
    }
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'inference/request',
      params: { featureSet: 'doc', messages: [{ role: 'user', content: 'pending' }], stream } }));
    await until(() => !!hookSignal);
    if (phase === 'allowed provider call') await until(() => !!providerSignal);
    assert.equal(connection.requiredAdmission.pending.size, phase === 'pending admission' ? 1 : 0);
    if (end === 'stop') await fw.stop(1000);
    else if (end === 'router-stop') {
      const pending = inner.inferenceRouter.stopAll();
      await until(() => inner.inferenceRouter.running.size === 0);
      await Promise.all(pending.map((entry: any) => entry.promise));
    }
    else { socket.terminate(); await until(() => (providerSignal ?? hookSignal)!.aborted); }
    await until(() => inner.inferenceRouter.running.size === 0);
    assert.equal((providerSignal ?? hookSignal)!.aborted, true, 'request cancellation is immediate, not its deadline');
    assert.equal(connection.requiredAdmission.pending.size, 0, 'noncooperative callback holds no admission slot');
    assert.equal(attempts.length, end !== 'close' ? 1 : 0, 'closed transport receives no router answer attempt');
    if (end !== 'close') {
      assert.equal(attempts[0].method, 'sendErrorResponse');
      assert.deepEqual(attempts[0].args.slice(0, 3), [71, -32000, 'the host stopped while handling this request']);
      await until(() => replies.length === 1);
      assert.equal(replies[0].error.code, -32000);
    }
    release?.(store ? { store: true, mayWake: true } : { store: false, mayWake: false, reason: 'admission_denied' });
    await new Promise(r => setImmediate(r));
    assert.equal(attempts.length, end !== 'close' ? 1 : 0, 'late allow/refusal cannot answer twice');
    assert.equal(resolutions, phase === 'pending admission' ? 0 : 1);
    assert.equal(providerCalls, phase === 'pending admission' ? 0 : 1);
    assert.equal(membrane.calls.length, 0);
    if (end !== 'close' || phase === 'allowed provider call') {
      assert.equal(failures.length, 1, 'one failure trace, not one per listener');
      assert.equal(failures[0].model, phase === 'pending admission' ? null : 'test');
      assert.equal(failures[0].error, end === 'close'
        ? 'the transport the request came on closed'
        : 'the host stopped while handling this request');
    }
  });
}
