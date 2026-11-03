/**
 * What the MCPL lanes tell an agent, from the error-wording sweep: an MCPL
 * request that fails says whether it took effect, the framework's refusals of
 * an MCPL tool call say whether the call ran and what can change that, and a
 * block the host can't show says what kind of thing it was and why.
 *
 * Run: node --import tsx --test test/mcpl-agent-words.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentFramework } from '../src/framework.js';
import {
  AUDIO_NO_DATA_TEXT,
  AUDIO_NO_MEDIA_TYPE_TEXT,
  IMAGE_NO_DATA_TEXT,
  IMAGE_NO_MEDIA_TYPE_TEXT,
  INLINE_WITHHELD_TEXT,
  REFERENCE_LIMITS,
  REFERENCE_LINK_TOO_LONG_TEXT,
  REFERENCE_NO_LINK_TEXT,
  referenceStubOrNull,
} from '../src/mcpl/references.js';
import { convertBlock } from '../src/mcpl/convert-block.js';
import { toolResultDataToHistoryString } from '../src/tool-result-history.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { McplTransport } from '../src/mcpl/transport.js';
import { WITHHELD_TEXT } from '../src/mcpl/protocol-family.js';
import { logValue } from '../src/mcpl/log-value.js';
import type { McplHostCapabilities, McplServerConfig } from '../src/mcpl/types.js';

// ---------------------------------------------------------------------------
// Blocks the host can't show
// ---------------------------------------------------------------------------

test("the words that stand in for a block the host can't show, which other tests take from the constants", () => {
  assert.deepEqual(
    [IMAGE_NO_MEDIA_TYPE_TEXT, IMAGE_NO_DATA_TEXT, AUDIO_NO_MEDIA_TYPE_TEXT, AUDIO_NO_DATA_TEXT, REFERENCE_NO_LINK_TEXT, REFERENCE_LINK_TOO_LONG_TEXT, INLINE_WITHHELD_TEXT],
    [
      '[Image not shown: its data arrived without a media type.]',
      '[Image not shown: it arrived with no usable data or link.]',
      '[Audio not shown: its data arrived without a media type.]',
      '[Audio not shown: it arrived with no usable inline data.]',
      '[Reference not shown: it arrived without a link.]',
      '[Reference not shown: its link is longer than this host accepts.]',
      '[Content not shown: its inline data arrived marked as a reference too, so this host withheld it.]',
    ],
  );
});

test("a reference block that can't be read says which part is missing, and what isn't a block says it can't be read", () => {
  assert.equal(referenceStubOrNull({ type: 'resource', uri: 'u'.repeat(REFERENCE_LIMITS.uri + 1) }), REFERENCE_LINK_TOO_LONG_TEXT);
  assert.equal(referenceStubOrNull({ type: 'resource' }), REFERENCE_NO_LINK_TEXT);
  assert.equal(referenceStubOrNull(424242), "[Content not shown: a part arrived in a form this host can't read.]");
  assert.equal(referenceStubOrNull({ type: 'hologram\u0007' }), `[Content not shown: this host can't display "hologram" content.]`);
  assert.equal(referenceStubOrNull({ type: '\u0007' }), '[Content not shown: a part arrived with no type.]');
  assert.equal(referenceStubOrNull({ type: 42 }), '[Content not shown: a part arrived with no type.]');
  // An empty link is no link: the tool-result lane says what the push lane's
  // converter says for the same block.
  for (const [block, text] of [[{ type: 'image', uri: '' }, IMAGE_NO_DATA_TEXT], [{ type: 'audio', uri: '' }, AUDIO_NO_DATA_TEXT]] as const) {
    assert.equal(referenceStubOrNull(block), text);
    assert.deepEqual(convertBlock(block as never, 'test', 'words'), { type: 'text', text });
  }
  // Beside inline data, an empty link is no link either, now that the
  // tool-result lane gives every inline shape its marker: this audio shows as
  // a tool result's audio does, and its data stays out of history.
  const audio = { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav', uri: '' };
  const stored = toolResultDataToHistoryString([{ type: 'text', text: 't' }, audio]);
  assert.equal(stored, "t\n[Audio not shown: this host's tool results carry only text and images (audio/wav, 6B).]");
  // A link that isn't empty still withholds it.
  assert.equal(toolResultDataToHistoryString([{ ...audio, uri: 'https://zz.example/a.wav' }]), INLINE_WITHHELD_TEXT);
});

// ---------------------------------------------------------------------------
// An MCPL request that fails
// ---------------------------------------------------------------------------

// Stdio server: answers initialize and tools/list; tools/call "refuse" gets a
// JSON-RPC error, "mute" one with a blank message, "odd" one whose message
// isn't a string, "echo-token" one whose message echoes its API_TOKEN,
// "echo-token-object" one whose message is an object holding it, "exit"
// ends the process with the call pending,
// "answer-then-exit" answers and then ends it, and "hang" is never answered.
const SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n');
    if (m.method === 'initialize') send({ result: { protocolVersion: '2024-11-05', capabilities: {} } });
    else if (m.method === 'tools/list') send({ result: { tools: [] } });
    else if (m.method === 'tools/call' && m.params.name === 'refuse') send({ error: { code: -32000, message: 'Missing Access' } });
    else if (m.method === 'tools/call' && m.params.name === 'mute') send({ error: { code: -32000, message: '  ' } });
    else if (m.method === 'tools/call' && m.params.name === 'odd') send({ error: { code: -32000, message: 42 } });
    else if (m.method === 'tools/call' && m.params.name === 'echo-token') send({ error: { code: -32000, message: 'bad token ' + process.env.API_TOKEN } });
    else if (m.method === 'tools/call' && m.params.name === 'echo-token-object') send({ error: { code: -32000, message: { said: 'bad token ' + process.env.API_TOKEN } } });
    else if (m.method === 'tools/call' && m.params.name === 'answer-then-exit') { send({ result: { content: [] } }); setTimeout(() => process.exit(0), 50); }
    else if (m.method === 'tools/call' && m.params.name === 'exit') process.exit(3);
  }
});
setInterval(() => {}, 1 << 30);
`;

const HOST_CAPS: McplHostCapabilities = { version: '0.4', pushEvents: true, contextHooks: { beforeInference: true }, featureSets: true };
const config = (overrides: Partial<McplServerConfig> = {}): McplServerConfig =>
  ({ id: 'words', command: process.execPath, args: ['-e', SERVER], ...overrides });

/** `promise`, or a failure naming `what` after five seconds, so a regression fails rather than hangs. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${what} within 5 s`)), 5000); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

/** What a server's error answer with no words reads as. */
const NO_WORDS = 'The "words" server answered with an error without saying what went wrong, so whether the request took effect is unknown. ' +
  'Check its effect before trying again.';

