/**
 * Dendrite context derivation through the framework.
 *
 * `deriveAgent` gives a child its parent's context at a checkpoint and a
 * private continuation. With shared inheritance nothing is copied and the
 * child renders what the parent rendered, so the provider prefix the parent
 * paid for is reused. The rendering contract is checked on PROVIDER-
 * FORMATTED requests, up to the fork boundary: the end of the parent's last
 * request before the turn that caused the derivation.
 *
 * Shared inheritance needs branch-bound store handles (`JsStore.view`) and
 * `ContextManager.derive`. Where the installed packages lack them, those
 * tests are skipped by name with the reason; the copy-mode and refusal
 * tests always run.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { NativeFormatter } from '@animalabs/membrane';
import type { NormalizedRequest } from '@animalabs/membrane';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework, AutobiographicalStrategy } from '../src/index.js';
import type { ContextStrategy } from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';
import { createMockResponse } from './helpers/mock-membrane.js';

const supported =
  typeof (JsStore.prototype as unknown as { view?: unknown }).view === 'function' &&
  typeof (ContextManager.prototype as unknown as { derive?: unknown }).derive === 'function';
const skip = supported
  ? false
  : 'installed @animalabs/chronicle / context-manager lack branch-bound handles or ContextManager.derive';

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');

/** A fork's messages after inheritance, leaving aside the parent's round in flight (tested on its own). */
const own = <M extends { metadata?: unknown }>(messages: M[]): M[] =>
  messages.filter((m) => (m.metadata as { kind?: string } | undefined)?.kind !== 'dendrite-pending-round');

const FRAMING = '[FORK-FRAMING] You are the fork. Task: count the open issues.';

function folding(): ContextStrategy {
  return new AutobiographicalStrategy({
    compressionModel: 'mock',
    adaptiveResolution: true,
    targetChunkTokens: 100,
    recentWindowTokens: 200,
  }) as unknown as ContextStrategy;
}

/** Provider-formatted view of a request, as the native formatter sends it. */
function providerFormat(request: NormalizedRequest) {
  const built = new NativeFormatter().buildMessages(request.messages, {
    participantMode: 'multiuser',
    assistantParticipant: request.assistantParticipant ?? 'Claude',
    tools: request.tools,
    thinking: request.config.thinking,
    systemPrompt: request.system,
    promptCaching: request.promptCaching ?? true,
    cacheMarkers: request.cacheMarkers ?? 'membrane-system',
    cacheTtl: request.cacheTtl,
  } as never) as unknown as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
    system?: unknown;
    tools?: unknown;
  };
  return built;
}

type Block = Record<string, unknown>;
const blocksOf = (message: { content: Block[] | string }): Block[] =>
  typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;

