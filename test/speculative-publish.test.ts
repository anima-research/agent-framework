/**
 * Speculative channel chunks (docs/speculative-channel-chunks.md): the text
 * of a channel_publish call streams to a channel that opted in
 * (`capabilities.streaming.speculative`) while the model writes the call,
 * and the publish's outcome ends the stream: complete with the full text, or
 * cancelled with empty content.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStreamOptions } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type Module, type ModuleContext, type ProcessEvent, type ProcessState } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { PublishArgsReader, SpeculativePublishStreams, type SpeculativeStreamSink } from '../src/speculative-publish.js';
import { ChannelRegistry, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { ALL_CAPABILITY_PATHS, CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

// ---------------------------------------------------------------------------
// PublishArgsReader
// ---------------------------------------------------------------------------

/** Feeds `json` to a reader in the given cut points; returns it and the deltas. */
function read(json: string, cuts: number[]) {
  const reader = new PublishArgsReader();
  const deltas: string[] = [];
  let at = 0;
  for (const cut of [...cuts, json.length]) {
    const d = reader.push(json.slice(at, cut));
    if (d) deltas.push(d);
    at = cut;
  }
  return { reader, deltas };
}

const TRICKY = 'Line one.\nShe said "hi" \\ back\t/ é 😀 end';

test('reader: content split at every position, escapes included, decodes to what JSON.parse gives', () => {
  const json = JSON.stringify({ channelId: 'bosun:meeting:1', content: TRICKY });
  // Also the escaped forms the model may write: é and a surrogate pair as 😀.
  const escaped = json.replace('é', '\\u00e9').replace('😀', '\\ud83d\\ude00').replace('/', '\\/');
  for (const source of [json, escaped]) {
    assert.equal(JSON.parse(source).content, TRICKY);
    for (let cut = 0; cut <= source.length; cut++) {
      const { reader, deltas } = read(source, [cut]);
      assert.equal(deltas.join(''), TRICKY, `cut at ${cut}: ${JSON.stringify(source.slice(0, cut))}`);
      assert.equal(reader.channelId, 'bosun:meeting:1');
      assert.equal(reader.done, true);
      assert.equal(reader.failed, false);
    }
    // One character at a time: every escape and the surrogate pair cross fragments.
    const { deltas } = read(source, [...source].map((_, i) => i + 1).slice(0, -1));
    assert.equal(deltas.join(''), TRICKY);
    // No delta holds half a surrogate pair.
    for (const d of deltas) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(d), `delta ${JSON.stringify(d)} splits a pair`);
  }
});

test('reader: channelId after content, text as the alias, other values skipped', () => {
  const json = '{ "meta": {"a": "}\\"{", "b": [1, {"c": null}]}, "n": -1.5e3, "ok": true, "content": "Hi.", "channelId": "room" }';
  const { reader, deltas } = read(json, [20, 40, 60]);
  assert.equal(deltas.join(''), 'Hi.');
  assert.equal(reader.channelId, 'room');
  assert.equal(reader.sendKey, 'content');
  assert.equal(reader.done, true);

  const alias = read('{"text":"Via text.","channelId":"room","serverId":"srv"}', [5, 12]);
  assert.equal(alias.deltas.join(''), 'Via text.');
  assert.equal(alias.reader.sendKey, 'text');
  assert.equal(alias.reader.serverId, 'srv');

  // Only the first of content/text streams, and a repeated key doesn't.
  const both = read('{"content":"One.","text":"Two.","content":"Three."}', []);
  assert.equal(both.deltas.join(''), 'One.');
});

test('reader: what is not a JSON object stops it', () => {
  assert.equal(read('["content"]', []).reader.failed, true);
  // A skipped value that isn't JSON: the call can't parse, so nothing after it streams.
  for (const bad of ['{"junk":"raw\nnewline","content":"Never."}', '{"a":1,,"content":"Never."}', '{"a":1,}', '{"a":1,\u00a0"content":"Never."}',
    '{"junk":truX,"content":"Never."}', '{"n":1.2.3,"content":"Never."}', '{"meta":{tru},"content":"Never."}', '{"meta":[1,,2],"content":"Never."}']) {
    const r = read(bad, [9]);
    assert.equal(r.reader.failed, true, bad);
    assert.deepEqual(r.deltas, [], bad);
  }
  assert.equal(read('{"content" "x"}', []).reader.failed, true);
  assert.equal(read('{"content":"bad \\q escape"}', []).reader.failed, true);
  assert.equal(read('{"content":"x"} trailing', []).reader.failed, true);
  const partial = read('{"channelId":"room","content":"Half a sen', []);
  assert.equal(partial.reader.failed, false);
  assert.equal(partial.reader.done, false);
  assert.equal(partial.deltas.join(''), 'Half a sen');
});

// ---------------------------------------------------------------------------
// SpeculativePublishStreams
// ---------------------------------------------------------------------------

type Sent =
  | { kind: 'chunk'; channelId: string; streamId: string; seq: number; content: string }
  | { kind: 'complete'; channelId: string; streamId: string; content: string; cancelled: boolean };

function sink(opted = new Set(['voice']), fallback: string | null = 'voice') {
  const sent: Sent[] = [];
  const ref = (channelId: string): ChannelRef | null => (opted.has(channelId) ? { serverId: 'bosun', channelId } : null);
  const s: SpeculativeStreamSink = {
    target: ({ channelId }) => ref(channelId),
    defaultTarget: () => (fallback ? ref(fallback) : null),
    chunk: (to, streamId, seq, content) => { sent.push({ kind: 'chunk', channelId: to.channelId, streamId, seq, content }); },
    complete: (to, streamId, content, cancelled) => { sent.push({ kind: 'complete', channelId: to.channelId, streamId, content, cancelled }); },
  };
  return { sent, sink: s };
}

const publishCall = (id: string, input: Record<string, unknown>) => ({ id, name: 'channel_publish', input });
const voice: ChannelRef = { serverId: 'bosun', channelId: 'voice' };

