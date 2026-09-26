/**
 * Prose outbox (FrameworkConfig.proseOutbox): plain speech whose publish
 * fails transiently is kept, retried in order without double posts, and
 * given up honestly.
 *
 * The wire tests drive a REAL McplServerConnection against a stdio server
 * that simulates a chat platform: it appends every post to a log file, can
 * post and then never answer (the timed-out-but-posted case behind lost and
 * duplicated replies), and can dedupe by idempotencyKey.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { classifyPublishError, type OutboxEvent } from '../src/mcpl/prose-outbox.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { McplHostCapabilities } from '../src/mcpl/types.js';

// ---------------------------------------------------------------------------
// Simulated platform server
// ---------------------------------------------------------------------------

/** argv: <postLog> <modeFile>. Mode (re-read per request): "ok", "hang"
 *  (post, never answer). "idem" in the mode enables key dedupe + echo. */
const PLATFORM_SERVER = `
const fs = require('node:fs');
const [postLog, modeFile] = process.argv.slice(1);
const seen = new Map();
let buf = '', n = 0;
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') { reply({ capabilities: {} }); continue; }
    if (m.method !== 'channels/publish') { if (m.id !== undefined) reply({}); continue; }
    const mode = fs.readFileSync(modeFile, 'utf8');
    const key = m.params.idempotencyKey;
    const idem = mode.includes('idem');
    if (idem && key && seen.has(key)) { reply({ delivered: true, messageId: seen.get(key), idempotencyKey: key }); continue; }
    const id = 'msg-' + (++n);
    fs.appendFileSync(postLog, JSON.stringify({ id, text: m.params.content[0].text, key, writtenAt: m.params.writtenAt }) + '\\n');
    if (idem && key) seen.set(key, id);
    if (mode.startsWith('hang')) continue; // posted, but the answer never comes
    reply({ delivered: true, messageId: id, ...(idem && key ? { idempotencyKey: key } : {}) });
  }
});
setInterval(() => {}, 1 << 30);
`;

const HOST_CAPS: McplHostCapabilities = { version: '0.5', pushEvents: true, featureSets: true } as McplHostCapabilities;
const FULL_GRANT = () => new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prose-outbox-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Harness {
  registry: ChannelRegistry;
  failures: Array<{ reason: string; mayHaveArrived?: boolean }>;
  events: OutboxEvent[];
  setServer(server: unknown): void;
  clock: { t: number };
}

function makeRegistry(opts: {
  server: unknown;
  outbox?: { enabled: boolean; path?: string; maxAgeMs?: number; noticeMaxAgeMs?: number; maxEntriesPerAgent?: number };
  channels?: string[];
  clock?: { t: number };
}): Harness {
  let server = opts.server;
  const clock = opts.clock ?? { t: Date.parse('2026-09-25T12:00:00Z') };
  const failures: Harness['failures'] = [];
  const events: OutboxEvent[] = [];
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    {
      onRouteFailure: (info) => { failures.push(info); },
      ...(opts.outbox ? { proseOutbox: opts.outbox, onOutboxEvent: (e: OutboxEvent) => { events.push(e); } } : {}),
      now: () => clock.t,
    },
  );
  cleanups.push(() => registry.stopAll());
  const channels = (registry as unknown as {
    channels: Map<string, { serverId: string; descriptor: { id: string; type: string; label: string }; open: boolean }>;
  }).channels;
  for (const id of opts.channels ?? ['chat:1']) {
    channels.set(`chat:${id}`, { serverId: 'chat', descriptor: { id, type: 'chat', label: id }, open: true });
  }
  return { registry, failures, events, setServer: (s) => { server = s; }, clock };
}

async function platform(mode: string, timeoutMs = 300) {
  const dir = tempDir();
  const postLog = join(dir, 'posts.jsonl');
  const modeFile = join(dir, 'mode');
  writeFileSync(modeFile, mode);
  const connect = async () => {
    const conn = await McplServerConnection.connect(
      { id: 'chat', command: process.execPath, args: ['-e', PLATFORM_SERVER, postLog, modeFile], requestTimeoutMs: timeoutMs },
      HOST_CAPS,
    );
    conn.ready();
    (conn as unknown as { grant: CapabilityGrant }).grant = FULL_GRANT();
    cleanups.push(() => conn.close());
    return conn;
  };
  return {
    connect,
    setMode: (m: string) => writeFileSync(modeFile, m),
    posts: (): Array<{ id: string; text: string; key?: string; writtenAt?: string }> =>
      existsSync(postLog) ? readFileSync(postLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
  };
}

// ---------------------------------------------------------------------------
// Wire tests (real connection)
// ---------------------------------------------------------------------------

test('without the outbox, a timed-out publish no longer escapes: marked "may have arrived"', async () => {
  const p = await platform('hang');
  const h = makeRegistry({ server: await p.connect() });
  const result = await h.registry.routeSpeech('agent', 'hello', 'chat:1');
  assert.equal(result, null);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0]!.reason, /did not respond to channels\/publish/);
  assert.equal(h.failures[0]!.mayHaveArrived, true);
  assert.equal(p.posts().length, 1, 'the platform did post it — which is why "not delivered" would be false');
});

