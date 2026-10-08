/**
 * Protocol family and transport selection (room-284 design, shelf-487).
 * A URL's scheme decides a network server's family; only a stdio server has
 * a choice, and it defaults to legacy. Validation adds checks only for what
 * the modern family brought, so every legacy configuration still passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveServerBinding,
  serverConfigProblems,
  serverConfigWarnings,
  checkServerConfig,
  MCPL_ONLY_POLICY_FIELDS,
  MAX_TIMER_MS,
} from '../src/mcpl/protocol-family.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const cfg = (c: Partial<McplServerConfig>): McplServerConfig => ({ id: 's', ...c });

test('family and transport follow the configuration', () => {
  assert.deepEqual(resolveServerBinding(cfg({ command: 'srv' })), { family: 'legacy', transport: 'stdio' });
  assert.deepEqual(resolveServerBinding(cfg({ command: 'srv', protocol: 'legacy' })), { family: 'legacy', transport: 'stdio' });
  assert.deepEqual(resolveServerBinding(cfg({ command: 'srv', protocol: 'modern' })), { family: 'modern', transport: 'stdio' });
  assert.deepEqual(resolveServerBinding(cfg({ url: 'ws://localhost:3000/mcpl' })), { family: 'legacy', transport: 'websocket' });
  assert.deepEqual(resolveServerBinding(cfg({ url: 'wss://example.com/mcpl' })), { family: 'legacy', transport: 'websocket' });
  assert.deepEqual(resolveServerBinding(cfg({ url: 'http://localhost:8080/mcp' })), { family: 'modern', transport: 'http' });
  assert.deepEqual(resolveServerBinding(cfg({ url: 'https://example.com/mcp' })), { family: 'modern', transport: 'http' });
  // Existing semantics: a command wins over a url unless transport says otherwise.
  assert.deepEqual(resolveServerBinding(cfg({ command: 'srv', url: 'ws://x/mcpl' })), { family: 'legacy', transport: 'stdio' });
  assert.deepEqual(
    resolveServerBinding(cfg({ command: 'srv', url: 'ws://x/mcpl', transport: 'websocket' })),
    { family: 'legacy', transport: 'websocket' },
  );
  assert.deepEqual(
    resolveServerBinding(cfg({ url: 'https://x/mcp', transport: 'http' })),
    { family: 'modern', transport: 'http' },
  );
});

test('a configuration that names no usable transport throws', () => {
  assert.throws(() => resolveServerBinding(cfg({})), /needs "command"/);
  assert.throws(() => resolveServerBinding(cfg({ url: 'ftp://x' })), /ws:\/\/ or wss:\/\/.*http:\/\/ or https:\/\//);
  assert.throws(() => resolveServerBinding(cfg({ url: 'not a url' })), /invalid url/);
  assert.throws(() => resolveServerBinding(cfg({ url: 'ws://x', transport: 'http' })), /does not match url/);
  assert.throws(() => resolveServerBinding(cfg({ url: 'https://x', transport: 'websocket' })), /does not match url/);
  assert.throws(() => resolveServerBinding(cfg({ url: 'ws://x', transport: 'stdio' })), /requires "command"/);
  assert.throws(() => resolveServerBinding(cfg({ command: 'srv', transport: 'http' })), /transport "http" requires "url"/);
});

test('every legacy configuration shape passes validation unchanged', () => {
  const legacy: McplServerConfig[] = [
    cfg({ command: 'srv', requestTimeoutMs: 0 }), // zero still disables the legacy watchdog
    cfg({ command: 'srv', enabledFeatureSets: ['a.*'], allowHostCommands: true, channelSubscription: 'auto' }),
    cfg({ url: 'wss://x/mcpl', token: 't', toolLifecycle: { observe: { tools: ['*'] } } as never, autofetch: { maxBytes: 1 } }),
    cfg({ command: 'srv', protocol: 'legacy', disabledCapabilities: ['contextHooks.*'] }),
  ];
  for (const c of legacy) assert.deepEqual(serverConfigProblems(c), [], JSON.stringify(c));
});

test('protocol is a stdio-only choice', () => {
  assert.match(serverConfigProblems(cfg({ url: 'https://x/mcp', protocol: 'modern' })).join(), /applies only to stdio/);
  assert.match(serverConfigProblems(cfg({ url: 'ws://x/mcpl', protocol: 'legacy' })).join(), /applies only to stdio/);
  assert.match(serverConfigProblems(cfg({ command: 'srv', protocol: 'new' as never })).join(), /must be 'legacy' or 'modern'/);
});

test('a modern server needs a real deadline', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_MS + 1]) {
    const problems = serverConfigProblems(cfg({ command: 'srv', protocol: 'modern', requestTimeoutMs: bad }));
    assert.match(problems.join(), /requestTimeoutMs must be an integer from 1/, String(bad));
  }
  for (const good of [undefined, 1, 60_000, MAX_TIMER_MS]) {
    assert.deepEqual(serverConfigProblems(cfg({ url: 'https://x/mcp', requestTimeoutMs: good })), [], String(good));
  }
});

test('MCPL policy on a modern server is rejected, empty values are not', () => {
  const effective: Partial<McplServerConfig> = {
    enabledFeatureSets: ['a'],
    disabledFeatureSets: ['b'],
    enabledCapabilities: ['pushEvents'],
    disabledCapabilities: ['channels'],
    scopes: { a: {} as never },
    channelSubscription: 'manual',
    allowHostCommands: true,
    toolLifecycle: { observe: {} } as never,
    autofetch: { maxBytes: 10 },
    shouldTriggerInference: () => true,
  };
  for (const field of MCPL_ONLY_POLICY_FIELDS) {
    const problems = serverConfigProblems(cfg({ url: 'https://x/mcp', [field]: effective[field] }));
    assert.equal(problems.length, 1, field);
    assert.match(problems[0]!, new RegExp(`"${field}" is MCPL policy`));
  }
  const empty = cfg({
    command: 'srv',
    protocol: 'modern',
    enabledFeatureSets: [],
    disabledCapabilities: [],
    scopes: {},
    allowHostCommands: false,
    toolLifecycle: {} as never,
  });
  assert.deepEqual(serverConfigProblems(empty), []);
});

test('a credential sent in cleartext to a host that is not loopback is warned about, never refused', () => {
  const provider = async () => 'fresh';
  const warned = (c: Partial<McplServerConfig>) => serverConfigWarnings(cfg(c));
  // The Authorization header over http, and the ?token= query over ws.
  assert.match(warned({ url: 'http://10.0.0.5:8080/mcp', token: 't' })[0]!, /credential goes to 10\.0\.0\.5:8080 unencrypted \(http:\/\/\).*use https:\/\//);
  assert.match(warned({ url: 'ws://mcp.lan/mcpl', accessProvider: provider })[0]!, /credential goes to mcp\.lan unencrypted \(ws:\/\/\).*use wss:\/\//);
  assert.equal(serverConfigProblems(cfg({ url: 'http://10.0.0.5:8080/mcp', token: 't' })).length, 0, 'still usable');
  // Nothing to warn about: encrypted, loopback, no credential, or not dialed.
  for (const quiet of [
    { url: 'https://10.0.0.5/mcp', token: 't' },
    { url: 'wss://mcp.lan/mcpl', token: 't' },
    { url: 'http://localhost:8080/mcp', token: 't' },
    { url: 'http://127.0.0.1:8080/mcp', token: 't' },
    { url: 'http://127.0.0.2:8080/mcp', token: 't' },
    { url: 'ws://0.0.0.0:8080/mcpl', token: 't' },
    { url: 'http://[::1]:8080/mcp', token: 't' },
    { url: 'ws://app.localhost/mcpl', token: 't' },
    { url: 'http://10.0.0.5:8080/mcp' },
    { command: 'srv', url: 'http://10.0.0.5/mcp', token: 't' },
    { url: 'ftp://10.0.0.5/mcp', token: 't' },
  ]) assert.deepEqual(warned(quiet), [], JSON.stringify(quiet));
});

test('both engines admit a configuration through checkServerConfig, which logs its warnings', () => {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    checkServerConfig(cfg({ url: 'ws://mcp.lan/mcpl', token: 't' }));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[mcp\] MCP server "s": its credential goes to mcp\.lan unencrypted/);
    // The modern engine checks at create(), before anything is dialed.
    ModernMcpConnection.create(cfg({ id: 'm', url: 'http://10.0.0.5:8080/mcp', token: 't' }));
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /MCP server "m": its credential goes to 10\.0\.0\.5:8080 unencrypted/);
    checkServerConfig(cfg({ url: 'https://10.0.0.5/mcp', token: 't' }));
    assert.equal(lines.length, 2, 'nothing for https');
  } finally {
    console.warn = realWarn;
  }
});