/** Whether some console.error line matches. */
const logged = (calls: ReadonlyArray<{ arguments: unknown[] }>, line: RegExp): boolean =>
  calls.some((call) => line.test(String(call.arguments[0])));

test("a server's error answer is shown as the server's, and its method, id and code go to the log", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const connection = await McplServerConnection.connect(config(), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  await assert.rejects(connection.sendToolsCall('refuse', {}),
    { message: 'The "words" server answered with an error: Missing Access' });
  assert.ok(logged(errors.mock.calls, /^MCPL server "words" answered tools\/call \(id=\d+\) with error -32000: /), 'the operator log has the answer');
  // An answer with no words says so, rather than ending on a colon.
  await assert.rejects(connection.sendToolsCall('mute', {}),
    { message: NO_WORDS });
  // A message that isn't a string reads the same, and the log keeps what was sent.
  await assert.rejects(connection.sendToolsCall('odd', {}),
    { message: NO_WORDS });
  assert.ok(logged(errors.mock.calls, /^MCPL server "words" answered tools\/call \(id=\d+\) with error -32000: 42$/), 'the log has the number');
});

test("a server's error answer that echoes a credential reaches the caller and the log redacted", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const token = 'tok-0123456789abcdef';
  const connection = await McplServerConnection.connect(config({ env: { API_TOKEN: token } }), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  // The server's words are in an error the caller gets, so a credential
  // its configuration holds leaves them (redactServerText's scope).
  await assert.rejects(connection.sendToolsCall('echo-token', {}),
    { message: 'The "words" server answered with an error: bad token redacted' });
  // The log is a record of the server's text, so the credential leaves it,
  // in a message of any JSON value.
  await assert.rejects(connection.sendToolsCall('echo-token-object', {}), { message: NO_WORDS });
  const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged(errors.mock.calls, /^MCPL server "words" answered tools\/call \(id=\d+\) with error -32000: "bad\\u0020token\\u0020redacted"$/), lines.join('\n'));
  assert.ok(lines.some((line) => line.endsWith('with error -32000: "{\\"said\\":\\"bad\\u0020token\\u0020redacted\\"}"')), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes(token)), 'no log line has the token');
});

