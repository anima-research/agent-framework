/**
 * ApiServer host-verb admin gate + WebSocket origin policy (issue #122).
 * The framework is real (temp store, mock membrane); the server binds an
 * ephemeral port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { AgentFramework, ApiServer } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

async function withServer(
  config: ConstructorParameters<typeof ApiServer>[1],
  fn: (base: string, framework: AgentFramework) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'api-admin-gate-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const server = new ApiServer(framework, { port: 0, host: '127.0.0.1', ...config });
  await server.start();
  const port = (server as unknown as { httpServer: { address(): { port: number } } }).httpServer.address().port;
  try {
    await fn(`127.0.0.1:${port}`, framework);
  } finally {
    await server.stop();
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function wsOpens(url: string, headers?: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on('error', () => resolve(0));
  });
}

test('an empty adminToken is refused at construction', () => {
  // The refusal comes before the server uses its framework, so none is started.
  assert.throws(() => new ApiServer({} as AgentFramework, { adminToken: '' }), /non-empty/);
});

test('HTTP host verbs: header required without a token (CSRF), exact token with one', async () => {
  await withServer({}, async (base) => {
    const noHeader = await fetch(`http://${base}/quiesce`, { method: 'POST' });
    assert.equal(noHeader.status, 401, 'a simple POST is refused: no preflight-forcing header');
    const any = await fetch(`http://${base}/quiesce?reason=t`, { method: 'POST', headers: { 'x-admin-token': 'anything' } });
    assert.equal(any.status, 200);
    const body = await any.json() as { quiesced: boolean };
    assert.equal(body.quiesced, true);
    const mode = await fetch(`http://${base}/hostmode`);
    assert.equal(mode.status, 200, '/hostmode is open when no token is configured');
  });
  await withServer({ adminToken: 's3cret' }, async (base) => {
    const wrong = await fetch(`http://${base}/quiesce`, { method: 'POST', headers: { 'x-admin-token': 's3cre' } });
    assert.equal(wrong.status, 401);
    const modeNoToken = await fetch(`http://${base}/hostmode`);
    assert.equal(modeNoToken.status, 401, '/hostmode carries the operator reason — gated when a token exists');
    const right = await fetch(`http://${base}/quiesce`, { method: 'POST', headers: { 'x-admin-token': 's3cret' } });
    assert.equal(right.status, 200);
    const modeToken = await fetch(`http://${base}/hostmode`, { headers: { 'x-admin-token': 's3cret' } });
    assert.equal(modeToken.status, 200);
  });
});

test('WS upgrade: foreign browser origins are rejected; same-host, allow-listed and non-browser clients pass', async () => {
  await withServer({ allowedOrigins: ['https://ops.example.test'] }, async (base) => {
    const url = `ws://${base}/ws`;
    assert.equal(await wsOpens(url), 'open', 'no Origin (non-browser client)');
    assert.equal(await wsOpens(url, { origin: `http://${base}` }), 'open', 'same host');
    assert.equal(await wsOpens(url, { origin: 'https://ops.example.test' }), 'open', 'allow-listed');
    assert.equal(await wsOpens(url, { origin: 'http://evil.example' }), 403, 'a visited web page');
    assert.equal(await wsOpens(url, { origin: 'null' }), 403, 'opaque origin');
  });
});

test('WS host.* verbs require the token when one is configured', async () => {
  await withServer({ adminToken: 's3cret' }, async (base) => {
    const ws = new WebSocket(`ws://${base}/ws`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    const send = (command: string, params: Record<string, unknown>): Promise<{ success: boolean; error?: string; data?: unknown }> =>
      new Promise((resolve) => {
        const id = `${command}-${Math.random()}`;
        const onMsg = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(raw.toString()) as { type: string; id?: string; success: boolean; error?: string; data?: unknown };
          if (msg.type === 'response' && msg.id === id) { ws.off('message', onMsg); resolve(msg); }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ type: 'request', id, command, params }));
      });
    const denied = await send('host.quiesce', {});
    assert.equal(denied.success, false);
    assert.match(denied.error ?? '', /adminToken/);
    const allowed = await send('host.quiesce', { adminToken: 's3cret', reason: 'ws' });
    assert.equal(allowed.success, true);
    const status = await send('host.status', {});
    assert.equal((status.data as { quiesced: boolean }).quiesced, true);
    ws.close();
  });
});
