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
  redactUrl,
  redactServerText,
  credentialRedactor,
  serverCredentialPatterns,
  serverTextRedactor,
  noteDialSent,
  describeCredentialError,
  mcplPolicyGrants,
  MAX_TIMER_MS,
} from '../src/mcpl/protocol-family.js';
import { logValueRedacted } from '../src/mcpl/log-value.js';
import { getEventListeners } from 'node:events';
import { DEFAULT_EAGER_FETCH_MAX_BYTES, DEFAULT_MAX_TOTAL_BYTES } from '../src/mcpl/reference-fetcher.js';
import { DEFAULT_MAX_INPUT_BYTES } from '../src/mcpl/tool-lifecycle.js';
import { ModernMcpConnection } from '../src/mcpl/modern-connection.js';
import { WebSocketTransport, buildWebSocketUrl } from '../src/mcpl/transport.js';
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
  // With both a command and a url, an explicit transport says which is used
  // (a host layers a recipe's url and transport over a file's command).
  assert.deepEqual(
    resolveServerBinding(cfg({ command: 'srv', url: 'ws://x/mcpl', transport: 'websocket' })),
    { family: 'legacy', transport: 'websocket' },
  );
  assert.deepEqual(
    resolveServerBinding(cfg({ command: 'srv', url: 'ws://x/mcpl', transport: 'stdio' })),
    { family: 'legacy', transport: 'stdio' },
  );
  assert.deepEqual(
    resolveServerBinding(cfg({ command: 'srv', url: 'https://x/mcp', transport: 'http' })),
    { family: 'modern', transport: 'http' },
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

test('command and url without a transport are refused, rather than one of them silently ignored', () => {
  for (const url of ['ws://x/mcpl', 'https://x/mcp']) {
    for (const extra of [{}, { protocol: 'legacy' as const }, { protocol: 'modern' as const }]) {
      const c = cfg({ command: 'srv', url, ...extra });
      assert.throws(() => resolveServerBinding(c), /"command" and "url" are both set, and no "transport" says which one to use/, JSON.stringify(c));
      assert.match(serverConfigProblems(c).join(), /"command" and "url" are both set/, JSON.stringify(c));
    }
  }
  // A transport that disagrees with the url it would use is still refused.
  assert.throws(() => resolveServerBinding(cfg({ command: 'srv', url: 'https://x/mcp', transport: 'websocket' })), /does not match url/);
  assert.throws(() => resolveServerBinding(cfg({ command: 'srv', url: 'ws://x/mcpl', transport: 'http' })), /does not match url/);
});

test('errors and the status view show a url redacted: no userinfo, no query values', () => {
  assert.equal(redactUrl('https://user:pw@mcp.example:8443/v1/mcp?token=abc&region=eu&token=def#frag'),
    'https://mcp.example:8443/v1/mcp?token=redacted&region=redacted&token=redacted');
  assert.equal(redactUrl('wss://example.test/mcpl'), 'wss://example.test/mcpl');
  // A path segment that looks like a credential goes too: a hosted server's
  // per-user secret, a uuid, anything very long. Short and plain-word ones stay.
  assert.equal(redactUrl('https://mcp.zapier.com/api/mcp/s/Zt4kQ9xW2vLm8pRs7YbN/mcp'), 'https://mcp.zapier.com/api/mcp/s/redacted/mcp');
  assert.equal(redactUrl('https://mcp.example/server/123e4567-e89b-12d3-a456-426614174000/mcp'), 'https://mcp.example/server/redacted/mcp');
  assert.equal(redactUrl(`https://mcp.example/${'a'.repeat(32)}/mcp`), 'https://mcp.example/redacted/mcp');
  assert.equal(redactUrl('https://mcp.example/v2/2026-07-28/organization-settings/mcp'), 'https://mcp.example/v2/2026-07-28/organization-settings/mcp');
  // A bare token rides as a valueless name: one shaped like a token, or one
  // whose name says it's a credential, goes. A name with a value is a label
  // and stays, and so does a short plain name.
  assert.equal(redactUrl('https://h/mcp?sk-live-abcdef0123456789'), 'https://h/mcp?redacted=redacted');
  assert.equal(redactUrl('https://h/mcp?apikey_x9'), 'https://h/mcp?redacted=redacted');
  assert.equal(redactUrl('https://h/mcp?token=abc'), 'https://h/mcp?token=redacted');
  assert.equal(redactUrl('https://h/mcp?verbose'), 'https://h/mcp?verbose=redacted');
  assert.equal(redactUrl('not a url ?token=abc'), '(an invalid url, not shown)');
  assert.equal(redactUrl(undefined), '(an invalid url, not shown)');
  // The configuration errors that name a url give it redacted, or not at all.
  const mismatch = serverConfigProblems(cfg({ url: 'https://u:pw@x/mcp?key=sekret', transport: 'websocket' })).join();
  assert.match(mismatch, /does not match url https:\/\/x\/mcp\?key=redacted/);
  const invalid = serverConfigProblems(cfg({ url: 'sekret token not a url' })).join();
  assert.match(invalid, /invalid url/);
  for (const text of [mismatch, invalid]) assert.ok(!/sekret|pw@/.test(text), text);
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

test('a legacy deadline above the timer limit is refused; every value that worked passes', () => {
  for (const bad of [MAX_TIMER_MS + 1, Number.POSITIVE_INFINITY]) {
    for (const c of [cfg({ command: 'srv', requestTimeoutMs: bad }), cfg({ url: 'wss://x/mcpl', requestTimeoutMs: bad })]) {
      assert.match(serverConfigProblems(c).join(), /requestTimeoutMs must be at most 2147483647/, String(bad));
    }
  }
  for (const good of [undefined, 0, 1, 60_000, MAX_TIMER_MS]) {
    assert.deepEqual(serverConfigProblems(cfg({ command: 'srv', requestTimeoutMs: good })), [], String(good));
  }
});

test('MCPL policy on a modern server is refused where its value grants, and accepted where it only narrows or repeats a default (R1-3)', () => {
  const modern = (c: Partial<McplServerConfig>) => cfg({ url: 'https://x/mcp', ...c });
  // Each value that asks for MCPL behaviour is refused, naming the part that grants.
  const granting: Array<[Partial<McplServerConfig>, string]> = [
    [{ enabledCapabilities: ['toolLifecycle.observe'] }, 'enabledCapabilities: toolLifecycle.observe'],
    [{ enabledCapabilities: ['contextHooks.beforeInference.inject.*'] }, 'enabledCapabilities: contextHooks.beforeInference.inject.system'],
    [{ allowHostCommands: true }, 'allowHostCommands'],
    [{ channelSubscription: 'auto' }, 'channelSubscription'],
    [{ channelSubscription: ['general'] }, 'channelSubscription'],
    [{ scopes: { files: { whitelist: ['read:*'], blacklist: ['write:*'] } } }, 'scopes.files.whitelist'],
    [{ toolLifecycle: { observe: {} } }, 'toolLifecycle.observe'],
    [{ toolLifecycle: { inputs: { tools: ['x--*'] } } }, 'toolLifecycle.inputs'],
    [{ autofetch: { maxBytes: DEFAULT_EAGER_FETCH_MAX_BYTES + 1 } }, 'autofetch.maxBytes'],
    [{ autofetch: { maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES + 1 } }, 'autofetch.maxTotalBytes'],
    [{ toolLifecycle: { maxInputBytes: DEFAULT_MAX_INPUT_BYTES + 1 } }, 'toolLifecycle.maxInputBytes'],
  ];
  // Patterns reaching every path denied by default name each. A `*` matches
  // one segment, and counts must agree (capabilityPatternMatches).
  assert.deepEqual(mcplPolicyGrants(modern({ enabledCapabilities: ['*.*', '*.*.*.*'] })), [
    'enabledCapabilities: contextHooks.beforeInference.inject.system',
    'enabledCapabilities: toolLifecycle.observe',
    'enabledCapabilities: toolLifecycle.inputs',
  ]);
  // An entry that isn't a string can't be matched, so it's read as asking
  // for every path denied by default.
  assert.deepEqual(mcplPolicyGrants(modern({ enabledCapabilities: [42 as never] })), [
    'enabledCapabilities: contextHooks.beforeInference.inject.system',
    'enabledCapabilities: toolLifecycle.observe',
    'enabledCapabilities: toolLifecycle.inputs',
  ]);
  for (const [config, path] of granting) {
    assert.deepEqual(mcplPolicyGrants(modern(config)), [path], path);
    const problems = serverConfigProblems(modern(config));
    assert.equal(problems.length, 1, path);
    assert.ok(problems[0]!.includes(`"${path}" asks for MCPL behaviour, which a modern MCP server cannot negotiate`), problems[0]);
  }
  // What only takes something away, or repeats a default, is already
  // satisfied: a modern server has no MCPL surface.
  const narrowing: Partial<McplServerConfig>[] = [
    // connectome-host's overlay route stamps this on every server it deploys.
    { disabledCapabilities: ['contextHooks', 'inferenceLifecycle', 'inferenceRequest', 'toolLifecycle'] },
    { disabledFeatureSets: ['b'] },
    // Allow-lists: absent, every declared set or advertised capability is a
    // candidate, so a list can only narrow, except where it names a path
    // denied by default.
    { enabledFeatureSets: ['a'] },
    { enabledCapabilities: ['pushEvents', 'contextHooks.afterInference'] },
    // A one-segment `*` reaches no path denied by default.
    { enabledCapabilities: ['*'] },
    { scopes: { files: { blacklist: ['write:*'] } } },
    { scopes: { files: { whitelist: [] } } },
    { channelSubscription: 'manual' },
    { toolLifecycle: { maxInputBytes: 1024 } },
    { toolLifecycle: { maxInputBytes: DEFAULT_MAX_INPUT_BYTES } },
    { toolLifecycle: { observe: false } as never },
    { autofetch: { maxBytes: DEFAULT_EAGER_FETCH_MAX_BYTES, maxTotalBytes: 1 } },
    { shouldTriggerInference: () => false },
  ];
  for (const config of narrowing) {
    assert.deepEqual(serverConfigProblems(modern(config)), [], JSON.stringify(config));
    // Nor a warning: a host that stamps its deny-list on every server would
    // hear it at every start, with nothing to do about it.
    assert.deepEqual(serverConfigWarnings(modern(config)), [], JSON.stringify(config));
  }
  // Empty values grant nothing, on a modern stdio server too.
  const empty = cfg({
    command: 'srv',
    protocol: 'modern',
    enabledFeatureSets: [],
    disabledCapabilities: [],
    scopes: {},
    allowHostCommands: false,
    toolLifecycle: {} as never,
    channelSubscription: [],
  });
  assert.deepEqual(serverConfigProblems(empty), []);
});

test('a credential on a modern stdio server is refused; a legacy stdio server still ignores it', () => {
  const provider = async () => 'fresh';
  assert.match(serverConfigProblems(cfg({ command: 'srv', protocol: 'modern', token: 't' })).join(), /"token" applies only to a network \(url\) server/);
  assert.match(serverConfigProblems(cfg({ command: 'srv', protocol: 'modern', accessProvider: provider })).join(), /"accessProvider" applies only to a network/);
  assert.deepEqual(serverConfigProblems(cfg({ command: 'srv', token: 't', accessProvider: provider })), []);
  assert.deepEqual(serverConfigProblems(cfg({ url: 'https://x/mcp', token: 't', accessProvider: provider })), []);
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
    { url: 'http://[::]:8080/mcp', token: 't' },
    { url: 'http://[::ffff:127.0.0.1]:8080/mcp', token: 't' },
    { url: 'http://[::ffff:127.9.8.7]/mcp', token: 't' },
    { url: 'http://localhost.:8080/mcp', token: 't' },
    { url: 'ws://app.localhost./mcpl', token: 't' },
    { url: 'http://localhost:8080/mcp?token=abc' },
    { url: 'http://10.0.0.5:8080/mcp' },
    { url: 'http://10.0.0.5:8080/mcp?region=eu&page=2' },
    { command: 'srv', url: 'http://10.0.0.5/mcp', token: 't' },
    { url: 'ftp://10.0.0.5/mcp', token: 't' },
  ]) assert.deepEqual(warned(quiet), [], JSON.stringify(quiet));
  // Not loopback: a mapped address outside 127/8, and a name that only ends in "localhost".
  for (const loud of ['http://[::ffff:10.0.0.5]/mcp', 'http://notlocalhost/mcp']) {
    assert.equal(warned({ url: loud, token: 't' }).length, 1, loud);
  }
});

test('a secret the url carries itself is warned about too, and the warning never quotes it', () => {
  const warned = (url: string, extra: Partial<McplServerConfig> = {}) => serverConfigWarnings(cfg({ url, ...extra }));
  assert.match(warned('ws://user:pw@10.0.0.5/mcpl')[0]!, /its url's userinfo goes to 10\.0\.0\.5 unencrypted \(ws:\/\/\).*read it;/);
  assert.match(warned('ws://mcp.lan/mcpl?api_key=k1')[0]!, /its url's query parameter "api_key" goes to mcp\.lan unencrypted.*use wss:\/\//);
  for (const name of ['token', 'Access_Token', 'apikey', 'client_secret', 'password', 'auth', 'X-Amz-Signature']) {
    assert.equal(warned(`http://10.0.0.5/mcp?${name}=v`).length, 1, name);
  }
  const both = warned('ws://u:p@10.0.0.5/mcpl?token=a&sig_key=b&region=eu', { token: 't' })[0]!;
  assert.match(both, /its credential, its url's userinfo and its url's query parameters "token", "sig_key" go to 10\.0\.0\.5 unencrypted.*read them;/);
  for (const text of [both, ...warned('ws://user:pw@10.0.0.5/mcpl?token=sekret')]) assert.ok(!/sekret|pw|u:p/.test(text), text);
  // A name that may itself be a credential is warned about and counted, never quoted.
  assert.deepEqual(warned('ws://mcp.lan/mcpl?sk-live-abcdef0123456789'), [
    'MCP server "s": a query parameter whose name looks like a credential goes to mcp.lan unencrypted (ws://), where anything on the network path can read it; use wss:// unless that network is trusted',
  ]);
  const named = warned('ws://mcp.lan/mcpl?token=a&apikey_x9&x7y8z9w0v1u2t3s4r5')[0]!;
  assert.match(named, /its url's query parameter "token" and 2 query parameters whose names look like credentials go to mcp\.lan unencrypted.*read them;/);
  assert.ok(!/apikey_x9|x7y8z9/.test(named), named);
  const path = warned('http://10.0.0.5/api/mcp/s/Zt4kQ9xW2vLm8pRs7YbN/mcp')[0]!;
  assert.match(path, /a credential-like segment of its url's path goes to 10\.0\.0\.5 unencrypted.*read it;/);
  assert.ok(!path.includes('Zt4kQ9xW2vLm8pRs7YbN'), path);
  assert.deepEqual(warned('http://10.0.0.5/v2/2026-07-28/mcp'), [], 'a short segment with digits is a name');
  // Encrypted or loopback: nothing.
  assert.deepEqual(warned('https://user:pw@10.0.0.5/mcp?token=a'), []);
  assert.deepEqual(warned('http://user:pw@127.0.0.1/mcp?token=a'), []);
});

test('an access provider that throws is never quoted in the log, on either dial', async () => {
  const message = 'refresh token sekret-123 expired';
  const accessProvider = async (): Promise<string | null> => { throw new Error(message); };
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    // Nothing listens on port 1: each dial fails after asking the provider.
    await assert.rejects(WebSocketTransport.open(cfg({ id: 'ws', url: 'ws://127.0.0.1:1/mcpl', accessProvider })));
    await assert.rejects(ModernMcpConnection.connect(cfg({ id: 'http', url: 'http://127.0.0.1:1/mcp', accessProvider })));
  } finally {
    console.error = realError;
  }
  const fallbacks = logged.filter((line) => line.includes('access provider failed'));
  assert.equal(fallbacks.length, 2, logged.join('\n'));
  for (const line of fallbacks) assert.ok(line.includes(`access provider failed (Error, ${message.length} characters)`), line);
  assert.ok(!logged.some((line) => line.includes('sekret')), logged.join('\n'));
});

test('an access provider that throws is logged by its error class and length, not its text', () => {
  assert.equal(describeCredentialError(new TypeError('refresh failed for sekret-abc')), 'TypeError, 29 characters');
  class ProviderError extends Error {}
  assert.equal(describeCredentialError(new ProviderError('x')), 'ProviderError, 1 character');
  assert.equal(describeCredentialError('sekret'), 'a thrown string');
  assert.equal(describeCredentialError(undefined), 'a thrown undefined');
});

test("an http(s) url with userinfo is refused, since the HTTP client can't send it and its error would quote it", () => {
  for (const url of ['http://user:S3CRET@127.0.0.1:9/mcp', 'http://user:S3CRET@10.0.0.5/mcp', 'https://user:S3CRET@mcp.example/mcp', 'http://justauser@127.0.0.1:9/mcp']) {
    const problems = serverConfigProblems(cfg({ url }));
    assert.deepEqual(problems, [
      'MCP server "s": an http(s):// url can\'t carry userinfo (user:password@), since the HTTP client refuses such a url; give the credential as "token" or "accessProvider"',
    ], url);
    // The modern engine checks at create(), so nothing is dialed with it.
    assert.throws(() => ModernMcpConnection.create(cfg({ id: 's', url })), (error: Error) => error.message === problems[0]);
    assert.deepEqual(serverConfigWarnings(cfg({ url })), [], 'a refusal, not also a warning');
  }
  assert.deepEqual(serverConfigProblems(cfg({ url: 'ws://user:pw@127.0.0.1:9/mcpl' })), [], 'a WebSocket url sends its userinfo');
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

test("a query credential is removed as the WebSocket dial sends it, the query re-encoded once the token is set", () => {
  const config = cfg({ url: 'wss://host.example/mcp?password=secret%20key123&q=a~b', token: 'tok-abcdefgh' });
  const sent = buildWebSocketUrl(config);
  // The form the server receives, and can echo, as URLSearchParams writes it.
  assert.ok(sent.includes('password=secret+key123') && sent.includes('q=a%7Eb'), sent);
  const shown = redactServerText(`closed by the server: ${sent}`, config);
  assert.ok(!shown.includes('key123'), shown);
  assert.ok(!shown.includes('tok-abcdefgh'), shown);
  assert.ok(!shown.includes('q=a%7Eb'), shown);
});

test("an access provider's token is removed once a dial has sent it, in a WebSocket url or an HTTP header", async () => {
  const ws = cfg({ id: 'ws', url: 'ws://127.0.0.1:1/mcpl?password=secret%20key123', accessProvider: async () => 'prov/ws-0123456789' });
  const http = cfg({ id: 'http', url: 'http://127.0.0.1:1/mcp', accessProvider: async () => 'prov-http-0123456789' });
  // Made before the dial, as the framework makes a connection's.
  const recorded = serverTextRedactor(ws);
  assert.ok(recorded('token=prov%2Fws-0123456789').includes('ws-0123456789'), 'no dial has sent it yet');
  // Nothing listens on port 1: each dial notes its credential before it fails.
  await assert.rejects(WebSocketTransport.open(ws));
  await assert.rejects(ModernMcpConnection.connect(http));
  const shown = recorded('closed: ws://127.0.0.1:1/mcpl?password=secret+key123&token=prov%2Fws-0123456789');
  assert.ok(!shown.includes('ws-0123456789') && !shown.includes('key123'), shown);
  // The token in the forms a token takes, as JSON with its slash escaped.
  const json = recorded('{"token":"prov\\/ws-0123456789"}');
  assert.ok(!json.includes('ws-0123456789'), json);
  const header = redactServerText('refused: Authorization: Bearer prov-http-0123456789', http);
  assert.ok(!header.includes('prov-http'), header);
});

test("a dial with an access provider takes its abort listener off the signal once the provider has answered", async () => {
  // A reconnect loop's signal lives across many dials.
  const controller = new AbortController();
  for (let n = 1; n <= 3; n++) {
    await assert.rejects(WebSocketTransport.open(cfg({ id: 'ws', url: 'ws://127.0.0.1:1/mcpl', accessProvider: async () => `prov-loop-${n}-0123456789` }), controller.signal));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, `after dial ${n}`);
  }
});

test("a dial whose signal aborts while its access provider is called ends then, not when the provider answers", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  await assert.rejects(
    WebSocketTransport.open(cfg({
      id: 'ws',
      url: 'ws://127.0.0.1:1/mcpl',
      // The connection is closed while the provider runs, and the provider
      // never answers.
      accessProvider: () => { controller.abort(); return new Promise<string>(() => {}); },
    }), controller.signal),
    /WebSocket connect abandoned: the connection was closed/,
  );
});

test("a token a dial sends again is the newest, so the oldest of the others goes first", () => {
  const config = cfg({ id: 'r', url: 'http://127.0.0.1:1/mcp' });
  noteDialSent(config, { token: 'prov-again-0000' });
  for (let n = 1; n <= 15; n++) noteDialSent(config, { token: `prov-other-${String(n).padStart(4, '0')}` });
  noteDialSent(config, { token: 'prov-again-0000' });
  noteDialSent(config, { token: 'prov-other-0016' });
  assert.equal(redactServerText('prov-again-0000', config), 'redacted');
  assert.equal(redactServerText('prov-other-0001', config), 'prov-other-0001', 'the oldest of the others is let go');
});

test("a configuration keeps only its dials' newest provider tokens", () => {
  const config = cfg({ id: 'p', url: 'http://127.0.0.1:1/mcp' });
  for (let n = 0; n <= 16; n++) noteDialSent(config, { token: `prov-token-${String(n).padStart(4, '0')}` });
  assert.ok(redactServerText('prov-token-0000', config).includes('prov-token-0000'), 'the oldest of 17 is let go');
  assert.equal(redactServerText('prov-token-0001 prov-token-0016', config), 'redacted redacted');
});

test('recorded server text removes encoded and decoded URL credentials as exact strings', () => {
  const config = cfg({ url: 'https://h/api/s/secret%2B0123456789/mcp?password=p%2Bassw0rd%21&bare%2Bsecret0123456789&plain=value0123456789abcdef&region=eu&label=a%20b' });
  const secrets = ['secret%2B0123456789', 'secret+0123456789', 'p%2Bassw0rd%21', 'p+assw0rd!', 'bare%2Bsecret0123456789', 'bare+secret0123456789', 'value0123456789abcdef', 'region=eu', 'label=a%20b', 'label=a b'];
  for (const secret of secrets) assert.equal(redactServerText(`queue full: ${secret}; eu`, config), 'queue full: redacted; eu', secret);
});

test('recorded server text removes WebSocket userinfo and the static token, escaping regex characters', () => {
  const config = cfg({ url: 'wss://user%2B12345678:pass%2B12345678@h/mcp', token: 'token.[1234]' });
  for (const secret of ['user%2B12345678', 'user+12345678', 'pass%2B12345678', 'pass+12345678', config.token!]) {
    assert.equal(redactServerText(`error: ${secret}`, config), 'error: redacted');
  }
  assert.equal(redactServerText('tokenX11234]', config), 'tokenX11234]');
  assert.equal(redactServerText('static-token123', cfg({ token: 'static-token123' })), 'redacted');
  assert.equal(redactServerText('static-token123', cfg({ url: 'invalid', token: 'static-token123' })), 'redacted');
});

test('recorded server text keeps short standalone values and unrelated words, but removes whole query pairs', () => {
  const config = cfg({ url: 'https://h/mcp?auth=x&token=auth&region=eu&debug', token: 'x' });
  assert.equal(redactServerText('auth x eu queue full debug', config), 'auth x eu queue full debug');
  assert.equal(redactServerText('auth=x token=auth region=eu', config), 'redacted redacted redacted');
  assert.equal(redactServerText('1234567 12345678', cfg({token:'1234567'})), '1234567 12345678');
  assert.equal(redactServerText('12345678', cfg({token:'12345678'})), 'redacted');
});

test('recorded server text: the token as a url carries it, credential-named env values, only where nothing adjoins, and any value', () => {
  // The static token, raw and as a url carries it, percent- or form-encoded.
  const token = 'tok en+x/123=';
  const tokenConfig = cfg({ token });
  // Percent-encoded (%20 for the space) and form-encoded (+ for it) differ here.
  for (const form of [token, 'tok%20en%2Bx%2F123%3D', 'tok+en%2Bx%2F123%3D']) {
    assert.equal(redactServerText(`refused: ${form}`, tokenConfig), 'refused: redacted', form);
  }
  // A stdio server's env: a value whose name has a part ending in a credential
  // word (plural, or with digits after it, too), and no other
  // (GIT_AUTHOR_NAME's part AUTHOR doesn't end in 'auth').
  const env = cfg({ command: 'srv', env: {
    GITHUB_TOKEN: 'ghp_abcdef123456', API_KEY: 'k3y-abcdefgh', PGPASSWORD: 'pgpass-abcdefgh', ACCESSTOKEN: 'acc-abcdefgh12',
    DB_PASS: 'dbpass-abcdefgh', SSH_KEY_PASSPHRASE: 'phrase-abcdefgh',
    AUTHORIZATION: 'Bearer-abcdefgh', API_KEYS: 'k1-abcdefgh9', TOKEN2: 'tok2-abcdefgh', API_KEY_ID: 'keyid-abcdefgh', GITHUB_PAT: 'pat-abcdefgh12',
    SESSION_COOKIE: 'cookie-abcdefgh', CLOUD_CREDS: 'creds-abcdefgh',
    PATH: '/usr/local/bin', GIT_AUTHOR_NAME: 'Somebody Longname', KEYBOARD_LAYOUT: 'dvorak-programmer', TOKENIZERS_PARALLELISM: 'parallel-false',
  } });
  assert.equal(
    redactServerText('auth ghp_abcdef123456 k3y-abcdefgh pgpass-abcdefgh acc-abcdefgh12 dbpass-abcdefgh phrase-abcdefgh Bearer-abcdefgh k1-abcdefgh9 tok2-abcdefgh keyid-abcdefgh pat-abcdefgh12 cookie-abcdefgh creds-abcdefgh /usr/local/bin Somebody Longname dvorak-programmer parallel-false', env),
    'auth redacted redacted redacted redacted redacted redacted redacted redacted redacted redacted redacted redacted redacted /usr/local/bin Somebody Longname dvorak-programmer parallel-false');
  // A credential env value as a url would carry it, percent-encoded.
  assert.equal(redactServerText('GET /x?pw=p%40ss%2Fw0rd!x', cfg({ command: 'srv', env: { DB_PASSWORD: 'p@ss/w0rd!x' } })), 'GET /x?pw=redacted');
  // A value that isn't a string (a JavaScript host can pass one) is skipped, not thrown on.
  assert.equal(redactServerText('fine', cfg({ command: 'srv', env: { API_TOKEN: null as unknown as string, OTHER_KEY: 7 as unknown as string } })), 'fine');
  // A short pair only where no letter or digit adjoins it; any other string
  // wherever it occurs, after a percent escape, an ANSI code or a JSON escape too.
  const pair = cfg({ url: 'https://h/api/s/pathSecret0123456789/mcp?v=2' });
  assert.equal(redactServerText('dev=2 ready; v=2 sent', pair), 'dev=2 ready; redacted sent');
  // A long pair too: only as its own name=value.
  const longPair = cfg({ url: 'https://h/mcp?v=12345678' });
  assert.equal(redactServerText('dev=12345678 ready; v=12345678 sent', longPair), 'dev=12345678 ready; redacted sent');
  assert.equal(redactServerText('a%2FpathSecret0123456789 \u001b[31mpathSecret0123456789 "\\npathSecret0123456789"', pair),
    'a%2Fredacted \u001b[31mredacted "\\nredacted"');
  // A ws:// url's userinfo, as for wss://.
  const ws = cfg({ url: 'ws://wsuser1234:wspass5678@h/mcp' });
  assert.equal(redactServerText('connect wsuser1234 wspass5678', ws), 'connect redacted redacted');
  // A url with a stray percent sign: its value is kept as written.
  const stray = cfg({ url: 'https://h/mcp?note=100%&key=abcdefgh1234' });
  assert.equal(redactServerText('note=100% key=abcdefgh1234', stray), 'redacted redacted');
  // Any value reads as text: a rejection that isn't an Error doesn't throw,
  // and neither does one that can't be printed.
  assert.equal(redactServerText(undefined, tokenConfig), 'undefined');
  assert.equal(redactServerText({ toString: () => `obj ${token}` }, tokenConfig), 'obj redacted');
  assert.equal(redactServerText(Object.create(null), tokenConfig), '[a value that cannot be printed]');
  assert.equal(redactServerText({ toString() { throw new Error('no'); } }, tokenConfig), '[a value that cannot be printed]');
  // A token that can't be url-encoded (an unpaired surrogate) is still replaced as written.
  assert.equal(redactServerText('x abcdefgh\ud800ij', cfg({ token: 'abcdefgh\ud800ij' })), 'x redacted');
});

test('the cleartext warning counts a credential-shaped value under a plain name, as redaction does', () => {
  const warned = serverConfigWarnings(cfg({ url: 'http://remote.example/mcp?session=Zx81kQ0pL2mN7vB4tY6c' }));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /its url's query parameter "session" goes to remote\.example unencrypted/);
});

test('recorded server text: a slash escaped as JSON may write it, and percent-escapes in lowercase hex', () => {
  const config = cfg({ token: 'tok/en+x0123', env: { API_TOKEN: 'env/secret+0123' } } as Partial<McplServerConfig>);
  for (const form of ['tok/en+x0123', 'tok\\/en+x0123', 'tok%2Fen%2Bx0123', 'tok%2fen%2bx0123', 'env\\/secret+0123', 'env%2fsecret%2b0123']) {
    assert.equal(redactServerText(`refused: ${form}`, config), 'refused: redacted', form);
  }
  // A token whose form encoding differs from its percent encoding: a space is + there, %20 here.
  const spaced = cfg({ token: 'tok en/x0123' });
  for (const form of ['tok+en%2Fx0123', 'tok+en%2fx0123', 'tok%20en%2Fx0123', 'tok%20en%2fx0123']) {
    assert.equal(redactServerText(`refused: ${form}`, spaced), 'refused: redacted', form);
  }
});

test("recorded server text: a ws:// url's userinfo as one unit before its @, and the Basic credential sent for it", () => {
  // Neither part is long enough to replace on its own, nor is the unit.
  const config = cfg({ url: 'wss://bot:pw@h/mcp' });
  assert.equal(redactServerText('dial wss://bot:pw@h/mcp failed', config), 'dial wss://redacted@h/mcp failed');
  assert.equal(redactServerText('Authorization: Basic Ym90OnB3', config), 'Authorization: Basic redacted');
  // The @ and a boundary before it anchor the unit.
  assert.equal(redactServerText('bot:pw is not followed by its @ here', config), 'bot:pw is not followed by its @ here');
  assert.equal(redactServerText('robot:pw@h', config), 'robot:pw@h');
  assert.equal(redactServerText('dial wss://alice:pw@h/mcp failed', cfg({ url: 'wss://alice:pw@h/mcp' })), 'dial wss://redacted@h/mcp failed');
  // ws:// as wss://.
  const plain = cfg({ url: 'ws://bot:pw@h/mcp' });
  assert.equal(redactServerText('dial ws://bot:pw@h/mcp failed', plain), 'dial ws://redacted@h/mcp failed');
  assert.equal(redactServerText('Authorization: Basic Ym90OnB3', plain), 'Authorization: Basic redacted');
  // A username alone, as a token written as the username is: the unit is the
  // username, and the Basic credential is that of "name:".
  for (const url of ['ws://k3y@h/mcp', 'wss://k3y@h/mcp']) {
    const tokenOnly = cfg({ url });
    assert.equal(redactServerText(`dial ${url} failed`, tokenOnly), `dial ${url.replace('k3y', 'redacted')} failed`, url);
    assert.equal(redactServerText(`Authorization: Basic ${Buffer.from('k3y:').toString('base64')}`, tokenOnly), 'Authorization: Basic redacted', url);
    assert.equal(redactServerText('monk3y@h', tokenOnly), 'monk3y@h', url);
  }
  // Percent-encoded, with every part too short to replace on its own: the
  // unit as written and as decoded, and the Basic credential sent for each.
  const encoded = cfg({ url: 'wss://b%40t:p%40ss@h/mcp' });
  assert.equal(redactServerText('dial wss://b%40t:p%40ss@h/mcp failed', encoded), 'dial wss://redacted@h/mcp failed');
  assert.equal(redactServerText('as user b@t:p@ss@h', encoded), 'as user redacted@h');
  for (const userinfo of ['b%40t:p%40ss', 'b@t:p@ss']) {
    assert.equal(redactServerText(`Authorization: Basic ${Buffer.from(userinfo).toString('base64')}`, encoded), 'Authorization: Basic redacted', userinfo);
  }
});

test('recorded server text: a credential as JSON.stringify writes it, its quotes and backslashes escaped', () => {
  const password = 'pa"ss\\w0rd/x1';
  const config = cfg({ command: 'srv', token: 'to"ken\\0123', env: { DB_PASSWORD: password } } as Partial<McplServerConfig>);
  for (const secret of [password, config.token!]) {
    const json = JSON.stringify(secret).slice(1, -1);
    for (const form of [secret, json, json.replace(/\//g, '\\/')]) {
      assert.equal(redactServerText(`config {"secret":"${form}"} refused`, config), 'config {"secret":"redacted"} refused', form);
    }
  }
});

test("recorded server text: a url's credentials, pairs and userinfo as JSON.stringify writes them, as a token's are", () => {
  // Decoded, each holds a quote and a backslash, or a slash: a path segment,
  // a credential-named query value, a pair whose value is too short to go on
  // its own, a ws:// password, and a userinfo unit too short to go on its own.
  const config = cfg({ url: 'wss://bot:pa%22ss%5Cw0rd@h/mcpl/s3cr%22et%5C0123456789?password=sec%2Fret%22key123&region=e%22u' });
  for (const decoded of ['s3cr"et\\0123456789', 'sec/ret"key123', 'pa"ss\\w0rd']) {
    const json = JSON.stringify(decoded).slice(1, -1);
    for (const form of [decoded, json, json.replace(/\//g, '\\/')]) {
      assert.equal(redactServerText(`config {"secret":"${form}"} refused`, config), 'config {"secret":"redacted"} refused', form);
    }
  }
  assert.equal(redactServerText('config {"q":"region=e\\"u"} refused', config), 'config {"q":"redacted"} refused');
  const short = cfg({ url: 'wss://b%22t:p%22w@h/mcp' });
  assert.equal(redactServerText('dial {"url":"wss://b\\"t:p\\"w@h/mcp"} failed', short), 'dial {"url":"wss://redacted@h/mcp"} failed');
});

test('recorded server text: a pair or userinfo unit after a JSON escape goes, as after the control character it stands for', () => {
  const config = cfg({ url: 'wss://bot:pw@h/mcpl?key=abc' });
  for (const escape of ['\\n', '\\t', '\\r', '\\b', '\\f', '\\u000b']) {
    assert.equal(redactServerText(`{"said":"bad${escape}key=abc"}`, config), `{"said":"bad${escape}redacted"}`, escape);
    assert.equal(redactServerText(`{"said":"dial${escape}bot:pw@h"}`, config), `{"said":"dial${escape}redacted@h"}`, escape);
  }
  // A letter or digit that's text, not an escape's end, still adjoins it.
  assert.equal(redactServerText('monkey=abc', config), 'monkey=abc');
  assert.equal(redactServerText('robot:pw@h', config), 'robot:pw@h');
  // The case a JSON value's text makes: a string with a newline before the pair.
  assert.equal(logValueRedacted({ said: 'bad\nkey=abc' }, (text) => redactServerText(text, config)), '"{\\"said\\":\\"bad\\\\nredacted\\"}"');
});

test('recorded server text: the floor applies to each form, so a seven-character token goes in its eight-character JSON form', () => {
  const config = cfg({ token: 'ab"cdef' });
  assert.equal(redactServerText('refused: ab"cdef', config), 'refused: ab"cdef');
  assert.equal(redactServerText('refused: ab\\"cdef', config), 'refused: redacted');
});

test("a JSON value logged through logValueRedacted keeps no url credential, though its JSON text escapes the credential's quote", () => {
  const config = cfg({ url: 'wss://h/mcpl?password=secret%22key123' });
  const line = logValueRedacted({ said: 'secret"key123' }, (text) => redactServerText(text, config));
  assert.equal(line, '"{\\"said\\":\\"redacted\\"}"');
});

test("one redactor over several configurations' strings takes the longest secret among them all", () => {
  const short = cfg({ id: 'a', token: 'ghp_SHAREDPREFIX123' });
  const long = cfg({ id: 'b', token: 'ghp_SHAREDPREFIX123_but_longer_TAIL9' });
  const redact = credentialRedactor([...serverCredentialPatterns(short), ...serverCredentialPatterns(long)]);
  assert.equal(redact('auth failed for ghp_SHAREDPREFIX123_but_longer_TAIL9'), 'auth failed for redacted');
  assert.equal(redact('auth failed for ghp_SHAREDPREFIX123'), 'auth failed for redacted');
  assert.equal(credentialRedactor([])('nothing to replace'), 'nothing to replace');
});

test("one redactor over several configurations' strings replaces strings that overlap, both whole", () => {
  // The first's end is the second's start.
  const head = cfg({ id: 'a', token: 'XXXXXXXXYYYY' });
  const tail = cfg({ id: 'b', token: 'YYYYZZZZZZZZ' });
  const redact = credentialRedactor([...serverCredentialPatterns(head), ...serverCredentialPatterns(tail)]);
  assert.equal(redact('auth failed for XXXXXXXXYYYYZZZZZZZZ.'), 'auth failed for redacted.');
  assert.equal(redact('XXXXXXXXYYYY and YYYYZZZZZZZZ'), 'redacted and redacted');
  // Strings next to each other, not overlapping, are each replaced, as before.
  assert.equal(redact('XXXXXXXXYYYYYYYYZZZZZZZZ'), 'redactedredacted');
});

test('recorded server text uses longest-first, one-pass replacements and is idempotent', () => {
  const config = cfg({ url: 'https://h/mcp?secret=token0123456789-tail&redacted=eu', token: 'token0123456789' });
  const original = 'secret=token0123456789-tail token0123456789 redacted=eu queue full';
  const clean = redactServerText(original, config);
  assert.equal(clean, 'redacted redacted redacted queue full');
  assert.equal(redactServerText('token0123456789-tail', config), 'redacted');
  assert.equal(redactServerText(clean, config), clean);
});