test("an error answer whose configuration can't be read settles its call, and its error and its log line withhold the server's text", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  // A stdio server's env, as the framework gives it, is a getter, which
  // throws once the reaction baseline's ledger can't be read.
  let unreadable = false;
  const withGetter = config();
  Object.defineProperty(withGetter, 'env', {
    enumerable: true,
    get: () => { if (unreadable) throw new Error('reaction-baseline ledger unreadable'); return {}; },
  });
  const connection = await McplServerConnection.connect(withGetter, HOST_CAPS);
  t.after(() => { unreadable = false; return connection.close(); });
  connection.ready();
  unreadable = true;
  await within(assert.rejects(connection.sendToolsCall('refuse', {}),
    { message: `The "words" server answered with an error: ${WITHHELD_TEXT}` }), 'settled call');
  const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(!lines.some((line) => line.includes('Missing')), lines.join('\n'));
  assert.ok(lines.some((line) => /^MCPL server "words" answered tools\/call \(id=\d+\) with error -32000: /.test(line) && line.endsWith(logValue(WITHHELD_TEXT))), lines.join('\n'));
});

test("a request JSON can't write is refused before anything is kept for it: not sent, in the modern engine's words (#556)", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const connection = await McplServerConnection.connect(config(), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const args of [{ n: 1n }, cyclic]) {
    await assert.rejects(connection.sendToolsCall('refuse', args), {
      outcome: 'not-sent',
      message: 'The request wasn\'t sent: this host couldn\'t send it to the "words" server, so nothing ran. If calling it again fails, ask whoever runs this host.',
    });
  }
  assert.equal((connection as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size, 0, 'nothing kept pending');
  assert.ok(logged(errors.mock.calls, /^MCPL server "words": tools\/call \(id=\d+\) not sent, since it can't be written as JSON: "Do not know how to serialize a BigInt"$/),
    errors.mock.calls.map((call) => String(call.arguments[0])).join('\n'));
});

test("a request refused as not sent is refused through its promise when the host's logger throws (#556)", async (t) => {
  t.mock.method(console, 'error', () => { throw new Error('the logger is down'); });
  class PipeTransport extends McplTransport {
    constructor() { super(); }
    readonly kind = 'stdio' as const;
    failed: Error | undefined;
    writeFails: Error | undefined;
    override get stdioStopCause(): Error | undefined { return this.failed; }
    writeLine(): void { if (this.writeFails) throw this.writeFails; }
    async close(): Promise<void> {}
  }
  const transport = new PipeTransport();
  const connection = new (McplServerConnection as any)('words', null, transport) as McplServerConnection;
  let refused: Promise<unknown> | undefined;
  // Arguments JSON can't write.
  assert.doesNotThrow(() => { refused = connection.sendToolsCall('refuse', { n: 1n }); });
  await assert.rejects(refused!, { outcome: 'not-sent' });
  // A write the transport refuses at once.
  transport.writeFails = new Error('the stream is destroyed');
  assert.doesNotThrow(() => { refused = connection.sendToolsCall('refuse', {}); });
  await assert.rejects(refused!, { outcome: 'not-sent' });
  // A stdio pipe that has failed, with nothing else to refuse the write.
  transport.writeFails = undefined;
  transport.failed = new Error('write EPIPE');
  assert.doesNotThrow(() => { refused = connection.sendToolsCall('refuse', {}); });
  await assert.rejects(refused!, { outcome: 'not-sent' });
});

test("error answers read their connection's configuration once each until a read succeeds, and not after (#540's review, R1-2)", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  // A stdio server's env, as the framework gives it, is a getter, which reads
  // the reaction baseline's ledger from disk each time, and throws while the
  // ledger can't be read.
  let reads = 0;
  let unreadable = false;
  const counted = config();
  Object.defineProperty(counted, 'env', {
    enumerable: true,
    get: () => { reads++; if (unreadable) throw new Error('reaction-baseline ledger unreadable'); return {}; },
  });
  const connection = await McplServerConnection.connect(counted, HOST_CAPS);
  t.after(() => { unreadable = false; return connection.close(); });
  connection.ready();
  const refused = (words = 'Missing Access') => assert.rejects(connection.sendToolsCall('refuse', {}), { message: `The "words" server answered with an error: ${words}` });
  const answerLines = () => errors.mock.calls.map((call) => String(call.arguments[0])).filter((line) => / answered tools\/call /.test(line));
  // While the ledger can't be read, each answer's words and line are
  // withheld, each answer reads it once, and the next answer reads it again.
  unreadable = true;
  let before = reads;
  await refused(WITHHELD_TEXT);
  await refused(WITHHELD_TEXT);
  assert.equal(reads - before, 2);
  assert.ok(answerLines().every((line) => line.endsWith(logValue(WITHHELD_TEXT))), answerLines().join('\n'));
  // Once a read succeeds, the redaction it built is kept.
  unreadable = false;
  before = reads;
  for (let i = 0; i < 3; i++) await refused();
  assert.equal(reads - before, 1, 'read for the first of these answers only');
  assert.ok(answerLines().at(-1)!.includes('Missing'), answerLines().join('\n'));
});

