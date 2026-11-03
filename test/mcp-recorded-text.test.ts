import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, UnsupportedProtocolVersionError, type Transport } from '@modelcontextprotocol/client';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import type { ModuleContext } from '../src/index.js';
import { AgentFramework } from '../src/framework.js';
import { McplProtocolVersionError, McplRequestError, McplServerConnection, McplUnreapedLaunchError } from '../src/mcpl/server-connection.js';
import { ModernMcpConnection, malformedLineDiagnostic } from '../src/mcpl/modern-connection.js';
import { STDERR_TAIL_CHARS, STDERR_WINDOW_CHARS } from '../src/mcpl/transport.js';
import { TOO_DEEP_TEXT, WITHHELD_TEXT, maskedError, noteDialSent, redactServerText, redactedData, serverTextRedactor } from '../src/mcpl/protocol-family.js';
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


test('startup records and the direct host connect error both redact an echoed path', async (t) => {
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
    await assert.rejects(ModernMcpConnection.connect({ id: 'raw', url }), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes('Cannot POST /api/mcp/s/redacted/mcp'), String(error));
      assert.ok(!error.message.includes(secret), error.message);
      assert.equal(error.cause, undefined, 'the raw error is not kept as its cause');
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
    assert.match(String(alert!.message), /MCPL server not connected at startup, and this host won't retry it on its own: .*refused at \/api\/mcp\/s\/redacted\/mcp/);
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


// A stdio MCPL server whose words quote its own credential, an env value
// whose name says it's one: in its initialize error (MODE init-error), its
// refusal of the protocol revision with that in its data too
// (version-error), the revision it answers with (mismatch), its tools/call
// error with that in its data too (tool-error), or a tools/call error sent
// after the call's deadline (late-error). PAD characters come first, so the
// credential can straddle the 200 code points a server's words are cut to.
const QUOTING_SERVER = String.raw`
let buf = '';
let held = null;
const mode = process.env.MODE;
const token = process.env.API_TOKEN;
const said = 'x'.repeat(Number(process.env.PAD || 0)) + token + (process.env.TAIL ?? ' and more words');
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || !m.method) continue;
    const send = (o, id = m.id) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id }, o)) + '\n');
    if (m.method === 'initialize') {
      if (mode === 'init-error') send({ error: { code: -32603, message: said } });
      else if (mode === 'version-error') send({ error: { code: -32022, message: said, data: { echoed: token } } });
      else if (mode === 'version-list') send({ error: { code: -32022, message: said, data: { supported: ['2024-10-07', token, ...Array.from({ length: 30 }, (_, n) => 'v' + String(n).padStart(10, '0'))] } } });
      else if (mode === 'stderr-exit') {
        // The token between BEFORE a's and AFTER b's, each side joined by
        // SEP, then the child exits before it answers.
        const sep = process.env.SEP ?? '';
        process.stderr.write('a'.repeat(Number(process.env.BEFORE)) + sep + token + sep + 'b'.repeat(Number(process.env.AFTER)) + '\n', () => process.exit(1));
      }
      else if (mode === 'exit-quiet') process.exit(1);
      else if (mode === 'stderr-keys') {
        // The token, then COPIES lines of the private key, then a line of
        // FILLER f's, then the child exits before it answers.
        process.stderr.write(token + ('\n' + process.env.PRIVATE_KEY).repeat(Number(process.env.COPIES)) + '\n' + 'f'.repeat(Number(process.env.FILLER)) + '\n', () => process.exit(1));
      }
      else send({ result: { protocolVersion: mode === 'mismatch' ? said : '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } } });
    } else if (m.method === 'tools/list') {
      // cursor-repeat answers every page with the same cursor, its words;
      // cursor-object with a cursor that isn't a string.
      const nextCursor = mode === 'cursor-repeat' ? said : mode === 'cursor-object' ? { quoted: said } : undefined;
      send({ result: { tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object' } }], ...(nextCursor === undefined ? {} : { nextCursor }) } });
    }
    else if (m.method === 'tools/call') {
      // code-quote's error answer has its token for a code, which JSON-RPC
      // says is a number.
      const answer = { error: { code: mode === 'code-quote' ? token : -32000, message: said, data: { echoed: token } } };
      // late-error holds its first call's answer until the next call comes,
      // and sends it first then, after the first call's deadline.
      if (mode === 'late-error' && held === null) held = m.id;
      else {
        if (held !== null) { send(answer, held); held = -1; }
        send(answer);
      }
    } else send({ result: {} });
  }
});
`;

/** The quoting server's credential: one cut at the 200th code point, one
 *  holding a TAB, and one that ends in a space and ends the server's words. */
const QUOTED: Array<{ kind: string; token: string; pad: number; kept: string; tail?: string }> = [
  { kind: 'across the cut', token: 'Kq7vR2mXp9LwT4sB8nYd', pad: 185, kept: 'Kq7vR2mXp9' },
  { kind: 'holding a TAB', token: 'Kq7vR2mXp9\tLwT4sB8nYd', pad: 10, kept: 'Kq7vR2mXp9' },
  { kind: 'ending in a space at the end of the words', token: 'Kq7vR2mXp9LwT4sB8nYd ', pad: 10, kept: 'Kq7vR2mXp9', tail: '' },
];

/** The quoting server's environment for a mode and a credential. */
const quotingEnv = (mode: string, quoted: typeof QUOTED[number]) => ({
  API_TOKEN: quoted.token, MODE: mode, PAD: String(quoted.pad), ...(quoted.tail === undefined ? {} : { TAIL: quoted.tail }),
});

async function frameworkWithQuotingServer(dir: string, mode: string, quoted: typeof QUOTED[number], traces: Array<Record<string, unknown>>) {
  return AgentFramework.create({
    storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
    modules: [{ name: 'watcher', async start(ctx: ModuleContext) { ctx.onTrace(event => traces.push(event as never)); }, async stop() {}, getTools: () => [], async handleToolCall() { return { success: false }; }, async onProcess() { return {}; } }],
    mcplServers: [{ id: 'probe', command: process.execPath, args: ['-e', QUOTING_SERVER], env: quotingEnv(mode, quoted) }],
  });
}

for (const quoted of QUOTED) {
  test(`an initialize error that quotes a credential ${quoted.kind} is recorded without any of it`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-quoted-init-'));
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
    const traces: Array<Record<string, unknown>> = [];
    let framework: AgentFramework | undefined;
    try {
      framework = await frameworkWithQuotingServer(dir, 'init-error', quoted, traces);
      const failed = traces.find(e => e.type === 'mcpl:server-connect-failed');
      assert.ok(failed, JSON.stringify(traces.map(e => e.type)));
      assert.match(String(failed!.error), /initialize error: x/);
      assert.ok(!JSON.stringify(traces).includes(quoted.kept), JSON.stringify(failed));
      assert.ok(!lines.join('\n').includes(quoted.kept), lines.join('\n'));
    } finally {
      await framework?.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a tool call's error that quotes a credential ${quoted.kind} reaches its caller without any of it`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-quoted-call-'));
    t.mock.method(console, 'error', () => {});
    const traces: Array<Record<string, unknown>> = [];
    let framework: AgentFramework | undefined;
    try {
      framework = await frameworkWithQuotingServer(dir, 'tool-error', quoted, traces);
      const result = await framework.executeToolCall({ id: 'c1', name: 'mcpl--probe--x', input: {} });
      assert.equal(result.success, false);
      assert.match(String(result.error), /answered with an error: x/);
      assert.ok(!String(result.error).includes(quoted.kept), String(result.error));
    } finally {
      await framework?.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a late tools/call error's record is redacted, then bounded, like an on-time one's", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-quoted-late-'));
  t.mock.method(console, 'error', () => {});
  const traces: Array<Record<string, unknown>> = [];
  // The record is `[-32000] ` and the words, cut to 500 code points: the
  // padding puts the credential across the cut.
  const quoted = { kind: "across the record's cut", token: 'Kq7vR2mXp9LwT4sB8nYd', pad: 481, kept: 'Kq7vR2mXp9' };
  let framework: AgentFramework | undefined;
  try {
    framework = await frameworkWithQuotingServer(dir, 'late-error', quoted, traces);
    const server = (framework as unknown as { mcplServerRegistry: { getServer(id: string): McplServerConnection } })
      .mcplServerRegistry.getServer('probe');
    await assert.rejects(server.sendToolsCallWithDeadline('x', {}, 100), /didn't answer within/);
    // The server answers the first call only when a second one comes, so
    // its answer comes after the first call's deadline.
    await assert.rejects(server.sendToolsCall('x', {}), /answered with an error/);
    const deadline = Date.now() + 5_000;
    while (!traces.some(e => e.type === 'mcpl:orphaned-response')) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the late answer\'s record');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const late = traces.find(e => e.type === 'mcpl:orphaned-response')!;
    assert.match(String(late.error), /\[-32000\] x/);
    assert.ok(!JSON.stringify(late).includes(quoted.kept), JSON.stringify(late));
  } finally {
    await framework?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The quoting server's configuration, for a connection made without the framework. */
const quotingServer = (mode: string, quoted: typeof QUOTED[number]) => ({
  id: 'probe', command: process.execPath, args: ['-e', QUOTING_SERVER], env: quotingEnv(mode, quoted),
});

for (const quoted of QUOTED) {
  test(`a legacy connect's error carries none of a credential ${quoted.kind} its server's initialize error quotes`, async () => {
    await assert.rejects(McplServerConnection.connect(quotingServer('init-error', quoted), { version: '0.5' }), (error: Error) => {
      assert.match(error.message, /initialize error: x/);
      assert.ok(!error.message.includes(quoted.kept), error.message);
      return true;
    });
  });

  test(`a legacy tool call's error carries none of a credential ${quoted.kind} its server's words or data quote`, async () => {
    const connection = await McplServerConnection.connect(quotingServer('tool-error', quoted), { version: '0.5' });
    try {
      connection.ready();
      await assert.rejects(connection.sendToolsCall('x', {}), (error: unknown) => {
        assert.ok(error instanceof McplRequestError);
        assert.match(error.message, /answered with an error: x/);
        assert.ok(!error.message.includes(quoted.kept), error.message);
        assert.ok(!JSON.stringify(error.data).includes(quoted.kept), JSON.stringify(error.data));
        return true;
      });
    } finally {
      await connection.close();
    }
  });
}

test("a legacy connect's refusal of the protocol revision carries none of a credential its server's words, data or revision quote", async () => {
  const quoted = QUOTED[0];
  await assert.rejects(McplServerConnection.connect(quotingServer('version-error', quoted), { version: '0.5' }), (error: unknown) => {
    assert.ok(error instanceof McplProtocolVersionError);
    assert.equal(error.kind, 'rejected');
    assert.ok(!error.message.includes(quoted.kept), error.message);
    assert.ok(!JSON.stringify(error.data).includes(quoted.kept), JSON.stringify(error.data));
    return true;
  });
  // A long list of revisions, one quoting the credential: redacted, then bounded.
  await assert.rejects(McplServerConnection.connect(quotingServer('version-list', quoted), { version: '0.5' }), (error: unknown) => {
    assert.ok(error instanceof McplProtocolVersionError);
    assert.match(error.message, /\(it supports: 2024-10-07, redacted, v0000000000, [^)]*…\)/);
    assert.equal(error.supported?.length, 32);
    assert.equal(error.supported?.[1], 'redacted');
    return true;
  });
  // A long revision quoting the credential: redacted, then bounded.
  await assert.rejects(McplServerConnection.connect(quotingServer('mismatch', quoted), { version: '0.5' }), (error: unknown) => {
    assert.ok(error instanceof McplProtocolVersionError);
    assert.equal(error.kind, 'mismatch');
    assert.match(error.message, /protocolVersion "x+redacted and [^;]*…; this client's legacy engine/);
    assert.ok(!error.message.includes(quoted.kept), error.message);
    assert.ok(!String(error.returned).includes(quoted.kept), String(error.returned));
    return true;
  });
});

test("a modern connect's failure carries the library's words redacted, and none of what else its error carries", async (t) => {
  const url = `https://127.0.0.1:9/api/mcp/s/${secret}/mcp`;
  t.mock.method(console, 'error', () => {});
  // As a fetch fails on Bun: a TypeError with the url in its own `path`.
  const bun = t.mock.method(Client.prototype, 'connect', async () => {
    throw Object.assign(new TypeError('ECONNREFUSED: Unable to connect. Is the computer able to access the url?'), { path: url, code: 'ECONNREFUSED' });
  });
  await assert.rejects(ModernMcpConnection.connect({ id: 'raw', url }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?');
    assert.equal((error as { path?: unknown }).path, undefined);
    assert.equal((error as { code?: unknown }).code, undefined);
    return true;
  });
  bun.mock.restore();
  // Under a wrapper that quotes the url and keeps the raw error as its cause.
  t.mock.method(Client.prototype, 'connect', async () => {
    const raw = Object.assign(new Error(`Unable to connect: ${url}`), { path: url, code: 'ConnectionRefused' });
    throw new Error(`fetch failed for ${url}`, { cause: raw });
  });
  await assert.rejects(ModernMcpConnection.connect({ id: 'raw', url }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'fetch failed for https://127.0.0.1:9/api/mcp/s/redacted/mcp');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("a modern refusal of the protocol revision carries none of a credential the server's words or data quote", () => {
  const refusal = new UnsupportedProtocolVersionError({ supported: ['2024-11-05'], requested: '2026-07-28' });
  // A server's own words and data, quoting the url's path credential.
  Object.defineProperty(refusal, 'message', { value: `not at /api/mcp/s/${secret}/mcp` });
  Object.defineProperty(refusal, 'data', { value: { supported: `none for ${secret}`, echoed: secret } });
  const connection = ModernMcpConnection.create({ id: 'remote', url: `https://h/api/mcp/s/${secret}/mcp` }) as unknown as {
    versionVerdict(error: unknown): McplProtocolVersionError | null;
  };
  const verdict = connection.versionVerdict(refusal)!;
  assert.ok(verdict instanceof McplProtocolVersionError);
  assert.match(verdict.message, /\(not at \/api\/mcp\/s\/redacted\/mcp\)/);
  assert.ok(!verdict.message.includes(secret), verdict.message);
  assert.ok(!JSON.stringify(verdict.data).includes(secret), JSON.stringify(verdict.data));
  // A long list of the revisions it supports, one of them quoting the
  // credential: redacted, then bounded.
  const others = Array.from({ length: 30 }, (_, n) => 'v' + String(n).padStart(10, '0'));
  const listed = new UnsupportedProtocolVersionError({ supported: ['2024-11-05', secret, ...others], requested: '2026-07-28' });
  const listedVerdict = connection.versionVerdict(listed)!;
  assert.match(listedVerdict.message, /\(it supports: 2024-11-05, redacted, v0000000000, [^)]*…\)/);
  assert.deepEqual(listedVerdict.supported, ['2024-11-05', 'redacted', ...others]);
});

test("an error answer whose code quotes a credential is logged without it, by either engine", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  const quoted = QUOTED[0];
  const connection = await McplServerConnection.connect(quotingServer('code-quote', quoted), { version: '0.5' });
  try {
    connection.ready();
    await assert.rejects(connection.sendToolsCall('x', {}), /answered with an error/);
  } finally {
    await connection.close();
  }
  const modern = ModernMcpConnection.create({ id: 'remote', url: 'https://h/mcp', token: quoted.token }) as unknown as {
    requestFailure(what: string, record: unknown, error: unknown): Error;
  };
  modern.requestFailure('tools/call', { method: 'tools/call', handedOff: true, answer: 'error', error: { code: quoted.token, message: 'refused' }, continued: false }, new Error('answered'));
  const logged = lines.filter((line) => /with error /.test(line));
  assert.equal(logged.length, 2, lines.join('\n'));
  assert.ok(!logged.join('\n').includes(quoted.kept), logged.join('\n'));
});

for (const quoted of QUOTED) {
  test(`a legacy tools/list's cursor errors carry none of a credential ${quoted.kind} the server's cursor quotes`, async () => {
    for (const mode of ['cursor-repeat', 'cursor-object']) {
      const connection = await McplServerConnection.connect(quotingServer(mode, quoted), { version: '0.5' });
      try {
        connection.ready();
        await assert.rejects(connection.sendToolsList(), (error: Error) => {
          assert.match(error.message, mode === 'cursor-repeat' ? /repeated tools\/list cursor "x+redacted/ : /nextCursor must be a string, got \{"quoted":"x+red/);
          assert.ok(!error.message.includes(quoted.kept), error.message);
          // The cursor is cut to 200 code points after it's redacted.
          if (quoted.pad > 100) assert.match(error.message, /…$/);
          return true;
        });
      } finally {
        await connection.close();
      }
    }
  });
}

for (const quoted of QUOTED) {
  test(`a modern error answer's words, quoting a credential ${quoted.kind}, reach the caller without any of it`, (t) => {
    t.mock.method(console, 'error', () => {});
    const connection = ModernMcpConnection.create({ id: 'remote', url: 'https://h/mcp', token: quoted.token }) as unknown as {
      requestFailure(what: string, record: unknown, error: unknown): Error;
    };
    const words = 'x'.repeat(quoted.pad) + quoted.token + (quoted.tail ?? ' and more words');
    const record = { method: 'tools/call', handedOff: true, answer: 'error', error: { code: -32000, message: words, data: { echoed: quoted.token } }, continued: false };
    const error = connection.requestFailure('tools/call', record, new Error('answered with an error'));
    assert.ok(error instanceof McplRequestError);
    assert.match(error.message, /answered with an error: x/);
    assert.ok(!error.message.includes(quoted.kept), error.message);
    assert.ok(!JSON.stringify(error.data).includes(quoted.kept), JSON.stringify(error.data));
  });
}

test("a failed legacy handshake's stderr tail goes to the host redacted, the credential whole when it's matched though the tail's cut splits it", async () => {
  const failing = (token: string, layout: Record<string, string>) =>
    McplServerConnection.connect({ ...quotingServer('stderr-exit', { kind: 'tail', token, pad: 0, kept: '' }), env: { API_TOKEN: token, MODE: 'stderr-exit', ...layout } }, { version: '0.5' });
  // A token on one line with no newline, the tail's cut 9 characters from its end.
  const token = 'Kq7vR2mXp9LwT4sB8nYd';
  const after = STDERR_TAIL_CHARS - 9 - 1;
  await assert.rejects(failing(token, { BEFORE: '3000', AFTER: String(after) }), (error: Error & { stderrTail?: string }) => {
    // The token is whole when it's matched, so the tail holds it redacted.
    assert.equal(error.stderrTail, `\u2026redacted${'b'.repeat(after)}`);
    return true;
  });
  // A credential longer than the tail, PEM-like lines about the size of a
  // 4,096-bit private key's, its start well before the tail's cut and its
  // end inside the tail.
  const pem = Array.from({ length: 80 }, (_, n) => `MIIJQwIBADANBgkqhkiG9w0BAQEFAASCCS0wggkpAgEAAo${String(n).padStart(4, '0')}`).join('\n');
  assert.ok(pem.length > STDERR_TAIL_CHARS);
  await assert.rejects(failing(pem, { BEFORE: '100', SEP: '\n', AFTER: '1000' }), (error: Error & { stderrTail?: string }) => {
    assert.equal(error.stderrTail, `\u2026redacted\n${'b'.repeat(1000)}`);
    return true;
  });
  // The tail begins where the raw tail does, however much the redaction
  // shortens the window. Here the window's own cut falls 5 characters into
  // the token, and the 16 lines of a 1,000-character key after it redact to
  // 9 characters each, so the redacted window is shorter than the tail. The
  // tail begins inside the 15th key, which it replaces whole, and keeps
  // none of the token the window's cut split.
  const key = 'k'.repeat(1000);
  // The stream is the token, 16 times a newline and the key, a newline, the
  // filler and a newline: 5 characters more than the window.
  const filler = STDERR_WINDOW_CHARS + 5 - token.length - 16 * (1 + key.length) - 2;
  await assert.rejects(McplServerConnection.connect({ ...quotingServer('stderr-keys', { kind: 'keys', token, pad: 0, kept: '' }), env: { API_TOKEN: token, PRIVATE_KEY: key, MODE: 'stderr-keys', COPIES: '16', FILLER: String(filler) } }, { version: '0.5' }), (error: Error & { stderrTail?: string }) => {
    assert.equal(error.stderrTail, `\u2026redacted\nredacted\n${'f'.repeat(filler)}`);
    return true;
  });
});

test("a launch that wrote nothing to stderr has no stderr tail, even while its configuration can't be read", async () => {
  let readable = true;
  const launched = quotingServer('exit-quiet', QUOTED[0]);
  const config = Object.defineProperty({ ...launched }, 'env', {
    enumerable: true,
    configurable: true,
    get() { if (!readable) throw new Error('the ledger cannot be read'); return launched.env; },
  });
  // The launch reads the configuration as connect() starts, and it turns
  // unreadable after that, before the handshake fails.
  const connecting = McplServerConnection.connect(config, { version: '0.5' });
  readable = false;
  await assert.rejects(connecting, (error: Error & { stderrTail?: string }) => {
    assert.match(error.message, /transport closed before handshake completed/);
    assert.equal(error.stderrTail, undefined);
    return true;
  });
});

test("a stdio server that can't be started is refused without its command line, which can repeat a credential, and with its code", async () => {
  const token = 'envSecret0123456789';
  // The command's path and an argument both repeat the credential.
  const missing = (at: string) => `/nonexistent/${at}/mcpl-server-that-is-not-here`;
  await assert.rejects(McplServerConnection.connect({ id: 'missing', command: missing(token), args: ['--token', token], env: { API_TOKEN: token } }, { version: '0.5' }), (error: Error) => {
    assert.equal(error.message, `MCPL server "missing" could not be started: spawn ${missing('redacted')} ENOENT`);
    const cause = error.cause as NodeJS.ErrnoException & { spawnargs?: unknown };
    assert.equal(cause.message, `spawn ${missing('redacted')} ENOENT`);
    assert.equal(cause.code, 'ENOENT');
    for (const kept of ['spawnargs', 'path', 'syscall', 'errno']) assert.equal((cause as unknown as Record<string, unknown>)[kept], undefined, kept);
    assert.ok(!inspect(error, { depth: 5, showHidden: true }).includes(token), inspect(error, { depth: 5 }));
    return true;
  });
  // A failure Node reports on a tick after keeps its words whole, redacted,
  // even where they hold " Received": they quote the command, not a value
  // Node refused.
  const received = '/nonexistent/x Received y/mcpl-server-that-is-not-here';
  await assert.rejects(McplServerConnection.connect({ id: 'received', command: received, env: { API_TOKEN: token } }, { version: '0.5' }), (error: Error) => {
    assert.equal(error.message, `MCPL server "received" could not be started: spawn ${received} ENOENT`);
    return true;
  });
  // An argument or an env value Node refuses at spawn() itself, before any
  // 'error': Node quotes it after " Received", cut to 128 characters, here
  // across the credential, so its words stop before the quote.
  const refusals = [
    { id: 'refused-arg', args: [`--t=${'a'.repeat(110)}${token}\u0000`], env: { API_TOKEN: token }, said: "The argument 'args[0]' must be a string without null bytes." },
    { id: 'refused-env', args: [], env: { API_TOKEN: `${token}\u0000` }, said: "The property 'options.env['API_TOKEN']' must be a string without null bytes." },
  ];
  for (const { id, args, env, said } of refusals) {
    await assert.rejects(McplServerConnection.connect({ id, command: process.execPath, args, env }, { version: '0.5' }), (error: Error) => {
      assert.equal(error.message, `MCPL server "${id}" could not be started: ${said}`);
      const cause = error.cause as NodeJS.ErrnoException;
      assert.equal(cause.message, said);
      assert.equal(cause.name, 'TypeError');
      assert.equal(cause.code, 'ERR_INVALID_ARG_VALUE');
      assert.ok(!inspect(error, { depth: 5, showHidden: true }).includes(token.slice(0, 8)), inspect(error, { depth: 5 }));
      return true;
    });
  }
});

test("a redaction from a place in the text gives what lies from there on, a credential that reaches across it replaced whole", () => {
  const redact = serverTextRedactor(config);
  const text = `aaa ${secret} bbb`;
  assert.equal(redact(text, 0), 'aaa redacted bbb');
  assert.equal(redact(text, 2), 'a redacted bbb');
  // From inside the credential: matched in the whole text, replaced whole.
  assert.equal(redact(text, 4 + 5), 'redacted bbb');
  // From where it ends: none of it.
  assert.equal(redact(text, 4 + secret.length), ' bbb');
  // From past it: only what lies there, and from the text's end, nothing.
  assert.equal(redact(text, 4 + secret.length + 1), 'bbb');
  assert.equal(redact(text, text.length), '');
  assert.equal(redact(text, text.length + 5), '');
  // Two credentials that overlap are one place, replaced whole from inside either.
  const overlapping = serverTextRedactor({ url: 'https://h/mcp', token: 'abcdefgh12', env: { API_KEY: 'gh12ijklmn' } });
  assert.equal(overlapping('xx abcdefgh12ijklmn yy', 0), 'xx redacted yy');
  assert.equal(overlapping('xx abcdefgh12ijklmn yy', 14), 'redacted yy');
  // The same through one build, and with nothing to replace.
  assert.equal(redact.now()(text, 4 + 5), 'redacted bbb');
  assert.equal(serverTextRedactor({})(text, 4), `${secret} bbb`);
});

test("an error answer's data is redacted through and through: its keys, keeping every entry, its numbers, and plain objects, to a depth past which it's withheld", () => {
  const redact = serverTextRedactor(config);
  // Keys that redact alike are numbered, each entry kept under a name of its
  // own; the doc leaves the number's form to the code, so the names are
  // checked for being distinct and free of credentials.
  const besides = (data: unknown, ...names: string[]) =>
    Object.entries(data as Record<string, unknown>).filter(([key]) => !names.includes(key));
  const free = (key: string) => !key.includes(secret) && !key.includes(config.token);
  const both = redactedData({ [secret]: [secret, { deep: `at ${secret}` }], [config.token]: 'kept', count: 2, none: null }, redact) as Record<string, unknown>;
  assert.deepEqual([both.count, both.none], [2, null]);
  const alike = besides(both, 'count', 'none');
  assert.equal(alike.length, 2, `each redacted key keeps its entry: ${JSON.stringify(both)}`);
  assert.ok(alike.every(([key]) => free(key)), JSON.stringify(both));
  assert.deepEqual(alike.find(([, value]) => Array.isArray(value))?.[1], ['redacted', { deep: 'at redacted' }]);
  assert.ok(alike.some(([, value]) => value === 'kept'), JSON.stringify(both));
  // A key of the server's own that reads `redacted` keeps its name.
  const own = redactedData({ [secret]: 'diagnostic', redacted: false }, redact) as Record<string, unknown>;
  assert.equal(own.redacted, false);
  const moved = besides(own, 'redacted');
  assert.equal(moved.length, 1, JSON.stringify(own));
  assert.ok(free(moved[0]![0]) && moved[0]![1] === 'diagnostic', JSON.stringify(own));
  // A number whose digits are a credential.
  assert.deepEqual(redactedData({ pin: 9876543210123, count: 2 }, serverTextRedactor({ url: 'https://h/mcp', token: '9876543210123' })), { pin: 'redacted', count: 2 });
  // An object with no prototype is walked; an instance of a class is not.
  assert.deepEqual(redactedData(Object.assign(Object.create(null), { said: secret }), redact), { said: 'redacted' });
  class Opaque { constructor(readonly said: string) {} }
  const opaque = new Opaque(secret);
  assert.equal(redactedData(opaque, redact), opaque);
  // 64 levels of arrays or objects are walked; the 65th is withheld.
  const inArrays = (levels: number, inner: unknown): unknown => (levels === 0 ? inner : [inArrays(levels - 1, inner)]);
  const inObjects = (levels: number, inner: unknown): unknown => (levels === 0 ? inner : { at: inObjects(levels - 1, inner) });
  assert.deepEqual(redactedData(inArrays(64, secret), redact), inArrays(64, 'redacted'));
  assert.deepEqual(redactedData(inArrays(65, secret), redact), inArrays(64, TOO_DEEP_TEXT));
  assert.deepEqual(redactedData(inObjects(64, secret), redact), inObjects(64, 'redacted'));
  assert.deepEqual(redactedData(inObjects(65, secret), redact), inObjects(64, TOO_DEEP_TEXT));
  // Nested deeper than a recursive walk's stack holds, as a server's JSON can
  // be, in arrays and in objects.
  for (const wrap of [(v: unknown) => [v], (v: unknown) => ({ at: v })]) {
    let deep: unknown = secret;
    for (let i = 0; i < 10_000; i++) deep = wrap(deep);
    const walked = JSON.stringify(redactedData(deep, redact));
    assert.ok(walked.includes(JSON.stringify(TOO_DEEP_TEXT)) && !walked.includes(secret), walked.slice(-200));
  }
  // With a configuration that can't be read, the data is withheld as a
  // whole, keys and all, and absent data stays absent.
  const unreadable = { id: 'unreadable', url: 'https://h/mcp' };
  Object.defineProperty(unreadable, 'env', { enumerable: true, get() { throw new Error('the ledger cannot be read'); } });
  for (const redactor of [serverTextRedactor(unreadable), serverTextRedactor(unreadable).now()]) {
    assert.equal(redactedData({ [secret]: [secret], count: 2, ok: true }, redactor), WITHHELD_TEXT);
    assert.equal(redactedData(undefined, redactor), undefined);
  }
});

test("an error answer's data with many keys that redact alike is numbered with name probes that grow with the keys, not with their square", () => {
  // Every key that starts with "k" redacts to "x" here, so all of them come
  // out as one name, as copies of one credential in a server's keys can.
  const alike = (text: unknown) => (typeof text === 'string' && text.startsWith('k') ? 'x' : String(text));
  const numbered = (keys: number) => {
    const data = Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, i]));
    const has = Set.prototype.has;
    let probes = 0;
    Set.prototype.has = function (this: Set<unknown>, value: unknown) { probes++; return has.call(this, value); };
    try {
      return { names: Object.keys(redactedData(data, alike) as object), probes };
    } finally {
      Set.prototype.has = has;
    }
  };
  const small = numbered(1_024);
  const large = numbered(4_096);
  assert.deepEqual(large.names, ['x', ...Array.from({ length: 4_095 }, (_, i) => `x (${i + 2})`)]);
  assert.ok(small.probes >= 1_024, `${small.probes} name probes for 1,024 keys`);
  assert.ok(large.probes < 8 * small.probes, `${small.probes} name probes for 1,024 keys and ${large.probes} for 4,096: ` +
    'four times the keys should take about four times the probes, not sixteen');
});

test("an error built from a server's words and data reads a configuration that can't be read once, in either engine", async (t) => {
  t.mock.method(console, 'error', () => {});
  let reads = 0;
  let readable = true;
  // An `env` getter that counts its reads and throws while `readable` is
  // false, as the framework's reads the awareness ledger.
  const counted = <T extends object>(base: T, env: Record<string, string>): T => Object.defineProperty(base, 'env', {
    enumerable: true,
    configurable: true,
    get() { reads++; if (!readable) throw new Error('the ledger cannot be read'); return env; },
  });
  const modern = ModernMcpConnection.create(counted({ id: 'remote', url: 'https://h/mcp' }, { API_TOKEN: 'envSecret0123456789' })) as unknown as {
    requestFailure(what: string, record: unknown, error: unknown): Error;
    versionVerdict(error: unknown): McplProtocolVersionError | null;
  };
  readable = false;
  let before = reads;
  const failure = modern.requestFailure('tools/call', { method: 'tools/call', handedOff: true, answer: 'error', error: { code: -32000, message: 'refused', data: { a: 'x', b: ['y', 'z'] } }, continued: false }, new Error('answered'));
  assert.equal(reads - before, 1, 'the modern error answer');
  assert.equal((failure as McplRequestError).data, WITHHELD_TEXT);
  before = reads;
  modern.versionVerdict(new UnsupportedProtocolVersionError({ supported: ['2024-11-05', 'x'], requested: '2026-07-28' }));
  assert.equal(reads - before, 1, 'the modern version verdict');
  // The legacy refusal of the protocol revision, which a stdio server sends
  // once it's launched: the launch reads the configuration as connect()
  // starts, and it turns unreadable after that.
  readable = true;
  const launched = quotingServer('version-error', QUOTED[0]);
  const connecting = McplServerConnection.connect(counted({ ...launched }, launched.env as Record<string, string>), { version: '0.5' });
  readable = false;
  before = reads;
  await assert.rejects(connecting, McplProtocolVersionError);
  assert.equal(reads - before, 1, 'the legacy version refusal');
  // A stdio child that can't be started, refused on a tick after the launch
  // has read the configuration.
  readable = true;
  const starting = McplServerConnection.connect(counted({ id: 'missing', command: '/nonexistent/mcpl-server-that-is-not-here' }, { API_TOKEN: 'envSecret0123456789' }), { version: '0.5' });
  readable = false;
  before = reads;
  await assert.rejects(starting, /could not be started/);
  assert.equal(reads - before, 1, 'the launch that failed');
});

test("a library's error is handed on as its name and redacted words alone, and an unreaped launch's error doesn't print its connection", () => {
  const redact = serverTextRedactor(config);
  const raw = Object.assign(new TypeError(`fetch failed for /api/mcp/s/${secret}/mcp`), { path: secret }, { cause: new Error(secret) });
  const masked = maskedError(raw, redact);
  assert.equal(masked.name, 'TypeError');
  assert.equal(masked.message, 'fetch failed for /api/mcp/s/redacted/mcp');
  assert.deepEqual(Object.keys(masked), []);
  assert.equal(masked.cause, undefined);
  // What a library threw that isn't an Error: its text, as a plain Error's words.
  const fromText = maskedError(`refused at /api/mcp/s/${secret}/mcp`, redact);
  assert.equal(fromText.name, 'Error');
  assert.equal(fromText.message, 'refused at /api/mcp/s/redacted/mcp');
  // The connection stays reachable for the reap, and printing the error leaves it out.
  const held = { close: async () => {}, config };
  const unreaped = new McplUnreapedLaunchError(held, new Error('connect refused'), new Error('reap failed'));
  assert.equal(unreaped.connection, held);
  assert.ok(!Object.keys(unreaped).includes('connection'));
  assert.ok(!inspect(unreaped).includes(config.token), inspect(unreaped));
});