test('streams: channelId and serverId first, each delta goes out at once; a delivered publish completes with the full text', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  for (const f of ['{"channelId":"voi', 'ce","serverId":"bos', 'un","content":"Hel', 'lo. ', 'Bye."}']) streams.onInputDelta('t1', 'channel_publish', f);
  assert.deepEqual(sent, [
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Hel' },
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 1, content: 'lo. ' },
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 2, content: 'Bye.' },
  ]);
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Hello. Bye.' })]);
  assert.equal(streams.dispatch('t1')?.streamId, 'spec_t1');
  streams.published('t1', { delivered: true, destination: voice });
  assert.deepEqual(sent.at(-1), { kind: 'complete', channelId: 'voice', streamId: 'spec_t1', content: 'Hello. Bye.', cancelled: false });
  assert.equal(streams.size, 0);
});

test('streams: content before the recipient is fixed is held, then sent at once when channelId and serverId are read', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"content":"Early ');
  streams.onInputDelta('t1', 'channel_publish', 'words.",');
  assert.deepEqual(sent, []);
  streams.onInputDelta('t1', 'channel_publish', '"channelId":"voice",');
  assert.deepEqual(sent, [], 'a serverId may still follow');
  streams.onInputDelta('t1', 'channel_publish', '"serverId":"bosun"}');
  assert.deepEqual(sent, [{ kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Early words.' }]);
});

test('streams: a call that names no serverId sends nothing while it is written, and its text as one chunk once it is finished', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  for (const f of ['{"channelId":"voice","content":"Hel', 'lo. ', 'Bye."}']) streams.onInputDelta('t1', 'channel_publish', f);
  assert.deepEqual(sent, []);
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Hello. Bye.' })]);
  assert.deepEqual(sent, [{ kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Hello. Bye.' }]);
  assert.deepEqual(streams.dispatch('t1'), { streamId: 'spec_t1', channel: voice, live: true });
});

test('streams: a call naming no channel streams to its default once the call is finished', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"content":"To the default."}');
  assert.deepEqual(sent, []);
  streams.onToolCalls([publishCall('t1', { content: 'To the default.' })]);
  assert.deepEqual(sent, [{ kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'To the default.' }]);
  assert.equal(streams.dispatch('t1')?.streamId, 'spec_t1');
  streams.published('t1', { delivered: true, destination: voice });
  assert.equal(sent.length, 2);
});

test('streams: a channel that did not opt in, and other tools, get nothing', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"text-chat","serverId":"bosun","content":"Not spoken."}');
  streams.onInputDelta('t2', 'send_message', '{"channelId":"voice","serverId":"bosun","content":"Other tool."}');
  streams.onInputDelta('t3', 'channel_publish', '{"content":"No default."}');
  streams.onToolCalls([publishCall('t1', { channelId: 'text-chat', content: 'Not spoken.' })]);
  assert.equal(streams.dispatch('t1'), undefined);
  streams.published('t1', { delivered: true, destination: { serverId: 'bosun', channelId: 'text-chat' } });
  assert.deepEqual(sent, []);

  const none = sink(new Set(['voice']), null);
  const s2 = new SpeculativePublishStreams(none.sink);
  s2.onInputDelta('t3', 'channel_publish', '{"content":"No default."}');
  s2.onToolCalls([publishCall('t3', { content: 'No default.' })]);
  assert.deepEqual(none.sent, []);
  assert.equal(s2.size, 0);
});

test('streams: a name two channels share waits for serverId, however the fragments fall', () => {
  const json = '{"channelId":"shared","serverId":"bosun","content":"Hello there."}';
  for (let cut = 1; cut < json.length; cut++) {
    const sent: Sent[] = [];
    const streams = new SpeculativePublishStreams({
      target: ({ channelId, serverId }) => (channelId === 'shared' && serverId === 'bosun' ? { serverId: 'bosun', channelId } : null),
      defaultTarget: () => null,
      chunk: (to, streamId, seq, content) => { sent.push({ kind: 'chunk', channelId: to.channelId, streamId, seq, content }); },
      complete: (to, streamId, content, c) => { sent.push({ kind: 'complete', channelId: to.channelId, streamId, content, cancelled: c }); },
    });
    streams.onInputDelta('t1', 'channel_publish', json.slice(0, cut));
    streams.onInputDelta('t1', 'channel_publish', json.slice(cut));
    assert.equal(sent.filter((e) => e.kind === 'chunk').map((e) => (e as { content: string }).content).join(''), 'Hello there.', `cut at ${cut}`);
  }
});

test('streams: a channel that changes after chunks went out cancels the stream', () => {
  const { sent, sink: s } = sink(new Set(['voice', 'voice2']));
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"Spoken ');
  streams.onInputDelta('t1', 'channel_publish', 'already.","channelId":"voice2"}');
  assert.deepEqual(sent, [
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Spoken ' },
    // The fragment that names another channel sends none of its text.
    { kind: 'complete', channelId: 'voice', streamId: 'spec_t1', content: '', cancelled: true },
  ]);
  streams.onToolCalls([publishCall('t1', { channelId: 'voice2', serverId: 'bosun', content: 'Spoken already.' })]);
  assert.deepEqual(streams.dispatch('t1'), { streamId: 'spec_t1', channel: voice, live: false },
    'the publish is held to where its text went, and carries no stream id');
  assert.equal(sent.length, 2);
});

const cancelled = (streamId = 'spec_t1') => ({ kind: 'complete', channelId: 'voice', streamId, content: '', cancelled: true });