test("an error answer settles its call when writing its log line throws", async (t) => {
  // A host's logger can throw. The call's entry and timer are gone by the
  // time the line is written, so nothing else would settle it.
  const errors = t.mock.method(console, 'error', (line: unknown) => {
    if (String(line).includes(' answered tools/call ')) throw new Error('the logger is down');
  });
  const connection = await McplServerConnection.connect(config(), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  await within(assert.rejects(connection.sendToolsCall('refuse', {}),
    { message: 'The "words" server answered with an error: Missing Access' }), 'settled call');
  const lines = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(lines.some((line) => /inbound dispatch failed .*the logger is down/.test(line)), lines.join('\n'));
});

test("a server that drops with a call pending says the outcome is unknown, and whether it's coming back", async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const once = await McplServerConnection.connect(config(), HOST_CAPS);
  t.after(() => once.close());
  once.ready();
  await assert.rejects(once.sendToolsCall('exit', {}), {
    message: 'The connection to the "words" server closed before it answered, so whether the request took effect is unknown. ' +
      "This host won't reconnect to it on its own. If you need it, ask whoever runs this host.",
  });
  // The close's details are the operator's: they go to the log.
  assert.ok(logged(errors.mock.calls, /^MCPL server "words" disconnected \(code=.*\) with 1 request\(s\) unanswered: tools\/call \(id=\d+\)$/),
    'the operator log has the close');
  await assert.rejects(once.sendToolsCall('refuse', {}), {
    message: `The request wasn't sent: the connection to the "words" server is closed, so nothing ran. This host won't reconnect to it on its own. If you need it, ask whoever runs this host.`,
  });

  const again = await McplServerConnection.connectWithReconnect(config({ reconnect: true, reconnectIntervalMs: 600_000 }), HOST_CAPS);
  t.after(() => again.close());
  again.ready();
  await assert.rejects(again.sendToolsCall('exit', {}), {
    message: 'The connection to the "words" server closed before it answered, so whether the request took effect is unknown. ' +
      'Check its effect before trying again; this host is reconnecting to it.',
  });
  await assert.rejects(again.sendToolsCall('refuse', {}), {
    message: `The request wasn't sent: the connection to the "words" server is closed, so nothing ran. This host is reconnecting to it; try again later.`,
  });
});

