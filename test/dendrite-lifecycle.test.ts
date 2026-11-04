/**
 * Dendrite lifecycle through the framework: the creation paths register as
 * presets, anyone can stop or cancel, orphans are told and can be adopted,
 * results travel as attributed mail that is neither lost nor duplicated,
 * and a restart settles what the previous process left unfinished.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import {
  AgentFramework,
  AgentSpecError,
  AgentStoppedError,
  taskForkSpec,
  workerSpec,
} from '../src/index.js';
import type {
  AgentSpec,
  ProcessEvent,
  TraceEvent,
} from '../src/index.js';
import { GateModule, RoutedMembrane, say, until, waitCall } from './helpers/dendrite.js';

function textsIn(framework: AgentFramework, agent: string): Array<{ participant: string; text: string; metadata: Record<string, unknown> }> {
  return framework.getAgent(agent)!.getContextManager().getAllMessages().map((message) => ({
    participant: message.participant,
    text: message.content.map((block) => (block.type === 'text' ? block.text : `<${block.type}>`)).join(''),
    metadata: (message.metadata ?? {}) as Record<string, unknown>,
  }));
}

describe('Dendrite lifecycle', () => {
  let tempDir: string;
  let membrane: RoutedMembrane;
  let gates: GateModule;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-lifecycle-'));
    membrane = new RoutedMembrane();
    gates = new GateModule();
    frameworks = [];
  });

  afterEach(async () => {
    for (const framework of frameworks.reverse()) {
      try { await framework.stop(); } catch { /* already stopped */ }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function boot(overrides: Partial<Parameters<typeof AgentFramework.create>[0]> = {}): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      storePath: join(tempDir, 'store.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [
        { name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' },
        { name: 'oren', model: 'test-model', systemPrompt: 'You are oren.' },
      ],
      modules: [gates],
      syncIntervalMs: 0,
      ...overrides,
    });
    frameworks.push(framework);
    return framework;
  }

  /** Start a bounded agent whose first act is to block on `gate`. */
  async function startBlocked(
    framework: AgentFramework,
    name: string,
    gate: string,
    spec?: Omit<AgentSpec, 'name'>,
    finalText = `${name} done`,
  ) {
    membrane.script(name, waitCall(gate), say(finalText));
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      spec,
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const run = framework.runEphemeralToCompletion(agent, contextManager);
    // Observe the outcome without leaving a rejection unhandled.
    const settled = run.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await until(() => gates.entered.has(gate), `${name} to block on ${gate}`);
    return { agent, contextManager, settled };
  }

  it('registers every creation path as a preset and answers discovery', async () => {
    const framework = await boot({
      subconscious: { enabled: true, systemPrompt: 'You watch.' } as never,
    });
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();

    const worker = await startBlocked(framework, 'worker-1', 'g1');

    const byName = new Map(framework.listAgents().map((record) => [record.name, record]));
    assert.deepEqual([...byName.keys()], ['mira', 'oren', 'Subconscious', 'worker-1']);
    assert.equal(framework.getPrimaryAgentName(), 'mira');
    assert.equal(byName.get('mira')!.roles.defaultDelivery, true);
    assert.equal(byName.get('oren')!.roles.defaultDelivery, false);
    assert.deepEqual(byName.get('mira')!.lifetime, { kind: 'persistent' });

    const subconscious = byName.get('Subconscious')!;
    assert.equal(subconscious.kind, 'subconscious');
    assert.equal(subconscious.relationships.spawnedBy, 'mira');
    assert.equal(subconscious.onParentEnd, 'end', 'attention tenancy ends with the resident it serves');
    assert.equal(subconscious.roles.receivesUntargeted, false);
    assert.deepEqual(subconscious.relationships.observes, [{ includeHeld: true }]);

    const record = byName.get('worker-1')!;
    assert.equal(record.kind, 'worker');
    assert.equal(record.lifetime.kind, 'task');
    assert.equal(record.relationships.spawnedBy, undefined, 'an independent agent needs no artificial parent');
    assert.equal(record.namespace, 'subagent/worker-1');

    // The agent that owns the in-flight work is identified.
    const activation = framework.listActivations().find((a) => a.owner.agent === 'worker-1');
    assert.ok(activation, 'the running job has an owned activation');
    assert.deepEqual(activation!.owner, { agent: 'worker-1', incarnation: 1 });
    assert.equal(activation!.reason, 'ephemeral');

    const created = traces.find((t) => t.type === 'dendrite:agent-created' && t.agentName === 'worker-1');
    assert.ok(created, 'creation is announced');
    assert.deepEqual((created as { lifetime: unknown }).lifetime, record.lifetime);
    // Whose weights, next to whose context: what a consent decision is made on.
    assert.equal((created as { model?: string }).model, 'test-model');
    assert.equal(record.model, 'test-model');
    assert.equal(byName.get('mira')!.model, 'test-model');

    gates.release('g1');
    const result = await worker.settled;
    assert.ok(result.ok);
    assert.equal(framework.getAgentRecord('worker-1')?.ended?.reason, 'completed');
    assert.equal(framework.listAgents().some((r) => r.name === 'worker-1'), false);
    assert.equal(
      framework.listAgents({ includeEnded: true }).some((r) => r.name === 'worker-1'),
      true,
      'an ended agent stays inspectable',
    );
  });

  it('an untargeted broadcast wakes residents and not a running bounded job', async () => {
    const framework = await boot();
    framework.start();
    const worker = await startBlocked(framework, 'worker-1', 'g1');
    const before = membrane.calls.length;

    gates.broadcastOn = 'custom';
    framework.pushEvent({ type: 'custom', name: 'nudge' } as unknown as ProcessEvent);
    await until(
      () => membrane.callsFor('mira').length > 0 && membrane.callsFor('oren').length > 0,
      'both residents to be woken',
    );
    gates.broadcastOn = null;
    // The job was never queued for the broadcast — not queued and then
    // dropped once it finished.
    const queued = (framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests;
    assert.equal(queued.some((request) => request.agentName === 'worker-1'), false);

    gates.release('g1');
    assert.ok((await worker.settled).ok);
    await framework.runUntilIdle();
    // One stream, which held both of the job's own rounds: the broadcast
    // started no turn of its own for the job.
    assert.equal(membrane.callsFor('worker-1').length, 1);
    assert.ok(membrane.calls.length >= before + 2);
  });

  it('refuses to run a bounded job with no bound, leaving nothing registered', async () => {
    const framework = await boot();
    framework.start();
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name: 'forever', model: 'test-model', systemPrompt: 'x', allowedTools: 'all' },
      { ...workerSpec('forever'), lifetime: { kind: 'task' } },
    );
    await assert.rejects(
      framework.runEphemeralToCompletion(agent, contextManager),
      (error: unknown) => error instanceof AgentSpecError && /every task agent must end/.test(error.message),
    );
    assert.equal(framework.getAgent('forever'), null);
    assert.equal(framework.getAgentRecord('forever'), null);
  });

  it('stopAgent ends a running job: its caller is told who stopped it and why', async () => {
    const framework = await boot();
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    const worker = await startBlocked(framework, 'worker-1', 'g1', workerSpec('worker-1', { spawnedBy: 'oren' }));

    const outcome = framework.stopAgent('worker-1', { by: 'mira', reason: 'no longer needed' });
    assert.equal(outcome.ended.ended?.reason, 'stopped');
    assert.equal(outcome.ended.ended?.by, 'mira', 'anyone may stop: mira did not spawn it');

    const result = await worker.settled;
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error instanceof AgentStoppedError);
    assert.match(String(!result.ok && (result.error as Error).message), /ended \(stopped by mira\): no longer needed/);
    assert.equal(framework.getAgent('worker-1'), null);
    assert.deepEqual(framework.getAgentRecord('worker-1')?.ended && {
      reason: framework.getAgentRecord('worker-1')!.ended!.reason,
      by: framework.getAgentRecord('worker-1')!.ended!.by,
    }, { reason: 'stopped', by: 'mira' });
    assert.equal(traces.filter((t) => t.type === 'dendrite:agent-ended' && t.agentName === 'worker-1').length, 1);

    assert.throws(() => framework.stopAgent('worker-1'), /not a registered agent/);
    assert.throws(() => framework.stopAgent('mira'), /owns default delivery and cannot be stopped/);
  });

  it('cancelActivation ends a bounded job through its own run', async () => {
    const framework = await boot();
    framework.start();
    const worker = await startBlocked(framework, 'worker-1', 'g1');
    assert.equal(framework.cancelActivation('worker-1', { by: 'oren', reason: 'changed plans' }), true);
    const result = await worker.settled;
    assert.equal(result.ok, false);
    const ended = framework.getAgentRecord('worker-1')?.ended;
    assert.equal(ended?.reason, 'stopped');
    assert.equal(ended?.by, 'oren');
    assert.equal(framework.cancelActivation('oren'), false, 'nothing was running for oren');
  });

  it('enforces a task deadline however lively the run is', async () => {
    const framework = await boot();
    framework.start();
    // The outcome alone is awaited: on a loaded machine the 60 ms deadline can
    // pass before the job reaches its gate, and either way the job must end
    // at its deadline, so nothing here waits on the gate first.
    membrane.script('worker-1', waitCall('g1'), say('worker-1 done'));
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name: 'worker-1', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      { ...workerSpec('worker-1'), lifetime: { kind: 'task', deadlineMs: 60 } },
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const worker = {
      settled: framework.runEphemeralToCompletion(agent, contextManager).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    };
    const result = await worker.settled;
    assert.ok(!result.ok && result.error instanceof AgentStoppedError);
    assert.equal(framework.getAgentRecord('worker-1')?.ended?.reason, 'deadline');
    assert.equal(framework.getAgent('worker-1'), null);
  });

  it('a task deadline past the longest timer waits it out rather than ending the job at once', async () => {
    const framework = await boot();
    framework.start();
    const deadlineMs = 2 ** 31; // one past the longest wait a timer holds
    const worker = await startBlocked(
      framework,
      'worker-1',
      'g1',
      { ...workerSpec('worker-1'), lifetime: { kind: 'task', deadlineMs } },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(framework.getAgentRecord('worker-1')?.ended, undefined, 'the job is still running');
    framework.stopAgent('worker-1');
    const result = await worker.settled;
    assert.equal(framework.getAgentRecord('worker-1')?.ended?.reason, 'stopped');
    assert.ok(!result.ok);
  });

  it('a replay of create()\'s traces keeps the first 1,000 and ends by naming how many it dropped', async () => {
    const framework = await boot();
    const emit = (framework as unknown as { emitTrace(event: unknown): void }).emitTrace.bind(framework);
    for (let i = 0; i < 1005; i++) emit({ type: 'dendrite:test-early', seq: i });
    const replayed: Array<{ type: string; seq?: number; dropped?: number }> = [];
    framework.onTrace((event) => replayed.push(event as never), { replay: true });
    assert.equal(replayed.length, 1001, 'the first 1,000, then one event naming the rest');
    const ours = replayed.filter((e) => e.type === 'dendrite:test-early').map((e) => e.seq);
    assert.equal(ours[0], 0, 'the start of the stream is kept');
    assert.deepEqual(ours, [...ours].sort((a, b) => a! - b!), 'in order');
    assert.ok(!ours.includes(1004), 'the newest are the ones dropped');
    const last = replayed.at(-1)!;
    assert.equal(last.type, 'dendrite:early-traces-dropped');
    assert.equal(last.dropped, 1005 - ours.length);
  });

  it('delivers a result as attributed mail in the child\'s own name and wakes the recipient', async () => {
    const framework = await boot();
    framework.start();
    const fork = await startBlocked(
      framework,
      'fork-1',
      'g1',
      taskForkSpec('fork-1', { parent: 'oren', resultTo: { to: 'oren', as: 'message' } }),
      'the answer is 42',
    );
    gates.release('g1');
    const result = await fork.settled;
    assert.ok(result.ok);

    // The run has ended; its record still carries the route.
    const delivery = framework.deliverAgentResult(
      'fork-1',
      [{ type: 'text', text: result.ok ? result.value.speech : '' }],
      { causedBy: ['task-7'] },
    );
    assert.deepEqual({ delivered: delivery.delivered, to: delivery.to }, { delivered: true, to: 'oren' });
    await until(() => membrane.callsFor('oren').length > 0, 'oren to be woken by the result');
    await framework.runUntilIdle();

    const landed = textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-result');
    assert.equal(landed.length, 1);
    assert.equal(landed[0]!.participant, 'fork-1', 'the result is the child\'s own words under its own name');
    assert.equal(landed[0]!.text, 'the answer is 42');
    const stamp = landed[0]!.metadata.dendrite as Record<string, unknown>;
    assert.equal(typeof stamp.producedAt, 'number', 'when it was produced, apart from when it is read');
    assert.deepEqual({ ...stamp, producedAt: undefined }, {
      mailId: delivery.mailId,
      kind: 'result',
      from: { agent: 'fork-1', incarnation: 1 },
      causedBy: ['task-7'],
      producedAt: undefined,
    });
    assert.deepEqual(framework.listHeldMail(), [], 'a delivered result is no longer held');
    // (Co-residents share one message slot today, so mira can read it too;
    // what the route decides is who it is addressed to and who is woken.)
    assert.equal(membrane.callsFor('mira').length, 0, 'the primary is not woken for a result routed elsewhere');
  });

  it('refuses to deliver a result whose route is a tool result: the caller awaiting the run already has it', async () => {
    const framework = await boot();
    framework.start();
    const job = await startBlocked(
      framework,
      'inline-1',
      'g1',
      workerSpec('inline-1', { spawnedBy: 'oren', resultTo: { to: 'oren', as: 'tool-result' } }),
      'the inline answer',
    );
    gates.release('g1');
    assert.ok((await job.settled).ok);
    assert.throws(
      () => framework.deliverAgentResult('inline-1', [{ type: 'text', text: 'the inline answer' }]),
      /deliverAgentResult: "inline-1" returns its result as a tool-result; the caller awaiting the run delivers it/,
    );
    assert.deepEqual(framework.listHeldMail({ from: 'inline-1' }), [], 'nothing is held for delivery');
    await framework.runUntilIdle();
    assert.equal(
      textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-result').length,
      0,
      "no second copy lands in the caller's context",
    );
  });

  it('with a derivationNotice that passes the line on, a derivation tells the agent it was made from — name, kind, weights, inheritance, route, lifetime — and not the fork (#270)', async () => {
    const framework = await boot({ dendrite: { derivationNotice: (_record, _from, line) => line } });
    framework.start();
    const fork = await startBlocked(
      framework,
      'fork-1',
      'g1',
      taskForkSpec('fork-1', { parent: 'oren', resultTo: { to: 'oren', as: 'message' }, idleTimeoutMs: 600_000 }),
    );
    const told = () => textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-lifecycle');
    assert.equal(told().length, 1, 'the source hears of the derivation once, as a host-framed lifecycle line');
    const line = told()[0]!;
    assert.equal(line.participant, 'user', 'host-framed, voiced as nobody');
    for (const fact of ['fork-1', 'task-fork', 'your weights', 'copy of your context', 'returns to you', 'it ends when its task does (idle 10 min)', 'orphaned']) {
      assert.ok(line.text.includes(fact), `the notice names ${JSON.stringify(fact)}: ${line.text}`);
    }
    assert.deepEqual(line.metadata.dendrite, {
      event: 'derived', agent: 'fork-1', kind: 'task-fork', incarnation: 1, model: 'test-model',
      inherit: { from: 'oren', mode: 'copy' }, resultTo: { to: 'oren', as: 'message' },
      lifetime: { kind: 'task', idleTimeoutMs: 600_000 },
    });
    assert.ok(
      !fork.contextManager.getAllMessages().some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-lifecycle'),
      'the fork never inherits the notice about itself',
    );
    assert.equal(membrane.callsFor('oren').length, 0, 'a notice requests no wake');

    gates.release('g1');
    const result = await fork.settled;
    assert.ok(result.ok);

    // A resumption is announced to the source too, and says which it is.
    membrane.script('fork-1', say('back again'));
    const resumed = await framework.resumeAgent('fork-1', { model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' });
    await framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
    assert.equal(told().length, 2);
    assert.ok(told()[1]!.text.includes('resumed') && told()[1]!.text.includes('incarnation 2'), told()[1]!.text);
  });

  it('above a threshold, derivation notices collapse to a count line every threshold forks (Linn, #270)', async () => {
    const framework = await boot({ dendrite: { collapseDerivationNoticesAfter: 3, derivationNotice: (_record, _from, line) => line } });
    framework.start();
    for (let n = 1; n <= 7; n++) {
      const name = `reader-${n}`;
      membrane.script(name, say('looked'));
      const { agent, contextManager } = await framework.createEphemeralAgent(
        { name, model: 'test-model', systemPrompt: 'Read.' },
        taskForkSpec(name, { parent: 'oren', resultTo: { to: 'oren', as: 'message' } }),
      );
      contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      await framework.runEphemeralToCompletion(agent, contextManager);
    }
    const told = textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-lifecycle');
    assert.deepEqual(
      told.map((m) => (m.metadata.dendrite as { agent: string }).agent),
      ['reader-1', 'reader-2', 'reader-3', 'reader-6'],
      'three per-fork lines, then one count line at the sixth; the seventh waits for the ninth',
    );
    const count = told[3]!;
    assert.ok(count.text.includes('6 task-forks have been derived from you'), count.text);
    assert.ok(count.text.includes('3 since the last note'), count.text);
    assert.ok(count.text.includes('the latest, reader-6,'), count.text);
    assert.deepEqual((count.metadata.dendrite as { collapsed: unknown }).collapsed, { count: 6, sinceLastNote: 3 });
    assert.equal(
      framework.listAgents({ includeEnded: true }).filter((r) => r.kind === 'task-fork').length, 7,
      'the per-fork records are all there for anyone who fetches',
    );
  });

  it('orphans task work when its parent ends, offers adoption, and holds the result until adopted', async () => {
    const framework = await boot();
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();

    const boss = await startBlocked(framework, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(
      framework,
      'job',
      'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }),
      'job result',
    );
    // A reader that exists only to serve the boss: attention tenancy.
    const reader = await startBlocked(
      framework,
      'reader',
      'g-reader',
      { ...workerSpec('reader', { spawnedBy: 'boss' }), onParentEnd: 'end' },
    );

    const outcome = framework.stopAgent('boss', { by: 'mira' });
    assert.deepEqual(outcome.cascaded.map((r) => r.name), ['reader']);
    assert.deepEqual(outcome.orphaned.map((o) => [o.record.name, o.candidates]), [['job', ['oren', 'mira']]]);

    // The tenant ended with its parent; the job did not.
    const readerResult = await reader.settled;
    assert.ok(!readerResult.ok && readerResult.error instanceof AgentStoppedError);
    assert.equal(framework.getAgentRecord('reader')?.ended?.reason, 'parent-ended');
    assert.ok(!(await boss.settled).ok);
    assert.ok(framework.getAgent('job'), 'orphaned task work keeps running');
    assert.equal(framework.getAgentRecord('job')?.orphaned?.formerParent.agent, 'boss');

    const orphaned = traces.find((t) => t.type === 'dendrite:agent-orphaned');
    assert.deepEqual(orphaned && {
      agentName: orphaned.agentName, formerParent: orphaned.formerParent, candidates: orphaned.candidates,
    }, { agentName: 'job', formerParent: 'boss', candidates: ['oren', 'mira'] });

    // The nearest candidate is told, factually.
    const offer = textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-lifecycle');
    assert.equal(offer.length, 1);
    assert.match(offer[0]!.text, /boss has ended \(stopped\).*"job".*can be reparented to you/);
    assert.equal(offer[0]!.participant, 'user', 'a lifecycle fact is host-framed, never voiced as an agent');

    // The orphan finishes. Its notice reached it at its tool boundary.
    gates.release('g-job');
    const jobResult = await job.settled;
    assert.ok(jobResult.ok && jobResult.value.speech === 'job result');
    const notice = job.contextManager.getAllMessages()
      .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-lifecycle');
    assert.equal(notice.length, 1);
    assert.match(
      notice[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      /boss, the agent that started you, has ended \(stopped\)\. Your own work is not cancelled\. Your result will be held/,
    );

    // Nobody can receive the result yet: held, not dropped.
    const delivery = framework.deliverAgentResult('job', [{ type: 'text', text: 'job result' }]);
    assert.equal(delivery.delivered, false);
    assert.deepEqual(
      framework.listHeldMail().map((m) => [m.id, m.to, m.heldBecause]),
      [[delivery.mailId, 'boss', 'recipient-gone']],
    );
    assert.ok(traces.some((t) => t.type === 'dendrite:mail-held' && t.mailId === delivery.mailId));
  });

  it('reparenting a running orphan reroutes its result to the new parent, once', async () => {
    const framework = await boot();
    framework.start();
    await startBlocked(framework, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(
      framework,
      'job',
      'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }),
      'late result',
    );
    framework.stopAgent('boss', { by: 'mira' });

    const adopted = framework.reparentAgent('job', 'oren', { by: 'oren' });
    assert.equal(adopted.orphaned, undefined);
    assert.equal(adopted.relationships.spawnedBy, 'oren');
    assert.equal(adopted.relationships.resultTo?.to, 'oren');

    gates.release('g-job');
    assert.ok((await job.settled).ok);
    const delivery = framework.deliverAgentResult('job', [{ type: 'text', text: 'late result' }]);
    assert.equal(delivery.to, 'oren');
    await framework.runUntilIdle();

    const results = textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-result');
    assert.deepEqual(results.map((m) => [m.participant, m.text]), [['job', 'late result']]);
    assert.deepEqual(framework.listHeldMail(), []);
  });

  it('a result produced before adoption is delivered to the adopter, exactly once', async () => {
    const framework = await boot();
    framework.start();
    await startBlocked(framework, 'boss', 'g-boss', workerSpec('boss', { spawnedBy: 'oren' }));
    const job = await startBlocked(
      framework,
      'job',
      'g-job',
      workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }),
      'held result',
    );
    framework.stopAgent('boss');
    // Keep the job registered while its finished output waits: deliver from inside the run.
    const held = framework.deliverAgentResult('job', [{ type: 'text', text: 'held result' }]);
    assert.equal(held.delivered, false);

    framework.reparentAgent('job', 'oren');
    const results = () => textsIn(framework, 'oren').filter((m) => m.metadata.kind === 'agent-result');
    // The job is still blocked, so the framework is not idle; wait for the delivery itself.
    await until(() => results().length > 0 && membrane.callsFor('oren').length > 0, 'the held result to reach oren');
    assert.deepEqual(results().map((m) => [m.participant, m.text, (m.metadata.dendrite as { mailId: string }).mailId]), [
      ['job', 'held result', held.mailId],
    ]);
    assert.deepEqual(framework.listHeldMail(), []);

    gates.release('g-job');
    await job.settled;
    await framework.runUntilIdle();
    assert.equal(results().length, 1);
  });

  it('an explicit agent-to-agent message is attributed and recorded as a message path', async () => {
    const framework = await boot();
    framework.start();
    const sent = framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'the build is green' }]);
    assert.equal(sent.delivered, true);
    await framework.runUntilIdle();

    const message = textsIn(framework, 'mira').find((m) => m.metadata.kind === 'agent-message');
    assert.ok(message);
    assert.equal(message!.participant, 'oren');
    assert.deepEqual((message!.metadata.dendrite as { from: unknown }).from, { agent: 'oren', incarnation: 1 });
    assert.deepEqual(framework.getAgentRecord('oren')!.relationships.messagePeers, ['mira']);
    assert.deepEqual(framework.getAgentRecord('mira')!.relationships.messagePeers, [], 'a path is directional');
    assert.throws(() => framework.sendAgentMessage('ghost', 'mira', []), /sender "ghost" is not a known agent/);
  });

  it("stopping a resident whose stream's cancel throws still leaves nothing running under its ended record", async () => {
    const framework = await boot();
    framework.start();
    membrane.script('oren', waitCall('g-oren'), say('oren done'));
    framework.sendAgentMessage('mira', 'oren', [{ type: 'text', text: 'look at this' }]);
    await until(() => gates.entered.has('g-oren'), 'oren to block on g-oren');
    framework.getAgent('oren')!.cancelStream = () => { throw new Error('the stream refused to cancel'); };
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      assert.equal(framework.stopAgent('oren', { by: 'mira' }).ended.ended?.reason, 'stopped');
    } finally { console.error = consoleError; }
    assert.equal(framework.getAgent('oren'), null, 'no agent runs under the ended record');
    assert.ok(logged.some((line) => line.includes('the stream refused to cancel')), logged.join('\n'));
    gates.release('g-oren');
  });

  it('stopping a resident that put the gate to sleep ends the sleep', async () => {
    const framework = await boot({ gate: { config: { default: 'always' } } } as Partial<Parameters<typeof AgentFramework.create>[0]>);
    framework.start();
    const gate = (framework as unknown as {
      eventGate: { setSleep(seconds: number, note?: string, agentName?: string): unknown; getSleepState(): unknown };
    }).eventGate;
    gate.setSleep(600, 'resting', 'oren');
    assert.ok(gate.getSleepState(), 'the gate sleeps for oren');
    framework.stopAgent('oren', { by: 'mira' });
    assert.equal(gate.getSleepState(), null, "oren's sleep ended with oren");
  });

  it('a derivation that fails after its child is made closes the manager it opened, and its name stays used', async () => {
    const framework = await boot();
    const openManagers = () => (framework as unknown as { openManagers: Set<WeakRef<object>> }).openManagers.size;
    const before = openManagers();
    const source = framework.getAgent('mira')!.getContextManager();
    const compile = source.compile.bind(source);
    let failNext = true;
    source.compile = ((...args: Parameters<typeof compile>) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('the source would not compile')); }
      return compile(...args);
    }) as typeof source.compile;
    await assert.rejects(framework.deriveAgent({ name: 'fork-c', from: 'mira', mode: 'copy' }), /the source would not compile/);
    assert.equal(framework.getAgentRecord('fork-c'), null, 'nothing registered');
    assert.equal(openManagers(), before, "the child's manager is closed");
    await assert.rejects(framework.deriveAgent({ name: 'fork-c', from: 'mira', mode: 'copy' }), /has been used in this framework/,
      'what was written under the name stays its own');
  });

  it("a derivation whose notice to its source can't be written still runs to its end", async () => {
    const framework = await boot({
      dendrite: { derivationNotice: () => { throw new Error('the notice hook failed'); } },
    } as Partial<Parameters<typeof AgentFramework.create>[0]>);
    framework.start();
    membrane.script('fork-n', say('fork-n done'));
    const fork = await framework.deriveAgent({ name: 'fork-n', from: 'mira', mode: 'copy' });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let result: Awaited<ReturnType<typeof framework.runEphemeralToCompletion>>;
    try {
      result = await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    } finally { console.error = consoleError; }
    assert.equal(result.speech, 'fork-n done');
    assert.equal(framework.getAgentRecord('fork-n')?.ended?.reason, 'completed');
    assert.ok(logged.some((line) => line.includes('the notice hook failed')), logged.join('\n'));
  });

  it("mail from an agent the recipient counts as its own voice arrives as '<sender> (mail)', not as its own words", async () => {
    const framework = await boot();
    framework.start();
    membrane.script('fork-m', waitCall('g-fork-m'), say('fork-m done'));
    const fork = await framework.deriveAgent({ name: 'fork-m', from: 'mira', mode: 'copy', config: { selfParticipants: ['mira'] } });
    fork.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    const run = framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
    await until(() => gates.entered.has('g-fork-m'), 'fork-m to block on g-fork-m');
    framework.sendAgentMessage('mira', 'fork-m', [{ type: 'text', text: 'also check the docs' }], { wake: false });
    gates.release('g-fork-m');
    await run;
    const mail = fork.contextManager.getAllMessages().find((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-message');
    assert.equal(mail?.participant, 'mira (mail)');
    assert.deepEqual((mail!.metadata as { dendrite: { from: unknown } }).dendrite.from, { agent: 'mira', incarnation: 1 });
    assert.ok(!membrane.callsFor('fork-m').some((call) => call.messages.some((m) =>
      m.participant === 'fork-m' && JSON.stringify(m.content).includes('also check the docs'))), 'never presented as its own turn');
  });

  it('a copy derivation that asks for what only a shared one inherits is refused before anything is made', async () => {
    const framework = await boot();
    await assert.rejects(framework.deriveAgent({ name: 'fork-r', from: 'mira', mode: 'copy', inheritRefusals: true }), /inheritRefusals is for mode 'shared'/);
    await assert.rejects(framework.deriveAgent({ name: 'fork-s', from: 'mira', mode: 'copy', solve: 'fresh' }), /solve is for mode 'shared'/);
    assert.equal(framework.getAgentRecord('fork-r'), null);
    const made = await framework.deriveAgent({ name: 'fork-r', from: 'mira', mode: 'copy' });
    made.cleanup();
  });

  it('of two overlapping resumes of one ended job, one resumes it and the other is refused', async () => {
    const framework = await boot();
    framework.start();
    membrane.script('job-r', say('job-r done'));
    const made = await framework.createEphemeralAgent(
      { name: 'job-r', model: 'test-model', systemPrompt: 'Do the task.' },
      workerSpec('job-r', { spawnedBy: 'mira' }),
    );
    made.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await framework.runEphemeralToCompletion(made.agent, made.contextManager);
    const config = { model: 'test-model', systemPrompt: 'Do the task.' };
    const outcomes = await Promise.allSettled([framework.resumeAgent('job-r', config), framework.resumeAgent('job-r', config)]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason), /"job-r" is already being resumed/);
    const resumed = (outcomes.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof framework.resumeAgent>>>).value;
    membrane.script('job-r', say('job-r again'));
    assert.equal((await framework.runEphemeralToCompletion(resumed.agent, resumed.contextManager)).speech, 'job-r again');
    assert.equal(framework.getAgentRecord('job-r')?.incarnation, 2);
  });

  it('a resume refused for its configuration leaves the job free to resume', async () => {
    const framework = await boot();
    framework.start();
    membrane.script('job-v', say('job-v done'));
    const made = await framework.createEphemeralAgent(
      { name: 'job-v', model: 'test-model', systemPrompt: 'Do the task.' },
      workerSpec('job-v', { spawnedBy: 'mira' }),
    );
    made.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await framework.runEphemeralToCompletion(made.agent, made.contextManager);
    await assert.rejects(
      framework.resumeAgent('job-v', { model: 'test-model', systemPrompt: 'Do the task.', promptCaching: 'yes' as unknown as boolean }),
      /promptCaching/,
    );
    const resumed = await framework.resumeAgent('job-v', { model: 'test-model', systemPrompt: 'Do the task.' });
    resumed.cleanup();
  });

  it("an earlier resume's cleanup, called again, leaves a later resume's hold on the name", async () => {
    const framework = await boot();
    framework.start();
    membrane.script('job-c', say('job-c done'));
    const made = await framework.createEphemeralAgent(
      { name: 'job-c', model: 'test-model', systemPrompt: 'Do the task.' },
      workerSpec('job-c', { spawnedBy: 'mira' }),
    );
    made.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await framework.runEphemeralToCompletion(made.agent, made.contextManager);
    const config = { model: 'test-model', systemPrompt: 'Do the task.' };
    const first = await framework.resumeAgent('job-c', config);
    first.cleanup();
    const second = await framework.resumeAgent('job-c', config);
    first.cleanup();
    await assert.rejects(framework.resumeAgent('job-c', config), /"job-c" is already being resumed/);
    second.cleanup();
  });

  it("an ended spawned agent's agent-ended trace names its spawner", async () => {
    const framework = await boot();
    const traces: TraceEvent[] = [];
    framework.onTrace((event) => traces.push(event));
    framework.start();
    const worker = await startBlocked(framework, 'worker-s', 'g-s', workerSpec('worker-s', { spawnedBy: 'oren' }));
    framework.stopAgent('worker-s', { by: 'mira' });
    await worker.settled;
    const ended = traces.find((t) => t.type === 'dendrite:agent-ended' && t.agentName === 'worker-s') as { spawnedBy?: string } | undefined;
    assert.equal(ended?.spawnedBy, 'oren');
    gates.release('g-s');
  });
});