test('timeout on a server that has not confirmed dedupe: not retried (a resend could double-post)', async () => {
  const p = await platform('hang');
  const h = makeRegistry({ server: await p.connect(), outbox: { enabled: true } });
  const result = await h.registry.routeSpeech('agent', 'hello', 'chat:1');
  assert.equal(result, null);
  assert.equal(h.registry.getOutboxEntries().length, 0);
  assert.equal(h.failures[0]!.mayHaveArrived, true);
  p.setMode('ok');
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.equal(p.posts().length, 1, 'exactly one post');
});

test('timeout on an idempotent server: queued, retried with the same key, posted exactly once', async () => {
  const p = await platform('ok idem');
  const h = makeRegistry({ server: await p.connect(), outbox: { enabled: true } });
  // A normal publish teaches the host that this server dedupes (key echoed).
  assert.equal((await h.registry.routeSpeech('agent', 'first', 'chat:1'))?.delivered, true);

  p.setMode('hang idem');
  const result = await h.registry.routeSpeech('agent', 'second', 'chat:1');
  assert.deepEqual(result, { delivered: false, queued: true, channelId: 'chat:1' });
  assert.equal(h.events[0]?.kind, 'queued');
  assert.equal(h.failures.length, 0, 'queued speech is not reported as failed');

  p.setMode('ok idem');
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  const posts = p.posts();
  assert.deepEqual(posts.map((x) => x.text), ['first', 'second'], 'the retry was deduped, not posted again');
  assert.equal(h.events.at(-1)?.kind, 'delivered-late');
  assert.equal(h.registry.getOutboxEntries().length, 0);
  // The key and write time travel on the first attempt too.
  assert.ok(posts[1]!.key);
  assert.equal(posts[1]!.writtenAt, new Date(h.clock.t).toISOString());
});

test('connection closed: queued as not-sent and delivered after the server comes back', async () => {
  const p = await platform('ok');
  const conn = await p.connect();
  const h = makeRegistry({ server: conn, outbox: { enabled: true } });
  await conn.close();

  const result = await h.registry.routeSpeech('agent', 'while down', 'chat:1');
  assert.equal(result?.queued, true);
  assert.equal(h.registry.getOutboxEntries()[0]?.outcome, 'not-sent');
  assert.equal(p.posts().length, 0);

  h.setServer(await p.connect()); // respawned connector
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(p.posts().map((x) => x.text), ['while down']);
  assert.equal(h.events.at(-1)?.kind, 'delivered-late');
});

// ---------------------------------------------------------------------------
// Ordering, durability, bounds (mock server)
// ---------------------------------------------------------------------------

function mockServer() {
  const sent: Array<{ text: string; key?: string; delayReason?: string }> = [];
  const state = { down: false };
  const server = {
    grant: FULL_GRANT(),
    get isConnected() { return !state.down; },
    sendChannelsPublish: async (params: { content: Array<{ text: string }>; idempotencyKey?: string; delayReason?: string }) => {
      if (state.down) throw new Error('Cannot send request: connection to "chat" is closed');
      sent.push({ text: params.content[0]!.text, key: params.idempotencyKey, delayReason: params.delayReason });
      return { delivered: true, messageId: `m${sent.length}` };
    },
  };
  return { server, sent, state };
}

test('newer speech never overtakes queued speech to the same channel', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true }, channels: ['chat:1', 'chat:2'] });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'one', 'chat:1');
  m.state.down = false;
  // The server is back, but 'one' is still queued: 'two' must wait behind it.
  const r2 = await h.registry.routeSpeech('agent', 'two', 'chat:1');
  assert.equal(r2?.queued, true);
  // Another channel is unaffected.
  assert.equal((await h.registry.routeSpeech('agent', 'elsewhere', 'chat:2'))?.delivered, true);
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['elsewhere', 'one', 'two']);
});