test('streams: every way a call does not get published cancels its stream, exactly once', () => {
  const begin = () => {
    const h = sink();
    const streams = new SpeculativePublishStreams(h.sink);
    streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"Maybe');
    return { ...h, streams };
  };

  // Cut off: the round's calls don't include it (max_tokens, a dropped call).
  let h = begin();
  h.streams.onToolCalls([{ id: 'other', name: 'think', input: {} }]);
  assert.deepEqual(h.sent.at(-1), cancelled());

  // The inference ended (or a refusal retry restarted it) before the call finished.
  h = begin();
  assert.deepEqual(h.streams.cancelPending(), ['t1']);
  assert.deepEqual(h.sent.at(-1), cancelled());

  // The publish failed.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  h.streams.published('t1', { delivered: false });
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Delivered, but somewhere else than where it streamed.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  h.streams.published('t1', { delivered: true, destination: { serverId: 'other', channelId: 'voice' } });
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Refused before its publish (a result arrived some other way).
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.settle('t1');
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Arguments that stop being JSON: what went out is taken back, nothing more goes.
  h = begin();
  h.streams.onInputDelta('t1', 'channel_publish', ' so"} oops');
  h.streams.onInputDelta('t1', 'channel_publish', 'more');
  assert.deepEqual(h.sent.at(-1), cancelled());
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe so' })]);
  assert.deepEqual(h.streams.dispatch('t1'), { streamId: 'spec_t1', channel: voice, live: false }, 'held to where its text went, no stream id');

  // stop() while the publish is under way: its outcome ends the stream, delivered here.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  assert.deepEqual(h.streams.cancelPending(), [], 'a publish under way ends its own stream');
  h.streams.published('t1', { delivered: true, destination: voice });
  assert.deepEqual(h.sent.filter((e) => e.kind === 'complete'), [
    { kind: 'complete', channelId: 'voice', streamId: 'spec_t1', content: 'Maybe', cancelled: false },
  ], 'ended once, completed');

  // A call membrane marked (cut off, or out of order) is refused at dispatch.
  h = begin();
  h.streams.onToolCalls([{ ...publishCall('t1', {}), unparseableInput: '{"channelId":"voice","content":"Maybe' }]);
  assert.deepEqual(h.sent.at(-1), cancelled());
  assert.equal(h.streams.dispatch('t1')?.live, false);
});

test('streams: a name is resolved only once serverId is read, or from the finished call', () => {
  const asked: Array<{ channelId: string; serverId?: string }> = [];
  const streams = new SpeculativePublishStreams({
    target: (named) => { asked.push({ ...named }); return { serverId: named.serverId ?? 'bosun', channelId: named.channelId }; },
    defaultTarget: () => null,
    chunk: () => {},
    complete: () => {},
  });
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"shared","content":"A');
  assert.deepEqual(asked, []);
  streams.onInputDelta('t1', 'channel_publish', '","serverId":"chat"}');
  assert.deepEqual(asked, [{ channelId: 'shared', serverId: 'chat' }]);
  streams.onInputDelta('t2', 'channel_publish', '{"channelId":"plain","content":"B"}');
  streams.onToolCalls([publishCall('t1', { channelId: 'shared', serverId: 'chat', content: 'A' }), publishCall('t2', { channelId: 'plain', content: 'B' })]);
  assert.deepEqual(asked.slice(1), [{ channelId: 'shared', serverId: 'chat' }, { channelId: 'plain' }]);
});

test("streams: chunks of other text than the publish posts are cancelled (a text alias before content, a repeated key)", () => {
  for (const [json, input] of [
    ['{"channelId":"voice","serverId":"bosun","text":"Said first.","content":"Posted."}', { channelId: 'voice', text: 'Said first.', content: 'Posted.' }],
    ['{"channelId":"voice","serverId":"bosun","content":"Said first.","content":"Posted."}', { channelId: 'voice', content: 'Posted.' }],
    ['{"channelId":"voice","serverId":"bosun","text":"Said first.","content":""}', { channelId: 'voice', text: 'Said first.', content: '' }],
  ] as const) {
    const { sent, sink: s } = sink();
    const streams = new SpeculativePublishStreams(s);
    streams.onInputDelta('t1', 'channel_publish', json);
    assert.equal(sent.filter((e) => e.kind === 'chunk').length, 1, json);
    streams.onToolCalls([publishCall('t1', input)]);
    assert.deepEqual(sent.at(-1), cancelled(), json);
    assert.equal(streams.dispatch('t1')?.live, false, 'the publish carries no stream id');
  }
  // An empty content goes first: nothing streams, and the text alias the publish doesn't post isn't sent at the end either.
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"","text":"Not posted."}');
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: '', text: 'Not posted.' })]);
  assert.deepEqual(sent, []);
});

test('streams: spokenPending names only the pending calls whose text went out', () => {
  const { sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('spoken', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"Out');
  streams.onInputDelta('silent', 'channel_publish', '{"channelId":"text-chat","serverId":"bosun","content":"Not out');
  streams.onInputDelta('held', 'channel_publish', '{"content":"Held');
  assert.deepEqual(streams.spokenPending(), ['spoken']);
  streams.onToolCalls([publishCall('spoken', { channelId: 'voice', content: 'Out' })]);
  assert.deepEqual(streams.spokenPending(), ['spoken']);
  streams.dispatch('spoken');
  assert.deepEqual(streams.spokenPending(), [], 'a publish under way ends its own stream');
});

test('streams: a channelId or serverId that is not a string stops the stream, wherever it comes', () => {
  for (const [json, input] of [
    ['{"channelId":"voice","serverId":42,"content":"Hello"}', { channelId: 'voice', serverId: 42, content: 'Hello' }],
    ['{"channelId":"voice","content":"Hello","serverId":{"id":"bosun"}}', { channelId: 'voice', content: 'Hello', serverId: { id: 'bosun' } }],
    ['{"serverId":true,"channelId":"voice","content":"Hello"}', { serverId: true, channelId: 'voice', content: 'Hello' }],
  ] as const) {
    const { sent, sink: s } = sink();
    const streams = new SpeculativePublishStreams(s);
    for (const ch of json) streams.onInputDelta('t1', 'channel_publish', ch);
    const chunks = sent.filter((e) => e.kind === 'chunk');
    if (chunks.length) assert.deepEqual(sent.at(-1), cancelled(), json);
    streams.onToolCalls([publishCall('t1', input as Record<string, unknown>)]);
    assert.equal(streams.dispatch('t1'), undefined, json);
    assert.equal(sent.filter((e) => e.kind === 'complete').length, chunks.length ? 1 : 0, json);
  }
  // Decided when the round's calls arrive too, whatever the fragments showed.
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"Hello"}');
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', serverId: 42, content: 'Hello' })]);
  assert.deepEqual(sent.at(-1), cancelled());
});

test('streams: a sink that throws never reaches the caller', () => {
  const streams = new SpeculativePublishStreams({
    target: () => voice,
    defaultTarget: () => voice,
    chunk: () => { throw new Error('transport closed'); },
    complete: () => { throw new Error('transport closed'); },
  });
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","serverId":"bosun","content":"x"}');
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'x' })]);
  streams.dispatch('t1');
  streams.published('t1', { delivered: true, destination: voice });
});

