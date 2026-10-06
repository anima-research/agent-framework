/**
 * Visibly-empty MCPL content never becomes a wake (agent-framework#235 F2).
 *
 * An empty push or channel message is stripped before the model sees it, so
 * a wake queued for it shows the model `[Continue]` or an older message as
 * the newest — a wake with no visible cause. The MCPL boundary rejects such
 * content (-32602 on push/event, an itemized result on channels/incoming);
 * only a coalescing retraction and the exact silent-heartbeat marker may be
 * empty. The store/wake site drops anything that gets past the boundary.
 *
 * Run: node --import tsx --test test/mcpl-empty-content.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { PushHandler, type McplPushEvent } from '../src/mcpl/push-handler.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import { CapabilityGrant, ALL_CAPABILITY_PATHS } from '../src/mcpl/capability-grant.js';
import { isSilentHeartbeatMarker, isVisiblyEmptyContent } from '../src/mcpl/visible-content.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { PushEventParams, PushEventResult } from '../src/mcpl/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { fixture, TS } from './helpers/coalescing-fixture.js';

const EMPTY_SHAPES: Array<[string, unknown[]]> = [
  ['[]', []],
  ["''", [{ type: 'text', text: '' }]],
  ['whitespace-only text', [{ type: 'text', text: ' \n\t ' }]],
  ['several blank text blocks', [{ type: 'text', text: '' }, { type: 'text', text: '  ' }]],
];
const IMAGE = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
const MARKER_ORIGIN = { source: 'heartbeat', reason: 'schedule', silent: true };

// ---------------------------------------------------------------------------
// The shared predicates
// ---------------------------------------------------------------------------

test('isVisiblyEmptyContent: blank text is empty; any non-text block or real text is not', () => {
  for (const [, content] of EMPTY_SHAPES) assert.equal(isVisiblyEmptyContent(content), true);
  assert.equal(isVisiblyEmptyContent([{ type: 'text', text: 7 }]), true, 'non-string text is stripped downstream');
  assert.equal(isVisiblyEmptyContent([IMAGE]), false);
  assert.equal(isVisiblyEmptyContent([{ type: 'text', text: ' ' }, { type: 'text', text: 'x' }]), false);
});

test('isSilentHeartbeatMarker matches only the exact marker', () => {
  const marker = { serverId: 'heartbeat', featureSet: 'heartbeat', origin: MARKER_ORIGIN, content: [] };
  assert.equal(isSilentHeartbeatMarker(marker), true);
  assert.equal(isSilentHeartbeatMarker({ ...marker, serverId: 'other' }), false);
  assert.equal(isSilentHeartbeatMarker({ ...marker, featureSet: 'other' }), false);
  assert.equal(isSilentHeartbeatMarker({ ...marker, origin: { ...MARKER_ORIGIN, source: 'reminder' } }), false);
  assert.equal(isSilentHeartbeatMarker({ ...marker, origin: { ...MARKER_ORIGIN, silent: 'true' } }), false);
  assert.equal(isSilentHeartbeatMarker({ ...marker, content: [{ type: 'text', text: '' }] }), false, 'blank text is not the marker');
});

// ---------------------------------------------------------------------------
// push/event boundary (PushHandler)
// ---------------------------------------------------------------------------

function pushHarness(handleCoalesced?: (serverId: string, params: PushEventParams, event: McplPushEvent) => Promise<PushEventResult>) {
  const pushed: McplPushEvent[] = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const handler = new PushHandler(
    { validateInbound() {} } as unknown as FeatureSetManager,
    (e) => { pushed.push(e); },
    (t) => { traces.push(t); },
    undefined,
    handleCoalesced,
  );
  const send = async (serverId: string, params: Omit<Partial<PushEventParams>, 'payload'> & { payload: { content: unknown[] } }, legacy = false) => {
    const out: { result?: PushEventResult; error?: { code: number; message: string; data?: unknown } } = {};
    await handler.handlePushEvent(serverId, { featureSet: 'fs', eventId: `e-${Math.random()}`, timestamp: TS, ...params } as PushEventParams, {
      respond: (r) => { out.result = r; },
      ...(legacy ? {} : { respondError: (code: number, message: string, data?: unknown) => { out.error = { code, message, data }; } }),
    });
    return out;
  };
  return { pushed, traces, send };
}

for (const [label, content] of EMPTY_SHAPES) {
  test(`push/event with ${label} content is rejected -32602 with the field, and queues nothing`, async () => {
    const h = pushHarness();
    const out = await h.send('editor', { payload: { content } });
    assert.equal(out.result, undefined);
    assert.equal(out.error?.code, -32602);
    assert.deepEqual(out.error?.data, { field: 'payload.content' });
    assert.equal(h.pushed.length, 0, 'no event queued');
    assert.ok(h.traces.some((t) => t.type === 'mcpl:push-event-rejected' && t.reason === 'empty-content' && t.serverId === 'editor'));
  });
}

test('a rejected empty push does not burn its eventId for a corrected retry', async () => {
  const h = pushHarness();
  const first = await h.send('editor', { eventId: 'same', payload: { content: [] } });
  assert.equal(first.error?.code, -32602);
  const retry = await h.send('editor', { eventId: 'same', payload: { content: [{ type: 'text', text: 'now with words' }] } });
  assert.equal(retry.result?.accepted, true);
  assert.equal(h.pushed.length, 1);
});

test('a legacy responder without an error path gets accepted:false, reason empty-content', async () => {
  const h = pushHarness();
  const out = await h.send('editor', { payload: { content: [] } }, true);
  assert.deepEqual(out.result, { accepted: false, reason: 'empty-content' });
  assert.equal(h.pushed.length, 0);
});

test('image-only push content is accepted', async () => {
  const h = pushHarness();
  const out = await h.send('editor', { payload: { content: [IMAGE] } });
  assert.equal(out.result?.accepted, true);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0]!.content[0]!.type, 'image');
});

test('the exact silent-heartbeat marker is accepted with its empty payload', async () => {
  const h = pushHarness();
  const out = await h.send('heartbeat', { featureSet: 'heartbeat', origin: MARKER_ORIGIN, payload: { content: [] } });
  assert.equal(out.result?.accepted, true);
  assert.equal(h.pushed.length, 1);
  assert.deepEqual(h.pushed[0]!.content, []);
});

test('the marker from another server, or with blank text instead of no content, is rejected', async () => {
  const h = pushHarness();
  const spoofed = await h.send('other', { featureSet: 'heartbeat', origin: MARKER_ORIGIN, payload: { content: [] } });
  assert.equal(spoofed.error?.code, -32602);
  const blank = await h.send('heartbeat', { featureSet: 'heartbeat', origin: MARKER_ORIGIN, payload: { content: [{ type: 'text', text: ' ' }] } });
  assert.equal(blank.error?.code, -32602);
  assert.equal(h.pushed.length, 0);
});

test('coalescing: an empty retraction is exempt; an empty plain occurrence is rejected before the coalescer', async () => {
  const seen: PushEventParams[] = [];
  const h = pushHarness(async (_s, params) => { seen.push(params); return { accepted: true, coalesce: { outcome: 'consumed' } }; });
  const retract = await h.send('editor', { coalesce: { key: 'k', retract: true }, payload: { content: [] } });
  assert.equal(retract.result?.accepted, true);
  assert.equal(seen.length, 1, 'retraction reached the coalescer');
  const plain = await h.send('editor', { coalesce: { key: 'k' }, payload: { content: [{ type: 'text', text: '' }] } });
  assert.equal(plain.error?.code, -32602);
  assert.deepEqual(plain.error?.data, { field: 'payload.content' });
  assert.equal(seen.length, 1, 'the empty plain occurrence never reached the coalescer');
});

// ---------------------------------------------------------------------------
// channels/incoming boundary (ChannelRegistry)
// ---------------------------------------------------------------------------

function channelHarness() {
  const pushed: unknown[] = [];
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const server = { grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []) };
  const registry = new ChannelRegistry(
    { getServer: () => server } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    (e) => { pushed.push(e); },
    (t) => { traces.push(t); },
  );
  (registry as unknown as { channels: Map<string, unknown> }).channels
    .set('discord:chan', { serverId: 'discord', descriptor: { id: 'chan', type: 'discord', label: 'chan' }, open: false });
  const send = async (...contents: unknown[][]) => {
    let response: { results: Array<{ messageId: string; accepted: boolean; reason?: string }> } | undefined;
    await registry.handleIncoming('discord', {
      messages: contents.map((content, i) => ({
        channelId: 'chan', messageId: `m${i}`, author: { id: 'u', name: 'User' }, timestamp: TS, content,
      })),
    } as never, { respond: (r: unknown) => { response = r as typeof response; } });
    return response!.results;
  };
  return { pushed, traces, send };
}

for (const [label, content] of EMPTY_SHAPES) {
  test(`channels/incoming with ${label} content is rejected per message and queues nothing`, async () => {
    const h = channelHarness();
    const results = await h.send(content);
    assert.deepEqual(results, [{ messageId: 'm0', accepted: false, reason: 'empty_content' }]);
    assert.equal(h.pushed.length, 0);
    assert.ok(h.traces.some((t) => t.type === 'mcpl:channel-incoming-rejected' && t.reason === 'empty-content'));
  });
}

test('channels/incoming: an empty message fails alone; its siblings and image-only messages are accepted', async () => {
  const h = channelHarness();
  const results = await h.send([], [{ type: 'text', text: 'hello' }], [IMAGE]);
  assert.deepEqual(results.map((r) => r.accepted), [false, true, true]);
  assert.equal(h.pushed.length, 2);
});

// ---------------------------------------------------------------------------
// Wire level, including coalescing retractions
// ---------------------------------------------------------------------------

test('wire: an empty push/event gets a -32602 error, stores nothing and wakes nobody', async (t) => {
  const f = await fixture(); t.after(f.close);
  const before = f.framework.getAgent('agent')!.getContextManager().getMessageCount();
  for (const [, content] of EMPTY_SHAPES) {
    const r = await f.send('push/event', { featureSet: 'doc', eventId: `e-${Math.random()}`, timestamp: TS, payload: { content } });
    assert.equal(r.error?.code, -32602);
    assert.equal(r.error?.data?.field, 'payload.content');
  }
  await f.framework.runUntilIdle();
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getMessageCount(), before);
  assert.equal(f.membrane.calls.length, 0, 'no inference');
});

test('wire: an empty deferred notice is rejected (its fallback must be self-contained, RFC-006 §5.1)', async (t) => {
  const f = await fixture(); t.after(f.close);
  const r = await f.send('push/event', f.params('1', '', { deferred: true }));
  assert.equal(r.error?.code, -32602);
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 0);
  assert.equal(f.membrane.calls.length, 0);
});

test('wire: a coalesced channel message with no content is rejected; an empty retraction is not', async (t) => {
  const f = await fixture(); t.after(f.close); await f.register();
  const empty = await f.send('channels/incoming', { messages: [f.channel('a', '', { initial: true })] });
  assert.deepEqual(empty.result.results, [{ messageId: 'm', accepted: false, reason: 'empty_content' }]);
  await f.send('channels/incoming', { messages: [f.channel('b', 'original_text', { initial: true })] });
  await f.framework.runUntilIdle();
  const count = f.framework.getAgent('agent')!.getContextManager().getMessageCount();
  const retract = await f.send('channels/incoming', { messages: [f.channel('c', '', { retract: true })] });
  assert.equal(retract.result.results[0].accepted, true);
  assert.equal(retract.result.results[0].coalesce.outcome, 'consumed');
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getMessageCount(), count);
});

test('wire: a retraction whose notice is only blank text appends nothing ("consumed")', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'read_original', { initial: true }));
  await f.framework.runUntilIdle();
  const calls = f.membrane.calls.length;
  const count = f.framework.getAgent('agent')!.getContextManager().getMessageCount();
  const r = await f.send('push/event', f.params('2', '   ', { retract: true }));
  assert.equal(r.result.coalesce.outcome, 'consumed');
  await f.framework.runUntilIdle();
  assert.equal(f.framework.getAgent('agent')!.getContextManager().getMessageCount(), count);
  assert.equal(f.membrane.calls.length, calls, 'no wake');
});

test('wire: a render result of only blank text appends nothing (RFC-006 §5.2)', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.renderer(async () => ({ content: [{ type: 'text', text: ' ' }] }));
  await f.send('push/event', f.params('1', 'fallback_text', { deferred: true }));
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1);
  assert(!f.context().includes('fallback_text'), 'a blank render is not a failed render: no fallback');
  assert(!f.context().includes('coalescingSubject'), 'no materialized occurrence was stored');
});

// ---------------------------------------------------------------------------
// Framework backstop at the store/wake site
// ---------------------------------------------------------------------------

async function frameworkHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'empty-content-af-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
    modules: [],
  });
  const added: string[] = [];
  const dropped: Array<Record<string, unknown>> = [];
  let starts = 0;
  framework.onTrace((e: any) => {
    if (e.type === 'message:added') added.push(e.source);
    if (e.type === 'mcpl:empty-content-dropped') dropped.push(e);
    if (e.type === 'inference:started') starts++;
  });
  return {
    framework, membrane, added, dropped, starts: () => starts,
    close: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('backstop: an empty push that reaches the framework stores no row and queues no wake', async (t) => {
  const x = await frameworkHarness(); t.after(x.close);
  x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
  for (const [, content] of EMPTY_SHAPES) {
    (x.framework as any).handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'module', featureSet: 'fs', eventId: `e-${Math.random()}`,
      content, timestamp: TS, inferenceId: 'i', triggerInference: true,
    });
  }
  await x.framework.runUntilIdle();
  assert.deepEqual(x.added, []);
  assert.equal(x.starts(), 0);
  assert.equal(x.dropped.length, EMPTY_SHAPES.length);
  assert.ok(x.dropped.every((d) => d.lane === 'push' && d.serverId === 'module'));
});

test('backstop: an empty channel message that reaches the framework stores no row and queues no wake', async (t) => {
  const x = await frameworkHarness(); t.after(x.close);
  x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'invented cause' }] as ContentBlock[]));
  await (x.framework as any).handleMcplChannelIncoming({
    type: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'discord:g:c', messageId: 'm1',
    author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: '  ' }], timestamp: TS, triggerInference: true,
  });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.added, []);
  assert.equal(x.starts(), 0);
  assert.deepEqual(x.dropped.map((d) => [d.lane, d.messageId]), [['channel', 'm1']]);
});

test('backstop: image-only push content is stored and wakes', async (t) => {
  const x = await frameworkHarness(); t.after(x.close);
  x.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'saw it' }] as ContentBlock[]));
  (x.framework as any).handleMcplPushEvent({
    type: 'mcpl:push-event', serverId: 'camera', featureSet: 'fs', eventId: 'img',
    content: [{ type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } }],
    timestamp: TS, inferenceId: 'i', triggerInference: true,
  });
  await x.framework.runUntilIdle();
  assert.deepEqual(x.added, ['mcpl:push-event']);
  assert.equal(x.starts(), 1);
});