test('a drain with nothing due does not block later drains (regression: stuck in-flight flag)', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'x', 'chat:1');
  // Nothing is due yet: this pass completes synchronously.
  await h.registry.drainOutboxNow();
  m.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['x']);
});

test('a retry tells the server why it is late; a first attempt does not', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true } });
  await h.registry.routeSpeech('agent', 'on time', 'chat:1');
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'late', 'chat:1');
  m.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => [s.text, s.delayReason]), [['on time', undefined], ['late', 'disconnected']]);
});

test('a disconnected server is not even attempted; the entry waits', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true } });
  m.state.down = true;
  const r = await h.registry.routeSpeech('agent', 'hi', 'chat:1');
  assert.equal(r?.queued, true);
  assert.match(h.registry.getOutboxEntries()[0]!.lastError, /disconnected/);
});

test('the queue survives a restart (file, not Chronicle) and drains after boot', async () => {
  const path = join(tempDir(), 'recovery', 'prose-outbox.json');
  const m = mockServer();
  m.state.down = true;
  const a = makeRegistry({ server: m.server, outbox: { enabled: true, path } });
  await a.registry.routeSpeech('agent', 'kept', 'chat:1');
  a.registry.stopAll();
  assert.ok(existsSync(path));

  m.state.down = false;
  const b = makeRegistry({ server: m.server, outbox: { enabled: true, path } });
  assert.equal(b.registry.getOutboxEntries().length, 1);
  b.registry.kickOutbox();
  await b.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['kept']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 0);
});

test('entries past maxAgeMs are dropped, not sent, and the agent is told', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, maxAgeMs: 60_000 } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'stale', 'chat:1');
  m.state.down = false;
  h.clock.t += 61_000;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.equal(m.sent.length, 0);
  const last = h.events.at(-1)!;
  assert.equal(last.kind, 'dropped');
  assert.match((last as { reason: string }).reason, /too old/);
});

test('per-agent cap: the oldest entry is dropped first, with a notice', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, maxEntriesPerAgent: 2 } });
  m.state.down = true;
  for (const t of ['a', 'b', 'c']) await h.registry.routeSpeech('agent', t, 'chat:1');
  assert.deepEqual(h.registry.getOutboxEntries().map((e) => e.textLen), [1, 1]);
  const dropped = h.events.filter((e) => e.kind === 'dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0]!.entry.text, 'a');
});

// Automatic notices (the Librarian, 2026-09-26): a failure notice is written
// at the START of an outage, so under the speech age limit it was the entry
// most likely to expire: the class that reports drops was the class dropped.
test('an automatic notice outlives the speech age limit and is still delivered, first', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, maxAgeMs: 60_000 } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', '⚠️ notice', 'chat:1', { notice: true });
  await h.registry.routeSpeech('agent', 'reply', 'chat:1');
  const queued = h.events.find((e) => e.kind === 'queued' && e.entry.notice);
  assert.equal((queued as { expiresAt: number }).expiresAt, Number.POSITIVE_INFINITY);
  h.clock.t += 12 * 3_600_000; // a long outage
  m.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['⚠️ notice']);
  const dropped = h.events.filter((e) => e.kind === 'dropped');
  assert.deepEqual(dropped.map((e) => e.entry.text), ['reply'], 'the stale reply expires as before');
});

test('noticeMaxAgeMs, when set, bounds notices too', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, maxAgeMs: 60_000, noticeMaxAgeMs: 120_000 } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', '⚠️ notice', 'chat:1', { notice: true });
  h.clock.t += 121_000;
  m.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.equal(m.sent.length, 0);
  assert.equal(h.events.at(-1)!.kind, 'dropped');
});

test('size cap: the resident\'s oldest words give way before an older notice', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, maxEntriesPerAgent: 2 } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'N', 'chat:1', { notice: true });
  for (const t of ['a', 'b']) await h.registry.routeSpeech('agent', t, 'chat:1');
  const dropped = h.events.filter((e) => e.kind === 'dropped');
  assert.deepEqual(dropped.map((e) => e.entry.text), ['a']);
  m.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['N', 'b'], 'order is kept among the survivors');
});

