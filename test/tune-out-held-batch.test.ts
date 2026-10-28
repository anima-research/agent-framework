/**
 * A deferred push batch in a tuned-out channel: its wake is held, so no turn's
 * assembly would store it while the hold lasts. It's stored at its wake ask,
 * stamped with the hold, so what reads held traffic and the release see it,
 * and the resident's turn after the release reads it once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
};
type Listing = { listActive(): Array<{ serverId: string; channelId: string; params: { epochId: string } }> };

test('a held deferred batch is stored under its hold, released in the dump, and read once after', async (t) => {
  const f = await fixture({ framework: { tuneOut: { enabled: true, announce: false } } as never });
  t.after(f.close);
  await f.register('chat');
  const coordinator = (f.framework as unknown as Internals).tuneOutCoordinator!;
  const entered = coordinator.enter('editor', 'chat', { durationSeconds: 600 }, 'agent-tool');
  assert.ok(entered.ok, 'the channel is tuned out');
  const epochId = (coordinator as unknown as Listing).listActive().find((e) => e.channelId === 'chat')!.params.epochId;

  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  const held = () => f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId);
  await eventually(() => held().some((m) => JSON.stringify(m.content).includes('document_diff')), 'the batch stored under the hold');
  assert.equal(f.renders.length, 1, 'rendered once, at its wake ask');
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'the hold woke nobody');

  const cancelled = coordinator.cancel('editor', 'chat', 'agent-tool', 'done');
  assert.ok(cancelled.ok);
  const dump = f.framework.getAgent('agent')!.getContextManager().getAllMessages()
    .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'tune-out-cancel');
  assert.equal(dump.length, 1);
  assert.match(JSON.stringify(dump[0]!.content), /document_diff/, 'the release dump includes the batch');

  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'no second render');
  const request = f.lastRequest();
  assert.equal(request.split('document_diff').length - 1, 1, "the resident's next turn reads the batch once");
});

test('a hold that ends while its batch renders leaves the batch stored unheld, with the wake an unheld push gets, for every recipient', async (t) => {
  const f = await fixture({
    framework: { tuneOut: { enabled: true, announce: false } } as never,
    agents: [
      { name: 'agent', model: 'test', systemPrompt: 'I am agent.' },
      { name: 'other', model: 'test', systemPrompt: 'I am other.' },
    ],
  });
  t.after(f.close);
  await f.register('chat');
  let release!: () => void;
  const rendering = new Promise<void>((resolve) => { release = resolve; });
  f.renderer(async () => { await rendering; return { content: [{ type: 'text', text: 'document_diff' }] }; });
  const coordinator = (f.framework as unknown as Internals).tuneOutCoordinator!;
  assert.ok(coordinator.enter('editor', 'chat', { durationSeconds: 600 }, 'agent-tool').ok);

  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => f.renders.length === 1, 'the held batch to start rendering');
  assert.ok(coordinator.cancel('editor', 'chat', 'agent-tool', 'done').ok, 'the hold ends while it renders');
  release();
  const pending = () => (f.framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
  await eventually(() => pending().some((r) => r.agentName === 'other'), "the second recipient's wake");
  f.alwaysRespond();
  await f.framework.runUntilIdle();
  const asked = (who: string) => f.membrane.calls.filter((c) => JSON.stringify(c).includes(`I am ${who}.`));
  assert.ok(asked('agent').some((c) => JSON.stringify(c).includes('document_diff')), 'the first recipient reads the batch');
  assert.ok(asked('other').some((c) => JSON.stringify(c).includes('document_diff')), 'the second recipient reads the batch');
  assert.equal(f.renders.length, 1, 'rendered once');
});