test('a call pending when this host recycles the connection reads as a closed connection, and the log says the host closed it', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const connection = await McplServerConnection.connectWithReconnect(config({ reconnect: true, reconnectIntervalMs: 600_000 }), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  const pending = assert.rejects(connection.sendToolsCall('hang', {}), {
    message: 'The connection to the "words" server closed before it answered, so whether the request took effect is unknown. ' +
      'Check its effect before trying again; this host is reconnecting to it.',
  });
  await connection.reconnectAfterFailure();
  await pending;
  assert.ok(logged(errors.mock.calls, /^MCPL server "words" disconnected \(closed by this host, code=.*, signal=.*, reason=.*\) with 1 request\(s\) unanswered: tools\/call \(id=\d+\)$/),
    'the operator log says the host closed it, and keeps the close\'s details');
});

test('a timeout of one second says so in the singular', async (t) => {
  t.mock.method(console, 'error', () => {});
  const connection = await McplServerConnection.connect(config({ requestTimeoutMs: 1000 }), HOST_CAPS);
  t.after(() => connection.close());
  connection.ready();
  await assert.rejects(connection.sendToolsCall('hang', {}), (error: Error) => {
    assert.match(error.message, /^The "words" server didn't answer within 1 second, so whether the request took effect is unknown: /);
    return true;
  });
});

test('a connection that closes with nothing pending logs nothing new, by this host or by the server', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const byHost = await McplServerConnection.connect(config(), HOST_CAPS);
  byHost.ready();
  await byHost.close();
  const dropped = await McplServerConnection.connect(config(), HOST_CAPS);
  t.after(() => dropped.close());
  dropped.ready();
  const closed = new Promise<void>((resolve) => { dropped.once('close', () => resolve()); });
  await dropped.sendToolsCall('answer-then-exit', {});
  await within(closed, 'the server to exit');
  assert.ok(!logged(errors.mock.calls, /unanswered/), errors.mock.calls.map((call) => String(call.arguments[0])).join('\n'));
});

test('a call pending when this host closes the connection says the outcome is unknown, and the log names it', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const connection = await McplServerConnection.connect(config(), HOST_CAPS);
  connection.ready();
  // No word on reconnecting: a restart closes the connection, then connects again.
  const unknown = {
    message: `The "words" server didn't answer before this host closed its connection, so whether the request took effect is unknown. ` +
      'Check its effect before trying again.',
  };
  const pending = [assert.rejects(connection.sendToolsCall('hang', {}), unknown), assert.rejects(connection.sendToolsCall('hang', {}), unknown)];
  await connection.close();
  await Promise.all(pending);
  // A request after the close isn't told whether the server comes back either.
  await assert.rejects(connection.sendToolsCall('refuse', {}), {
    message: `The request wasn't sent: this host closed its connection to the "words" server, so nothing ran. ` +
      'If calling it again fails, ask whoever runs this host.',
  });
  assert.ok(logged(errors.mock.calls, /^MCPL server "words": this host closed its connection with 2 request\(s\) unanswered: tools\/call \(id=(\d+)\), tools\/call \(id=(?!\1\))\d+\)$/),
    'the operator log has both requests');
});

// ---------------------------------------------------------------------------
// The framework's MCPL tool calls, and a conversation's channel guard
// ---------------------------------------------------------------------------

type ToolResultEvent = { type: string; result?: { success: boolean; error?: string; isError?: boolean } };

