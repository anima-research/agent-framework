/**
 * A shared fork's view (#291; Weft's eleventh round). A fork continuing its
 * parent's context sees what its parent sees and its own stored context
 * injections (src/stored-injections.ts). context-manager's derive gives the
 * fork its source's view filter, which leaves out every stored injection but
 * the source's own, so the framework replaces it (deriveSharedContext) and
 * records the same predicate for main's checks of whether an agent sees a row
 * (storeSees, agentSees). Reopened after it ends, a fork's context keeps the
 * view it had live, a fork of a fork's included (reopenAgentContext). A change
 * row (src/system-changes.ts) is seen as a stored injection is.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager, type ContextInjection } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { AgentFramework, type Agent } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { storeOwnRow } from '../src/dendrite/audience.js';
import { systemChangeMetadata } from '../src/system-changes.js';

type Internals = {
  storeInjections(agent: Agent, injections: ContextInjection[] | undefined): ContextInjection[] | undefined;
  agentSees(agent: Agent, metadata: unknown): boolean;
};
const internals = (f: AgentFramework) => f as unknown as Internals;

const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const injection = (t: string): ContextInjection => ({ namespace: 'lessons', position: 'afterUser', content: [text(t)] });
const textOf = (m: { content: unknown }): string =>
  (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
const change = (name: string): ContentBlock[] =>
  [{ type: 'system_change', defineTools: [{ name, description: name, inputSchema: { type: 'object', properties: {} } }] }];
const defined = (messages: ReadonlyArray<{ content: readonly ContentBlock[] }>): string[] =>
  messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'system_change' ? (b.defineTools ?? []).map((t) => t.name) : [])));
const store = (framework: AgentFramework, agent: Agent, participant: string, content: ContentBlock[], metadata?: Parameters<ContextManager['addMessage']>[2]) => {
  const id = agent.getContextManager().addMessage(participant, content, metadata);
  (framework as unknown as { presentation: { afterStore(agent: Agent, ids: unknown[]): void } }).presentation.afterStore(agent, [id]);
  return id;
};
const adopt = (framework: AgentFramework, agent: Agent) => (framework as unknown as { adoptPresentation(agent: Agent): void }).adoptPresentation(agent);
const storedChanges = (cm: ContextManager, owner: string) => cm.queryMessages({ metadata: { kind: 'system-change', agent: owner } }).messages.length;

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
  it("keeps its source's change rows and its own and leaves out another resident's, and its first request takes its source's and its own from its own branch alone", async () => {
    membrane.takesChanges = true;
    const changeTools = async (cm: ContextManager): Promise<string[]> => defined((await cm.compile(undefined, undefined, { dryRun: true })).messages);
    const mira = framework.getAgent('mira')!;
    const oren = framework.getAgent('oren')!;
    store(framework, mira, 'user', [text('Please look into the open issues.')]);
    store(framework, mira, 'system', change('mira-tool'), systemChangeMetadata('mira'));
    store(framework, oren, 'system', change('oren-tool'), systemChangeMetadata('oren'));
    assert.deepEqual(await changeTools(mira.getContextManager()), ['mira-tool'], "the premise: the source's view keeps its own change and leaves out another resident's");
    const fork = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      framing: [{ participant: 'user', content: [text(FRAMING)] }],
    });
    adopt(framework, fork.agent);
    storeOwnRow(fork.agent, 'system', change('fork-tool'), systemChangeMetadata('fork-1'));
    assert.deepEqual(await changeTools(fork.contextManager), ['mira-tool', 'fork-tool'], "the fork's compile: its source's change and its own, not another resident's");
    framework.start();
    membrane.script('fork-1', say('fork-1 done'));
    assert.equal((await framework.runEphemeralToCompletion(fork.agent, fork.contextManager)).speech, 'fork-1 done');
    const [request] = membrane.callsFor('fork-1');
    assert.deepEqual(defined(request!.messages), [], 'its first request records its head and carries no change row');
    const reopened = await framework.inspectAgentContext('fork-1');
    assert.deepEqual(await changeTools(reopened), [], "the reopened fork: another resident's change out of its view, and its source's and its own gone from its branch");
    assert.deepEqual([storedChanges(reopened, 'mira'), storedChanges(reopened, 'fork-1'), storedChanges(reopened, 'oren')], [0, 0, 1],
      "its source's and its own taken out of its branch, and another resident's left there, out of its view");
    assert.deepEqual([storedChanges(mira.getContextManager(), 'mira'), storedChanges(oren.getContextManager(), 'oren')], [1, 1],
      "and the residents' own rows as they were");
  });
});

describe("a resident whose model takes no change, refused over budget", () => {
  let tempDir: string;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-fork-view-budget-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: new RoutedMembrane().asMembrane(),
      agents: [{ name: 'nell', model: 'test-model', systemPrompt: 'You are nell.' }],
      modules: [],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves its own change rows that its window doesn't hold, and the refusal goes on", async () => {
    const nell = framework.getAgent('nell')!;
    const cm = nell.getContextManager();
    cm.addMessage('user', [text('Please look into the open issues.')]);
    const row = cm.addMessage('system', change('n'), systemChangeMetadata('nell'));
    assert.equal(storedChanges(cm, 'nell'), 1, 'the premise: its own row is stored');
    assert.notEqual(cm.windowStatusOf(row), 'in', "the premise: its window doesn't hold it");
    let refused = 0;
    (cm as unknown as { compile: (...args: unknown[]) => Promise<unknown> }).compile = async () => {
      refused++;
      throw Object.assign(new Error('over budget'), { name: 'OverBudgetError' });
    };
    await assert.rejects(nell.buildActivationRequest([]), /over budget/, 'refused over budget');
    assert.equal(refused, 1, 'compiled once');
    assert.equal(storedChanges(cm, 'nell'), 1, 'its row left where it was');
  });
});
