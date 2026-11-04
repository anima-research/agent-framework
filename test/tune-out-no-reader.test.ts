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
  channelRegistry: {
    getTuneOutState(serverId: string, channelId: string): unknown;
    readCoordinatorState(id: string): unknown;
    desiredStates: Map<string, { state: string; source: string }>;
  };
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
  // Refused before its options are read, as all-except is below.
  const one = coordinator.enter('editor', 'chat', { durationSeconds: 'soon' }, 'agent-tool');
  assert.equal(one.ok, false);
  assert.match((one as { error: string }).error, /no reader is configured here to read a held channel/);
  assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null);
  // Refused before its options are read: a bad duration isn't sent back for correction.
  const all = coordinator.enterAllExcept({ serverId: 'editor', channelId: 'other' }, { durationSeconds: 'soon' }, 'agent-tool');
  assert.equal(all.ok, false);
  assert.match((all as { error: string }).error, /no reader is configured here to read a held channel/);
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
  const record = internals(f).channelRegistry.desiredStates.get('editor\u0000chat');
  assert.equal(record?.state, 'open', 'decided open again, as a cancel leaves it');
  assert.equal(record?.source, 'agent-tool', "under the agent's own source, which the housekeeping guard reads");
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
  options.framework = {}; // announce on, as by default
  await f.create();
  const announced: string[] = [];
  // Any attempt counts: at a start the channel isn't registered yet, so a
  // post tried then is traced as tune-out:announce-failed, not announced.
  f.framework.onTrace((e) => { if (e.type.startsWith('tune-out:announce')) announced.push(e.type); }, { replay: true });
  // A post is asynchronous: give one tried at create time the time to settle into its trace.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const scoped = releases(f).filter((m) => m.metadata?.scope === 'all-except');
  assert.equal(scoped.length, 1, 'the all-except hold was released');
  assert.match(JSON.stringify(scoped[0]!.content), /document_diff/);
  assert.equal(internals(f).channelRegistry.readCoordinatorState('tune-out/agent/all-except') ?? null, null, 'its record is cleared');
  assert.deepEqual(announced, [], 'no release is announced in the excepted channel while the host starts');
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
  // With the reader gone, tune_out and focus are no longer offered, and no new hold is made.
  const names = f.framework.getAllTools().map((tool) => tool.name);
  assert.ok(names.length > 0 && !names.includes('tune_out') && !names.includes('focus'), names.join(', '));
  const again = coordinator.enter('editor', 'chat', {}, 'agent-tool');
  assert.equal(again.ok, false);
  assert.match((again as { error: string }).error, /no reader is configured here to read a held channel/);
  const focus = coordinator.enterAllExcept({ serverId: 'editor', channelId: 'chat' }, { durationSeconds: 600 }, 'agent-tool');
  assert.equal(focus.ok, false);
});

test('when the persistent reader is stopped during an all-except hold, the hold ends with it and its backlog goes to the resident', async (t) => {
  const f = await fixture({ framework: { subconscious: READER, tuneOut: { announce: false } } as Partial<FrameworkConfig> });
  t.after(f.close);
  await f.register('chat');
  await f.register('other');
  const coordinator = internals(f).tuneOutCoordinator!;
  assert.ok(coordinator.enterAllExcept({ serverId: 'editor', channelId: 'other' }, { durationSeconds: 3600 }, 'agent-tool').ok);
  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => residentRows(f).some((m) => m.metadata?.tuneOut && JSON.stringify(m.content).includes('document_diff')), 'the batch held');
  f.framework.stopAgent(internals(f).subconsciousAgentName!);
  assert.equal(coordinator.getAllExcept(), null, 'the all-except hold ended');
  const scoped = releases(f).filter((m) => m.metadata?.scope === 'all-except');
  assert.equal(scoped.length, 1);
  assert.match(JSON.stringify(scoped[0]!.content), /its reader ended/);
  assert.match(JSON.stringify(scoped[0]!.content), /document_diff/);
});

test('a release that fails when the reader is stopped is tried again until it goes', async (t) => {
  const f = await fixture({ framework: { subconscious: READER, tuneOut: { announce: false } } as Partial<FrameworkConfig> });
  t.after(f.close);
  await f.register('chat');
  const coordinator = internals(f).tuneOutCoordinator!;
  assert.ok(coordinator.enter('editor', 'chat', {}, 'agent-tool').ok, 'an open-ended hold');
  await f.send('push/event', f.params('e1', 'notice_fallback', { channelId: 'chat', key: 'doc1', deferred: true }));
  await eventually(() => residentRows(f).some((m) => m.metadata?.tuneOut && JSON.stringify(m.content).includes('document_diff')), 'the batch held');
  const registry = internals(f).channelRegistry as unknown as { cancelTuneOut: (...args: unknown[]) => unknown };
  const cancel = registry.cancelTuneOut;
  registry.cancelTuneOut = () => { throw new Error('the store refused the write'); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    f.framework.stopAgent(internals(f).subconsciousAgentName!);
    assert.notEqual(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null, 'the first try failed: still held');
  } finally {
    registry.cancelTuneOut = cancel;
  }
  t.mock.timers.tick(60_000);
  t.mock.timers.reset();
  assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'chat'), null, 'the retry released it');
  const withBatch = releases(f).filter((m) => JSON.stringify(m.content).includes('document_diff'));
  assert.equal(withBatch.length, 1, 'the held batch is delivered once');
  assert.equal(releases(f).length, 1, 'and the retry wrote no second notice');
});
