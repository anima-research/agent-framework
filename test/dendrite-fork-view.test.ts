/**
 * A shared fork's view (#291; Weft's eleventh round). A fork continuing its
 * parent's context sees what its parent sees and its own stored context
 * injections (src/stored-injections.ts). context-manager's derive gives the
 * fork its source's view filter, which leaves out every stored injection but
 * the source's own, so the framework replaces it (deriveSharedContext).
 * Reopened after it ends, a fork's context keeps the
 * view it had live, a fork of a fork's included (reopenAgentContext).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager, type ContextInjection } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, isSystemChangeMessage, systemChangeMetadata, taskForkSpec, type Agent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { storeOwnRow } from '../src/dendrite/audience.js';

type Internals = {
  storeInjections(agent: Agent, injections: ContextInjection[] | undefined): ContextInjection[] | undefined;
  agentSees(agent: Agent, metadata: unknown): boolean;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const injection = (t: string): ContextInjection => ({ namespace: 'lessons', position: 'afterUser', content: [text(t)] });
const textOf = (m: { content: unknown }): string =>
  (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
const store = (framework: AgentFramework, agent: Agent, participant: string, content: ContentBlock[], metadata?: unknown) => {
  const id = agent.getContextManager().addMessage(participant, content, metadata as never);
  (framework as unknown as { presentation: { afterStore(agent: Agent, ids: unknown[]): void } }).presentation.afterStore(agent, [id]);
  return id;
};
const adopt = (framework: AgentFramework, agent: Agent) => (framework as unknown as { adoptPresentation(agent: Agent): void }).adoptPresentation(agent);
const startOf = (framework: AgentFramework, agent: Agent) =>
  (framework as unknown as { presentation: { presentAtStart(agent: Agent, occasion: 'turn-start'): unknown } }).presentation.presentAtStart(agent, 'turn-start');

const prompt = (text: string) => `${text}\n${'Follow the task, and say what you did. '.repeat(2000)}`;
const FRAMING = '[FORK-FRAMING] Count the open issues.';
const GRANDCHILD = '[GRANDCHILD-FRAMING] Count the closed ones.';
/** The rows a view can leave out: each agent's stored injection, and a row a tune-out holds from the residents. */
const MARKED = ['HELD-ROW', 'MIRA-OWN', 'OREN-OWN', 'FORK-OWN', 'FORK2-OWN'];

