import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { openTransport, WebSocketTransport } from '../src/mcpl/transport.js';
import { serverConfigProblems } from '../src/mcpl/protocol-family.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

type Config = Omit<McplServerConfig, 'credentialRequired'> & { credentialRequired?: unknown };
const canary = () => `CANARY-${randomBytes(24).toString('hex')}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function mock(status?: number, location?: string) {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    requests.push(req);
    if (status) {
      socket.end(`HTTP/1.1 ${status} Refused\r\n${location ? `Location: ${location}\r\n` : ''}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    } else {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req);
        ws.on('message', data => {
          const m = JSON.parse(String(data));
          if (m.id === undefined) return;
          const result = m.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.4', pushEvents: true } } } }
            : { tools: [] };
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
        });
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcpl`;
  return { requests, wss, url, async close() {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(r => server.close(() => r()));
    wss.close();
  } };
}
function config(url: string, fields: Record<string, unknown> = {}): Config {
  return { id: 'strict-server', url, credentialRequired: true, tokenTransport: 'header', accessProvider: async () => canary(), ...fields } as Config;
}
async function rejected(c: Config, reason: string, signal?: AbortSignal) {
  let error: unknown;
  try { const t = await WebSocketTransport.open(c as McplServerConfig, signal); await t.close(); }
  catch (e) { error = e; }
  assert.ok(error instanceof Error, 'dial must reject');
  assert.equal(error.message, `MCPL server "strict-server": ${reason}`);
  assert.equal(error.constructor, Error);
  assert.equal('cause' in error, false);
  assert.deepEqual(Object.keys(error), []);
}

for (const [label, provided, reason] of [
  ['undefined', undefined, 'provider-failed'], ['null', null, 'provider-failed'], ['empty', '', 'provider-failed'],
  ['leading space', ' x', 'provider-failed'], ['trailing space', 'x ', 'provider-failed'],
  ['control', 'x\nx', 'provider-failed'], ['non-ASCII', 'xé', 'provider-failed'],
  ['number', 17, 'provider-failed'], ['object', {}, 'provider-failed'],
  ['uncoercible object', { toString() { throw new Error('must not coerce'); } }, 'provider-failed'],
] as const) test(`strict provider ${label} refuses with zero upgrades`, async () => {
  const s = await mock();
  try {
    await rejected(config(s.url, { accessProvider: async () => provided }), reason);
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('strict throwing provider never falls back or exposes its error', async () => {
  const s = await mock();
  try {
    await rejected(config(s.url, { accessProvider: async () => { throw new Error(canary(), { cause: canary() }); } }), 'provider-failed');
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

for (const provider of [undefined, null, 42]) test(`strict non-callable provider ${provider} refuses with zero upgrades`, async () => {
  const s = await mock();
  try { await rejected(config(s.url, { accessProvider: provider }), 'provider-failed'); assert.equal(s.requests.length, 0); }
  finally { await s.close(); }
});

test('strict server refusal is fixed-code, one authenticated attempt, no fallback', async () => {
  const s = await mock(401); const token = canary();
  try {
    await rejected(config(s.url, { accessProvider: async () => token }), 'credential-rejected');
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(s.requests[0].url, '/mcpl');
  } finally { await s.close(); }
});

for (const [label, fields] of [
  ['static token', { token: canary() }], ['empty static token', { token: '' }],
  ['query', { tokenTransport: 'query' }], ['omitted transport mode', { tokenTransport: undefined }],
  ['query token', { url: 'ws://127.0.0.1/mcpl?token=synthetic' }],
  ['fragment', { url: 'ws://127.0.0.1/mcpl#fragment' }],
  ['userinfo', { url: 'ws://synthetic:synthetic@127.0.0.1/mcpl' }],
  ['cleartext remote', { url: 'ws://192.0.2.1/mcpl' }],
  ['http', { url: 'http://127.0.0.1/mcp', tokenTransport: undefined }],
  ['https', { url: 'https://127.0.0.1/mcp', tokenTransport: undefined }],
  ['stdio', { url: undefined, command: 'never-spawn', tokenTransport: undefined }],
  ['modern', { url: undefined, command: 'never-spawn', protocol: 'modern', tokenTransport: undefined, accessProvider: undefined }],
] as const) test(`strict validation rejects ${label}`, () => {
  assert.ok(serverConfigProblems(config('ws://127.0.0.1/mcpl', fields) as McplServerConfig).length > 0);
});

for (const value of ['true', 'CANARY-invalid-flag', 1, 0, {}, []]) test(`flag validation rejects ${JSON.stringify(value)} without quoting it`, () => {
  const problems = serverConfigProblems(config('ws://127.0.0.1/mcpl', { credentialRequired: value }) as McplServerConfig);
  assert.ok(problems.length > 0);
  assert.ok(problems.some(p => p.includes('credentialRequired')));
  if (typeof value === 'string') assert.ok(!problems.join('').includes(value));
});

for (const fields of [{ token: '' }, { token: canary() }, { tokenTransport: 'query' }, { url: 'ws://192.0.2.1/mcpl' }, { url: 'ws://127.0.0.1/mcpl#fragment' }, { protocol: 'modern' }]) {
  test(`strict direct dial validates before provider (${Object.keys(fields)[0]} ${fields.token === '' ? 'empty' : 'set'})`, async () => {
    const s = await mock(); let calls = 0;
    try {
      await rejected(config(s.url, { accessProvider: async () => { calls++; return canary(); }, ...fields }), 'connection-failed');
      assert.equal(calls, 0); assert.equal(s.requests.length, 0);
    } finally { await s.close(); }
  });
}

for (const status of [301, 302, 303, 307, 308]) test(`strict ${status} redirect fails closed at original origin`, async () => {
  const second = await mock(); const first = await mock(status, second.url); const token = canary();
  try {
    await rejected(config(first.url, { accessProvider: async () => token }), 'connection-failed');
    await sleep(30);
    assert.equal(first.requests.length, 1);
    assert.equal(first.requests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(second.requests.length, 0);
  } finally { await first.close(); await second.close(); }
});

for (const field of ['url', 'tokenTransport', 'credentialRequired', 'token', 'accessProvider', 'id', 'command', 'transport', 'protocol']) {
  test(`strict snapshot holds ${field} while provider is pending`, async () => {
    const original = await mock(); const replacement = await mock(); const token = canary();
    let release!: (token: string) => void;
    const pending = new Promise<string>(r => { release = r; });
    const c = config(original.url, { accessProvider: function(this: Config) { assert.equal(this, c); return pending; } });
    const mutations: Record<string, unknown> = { url: replacement.url, tokenTransport: 'query', credentialRequired: false, token: canary(), accessProvider: async () => canary(), id: 'changed', command: 'never-spawn', transport: 'stdio', protocol: 'modern' };
    let transport: WebSocketTransport | undefined;
    try {
      const opened = WebSocketTransport.open(c as McplServerConfig);
      (c as unknown as Record<string, unknown>)[field] = mutations[field];
      release(token); transport = await opened;
      assert.equal(original.requests.length, 1); assert.equal(replacement.requests.length, 0);
      assert.equal(original.requests[0].headers.authorization, `Bearer ${token}`);
      assert.equal(original.requests[0].url, '/mcpl');
      assert.equal((transport as unknown as { serverId: string }).serverId, 'strict-server');
    } finally { release(token); await transport?.close(); await original.close(); await replacement.close(); }
  });
}

test('provider rotation on each header dial sends no query token', async () => {
  const s = await mock(); let token = canary();
  const c = config(s.url, { credentialRequired: undefined, accessProvider: async () => token });
  try {
    for (let i = 0; i < 2; i++) {
      const t = await WebSocketTransport.open(c as McplServerConfig); await t.close();
      assert.equal(s.requests[i].headers.authorization, `Bearer ${token}`); assert.equal(s.requests[i].url, '/mcpl');
      token = canary();
    }
  } finally { await s.close(); }
});

test('flag unset throwing provider falls back to static token', async () => {
  const s = await mock(); const token = canary();
  try {
    const c = config(s.url, { credentialRequired: undefined, token, accessProvider: async () => { throw new Error('synthetic'); } });
    const keys = Reflect.ownKeys(c); const t = await WebSocketTransport.open(c as McplServerConfig);
    assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`); assert.deepEqual(Reflect.ownKeys(c), keys);
    await t.close();
  } finally { await s.close(); }
});