describe('Dendrite deriveAgent', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let gates: GateModule;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-derive-'));
    membrane = new RoutedMembrane();
    membrane.completion = '[mock summary]';
    // A derived agent presents itself under its parent's name; tell the two
    // apart by the framing only the fork carries.
    membrane.identify = (request) => {
      const text = JSON.stringify(request.messages);
      if (text.includes('[GRANDCHILD-FRAMING]')) return 'fork-2';
      if (text.includes('[FORK-FRAMING]')) return 'fork-1';
      return request.assistantParticipant ?? '';
    };
    gates = new GateModule();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'mira',
        model: 'test-model',
        systemPrompt: 'You are mira.',
        strategy: folding(),
        contextBudgetTokens: 3200,
        maxTokens: 200,
        thinking: { enabled: true, budgetTokens: 1024 },
        cacheTtl: '5m',
        providerParams: { tier: 'priority' },
      }],
      modules: [gates],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
  });

  afterEach(async () => {
    try { await framework.stop(); } catch { /* already stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Enough history that mira's window cannot hold it raw, then a turn that blocks in a tool. */
  async function miraMidTurn(): Promise<{ parentRequest: NormalizedRequest; history: string[] }> {
    const cm = framework.getAgent('mira')!.getContextManager();
    const history: string[] = [];
    for (let i = 0; i < 60; i++) {
      history.push(cm.addMessage(i % 2 ? 'mira' : 'user', [{ type: 'text', text: `Turn ${i}. ` + 'word '.repeat(40) }]));
    }
    while (!cm.isReady()) await cm.tick();
    history.push(cm.addMessage('user', [{ type: 'text', text: 'Please look into the open issues.' }]));

    membrane.script('mira', waitCall('g-mira'), say('mira done'));
    framework.start();
    (framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now(),
    });
    await until(() => gates.entered.has('g-mira'), 'mira to block mid-turn');
    return { parentRequest: membrane.callsFor('mira').at(-1)!, history };
  }

  async function runFork(options: Parameters<AgentFramework['deriveAgent']>[0]) {
    const fork = await framework.deriveAgent(options);
    const run = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    const result = await run;
    return { ...fork, result };
  }

  it('shared inheritance: the fork continues from the parent\'s context and the parent is untouched', { skip }, async () => {
    const { history } = await miraMidTurn();
    const parentCm = framework.getAgent('mira')!.getContextManager();
    const before = parentCm.getAllMessages();

    membrane.script('fork-1', say('there are 7 open issues'));
    const { result, contextManager } = await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    assert.equal(result.speech, 'there are 7 open issues');

    // The child's own continuation: its framing and its answer, under its own name.
    const forkMessages = contextManager.getAllMessages();
    assert.deepEqual(forkMessages.slice(0, history.length).map((m) => m.id), history);
    assert.deepEqual(
      own(forkMessages).slice(history.length).map((m) => [m.participant, (m.content[0] as { text: string }).text]),
      [['user', FRAMING], ['fork-1', 'there are 7 open issues']],
    );
    // Shared, not copied; and nothing of the child's reached the parent.
    for (let i = 0; i < history.length; i++) assert.equal(forkMessages[i], before[i]);
    assert.deepEqual(parentCm.getAllMessages().map((m) => m.id), history);

    // The registry records what was inherited and where the child's writes live.
    const record = framework.getAgentRecord('fork-1')!;
    assert.equal(record.kind, 'task-fork');
    assert.equal(record.relationships.spawnedBy, 'mira');
    const { derivation, ...inherit } = record.inherit!;
    assert.deepEqual(inherit, {
      from: 'mira',
      mode: 'shared',
      solve: 'reuse',
      refusals: false,
      ownBranch: 'dendrite/fork-1',
      branch: 'main',
      atSequence: record.inherit!.atSequence,
    });
    assert.equal(typeof record.inherit!.atSequence, 'number');
    // What reopening the child's context later needs, as plain data.
    assert.deepEqual(
      (derivation as { slots: unknown; branch: string }).slots,
      { messageNamespace: null, contextNamespace: 'agents/mira', auxiliaryNamespaces: [] },
    );
    assert.equal((derivation as { branch: string }).branch, 'dendrite/fork-1');
    assert.deepEqual(record.selfParticipants, ['mira']);
    assert.equal(record.presentAs, 'mira');
    assert.equal(record.namespace, 'agents/mira', 'its context is the parent\'s namespace on its own branch');
    assert.equal(record.ended?.reason, 'completed');
    // The store cursor never moved.
    assert.equal(framework.getStore().currentBranch().name, 'main');
  });

  it('rendering contract: the fork\'s first request is the parent\'s request plus its framing, byte for byte', { skip }, async () => {
    const { parentRequest } = await miraMidTurn();
    membrane.script('fork-1', say('done'));
    await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const forkRequest = membrane.callsFor('fork-1')[0]!;

    // Identity and inference settings are the parent's, not a default.
    assert.equal(forkRequest.system, parentRequest.system);
    assert.deepEqual(forkRequest.config, parentRequest.config);
    assert.equal(forkRequest.config.model, 'test-model');
    assert.deepEqual(forkRequest.config.thinking, { enabled: true, budgetTokens: 1024 });
    assert.equal(forkRequest.cacheTtl, '5m');
    assert.deepEqual(forkRequest.providerParams, { tier: 'priority' });
    assert.equal(JSON.stringify(forkRequest.tools), JSON.stringify(parentRequest.tools), 'the tool block is identical');
    // The parent's turns are the fork's own turns, under the name the parent's requests use.
    assert.equal(forkRequest.assistantParticipant, parentRequest.assistantParticipant);
    assert.ok(parentRequest.messages.some((m) => m.participant === 'mira'), 'the parent has assistant turns to inherit');

    const parent = providerFormat(parentRequest);
    const fork = providerFormat(forkRequest);
    assert.equal(JSON.stringify(fork.system), JSON.stringify(parent.system));
    assert.equal(JSON.stringify(fork.tools), JSON.stringify(parent.tools));

    // Up to the boundary: every provider message of the parent's request,
    // and within the last one every block, appears unchanged in the fork's.
    //
    // "Unchanged" is the content the provider hashes. Where the breakpoints
    // sit is compared separately: interior breakpoints move from one request
    // to the next by design (a request marks the end of the previous one and
    // its own end), so the parent's own next request would not repeat its
    // earlier interior marker either. What reuse needs is the boundary
    // itself marked in both, which is asserted below.
    const content = (value: unknown): string =>
      JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner));
    const last = parent.messages.length - 1;
    assert.ok(last > 0 && fork.messages.length >= parent.messages.length);
    for (let i = 0; i < last; i++) {
      assert.equal(content(fork.messages[i]), content(parent.messages[i]), `provider message ${i}`);
    }
    assert.equal(fork.messages[last]!.role, parent.messages[last]!.role);
    const parentTail = blocksOf(parent.messages[last]!);
    const forkTail = blocksOf(fork.messages[last]!);
    assert.equal(
      content(forkTail.slice(0, parentTail.length)),
      content(parentTail),
      'the boundary message is a block-for-block prefix',
    );
    // A cache marker sits on the boundary in both requests: the parent wrote
    // the prefix there and the fork names the same breakpoint to read it.
    const boundary = parentTail.length - 1;
    assert.deepEqual(parentTail[boundary]!.cache_control, { type: 'ephemeral', ttl: '5m' }, 'the parent\'s request is cached up to its end');
    assert.deepEqual(forkTail[boundary]!.cache_control, parentTail[boundary]!.cache_control, 'the fork marks the same boundary, same TTL');
    // And the fork stays inside the provider's breakpoint allowance.
    const marked = (messages: typeof fork.messages) =>
      messages.flatMap(blocksOf).filter((block) => block.cache_control).length;
    assert.ok(marked(fork.messages) <= 4 && marked(fork.messages) >= 2);
    // Everything after the boundary is the fork's own.
    const after = [...forkTail.slice(parentTail.length), ...fork.messages.slice(last + 1).flatMap(blocksOf)];
    assert.ok(JSON.stringify(after).includes('[FORK-FRAMING]'));
    // The parent contains folded memory, so this was not a trivial raw copy.
    assert.ok(JSON.stringify(parent.messages).includes('[mock summary]'), 'the shared prefix includes folded memories');
  });

  it('a fresh solve at another budget is a supported choice: it renders differently and says so', { skip }, async () => {
    const { parentRequest } = await miraMidTurn();
    membrane.script('fork-1', say('done'));
    await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      solve: 'fresh',
      config: { contextBudgetTokens: 2000 },
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const forkRequest = membrane.callsFor('fork-1')[0]!;
    assert.equal(framework.getAgentRecord('fork-1')!.inherit!.solve, 'fresh');
    const parent = JSON.stringify(providerFormat(parentRequest).messages);
    const fork = JSON.stringify(providerFormat(forkRequest).messages);
    assert.notEqual(fork.slice(0, parent.length), parent, 'a smaller budget folds more: the prefix is not shared');
    assert.ok(fork.length < parent.length + FRAMING.length + 200, 'and the request is no larger');
    // Still the parent's identity and still a valid request.
    assert.equal(forkRequest.system, parentRequest.system);
    assert.ok(fork.includes('[FORK-FRAMING]'));
  });

  it('inherits the parent\'s refusal ledger only when asked, and says so in the record', { skip }, async () => {
    await miraMidTurn();
    const ledger = 'agents/mira/autobio:compression-refusal-quarantine-events';
    framework.getStore().appendToStateJson(ledger, { kind: 'checkpoint', at: 1, note: 'mira declined this' });

    membrane.script('fork-1', say('done'));
    const without = await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    assert.equal(framework.getAgentRecord('fork-1')!.inherit!.refusals, false);
    assert.equal(without.contextManager.getStore().getStateLen(ledger) ?? 0, 0, 'a task fork is free of its parent\'s refusals');

    membrane.identify = (request) => (JSON.stringify(request.messages).includes('[READER-FRAMING]') ? 'reader-1' : request.assistantParticipant ?? '');
    membrane.script('reader-1', say('done'));
    const withRefusals = await runFork({
      name: 'reader-1',
      from: 'mira',
      kind: 'subconscious-fork',
      inheritRefusals: true,
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: '[READER-FRAMING] you stand in for mira\'s attention' }] }],
    });
    const record = framework.getAgentRecord('reader-1')!;
    assert.equal(record.inherit!.refusals, true, 'the creation record says "with my refusals"');
    assert.equal(withRefusals.contextManager.getStore().getStateLen(ledger), 1, 'and the child knows what mira declined');
    assert.equal(framework.getStore().getStateLen(ledger), 1, 'mira\'s own ledger is untouched');
  });

  it('a running fork can itself be derived from, and each sees only its own line', { skip }, async () => {
    const { history } = await miraMidTurn();
    membrane.script('fork-1', waitCall('g-fork'), say('fork-1 done'));
    const first = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const firstRun = framework.runEphemeralToCompletion(first.agent, first.contextManager);
    await until(() => gates.entered.has('g-fork'), 'fork-1 to block');

    membrane.script('fork-2', say('fork-2 done'));
    const second = await runFork({
      name: 'fork-2',
      from: 'fork-1',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: '[GRANDCHILD-FRAMING] go deeper' }] }],
    });
    assert.equal(second.result.speech, 'fork-2 done');
    const record = framework.getAgentRecord('fork-2')!;
    assert.equal(record.inherit!.branch, 'dendrite/fork-1');
    assert.deepEqual(record.selfParticipants, ['fork-1', 'mira'], 'both ancestors are its own voice');
    assert.equal(membrane.callsFor('fork-2')[0]!.assistantParticipant, 'mira');

    const secondTexts = own(second.contextManager.getAllMessages()).slice(history.length)
      .map((m) => (m.content[0] as { text?: string }).text ?? `<${m.content[0]!.type}>`);
    assert.deepEqual(secondTexts, [FRAMING, '[GRANDCHILD-FRAMING] go deeper', 'fork-2 done']);

    gates.release('g-fork');
    assert.equal((await firstRun).speech, 'fork-1 done');
    const firstTexts = own(first.contextManager.getAllMessages()).slice(history.length).map((m) => m.participant);
    assert.equal(firstTexts.includes('fork-2'), false, 'the grandchild\'s turns never reached its parent');
    assert.equal(framework.getAgent('mira')!.getContextManager().getAllMessages().length, history.length);
  });

  it('returns its result to the parent as attributed mail', { skip }, async () => {
    await miraMidTurn();
    membrane.script('fork-1', say('7 open issues'));
    const { result } = await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      resultTo: { to: 'mira', as: 'message' },
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const mailTraces: string[] = [];
    framework.onTrace((event) => {
      if (event.type.startsWith('dendrite:mail-')) mailTraces.push(event.type);
    });
    const delivery = framework.deliverAgentResult('fork-1', [{ type: 'text', text: result.speech }]);
    assert.equal(delivery.delivered, true);
    // mira is mid-turn: the result waits for her tool boundary, never lost.
    assert.equal(framework.listHeldMail().length, 1);
    assert.deepEqual(mailTraces, ['dendrite:mail-deferred'], 'queued is not delivered');
    gates.release('g-mira');
    await until(() => framework.listHeldMail().length === 0, 'the result to enter mira\'s context');
    assert.deepEqual(mailTraces, ['dendrite:mail-deferred', 'dendrite:mail-delivered'], 'delivered when it entered the store');
    const landed = framework.getAgent('mira')!.getContextManager().getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-result');
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.participant, 'fork-1');
    assert.deepEqual(
      (landed[0]!.metadata as { dendrite: { from: unknown } }).dendrite.from,
      { agent: 'fork-1', incarnation: 1 },
    );
  });

  it('a fork made from inside a tool call sees the call that made it', { skip }, async () => {
    await miraMidTurn(); // mira is blocked in test--wait, call id call-g-mira; that turn is not stored yet
    membrane.script('fork-1', say('seen'));
    const { result, contextManager } = await runFork({
      name: 'fork-1',
      from: 'mira',
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    assert.equal(result.speech, 'seen');
    const messages = contextManager.getAllMessages();
    const at = messages.findIndex((m) => m.content.some((b) => b.type === 'tool_use' && b.id === 'call-g-mira'));
    assert.ok(at >= 0, 'the pending assistant turn is on the fork\'s branch');
    assert.equal(messages[at]!.participant, 'mira', 'stored under the parent\'s name, presented as the fork\'s own');
    assert.equal((messages[at]!.metadata as { kind?: string }).kind, 'dendrite-pending-round');
    const results = messages[at + 1]!;
    assert.equal(results.participant, 'user');
    const toolResult = results.content.find((b) => b.type === 'tool_result') as { toolUseId: string; content: string };
    assert.equal(toolResult.toolUseId, 'call-g-mira');
    assert.match(
      toolResult.content,
      /This call derived fork-1\. You are fork-1, a task-fork, continuing from here on your own branch\. You finish your task and then end; if mira ends first you keep running/,
      'who, what kind, and how long — the consent event\'s fields, in the note',
    );
    assert.equal(textOf(messages[at + 2]!), FRAMING, 'framing follows the round');
    // The parent's own store still has nothing of the round: it lands there when the results are in.
    const miraMessages = framework.getAgent('mira')!.getContextManager().getAllMessages();
    assert.equal(miraMessages.some((m) => m.content.some((b) => b.type === 'tool_use')), false);
    // On the wire: the fork's request pairs the tool_use with a tool_result, so no dangling call.
    const request = membrane.callsFor('fork-1')[0]!;
    const flat = JSON.stringify(request.messages);
    assert.ok(flat.includes('"call-g-mira"') && flat.includes('This call derived fork-1'));
  });

  it('the pending round is the host\'s to word or leave out', async () => {
    await miraMidTurn();
    membrane.script('fork-1', say('ok'));
    membrane.script('fork-2', say('ok'));
    const worded = await runFork({
      name: 'fork-1',
      from: 'mira',
      mode: 'copy',
      pendingRound: { madeBy: { toolUseId: 'call-g-mira', result: 'You are the fork this call asked for.' } },
    });
    const wordedMessages = worded.contextManager.getAllMessages();
    const round = wordedMessages.find((m) => m.content.some((b) => b.type === 'tool_use' && b.id === 'call-g-mira'))!;
    assert.equal(round.participant, 'fork-1', 'copy inheritance: renamed like the rest of the copy');
    const toolResult = wordedMessages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result') as { content: string };
    assert.equal(toolResult.content, 'You are the fork this call asked for.');

    const without = await runFork({ name: 'fork-2', from: 'mira', mode: 'copy', pendingRound: { include: false } });
    assert.equal(
      without.contextManager.getAllMessages().some((m) => m.content.some((b) => b.type === 'tool_use')),
      false,
      'include: false — the fork starts from the last stored message before the round',
    );
  });

  it('denies a tool at dispatch without removing it from the request', async () => {
    const { parentRequest } = await miraMidTurn();
    const refused: Array<{ tool?: unknown; error?: unknown }> = [];
    framework.onTrace((event) => {
      if (event.type === 'tool:failed') refused.push(event as { tool?: unknown; error?: unknown });
    });
    membrane.script(
      'fork-1',
      createMockResponse([{ type: 'tool_use', id: 'call-denied', name: 'test--wait', input: { gate: 'never' } }], 'tool_use'),
      say('could not wait'),
    );
    // Copy inheritance: the deny does not depend on how context is inherited.
    const { result, contextManager } = await runFork({
      name: 'fork-1',
      from: 'mira',
      mode: 'copy',
      config: { denyToolsAtDispatch: ['test--wait'] },
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    assert.equal(result.speech, 'could not wait');
    assert.equal(gates.entered.has('never'), false, 'the tool never ran');
    const forkRequest = membrane.callsFor('fork-1')[0]!;
    assert.equal(JSON.stringify(forkRequest.tools), JSON.stringify(parentRequest.tools), 'still advertised: the prefix is unchanged');
    assert.deepEqual(
      refused.map((event) => [event.tool, event.error]),
      [['test--wait', 'test--wait is not available to fork-1']],
    );
    // The refusal reached the fork as that call's tool result.
    const toolResult = contextManager.getAllMessages()
      .flatMap((m) => m.content)
      .find((block) => block.type === 'tool_result' && (block as { toolUseId: string }).toolUseId === 'call-denied');
    assert.ok(toolResult && JSON.stringify(toolResult).includes('not available to fork-1'));
  });

  it('a stopped fork resumes on the context it left, as a new incarnation', { skip }, async () => {
    const { history } = await miraMidTurn();
    membrane.script('fork-1', waitCall('g-fork'), say('never said'));
    const first = await framework.deriveAgent({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      resultTo: { to: 'mira', as: 'message' },
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const firstRun = framework.runEphemeralToCompletion(first.agent, first.contextManager).catch((error) => error);
    await until(() => gates.entered.has('g-fork'), 'fork-1 to block');

    await assert.rejects(
      framework.resumeAgent('fork-1', { model: 'test-model', systemPrompt: 'You are mira.' }),
      /still registered; only an ended agent resumes/,
    );
    framework.stopAgent('fork-1', { by: 'operator', reason: 'pausing' });
    assert.match(String((await firstRun as Error).message), /ended \(stopped by operator\)/);
    assert.equal(framework.getAgentRecord('fork-1')!.ended?.reason, 'stopped');

    // Configuration is not persisted; the caller supplies it. The role
    // mapping the fork used is restored from its record.
    membrane.script('fork-1', say('resumed and finished'));
    const resumed = await framework.resumeAgent('fork-1', {
      model: 'test-model',
      systemPrompt: 'You are mira.',
      strategy: folding(),
      contextBudgetTokens: 3200,
      maxTokens: 200,
    });
    // It starts from exactly what it had stored: its inheritance and its framing.
    assert.deepEqual(
      own(resumed.contextManager.getAllMessages()).slice(history.length).map((m) => (m.content[0] as { text: string }).text),
      [FRAMING],
    );
    const result = await framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
    assert.equal(result.speech, 'resumed and finished');

    const request = membrane.callsFor('fork-1').at(-1)!;
    assert.equal(request.assistantParticipant, 'mira', 'the inherited voice is still its own');
    const record = framework.getAgentRecord('fork-1')!;
    assert.equal(record.incarnation, 2);
    assert.equal(record.ended?.reason, 'completed');
    assert.equal(record.inherit!.ownBranch, 'dendrite/fork-1', 'the same branch, not a new derivation');
    assert.equal(record.relationships.resultTo?.to, 'mira');
    assert.deepEqual(
      framework.listAgents({ includeEnded: true }).filter((r) => r.name === 'fork-1').map((r) => [r.incarnation, r.ended?.reason]),
      [[1, 'stopped'], [2, 'completed']],
    );
    // The parent was never touched by either incarnation.
    assert.equal(framework.getAgent('mira')!.getContextManager().getAllMessages().length, history.length);

    await assert.rejects(
      framework.resumeAgent('nobody', { model: 'test-model', systemPrompt: 'x' }),
      /not a known ended agent/,
    );
  });

  it('inspects an earlier state of a live agent, and an ended fork, without changing either', { skip }, async () => {
    const { history } = await miraMidTurn();
    const parentCm = framework.getAgent('mira')!.getContextManager();
    const cut = parentCm.getMessage(history[9]!)!.sequence;

    const past = await framework.inspectAgentContext('mira', { atSequence: cut });
    assert.deepEqual(past.getAllMessages().map((m) => m.id), history.slice(0, 10));
    past.addMessage('user', [{ type: 'text', text: 'a note on the snapshot only' }]);
    assert.equal(parentCm.getAllMessages().length, history.length, 'the live agent is unaffected');
    assert.equal(framework.getStore().currentBranch().name, 'main');

    const now = await framework.inspectAgentContext('mira');
    assert.equal(now.getAllMessages().length, history.length);

    membrane.script('fork-1', say('fork done'));
    await runFork({
      name: 'fork-1',
      from: 'mira',
      strategy: folding(),
      framing: [{ participant: 'user', content: [{ type: 'text', text: FRAMING }] }],
    });
    const left = await framework.inspectAgentContext('fork-1');
    assert.deepEqual(
      own(left.getAllMessages()).slice(history.length).map((m) => [m.participant, (m.content[0] as { text: string }).text]),
      [['user', FRAMING], ['fork-1', 'fork done']],
    );
    await assert.rejects(framework.inspectAgentContext('nobody'), /not a known agent/);
  });

  it('copy inheritance works without store support and renames the parent\'s turns', async () => {
    const { history } = await miraMidTurn();
    membrane.identify = (request) => request.assistantParticipant ?? '';
    membrane.script('fork-copy', say('copied and done'));
    const parentCm = framework.getAgent('mira')!.getContextManager();
    const { result, contextManager } = await runFork({
      name: 'fork-copy',
      from: 'mira',
      mode: 'copy',
      framing: [{ participant: 'user', content: [{ type: 'text', text: 'Task: summarise.' }] }],
    });
    assert.equal(result.speech, 'copied and done');
    const record = framework.getAgentRecord('fork-copy')!;
    assert.equal(record.inherit!.mode, 'copy');
    assert.equal(record.inherit!.ownBranch, undefined);
    assert.equal(record.selfParticipants, undefined);
    assert.equal(record.namespace, 'subagent/fork-copy');

    const copied = contextManager.getAllMessages();
    assert.ok(copied.length > 2);
    assert.ok(copied.some((m) => m.participant === 'fork-copy'), 'the parent\'s turns were renamed at copy time');
    assert.equal(copied.some((m) => m.participant === 'mira'), false);
    // A copy has new ids: it shares nothing with the parent's store.
    assert.equal(copied.some((m) => history.includes(m.id)), false);
    assert.equal(parentCm.getAllMessages().length, history.length);
    // Configuration is inherited in copy mode too.
    const request = membrane.callsFor('fork-copy')[0]!;
    assert.deepEqual(request.config.thinking, { enabled: true, budgetTokens: 1024 });
    assert.equal(request.assistantParticipant, 'fork-copy');
  });

  it('refuses shared inheritance plainly when the context manager cannot derive', async () => {
    const parentCm = framework.getAgent('mira')!.getContextManager();
    Object.defineProperty(parentCm, 'derive', { value: undefined, configurable: true });
    await assert.rejects(
      framework.deriveAgent({ name: 'fork-1', from: 'mira' }),
      /shared context inheritance needs a @animalabs\/context-manager that provides ContextManager\.derive; use inherit\.mode "copy"/,
    );
    assert.equal(framework.getAgentRecord('fork-1'), null, 'nothing was registered');
    await assert.rejects(framework.deriveAgent({ name: 'fork-2', from: 'ghost' }), /"ghost" is not a registered agent/);
  });
});

describe('Dendrite role assignment at request assembly', () => {
  let tempDir: string;
  let framework: AgentFramework;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-roles-'));
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: new RoutedMembrane().asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
      modules: [],
      syncIntervalMs: 0,
    });
  });

  afterEach(async () => {
    try { await framework.stop(); } catch { /* already stopped */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const text = (value: string) => [{ type: 'text' as const, text: value }];

  async function requestFor(config: { selfParticipants?: string[]; presentAs?: string }, name: string) {
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name, model: 'test-model', systemPrompt: 'x', ...config,
    });
    contextManager.addMessage('user', text('hello'));
    contextManager.addMessage('mira', text('inherited parent turn'));
    contextManager.addMessage('oren', text('someone else'));
    contextManager.addMessage(name, text('the fork\'s own turn'));
    const request = await agent.buildActivationRequest([]);
    // Stored authorship is never rewritten, whatever the request shows.
    assert.deepEqual(
      contextManager.getAllMessages().map((m) => m.participant),
      ['user', 'mira', 'oren', name],
    );
    return request;
  }

  it('presents the inherited voice and the agent\'s own turns under one name', async () => {
    const request = await requestFor({ selfParticipants: ['mira'], presentAs: 'mira' }, 'fork-a');
    assert.equal(request.assistantParticipant, 'mira');
    assert.deepEqual(
      request.messages.map((m) => m.participant),
      // Both own voices are 'mira'; other participants are untouched. The
      // request would end on an assistant turn, so the continuation is added
      // — which only happens if the fork's own turn was recognised as its own.
      ['user', 'mira', 'oren', 'mira', 'user'],
    );
    assert.deepEqual(request.messages.at(-1)!.content, [{ type: 'text', text: '[Continue]' }]);
  });

  it('with no presentation name set, the inherited voice is presented under the agent\'s name', async () => {
    const request = await requestFor({ selfParticipants: ['mira'] }, 'fork-b');
    assert.equal(request.assistantParticipant, 'fork-b');
    assert.deepEqual(request.messages.map((m) => m.participant), ['user', 'fork-b', 'oren', 'fork-b', 'user']);
  });

  it('an agent that declares neither is assembled exactly as before', async () => {
    const request = await requestFor({}, 'plain');
    assert.equal(request.assistantParticipant, 'plain');
    // The parent's name is just another participant to it.
    assert.deepEqual(request.messages.map((m) => m.participant), ['user', 'mira', 'oren', 'plain', 'user']);
  });
});
