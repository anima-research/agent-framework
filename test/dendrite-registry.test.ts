/**
 * Dendrite agent registry — the bookkeeping rules, without a framework:
 * roles, spec validation, ending (cascade vs orphan), reparenting, held
 * mail, and restart behaviour by lifetime.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRegistry,
  AgentSpecError,
  conversationForkSpec,
  residentSpec,
  subconsciousSpec,
  taskForkSpec,
  workerSpec,
} from '../src/index.js';
import type { AgentRecord, RegistrySnapshot } from '../src/index.js';

/** A registry with a persisted side: the last snapshot and the ended log. */
function persisted() {
  const state: { snapshot: RegistrySnapshot | null; ended: AgentRecord[]; writes: number } = {
    snapshot: null,
    ended: [],
    writes: 0,
  };
  let clock = 1_000;
  const make = () =>
    new AgentRegistry({
      now: () => ++clock,
      persist: (snapshot) => {
        state.snapshot = JSON.parse(JSON.stringify(snapshot));
        state.writes++;
      },
      appendEnded: (record) => {
        state.ended.push(JSON.parse(JSON.stringify(record)));
      },
    });
  return { state, make };
}

describe('AgentRegistry roles', () => {
  it('answers each selection question from declared roles, not kinds', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(subconsciousSpec('Subconscious', 'mira'));
    registry.register(conversationForkSpec('mira-chan-1', { template: 'mira', homeChannel: { serverId: 's1', channelId: 'c1' }, idleTtlMs: 60_000 }));
    registry.register(workerSpec('worker-1', { spawnedBy: 'mira' }));

    assert.equal(registry.primary(), 'mira');
    assert.deepEqual(registry.untargetedRecipients(), ['mira', 'oren']);
    // The gate is host-wide: a channel-bound fork is woken by its own
    // channel's debounced traffic without being a broadcast recipient.
    assert.deepEqual(registry.gateRecipients(), ['mira', 'oren', 'mira-chan-1']);
    assert.deepEqual(registry.sharedSlotReaders(), ['mira', 'oren', 'Subconscious']);
    assert.equal(registry.ownsProviderScheduling('mira'), true);
    assert.equal(registry.ownsProviderScheduling('Subconscious'), true);
    assert.equal(registry.ownsProviderScheduling('mira-chan-1'), false);
    assert.equal(registry.ownsProviderScheduling('worker-1'), false);
    assert.equal(registry.ownsProviderScheduling('nobody'), false);
    assert.deepEqual(registry.homeChannel('mira-chan-1'), { serverId: 's1', channelId: 'c1' });
    assert.equal(registry.homeChannel('mira'), undefined);
  });

  it('a spec outside every preset is selected by its roles alone', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register({
      name: 'night-watch',
      kind: 'watcher',
      roles: { defaultDelivery: false, receivesUntargeted: true, receivesGateWakes: false, ownsProviderScheduling: false },
      lifetime: { kind: 'persistent' },
    });
    assert.deepEqual(registry.untargetedRecipients(), ['mira', 'night-watch']);
    assert.deepEqual(registry.gateRecipients(), ['mira']);
  });
});