describe('Dendrite restart', () => {
  let tempDir: string;
  let store: JsStore;
  let membrane: RoutedMembrane;
  let frameworks: AgentFramework[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dendrite-restart-'));
    store = JsStore.openOrCreate({ path: join(tempDir, 'store.chronicle') });
    membrane = new RoutedMembrane();
    frameworks = [];
  });

  afterEach(async () => {
    for (const framework of frameworks.reverse()) {
      try { await framework.stop(); } catch { /* already stopped */ }
    }
    try { store.close(); } catch { /* already closed */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Each call is a new process as far as the framework can tell: a fresh
   * AgentFramework over the same store, with the previous one simply
   * abandoned mid-flight (never stopped — that is the crash).
   */
  async function process(gates: GateModule): Promise<AgentFramework> {
    const framework = await AgentFramework.create({
      store,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'mira', model: 'test-model', systemPrompt: 'You are mira.' }],
      modules: [gates],
      syncIntervalMs: 0,
    });
    frameworks.push(framework);
    return framework;
  }

  async function blockedJob(framework: AgentFramework, gates: GateModule, name: string, spec: Omit<AgentSpec, 'name'>) {
    membrane.script(name, waitCall(name), say(`${name} done`));
    const { agent, contextManager } = await framework.createEphemeralAgent(
      { name, model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all' },
      spec,
    );
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    framework.runEphemeralToCompletion(agent, contextManager).catch(() => { /* abandoned */ });
    await until(() => gates.entered.has(name), `${name} to block`);
  }

  it('a graceful stop leaves bounded work for the next boot to report as interrupted', async () => {
    // First live run, finding D: a reader fork cut off by SIGTERM ended
    // silently. stop() must not end work it cut off as if it had finished
    // or failed; the next boot reports it, and a host whose trace sink
    // attaches after create() (every host) still sees the trace.
    const gates1 = new GateModule();
    const first = await process(gates1);
    first.start();
    await blockedJob(first, gates1, 'job', workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    await first.stop();
    assert.equal(first.getAgentRecord('job')?.ended, undefined, 'stop does not end work it cut off');

    const second = await process(new GateModule());
    const traces: Array<{ type: string; agentName?: string; reason?: string }> = [];
    second.onTrace((event) => traces.push(event as never), { replay: true });
    assert.equal(second.getAgentRecord('job')?.ended?.reason, 'host-restart');
    const notices = textsIn(second, 'mira').filter((m) => m.metadata.kind === 'agent-lifecycle');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /the host restarted while "job" was still working for you/);
    assert.ok(
      traces.some((t) => t.type === 'dendrite:agent-ended' && t.agentName === 'job' && t.reason === 'host-restart'),
      'the create()-time trace reaches a listener attached afterwards',
    );
  });

  it('tells a result recipient about bounded work a restart interrupted', async () => {
    const gates1 = new GateModule();
    const first = await process(gates1);
    first.start();
    await blockedJob(first, gates1, 'job', workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    // A job whose result goes back as a tool result has an awaiting caller, not a mailbox.
    await blockedJob(first, gates1, 'inline', workerSpec('inline', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'tool-result' } }));
    assert.equal(first.getAgentRecord('mira')!.incarnation, 1);

    const second = await process(new GateModule());
    assert.equal(second.getAgentRecord('mira')!.incarnation, 2, 'the same identity, a new incarnation');
    assert.deepEqual(second.listAgents().map((r) => r.name), ['mira']);
    assert.equal(second.getAgentRecord('job')?.ended?.reason, 'host-restart');
    assert.equal(second.getAgentRecord('inline')?.ended?.reason, 'host-restart');

    const notices = textsIn(second, 'mira').filter((m) => m.metadata.kind === 'agent-lifecycle');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /the host restarted while "job" was still working for you\. It was ended without a result\./);
    assert.deepEqual((notices[0]!.metadata.dendrite as { agents: string[] }).agents, ['job']);

    // A third boot has nothing left to say.
    const third = await process(new GateModule());
    assert.equal(third.getAgentRecord('mira')!.incarnation, 3);
    assert.equal(textsIn(third, 'mira').filter((m) => m.metadata.kind === 'agent-lifecycle').length, 1);
  });

  it("a job a restart interrupted is ended in a trace that names its spawner", async () => {
    const gates1 = new GateModule();
    const first = await process(gates1);
    first.start();
    await blockedJob(first, gates1, 'job-t', workerSpec('job-t', { spawnedBy: 'mira' }));
    const second = await process(new GateModule());
    const traces: TraceEvent[] = [];
    second.onTrace((event) => traces.push(event), { replay: true });
    const ended = traces.find((t) => t.type === 'dendrite:agent-ended' && t.agentName === 'job-t') as { reason?: string; spawnedBy?: string } | undefined;
    assert.deepEqual([ended?.reason, ended?.spawnedBy], ['host-restart', 'mira']);
  });

  it('a job interrupted by a restart resumes on its own context and still returns its result', async () => {
    const gates1 = new GateModule();
    const first = await process(gates1);
    first.start();
    await blockedJob(first, gates1, 'job', workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));

    const second = await process(new GateModule());
    second.start();
    assert.equal(second.getAgentRecord('job')?.ended?.reason, 'host-restart');

    membrane.script('job', say('finished after the restart'));
    const resumed = await second.resumeAgent('job', {
      model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
    });
    assert.deepEqual(
      resumed.contextManager.getAllMessages().map((m) => (m.content[0] as { text: string }).text),
      ['Go.'],
      'the round that was in flight was never stored; it starts from the task',
    );
    const result = await second.runEphemeralToCompletion(resumed.agent, resumed.contextManager);
    assert.equal(result.speech, 'finished after the restart');

    const record = second.getAgentRecord('job')!;
    assert.equal(record.incarnation, 2);
    assert.equal(record.relationships.spawnedBy, 'mira');
    const delivery = second.deliverAgentResult('job', [{ type: 'text', text: result.speech }]);
    assert.equal(delivery.delivered, true);
    await second.runUntilIdle();
    const landed = textsIn(second, 'mira').filter((m) => m.metadata.kind === 'agent-result');
    assert.deepEqual(landed.map((m) => [m.participant, m.text]), [['job', 'finished after the restart']]);
    assert.deepEqual((landed[0]!.metadata.dendrite as { from: unknown }).from, { agent: 'job', incarnation: 2 });
  });

  it('delivers a result held across a crash exactly once', async () => {
    const gates1 = new GateModule();
    const first = await process(gates1);
    first.start();
    await blockedJob(first, gates1, 'job', workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));

    // mira is mid-turn when the result arrives, so its message is deferred
    // in memory — exactly the window in which a crash would lose it.
    membrane.script('mira', waitCall('mira-busy'), say('mira done'));
    (first as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'mira', reason: 'test', source: 'test', timestamp: Date.now(),
    });
    await until(() => gates1.entered.has('mira-busy'), 'mira to be mid-turn');

    const traces: TraceEvent[] = [];
    first.onTrace((event) => traces.push(event));
    const delivery = first.deliverAgentResult('job', [{ type: 'text', text: 'survives the crash' }]);
    assert.equal(delivery.delivered, true, 'queued for mira');
    assert.equal(first.listHeldMail().length, 1, 'still held: the message has not entered the store');
    // Published is not delivered: queued for a boundary is a deferral.
    assert.deepEqual(
      traces.filter((t) => t.type.startsWith('dendrite:mail-')).map((t) => t.type),
      ['dendrite:mail-deferred'],
    );
    assert.equal(
      textsIn(first, 'mira').some((m) => m.metadata.kind === 'agent-result'),
      false,
    );

    const second = await process(new GateModule());
    const results = (framework: AgentFramework) =>
      textsIn(framework, 'mira').filter((m) => m.metadata.kind === 'agent-result');
    assert.deepEqual(results(second).map((m) => [m.participant, m.text]), [['job', 'survives the crash']]);
    assert.deepEqual(
      (results(second)[0]!.metadata.dendrite as { from: unknown }).from,
      { agent: 'job', incarnation: 1 },
      'attributed to the incarnation that produced it',
    );
    assert.deepEqual(second.listHeldMail(), []);
    // The job handed its result over before the crash: no "ended without a result" notice.
    assert.equal(textsIn(second, 'mira').some((m) => m.metadata.kind === 'agent-lifecycle'), false);

    const third = await process(new GateModule());
    assert.equal(results(third).length, 1, 'never delivered a second time');
  });
});