/** A framework with only what dispatching an MCPL tool call reads. */
function frameworkWith(server: unknown, config: Record<string, unknown> = {}) {
  const events: ToolResultEvent[] = [];
  let resolve!: () => void;
  const delivered = new Promise<void>((r) => { resolve = r; });
  const framework = Object.create(AgentFramework.prototype) as Record<string, unknown> & {
    dispatchMcplToolCall(agentName: string, call: { id: string; name: string; input: unknown }, serverId: string, prefix: string): void;
    executeMcplToolCall(call: { id: string; name: string; input: unknown }, serverId: string, prefix: string): Promise<{ error?: string }>;
    dispatchChannelToolCall(agentName: string, call: { id: string; name: string; input: unknown }): void;
  };
  framework.mcplServerRegistry = { getServer: () => server };
  framework.mcplServerConfigs = new Map([['words', { id: 'words', ...config }]]);
  framework.emitTrace = () => {};
  framework.pushEvent = (event: ToolResultEvent) => { events.push(event); if (event.type === 'tool-result') resolve(); };
  return { framework, events, delivered };
}

test("an MCPL tool call refused before it runs says it didn't run, and whether anything can change that", async () => {
  const gone = frameworkWith(null);
  gone.framework.dispatchMcplToolCall('agent', { id: 'c1', name: 'words--lookup', input: {} }, 'words', 'words');
  // A server missing from the registry was closed for good, removed, or its connect failed without reconnect.
  assert.equal(gone.events[0]?.result?.error, `The "words" server that provides words--lookup isn't connected, ` +
    "and this host won't reconnect to it on its own, so the call didn't run. If you need it, ask whoever runs this host.");
  assert.equal((await gone.framework.executeMcplToolCall({ id: 'c2', name: 'words--lookup', input: {} }, 'words', 'words')).error,
    gone.events[0]?.result?.error, "a script's call reads the same");

  const denied = frameworkWith({}, { disabledTools: ['lookup'] });
  denied.framework.dispatchMcplToolCall('agent', { id: 'c3', name: 'words--lookup', input: {} }, 'words', 'words');
  const deniedText = `words--lookup isn't allowed by this host's policy for the "words" server, so the call didn't run, ` +
    "and calling it again won't change that. If you need it, ask whoever runs this host.";
  assert.equal(denied.events[0]?.result?.error, deniedText);
  assert.equal((await denied.framework.executeMcplToolCall({ id: 'c4', name: 'words--lookup', input: {} }, 'words', 'words')).error, deniedText);
});