test('the notice class survives a restart', async () => {
  const path = join(tempDir(), 'recovery', 'prose-outbox.json');
  const m = mockServer();
  m.state.down = true;
  const clock = { t: Date.parse('2026-09-25T12:00:00Z') };
  const a = makeRegistry({ server: m.server, outbox: { enabled: true, path, maxAgeMs: 60_000 }, clock });
  await a.registry.routeSpeech('agent', '⚠️ notice', 'chat:1', { notice: true });
  a.registry.stopAll();
  clock.t += 3_600_000;
  m.state.down = false;
  const b = makeRegistry({ server: m.server, outbox: { enabled: true, path, maxAgeMs: 60_000 }, clock });
  b.registry.kickOutbox();
  await b.registry.drainOutboxNow();
  assert.deepEqual(m.sent.map((s) => s.text), ['⚠️ notice']);
});

test('a retry that fails permanently is dropped with the reason', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'x', 'chat:1');
  m.state.down = false;
  m.server.sendChannelsPublish = async () => ({ delivered: false, messageId: '' }) as never;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  const last = h.events.at(-1)!;
  assert.equal(last.kind, 'dropped');
  assert.match((last as { reason: string }).reason, /delivered:false/);
});

test('disabled (default): failures behave as before, nothing is queued', async () => {
  const m = mockServer();
  const h = makeRegistry({ server: m.server });
  m.state.down = true;
  assert.equal(await h.registry.routeSpeech('agent', 'x', 'chat:1'), null);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0]!.mayHaveArrived, undefined);
  assert.deepEqual(h.registry.getOutboxEntries(), []);
});

test('classifyPublishError on the real error texts', () => {
  assert.equal(classifyPublishError(new Error('Cannot send request: connection to "discord" is closed')), 'not-sent');
  assert.equal(classifyPublishError(new Error('Discord is not connected right now (network down or reconnecting) — try again shortly.')), 'not-sent');
  assert.equal(classifyPublishError(new Error('MCPL server "discord" did not respond to channels/publish (id=9) within 60000ms — the server may be hung.')), 'unknown');
  assert.equal(classifyPublishError(new Error('Send partially completed — Discord was too slow to finish.')), 'unknown');
  assert.equal(classifyPublishError(new Error('Connection to MCPL server "discord" closed while awaiting response for channels/publish (id=4)')), 'unknown');
  assert.equal(classifyPublishError(new Error('MCPL server "discord" disconnected unexpectedly (code=1, signal=n/a, reason=unknown) while awaiting channels/publish (id=4)')), 'unknown');
  assert.equal(classifyPublishError(new Error('MCPL server "discord" returned error for channels/publish: [-32603] Discord is not connected right now (network down or reconnecting) — try again shortly.')), 'not-sent');
  assert.equal(classifyPublishError(new Error('Missing Permissions')), 'permanent');
});

// ---------------------------------------------------------------------------
// Queueable send tools (proseOutbox.tools)
// ---------------------------------------------------------------------------

function toolServer() {
  const calls: Array<{ name: string; input: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
  const state = { down: false, mode: 'ok' as 'ok' | 'throw-timeout' | 'discord-down' | 'no-permission', echo: true };
  const server = {
    grant: FULL_GRANT(),
    get isConnected() { return !state.down; },
    sendChannelsPublish: async () => ({ delivered: true, messageId: 'p' }),
    sendToolsCall: async (name: string, input: Record<string, unknown>, _s?: unknown, meta?: Record<string, unknown>) => {
      if (state.down) throw new Error('Cannot send request: connection to "chat" is closed');
      if (state.mode === 'throw-timeout') throw new Error('MCPL server "chat" did not respond to tools/call (id=3) within 60000ms — the server may be hung.');
      if (state.mode === 'discord-down') {
        return { isError: true, content: [{ type: 'text', text: 'Discord is not connected right now (network down or reconnecting) — try again shortly.' }] };
      }
      if (state.mode === 'no-permission') return { isError: true, content: [{ type: 'text', text: 'Missing Permissions' }] };
      calls.push({ name, input, meta });
      return {
        content: [{ type: 'text', text: `sent ${calls.length}` }],
        ...(state.echo && meta?.idempotencyKey ? { _meta: { idempotencyKey: meta.idempotencyKey } } : {}),
      };
    },
  };
  return { server, calls, state };
}

const TOOLS = { enabled: true, tools: ['send_message', 'send_dm'] };
const resultText = (r: { data?: unknown }) => ((r.data as Array<{ text: string }>)[0]?.text ?? '');

test('a send tool that cannot reach its server is queued: "queued" result, replayed intact later', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS });
  t.state.down = true;
  const input = { channelId: 'chat:1', content: 'hello from the outage', files: [{ path: '/tmp/a.png' }] };
  const r = await h.registry.callQueueableTool('agent', 'chat', 'send_message', input);
  assert.equal(r.success, true);
  assert.match(resultText(r), /^\[queued\] Not sent yet/);
  assert.match(resultText(r), /you don't need to resend it/);
  assert.equal(h.events.filter((e) => e.kind === 'queued').length, 1);

  t.state.down = false;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0]!.input, input, 'the whole call is replayed: channel, content, files');
  assert.equal(t.calls[0]!.meta?.delayReason, 'disconnected');
  assert.ok(t.calls[0]!.meta?.idempotencyKey);
  assert.equal(h.events.at(-1)?.kind, 'delivered-late');
});