describe('AgentRegistry spec validation', () => {
  const base = () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    return registry;
  };

  it('refuses a second default-delivery owner', () => {
    const registry = base();
    assert.throws(() => registry.register(residentSpec('oren', { primary: true })), /default delivery already belongs to "mira"/);
    assert.equal(registry.has('oren'), false);
  });

  it('refuses a task that could run forever', () => {
    const registry = base();
    assert.throws(
      () => registry.register({ ...workerSpec('w'), lifetime: { kind: 'task' } }),
      (error: unknown) => error instanceof AgentSpecError && /every task agent must end/.test(error.message),
    );
    assert.throws(
      () => registry.register({ ...workerSpec('w'), lifetime: { kind: 'task', deadlineMs: 0 } }),
      AgentSpecError,
    );
    // Either bound is enough.
    registry.register({ ...workerSpec('w1'), lifetime: { kind: 'task', deadlineMs: 5_000 } });
    registry.register({ ...workerSpec('w2'), lifetime: { kind: 'task', idleTimeoutMs: 5_000 } });
  });

  it('refuses an idle lifetime with no TTL', () => {
    const registry = base();
    assert.throws(
      () => registry.register(conversationForkSpec('f', { template: 'mira', homeChannel: { serverId: 's1', channelId: 'c' }, idleTtlMs: 0 })),
      /positive idleTtlMs/,
    );
  });

  it('refuses relationships that name nobody', () => {
    const registry = base();
    assert.throws(() => registry.register(workerSpec('w', { spawnedBy: 'ghost' })), /spawner "ghost" is not a registered agent/);
    assert.throws(
      () => registry.register(workerSpec('w', { resultTo: { to: 'ghost', as: 'message' } })),
      /result recipient "ghost"/,
    );
    // Spawned by mira, so only the context source names nobody.
    assert.throws(
      () => registry.register(taskForkSpec('w', { parent: 'ghost', spawnedBy: 'mira' })),
      /context source "ghost" is not a registered agent/,
    );
    assert.throws(
      () => registry.register({ ...workerSpec('w'), observes: [{ agent: 'ghost' }] }),
      /observed agent "ghost"/,
    );
    assert.throws(() => registry.register({ ...workerSpec('w'), onParentEnd: 'end' }), /needs a spawnedBy/);
    assert.throws(() => registry.register(residentSpec('mira', { primary: false })), /already registered/);
    assert.deepEqual(registry.list().map((r) => r.name), ['mira']);
  });
});

describe('AgentRegistry ending and orphans', () => {
  it('ends attention tenants with their parent and orphans task work', () => {
    const { state, make } = persisted();
    const registry = make();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(taskForkSpec('fork', { parent: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    // Two things spawned by the fork: a reader that serves it, and a job.
    registry.register({ ...workerSpec('reader', { spawnedBy: 'fork' }), onParentEnd: 'end' });
    registry.register(workerSpec('job', { spawnedBy: 'fork', resultTo: { to: 'fork', as: 'message' } }));
    // The reader has a tenant of its own.
    registry.register({ ...workerSpec('reader-aide', { spawnedBy: 'reader' }), onParentEnd: 'end' });

    const outcome = registry.end('fork', 'stopped', 'operator')!;

    assert.equal(outcome.ended.name, 'fork');
    assert.deepEqual(outcome.ended.ended, { at: outcome.ended.ended!.at, reason: 'stopped', by: 'operator' });
    // Deepest first, so a caller tearing them down never removes a parent before its tenant.
    assert.deepEqual(outcome.cascaded.map((r) => r.name), ['reader-aide', 'reader']);
    assert.ok(outcome.cascaded.every((r) => r.ended?.reason === 'parent-ended'));
    assert.deepEqual(outcome.orphaned.map((o) => o.record.name), ['job']);
    // Offered to the nearest live ancestor of the agent that ended.
    assert.deepEqual(outcome.orphaned[0]!.candidates, ['mira']);

    const job = registry.get('job')!;
    assert.equal(job.orphaned?.formerParent.agent, 'fork');
    assert.equal(job.orphaned?.reason, 'stopped');
    assert.deepEqual(job.orphaned?.candidates, ['mira']);
    // The spawn edge is history; it is no longer a child of anyone.
    assert.deepEqual(registry.children('fork'), []);
    // Its result route is left pointing at the ended agent: delivery holds, not drops.
    assert.equal(job.relationships.resultTo?.to, 'fork');

    assert.deepEqual(registry.list().map((r) => r.name), ['mira', 'job']);
    assert.equal(registry.inspect('reader')?.ended?.reason, 'parent-ended');
    assert.deepEqual(state.ended.map((r) => r.name), ['fork', 'reader', 'reader-aide']);
    assert.ok(!state.snapshot!.records.some((r) => r.ended), 'ended history stays out of the snapshot');
    assert.equal(registry.end('fork', 'stopped'), null, 'ending twice is a no-op');
  });

  it('offers an orphan to the nearest LIVE ancestor, then the primary', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(workerSpec('a', { spawnedBy: 'oren' }));
    registry.register(workerSpec('b', { spawnedBy: 'a' }));
    registry.register(workerSpec('c', { spawnedBy: 'b' }));

    const outcome = registry.end('b', 'failed')!;
    assert.deepEqual(outcome.orphaned[0]!.candidates, ['a', 'oren', 'mira']);
  });

  it('reparenting clears orphan state, reroutes a dead result route and returns held mail', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('boss', { spawnedBy: 'mira' }));
    registry.register(workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'boss', as: 'message' } }));
    registry.end('boss', 'stopped');

    const mail = registry.holdMail({
      kind: 'result',
      from: registry.ref('job'),
      to: 'boss',
      content: [{ type: 'text', text: 'done' }],
      heldBecause: 'recipient-gone',
    });
    assert.deepEqual(registry.listMail({ to: 'boss' }).map((m) => m.id), [mail.id]);

    const { record, deliverable } = registry.reparent('job', 'mira');
    assert.equal(record.orphaned, undefined);
    assert.equal(record.relationships.spawnedBy, 'mira');
    assert.equal(record.relationships.resultTo?.to, 'mira');
    assert.deepEqual(deliverable.map((m) => [m.id, m.to]), [[mail.id, 'mira']]);
    assert.deepEqual(registry.children('mira').map((r) => r.name), ['job']);

    registry.releaseMail(mail.id);
    assert.deepEqual(registry.listMail(), []);
  });

  it('a live result route survives reparenting untouched', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(residentSpec('oren', { primary: false }));
    registry.register(workerSpec('boss', { spawnedBy: 'mira' }));
    registry.register(workerSpec('job', { spawnedBy: 'boss', resultTo: { to: 'oren', as: 'message' } }));
    registry.end('boss', 'stopped');
    const { record, deliverable } = registry.reparent('job', 'mira');
    assert.equal(record.relationships.resultTo?.to, 'oren', 'spawning is not the result route');
    assert.deepEqual(deliverable, []);
  });

  it('refuses a reparenting that would form a cycle', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('a', { spawnedBy: 'mira' }));
    registry.register(workerSpec('b', { spawnedBy: 'a' }));
    assert.throws(() => registry.reparent('a', 'b'), /would form a cycle/);
    assert.throws(() => registry.reparent('a', 'a'), /its own parent/);
    assert.throws(() => registry.reparent('a', 'ghost'), /not a registered agent/);
  });
});