test("a call while this host connects to the tool's server says so, and after a connect that failed, that the server's gone", async () => {
  // A runtime connect or a restart's maps the server's prefix, so its tool
  // calls route to it, then awaits addServer, which registers the server once
  // the handshake is done. Each handshake here waits for the test.
  const servers = new Map<string, unknown>();
  const handshakes: Array<(ok: boolean) => void> = [];
  const { framework, events } = frameworkWith(null);
  Object.assign(framework, {
    mcplServerRegistry: {
      getServer: (id: string) => servers.get(id) ?? null,
      addServer: (cfg: { id: string }) => new Promise((resolve, reject) => {
        handshakes.push((ok) => {
          if (!ok) return reject(new Error('handshake refused'));
          const connection = { on: () => {} };
          servers.set(cfg.id, connection);
          resolve(connection);
        });
      }),
    },
    mcplHostCapabilities: {},
    mcplPrefixMap: new Map(),
    mcplServerConfigs: new Map(),
    channelRegistry: null,
    discordAwarenessOutbox: null,
    discordAwarenessEmoji: '🔕',
    mcplPolicyExchanges: new WeakMap(),
    wireMcplEvents: () => {},
    registerMcplServerFeatures: async () => {},
  });
  const connect = (framework as unknown as {
    connectMcplServerInternal(config: McplServerConfig, deferAwareness?: boolean): Promise<void>;
  }).connectMcplServerInternal.bind(framework);
  const call = (id: string) => ({ id, name: 'words--lookup', input: {} });
  const settle = () => new Promise<void>((r) => setImmediate(r));

  const connecting = connect({ id: 'words', url: 'ws://127.0.0.1:9', toolPrefix: 'words' }, true);
  await settle();
  assert.equal(handshakes.length, 1, 'the handshake has begun');
  framework.dispatchMcplToolCall('agent', call('c1'), 'words', 'words');
  const connectingText = 'This host is connecting to the "words" server that provides words--lookup, so the call didn\'t run. Try again in a moment.';
  assert.equal(events[0]?.result?.error, connectingText);
  assert.equal((await framework.executeMcplToolCall(call('c2'), 'words', 'words')).error, connectingText, "a script's call reads the same");
  // Only the server being connected to reads so: another one missing is gone.
  framework.dispatchMcplToolCall('agent', { id: 'c3', name: 'other--lookup', input: {} }, 'other', 'other');
  assert.equal(events[1]?.result?.error, 'The "other" server that provides other--lookup isn\'t connected, ' +
    "and this host won't reconnect to it on its own, so the call didn't run. If you need it, ask whoever runs this host.");
  handshakes[0]!(true);
  await connecting;

  // The mark goes when the connect succeeds: once the server is gone, a call reads so.
  servers.clear();
  const goneText = 'The "words" server that provides words--lookup isn\'t connected, ' +
    "and this host won't reconnect to it on its own, so the call didn't run. If you need it, ask whoever runs this host.";
  framework.dispatchMcplToolCall('agent', call('c4'), 'words', 'words');
  assert.equal(events[2]?.result?.error, goneText, 'after a connect that succeeded');

  // A connect that fails without reconnect leaves the server unregistered, which nothing brings back.
  const failing = connect({ id: 'words', url: 'ws://127.0.0.1:9', toolPrefix: 'words' }, true);
  await settle();
  handshakes[1]!(false);
  await assert.rejects(failing, /handshake refused/);
  framework.dispatchMcplToolCall('agent', call('c5'), 'words', 'words');
  assert.equal(events[3]?.result?.error, goneText, 'after a connect that failed');
  assert.equal((await framework.executeMcplToolCall(call('c6'), 'words', 'words')).error, goneText, "a script's call reads the same");
});

test('a call while a modern connect is under way reads the connecting text on both paths; once its session is up, the call goes to it', async () => {
  // A modern connect registers its connection before it starts, so the
  // connection is there while the connect holds the id.
  const { framework, events } = frameworkWith(null);
  const reached: string[] = [];
  const modern = {
    id: 'words',
    isConnected: false,
    callTool: async (name: string) => { reached.push(name); return { content: [{ type: 'text', text: 'ran' }] }; },
  };
  Object.assign(framework, {
    modernMcpConnections: new Map([['words', modern]]),
    mcpServerOps: new Map([['words', { kind: 'connect', settled: new Promise<void>(() => {}) }]]),
  });
  const call = (id: string) => ({ id, name: 'words--lookup', input: {} });
  const connectingText = 'This host is connecting to the "words" server that provides words--lookup, so the call didn\'t run. Try again in a moment.';
  framework.dispatchMcplToolCall('agent', call('m1'), 'words', 'words');
  assert.equal(events[0]?.result?.error, connectingText);
  assert.equal((await framework.executeMcplToolCall(call('m2'), 'words', 'words')).error, connectingText, "a script's call reads the same");
  assert.deepEqual(reached, [], 'neither reached the connection');
  // Its first session is up while the connect still lists its tools: a call goes to it.
  modern.isConnected = true;
  const ran = await framework.executeMcplToolCall(call('m3'), 'words', 'words') as { success?: boolean };
  assert.equal(ran.success, true);
  assert.deepEqual(reached, ['lookup']);
});