test('abort during pending provider cannot create a late dial', async () => {
  const s = await mock(); const controller = new AbortController(); let release!: (s: string) => void;
  try {
    const p = WebSocketTransport.open(config(s.url, { accessProvider: () => new Promise<string>(r => { release = r; }) }) as McplServerConfig, controller.signal);
    controller.abort(); await assert.rejects(p);
    release(canary()); await sleep(30); assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('strict connection reconnect fetches a rotated credential', async () => {
  const s = await mock(); let token = canary(); let calls = 0; let conn: McplServerConnection | undefined;
  try {
    conn = await McplServerConnection.connect(config(s.url, { reconnect: true, reconnectIntervalMs: 40, accessProvider: async () => { calls++; return token; } }) as McplServerConfig,
      { version: '0.4', pushEvents: true, featureSets: true });
    assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`);
    conn.ready();
    token = canary(); for (const ws of s.wss.clients) ws.terminate();
    const deadline = Date.now() + 7000;
    while (s.requests.length < 2 && Date.now() < deadline) await sleep(20);
    assert.equal(s.requests.length, 2); assert.equal(calls, 2);
    assert.equal(s.requests[1].headers.authorization, `Bearer ${token}`); assert.equal(s.requests[1].url, '/mcpl');
  } finally { await conn?.close(); await s.close(); }
});

test('strict successful header dial stores no provider result on configuration', async () => {
  const s = await mock(); const token = canary(); const c = config(s.url, { accessProvider: async () => token });
  const before = Object.getOwnPropertyDescriptors(c); let t: WebSocketTransport | undefined;
  try {
    t = await WebSocketTransport.open(c as McplServerConfig);
    assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`); assert.equal(s.requests[0].url, '/mcpl');
    assert.deepEqual(Object.getOwnPropertyDescriptors(c), before);
    assert.ok(!JSON.stringify(c).includes(token));
  } finally { await t?.close(); await s.close(); }
});

test('strict captures all policy reads before the provider await', async () => {
  const s = await mock(); const token = canary(); let release!: (s: string) => void;
  const c = config(s.url, { accessProvider: () => new Promise<string>(r => { release = r; }) });
  let t: WebSocketTransport | undefined;
  try {
    const opened = WebSocketTransport.open(c as McplServerConfig);
    for (const field of ['id', 'url', 'tokenTransport', 'credentialRequired', 'token', 'accessProvider', 'command', 'transport', 'protocol']) {
      Object.defineProperty(c, field, { get() { throw new Error(`late ${field} read`); } });
    }
    release(token); t = await opened;
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`);
  } finally { release(token); await t?.close(); await s.close(); }
});

test('strict non-loopback hostname refuses before provider or DNS/connect', async () => {
  let called = false;
  await rejected(config('ws://never-resolve.invalid/mcpl', { accessProvider: async () => { called = true; return canary(); } }), 'connection-failed');
  assert.equal(called, false);
});


for (const [route, open] of [['openTransport', openTransport], ['WebSocketTransport.open', WebSocketTransport.open]] as const) {
  for (const flag of ['true', 1, 0, 'false', {}]) test(`${route} rejects mistyped flag ${JSON.stringify(flag)} before provider or upgrade`, async () => {
    const s = await mock(); let calls = 0;
    try {
      const c = config(s.url, { credentialRequired: flag, accessProvider: async () => { calls++; return canary(); } });
      let error: unknown;
      try { const t = await open(c as McplServerConfig); await t.close(); } catch (e) { error = e; }
      assert.equal(calls, 0); assert.equal(s.requests.length, 0);
      assert.ok(error instanceof Error);
      assert.match(error.message, /credentialRequired must be true or false/);
      assert.equal('cause' in error, false);
    } finally { await s.close(); }
  });
}

for (const protocol of ['legacy', 'modern'] as const) test(`strict direct dial refuses explicit protocol ${protocol} before provider or upgrade`, async () => {
  const s = await mock(); let calls = 0;
  try {
    await rejected(config(s.url, { protocol, accessProvider: async () => { calls++; return canary(); } }), 'connection-failed');
    assert.equal(calls, 0); assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('shared WebSocket admission refuses explicit legacy and modern protocol selectors', () => {
  for (const protocol of ['legacy', 'modern'] as const) {
    assert.ok(serverConfigProblems(config('ws://127.0.0.1/mcpl', { protocol }) as McplServerConfig).length > 0);
  }
});

for (const [label, fields] of [
  ['ambiguous command and URL', { command: process.execPath }],
  ['stdio transport without command', { transport: 'stdio' }],
] as const) test(`strict direct admission captures ${label}`, async () => {
  const s = await mock(); let calls = 0;
  try {
    // Direct WebSocket entry is intentional: openTransport's own binding
    // check must not mask a missing command/transport in the strict snapshot.
    await rejected(config(s.url, { ...fields, accessProvider: async () => { calls++; return canary(); } }), 'connection-failed');
    assert.equal(calls, 0); assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('reconnect refuses a newly mistyped flag before another provider call or upgrade', async () => {
  const s = await mock(); let calls = 0; let failed = false; let conn: McplServerConnection | undefined;
  const c = config(s.url, { credentialRequired: undefined, reconnect: true, reconnectIntervalMs: 40,
    accessProvider: async () => { calls++; return canary(); } });
  try {
    conn = await McplServerConnection.connect(c as McplServerConfig, { version: '0.4', pushEvents: true, featureSets: true });
    conn.ready(); conn.on('reconnect-failed', () => { failed = true; });
    Object.assign(c, { credentialRequired: 'true' });
    for (const ws of s.wss.clients) ws.terminate();
    const deadline = Date.now() + 7000;
    while (!failed && s.requests.length < 2 && Date.now() < deadline) await sleep(20);
    assert.equal(failed, true); assert.equal(calls, 1); assert.equal(s.requests.length, 1);
  } finally { await conn?.close(); await s.close(); }
});

for (const token of ['x', 'short-token', 'x'.repeat(31), 'x'.repeat(32)]) {
  test(`strict header credentials of length ${token.length} are sent unchanged`, async () => {
    const s = await mock();
    try {
      const t = await WebSocketTransport.open(config(s.url, { accessProvider: async () => token }) as McplServerConfig);
      await t.close();
      assert.equal(s.requests.length, 1);
      assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`);
      assert.equal(s.requests[0].url, '/mcpl');
    } finally { await s.close(); }
  });
}