// ---------------------------------------------------------------------------
// ChannelRegistry: which channels take a stream, and the wire shape
// ---------------------------------------------------------------------------

function streamingRegistry() {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const publishes: Array<Record<string, unknown>> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOutgoingSpeculativeChunk: (params: Record<string, unknown>) => { notifications.push({ method: 'channels/outgoing/chunk', params }); },
    sendChannelsOutgoingSpeculativeComplete: (params: Record<string, unknown>) => { notifications.push({ method: 'channels/outgoing/complete', params }); },
    sendChannelsPublish: async (params: Record<string, unknown>) => { publishes.push(params); return { delivered: true }; },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
  };
  const registry = new ChannelRegistry(
    { getServer: (id: string) => (id === 'bosun' || id === 'chat' ? server : null) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
  );
  const register = (serverId: string, id: string, extra: Record<string, unknown> = {}) =>
    registry.handleChanged(serverId, { added: [{ id, type: 'chat', label: id, ...extra }] } as never);
  return { registry, server, notifications, publishes, register };
}

const SPECULATIVE = { capabilities: { streaming: { speculative: true } } };

test('registry: only a channel that opted in, not inbound-only, on a server granted channels.streaming, takes a stream', async () => {
  const h = streamingRegistry();
  await h.register('bosun', 'bosun:meeting:1', SPECULATIVE);
  await h.register('bosun', 'bosun:plain');
  await h.register('bosun', 'bosun:ears', { ...SPECULATIVE, direction: 'inbound' });
  await h.register('bosun', 'shared', SPECULATIVE);
  await h.register('chat', 'shared', SPECULATIVE);

  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'bosun:meeting:1' }), { serverId: 'bosun', channelId: 'bosun:meeting:1' });
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:plain' }), null);
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:ears' }), null);
  assert.equal(h.registry.speculativeTarget({ channelId: 'shared' }), null, 'a name two channels answer to picks none');
  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'shared', serverId: 'chat' }), { serverId: 'chat', channelId: 'shared' });
  assert.equal(h.registry.speculativeTarget({ channelId: 'nowhere' }), null);

  // A name the turn's own channel answers to means that channel, as the publish reads it.
  const chat = { serverId: 'chat', channelId: 'shared' };
  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'shared' }, [chat]), chat);
  await h.register('chat', 'only-plain-on-chat');
  await h.register('bosun', 'only-plain-on-chat', SPECULATIVE);
  assert.equal(h.registry.speculativeTarget({ channelId: 'only-plain-on-chat' }, [{ serverId: 'chat', channelId: 'only-plain-on-chat' }]), null,
    "the turn's own channel didn't opt in, though another server's channel with its id did");

  h.server.grant = new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.streaming')), []);
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:meeting:1' }), null);
  // A server that may stream but not publish gets no text the publish would be refused.
  h.server.grant = new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.publish')), []);
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:meeting:1' }), null);
  h.registry.sendSpeculativeChunk({ serverId: 'bosun', channelId: 'bosun:meeting:1' }, 'Glassy', 'spec_t9', 0, 'x');
  assert.equal(h.notifications.length, 0);
});

test("registry: the reviewer's scenario: only A has the name while content is written, B registers, the call names B; A receives nothing", async () => {
  for (const serverIdIn of ['fragments', 'finished call'] as const) {
    const h = streamingRegistry();
    await h.register('bosun', 'shared', SPECULATIVE);
    const sent: Array<{ serverId: string; channelId: string; kind: string; content: string }> = [];
    const streams = new SpeculativePublishStreams({
      target: (named) => h.registry.speculativeTarget(named, []),
      defaultTarget: () => null,
      chunk: (to, streamId, seq, content) => { sent.push({ ...to, kind: 'chunk', content }); h.registry.sendSpeculativeChunk(to, 'Glassy', streamId, seq, content); },
      complete: (to, streamId, content, c) => { sent.push({ ...to, kind: 'complete', content }); h.registry.sendSpeculativeComplete(to, 'Glassy', streamId, content, c); },
    });
    streams.onInputDelta('t1', 'channel_publish', '{"channelId":"shared","content":"For B only');
    await h.register('chat', 'shared', SPECULATIVE);
    if (serverIdIn === 'fragments') streams.onInputDelta('t1', 'channel_publish', '","serverId":"chat"}');
    else streams.onInputDelta('t1', 'channel_publish', '"}');
    streams.onToolCalls([publishCall('t1', { channelId: 'shared', serverId: 'chat', content: 'For B only' })]);
    const spoken = streams.dispatch('t1');
    await h.registry.handleChannelToolCall('channel_publish', { channelId: 'shared', serverId: 'chat', content: 'For B only' },
      { kind: 'agent', agentName: 'Glassy', ...(spoken ? { speculativeStream: spoken } : {}) });
    assert.deepEqual(sent.filter((e) => e.serverId === 'bosun'), [], serverIdIn);
    assert.deepEqual(sent.filter((e) => e.kind === 'chunk').map((e) => [e.serverId, e.content]), [['chat', 'For B only']], serverIdIn);
    assert.equal(h.publishes.length, 1);
    assert.equal(h.publishes[0]!.streamId, 'spec_t1');
  }
});