test('a second connect, or a restart into the id, of a server whose connect is in flight is refused in these words before it writes anything', async () => {
  // The connect's hold on the id (mcpServerIdTaken) says the id is taken in
  // these words for as long as the connect runs: through its handshake, and
  // after the registry has taken the server, while the connect sets it up.
  // Each handshake, and the setup after it, waits for the test. A disconnect
  // isn't refused: it ends the connect, as mcp-server-ownership's tests of a
  // disconnect during a legacy handshake and during a modern connect pin.
  const servers = new Map<string, unknown>();
  const handshakes: Array<() => void> = [];
  let setUp!: () => void;
  const settingUp = new Promise<void>((r) => { setUp = r; });
  const { framework } = frameworkWith(null);
  Object.assign(framework, {
    mcplServerRegistry: {
      getServer: (id: string) => servers.get(id) ?? null,
      addServer: (cfg: { id: string }) => new Promise((resolve) => {
        handshakes.push(() => {
          const connection = { on: () => {}, isConnected: true, willReconnect: false };
          servers.set(cfg.id, connection);
          resolve(connection);
        });
      }),
    },
    moduleRegistry: { getAllModules: () => [] },
    mcplHostCapabilities: {},
    mcplPrefixMap: new Map(),
    mcplServerConfigs: new Map(),
    channelRegistry: null,
    discordAwarenessOutbox: null,
    discordAwarenessEmoji: '🔕',
    mcplPolicyExchanges: new WeakMap(),
    wireMcplEvents: () => {},
    registerMcplServerFeatures: () => settingUp,
  });
  const fw = framework as unknown as {
    connectMcplServerInternal(config: McplServerConfig, deferAwareness?: boolean): Promise<unknown>;
    mcpServerIdTaken(id: string, claim?: unknown, restarting?: string): string | null;
  };
  const words = { id: 'words', url: 'ws://127.0.0.1:9', toolPrefix: 'words' } as McplServerConfig;
  const connecting = fw.connectMcplServerInternal(words, true);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(handshakes.length, 1, 'the handshake has begun');
  const inFlight = 'MCPL server "words" has a connect in flight; try again once it settles';
  await assert.rejects(fw.connectMcplServerInternal(words, true), { message: inFlight }, 'a second connect of it');
  assert.equal(handshakes.length, 1, 'the refused connect began no handshake');
  assert.equal(fw.mcpServerIdTaken('words', undefined, 'other'), `MCP server "other" was not restarted: ${inFlight}`,
    'a restart of another server into its id');
  handshakes[0]!();
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(servers.has('words'), 'the registry has taken the server');
  await assert.rejects(fw.connectMcplServerInternal(words, true), { message: inFlight }, 'a second connect while the first sets the server up');
  setUp();
  await connecting;
  // Once the connect settles, the registered server holds the id.
  assert.equal(fw.mcpServerIdTaken('words'), 'MCPL server "words" is already registered');
});

test("an MCPL tool's error result with no words says so, and that its effect is unknown", async () => {
  const silent = frameworkWith({ sendToolsCall: async () => ({ isError: true, content: [] }) });
  silent.framework.dispatchMcplToolCall('agent', { id: 'c1', name: 'words--lookup', input: {} }, 'words', 'words');
  await within(silent.delivered, 'the tool result');
  const result = silent.events.find((event) => event.type === 'tool-result')!.result!;
  assert.equal(result.isError, true);
  assert.equal(result.error, `The "words" server reported an error for words--lookup without saying what went wrong. ` +
    'Whether it did anything is unknown: check before calling it again.');
});

test("a conversation bound to its channel is told it can't open another, and where to reply", () => {
  const { framework, events } = frameworkWith(null);
  framework.registry = { homeChannel: (name: string) => (name === 'fork' ? { serverId: 'srv', channelId: 'home-1' } : undefined), list: () => [] };
  framework.toolLifecycleEmitter = undefined;
  framework.dispatchChannelToolCall('fork', { id: 'c1', name: 'channel_open', input: { channelId: 'elsewhere' } });
  assert.equal(events[0]?.result?.error,
    `This conversation is bound to channel "home-1", so it can't open other channels, and nothing was opened. Reply in "home-1".`);
});