test('the connector reporting Discord unreachable (isError) is queued too', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS });
  t.state.mode = 'discord-down';
  const r = await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'x' });
  assert.match(resultText(r), /^\[queued\]/);
});

test('a real tool error is returned exactly as an unqueued call would', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS });
  t.state.mode = 'no-permission';
  const r = await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'x' });
  assert.deepEqual(r, { success: true, data: [{ type: 'text', text: 'Missing Permissions' }] });
  assert.equal(h.registry.getOutboxEntries().length, 0);
});

test('timeout: queued only if THAT tool confirmed dedupe (scope is server + tool)', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS });
  // send_message confirms dedupe (key echoed); send_dm never has.
  await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'first' });
  t.state.mode = 'throw-timeout';
  const sm = await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'second' });
  assert.match(resultText(sm), /^\[queued\]/);
  const dm = await h.registry.callQueueableTool('agent', 'chat', 'send_dm', { userId: 'u1', content: 'hi' });
  assert.equal(dm.success, false, 'a possibly-posted DM is not resent to a tool that cannot dedupe');
  assert.match(dm.error ?? '', /did not respond/);
});

test('a send tool queues behind plain speech to the same channel (raw id matched to the registry id)', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS, channels: ['chat:1'] });
  t.state.down = true;
  await h.registry.routeSpeech('agent', 'speech first', 'chat:1');
  t.state.down = false;
  // The server is back, but speech is still queued: the send must wait.
  const r = await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: '1', content: 'tool second' });
  assert.match(resultText(r), /still waiting/);
  assert.deepEqual(h.registry.getOutboxEntries().map((e) => e.channelId), ['chat:1', 'chat:1']);
});

test('a queued send survives a restart and is replayed after boot', async () => {
  const path = join(tempDir(), 'q.json');
  const t = toolServer();
  t.state.down = true;
  const a = makeRegistry({ server: t.server, outbox: { ...TOOLS, path } });
  const r = await a.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'kept' });
  assert.match(resultText(r), /kept across restarts/);
  a.registry.stopAll();
  t.state.down = false;
  const b = makeRegistry({ server: t.server, outbox: { ...TOOLS, path } });
  b.registry.kickOutbox();
  await b.registry.drainOutboxNow();
  assert.deepEqual(t.calls.map((c) => c.input.content), ['kept']);
});

test('giving up keeps the words: a copy beside the queue file, and the event says where', async () => {
  const dir = tempDir();
  const path = join(dir, 'recovery', 'prose-outbox.json');
  const m = mockServer();
  const h = makeRegistry({ server: m.server, outbox: { enabled: true, path, maxAgeMs: 60_000 } });
  m.state.down = true;
  await h.registry.routeSpeech('agent', 'the finished message', 'chat:1');
  h.clock.t += 61_000;
  h.registry.kickOutbox();
  await h.registry.drainOutboxNow();
  const dropped = h.events.find((e) => e.kind === 'dropped') as { savedTo?: string } | undefined;
  assert.ok(dropped?.savedTo?.startsWith(join(dir, 'recovery', 'undelivered')));
  assert.equal(JSON.parse(readFileSync(dropped!.savedTo!, 'utf8')).text, 'the finished message');
});

test('an outcome-unknown queued send says it may already have arrived', async () => {
  const t = toolServer();
  const h = makeRegistry({ server: t.server, outbox: TOOLS });
  await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'first' }); // confirms dedupe
  t.state.mode = 'throw-timeout';
  const r = await h.registry.callQueueableTool('agent', 'chat', 'send_message', { channelId: 'chat:1', content: 'second' });
  assert.match(resultText(r), /^\[queued\] No answer .*may already have arrived/);
  assert.match(resultText(r), /won't post it twice if it finds it/);
});
