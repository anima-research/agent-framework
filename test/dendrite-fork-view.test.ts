/**
 * A shared fork's view (#291; Weft's eleventh round). A fork continuing its
 * parent's context sees what its parent sees and its own stored context
 * injections (src/stored-injections.ts). context-manager's derive gives the
 * fork its source's view filter, which leaves out every stored injection but
 * the source's own, so the framework replaces it (deriveSharedContext) and
 * records the same predicate for main's checks of whether an agent sees a row
 * (storeViews, agentSees). Reopened after it ends, a fork's context keeps the
 * view it had live, a fork of a fork's included (reopenAgentContext).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, type ContextInjection } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, systemChangeMetadata, taskForkSpec, type Agent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

const supported =
  typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function' &&
  typeof (ContextManager.prototype as unknown as { derive?: unknown }).derive === 'function';
const skip = supported
  ? false
  : 'installed @animalabs/chronicle / context-manager lack branch-bound handles or ContextManager.derive';

type Internals = {
  storeInjections(agent: Agent, injections: ContextInjection[] | undefined): ContextInjection[] | undefined;
  agentSees(agent: Agent, metadata: unknown): boolean;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const injection = (t: string): ContextInjection => ({ namespace: 'lessons', position: 'afterUser', content: [text(t)] });
const textOf = (m: { content: unknown }): string =>
  (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

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
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
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

  it('sees its source\'s view and its own stored injections: in its compile, in agentSees, and reopened after it ends', { skip }, async () => {
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

    // Each compile: the fork its source's view and its own injection; the
    // source and the stranger each their own alone.
    assert.deepEqual(await shown(fork.contextManager), ['MIRA-OWN', 'FORK-OWN'], "the fork sees its own injection and its source's, not a stranger's");
    assert.deepEqual(await shown(mira.getContextManager()), ['MIRA-OWN'], 'the source sees its own only');
    assert.deepEqual(await shown(oren.getContextManager()), ['OREN-OWN'], 'the stranger sees its own only');
    // main's checks of whether an agent sees a row (agentSees) agree with the fork's compile.
    assert.deepEqual(seenBy(fork.agent, fork.contextManager), ['MIRA-OWN', 'FORK-OWN'], "agentSees answers for the fork as its compile shows");
    assert.deepEqual(seenBy(mira, fork.contextManager), ['MIRA-OWN']);
    assert.deepEqual(seenBy(oren, fork.contextManager), ['OREN-OWN']);

    // A fork of the running fork: its view is its source's (the fork's) and its own.
    framework.start();
    membrane.script('fork-1', waitCall('g-fork'), say('fork-1 done'));
    const firstRun = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    await until(() => gates.entered.has('g-fork'), 'fork-1 to block mid-turn');
    const grandchild = await framework.deriveAgent({
      name: 'fork-2',
      from: 'fork-1',
      framing: [{ participant: 'user', content: [text(GRANDCHILD)] }],
    });
    internals(framework).storeInjections(grandchild.agent, [injection('FORK2-OWN')]);
    assert.deepEqual(await shown(grandchild.contextManager), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN']);
    assert.deepEqual(seenBy(grandchild.agent, grandchild.contextManager), ['MIRA-OWN', 'FORK-OWN', 'FORK2-OWN']);
    membrane.script('fork-2', say('fork-2 done'));
    assert.equal((await framework.runEphemeralToCompletion(grandchild.agent, grandchild.contextManager)).speech, 'fork-2 done');
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

  it("keeps its source's system changes and its own and leaves out another resident's, and reopened after it ends still leaves out another resident's", { skip }, async () => {
    const change = (name: string) => [{ type: 'system_change', defineTools: [{ name, description: name, inputSchema: { type: 'object', properties: {} } }] }] as never;
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    mira.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    mira.getContextManager().addMessage('system', change('mira-tool'), systemChangeMetadata('mira') as never);
    framework.getAgent('oren')!.getContextManager().addMessage('system', change('oren-tool'), systemChangeMetadata('oren') as never);
    assert.deepEqual(await changeTools(mira.getContextManager()), ['mira-tool'], "the premise: the source's view keeps its own change and leaves out another resident's");
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    fork.contextManager.addMessage('system', change('fork-tool'), systemChangeMetadata('fork-1') as never);
    assert.deepEqual(await changeTools(fork.contextManager), ['mira-tool', 'fork-tool'], "the fork's compile: its source's change and its own, not another resident's");
    framework.start();
    membrane.script('fork-1', say('fork-1 done'));
    assert.equal((await framework.runEphemeralToCompletion(fork.agent, fork.contextManager)).speech, 'fork-1 done');
    assert.deepEqual(await changeTools(await framework.inspectAgentContext('fork-1')), [],
      "the reopened fork: another resident's change out of its view, and its source's and its own gone from its branch at its first request, as an agent on its head removes its own");
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
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
      subconscious: { enabled: true, systemPrompt: 'notice' },
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    try { await framework.stop(); } catch { /* already stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const compiled = async (cm: ContextManager): Promise<string[]> =>
    (await cm.compile(undefined, undefined, { dryRun: true })).messages.map(textOf);

  it("a fork of the subconscious, reopened after it ends, shows what its live compile showed", { skip }, async () => {
    const mira = framework.getAgent('mira')!;
    const sub = framework.getAgent('Subconscious')!;
    mira.getContextManager().addMessage('user', [text('MIRA-SAID')]);
    mira.getContextManager().addMessage('Antra', [text('HELD-ROW')], { tuneOut: { epochId: 'e1' } } as never);
    internals(framework).storeInjections(mira, [injection('MIRA-OWN')]);
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: sub.name,
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
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
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.', selfParticipants: ['mira-old'] },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
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

  it("keeps, reopened after it ends, a change its source counts as its own under a former name, as it did live", { skip }, async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    mira.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    mira.getContextManager().addMessage('system',
      [{ type: 'system_change', defineTools: [{ name: 'old-tool', description: 'old', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('mira-old') as never);
    const { name: _name, ...spec } = taskForkSpec('job-1', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-1', model: 'test-model', systemPrompt: 'Do the task.' }, spec);
    job.contextManager.addMessage('user', [text('Run once.')]);
    assert.deepEqual(await changeTools(job.contextManager), ['old-tool'], "live, the child keeps the change its source keeps");
    framework.start();
    membrane.script('job-1', say('job-1 done'));
    assert.equal((await framework.runEphemeralToCompletion(job.agent, job.contextManager)).speech, 'job-1 done');
    assert.deepEqual(await changeTools(job.contextManager), ['old-tool'], 'and still at its end');
    assert.deepEqual(await changeTools(await framework.inspectAgentContext('job-1')), ['old-tool'], 'reopened, as at its end');
    const record = framework.getAgentRecord('mira')!;
    assert.deepEqual([record.selfParticipants, record.presentAs], [['mira-old'], undefined], "the resident's record states its mapping");
  });

  it("gives a resumed child the view of the mapping it resumes with", { skip }, async () => {
    const changeTools = async (cm: ContextManager): Promise<string[]> =>
      (await cm.compile(undefined, undefined, { dryRun: true })).messages.flatMap((m) =>
        (m.content as Array<{ type: string; defineTools?: Array<{ name: string }> }>)
          .filter((b) => b.type === 'system_change').flatMap((b) => (b.defineTools ?? []).map((t) => t.name)));
    const mira = framework.getAgent('mira')!;
    mira.getContextManager().addMessage('user', [text('Please look into the open issues.')]);
    mira.getContextManager().addMessage('system',
      [{ type: 'system_change', defineTools: [{ name: 'zed-tool', description: 'zed', inputSchema: { type: 'object', properties: {} } }] }] as never,
      systemChangeMetadata('zed') as never);
    const { name: _name, ...spec } = taskForkSpec('job-2', { parent: 'mira', inherit: { mode: 'shared' } });
    const job = await framework.createEphemeralAgent({ name: 'job-2', model: 'test-model', systemPrompt: 'Do the task.' }, spec);
    job.contextManager.addMessage('user', [text('Run once.')]);
    assert.deepEqual(await changeTools(job.contextManager), [], "the premise: live, a change stamped by another is out of its view");
    framework.start();
    membrane.script('job-2', say('job-2 done'));
    await framework.runEphemeralToCompletion(job.agent, job.contextManager);
    const resumed = await framework.resumeAgent('job-2', { model: 'test-model', systemPrompt: 'Do the task.', selfParticipants: ['zed'] } as never);
    assert.deepEqual(await changeTools(resumed.contextManager), ['zed-tool'], 'resumed as zed too, its view keeps the change it now counts as its own');
    resumed.cleanup();
  });
});