describe("a shared fork's view", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let gates: GateModule;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-'));
    membrane = new RoutedMembrane();
    // A derived agent presents itself under its parent's name; tell them
    // apart by the framing only each fork carries.
    membrane.identify = (request) => {
      const sent = JSON.stringify(request.messages);
      if (sent.includes('[GRANDCHILD-FRAMING]')) return 'fork-2';
      if (sent.includes('[FORK-FRAMING]')) return 'fork-1';
      return request.assistantParticipant ?? '';
    };
    gates = new GateModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.'), toolDeclarations: 'entries' },
        { name: 'oren', model: 'test-model', systemPrompt: prompt('You are oren.'), toolDeclarations: 'entries' },
      ],
      modules: [gates],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    try { await framework.stop(); } catch { /* already stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** The marked rows a dry-run compile of `cm` shows, in order. */
  const shown = async (cm: ContextManager): Promise<string[]> =>
    (await cm.compile(undefined, undefined, { dryRun: true })).messages.map(textOf).filter((t) => MARKED.includes(t));
  /** The marked rows of `record` that agentSees says `agent` sees. */
  const seenBy = (agent: Agent, record: ContextManager): string[] =>
    MARKED.flatMap((t) => record.getAllMessages().filter((m) => textOf(m) === t))
      .filter((m) => internals(framework).agentSees(agent, m.metadata)).map(textOf);
  /** agentSees takes an agent; an inspected context has none, so this stands in for it. */
  const readerOf = (cm: ContextManager): Agent => ({ getContextManager: () => cm }) as unknown as Agent;

  it('sees its source\'s view and its own stored injections: in its compile, in agentSees, and reopened after it ends', async () => {
    const mira = framework.getAgent('mira')!;
    const oren = framework.getAgent('oren')!;
    mira.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    mira.getContextManager().addMessage('Antra', [text('HELD-ROW')], { tuneOut: { epochId: 'e1' } } as never);
    internals(framework).storeInjections(mira, [injection('MIRA-OWN')]);
    internals(framework).storeInjections(oren, [injection('OREN-OWN')]);

    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    internals(framework).storeInjections(fork.agent, [injection('FORK-OWN')]);
    assert.deepEqual(
      fork.contextManager.getAllMessages().filter((m) => MARKED.includes(textOf(m))).map(textOf),
      ['HELD-ROW', 'MIRA-OWN', 'OREN-OWN', 'FORK-OWN'],
      "the premise: the fork's record holds every row, its own injection on its branch",
    );

    // The source and the stranger each compile their own alone, and main's
    // checks of whether an agent sees a row (agentSees) answer for the fork
    // as its compile will show once its run has taken it on.
    assert.deepEqual(await shown(mira.getContextManager()), ['MIRA-OWN'], 'the source sees its own only');
    assert.deepEqual(await shown(oren.getContextManager()), ['OREN-OWN'], 'the stranger sees its own only');
    assert.deepEqual(seenBy(fork.agent, fork.contextManager), ['MIRA-OWN', 'FORK-OWN'], "agentSees answers for the fork: its own injection and its source's, not a stranger's");
    assert.deepEqual(seenBy(mira, fork.contextManager), ['MIRA-OWN']);
    assert.deepEqual(seenBy(oren, fork.contextManager), ['OREN-OWN']);

    // On this branch a compile reads the agent's window, and a fork's own
    // rows enter its window when its run takes it on (presentation.adopt), so
    // each fork's compile is read mid-turn, blocked on a gate.
    framework.start();
    membrane.script('fork-1', waitCall('g-fork'), say('fork-1 done'));
    const firstRun = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    await until(() => gates.entered.has('g-fork'), 'fork-1 to block mid-turn');
    assert.deepEqual(await shown(fork.contextManager), ['MIRA-OWN', 'FORK-OWN'], "the fork sees its own injection and its source's, not a stranger's");

    // A fork of the running fork: its view is its source's (the fork's) and its own.
    const grandchild = await framework.deriveAgent({
      name: 'fork-2',
      from: 'fork-1',
      framing: [{ participant: 'user', content: [text(GRANDCHILD)] }],
    });
    internals(framework).storeInjections(grandchild.agent, [injection('FORK2-OWN')]);
    assert.deepEqual(seenBy(grandchild.agent, grandchild.contextManager), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN']);
    membrane.script('fork-2', waitCall('g-fork2'), say('fork-2 done'));
    const secondRun = framework.runEphemeralToCompletion(grandchild.agent, grandchild.contextManager);
    await until(() => gates.entered.has('g-fork2'), 'fork-2 to block mid-turn');
    assert.deepEqual(await shown(grandchild.contextManager), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN']);
    gates.release('g-fork2');
    assert.equal((await secondRun).speech, 'fork-2 done');
    gates.release('g-fork');
    assert.equal((await firstRun).speech, 'fork-1 done');
    assert.equal(framework.getAgentRecord('fork-1')?.ended?.reason, 'completed');
    assert.equal(framework.getAgentRecord('fork-2')?.ended?.reason, 'completed');

    // Reopened for inspection, each ended fork's context sees what it saw live.
    const left = await framework.inspectAgentContext('fork-1');
    assert.deepEqual(await shown(left), ['MIRA-OWN', 'FORK-OWN'], 'the reopened fork, as live');
    assert.deepEqual(seenBy(readerOf(left), left), ['MIRA-OWN', 'FORK-OWN'], 'and agentSees for it');
    const leftBelow = await framework.inspectAgentContext('fork-2');
    assert.deepEqual(await shown(leftBelow), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN'], "the reopened fork of a fork, as live: its source's source's view too");
    assert.deepEqual(seenBy(readerOf(leftBelow), leftBelow), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN']);
  });

  it("keeps its source's system changes and its own and leaves out another resident's, and reopened after it ends still leaves out another resident's", async () => {
    const change = (name: string) => [{ type: 'system_change', defineTools: [{ name, description: name, inputSchema: { type: 'object', properties: {} } }] }] as never;
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system', change('mira-tool'), systemChangeMetadata('mira') as never);
    store(framework, framework.getAgent('oren')!, 'system', change('oren-tool'), systemChangeMetadata('oren') as never);
    assert.deepEqual(await changeTools(mira.getContextManager()), ['mira-tool'], "the premise: the source's view keeps its own change and leaves out another resident's");
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    adopt(framework, fork.agent);
    storeOwnRow(fork.agent, 'system', change('fork-tool'), systemChangeMetadata('fork-1') as never);
    assert.deepEqual(await changeTools(fork.contextManager), ['mira-tool', 'fork-tool'], "the fork's compile: its source's change and its own, not another resident's");
    framework.start();
    membrane.script('fork-1', say('fork-1 done'));
    assert.equal((await framework.runEphemeralToCompletion(fork.agent, fork.contextManager)).speech, 'fork-1 done');
    const reopened = await framework.inspectAgentContext('fork-1');
    assert.deepEqual(await changeTools(reopened), [],
      "the reopened fork: another resident's change out of its view, and its source's and its own gone from its branch at its first request, where it adopts its head and takes its own");
    const stored = (cm: ContextManager, owner: string) => cm.queryMessages({ metadata: { kind: 'system-change', agent: owner } }).messages.length;
    assert.deepEqual([stored(reopened, 'mira'), stored(reopened, 'fork-1'), stored(reopened, 'oren')], [0, 0, 1],
      "its source's and its own taken out of its branch, and another resident's left there, out of its view");
    assert.deepEqual([stored(mira.getContextManager(), 'mira'), stored(framework.getAgent('oren')!.getContextManager(), 'oren')], [1, 1],
      "and the residents' own rows as they were");
  });
});

describe("a shared fork of an isolated-slot reader's view", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-isolated-'));
    membrane = new RoutedMembrane();
    membrane.identify = (request) =>
      JSON.stringify(request.messages).includes('[FORK-FRAMING]') ? 'fork-1' : request.assistantParticipant ?? '';
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.') }],
      subconscious: { enabled: true, systemPrompt: prompt('notice') },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    try { await framework.stop(); } catch { }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const compiled = async (cm: ContextManager): Promise<string[]> =>
    (await cm.compile(undefined, undefined, { dryRun: true })).messages.map(textOf);

  it("a fork of the subconscious, reopened after it ends, shows what its live compile showed", async () => {
    const mira = framework.getAgent('mira')!;
    const sub = framework.getAgent('Subconscious')!;
    store(framework, mira, 'user', [text('MIRA-SAID')]);
    store(framework, mira, 'Antra', [text('HELD-ROW')], { tuneOut: { epochId: 'e1' } } as never);
    internals(framework).storeInjections(mira, [injection('MIRA-OWN')]);
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: sub.name,
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    adopt(framework, fork.agent);
    internals(framework).storeInjections(fork.agent, [injection('FORK-OWN')]);
    const live = await compiled(fork.contextManager);
    assert.ok(live.includes('FORK-OWN'), "the premise: the fork's compile shows its own injection");
    assert.ok(live.includes('MIRA-SAID'), "the premise: like its source's, the fork's compile reads the residents' slot");
    assert.ok(!live.includes('MIRA-OWN'), "like its source's, the fork's compile leaves out a resident's stored injection");
    assert.ok(live.includes('HELD-ROW'), "and, like its source's, shows a row a tune-out holds from the residents");
    membrane.script('fork-1', say('fork-1 done'));
    framework.start();
    assert.equal((await framework.runEphemeralToCompletion(fork.agent, fork.contextManager)).speech, 'fork-1 done');
    const left = await framework.inspectAgentContext('fork-1');
    const reopened = await compiled(left);
    assert.ok(!reopened.includes('MIRA-OWN'), "the reopened fork, as live, leaves out the resident's stored injection");
    assert.ok(reopened.includes('HELD-ROW'), 'and shows the held row');
    assert.ok(reopened.includes('FORK-OWN') && reopened.includes('MIRA-SAID'), "and its own injection and the residents' row");
  });

  it("leaves out a suppressed row while it shows a held one, in the subconscious's own view and in a fork of it", async () => {
    const mira = framework.getAgent('mira')!;
    const sub = framework.getAgent('Subconscious')!;
    const suppressed = { suppressed: { rule: 'quiet-bots', eventType: 'chat:message' } };
    store(framework, mira, 'user', [text('MIRA-SAID')]);
    store(framework, mira, 'Antra', [text('HELD-ROW')], { tuneOut: { epochId: 'e1' } } as never);
    store(framework, mira, 'Antra', [text('SUPPRESSED-ROW')], suppressed as never);
    assert.ok(mira.getContextManager().getAllMessages().some((m) => textOf(m) === 'SUPPRESSED-ROW'), 'the premise: the suppressed row is stored');
    const own = await compiled(sub.getContextManager());
    assert.ok(own.includes('MIRA-SAID') && own.includes('HELD-ROW'), "the premise: the subconscious reads the residents' slot, held rows included");
    assert.ok(!own.includes('SUPPRESSED-ROW'), "the subconscious's compile leaves out the suppressed row");
    assert.equal(internals(framework).agentSees(sub, suppressed), false, 'and so does its agentSees');
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: sub.name,
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    const forked = await compiled(fork.contextManager);
    assert.ok(forked.includes('HELD-ROW'), "the premise: the fork, like its source, shows the held row");
    assert.ok(!forked.includes('SUPPRESSED-ROW'), 'and leaves out the suppressed one');
    assert.ok(!(await compiled(mira.getContextManager())).includes('SUPPRESSED-ROW'), "as the resident's view does");
  });
});

describe("a shared child of a resident with former names", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-former-'));
    membrane = new RoutedMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.'), selfParticipants: ['mira-old'], presentAs: 'mira-shown' },
        { name: 'oren', model: 'test-model', systemPrompt: prompt('You are oren.') },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps a change its source counts as its own under a former name until its own head takes its place, reopened as live", async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system',
      [{ type: 'system_change', defineTools: [{ name: 'old-tool', description: 'old', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('mira-old') as never);
    const { name: _name, ...spec } = taskForkSpec('job-1', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-1', model: 'test-model', systemPrompt: prompt('Do the task.'), toolDeclarations: 'entries' }, spec);
    job.contextManager.addMessage('user', [text('Run once.')]);
    assert.deepEqual(await changeTools(job.contextManager), ['old-tool'], "live, the child keeps the change its source keeps");
    framework.start();
    membrane.script('job-1', say('job-1 done'));
    assert.equal((await framework.runEphemeralToCompletion(job.agent, job.contextManager)).speech, 'job-1 done');
    assert.deepEqual(await changeTools(job.contextManager), [], 'and none at its end, its adoption having taken it off its branch');
    assert.equal(job.contextManager.getAllMessages().filter((m) => isSystemChangeMessage(m)).length, 0, 'none stored on its branch either');
    assert.deepEqual(await changeTools(await framework.inspectAgentContext('job-1')), [], 'reopened, as at its end');
    assert.equal(mira.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'mira-old' } }).messages.length, 1,
      "while its source's own branch keeps it");
    const record = framework.getAgentRecord('mira')!;
    assert.deepEqual([record.selfParticipants, record.presentAs], [['mira-old'], 'mira-shown'], "the resident's record states its mapping");
  });

  it("gives a resumed child the view of the mapping it resumes with", async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system',
      [{ type: 'system_change', defineTools: [{ name: 'zed-tool', description: 'zed', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('zed') as never);
    const { name: _name, ...spec } = taskForkSpec('job-2', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-2', model: 'test-model', systemPrompt: prompt('Do the task.'), toolDeclarations: 'entries' }, spec);
    job.contextManager.addMessage('user', [text('Run once.')]);
    assert.deepEqual(await changeTools(job.contextManager), [], "the premise: live, a change stamped by another is out of its view");
    framework.start();
    membrane.script('job-2', say('job-2 done'));
    await framework.runEphemeralToCompletion(job.agent, job.contextManager);
    const resumed = await framework.resumeAgent('job-2', { model: 'test-model', systemPrompt: prompt('Do the task.'), selfParticipants: ['zed'], toolDeclarations: 'entries' } as never);
    assert.deepEqual(await changeTools(resumed.contextManager), ['zed-tool'], 'resumed as zed too, its view keeps the change it now counts as its own');
    resumed.cleanup();
  });

  it("records the mapping a job's requests use when its config names it and its spec doesn't", async () => {
    framework.getAgent('mira')!.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    const { name: _name, ...spec } = taskForkSpec('job-4', { parent: 'mira', inherit: { mode: 'shared' } });
    const config = (name: string) => ({ name, model: 'test-model', systemPrompt: prompt('Do the task.'), toolDeclarations: 'entries', selfParticipants: ['zed'], presentAs: `${name}-shown` });
    const withSpec = await framework.createEphemeralAgent(config('job-4') as never, spec);
    const bare = await framework.createEphemeralAgent(config('job-5') as never);
    for (const job of [withSpec, bare]) job.contextManager.addMessage('user', [text('Run once.')]);
    framework.start();
    membrane.script('job-4-shown', say('job-4 done'));
    membrane.script('job-5-shown', say('job-5 done'));
    for (const job of [withSpec, bare]) await framework.runEphemeralToCompletion(job.agent, job.contextManager);
    for (const name of ['job-4', 'job-5']) {
      const record = framework.getAgentRecord(name)!;
      assert.deepEqual([record.selfParticipants, record.presentAs], [['zed'], `${name}-shown`], name);
    }
  });

  it("runs a live child with its spec's mapping when its config names none, as its record states it", async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system',
      [{ type: 'system_change', defineTools: [{ name: 'zed-tool', description: 'zed', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('zed') as never);
    const { name: _name, ...spec } = taskForkSpec('job-6', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-6', model: 'test-model', systemPrompt: prompt('Do the task.'), toolDeclarations: 'entries' }, { ...spec, selfParticipants: ['zed'] });
    assert.equal(job.agent.isOwnParticipant('zed'), true, "zed's turns are its own, as the spec says");
    assert.deepEqual(await changeTools(job.contextManager), ['zed-tool'], "and its view keeps zed's change as its own");
    job.contextManager.addMessage('user', [text('Run once.')]);
    framework.start();
    membrane.script('job-6', say('job-6 done'));
    await framework.runEphemeralToCompletion(job.agent, job.contextManager);
    assert.deepEqual(framework.getAgentRecord('job-6')!.selfParticipants, ['zed'], 'its record states the mapping it ran with');
  });

  it("gives a child resumed with no mapping of its own the view of its record's", async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system',
      [{ type: 'system_change', defineTools: [{ name: 'zed-tool', description: 'zed', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('zed') as never);
    const { name: _name, ...spec } = taskForkSpec('job-3', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-3', model: 'test-model', systemPrompt: prompt('Do the task.') }, { ...spec, selfParticipants: ['zed'] });
    job.contextManager.addMessage('user', [text('Run once.')]);
    framework.start();
    membrane.script('job-3', say('job-3 done'));
    await framework.runEphemeralToCompletion(job.agent, job.contextManager);
    assert.deepEqual(framework.getAgentRecord('job-3')!.selfParticipants, ['zed'], 'the premise: its record states zed as its own');
    const resumed = await framework.resumeAgent('job-3', { model: 'test-model', systemPrompt: prompt('Do the task.'), toolDeclarations: 'entries' } as never);
    assert.deepEqual(await changeTools(resumed.contextManager), ['zed-tool'], "resumed with no mapping of its own, its view counts its record's");
    resumed.cleanup();
  });
});

describe("a resumed 'head' job", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-resumed-'));
    membrane = new RoutedMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.') }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const bulky = (name: string) =>
    [{ type: 'system_change', defineTools: [{ name, description: `${name} `.repeat(20000), inputSchema: { type: 'object', properties: {} } }] }] as never;
  const job = { model: 'test-model', systemPrompt: prompt('Do the task.'), contextBudgetTokens: 20000 };

  for (const [how, shared] of [['in a namespace of its own', false], ["continuing a resident's context", true]] as const) {
    it(`sends its request beside a host's change rows that alone exceed its budget, ${how}`, async () => {
      store(framework, framework.getAgent('mira')!, 'user', [text('Please look into the open issues.')]);
      const { name: _name, ...spec } = taskForkSpec('job', { parent: 'mira', inherit: { mode: 'shared' } });
      const first = await framework.createEphemeralAgent({ name: 'job', ...job } as never, shared ? spec : undefined);
      first.contextManager.addMessage('user', [text('Run once.')]);
      framework.start();
      membrane.script('job', say('job done'));
      await framework.runEphemeralToCompletion(first.agent, first.contextManager);
      const resumed = await framework.resumeAgent('job', job as never);
      adopt(framework, resumed.agent);
      resumed.contextManager.addMessage('system', bulky('h1'));
      resumed.contextManager.addMessage('system', bulky('h2'));
      resumed.contextManager.addMessage('user', [text('Once more.')]);
      startOf(framework, resumed.agent);
      const request = await resumed.agent.buildActivationRequest([]);
      assert.equal(textOf(request.messages.at(-1)!), 'Once more.');
      assert.ok(!request.messages.some((m) => (m.content as Array<{ type: string }>).some((b) => b.type === 'system_change')), 'and no change row');
      resumed.cleanup();
    });
  }
});

describe("a derived agent's change rows, its source's among them", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let gates: GateModule;
  let framework: AgentFramework;
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } });
  const change = (name: string) => [{ type: 'system_change', defineTools: [tool(name)] }] as never;
  const defined = (messages: ReadonlyArray<{ content: unknown }>): string[] =>
    messages.flatMap((m) => (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
      .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-owners-'));
    membrane = new RoutedMembrane();
    membrane.identify = (request) => {
      const sent = JSON.stringify(request.messages);
      if (sent.includes('[GRANDCHILD-FRAMING]')) return 'g';
      if (sent.includes('[FORK-FRAMING]')) return 'c';
      return request.assistantParticipant ?? '';
    };
    gates = new GateModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.'), selfParticipants: ['mira-old'], toolDeclarations: 'entries' }],
      modules: [gates],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const mira = framework.getAgent('mira')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    await mira.buildActivationRequest([]);
    store(framework, mira, 'system', change('b'), systemChangeMetadata('mira') as never);
    store(framework, mira, 'system', change('o'), systemChangeMetadata('mira-old') as never);
  });
  const holdsBoth = (names: string[]) => names.includes('b') && names.includes('o');
  const holdsNeither = (names: string[]) => !names.includes('b') && !names.includes('o');

  afterEach(async () => {
    try { await framework.stop(); } catch { }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function childAndGrandchild(copy = false) {
    const { name: _c, ...cSpec } = taskForkSpec('c', { parent: 'mira', inherit: { mode: 'shared' } });
    const c = await framework.createEphemeralAgent({ name: 'c', model: 'test-model', systemPrompt: prompt('You are mira.'), toolDeclarations: 'entries' }, cSpec);
    c.contextManager.addMessage('user', [text(FRAMING)]);
    framework.start();
    membrane.script('c', waitCall('g-c'), say('c done'));
    const run = framework.runEphemeralToCompletion(c.agent, c.contextManager);
    await until(() => gates.entered.has('g-c'), 'c to block mid-turn');
    let g: { agent: Agent; contextManager: ContextManager };
    if (copy) {
      g = await framework.deriveAgent({ name: 'g', from: 'c', mode: 'copy', config: { systemPrompt: prompt('You are g.') }, framing: [{ participant: 'user', content: [text(GRANDCHILD)] }] });
    } else {
      const { name: _g, ...gSpec } = taskForkSpec('g', { parent: 'c', inherit: { mode: 'shared' } });
      g = await framework.createEphemeralAgent({ name: 'g', model: 'test-model', systemPrompt: prompt('You are mira.'), toolDeclarations: 'entries' }, gSpec);
      g.contextManager.addMessage('user', [text(GRANDCHILD)]);
    }
    return { c, g, run };
  }

  it("takes, resumed with a prompt of its own, every change row a host's shared child's sources count as their own, its source's former name's and its source's source's included", async () => {
    const { g, run } = await childAndGrandchild();
    membrane.script('g', say('g done'));
    assert.equal((await framework.runEphemeralToCompletion(g.agent, g.contextManager)).speech, 'g done');
    gates.release('g-c');
    assert.equal((await run).speech, 'c done');
    for (const name of ['c', 'g']) {
      const resumed = await framework.resumeAgent(name, { model: 'test-model', systemPrompt: prompt(`You are ${name}, resumed.`), toolDeclarations: 'entries' } as never);
      const before = defined((await resumed.contextManager.compile(undefined, undefined, { dryRun: true })).messages);
      assert.ok(holdsBoth(before), `the premise: resumed ${name}'s view keeps mira's rows under both its names: ${before}`);
      const request = await resumed.agent.buildActivationRequest([]);
      const sent = defined(request.messages);
      assert.ok(holdsNeither(sent), `resumed ${name}'s request, on a head of its own, defines neither: ${sent}`);
      assert.ok(holdsNeither(defined(resumed.contextManager.getAllMessages())), `and resumed ${name}'s branch stores neither`);
      resumed.cleanup();
    }
  });

  it("stamps a copy-mode fork of a host's running shared child with every change row the child counts as its own, so the fork's move takes them", async () => {
    const { g, run } = await childAndGrandchild(true);
    const copied = defined((await g.contextManager.compile(undefined, undefined, { dryRun: true })).messages);
    assert.ok(holdsBoth(copied), `the premise: the fork's copy holds both of mira's rows: ${copied}`);
    membrane.script('g', say('g done'));
    assert.equal((await framework.runEphemeralToCompletion(g.agent, g.contextManager)).speech, 'g done', 'the fork runs as an agent the framework took on');
    const sent = defined(membrane.callsFor('g').at(-1)!.messages);
    assert.ok(holdsNeither(sent), `the fork's request, on a head of its own, defines neither: ${sent}`);
    assert.ok(holdsNeither(defined(g.contextManager.getAllMessages())), "and the fork's branch stores neither");
    gates.release('g-c');
    await run;
  });
});

describe("a 'head' agent whose compile is refused over budget", () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let framework: AgentFramework;
  const change = (name: string) => [{ type: 'system_change', defineTools: [{ name, description: name, inputSchema: { type: 'object' as const, properties: {} } }] }] as never;
  const defined = (messages: ReadonlyArray<{ content: unknown }>): string[] =>
    messages.flatMap((m) => (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
      .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-head-budget-'));
    membrane = new RoutedMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: prompt('You are mira.'), selfParticipants: ['mira-old'], toolDeclarations: 'entries' },
        { name: 'nell', model: 'test-model', systemPrompt: prompt('You are nell.') },
      ],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    const mira = framework.getAgent('mira')!;
    mira.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    await mira.buildActivationRequest([]);
    mira.getContextManager().addMessage('system', change('b'), systemChangeMetadata('mira') as never);
    mira.getContextManager().addMessage('system', change('o'), systemChangeMetadata('mira-old') as never);
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves its branch's change rows, its own and its source's, where its compile never held them, and the refusal goes on", async () => {
    const traces: Array<{ type: string; agentName?: string }> = [];
    framework.onTrace((event) => { traces.push(event as never); });
    const { name: _name, ...spec } = taskForkSpec('hc', { parent: 'mira', inherit: { mode: 'shared' } });
    const hc = await framework.createEphemeralAgent({ name: 'hc', model: 'test-model', systemPrompt: prompt('You are hc.') }, spec);
    hc.contextManager.addMessage('system', change('h'), systemChangeMetadata('hc') as never);
    hc.contextManager.addMessage('user', [text('Run once.')]);
    const stored = () => ['mira', 'mira-old', 'hc'].map((owner) => hc.contextManager.queryMessages({ metadata: { kind: 'system-change', agent: owner } }).messages.length);
    assert.deepEqual(stored(), [1, 1, 1], "the premise: its branch holds its source's two rows and its own");
    assert.deepEqual(defined((await hc.contextManager.compile(undefined, undefined, { dryRun: true })).messages), [], 'and its compile, on its head, holds none of them');
    let refused = 0;
    (hc.contextManager as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile = async () => {
      refused++;
      throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    };
    await assert.rejects(hc.agent.buildActivationRequest([]), /over budget/, 'refused over budget');
    assert.equal(refused, 1, 'compiled once, as nothing it could take would help');
    assert.deepEqual(stored(), [1, 1, 1], 'every row left where it was');
    assert.deepEqual(traces.filter((t) => t.type === 'head:moved' && t.agentName === 'hc'), [], 'and no move');
  });

  it("leaves a resumed 'head' child's change rows where its compile never held them, and the refusal goes on", async () => {
    const mira = framework.getAgent('mira')!;
    const [last] = mira.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'mira-old' } }).messages;
    const atSequence = mira.getContextManager().getMessage(last!.id)!.sequence;
    const { name: _name, ...spec } = taskForkSpec('hc', { parent: 'mira', inherit: { mode: 'shared', atSequence } });
    const config = { model: 'test-model', systemPrompt: prompt('You are hc.') };
    const hc = await framework.createEphemeralAgent({ name: 'hc', ...config }, spec);
    hc.contextManager.addMessage('system', change('h'), systemChangeMetadata('hc') as never);
    hc.contextManager.addMessage('user', [text('Run once.')]);
    framework.start();
    membrane.script('hc', say('hc done'));
    assert.equal((await framework.runEphemeralToCompletion(hc.agent, hc.contextManager)).speech, 'hc done');
    const resumed = await framework.resumeAgent('hc', config as never);
    const stored = () => ['mira', 'mira-old', 'hc'].map((owner) => resumed.contextManager.queryMessages({ metadata: { kind: 'system-change', agent: owner } }).messages.length);
    assert.deepEqual(stored(), [1, 1, 1], "the premise: its branch still holds its source's two rows and its own");
    let refused = 0;
    (resumed.contextManager as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile = async () => {
      refused++;
      throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    };
    await assert.rejects(resumed.agent.buildActivationRequest([]), /over budget/, 'refused over budget');
    assert.equal(refused, 1, 'compiled once');
    assert.deepEqual(stored(), [1, 1, 1], 'every row left where it was');
    resumed.cleanup();
  });

  it("leaves a 'head' resident's own change rows where its compile never held them, and the refusal goes on", async () => {
    const nell = framework.getAgent('nell')!;
    nell.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    nell.getContextManager().addMessage('system', change('n'), systemChangeMetadata('nell') as never);
    const stored = () => nell.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'nell' } }).messages.length;
    assert.equal(stored(), 1, 'the premise: its own row is stored');
    let refused = 0;
    (nell.getContextManager() as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile = async () => {
      refused++;
      throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    };
    await assert.rejects(nell.buildActivationRequest([]), /over budget/, 'refused over budget');
    assert.equal(refused, 1, 'compiled once');
    assert.equal(stored(), 1, 'its row left where it was');
  });
});
