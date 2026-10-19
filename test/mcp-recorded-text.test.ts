import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Transport } from '@modelcontextprotocol/client';
import { EventEmitter } from 'node:events';
import type { ModuleContext } from '../src/index.js';
import { AgentFramework } from '../src/framework.js';
import { McplProtocolVersionError, McplServerConnection } from '../src/mcpl/server-connection.js';
import { ModernMcpConnection, malformedLineDiagnostic } from '../src/mcpl/modern-connection.js';
import { noteDialSent, redactServerText, serverTextRedactor } from '../src/mcpl/protocol-family.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** Discovery succeeds; the inventory request gets a normal echoed-path 404. */
function echo404Server() {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (message.method === 'server/discover') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 60000, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'echo', version: '1' } } },
      }));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`Cannot POST ${req.url}`);
    }
  });
}

/** The SDK's pin-mode discovery rewrites an HTTP 404 into a version error.
 * Send tools/list through the real transport at the connect seam so this test
 * isolates how connection recordings handle an SDK error with the real body. */
function failConnectWithHttpBody(t: import('node:test').TestContext): void {
  t.mock.method(Client.prototype, 'connect', async (transport: Transport) => {
    await transport.start();
    try { await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); }
    finally { await transport.close(); }
  });
}

const secret = 'pathSecret0123456789';
const config = { id: 'remote', url: `https://h/api/mcp/s/${secret}/mcp`, token: 'staticToken012345' };

