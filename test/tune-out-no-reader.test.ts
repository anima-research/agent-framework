/**
 * No hold without a reader (0.33.0): `tuneOut.enabled` is refused, a hold is
 * refused once the reader is gone, and a hold on record at a start with no
 * reader configured (one 0.32's `tuneOut.enabled` left, or one whose reader
 * the config no longer has) ends with its backlog delivered to the resident,
 * the per-channel holds and the all-except scope alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import type { FrameworkConfig } from '../src/types/index.js';

const READER = { enabled: true, systemPrompt: 'You are the Subconscious. Report briefly.' } as const;

type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  subconsciousAgentName: string | null;
  channelRegistry: { getTuneOutState(serverId: string, channelId: string): unknown };
};
const internals = (f: { framework: AgentFramework }) => f.framework as unknown as Internals;
const residentRows = (f: { framework: AgentFramework }) =>
  f.framework.getAgent('agent')!.getContextManager().getAllMessages() as unknown as Array<{ content: unknown; metadata?: Record<string, unknown> }>;
const releases = (f: { framework: AgentFramework }) =>
  residentRows(f).filter((m) => m.metadata?.kind === 'tune-out-cancel');

test('create refuses tuneOut.enabled before anything opens', async () => {
  await assert.rejects(
    AgentFramework.create({ tuneOut: { enabled: true } } as unknown as FrameworkConfig),
    /tuneOut\.enabled was removed in agent-framework 0\.33\.0/,
  );
});

test('once the reader is gone, a hold is refused for one channel and for all-except alike, and nothing is recorded', async (t) => {
  const f = await fixture({ framework: { subconscious: READER, tuneOut: { announce: false } } as Partial<FrameworkConfig> });
  t.after(f.close);
  await f.register('chat');
  await f.register('other');
  const coordinator = internals(f).tuneOutCoordinator!;
  internals(f).subconsciousAgentName = null; // the reader ended
  const one = coordinator.enter('editor', 'chat', { durationSeconds: 600 }, 'agent-tool');
  assert.equal(one.ok, false);
  assert.match((one as { error: string }).error, /no subconscious resident to watch a channel/);
  assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null);
  // Refused before its options are read: a bad duration isn't sent back for correction.
  const all = coordinator.enterAllExcept({ serverId: 'editor', channelId: 'other' }, { durationSeconds: 'soon' }, 'agent-tool');
  assert.equal(all.ok, false);
  assert.match((all as { error: string }).error, /no subconscious resident to watch a channel/);
  assert.equal(coordinator.getAllExcept(), null);
});

test('a hold on record at a start with no reader ends there, its backlog delivered once', async (t) => {
  const options: { framework: Partial<FrameworkConfig> } = { framework: { subconscious: READER, tuneOut: { announce: false } } };
  const f = await fixture(options as never);
  t.after(f.close);
  await f.register('chat');
  assert.ok(internals(f).tuneOutCoordinator!.enter('editor', 'chat', { durationSeconds: 3600 }, 'agent-tool').ok);
  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => residentRows(f).some((m) => m.metadata?.tuneOut && JSON.stringify(m.content).includes('document_diff')), 'the batch held');

  await f.framework.stop();
  options.framework = { tuneOut: { announce: false } };
  await f.create();
  assert.equal(internals(f).tuneOutCoordinator, null, 'no reader, no coordinator kept');
  assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null, 'the hold ended');
  assert.equal(releases(f).length, 1);
  const dump = JSON.stringify(releases(f)[0]!.content);
  assert.match(dump, /document_diff/, 'the held batch is in the backlog');
  assert.match(dump, /no reader is configured/);

  await f.framework.stop();
  await f.create();
  assert.equal(releases(f).length, 1, 'a later start releases nothing again');
});

test('an all-except hold on record at a start with no reader ends there, its backlog delivered', async (t) => {
  const options: { framework: Partial<FrameworkConfig> } = { framework: { subconscious: READER, tuneOut: { announce: false } } };
  const f = await fixture(options as never);
  t.after(f.close);
  await f.register('chat');
  await f.register('other');
  assert.ok(internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'other' }, { durationSeconds: 3600 }, 'agent-tool').ok);
  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => residentRows(f).some((m) => m.metadata?.tuneOut && JSON.stringify(m.content).includes('document_diff')), 'the batch held');

  await f.framework.stop();
  options.framework = { tuneOut: { announce: false } };
  await f.create();
  const scoped = releases(f).filter((m) => m.metadata?.scope === 'all-except');
  assert.equal(scoped.length, 1, 'the all-except hold was released');
  assert.match(JSON.stringify(scoped[0]!.content), /document_diff/);
});

test('when the persistent reader is stopped, its holds end with it and each backlog goes to the resident', async (t) => {
  const f = await fixture({ framework: { subconscious: READER, tuneOut: { announce: false } } as Partial<FrameworkConfig> });
  t.after(f.close);
  await f.register('chat');
  const coordinator = internals(f).tuneOutCoordinator!;
  assert.ok(coordinator.enter('editor', 'chat', {}, 'agent-tool').ok, 'an open-ended hold');
  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => residentRows(f).some((m) => m.metadata?.tuneOut && JSON.stringify(m.content).includes('document_diff')), 'the batch held');
  f.framework.stopAgent(internals(f).subconsciousAgentName!);
  assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null, 'the hold ended');
  assert.equal(releases(f).length, 1);
  assert.match(JSON.stringify(releases(f)[0]!.content), /its reader ended/);
  assert.match(JSON.stringify(releases(f)[0]!.content), /document_diff/);
});