for (const fields of [
  { url: undefined, command: 'never-spawn' },
  { url: 'https://127.0.0.1/mcp' },
  { url: undefined, command: 'never-spawn', protocol: 'modern' },
]) test(`strict transport factory refuses ${fields.protocol ?? fields.url ?? 'stdio'} before provider or launch`, async () => {
  let calls = 0;
  await assert.rejects(openTransport(config('ws://127.0.0.1/mcpl', {
    ...fields, accessProvider: async () => { calls++; return canary(); },
  }) as McplServerConfig), { message: 'MCPL server "strict-server": connection-failed' });
  assert.equal(calls, 0);
});

test('strict reconnect with an empty provider does not make an unauthenticated upgrade', async () => {
  const s = await mock();
  let calls = 0;
  let conn: McplServerConnection | undefined;
  try {
    conn = await McplServerConnection.connect(config(s.url, {
      reconnect: true, reconnectIntervalMs: 40,
      accessProvider: async () => ++calls === 1 ? 'short-token' : null,
    }) as McplServerConfig, { version: '0.4', pushEvents: true, featureSets: true });
    conn.ready();
    const failed = once(conn, 'reconnect-failed');
    for (const ws of s.wss.clients) ws.terminate();
    await failed;
    assert.equal(calls, 2);
    assert.equal(s.requests.length, 1);
  } finally { await conn?.close(); await s.close(); }
});