test('both framework engines scrub failure, error and stderr records before tracing and alerting', () => {
  for (const method of ['wireMcplEvents', 'wireModernEvents']) {
    const traces: unknown[] = [];
    const alerts: string[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.mcplServerConfigs = new Map([[config.id, config]]);
    framework.emitTrace = (event: unknown) => traces.push(event);
    framework.opsAlert = (_kind: string, _id: string, text: string) => alerts.push(text);
    // A permanent failure also refreshes the tool list.
    framework.handleToolsListChanged = () => {};
    const connection = Object.assign(new EventEmitter(), { id: config.id, willReconnect: true });
    framework[method](connection, config);
    connection.emit('connect-failed', { error: `Cannot POST ${secret}`, attempt: 0 });
    connection.emit('reconnect-failed', { error: `Cannot POST ${secret}`, attempt: 1, permanent: true });
    connection.emit('reconnect-failed', { error: `Cannot POST ${secret}`, attempt: 5 });
    connection.emit('error', new Error(`transport ${secret}`));
    connection.emit('stderr', { line: `server ${config.token}` });
    assert.equal(traces.length, 5);
    assert.equal(alerts.length, 2);
    assert.ok(!JSON.stringify(traces).includes(secret), method);
    assert.ok(!JSON.stringify(traces).includes(config.token), method);
    assert.ok(alerts.every(text => text.includes('Cannot POST redacted')), method);
  }
});

test("both engines' wiring redacts a stdio server's credential env value in its stderr records", () => {
  const stdio = { id: 'local', command: 'srv', env: { API_TOKEN: 'envToken0123456789', PATH: '/usr/local/bin' } };
  for (const method of ['wireMcplEvents', 'wireModernEvents']) {
    const traces: unknown[] = [];
    const framework = Object.create(AgentFramework.prototype) as any;
    framework.mcplServerConfigs = new Map([[stdio.id, stdio]]);
    framework.emitTrace = (event: unknown) => traces.push(event);
    framework.opsAlert = () => {};
    const connection = Object.assign(new EventEmitter(), { id: stdio.id, willReconnect: false });
    framework[method](connection, stdio);
    connection.emit('stderr', { line: 'auth with envToken0123456789 from /usr/local/bin' });
    assert.equal(traces.length, 1, method);
    assert.match(JSON.stringify(traces[0]), /auth with redacted from \/usr\/local\/bin/, method);
  }
});

test('an SDK HTTP 404 error keeps its path but hides the secret in connection console, traces and ops alerts', async (t) => {
  failConnectWithHttpBody(t);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-recorded-text-'));
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  const traces: Array<{ type: string; error?: string; message?: string; attempt?: number }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url: `http://127.0.0.1:${port}/api/mcp/s/${secret}/mcp`, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 }],
    });
    // The loop ends as soon as the record appears; the ceiling only bounds a hang.
    const deadline = Date.now() + 30_000;
    while (!traces.some(e => e.type === 'ops:alert') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const failed = traces.filter(e => e.type === 'mcpl:server-connect-failed');
    assert.ok(failed.some(e => e.attempt === 0));
    assert.ok(failed.some(e => (e.attempt ?? 0) >= 5));
    assert.ok(failed.every(e => e.error?.includes('Cannot POST /api/mcp/s/redacted/mcp')), JSON.stringify(failed));
    assert.ok(traces.some(e => e.type === 'ops:alert' && e.message?.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(consoleLines.some(line => line.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(!JSON.stringify(traces).includes(secret));
    assert.ok(!consoleLines.join('\n').includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test('startup records redact an echoed path while the direct host connect error stays as raised', async (t) => {
  failConnectWithHttpBody(t);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-startup-text-'));
  const consoleLines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => consoleLines.push(args.map(String).join(' ')));
  const traces: Array<{ type: string; error?: string }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/s/${secret}/mcp`;
  let framework: AgentFramework | undefined;
  try {
    await assert.rejects(ModernMcpConnection.connect({ id: 'raw', url }), error => {
      assert.ok(error instanceof Error && error.message.includes(secret));
      return true;
    });
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url }],
    });
    assert.ok(traces.some(e => e.type === 'mcpl:server-connect-failed' && e.error?.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(consoleLines.some(line => line.includes('Failed to connect MCPL server') && line.includes('Cannot POST /api/mcp/s/redacted/mcp')));
    assert.ok(!JSON.stringify(traces).includes(secret));
    assert.ok(!consoleLines.join('\n').includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});


test('legacy initial and reconnect console records redact known credentials', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  t.mock.method(McplServerConnection as any, 'handshake', async () => { throw new Error(`transport ${secret}`); });
  const legacyConfig = { id: 'legacy', url: `ws://127.0.0.1/s/${secret}`, reconnect: true, reconnectIntervalMs: 10, reconnectMaxIntervalMs: 20 };
  const capabilities = { version: '0.5', pushEvents: true };
  const connection = await McplServerConnection.connectWithReconnect(legacyConfig, capabilities);
  try {
    // The loop ends as soon as the record appears; the ceiling only bounds a hang.
    const deadline = Date.now() + 30_000;
    while (!lines.some(line => line.includes('reconnect failed:')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(lines.some(line => line.includes('initial connect failed, will retry: transport redacted')));
    assert.ok(lines.some(line => line.includes('reconnect failed: transport redacted')));
    assert.ok(!lines.join('\n').includes(secret));
  } finally { await connection.close(); }
});

test("a legacy initial connect that fails while its configuration can't be read still returns the stub that retries, and logs its failure withheld", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  t.mock.method(McplServerConnection as any, 'handshake', async () => { throw new Error(`transport ${secret}`); });
  const legacyConfig = { id: 'legacy', command: 'unused', reconnect: true, reconnectIntervalMs: 60_000, reconnectMaxIntervalMs: 60_000 };
  Object.defineProperty(legacyConfig, 'env', { enumerable: true, get() { throw new Error('the ledger cannot be read'); } });
  const connection = await McplServerConnection.connectWithReconnect(legacyConfig, { version: '0.5', pushEvents: true });
  try {
    assert.equal(connection.isConnected, false);
    assert.ok(
      lines.includes(`MCPL server "legacy" initial connect failed, will retry: [withheld: the server's configuration couldn't be read to redact this]`),
      lines.join('\n'),
    );
  } finally { await connection.close(); }
});

test("a real discover-then-tools/list 404 is redacted in the host's log line, and the framework's trace of it carries no credential", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  const dir = mkdtempSync(join(tmpdir(), 'mcp-list-text-'));
  const traces: Array<{ type: string; error?: string }> = [];
  const server = echo404Server();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/s/${secret}/mcp` }],
    });
    // The failed request is reported once: its status and the server's words
    // in the host's log line, redacted, and the listing's failure in the
    // framework's trace, in the agent's words (#556).
    assert.ok(lines.some(line => /^MCP server "echo" tools\/list failed with HTTP 404: .*Cannot POST \/api\/mcp\/s\/redacted\/mcp/.test(line)), lines.join('\n'));
    assert.deepEqual(traces.filter(e => e.type === 'mcpl:server-error').map(e => e.error), [
      'tools/list failed: The request to the "echo" server failed before an answer came back. Listing changes nothing on the server, so it\'s safe to try again.',
    ]);
    assert.ok(!JSON.stringify(traces).includes(secret));
    assert.ok(!lines.join('\n').includes(secret));
  } finally {
    await framework?.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool call's failure, from either engine, reaches its caller and its trace without the server's credentials", async () => {
  // A legacy MCPL server's call rejected with a close reason that quotes the
  // url; the modern engine's transport text is requestFailure's, tested over HTTP.
  const traces: Array<{ type: string; error?: string; stack?: string }> = [];
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map([[config.id, config]]);
  framework.emitTrace = (event: { type: string }) => traces.push(event);
  const server = { id: config.id, sendToolsCall: async () => { throw new Error(`socket closed: 1008 /api/mcp/s/${secret}/mcp`); } };
  framework.mcplServerRegistry = { getServer: (id: string) => (id === config.id ? server : null) };
  framework.modernServers = () => new Map();
  const result = await framework.executeMcplToolCall({ id: 'c1', name: 'mcpl--remote--echo', input: {} }, config.id, 'mcpl--remote');
  assert.equal(result.success, false);
  assert.match(String(result.error), /socket closed: 1008 \/api\/mcp\/s\/redacted\/mcp/);
  // A redactor for any server's text is made before an operation waits, so
  // a server removed meanwhile still has its credentials replaced.
  const other = { id: 'other', url: 'https://g/api/s/otherSecret0123456789/mcp' };
  framework.mcplServerConfigs = new Map([[config.id, config], [other.id, other]]);
  const everyServer = framework.everyServerRedactor();
  framework.mcplServerConfigs = new Map();
  assert.equal(everyServer(`closed ${secret} and otherSecret0123456789`), 'closed redacted and redacted');
  // A server connected after it was made is covered too.
  framework.mcplServerConfigs = new Map([['late', { id: 'late', url: 'https://k/api/s/lateSecret0123456789/mcp' }]]);
  assert.equal(everyServer('closed lateSecret0123456789'), 'closed redacted');
  // What a server's dial sent after the redactor was made is covered, though
  // the server has gone by the time the text is recorded.
  const dialing = { id: 'dialing', url: 'https://d/mcp' };
  framework.mcplServerConfigs = new Map([[dialing.id, dialing]]);
  const beforeDial = framework.everyServerRedactor();
  noteDialSent(dialing, { token: 'prov-late-0123456789' });
  framework.mcplServerConfigs = new Map();
  assert.equal(beforeDial('refused prov-late-0123456789'), 'refused redacted');
  // A value that can't be printed reads as a placeholder.
  assert.equal(everyServer(Object.create(null)), '[a value that cannot be printed]');
  // One pass over every server's strings: a secret that begins another
  // server's longer one doesn't cut that one short.
  framework.mcplServerConfigs = new Map([
    ['a', { id: 'a', token: 'ghp_SHAREDPREFIX123' }],
    ['b', { id: 'b', token: 'ghp_SHAREDPREFIX123_but_longer_TAIL9' }],
  ]);
  assert.equal(framework.everyServerRedactor()('auth failed for ghp_SHAREDPREFIX123_but_longer_TAIL9'), 'auth failed for redacted');
  // The same across the two sets it reads: the secret of a server present
  // when it was made begins the longer secret of a server connected since.
  framework.mcplServerConfigs = new Map([['a', { id: 'a', token: 'ghp_SHAREDPREFIX123' }]]);
  const across = framework.everyServerRedactor();
  framework.mcplServerConfigs = new Map([['b', { id: 'b', token: 'ghp_SHAREDPREFIX123_but_longer_TAIL9' }]]);
  assert.equal(across('auth failed for ghp_SHAREDPREFIX123_but_longer_TAIL9'), 'auth failed for redacted');
  framework.mcplServerConfigs = new Map([[config.id, config]]);

  // The model's dispatch: the tool:failed trace (message and stack) and the
  // result the model gets.
  const events: Array<{ type: string; result?: { error?: string } }> = [];
  framework.pushEvent = (event: { type: string }) => events.push(event);
  framework.toolLifecycleEmitter = null;
  const modern = { callTool: async () => { throw new Error(`HTTP 500 at /api/mcp/s/${secret}/mcp with ${config.token}`); } };
  framework.modernServers = () => new Map([[config.id, modern]]);
  framework.dispatchMcplToolCall('assistant', { id: 'c2', name: 'mcpl--remote--echo', input: {} }, config.id, 'mcpl--remote');
  // The server is disconnected while the call is in flight: its failure is
  // still recorded with the configuration it was dispatched under.
  framework.mcplServerConfigs.delete(config.id);
  const until = Date.now() + 30_000;
  while (!(traces.some((event) => event.type === 'tool:failed') && events.length > 0) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const failed = traces.find((event) => event.type === 'tool:failed');
  assert.ok(failed, 'the failure is traced');
  for (const text of [failed!.error, failed!.stack, events[0]?.result?.error]) {
    assert.ok(text && !text.includes(secret) && !text.includes(config.token), String(text));
  }
  assert.match(String(events[0]?.result?.error), /HTTP 500 at \/api\/mcp\/s\/redacted\/mcp with redacted/);
});

/** A framework with one server, whose configuration a host passed with an
 *  `env` getter that throws: the configuration its text is redacted with. */
function frameworkWithUnreadableConfig() {
  const unreadable = { id: 'remote' } as { id: string; env?: Record<string, string> };
  Object.defineProperty(unreadable, 'env', { enumerable: true, get() { throw new Error('the host cannot read it'); } });
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map<string, object>([[unreadable.id, unreadable]]);
  framework.emitTrace = () => {};
  return framework;
}

test("an in-process tool call that fails under a host's configuration that can't be read returns the withheld words as its error", async () => {
  // Where the redaction's throw rejected the caller's await.
  const framework = frameworkWithUnreadableConfig();
  const server = { id: 'remote', sendToolsCall: async () => { throw new Error('socket closed'); } };
  framework.mcplServerRegistry = { getServer: (id: string) => (id === 'remote' ? server : null) };
  framework.modernServers = () => new Map();
  const result = await framework.executeMcplToolCall({ id: 'c1', name: 'mcpl--remote--echo', input: {} }, 'remote', 'mcpl--remote');
  assert.deepEqual([result.success, result.error], [false, "[withheld: the server's configuration couldn't be read to redact this]"]);
});

test("a dispatched tool call that fails under a host's configuration that can't be read gets the withheld words as its result's error", async () => {
  // Where the failure handler threw and posted no result.
  const framework = frameworkWithUnreadableConfig();
  const events: Array<{ type: string; result?: { error?: string } }> = [];
  framework.pushEvent = (event: { type: string }) => events.push(event);
  framework.toolLifecycleEmitter = null;
  framework.modernServers = () => new Map([['remote', { callTool: async () => { throw new Error('HTTP 500'); } }]]);
  framework.dispatchMcplToolCall('assistant', { id: 'c2', name: 'mcpl--remote--echo', input: {} }, 'remote', 'mcpl--remote');
  const until = Date.now() + 5_000;
  while (events.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events[0]?.result?.error, "[withheld: the server's configuration couldn't be read to redact this]");
});

test("a redaction whose server's configuration can't be read withholds the text, and reads the configuration again next time", () => {
  // A stdio server's env is a getter that throws while the Discord awareness
  // ledger can't be read: such a configuration says nothing of what to take
  // out, and a redaction runs where a throw has nowhere to go.
  let readable = false;
  const unreadable = { id: 'unreadable' } as { id: string; env?: Record<string, string> };
  Object.defineProperty(unreadable, 'env', {
    enumerable: true,
    get() {
      if (!readable) throw new Error('the ledger cannot be read');
      return { API_TOKEN: 'envSecret0123456789' };
    },
  });
  const withheld = "[withheld: the server's configuration couldn't be read to redact this]";
  assert.equal(redactServerText('failed with envSecret0123456789', unreadable), withheld);
  // A url that can't be read withholds too, rather than reading as no url.
  const unreadableUrl = { id: 'unreadable-url' } as { id: string; url?: string };
  Object.defineProperty(unreadableUrl, 'url', { enumerable: true, get() { throw new Error('the url cannot be read'); } });
  assert.equal(redactServerText(`closed ${secret}`, unreadableUrl), withheld);
  // A connection's redactor reads it again at its next call.
  const recorded = serverTextRedactor(unreadable);
  assert.equal(recorded('failed with envSecret0123456789'), withheld);
  readable = true;
  assert.equal(recorded('failed with envSecret0123456789'), 'failed with redacted');
  // Text that may come from any server is withheld while one of them can't be
  // read, and redacted again once it can.
  readable = false;
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplServerConfigs = new Map<string, object>([[config.id, config], ['unreadable', unreadable]]);
  const everyServer = framework.everyServerRedactor();
  assert.equal(everyServer(`closed ${secret}`), withheld);
  readable = true;
  assert.equal(everyServer(`closed ${secret} envSecret0123456789`), 'closed redacted redacted');
});

test("a malformed line's diagnostic is redacted before it is cut, so no part of a credential across the cut is kept", () => {
  const envSecret = 'envSecretValue0123456789';
  const line = JSON.stringify({ note: `${'p'.repeat(185)} ${envSecret}` });
  // The credential starts this far into the line; a cut at 200 would keep
  // the first (200 - start) of its characters.
  const start = line.indexOf(envSecret);
  const kept = envSecret.slice(0, 200 - start);
  assert.ok(kept.length > 0 && kept.length < envSecret.length, `the cut falls inside the credential (${kept.length})`);
  const diagnostic = malformedLineDiagnostic({ id: 'stdio-env', command: 'srv', env: { API_TOKEN: envSecret } } as never, line, new Error('not a message'));
  assert.match(diagnostic, /sent a malformed JSON-RPC message/);
  assert.ok(!diagnostic.includes(kept), diagnostic);
  // The parser's own message can quote the line; it's redacted too.
  const quoting = malformedLineDiagnostic({ id: 'stdio-env', command: 'srv', env: { API_TOKEN: envSecret } } as never, '{}', new Error(`unexpected ${envSecret}`));
  assert.ok(!quoting.includes(envSecret), quoting);
  assert.match(diagnostic, / redac/, 'the replacement, cut where the line is cut');
});

test("the startup alert for a server with no common protocol revision carries the server's text without its credentials", async (t) => {
  // The version verdict quotes the SDK's error, which is server text.
  t.mock.method(ModernMcpConnection.prototype as never, 'open' as never, (async () => {
    throw new McplProtocolVersionError(`MCP server "echo" does not support MCP 2025-11-25 (refused at /api/mcp/s/${secret}/mcp).`, 'rejected', null, null);
  }) as never);
  const dir = mkdtempSync(join(tmpdir(), 'mcp-startup-alert-'));
  t.mock.method(console, 'error', () => {});
  const traces: Array<{ type: string; message?: string; error?: string }> = [];
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
      mcplServers: [{ id: 'echo', url: `https://127.0.0.1:9/api/mcp/s/${secret}/mcp` }],
    });
    const alert = traces.find(e => e.type === 'ops:alert');
    assert.ok(alert, JSON.stringify(traces.map(e => e.type)));
    assert.match(String(alert!.message), /MCPL server unreachable at startup: .*refused at \/api\/mcp\/s\/redacted\/mcp/);
    assert.ok(!JSON.stringify(traces).includes(secret));
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runtime connect's failed cleanup is traced without the server's credentials, and the host's error stays as raised", async (t) => {
  const prototype = ModernMcpConnection.prototype as unknown as { open(): Promise<void> };
  const open = t.mock.method(prototype, 'open', async () => {
    throw new Error('connect refused');
  });
  const close = t.mock.method(ModernMcpConnection.prototype, 'close', async () => {
    throw new Error(`reap failed for /api/mcp/s/${secret}/mcp`);
  });
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cleanup-trace-'));
  t.mock.method(console, 'error', () => {});
  const traces: Array<{ type: string; error?: string }> = [];
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
    });
    await assert.rejects(framework.connectMcplServer({ id: 'echo', url: `https://127.0.0.1:9/api/mcp/s/${secret}/mcp` }), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes(secret), 'the host gets the error as raised');
      return true;
    });
    const traced = traces.find(e => e.type === 'mcpl:server-error');
    assert.ok(traced, JSON.stringify(traces.map(e => e.type)));
    assert.match(String(traced!.error), /reap failed for \/api\/mcp\/s\/redacted\/mcp/);
    assert.ok(!JSON.stringify(traces).includes(secret));
  } finally {
    open.mock.restore();
    close.mock.restore();
    await framework?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