describe('AgentRegistry restart behaviour follows lifetime', () => {
  it('restores a persistent agent as a new incarnation and ends interrupted bounded work', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(subconsciousSpec('Subconscious', 'mira'));
    first.register(workerSpec('job', { spawnedBy: 'mira', resultTo: { to: 'mira', as: 'message' } }));
    first.register(conversationForkSpec('mira-c1', { template: 'mira', homeChannel: { serverId: 's1', channelId: 'c1' }, idleTtlMs: 1_000 }));
    const held = first.holdMail({
      kind: 'result',
      from: first.ref('job'),
      to: 'mira',
      content: [{ type: 'text', text: 'almost lost' }],
    });
    assert.equal(first.get('mira')!.incarnation, 1);

    // The process dies here. A new one loads what was persisted.
    const second = make();
    const { interrupted } = second.restore(state.snapshot, state.ended);
    assert.deepEqual(interrupted.map((r) => r.name).sort(), ['job', 'mira-c1']);
    assert.ok(interrupted.every((r) => r.ended?.reason === 'host-restart'));
    assert.equal(second.has('mira'), false, 'a persistent agent is not live until configuration declares it');

    second.register(residentSpec('mira', { primary: true }));
    second.register(subconsciousSpec('Subconscious', 'mira'));
    assert.equal(second.get('mira')!.incarnation, 2);
    assert.equal(second.get('Subconscious')!.incarnation, 2);
    assert.deepEqual(second.reconcile().unconfigured, []);

    assert.equal(second.inspect('job')?.ended?.reason, 'host-restart');
    // The result is still held, attributed to the incarnation that produced it.
    assert.deepEqual(second.listMail().map((m) => [m.id, m.from.agent, m.from.incarnation, m.to]), [
      [held.id, 'job', 1, 'mira'],
    ]);
    // Until the host has told the recipients, the interrupted records stay in
    // the snapshot as they were and their ends aren't written, so a crash here
    // owes the same notices at the next boot.
    assert.equal(state.ended.length, 0, 'no end is written before the recipients are told');
    assert.deepEqual(state.snapshot!.records.filter((r) => !r.ended).map((r) => r.name).sort(), ['Subconscious', 'job', 'mira', 'mira-c1']);
    second.settleInterrupted();
    assert.deepEqual(state.ended.map((r) => r.name).sort(), ['job', 'mira-c1']);
    assert.deepEqual(state.snapshot!.records.map((r) => r.name).sort(), ['Subconscious', 'mira'], 'and the snapshot no longer lists them');
  });

  it('settles every interrupted end, more than memory keeps, and keeps one whose write fails pending', () => {
    const state = { snapshot: null as RegistrySnapshot | null, ended: [] as AgentRecord[] };
    let failFor: string | undefined;
    const failed: string[] = [];
    let clock = 1_000;
    const make = () => new AgentRegistry({
      now: () => ++clock,
      endedRetention: 2,
      persist: (snapshot) => { state.snapshot = JSON.parse(JSON.stringify(snapshot)); },
      appendEnded: (record) => {
        if (record.name === failFor) throw new Error('EIO: the ended log');
        state.ended.push(JSON.parse(JSON.stringify(record)));
      },
      onRecordWriteFailed: (what) => { failed.push(what); },
    });
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    for (const name of ['j1', 'j2', 'j3', 'j4']) first.register(workerSpec(name, { spawnedBy: 'mira' }));
    // The process dies with four jobs live; memory keeps two ended records.
    const second = make();
    assert.equal(second.restore(state.snapshot, state.ended).interrupted.length, 4);
    assert.deepEqual(second.endedHistory(), [], 'an end not yet written is no history a put-back could write');
    failFor = 'j3';
    second.settleInterrupted();
    assert.deepEqual(state.ended.map((r) => r.name), ['j1', 'j2', 'j4'], 'every end is written but the one that failed');
    assert.deepEqual(failed, ['the end of j3']);
    const jobs = () => state.snapshot!.records.filter((r) => r.name.startsWith('j')).map((r) => r.name);
    assert.deepEqual(jobs(), ['j3'], 'which stays in the snapshot');
    assert.equal(second.inspect('j3')?.ended?.reason, 'host-restart');
    failFor = undefined;
    second.settleInterrupted();
    assert.deepEqual(state.ended.map((r) => r.name), ['j1', 'j2', 'j4', 'j3'], 'and the next settlement writes it');
    assert.deepEqual(jobs(), []);
  });

  it('a persistent record whose end the ended history holds still waits to be re-declared', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(residentSpec('oren', { primary: false }));
    // A stop of oren appended its end, then failed and was put back: the
    // snapshot lists oren live, and the ended history holds its end.
    const snapshot = JSON.parse(JSON.stringify(state.snapshot)) as RegistrySnapshot;
    const oren = snapshot.records.find((r) => r.name === 'oren')!;
    const second = make();
    second.restore(snapshot, [{ ...oren, ended: { at: 5, reason: 'stopped', by: 'mira' } }]);
    second.register(residentSpec('mira', { primary: true }));
    assert.deepEqual(second.reconcile().unconfigured.map((o) => o.ended.name), ['oren'], 'oren was awaiting re-declaration');
  });

  it('inspects the newest of two pending incarnations once memory has let both go', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(workerSpec('j', { spawnedBy: 'mira' }));
    first.register(workerSpec('k', { spawnedBy: 'mira' }));
    const snapshot = JSON.parse(JSON.stringify(state.snapshot)) as RegistrySnapshot;
    const j = snapshot.records.find((r) => r.name === 'j')!;
    snapshot.records.splice(snapshot.records.indexOf(j) + 1, 0, { ...j, incarnation: 2 });
    snapshot.incarnations.j = 2;
    const second = new AgentRegistry({ endedRetention: 1, persist: () => {}, appendEnded: () => {} });
    second.restore(snapshot, []);
    assert.equal(second.inspect('j')?.incarnation, 2);
  });

  it('settles two interrupted incarnations of one name as two ends', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(workerSpec('j', { spawnedBy: 'mira' }));
    const snapshot = JSON.parse(JSON.stringify(state.snapshot)) as RegistrySnapshot;
    const older = snapshot.records.find((r) => r.name === 'j')!;
    snapshot.records.push({ ...older, incarnation: 2 });
    snapshot.incarnations.j = 2;
    const second = make();
    assert.equal(second.restore(snapshot, []).interrupted.length, 2);
    second.settleInterrupted();
    assert.deepEqual(state.ended.filter((r) => r.name === 'j').map((r) => r.incarnation).sort(), [1, 2]);
  });

  it('restores a snapshot whose fork keeps its home as a bare id, as one written before homes carried their server', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(conversationForkSpec('mira-c1', { template: 'mira', homeChannel: { serverId: 's1', channelId: 'c1' }, idleTtlMs: 1_000 }));
    // The record as the code before this one wrote it: the id alone.
    const snapshot = JSON.parse(JSON.stringify(state.snapshot)) as { records: Array<{ name: string; homeChannel?: unknown }> };
    snapshot.records.find((r) => r.name === 'mira-c1')!.homeChannel = 'c1';

    const second = make();
    const { interrupted } = second.restore(snapshot as never, state.ended);
    assert.deepEqual(interrupted.map((r) => [r.name, r.ended?.reason, r.homeChannel]), [['mira-c1', 'host-restart', 'c1']],
      'the fork ends at the restart, as every fork does, its home as it was written');
    assert.equal(second.homeChannel('mira-c1'), undefined, 'and no live agent has that home');
  });

  it('ends a persistent agent the new configuration no longer declares', () => {
    const { state, make } = persisted();
    const first = make();
    first.register(residentSpec('mira', { primary: true }));
    first.register(residentSpec('oren', { primary: false }));

    const second = make();
    second.restore(state.snapshot, state.ended);
    second.register(residentSpec('mira', { primary: true }));
    const { unconfigured } = second.reconcile();
    assert.deepEqual(unconfigured.map((o) => [o.ended.name, o.ended.ended?.reason]), [['oren', 'not-configured']]);
    assert.equal(second.inspect('oren')?.ended?.reason, 'not-configured');
    assert.deepEqual(second.list().map((r) => r.name), ['mira']);
  });

  it('a re-used name is a new incarnation while the old record is still referable', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('job'));
    registry.end('job', 'completed');
    assert.equal(registry.register(workerSpec('job')).incarnation, 2);
    assert.equal(registry.list({ includeEnded: true }).filter((r) => r.name === 'job').length, 2);
  });

  it('names the agent whose own context a namespace holds; a shared fork holds none', () => {
    const registry = new AgentRegistry();
    registry.register(residentSpec('mira', { primary: true }));
    registry.register(workerSpec('w', { spawnedBy: 'mira', namespace: 'jobs/w' }));
    registry.register({ ...workerSpec('fork', { spawnedBy: 'mira' }), namespace: 'jobs/p', inherit: { from: 'mira', mode: 'shared' } });
    assert.equal(registry.namespaceHolder('agents/mira', 'x'), 'mira');
    assert.equal(registry.namespaceHolder('jobs/w', 'x'), 'w');
    assert.equal(registry.namespaceHolder('jobs/w', 'w'), undefined, 'not its own');
    assert.equal(registry.namespaceHolder('jobs/p', 'x'), undefined, 'a shared fork owns a branch, not the namespace');
    registry.end('w', 'stopped', 'mira');
    assert.equal(registry.namespaceHolder('jobs/w', 'x'), 'w', 'an ended agent\'s');
  });

  it('refuses a version-1 snapshot without its map of incarnations', () => {
    assert.throws(
      () => new AgentRegistry().restore({ version: 1, records: [], mail: [] } as unknown as RegistrySnapshot),
      /reads as version 1 but has no map of incarnations; nothing was restored/,
    );
  });

  it('a put-back that throws is reported, and the change\'s own error is what the caller hears', () => {
    const said: string[] = [];
    const registry = new AgentRegistry({
      persist: () => { throw new Error('EIO: the change'); },
      onRollback: () => { throw new Error('EIO: the put-back'); },
      onRecordWriteFailed: (what) => { said.push(what); },
    });
    assert.throws(() => registry.register(residentSpec('mira', { primary: true })), /EIO: the change/);
    assert.equal(registry.has('mira'), false, 'and the change is put back');
    assert.deepEqual(said, ['the put-back of a change that failed']);
  });

  it('tolerates a missing snapshot, and refuses one in a version it does not read', () => {
    const registry = new AgentRegistry();
    assert.deepEqual(registry.restore(null), { interrupted: [] });
    // Taken as empty, a registry in another version would be overwritten by the
    // first registration, with the results it holds (nissa's #546 finding 1).
    assert.throws(() => registry.restore({ version: 9 } as unknown as RegistrySnapshot), /reads as version 9, which this code doesn't read/);
    registry.register(residentSpec('mira', { primary: true }));
    assert.equal(registry.get('mira')!.incarnation, 1);
  });
});
