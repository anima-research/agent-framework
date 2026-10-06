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
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import {
  AgentFramework,
  AgentSpecError,
  AgentStoppedError,
  taskForkSpec,
  workerSpec,
} from '../src/index.js';
import type {
  AgentSpec,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEvent,
} from '../src/index.js';
import { createMockResponse, MockYieldingStream } from './helpers/mock-membrane.js';

/** A membrane that scripts each agent separately: one response list per activation. */
class RoutedMembrane {
  readonly calls: NormalizedRequest[] = [];
  private readonly scripts = new Map<string, NormalizedResponse[][]>();

  script(agent: string, ...activation: NormalizedResponse[]): void {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), activation]);
  }

  callsFor(agent: string): NormalizedRequest[] {
    return this.calls.filter((call) => call.assistantParticipant === agent);
  }

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const queue = this.scripts.get(request.assistantParticipant ?? '') ?? [];
    const activation = queue.shift() ?? [createMockResponse([{ type: 'text', text: 'ok' }])];
    return new MockYieldingStream(activation);
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    return createMockResponse([{ type: 'text', text: 'ok' }]);
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

/** `test--wait` blocks its caller until the test releases the named gate. */
class GateModule implements Module {
  readonly name = 'test';
  readonly entered = new Set<string>();
  private readonly gates = new Map<string, () => void>();
  broadcastOn: string | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  // Gates still closed at shutdown stay closed: releasing them would hand a
  // tool result to a framework that has already stopped.
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'wait',
      description: 'Block until released',
      inputSchema: { type: 'object', properties: { gate: { type: 'string' } } },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const gate = String((call.input as { gate?: string }).gate ?? 'default');
    this.entered.add(gate);
    await new Promise<void>((resolve) => this.gates.set(gate, resolve));
    return { success: true, data: { released: gate } };
  }

  release(gate: string): void {
    this.gates.get(gate)?.();
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (this.broadcastOn && (event as { type: string }).type === this.broadcastOn) {
      return { requestInference: true };
    }
    return {};
  }
}

const waitCall = (gate: string) =>
  createMockResponse([{ type: 'tool_use', id: `call-${gate}`, name: 'test--wait', input: { gate } }], 'tool_use');
const say = (text: string) => createMockResponse([{ type: 'text', text }]);

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    // The job made exactly its own two rounds' worth of requests: one stream.
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
    const worker = await startBlocked(
      framework,
      'worker-1',
      'g1',
      { ...workerSpec('worker-1'), lifetime: { kind: 'task', deadlineMs: 60 } },
    );
    const result = await worker.settled;
    assert.ok(!result.ok && result.error instanceof AgentStoppedError);
    assert.equal(framework.getAgentRecord('worker-1')?.ended?.reason, 'deadline');
    assert.equal(framework.getAgent('worker-1'), null);
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
    assert.deepEqual(landed[0]!.metadata.dendrite, {
      mailId: delivery.mailId,
      kind: 'result',
      from: { agent: 'fork-1', incarnation: 1 },
      causedBy: ['task-7'],
    });
    assert.deepEqual(framework.listHeldMail(), [], 'a delivered result is no longer held');
    // (Co-residents share one message slot today, so mira can read it too;
    // what the route decides is who it is addressed to and who is woken.)
    assert.equal(membrane.callsFor('mira').length, 0, 'the primary is not woken for a result routed elsewhere');
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

    const delivery = first.deliverAgentResult('job', [{ type: 'text', text: 'survives the crash' }]);
    assert.equal(delivery.delivered, true, 'queued for mira');
    assert.equal(first.listHeldMail().length, 1, 'still held: the message has not entered the store');
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