test('registry: a publish whose text already went to one channel goes there or nowhere', async () => {
  const h = streamingRegistry();
  await h.register('bosun', 'shared', SPECULATIVE);
  await h.register('chat', 'shared', SPECULATIVE);
  const bosun = { serverId: 'bosun', channelId: 'shared' };
  const refused = await h.registry.handleChannelToolCall('channel_publish', { channelId: 'shared', serverId: 'chat', content: 'Hi.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t1', channel: bosun, live: true } });
  assert.equal(refused.isError, true);
  assert.match(String(refused.error), /already went to channel/);
  assert.equal(h.publishes.length, 0, 'nothing was sent to the other channel');
  // Where the text went: published, without the stream id once the stream was cancelled.
  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'shared', serverId: 'bosun', content: 'Hi.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t1', channel: bosun, live: false } });
  assert.equal(h.publishes.length, 1);
  assert.equal('streamId' in h.publishes[0]!, false);
});

test('registry: chunk and complete params are the contract, and the publish carries the stream id', async () => {
  const h = streamingRegistry();
  await h.register('bosun', 'bosun:meeting:1', SPECULATIVE);
  const to = { serverId: 'bosun', channelId: 'bosun:meeting:1' };
  h.registry.sendSpeculativeChunk(to, 'Glassy', 'spec_t1', 0, 'Hello');
  h.registry.sendSpeculativeComplete(to, 'Glassy', 'spec_t1', 'Hello.', false);
  h.registry.sendSpeculativeComplete(to, 'Glassy', 'spec_t2', '', true);
  assert.deepEqual(h.notifications, [
    { method: 'channels/outgoing/chunk', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t1', seq: 0, content: 'Hello', speculative: true, conversationId: 'Glassy' } },
    { method: 'channels/outgoing/complete', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t1', content: 'Hello.', speculative: true, conversationId: 'Glassy' } },
    { method: 'channels/outgoing/complete', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t2', content: '', speculative: true, cancelled: true, conversationId: 'Glassy' } },
  ]);

  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:meeting:1', content: 'Hello.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t1', channel: to } });
  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:meeting:1', content: 'Plain.' },
    { kind: 'agent', agentName: 'Glassy' });
  assert.equal(h.publishes[0]!.streamId, 'spec_t1');
  assert.equal('streamId' in h.publishes[1]!, false);
  // A publish that would land elsewhere than where its text went is refused.
  await h.register('bosun', 'bosun:plain');
  const elsewhere = await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:plain', content: 'Elsewhere.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t4', channel: to } });
  assert.equal(elsewhere.isError, true);
  assert.equal(h.publishes.length, 2);

  // A channel that didn't opt in gets no chunk, even when asked.
  h.registry.sendSpeculativeChunk({ serverId: 'bosun', channelId: 'bosun:plain' }, 'Glassy', 'spec_t3', 0, 'x');
  assert.equal(h.notifications.length, 3);
});

// ---------------------------------------------------------------------------
// The framework, end to end with a scripted stream
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const round = (...blocks: ContentBlock[]) => createMockResponse(blocks, 'tool_use');
const final = (...blocks: ContentBlock[]) => createMockResponse(blocks);

/**
 * Each stream takes the next script. Before a tool-calls event, each call's
 * argument fragments (by call id) come as tool-input tokens; `cutOff` ones
 * come before the stream's end, for a call that never finishes.
 */
class ScriptMembrane {
  options: YieldingStreamOptions[] = [];
  constructor(
    readonly scripts: NormalizedResponse[][],
    readonly fragments: Record<string, string[]>,
    readonly cutOff: Record<string, string[]> = {},
    /**
     * The first stream starts with a call's fragments, then this: an event
     * (a `retrying` goes on with the script, as the retried attempt; others
     * end the stream) or a throw.
     */
    readonly interrupt?: { id: string; fragments: string[]; then: StreamEvent | 'throw' },
  ) {}
  streamYielding(_request: NormalizedRequest, options: YieldingStreamOptions = {}) {
    this.options.push(options);
    const script = this.scripts.shift();
    assert.ok(script, 'unexpected extra inference');
    const stream = new MockYieldingStream(script);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    const { fragments, cutOff } = this;
    const interrupt = this.options.length === 1 ? this.interrupt : undefined;
    const deltas = (id: string, name: string, list: string[]) => list.map((content) => ({
      type: 'tokens', content,
      meta: { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'input', toolId: id, toolName: name },
    }) as unknown as StreamEvent);
    async function* wrapped(): AsyncGenerator<StreamEvent> {
      if (interrupt) {
        yield* deltas(interrupt.id, 'channel_publish', interrupt.fragments);
        if (interrupt.then === 'throw') throw new Error('zz stream broke');
        yield interrupt.then;
        if (interrupt.then.type !== 'retrying') return;
      }
      const it = { [Symbol.asyncIterator]: iterate };
      for await (const event of it as AsyncIterable<StreamEvent>) {
        if (event.type === 'tool-calls') {
          for (const c of event.calls) yield* deltas(c.id, c.name, fragments[c.id] ?? []);
        }
        if (event.type === 'complete') {
          for (const [id, list] of Object.entries(cutOff)) yield* deltas(id, 'channel_publish', list);
        }
        yield event;
      }
    }
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent> })[Symbol.asyncIterator] = () => wrapped();
    return stream;
  }
  asMembrane() { return this as unknown as Membrane; }
}

/** Turns the test's message into the turn's request. */
class WakeModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext) {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true }
      : {};
  }
}

const CHANNEL_PUBLISH_TOOL = {
  name: 'channel_publish', description: 'Publish',
  inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' }, content: { type: 'string' } } },
};

async function harness(membrane: ScriptMembrane, config: Partial<AgentConfig> = {}, opted = new Set(['bosun:meeting:1'])) {
  const dir = mkdtempSync(join(tmpdir(), 'af-speculative-')); dirs.push(dir);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'Glassy', model: 'test', systemPrompt: 'system', proseRouting: 'disabled', ...config }], modules: [new WakeModule()], syncIntervalMs: 0,
  });
  const log: Array<Record<string, unknown>> = [];
  const failing = new Set<string>();
  const throwing = new Set<string>();
  /** For each publish: where the call's text went, which it may go to alone (the registry holds it there). */
  const pins: Array<{ content?: string; pinnedTo?: string }> = [];
  /** While set, a publish waits for it. */
  const gate: { hold?: Promise<void> } = {};
  const ref = (channelId: string) => ({ serverId: 'bosun', channelId });
  const target: Record<string, unknown> = {
    resolveLocus: () => ref('bosun:meeting:1'),
    speculativeTarget: ({ channelId }: { channelId: string }) => (opted.has(channelId) ? ref(channelId) : null),
    sendSpeculativeChunk: (to: ChannelRef, conversationId: string, streamId: string, seq: number, content: string) =>
      log.push({ kind: 'chunk', channelId: to.channelId, conversationId, streamId, seq, content }),
    sendSpeculativeComplete: (to: ChannelRef, conversationId: string, streamId: string, content: string, cancelled: boolean) =>
      log.push({ kind: 'complete', channelId: to.channelId, conversationId, streamId, content, ...(cancelled ? { cancelled } : {}) }),
    handleChannelToolCall: async (name: string, input: { channelId?: string; content?: string }, origin: { speculativeStream?: { streamId: string; live?: boolean } },
      published: { outcome?: unknown } = {}) => {
      if (name !== 'channel_publish') return { success: true, data: {} };
      log.push({ kind: 'publish', channelId: input.channelId, content: input.content, ...(origin.speculativeStream?.live !== false && origin.speculativeStream ? { streamId: origin.speculativeStream.streamId } : {}) });
      pins.push({ content: input.content, pinnedTo: (origin.speculativeStream as { channel?: ChannelRef } | undefined)?.channel?.channelId });
      await gate.hold;
      if (throwing.has(input.content ?? '')) throw new Error('zz transport closed');
      const fails = failing.has(input.content ?? '');
      published.outcome = fails
        ? { status: 'failed', destination: ref(input.channelId!), reason: 'the stub reported delivered: false', at: Date.now() }
        : { status: 'delivered', destination: ref(input.channelId!), at: Date.now() };
      return fails ? { success: false, error: 'not delivered', isError: true } : { success: true, data: { delivered: true } };
    },
    getChannelTools: () => [CHANNEL_PUBLISH_TOOL],
    getDescriptor: () => undefined,
    isChannelOpen: () => true,
    getDefaultPublishChannel: () => null,
    channelsNamed: (name: string) => [ref(name)],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(target, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
  });
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, log, failing, throwing, gate, pins, run };
}

test('framework: off by default; no tool-input deltas are asked for and nothing streams', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Hi.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Hi."}'] },
  );
  const h = await harness(membrane);
  try {
    await h.run();
    assert.equal((membrane.options[0] as { emitToolInputDeltas?: boolean }).emitToolInputDeltas, undefined);
    assert.deepEqual(h.log, [{ kind: 'publish', channelId: 'bosun:meeting:1', content: 'Hi.' }]);
  } finally { await h.framework.stop(); }
});

test('framework: on, the text streams ahead of the publish, which carries the stream id and completes it', async () => {
  const membrane = new ScriptMembrane(
    [[
      round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Good question.\nThe answer is yes.' })),
      round(call('p2', 'channel_publish', { channelId: 'text-chat', content: 'Not spoken.' })),
      final(text('done')),
    ]],
    {
      p1: ['{"channelId": "bosun:meet', 'ing:1", "serverId": "bosun", "content": "Good ques', 'tion.\\nThe answer', ' is yes."}'],
      p2: ['{"channelId":"text-chat","serverId":"bosun","content":"Not spoken."}'],
    },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.equal((membrane.options[0] as { emitToolInputDeltas?: boolean }).emitToolInputDeltas, true);
    const streamId = 'spec_p1';
    assert.deepEqual(h.log, [
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 0, content: 'Good ques' },
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 1, content: 'tion.\nThe answer' },
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 2, content: ' is yes.' },
      { kind: 'publish', channelId: 'bosun:meeting:1', content: 'Good question.\nThe answer is yes.', streamId },
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, content: 'Good question.\nThe answer is yes.' },
      // A channel that didn't opt in: as before.
      { kind: 'publish', channelId: 'text-chat', content: 'Not spoken.' },
    ]);
  } finally { await h.framework.stop(); }
});

test('framework: a failed publish and a call cut off before it finished are cancelled', async () => {
  const membrane = new ScriptMembrane(
    [[
      round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Will fail.' })),
      final(text('done')),
    ]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Will ', 'fail."}'] },
    { cut: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Never fin'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  h.failing.add('Will fail.');
  try {
    await h.run();
    const ends = h.log.filter((e) => e.kind === 'complete');
    assert.deepEqual(ends, [
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId: 'spec_p1', content: '', cancelled: true },
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId: 'spec_cut', content: '', cancelled: true },
    ]);
    assert.deepEqual(h.log.filter((e) => e.kind === 'chunk' && e.streamId === 'spec_cut').map((e) => e.content), ['Never fin']);
  } finally { await h.framework.stop(); }
});

test('framework: a call naming no channel streams to the turn default once it is finished', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { content: 'Default channel.' })), final(text('done'))]],
    { p1: ['{"content":"Default ', 'channel."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.deepEqual(h.log.map((e) => [e.kind, e.content]), [
      ['chunk', 'Default channel.'],
      ['publish', 'Default channel.'],
      ['complete', 'Default channel.'],
    ]);
    assert.equal(h.log[1]!.streamId, 'spec_p1');
  } finally { await h.framework.stop(); }
});

test('framework: a stop() before the publish starts cancels the stream, and the publish is refused', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Half said.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Half ', 'said."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let stopping: Promise<void> | undefined;
  const failed: string[] = [];
  h.framework.onTrace((e) => {
    const event = e as unknown as { type: string; tool?: string; error?: string };
    if (event.type === 'tool:started' && event.tool === 'channel_publish') stopping ??= h.framework.stop();
    if (event.type === 'tool:failed' && event.tool === 'channel_publish') failed.push(event.error ?? '');
  });
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await h.framework.runUntilIdle().catch(() => {});
    await stopping;
    assert.deepEqual(h.log.map((e) => [e.kind, e.content, e.cancelled ?? false]), [
      ['chunk', 'Half ', false],
      ['chunk', 'said.', false],
      ['complete', '', true],
    ]);
    assert.equal(failed.length, 1);
    assert.match(failed[0]!, /stopping/);
  } finally { await (stopping ?? h.framework.stop()); }
});

test("framework: another agent's result with the same call id leaves a stream alone", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Mine.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Mine."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const running = h.run();
    for (let i = 0; i < 200 && !h.log.some((e) => e.kind === 'publish'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(h.log.some((e) => e.kind === 'publish'), 'the publish started');
    h.framework.pushEvent({
      type: 'tool-result', callId: 'p1', toolName: 'channel_publish', agentName: 'Other', moduleName: 'channels',
      result: { success: true, data: {} },
    } as ProcessEvent);
    release();
    await running;
    assert.deepEqual(h.log.filter((e) => e.kind === 'complete').map((e) => [e.content, e.cancelled ?? false]), [['Mine.', false]]);
  } finally { release(); await h.framework.stop(); }
});

test('framework: a stop() while a call to a channel that did not opt in is written leaves its publish alone', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'text-chat', content: 'Plain.' })), final(text('done'))]],
    { p1: ['{"channelId":"text-chat","serverId":"bosun","content":"Pla', 'in."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let stopping: Promise<void> | undefined;
  const failed: string[] = [];
  // The stop comes while the call is still being written: its arguments' channel is being resolved.
  const registry = (h.framework as unknown as { channelRegistry: { speculativeTarget: (...a: unknown[]) => unknown } }).channelRegistry;
  const original = registry.speculativeTarget;
  (registry as unknown as Record<string, unknown>).speculativeTarget = (...a: unknown[]) => {
    stopping ??= h.framework.stop();
    return original(...a);
  };
  h.framework.onTrace((e) => {
    const event = e as unknown as { type: string; tool?: string; error?: string };
    if (event.type === 'tool:failed' && event.tool === 'channel_publish') failed.push(event.error ?? '');
  });
  try {
    h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await h.framework.runUntilIdle().catch(() => {});
    await stopping;
    assert.ok(stopping, 'stop() ran while the call was written');
    assert.deepEqual(failed.filter((e) => /stopping/.test(e)), []);
    assert.deepEqual(h.log.filter((e) => e.kind !== 'publish'), [], 'nothing streamed');
  } finally { await (stopping ?? h.framework.stop()); }
});

/** The log's entries for one stream, as [kind, content, cancelled]. */
const streamLog = (log: Array<Record<string, unknown>>, streamId: string) =>
  log.filter((e) => e.streamId === streamId).map((e) => [e.kind, e.content, e.cancelled ?? false]);

for (const [name, then] of [
  ['an error event', { type: 'error', error: new Error('zz overloaded') } as unknown as StreamEvent],
  ['an aborted event', { type: 'aborted', reason: 'timeout', message: 'zz deadline' } as unknown as StreamEvent],
  ['a stream that throws', 'throw'],
] as const) {
  test(`framework: ${name} cancels a stream whose call was being written, once, and nothing publishes`, async () => {
    const membrane = new ScriptMembrane(
      [[final(text('unused'))], [final(text('done'))], [final(text('done'))]],
      {},
      {},
      { id: 'x1', fragments: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Interr', 'upted'], then },
    );
    const h = await harness(membrane, { speculativeChannelChunks: true });
    try {
      await h.run().catch(() => {});
      assert.deepEqual(streamLog(h.log, 'spec_x1'), [
        ['chunk', 'Interr', false],
        ['chunk', 'upted', false],
        ['complete', '', true],
      ]);
      assert.equal(h.log.filter((e) => e.kind === 'publish').length, 0);
    } finally { await h.framework.stop(); }
  });
}

test("framework: a refusal retry cancels the refused attempt's stream, and the retried attempt's call streams under its own id", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Second try.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Second try."}'] },
    {},
    {
      id: 'r1', fragments: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Refused ans'],
      then: { type: 'retrying', attempt: 1, maxAttempts: 2, reason: 'refusal' } as unknown as StreamEvent,
    },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.deepEqual(streamLog(h.log, 'spec_r1'), [['chunk', 'Refused ans', false], ['complete', '', true]]);
    assert.deepEqual(streamLog(h.log, 'spec_p1'), [
      ['chunk', 'Second try.', false],
      ['publish', 'Second try.', false],
      ['complete', 'Second try.', false],
    ]);
    const cancelAt = h.log.findIndex((e) => e.streamId === 'spec_r1' && e.kind === 'complete');
    const retriedAt = h.log.findIndex((e) => e.streamId === 'spec_p1');
    assert.ok(cancelAt < retriedAt, 'the cancel goes before the retried attempt streams');
  } finally { await h.framework.stop(); }
});

test('framework: a call membrane marked as cut off or out of order is cancelled before dispatch refuses it', async () => {
  const membrane = new ScriptMembrane(
    [[round({ ...call('p1', 'channel_publish', {}), unparseableInput: '{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Half' } as ContentBlock), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Half'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.deepEqual(streamLog(h.log, 'spec_p1'), [['chunk', 'Half', false], ['complete', '', true]]);
    assert.equal(h.log.filter((e) => e.kind === 'publish').length, 0, 'dispatch refused it');
  } finally { await h.framework.stop(); }
});

test("framework: a result for the agent's own streamed call before its publish (refused) cancels the stream", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Refused.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Refused."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  // A refusal on the way to the publish answers the call with a result, as a module's guard does.
  const fw = h.framework as unknown as { dispatchChannelToolCall: (agentName: string, c: { id: string; name: string }) => void };
  fw.dispatchChannelToolCall = (agentName, c) => h.framework.pushEvent({
    type: 'tool-result', callId: c.id, toolName: c.name, agentName, moduleName: 'channels',
    result: { success: false, error: 'zz refused', isError: true },
  } as ProcessEvent);
  try {
    await h.run();
    assert.deepEqual(streamLog(h.log, 'spec_p1'), [['chunk', 'Refused.', false], ['complete', '', true]]);
  } finally { await h.framework.stop(); }
});

test("framework: a publish that throws cancels its stream", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Lost.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Lost."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  h.throwing.add('Lost.');
  try {
    await h.run();
    assert.deepEqual(streamLog(h.log, 'spec_p1'), [['chunk', 'Lost.', false], ['publish', 'Lost.', false], ['complete', '', true]]);
  } finally { await h.framework.stop(); }
});

test('framework: nothing streams where dispatch would refuse the publish (denyToolsAtDispatch, allowedTools, a fork bound elsewhere)', async () => {
  const script = () => new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Kept back.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Kept back."}'] },
  );
  for (const config of [
    { denyToolsAtDispatch: ['channel_publish'] },
    { allowedTools: ['think'] },
  ] as Array<Partial<AgentConfig>>) {
    const h = await harness(script(), { speculativeChannelChunks: true, ...config });
    try {
      await h.run();
      assert.deepEqual(h.log.filter((e) => e.kind !== 'publish'), [], JSON.stringify(config));
    } finally { await h.framework.stop(); }
  }
  // A conversation fork bound to another channel: its publish is refused there, so nothing streams there.
  const h = await harness(script(), { speculativeChannelChunks: true });
  (h.framework as unknown as { homeOf: () => ChannelRef | undefined }).homeOf = () => ({ serverId: 'bosun', channelId: 'bosun:home' });
  try {
    await h.run();
    assert.deepEqual(h.log.filter((e) => e.kind === 'chunk'), []);
  } finally { await h.framework.stop(); }
});

test("framework: a stop() while the publish is under way leaves the stream to the publish's outcome", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Delivered.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Delivered."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
  let stopping: Promise<void> | undefined;
  try {
    const running = h.run().catch(() => {});
    for (let i = 0; i < 200 && !h.log.some((e) => e.kind === 'publish'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(h.log.some((e) => e.kind === 'publish'), 'the publish started');
    stopping = h.framework.stop();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await stopping;
    await running;
    assert.deepEqual(streamLog(h.log, 'spec_p1'), [
      ['chunk', 'Delivered.', false],
      ['publish', 'Delivered.', false],
      ['complete', 'Delivered.', false],
    ]);
  } finally { release(); await (stopping ?? h.framework.stop()); }
});

test("framework: stop() waits for a publish under way that ends a stream, so a delivered one's complete goes out before it returns", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Answered late.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Answered late."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
  let stopping: Promise<void> | undefined;
  try {
    const running = h.run().catch(() => {});
    for (let i = 0; i < 200 && !h.log.some((e) => e.kind === 'publish'); i++) await new Promise((r) => setTimeout(r, 5));
    stopping = h.framework.stop().then(() => { h.log.push({ kind: 'stopped' }); });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.log.some((e) => e.kind === 'stopped'), false, 'stop() is still waiting for the publish');
    release();
    await stopping;
    await running;
    const kinds = h.log.map((e) => e.kind === 'complete' ? `complete:${String(e.content)}` : String(e.kind));
    assert.ok(kinds.indexOf('complete:Answered late.') >= 0 && kinds.indexOf('complete:Answered late.') < kinds.indexOf('stopped'), kinds.join(' '));
  } finally { release(); await (stopping ?? h.framework.stop()); }
});

test("framework: stop()'s wait for such a publish ends at the caller's bound, without failing stop()", async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Never answered.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Never answered."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  let release!: () => void;
  h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    void h.run().catch(() => {});
    for (let i = 0; i < 200 && !h.log.some((e) => e.kind === 'publish'); i++) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    await h.framework.stop(300);
    assert.ok(Date.now() - started < 5000, 'stop() returned at its bound');
  } finally { release(); }
});

test('framework: a result that arrives before the publish keeps the call held to where its text went', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', serverId: 'bosun', content: 'Spoken.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Spoken."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  // A refusal on its way, delivered while the publish is being dispatched (as from a trace listener).
  h.framework.onTrace((e) => {
    const event = e as unknown as { type: string; tool?: string; callId?: string };
    if (event.type === 'tool:started' && event.tool === 'channel_publish') {
      h.framework.pushEvent({
        type: 'tool-result', callId: event.callId!, toolName: 'channel_publish', agentName: 'Glassy', moduleName: 'channels',
        result: { success: false, error: 'zz refused', isError: true },
      } as ProcessEvent);
    }
  });
  try {
    await h.run();
    assert.deepEqual(streamLog(h.log, 'spec_p1').slice(0, 2), [['chunk', 'Spoken.', false], ['complete', '', true]]);
    assert.deepEqual(h.pins, [{ content: 'Spoken.', pinnedTo: 'bosun:meeting:1' }], 'the publish still carries where the text went');
  } finally { await h.framework.stop(); }
});

test('framework: executeToolCall with a call whose text went out holds it to where its text went', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', serverId: 'bosun', content: 'Once.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","serverId":"bosun","content":"Once."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    await h.framework.executeToolCall({ id: 'p1', name: 'channel_publish', input: { channelId: 'other', content: 'Once.' }, callerAgentName: 'Glassy' });
    assert.deepEqual(h.pins.map((p) => p.pinnedTo), ['bosun:meeting:1', 'bosun:meeting:1']);
  } finally { await h.framework.stop(); }
});
