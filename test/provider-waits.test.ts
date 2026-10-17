/**
 * Provider waits: a provider's stated retry-after is a lower bound on the next
 * call to that model, for that agent, across restarts and branch switches.
 *
 * Unit cases drive ProviderWaits on a real Chronicle store; framework cases
 * drive a real AgentFramework whose membrane answers with classified errors
 * carrying retryAfterMs.
 */
import { describe, it, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, ApiServer, ProviderWaitNotSleptError } from '../src/index.js';
import { ProviderWaits, waitDeadline, PROVIDER_WAIT_RECORD_TYPE } from '../src/provider-waits.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

function withStoreDir<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'provider-waits-'));
  return Promise.resolve(fn(join(dir, 'store'))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A clock tests can move. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const quiet = { log: () => {} };

describe('waitDeadline', () => {
  it('is the absolute instant of a usable wait', () => {
    assert.equal(waitDeadline(1_500, 1_000), 2_500);
    assert.equal(waitDeadline(0, 1_000), 1_000);
    assert.equal(waitDeadline(0.4, 1_000), 1_001, 'rounded up, never down');
  });

  it('is null (held until released) for a wait it cannot represent', () => {
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, '60', undefined]) {
      assert.equal(waitDeadline(unusable, 1_000), null, String(unusable));
    }
    assert.equal(waitDeadline(8.64e15 - 1_000, 1_000), 8.64e15, 'the last representable instant');
    assert.equal(waitDeadline(8.64e15, 1_000), null, 'one past it');
  });

  it('is the moment it was stated for a negative wait: already over, never held (PR #251 review)', () => {
    // -Infinity too: as negative as any, so over, never held.
    for (const negative of [-1, -1_000, -0.4, -0, -1e20, -Number.MAX_VALUE, Number.NEGATIVE_INFINITY]) {
      assert.equal(waitDeadline(negative, 1_000), 1_000, String(negative));
    }
  });
});

describe('ProviderWaits', () => {
  it('binds (agent, model) until the wait passes', () => withStoreDir((path) => {
    const store = JsStore.openOrCreate({ path });
    try {
      const time = clock();
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-model', 60_000, 'zz 429');
      assert.equal(waits.active('ada', 'zz-model')?.until, time.now() + 60_000);
      assert.equal(waits.active('ada', 'zz-other'), undefined, 'another model is not bound');
      assert.equal(waits.active('bo', 'zz-model'), undefined, 'another agent is not bound');
      time.advance(59_999);
      assert.ok(waits.active('ada', 'zz-model'));
      time.advance(1);
      assert.equal(waits.active('ada', 'zz-model'), undefined);
    } finally { store.close(); }
  }));

  it('never lets a later, shorter wait shorten an outstanding one; indefinite stays indefinite', () => withStoreDir((path) => {
    const store = JsStore.openOrCreate({ path });
    try {
      const time = clock();
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      const long = waits.set('ada', 'zz-model', 600_000, 'long');
      assert.equal(long.changed, true);
      const short = waits.set('ada', 'zz-model', 10_000, 'short');
      assert.equal(short.changed, false);
      assert.equal(short.wait.until, time.now() + 600_000);
      assert.equal(short.wait.reason, 'long');
      const longer = waits.set('ada', 'zz-model', 900_000, 'longer');
      assert.equal(longer.changed, true);
      assert.equal(waits.active('ada', 'zz-model')?.until, time.now() + 900_000);

      waits.set('ada', 'zz-model', Number.NaN, 'unusable');
      assert.equal(waits.active('ada', 'zz-model')?.until, null);
      waits.set('ada', 'zz-model', 5_000, 'finite after indefinite');
      assert.equal(waits.active('ada', 'zz-model')?.until, null);
      time.advance(10 * 365 * 24 * 3_600_000);
      assert.equal(waits.active('ada', 'zz-model')?.until, null, 'an indefinite wait does not pass');
    } finally { store.close(); }
  }));

  it('survives a reopen, a checkpoint and a branch switch, with the same lower bound', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-model', 600_000, 'long');
      waits.set('ada', 'zz-forever', Number.POSITIVE_INFINITY, 'unusable');
      // Enough entries to force a checkpoint, then shorter hints after it.
      for (let i = 0; i < 70; i++) waits.set(`agent-${i}`, 'zz-model', 1_000 + i, `hint ${i}`);
      waits.set('ada', 'zz-model', 10_000, 'short, after the checkpoint');
      waits.set('ada', 'zz-forever', 10_000, 'finite, after the checkpoint');
      assert.ok(store.getRecordIdsByType(`${PROVIDER_WAIT_RECORD_TYPE}/checkpoint`).length >= 1, 'a checkpoint was written');

      // A rollback-shaped branch switch: back before every wait was recorded.
      const main = store.currentBranch().name;
      store.createBranchAt('rollback', main, 0);
      store.switchBranch('rollback');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(store.currentBranch().name, 'rollback');
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-model')?.until, time.now() + 600_000, 'the longer wait still binds');
      assert.equal(reopened.active('ada', 'zz-model')?.reason, 'long');
      assert.equal(reopened.active('ada', 'zz-forever')?.until, null, 'the indefinite wait still binds');
      reopened.set('ada', 'zz-model', 20_000, 'shorter again');
      assert.equal(reopened.active('ada', 'zz-model')?.until, time.now() + 600_000);
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('a recorded release outlives a reopen; releasing one model leaves the others', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-a', 600_000, 'a');
      waits.set('ada', 'zz-b', 600_000, 'b');
      waits.set('bo', 'zz-a', 600_000, 'bo');
      assert.deepEqual(waits.release('ada', 'zz-a', 'operator').map((r) => r.wait.model), ['zz-a']);
      assert.equal(waits.active('ada', 'zz-a'), undefined);
      assert.ok(waits.active('ada', 'zz-b'));
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-a'), undefined, 'released stays released');
      assert.ok(reopened.active('ada', 'zz-b'));
      assert.deepEqual(reopened.release('ada', undefined, 'operator').map((r) => r.wait.model), ['zz-b']);
      assert.ok(reopened.active('bo', 'zz-a'), "another agent's wait is untouched");
      assert.deepEqual(reopened.release('ada', undefined, 'operator'), [], 'nothing left to release');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  // A negative stated wait (a stream error frame's `retry_after_ms: -1000`, or
  // an HTTP date already past) means "retry now". It used to fall into the
  // indefinite case and hold the model until an operator released it, across
  // reopens, and one arriving during a finite wait made that wait indefinite
  // (PR #251 review, 2026-10-08).
  it('a negative stated wait binds nothing, before or after a reopen, and leaves an outstanding wait as it was', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      for (const stated of [-1, -1_000, 0]) {
        const set = waits.set('ada', 'zz-model', stated, `retry now (${stated})`);
        assert.equal(set.changed, false, `${stated} records nothing`);
        assert.equal(waits.active('ada', 'zz-model'), undefined, `${stated} binds nothing`);
      }
      assert.equal(store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length, 0, 'no record for a wait already over');
      waits.set('ada', 'zz-held', 600_000, 'long');
      const after = waits.set('ada', 'zz-held', -1, 'retry now');
      assert.equal(after.changed, false);
      assert.equal(waits.active('ada', 'zz-held')?.until, time.now() + 600_000, 'the outstanding wait stands, neither shortened nor made indefinite');
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-model'), undefined, 'nothing binds after a reopen, at the same instant');
      assert.deepEqual(reopened.list('ada').map((wait) => [wait.model, wait.until]), [['zz-held', time.now() + 600_000]]);
    } finally { if (!store.isClosed()) store.close(); }
  }));
});

/** The store's journal surface, with failures a test can arm. */
function flaky(store: JsStore) {
  const fail = { appendJson: 0, appendAfter: 0, checkpoint: 0, sync: 0, read: false };
  const surface = {
    getRecordIdsByType: (type: string) => { if (fail.read) throw new Error('zz unreadable record'); return store.getRecordIdsByType(type); },
    getRecord: (id: string) => store.getRecord(id),
    appendJson: (type: string, data: unknown) => {
      if (fail.appendJson > 0) { fail.appendJson--; throw new Error('zz append refused'); }
      // Written, then thrown: as when the store's periodic sync fails after its log has the record.
      if (fail.appendAfter > 0) { fail.appendAfter--; store.appendJson(type, data); throw new Error('zz append threw after writing'); }
      if (fail.checkpoint > 0 && type !== PROVIDER_WAIT_RECORD_TYPE) { fail.checkpoint--; throw new Error('zz checkpoint refused'); }
      return store.appendJson(type, data);
    },
    sync: () => { if (fail.sync > 0) { fail.sync--; throw new Error('zz disk full'); } store.sync(); },
  } as unknown as JsStore;
  return { surface, fail };
}

describe('ProviderWaits: durable and pending acts (room-225 #46276)', () => {
  it('a release made after an ambiguous write stays released: through reconciliation, a checkpoint and a reopen', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      fail.sync = 1; // the set reaches the store, its barrier fails: ambiguous
      waits.set('ada', 'zz-model', 600_000, 'zz 429');
      assert.ok(waits.active('ada', 'zz-model'), 'binds here while its record is unknown');
      const receipt = waits.release('ada', 'zz-model', 'operator');
      assert.deepEqual(receipt.map((r) => [r.wait.model, r.release]), [['zz-model', 'recorded']]);
      assert.equal(waits.active('ada', 'zz-model'), undefined, 'reconciling the set does not undo the release');
      for (let i = 0; i < 70; i++) waits.set(`zz-agent-${i}`, 'zz-model', 600_000, 'unrelated'); // past a checkpoint
      assert.equal(waits.active('ada', 'zz-model'), undefined);
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-model'), undefined, 'released stays released after the checkpoint and a reopen');
      assert.ok(reopened.active('zz-agent-69', 'zz-model'));
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('a binding wait not known to be recorded is recorded at the next act, even one that leaves the binding unchanged', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      const recorded = () => store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      fail.sync = 1; // the set reaches the store, its barrier fails: not known to be recorded
      assert.equal(waits.set('ada', 'zz-model', Number.POSITIVE_INFINITY, 'zz indefinite').wait.until, null);
      assert.equal(recorded(), 1, 'its record reached the store, unconfirmed');
      const shorter = waits.set('ada', 'zz-model', 1_000, 'zz shorter');
      assert.equal(shorter.changed, false);
      assert.equal(shorter.wait.until, null, 'the indefinite wait still binds');
      assert.equal(recorded(), 2, 'the later act offered the pending set again, and it was recorded');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(new ProviderWaits(store, { now: time.now, ...quiet }).active('ada', 'zz-model')?.until, null, 'and survives a reopen');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('a release replayed while its record is pending lists nothing, and offers the record again at once (PR #251 review)', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      const recorded = () => store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      waits.set('ada', 'zz-model', 600_000, 'zz 429');
      fail.sync = 1; // the release reaches the store, its barrier fails: not known to be recorded
      assert.deepEqual(waits.release('ada', 'zz-model', 'operator').map((r) => [r.wait.model, r.release]), [['zz-model', 'pending']]);
      const before = recorded();
      assert.deepEqual(waits.release('ada', 'zz-model', 'operator'), [], 'nothing binds to lift');
      assert.equal(recorded(), before + 1, 'the replay offered the pending release again at once');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(new ProviderWaits(store, { now: time.now, ...quiet }).active('ada', 'zz-model'), undefined,
        'the replay recorded the release, so a restart keeps it');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('absent any later act, a wait not known to be recorded is offered again from admission checks', () => withStoreDir((path) => {
    const time = clock();
    const store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      const recorded = () => store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      fail.sync = 1; // the set reaches the store, its barrier fails: not known to be recorded
      waits.set('ada', 'zz-model', 3_600_000, 'zz 429');
      const before = recorded();
      waits.active('ada', 'zz-model');
      assert.equal(recorded(), before, 'not retried at once');
      time.advance(30_000);
      waits.active('ada', 'zz-model');
      assert.equal(recorded(), before + 1, 'retried after the interval');
    } finally { store.close(); }
  }));

  it('after an append that throws inside the store, waits and releases hold in this process only, said once, and nothing more is written', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const lines: string[] = [];
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, log: (line) => lines.push(line) });
      const recorded = () => store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      waits.set('ada', 'zz-recorded', 600_000, 'zz recorded first');
      fail.appendJson = 1; // the store's append throws: the journal writes nothing until the store is reopened
      waits.set('ada', 'zz-model', 600_000, 'zz 429');
      assert.ok(waits.active('ada', 'zz-model'), 'the wait binds in this process');
      waits.set('bob', 'zz-model', 600_000, 'zz later');
      assert.deepEqual(waits.release('ada', 'zz-recorded', 'operator').map((r) => [r.wait.model, r.release]), [['zz-recorded', 'pending']]);
      time.advance(30_000);
      assert.ok(waits.active('bob', 'zz-model'), 'a later wait binds in this process too');
      assert.equal(waits.active('ada', 'zz-recorded'), undefined, 'and the release lifts its wait here');
      assert.equal(recorded(), 1, 'nothing is written after the failed append, not even from the 30 s re-offer');
      assert.equal(lines.filter((line) => line.includes('until the store is reopened')).length, 1, 'said once');
      assert.equal(lines.filter((line) => line.includes('could not record')).length, 0, 'not once per act');
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-model'), undefined, 'a reopened store has none of the acts that held in process only');
      assert.equal(reopened.active('bob', 'zz-model'), undefined);
      assert.ok(reopened.active('ada', 'zz-recorded'), 'and a release not recorded no longer lifts its wait');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('after an append that throws once its record reached the store, the next start has that act, and only it', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const lines: string[] = [];
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, log: (line) => lines.push(line) });
      fail.appendAfter = 1;
      waits.set('ada', 'zz-landed', 600_000, 'zz written, then the append threw');
      waits.set('ada', 'zz-later', 600_000, 'zz after the throw');
      assert.ok(waits.active('ada', 'zz-landed'));
      assert.ok(waits.active('ada', 'zz-later'), 'both bind in this process');
      assert.equal(lines.filter((line) => line.includes("may still be in the store's log")).length, 1, 'said once');
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.ok(reopened.active('ada', 'zz-landed'), 'the act whose append threw after writing: the next start has it');
      assert.equal(reopened.active('ada', 'zz-later'), undefined, 'a later act held in this process only');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('after a checkpoint that throws inside the store, nothing more is written, and that is said once', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const lines: string[] = [];
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, log: (line) => lines.push(line) });
      const recorded = () => store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      fail.checkpoint = 1; // the 64th entry's flush checkpoints, and the store's append of it throws
      for (let i = 0; i < 64; i++) waits.set(`zz-agent-${i}`, 'zz-model', 600_000, 'zz 429');
      assert.deepEqual(waits.release('zz-nobody', 'zz-model', 'operator'), [], 'an act with nothing to record tries no checkpoint again');
      waits.set('ada', 'zz-model', 600_000, 'zz after');
      time.advance(30_000);
      assert.ok(waits.active('ada', 'zz-model'), 'a later wait binds in this process');
      assert.equal(recorded(), 64, 'the entries before the checkpoint are recorded, and nothing after it');
      assert.equal(lines.filter((line) => line.includes('until the store is reopened')).length, 1, 'said once');
      assert.equal(lines.filter((line) => line.includes('could not')).length, 0, 'not as a failed checkpoint or once per act');
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.ok(reopened.active('zz-agent-63', 'zz-model'), 'a reopened store has the entries');
      assert.equal(reopened.active('ada', 'zz-model'), undefined, 'and not the wait that held in process only');
    } finally { if (!store.isClosed()) store.close(); }
  }));
});

describe('ProviderWaits: unreadable history fails closed (room-225 #46189, #46449)', () => {
  it('holds every (agent, model) with a reason, lifts exactly what a release names, and applies that release in order once readable', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      new ProviderWaits(store, { now: time.now, ...quiet }).set('ada', 'zz-a', Number.POSITIVE_INFINITY, 'zz recorded indefinite');
      store.close();

      store = JsStore.openOrCreate({ path });
      const { surface, fail } = flaky(store);
      fail.read = true;
      const lines: string[] = [];
      const waits = new ProviderWaits(surface, { now: time.now, log: (line) => lines.push(line) });
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /could not be read \(zz unreadable record\): no provider call is admitted/);
      for (const [agent, model] of [['ada', 'zz-a'], ['ada', 'zz-b'], ['bo', 'zz-a']] as const) {
        const held = waits.active(agent, model);
        assert.equal(held?.until, null, `${agent}/${model} held: absence is unknown, not "no waits"`);
        assert.match(held!.reason, /recorded provider waits could not be read \(zz unreadable record\)/);
      }
      assert.deepEqual(waits.list('ada').map((w) => [w.model, w.until]), [['*', null]], 'listed for inspection');

      const narrow = waits.release('ada', 'zz-b', 'operator');
      assert.deepEqual(narrow.map((r) => [r.wait.model, r.release]), [['zz-b', 'in-process override']]);
      assert.equal(waits.active('ada', 'zz-b'), undefined, 'the named model is lifted');
      assert.equal(waits.active('ada', 'zz-a')?.until, null, 'another model of the agent stays held');
      assert.equal(waits.active('bo', 'zz-b')?.until, null, 'another agent stays held');

      // Readable again in this process: the recorded wait returns, and the
      // release already made applies after it, in order.
      fail.read = false;
      time.advance(30_000);
      assert.equal(waits.active('ada', 'zz-a')?.reason, 'zz recorded indefinite', 'the recorded wait, not the stand-in');
      assert.equal(waits.active('ada', 'zz-b'), undefined, 'the release made meanwhile still holds');
      assert.equal(waits.active('bo', 'zz-a'), undefined, 'no stand-in once readable');
      store.close();

      store = JsStore.openOrCreate({ path });
      const again = flaky(store);
      again.fail.read = true;
      const restarted = new ProviderWaits(again.surface, { now: time.now, ...quiet });
      assert.equal(restarted.active('ada', 'zz-b')?.until, null, 'a restart that still cannot read holds again');
      const all = restarted.release('ada', undefined, 'operator');
      assert.deepEqual(all.map((r) => [r.wait.model, r.release]), [['*', 'in-process override']]);
      assert.equal(restarted.active('ada', 'zz-a'), undefined, 'omitting the model lifts every model of the agent');
      assert.equal(restarted.active('bo', 'zz-a')?.until, null);
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it("readable again, the log counts what binds after this process's unrecorded release (PR #251 review)", () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      new ProviderWaits(store, { now: time.now, ...quiet }).set('ada', 'zz-a', 600_000, 'zz recorded');
      store.close();

      store = JsStore.openOrCreate({ path });
      const { surface, fail } = flaky(store);
      fail.read = true;
      const lines: string[] = [];
      const waits = new ProviderWaits(surface, { now: time.now, log: (line) => lines.push(line) });
      fail.appendJson = 1; // the release's record is refused: it stays this process's act
      assert.deepEqual(waits.release('ada', undefined, 'operator').map((r) => r.release), ['in-process override']);
      fail.read = false;
      time.advance(30_000);
      assert.equal(waits.active('ada', 'zz-a'), undefined, 'the release made meanwhile lifts the recorded wait');
      assert.ok(lines.some((line) => /readable again; 0 bind$/.test(line)), lines.join('\n'));
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('reports each episode of unreadable records once, and a failing report leaves the hold standing (PR #251 review)', () => withStoreDir((path) => {
    const time = clock();
    const store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      fail.read = true;
      const reported: string[] = [];
      const onUnreadable = (error: string) => { reported.push(error); };
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet, onUnreadable });
      assert.deepEqual(reported, ['zz unreadable record'], 'reported as the hold begins');
      time.advance(30_000);
      assert.equal(waits.active('ada', 'zz-a')?.until, null);
      assert.equal(reported.length, 1, 'a re-read that fails again is the same episode');
      fail.read = false;
      time.advance(30_000);
      assert.equal(waits.active('ada', 'zz-a'), undefined, 'readable again');

      fail.read = true;
      new ProviderWaits(surface, { now: time.now, ...quiet, onUnreadable });
      assert.equal(reported.length, 2, 'a restart that still cannot read is a new episode');
      const unreported = new ProviderWaits(surface, { now: time.now, ...quiet, onUnreadable: () => { throw new Error('zz alert sink down'); } });
      assert.equal(unreported.active('ada', 'zz-a')?.until, null, 'a report that throws changes nothing');
    } finally { store.close(); }
  }));
});

describe('ProviderWaits: a record that parses but is not a provider wait fails closed (PR #251 review)', () => {
  const CHECKPOINT = `${PROVIDER_WAIT_RECORD_TYPE}/checkpoint`;
  const wait = { agent: 'ada', model: 'zz-a', until: 1_700_000_600_000, reason: 'zz', setAt: 1_700_000_000_000 };
  // Each writes one malformed record after a well-formed recorded wait; a
  // checkpoint's `through` covers that wait, so reading it as empty drops it.
  const malformed: Array<[string, (store: JsStore, through: string) => void]> = [
    ['a checkpoint whose snapshot is {}', (store, through) => { store.appendJson(CHECKPOINT, { through, snapshot: {} }); }],
    ['a checkpoint whose snapshot is null', (store, through) => { store.appendJson(CHECKPOINT, { through, snapshot: null }); }],
    ['a checkpoint wait without its deadline', (store, through) => {
      const { until: _until, ...partial } = wait;
      store.appendJson(CHECKPOINT, { through, snapshot: { waits: [partial] } });
    }],
    ['a checkpoint holding one (agent, model) twice, the shorter last', (store, through) => {
      store.appendJson(CHECKPOINT, { through, snapshot: { waits: [wait, { ...wait, until: wait.setAt + 1 }] } });
    }],
    ['an entry of a kind this reader does not know', (store) => {
      store.appendJson(PROVIDER_WAIT_RECORD_TYPE, { kind: 'paused', agent: 'ada', model: 'zz-a', at: 1 });
    }],
    ['a set whose deadline is not an instant', (store) => {
      store.appendJson(PROVIDER_WAIT_RECORD_TYPE, { kind: 'set', agent: 'ada', model: 'zz-a', until: 'later', reason: 'zz', at: 1 });
    }],
    ['a set whose deadline is past any Date', (store) => {
      store.appendJson(PROVIDER_WAIT_RECORD_TYPE, { kind: 'set', agent: 'ada', model: 'zz-a', until: 1e300, reason: 'zz', at: 1 });
    }],
    ['a release that names no agent', (store) => {
      store.appendJson(PROVIDER_WAIT_RECORD_TYPE, { kind: 'released', model: null, by: 'zz', at: 1 });
    }],
  ];
  for (const [shape, write] of malformed) {
    it(`${shape}: every (agent, model) is held, not read as no waits`, () => withStoreDir((path) => {
      const time = clock();
      let store = JsStore.openOrCreate({ path });
      try {
        new ProviderWaits(store, { now: time.now, ...quiet }).set('ada', 'zz-a', 600_000, 'zz recorded');
        const [through] = store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE);
        write(store, through!);
        store.close();

        store = JsStore.openOrCreate({ path });
        const waits = new ProviderWaits(store, { now: time.now, ...quiet });
        for (const [agent, model] of [['ada', 'zz-a'], ['bo', 'zz-b']] as const) {
          const held = waits.active(agent, model);
          assert.equal(held?.until, null, `${agent}/${model} held`);
          assert.match(held!.reason, /could not be read \(.*malformed\)/);
        }
      } finally { if (!store.isClosed()) store.close(); }
    }));
  }

  it("a release's `by` is never read back, so an odd requester does not make the history unreadable", () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const waits = new ProviderWaits(store, { now: time.now, ...quiet });
      waits.set('ada', 'zz-a', 600_000, 'zz recorded');
      waits.set('ada', 'zz-b', 600_000, 'zz recorded');
      waits.release('ada', 'zz-a', 42 as unknown as string);
      store.close();

      store = JsStore.openOrCreate({ path });
      const reopened = new ProviderWaits(store, { now: time.now, ...quiet });
      assert.equal(reopened.active('ada', 'zz-a'), undefined, 'released, and the history reads');
      assert.equal(reopened.active('ada', 'zz-b')?.reason, 'zz recorded');
    } finally { if (!store.isClosed()) store.close(); }
  }));
});

describe("ProviderWaits: '*' is every model, everywhere (room-225 #47372)", () => {
  it("releasing the listed '*' is the same release as omitting the model: in process, in the record, and after recovery", () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      new ProviderWaits(store, { now: time.now, ...quiet }).set('r', 'zz-a', 600_000, 'zz recorded');
      store.close();

      store = JsStore.openOrCreate({ path });
      const { surface, fail } = flaky(store);
      fail.read = true;
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      const listed = waits.list('r');
      assert.deepEqual(listed.map((w) => w.model), ['*']);
      const receipt = waits.release('r', listed[0]!.model, 'operator');
      assert.deepEqual(receipt.map((r) => [r.wait.model, r.release]), [['*', 'in-process override']]);
      assert.equal(waits.active('r', 'zz-a'), undefined, 'lifted for every model in process');

      fail.read = false;
      time.advance(30_000);
      assert.equal(waits.active('r', 'zz-a'), undefined, 'and the recorded release covers every model once readable');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(new ProviderWaits(store, { now: time.now, ...quiet }).active('r', 'zz-a'), undefined, 'and after a reopen');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('a specific-model release stays specific while the records are unreadable', () => withStoreDir((path) => {
    const time = clock();
    const store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      fail.read = true;
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      waits.release('r', 'zz-a', 'operator');
      assert.equal(waits.active('r', 'zz-a'), undefined);
      assert.equal(waits.active('r', 'zz-b')?.until, null, 'another model stays held');
      assert.deepEqual(waits.list('r').map((w) => w.model), ['*'], 'the every-model hold is still listed');
    } finally { store.close(); }
  }));
});

// ---------------------------------------------------------------------------
// The framework: a real store, context manager and admission.
// ---------------------------------------------------------------------------

class InputModule implements Module {
  readonly name = 'input';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

const rateLimited = (retryAfterMs: number | undefined, request?: NormalizedRequest) => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
  message: 'zz rate limit reached for requests', rawError: { status: 429 }, rawRequest: request,
});

/** Primary turns fail with a stated wait `failures` times, then succeed. */
class WaitingMembrane extends MockMembrane {
  primary = 0;
  auxiliary: NormalizedRequest[] = [];
  auxiliaryFailure: Error | undefined;
  constructor(private failures: number, private readonly retryAfterMs: number | undefined) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.primary <= this.failures) return new ErrorStream(rateLimited(this.retryAfterMs, request));
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-recovered' }])]);
  }
  override async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.auxiliary.push(request);
    if (this.auxiliaryFailure) throw this.auxiliaryFailure;
    return createMockResponse([{ type: 'text', text: 'zz-summary' }]);
  }
}

type Internal = {
  consecutiveInferenceFailures: Map<string, number>;
  providerAccelerationCooldowns: Map<string, { until: number; waitModel?: string; heldRequests: unknown[]; hostHoldError?: Error }>;
  auxiliaryMembraneFor(agentName: string): { complete(request: unknown): Promise<unknown> };
  handleHostCommand(serverId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  store: JsStore;
  providerWaits: ProviderWaits;
  providerAccelerationDefaultCooldownMs: number;
  providerAccelerationJitterMs: number;
};

async function framework(path: string, membrane: WaitingMembrane) {
  const fw = await AgentFramework.create({
    storePath: path, membrane: membrane.asMembrane(),
    agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
    modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  return { fw, internal: fw as unknown as Internal };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A stated wait ends at a `Date.now()` time, and these tests check that it
 *  binds after steps that take real time, which a loaded host can stretch
 *  past it. `holdClock` holds `Date` still from here on: call it before the
 *  framework is built, since ProviderWaits takes `Date.now` then, and the
 *  framework reads `Date.now()` at each hold and release. The hold's own
 *  timers stay real. `outlast(wait)` lets real time pass the wait while the
 *  clock stays inside it, the condition load makes, so a test fails there
 *  unless the clock is held; `pass(wait)` then moves the clock past it, and
 *  `advance(ms)` moves it by less, for what is timed inside the wait. */
function holdClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return {
    outlast: (waitMs: number) => sleep(waitMs + 100),
    pass: (waitMs: number) => t.mock.timers.tick(waitMs + 1),
    advance: (ms: number) => t.mock.timers.tick(ms),
  };
}

const auxRequest = (model: string) => ({
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-compress' }] }],
  config: { model, maxTokens: 16 },
});

function silence() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

test('a primary 429 with retry-after holds the turn, without a failure marker, and resumes once after it', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new WaitingMembrane(1, wait);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'no retry inside the wait');
      assert.equal(internal.consecutiveInferenceFailures.get('resident') ?? 0, 0, 'capacity is not a failure streak');
      const health = fw.healthSnapshot() as { agents: Array<{ providerAdmission: { providerWaits: Array<{ model: string; until: string | null }> } }> };
      assert.equal(health.agents[0].providerAdmission.providerWaits[0].model, 'zz-model');

      // Real time passes the wait before the next message arrives, as on a
      // loaded host; the clock stays inside it, and so the hold stands.
      await clock.outlast(wait);
      assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'the hold stands while the clock is inside the wait');
      // A real clock stamps the arrival after the failed turn. Under the held
      // one they would share a timestamp, and the hold would keep them as one
      // request (sameInferenceRequest compares timestamps).
      clock.advance(1);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-arrived while waiting', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'an arrival during the wait is held, not inferred');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 2, 'the hold keeps the failed turn and the arrival');

      // The wait passes, and the hold's timer, a real one, releases the turn.
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the fresh compile after the wait');
      assert.equal(membrane.primary, 2, 'one fresh compile after the wait');
      const text = membrane.calls[1].messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n');
      assert.match(text, /zz-first/);
      assert.match(text, /zz-arrived while waiting/);
      const markers = fw.getAgent('resident')!.getContextManager().queryMessages({}).messages
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
      assert.equal(markers.length, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a stated wait past the framework cap is honoured in full, until an operator releases it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const twentyMinutes = 20 * 60_000;
    const membrane = new WaitingMembrane(1, twentyMinutes);
    const { fw, internal } = await framework(path, membrane);
    try {
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const cooldown = internal.providerAccelerationCooldowns.get('resident')!;
      assert.ok(cooldown.until >= before + twentyMinutes, 'not shortened to the 10-minute cap');
      assert.equal(cooldown.waitModel, 'zz-model');

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.equal(released.ok, true);
      assert.deepEqual((released.released as Array<{ model: string }>).map((w) => w.model), ['zz-model']);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'the held turn runs once released');
      assert.ok(log.lines.some((l) => l.includes('released by zz-operator')));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a non-retryable failure worded as organization acceleration keeps its terminal disposition", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 400);
    const refuse = (request: NormalizedRequest) => new MembraneError({
      type: 'rate_limit', retryable: false, httpStatus: 429, retryAfterMs: 400,
      // Worded as framework.ts's isOrganizationAccelerationRateLimit reads one.
      message: 'zz your organization acceleration limit was reached', rawError: { status: 429 }, rawRequest: request,
    });
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request: NormalizedRequest) => {
      if (membrane.primary === 0) { membrane.calls.push(request); membrane.primary++; return new ErrorStream(refuse(request)); }
      return stream(request);
    };
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const markers = fw.getAgent('resident')!.getContextManager().queryMessages({}).messages
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
      assert.equal(markers.length, 1, 'terminal: its marker is written');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length ?? 0, 0, 'not retained for retry');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a turn arriving at a recorded wait is held without counting a failure', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    let opened = await framework(path, membrane);
    const failures = (internal: typeof opened.internal) =>
      (internal.providerAccelerationCooldowns.get('resident') as { failures?: number } | undefined)?.failures;
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(failures(opened.internal), 1, 'the failed call counts once');
    } finally { await opened.fw.stop(); }

    // After a restart, the recorded wait holds the next turn at admission:
    // no call failed in this process.
    opened = await framework(path, membrane);
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-after restart', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'held, not called');
      assert.equal(failures(opened.internal), 0, 'an arrival at the hold is not a failure');
    } finally { await opened.fw.stop(); log.restore(); }
  });
});

test('auxiliary admission: the same model is refused without a call; another model proceeds', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const aux = internal.auxiliaryMembraneFor('resident');
      const refused = await aux.complete(auxRequest('zz-model')).then(() => undefined, (e: unknown) => e);
      assert.ok(refused instanceof MembraneError);
      assert.equal(refused.type, 'rate_limit');
      assert.ok(refused.retryAfterMs !== undefined && refused.retryAfterMs > 50_000 && refused.retryAfterMs <= 60_000);
      assert.match(refused.message, /no call was made/);
      assert.equal((refused as unknown as { providerAdmission?: string }).providerAdmission, 'deferred',
        'marked as a deferral, so a pacing caller does not count it as a failed call');
      assert.equal(membrane.auxiliary.length, 0, 'the provider was not called');

      await aux.complete(auxRequest('zz-compression-model'));
      assert.equal(membrane.auxiliary.length, 1, 'a model the provider did not limit keeps working');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an auxiliary call's stated wait binds that model only", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    membrane.auxiliaryFailure = rateLimited(60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      const aux = internal.auxiliaryMembraneFor('resident');
      await assert.rejects(aux.complete(auxRequest('zz-compression-model')), /zz rate limit/);
      membrane.auxiliaryFailure = undefined;
      await assert.rejects(aux.complete(auxRequest('zz-compression-model')), /Provider wait/);
      assert.equal(membrane.auxiliary.length, 1, 'the second call never reached the provider');

      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-turn', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'the primary model is not bound by the compression model wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a restart honours the wait, even after a switch to a branch from before it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    let opened = await framework(path, membrane);
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 1);
    } finally { await opened.fw.stop(); }

    // Roll the store back to before the wait existed, then restart on it.
    const store = JsStore.openOrCreate({ path });
    const main = store.currentBranch().name;
    store.createBranchAt('zz-rollback', main, 0);
    store.switchBranch('zz-rollback');
    store.close();

    opened = await framework(path, membrane);
    try {
      opened.fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-after restart', metadata: {} });
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'no call before the provider said');
      const waits = opened.fw.providerWaitSnapshot('resident');
      assert.equal(waits.length, 1);
      assert.equal(waits[0].model, 'zz-model');

      opened.fw.releaseProviderWait('resident');
      await opened.fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'released by the operator, the held turn runs');
    } finally { await opened.fw.stop(); log.restore(); }
  });
});

for (const [delay, label] of [[3_000_000_000, 'a 34-day delay'], [Number.POSITIVE_INFINITY, 'an infinite delay']] as const) {
test(`a retry policy delay past one timer is waited in full, and stop() ends the wait: ${label}`, async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    // A non-membrane error keeps provider admission out of it: only the policy decides.
    class ThrowingMembrane extends WaitingMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        this.calls.push(request); this.primary++;
        return new ErrorStream(new Error('zz transient'));
      }
    }
    const membrane = new ThrowingMembrane(0, undefined);
    const fw = await AgentFramework.create({
      storePath: path, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: {
        maxRetries: 2,
        onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: delay } : { retry: false }),
      },
    });
    let stopped = false;
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      void fw.runUntilIdle();
      // The event the assertion rests on: the turn has failed once and is
      // asleep in its retry wait.
      const asleep = fw as unknown as { retryWaitWakers: Set<unknown> };
      for (let i = 0; i < 500 && asleep.retryWaitWakers.size === 0; i++) await sleep(10);
      assert.equal(asleep.retryWaitWakers.size, 1, 'asleep in the retry wait');
      assert.equal(membrane.primary, 1, `${label} does not fire almost at once`);
      const stopping = fw.stop();
      await Promise.race([stopping, sleep(5_000).then(() => { throw new Error('stop() did not end the wait'); })]);
      stopped = true;
      await sleep(200);
      assert.equal(membrane.primary, 1, 'stop() cancels the retry: no call after it (room-225 #46745)');
    } finally {
      if (!stopped) await fw.stop();
      log.restore();
    }
  });
});
}

/** The longest delay one setTimeout holds (2^31 - 1 ms, about 24.8 days). */
const ONE_TIMER_MS = 2_147_483_647;

test('a retry wait past one timer waits in steps of at most one timer, and only the last step ends it (PR #251 review)', async (t) => {
  await withStoreDir(async (path) => {
    const log = silence();
    const { fw } = await framework(path, new WaitingMembrane(0, undefined));
    const stepping = fw as unknown as { waitForRetry(ms: number): Promise<void> };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const mocked = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return mocked(fn, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      let done = false;
      const waiting = stepping.waitForRetry(ONE_TIMER_MS + 1_000).then(() => { done = true; });
      t.mock.timers.tick(ONE_TIMER_MS);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(done, false, "still waiting after one timer's worth");
      t.mock.timers.tick(1_000);
      await waiting;
      assert.ok(delays.includes(ONE_TIMER_MS), `a whole timer first (${delays.join(', ')})`);
      assert.ok(delays.every((ms) => ms <= ONE_TIMER_MS), 'no step longer than one timer holds');
    } finally {
      globalThis.setTimeout = mocked;
      t.mock.timers.reset();
      await fw.stop(); log.restore();
    }
  });
});

test('a hold on a wait longer than one timer is armed for at most one timer, and re-arms rather than releasing while the wait binds (PR #251 review)', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 30 * 86_400_000); // 30 days
    const { fw, internal } = await framework(path, membrane);
    const real = globalThis.setTimeout;
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const hold = internal.providerAccelerationCooldowns.get('resident');
      assert.equal(hold?.waitModel, 'zz-model');
      const until = hold!.until;
      // Its timer fires one timer's worth in, about 24.8 days: the wait still
      // binds, so the hold arms again rather than releasing the turn.
      const delays: number[] = [];
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        delays.push(ms ?? 0);
        return real(fn, ms, ...rest);
      }) as unknown as typeof setTimeout;
      (internal as unknown as { releaseProviderAccelerationCooldown(agentName: string): void }).releaseProviderAccelerationCooldown('resident');
      globalThis.setTimeout = real;
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, until, 'still held, to the same deadline');
      assert.deepEqual(delays, [ONE_TIMER_MS], 'armed again for one timer');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'and no call is made');
    } finally { globalThis.setTimeout = real; await fw.stop(); log.restore(); }
  });
});

test("an ephemeral run's cap includes its edge: a stated wait of exactly 600 s is left to the policy, and one past it ends the run (PR #251 review)", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const { fw, internal } = await framework(path, new WaitingMembrane(0, undefined));
    const runs = internal as unknown as {
      ephemeralRuns: Map<string, unknown>;
      nonOwningProviderWait(agent: unknown, error: Error): 'held' | 'fail' | undefined;
    };
    const name = 'zz-ephemeral-edge';
    try {
      const created = await fw.createEphemeralAgent({ name, model: 'zz-model', systemPrompt: 'Do the task.' });
      runs.ephemeralRuns.set(name, {});
      assert.equal(runs.nonOwningProviderWait(created.agent, rateLimited(600_000)), undefined, 'exactly the cap: slept by the error policy');
      assert.equal(runs.nonOwningProviderWait(created.agent, rateLimited(600_001)), 'fail', 'past the cap: the run ends now');
    } finally { runs.ephemeralRuns.delete(name); await fw.stop(); log.restore(); }
  });
});

test('stop() cancels a retry wait on the path that does not own provider admission (a conversation agent)', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    class ThrowingMembrane extends WaitingMembrane {
      override streamYielding(request: NormalizedRequest): YieldingStream {
        this.calls.push(request); this.primary++;
        return new ErrorStream(new Error('zz transient'));
      }
    }
    const membrane = new ThrowingMembrane(0, undefined);
    const fw = await AgentFramework.create({
      storePath: path, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      errorPolicy: {
        maxRetries: 2,
        onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: 3_000_000_000 } : { retry: false }),
      },
    });
    const internal = fw as unknown as {
      conversationAgentHomes: Map<string, string>;
      retryWaitWakers: Set<unknown>;
      startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
    };
    let stopped = false;
    try {
      internal.conversationAgentHomes.set('resident', 'world:zz');
      fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-direct' }]);
      const run = internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      for (let i = 0; i < 300 && internal.retryWaitWakers.size === 0; i++) await sleep(10);
      assert.equal(membrane.primary, 1);
      assert.ok(internal.retryWaitWakers.size > 0, 'parked in the policy delay');
      await fw.stop();
      stopped = true;
      await run;
      await sleep(200);
      assert.equal(membrane.primary, 1, 'no call after stop()');
    } finally {
      if (!stopped) await fw.stop();
      log.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Corrective round (room-225 #46189, #46418, #46371).
// ---------------------------------------------------------------------------

test('a non-retryable failure with a stated wait keeps its terminal disposition; the wait binds the calls after it', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new WaitingMembrane(1, wait);
    // The first primary call is refused outright (not retryable), with a hint.
    const refuse = (request: NormalizedRequest) => new MembraneError({
      type: 'invalid_request', retryable: false, httpStatus: 400, retryAfterMs: wait,
      message: 'zz request refused', rawError: { status: 400 }, rawRequest: request,
    });
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request: NormalizedRequest) => {
      if (membrane.primary === 0) { membrane.calls.push(request); membrane.primary++; return new ErrorStream(refuse(request)); }
      return stream(request);
    };
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1);
      const markers = () => fw.getAgent('resident')!.getContextManager().queryMessages({}).messages
        .filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'inference-failed');
      assert.equal(markers().length, 1, 'the failure is terminal: its marker is written');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length ?? 0, 0, 'the failed request is not retained for retry');

      // Real time passes the wait before the later wake, as on a loaded host.
      await clock.outlast(wait);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the wait', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'a later wake is held by the stated wait');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the wake');

      // The wait passes, and the hold's timer, a real one, releases the wake.
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the held wake after the wait');
      assert.equal(membrane.primary, 2, 'and runs once after it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a primary wake parked behind an auxiliary call is held by the wait that call\'s failure records', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    let entered!: () => void;
    let fail!: (error: Error) => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<never>((_resolve, reject) => { fail = reject; });
    const membrane = new WaitingMembrane(0, undefined);
    membrane.complete = async (request: NormalizedRequest) => { membrane.auxiliary.push(request); entered(); return held; };
    const { fw, internal } = await framework(path, membrane);
    try {
      const aux = internal.auxiliaryMembraneFor('resident').complete(auxRequest('zz-model')).catch((error: unknown) => error);
      await inFlight;
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-parked', metadata: {} });
      const run = fw.runUntilIdle();
      const gates = (fw as unknown as { providerGates: Map<string, { primaryDepth: number }> }).providerGates;
      for (let i = 0; i < 300 && !((gates.get('resident')?.primaryDepth ?? 0) > 0); i++) await sleep(10);
      assert.ok((gates.get('resident')?.primaryDepth ?? 0) > 0, 'the primary wake parked behind the auxiliary call');

      fail(rateLimited(wait));
      await aux;
      // The run started above drives the parked wake to the boundary.
      for (let i = 0; i < 500 && !log.lines.some((line) => /binds at admission/.test(line)); i++) await sleep(10);
      assert.ok(log.lines.some((line) => /binds at admission/.test(line)), 'the parked wake reached the boundary');
      assert.equal(membrane.primary, 0, 'not started into the wait its parked-behind call recorded');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the wake');

      // Real time passes the wait, as on a loaded host, and the wake stays held.
      await clock.outlast(wait);
      assert.equal(membrane.primary, 0, 'still held while the clock is inside the wait');
      assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'the hold stands');

      // The hold's timer releases it after the wait, and queues the wake again.
      clock.pass(wait);
      for (let i = 0; i < 500 && internal.providerAccelerationCooldowns.has('resident'); i++) await sleep(10);
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'the hold ended with the wait');
      await run;
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'the held wake runs once after the wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an operator release reaches the context strategy's compression lane, naming the model", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const strategy = fw.getAgent('resident')!.getContextManager().getStrategy() as unknown as { releaseCompressionPause?: (model?: string) => boolean };
      const asked: Array<string | undefined> = [];
      strategy.releaseCompressionPause = (model?: string) => { asked.push(model); return true; };
      await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.deepEqual(asked, ['zz-model']);
      await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', requesterName: 'zz-operator' });
      assert.deepEqual(asked, ['zz-model', undefined], 'an explicit release reaches the lane even with nothing left to release here');
      membrane.primary = 0; // fail the next primary again: a new wait
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-second', metadata: {} });
      await fw.runUntilIdle();
      await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: '*', requesterName: 'zz-operator' });
      assert.deepEqual(asked, ['zz-model', undefined, undefined], "'*' reaches the lane as every model");
      assert.ok(log.lines.some((line) => line.includes("compression lane's provider wait released")));
    } finally { await fw.stop(); log.restore(); }
  });
});

// ---------------------------------------------------------------------------
// Review round on PR #251: held-turn recovery, acceleration release, release
// model scope.
// ---------------------------------------------------------------------------

/** Swap in waits whose reads fail until `fail.read` is cleared, re-read every 50 ms. */
function unreadableWaits(internal: Internal) {
  const { surface, fail } = flaky(internal.store);
  fail.read = true;
  internal.providerWaits = new ProviderWaits(surface, { retryReadMs: 50, ...quiet });
  return fail;
}

test('a hold for unreadable records ends by itself once they read again: its own re-check finds them readable', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    try {
      const fail = unreadableWaits(internal);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 0, 'held: the absence of recorded waits is unknown');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, Number.POSITIVE_INFINITY);

      await sleep(200);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 0, 'still held while they cannot be read');

      // No health call and no operator release: only the hold's own timer.
      fail.read = false;
      await sleep(200);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'the held turn runs once the records read again');
      assert.equal(internal.providerAccelerationCooldowns.size, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an auxiliary call naming no model is held by the unreadable-records hold, and only by it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle(); // a wait is recorded for the primary model
      const aux = internal.auxiliaryMembraneFor('resident');
      const unnamed = { messages: auxRequest('x').messages, config: { maxTokens: 16 } };
      await aux.complete(unnamed as never);
      assert.equal(membrane.auxiliary.length, 1, "a recorded model's wait can't be matched to a call naming no model");

      unreadableWaits(internal);
      const refused = await aux.complete(unnamed as never).then(() => undefined, (e: unknown) => e);
      assert.ok(refused instanceof MembraneError, 'the hold that stands for unreadable records binds it');
      assert.match(refused.message, /\* is held for resident/);
      assert.equal(membrane.auxiliary.length, 1, 'the provider was not called');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("once the records read again, a hold takes the recorded wait's deadline: it neither stays indefinite nor ends early", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 900;
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    try {
      const recorded = internal.providerWaits.set('resident', 'zz-model', wait, 'zz recorded before the reads failed').wait;
      const fail = unreadableWaits(internal);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, Number.POSITIVE_INFINITY);

      await sleep(100);
      fail.read = false;
      // The records are read again once their retry interval (50 ms, in
      // unreadableWaits) has passed on the clock too, well inside the wait.
      clock.advance(50);
      await sleep(200);
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, recorded.until, 'the recorded deadline, not the stand-in');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the turn');
      assert.equal(membrane.primary, 0, 'and not before it');

      // Real time passes the wait, as on a loaded host, and the turn stays held.
      await clock.outlast(wait);
      assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'the hold stands while the clock is inside the wait');
      assert.equal(membrane.primary, 0, 'still held while the clock is inside the wait');

      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 1, 'the held turn after that wait');
      assert.equal(membrane.primary, 1, 'the held turn runs once that wait passes');
    } finally { await fw.stop(); log.restore(); }
  });
});

const accelerationLimited = (retryAfterMs: number, request: NormalizedRequest) => new MembraneError({
  type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
  message: "This request would exceed your organization's maximum usage increase rate for input tokens per minute",
  rawError: { status: 429 }, rawRequest: request,
});

test("releasing the stated wait of an organization-acceleration hold leaves AF's own pacing; another model's release leaves the hold", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const twentyMinutes = 20 * 60_000;
    const membrane = new WaitingMembrane(0, undefined);
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request: NormalizedRequest) => {
      if (membrane.primary === 0) { membrane.calls.push(request); membrane.primary++; return new ErrorStream(accelerationLimited(twentyMinutes, request)); }
      return stream(request);
    };
    const { fw, internal } = await framework(path, membrane);
    internal.providerAccelerationDefaultCooldownMs = 1_000;
    internal.providerAccelerationJitterMs = 0;
    try {
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const armedBy = Date.now();
      assert.equal(membrane.primary, 1);
      const hold = internal.providerAccelerationCooldowns.get('resident')!;
      assert.equal(hold.waitModel, undefined, 'an acceleration hold parks the whole agent');
      const statedUntil = hold.until;
      assert.ok(statedUntil >= before + twentyMinutes, 'its length is the stated wait');

      const other = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-other', requesterName: 'zz-operator' });
      assert.equal(other.ok, true);
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, statedUntil, "another model's release leaves the hold");

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.deepEqual((released.released as Array<{ model: string }>).map((w) => w.model), ['zz-model']);
      const paced = internal.providerAccelerationCooldowns.get('resident');
      assert.ok(paced, "AF's own pacing for the failure still holds");
      assert.ok(paced.until >= before + 1_000 && paced.until <= armedBy + 1_000, `held to AF's own pacing (${paced.until - before} ms after the failure)`);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'not before that pacing passes');

      await waitFor(fw, () => membrane.primary >= 2, 'the held turn after that pacing');
      assert.equal(membrane.primary, 2, 'the held turn runs once it has');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("releasing a provider wait leaves a host hold the host's", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 20 * 60_000);
    const fw = await AgentFramework.create({
      storePath: path, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      providerHold: () => ({ holdMs: 60_000, reason: 'zz weekly quota spent' }),
    });
    const internal = fw as unknown as Internal;
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const hold = internal.providerAccelerationCooldowns.get('resident')!;
      assert.ok(hold.hostHoldError, 'a host hold');
      const until = hold.until;
      assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model'], 'the stated wait is recorded beside it');

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.deepEqual((released.released as Array<{ model: string }>).map((w) => w.model), ['zz-model']);
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'the stated wait is released');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, until, 'the host hold stands, unchanged');
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'and still holds the turn');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a malformed release model is refused at both operator surfaces, never widened to every model', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model']);
      const api = new ApiServer(fw) as unknown as {
        executeCommand(ws: unknown, command: string, params?: Record<string, unknown>): Promise<unknown>;
      };
      for (const model of ['', null, 42, ['zz-model'], {}, 'zz-model\n[provider-wait] agent=resident model=zz-forged released by nobody']) {
        const label = JSON.stringify(model);
        const refused = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model, requesterName: 'zz-operator' });
        assert.equal(refused.ok, false, `host command, model ${label}`);
        assert.match(String(refused.error), /model must be a model name/);
        await assert.rejects(api.executeCommand(undefined, 'host.releaseProviderWait', { agentName: 'resident', model }),
          /model must be a model name/, `WS verb, model ${label}`);
      }
      assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model'], 'nothing was released');

      const every = await api.executeCommand(undefined, 'host.releaseProviderWait', { agentName: 'resident', model: '*' }) as { released: Array<{ model: string }> };
      assert.deepEqual(every.released.map((w) => w.model), ['zz-model'], "'*' still releases every model");
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a release names one of the agents, the API verb takes the admin token, and a requester is marked and cleaned (PR #251 review)', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const api = new ApiServer(fw, { adminToken: 'zz-token' }) as unknown as {
        executeCommand(ws: unknown, command: string, params?: Record<string, unknown>): Promise<unknown>;
      };
      const records = () => internal.store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
      const before = records();

      await assert.rejects(api.executeCommand(undefined, 'host.releaseProviderWait', { agentName: 'resident' }), /adminToken/,
        'no token, no release');
      // '*' and 'framework' are how the hold for unreadable records is listed and alerted.
      for (const agentName of ['zz-typo', '*', 'framework']) {
        await assert.rejects(api.executeCommand(undefined, 'host.releaseProviderWait', { agentName, adminToken: 'zz-token' }),
          /Unknown agent/, `WS verb, ${agentName}`);
        assert.throws(() => fw.releaseProviderWait(agentName), /Unknown agent/, `framework, ${agentName}`);
        const refused = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName, requesterName: 'zz-operator' });
        assert.equal(refused.ok, false, `host command, ${agentName}`);
      }
      const unnamed = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', requesterName: 'zz-operator' });
      assert.equal(unnamed.ok, false, 'a host command that names no agent releases nothing, not the first agent');
      assert.match(String(unnamed.error), /agentName must name the agent/);
      assert.equal(records(), before, 'nothing was recorded');
      assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model'], 'nothing was released');

      await assert.rejects(api.executeCommand(undefined, 'host.providerWaits', { agentName: 42 }), /agentName must be an agent name/,
        'a malformed filter is refused, never widened to every agent');
      const listed = await api.executeCommand(undefined, 'host.providerWaits', {}) as { waits: Array<{ agent: string }> };
      assert.deepEqual(listed.waits.map((w) => w.agent), ['resident'], 'a read, like host.status: no token needed');

      log.lines.length = 0;
      const forged = 'zz-ops\n[provider-wait] agent=resident model=zz-forged released by nobody';
      const released = await api.executeCommand(undefined, 'host.releaseProviderWait',
        { agentName: 'resident', adminToken: 'zz-token', requester: forged }) as { released: Array<{ model: string }> };
      assert.deepEqual(released.released.map((w) => w.model), ['zz-model']);
      assert.ok(log.lines.every((line) => !/[\r\n]/.test(line)), 'no line carries a line break');
      const said = log.lines.filter((line) => line.includes('released by'));
      assert.equal(said.length, 1, said.join('\n'));
      assert.match(said[0]!, /released by api:zz-ops \[provider-wait\] agent=resident model=zz-forged released by nobody \(recorded\)$/,
        'the requester is marked as the API\'s and kept on one line');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a release whose context strategy throws still releases the hold it lifted (PR #251 review)', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 60_000);
    const { fw, internal } = await framework(path, membrane);
    const cm = fw.getAgent('resident')!.getContextManager() as unknown as { getStrategy(): unknown };
    const getStrategy = cm.getStrategy;
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model');
      cm.getStrategy = () => { throw new Error('zz strategy unavailable'); };
      const released = fw.releaseProviderWait('resident', 'zz-model', 'zz-operator');
      cm.getStrategy = getStrategy;
      assert.deepEqual(released.map((w) => w.model), ['zz-model']);
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'the hold is released');
      await waitFor(fw, () => membrane.primary >= 2, 'the held turn after the release');
    } finally { cm.getStrategy = getStrategy; await fw.stop(); log.restore(); }
  });
});

test('an explicit release reaches the compression lane with exactly its scope, even when no wait binds here', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    try {
      // The lane holds a pause the framework no longer has: no wait binds here
      // (as after the records read again, or a release in another process).
      const paused = new Set(['zz-model', 'zz-compression-model']);
      const asked: Array<string | undefined> = [];
      const strategy = fw.getAgent('resident')!.getContextManager().getStrategy() as unknown as { releaseCompressionPause?: (model?: string) => boolean };
      strategy.releaseCompressionPause = (model?: string) => {
        asked.push(model);
        if (model !== undefined) return paused.delete(model);
        const had = paused.size > 0; paused.clear(); return had;
      };
      const release = (model?: unknown) => internal.handleHostCommand('zz-surface', {
        command: 'release-provider-wait', agentName: 'resident', requesterName: 'zz-operator', ...(model === undefined ? {} : { model }),
      });
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'no wait binds here');

      const other = await release('zz-other');
      assert.deepEqual(other.released, [], 'the receipt lists only waits released here');
      assert.deepEqual(asked, ['zz-other'], 'the lane is asked with exactly the named model');
      assert.deepEqual([...paused].sort(), ['zz-compression-model', 'zz-model'], "other models' pauses stand");

      const named = await release('zz-model');
      assert.deepEqual(named.released, []);
      assert.deepEqual(asked, ['zz-other', 'zz-model']);
      assert.deepEqual([...paused], ['zz-compression-model'], 'the named pause is released, and only it');
      assert.ok(log.lines.some((line) => line.includes("model=zz-model compression lane's provider wait released")));

      const refused = await release('');
      assert.equal(refused.ok, false);
      assert.deepEqual(asked, ['zz-other', 'zz-model'], 'a refused release never reaches the lane');

      await release();
      assert.deepEqual(asked, ['zz-other', 'zz-model', undefined], 'an omitted model reaches it as every model');
      assert.equal(paused.size, 0);
    } finally { await fw.stop(); log.restore(); }
  });
});

// ---------------------------------------------------------------------------
// PR #251 review (2026-10-08): a negative stated wait means "retry now", and
// a hold a person has to judge is raised as an ops alert.
// ---------------------------------------------------------------------------

test('a primary 429 stating a negative retry-after is retried, not held until released', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, -1_000);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'no hold');
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'no wait binds');
      assert.equal(membrane.primary, 2, 'the error policy retried, and the retry recovered');
      assert.ok(!log.lines.some((line) => /\[provider-wait\].* holds /.test(line)), 'and nothing is logged as held');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("an organization-acceleration 429 stating a negative retry-after is paced as a stated 0, not by AF's default", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const stream = membrane.streamYielding.bind(membrane);
    membrane.streamYielding = (request: NormalizedRequest) => {
      if (membrane.primary === 0) { membrane.calls.push(request); membrane.primary++; return new ErrorStream(accelerationLimited(-1_000, request)); }
      return stream(request);
    };
    const { fw, internal } = await framework(path, membrane);
    internal.providerAccelerationDefaultCooldownMs = 60_000;
    internal.providerAccelerationJitterMs = 0;
    try {
      const before = Date.now();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const armedBy = Date.now();
      const hold = internal.providerAccelerationCooldowns.get('resident')!;
      assert.ok(hold.until >= before + 1_000 && hold.until <= armedBy + 1_000, `held ${hold.until - before} ms: the 1 s floor, not the 60 s default`);
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'no wait binds');
      await waitFor(fw, () => membrane.primary >= 2, 'the held turn after the hold');
      assert.equal(membrane.primary, 2, 'the held turn runs once the hold passes');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a stated wait held until released, or for more than an hour, raises an ops alert when it is recorded', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    const alerts: Array<{ kind: string; agentName: string; message: string; data?: Record<string, unknown> }> = [];
    fw.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event); });
    const logged: Array<Record<string, unknown>> = [];
    (fw as unknown as { logFailure(record: Record<string, unknown>): void }).logFailure = (record) => { logged.push(record); };
    const aux = internal.auxiliaryMembraneFor('resident');
    const stated = async (model: string, retryAfterMs: number) => {
      membrane.auxiliaryFailure = rateLimited(retryAfterMs);
      return aux.complete(auxRequest(model)).then(() => undefined, (error: unknown) => error);
    };
    try {
      await stated('zz-minute', 60_000);
      await stated('zz-hour', 3_600_000);
      await stated('zz-retry-now', -1_000);
      assert.equal(alerts.length, 0, 'a wait that passes within the hour is pacing: no alert');

      const before = Date.now();
      await stated('zz-day', 24 * 3_600_000);
      await stated('zz-beyond-a-date', 1e20);
      await stated('zz-nan', Number.NaN);
      assert.deepEqual(alerts.map((alert) => [alert.kind, alert.agentName, alert.data?.model]), [
        ['provider-wait', 'resident', 'zz-day'],
        ['provider-wait', 'resident', 'zz-beyond-a-date'],
        ['provider-wait', 'resident', 'zz-nan'],
      ]);
      assert.ok(Date.parse(String(alerts[0].data?.until)) >= before + 24 * 3_600_000, 'the day-long wait names its end');
      assert.equal(alerts[1].data?.until, null, 'held until released');
      assert.equal(alerts[2].data?.until, null, 'held until released');
      assert.match(alerts[0].message, /release-provider-wait/);
      assert.deepEqual(logged.map((record) => [record.kind, record.model]), [
        ['provider-wait', 'zz-day'], ['provider-wait', 'zz-beyond-a-date'], ['provider-wait', 'zz-nan'],
      ], 'each is also a failures.log record');

      const refused = await stated('zz-day', 24 * 3_600_000);
      assert.equal((refused as { providerAdmission?: string }).providerAdmission, 'deferred', 'a held model is not called again');
      assert.equal(alerts.length, 3, 'so its alert is raised once');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('unreadable recorded waits raise an ops alert for the whole framework as the hold begins', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    // A record from a reader this one does not know (a newer framework, say):
    // re-reading never fixes it, so only a person can end the hold.
    const store = JsStore.openOrCreate({ path });
    store.appendJson(PROVIDER_WAIT_RECORD_TYPE, { kind: 'paused', agent: 'resident', model: 'zz-model', at: 1 });
    store.close();
    // Construction reads the records before any trace listener can attach:
    // failures.log (and the webhook) carry it then.
    const proto = AgentFramework.prototype as unknown as { logFailure(record: Record<string, unknown>): void };
    const logFailure = proto.logFailure;
    const logged: Array<Record<string, unknown>> = [];
    proto.logFailure = (record) => { logged.push(record); };
    let opened: Awaited<ReturnType<typeof framework>> | undefined;
    try {
      opened = await framework(path, new WaitingMembrane(0, undefined));
      const alerts = logged.filter((record) => record.kind === 'provider-wait');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].agent, 'framework');
      assert.equal(alerts[0].model, '*');
      assert.equal(alerts[0].until, null);
      assert.match(String(alerts[0].reason), /could not be read \(provider-wait record .* is malformed\): no provider call is admitted for any agent/);
      assert.deepEqual(opened.fw.providerWaitSnapshot('resident').map((wait) => [wait.model, wait.until]), [['*', null]], 'and the hold stands');
    } finally {
      proto.logFailure = logFailure;
      await opened?.fw.stop();
      log.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The paths that don't own provider admission (membrane #56 review, M3): a
// conversation agent's turn and an ephemeral run never sleep a stated wait
// for hours, silently. Each is reached at both retry sites: driveStream's
// error case (a stream's error event) and beginAgentTurn's catch (a failure
// before the stream exists, here thrown from streamYielding).
// ---------------------------------------------------------------------------

/** A stream whose iteration throws, instead of yielding an error event:
 *  driveStream's catch, the third failure site. */
class ThrowingStream extends ErrorStream {
  constructor(private readonly thrown: Error) { super(thrown); }
  override async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    throw this.thrown;
  }
}

type Site = 'stream' | 'setup' | 'throw';

/** Fails its first `failing` calls with `fail()` at `site`, then succeeds. */
class FailingAt extends WaitingMembrane {
  constructor(private readonly failing: number, private readonly site: Site, private readonly fail: () => Error) { super(0, undefined); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.primary++;
    if (this.primary <= this.failing) {
      if (this.site === 'setup') throw this.fail();
      if (this.site === 'throw') return new ThrowingStream(this.fail());
      return new ErrorStream(this.fail());
    }
    return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'zz-recovered' }])]);
  }
}

type NonOwning = Internal & {
  conversationAgentHomes: Map<string, string>;
  retryWaitWakers: Set<() => void>;
  pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number }>;
  startAgentStream(agent: unknown, trigger: unknown): Promise<void>;
  disposeConversationAgent(agentName: string): void;
};

/** The framework's one in-flight runUntilIdle, shared: two at once would
 *  run its event loop concurrently. */
const driving = new WeakMap<AgentFramework, Promise<void>>();
function drive(fw: AgentFramework): Promise<void> {
  let run = driving.get(fw);
  if (!run) {
    run = fw.runUntilIdle().catch(() => {}).finally(() => { driving.delete(fw); });
    driving.set(fw, run);
  }
  return run;
}

/** Poll for `done`, driving the framework, with time only as an outer bound:
 *  a turn asleep in a retry wait keeps the drive busy, and that must fail the
 *  test, not hang it. The bound runs on performance.now(), which a test that
 *  holds Date still doesn't hold. */
async function waitFor(fw: AgentFramework, done: () => boolean, what: string, boundMs = 5_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (!done()) {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`zz-timeout: ${what} did not happen within ${boundMs} ms`);
    // Not awaited: the poll's own sleep lets timers run (a drive with nothing
    // to do settles in microtasks, which would starve them).
    void drive(fw);
    await sleep(Math.min(20, left));
  }
}

async function conversationTurn(fw: AgentFramework, internal: NonOwning, text: string): Promise<void> {
  internal.conversationAgentHomes.set('resident', 'world:zz');
  fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text }]);
  await internal.startAgentStream(fw.getAgent('resident'), { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
}

for (const site of ['stream', 'setup', 'throw'] as const) {
  test(`a conversation agent treats a stated wait as a resident does (${site}): recorded, held without a retry in the turn, resumed once after it`, async (t) => {
    await withStoreDir(async (path) => {
      const clock = holdClock(t);
      const wait = 400;
      const log = silence();
      const membrane = new FailingAt(1, site, () => rateLimited(wait));
      const { fw, internal } = await framework(path, membrane);
      const nonOwning = internal as NonOwning;
      const exhausted: unknown[] = [];
      fw.onTrace((event) => { if (event.type === 'inference:exhausted') exhausted.push(event); });
      try {
        await conversationTurn(fw, nonOwning, 'zz-first');
        await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the hold');
        assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model');
        assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the turn');
        assert.equal(membrane.primary, 1, 'no retry slept inside the turn');
        assert.deepEqual(fw.providerWaitSnapshot('resident').map((stated) => stated.model), ['zz-model'], 'the wait is recorded');
        await drive(fw);
        assert.deepEqual(exhausted, [], 'a held turn is not settled as exhausted');

        // Real time passes the wait, as on a loaded host, and the turn stays held.
        await clock.outlast(wait);
        assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'the hold stands while the clock is inside the wait');
        assert.equal(membrane.primary, 1, 'still held while the clock is inside the wait');

        clock.pass(wait);
        await waitFor(fw, () => membrane.primary >= 2, 'the fresh compile after the wait');
        assert.equal(membrane.primary, 2, 'exactly one');
        assert.match(membrane.calls[1].messages.flatMap((m) => m.content).map((b) => (b as { text?: string }).text ?? '').join('\n'), /zz-first/);
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

test("a conversation agent's stated wait past an hour raises one ops alert and holds until an operator releases it", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new FailingAt(1, 'stream', () => rateLimited(2 * 3_600_000));
    const { fw, internal } = await framework(path, membrane);
    const alerts: Array<{ kind: string; agentName: string; message: string }> = [];
    fw.onTrace((event) => { if (event.type === 'ops:alert') alerts.push(event as unknown as { kind: string; agentName: string; message: string }); });
    try {
      await conversationTurn(fw, internal as NonOwning, 'zz-first');
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the hold');
      assert.equal(membrane.primary, 1, 'two hours are not slept in the turn');
      assert.deepEqual(alerts.map((alert) => [alert.kind, alert.agentName]), [['provider-wait', 'resident']]);
      assert.match(alerts[0].message, /release-provider-wait/);

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', model: 'zz-model', requesterName: 'zz-operator' });
      assert.equal(released.ok, true);
      await waitFor(fw, () => membrane.primary >= 2, 'the held turn after the release');
      assert.equal(membrane.primary, 2);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent's non-retryable failure that states a wait records it and isn't held; the wait holds the wake after it", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const refused = () => new MembraneError({
      type: 'rate_limit', retryable: false, httpStatus: 429, retryAfterMs: wait,
      message: 'zz refused, with a hint', rawError: { status: 429 },
    });
    const membrane = new FailingAt(1, 'stream', refused);
    const { fw, internal } = await framework(path, membrane);
    const nonOwning = internal as NonOwning;
    try {
      await conversationTurn(fw, nonOwning, 'zz-first');
      await waitFor(fw, () => fw.providerWaitSnapshot('resident').length > 0, 'the recorded wait');
      await drive(fw);
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'a terminal failure is not held');
      assert.equal(membrane.primary, 1, 'nor retried');

      // Real time passes the wait before the next wake, as on a loaded host.
      await clock.outlast(wait);
      nonOwning.pendingRequests.push({ agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      await drive(fw);
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model', 'the next wake is held by the recorded wait');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the wake');
      assert.equal(membrane.primary, 1);
      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the held wake after the wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a conversation agent closed during a stated-wait hold takes the hold with it: nothing is requeued for it past the deadline', async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    const membrane = new FailingAt(1, 'stream', () => rateLimited(wait));
    const { fw, internal } = await framework(path, membrane);
    const nonOwning = internal as NonOwning;
    try {
      await conversationTurn(fw, nonOwning, 'zz-first');
      // Real time passes the wait before the test looks for the hold, as on
      // a loaded host; the clock stays inside it, so the hold is there.
      await clock.outlast(wait);
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the hold');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the turn');
      nonOwning.disposeConversationAgent('resident');
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'the hold goes with the agent');

      // Past the moment its timer would have released it, on both clocks,
      // plus a few turns: the clock first, so a timer left behind fires past
      // the deadline.
      clock.pass(wait);
      await clock.outlast(wait);
      await sleep(50);
      assert.deepEqual(nonOwning.pendingRequests.filter((r) => r.agentName === 'resident'), [], 'nothing requeued for an agent that is gone');
      assert.equal(membrane.primary, 1);
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a conversation agent's retry is held at the last boundary by a wait recorded while it slept", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    // Shorter than the retry's 1 s sleep, so real time passes the wait
    // before the retry reaches its boundary, as load can; the clock stays
    // inside it.
    const wait = 400;
    const log = silence();
    // A failure with no stated wait: the error policy retries after 1 s.
    const flaky = () => new MembraneError({
      type: 'server', retryable: true, httpStatus: 500,
      message: 'zz overloaded, no hint', rawError: { status: 500 },
    });
    const membrane = new FailingAt(1, 'stream', flaky);
    const { fw, internal } = await framework(path, membrane);
    const nonOwning = internal as NonOwning;
    try {
      void conversationTurn(fw, nonOwning, 'zz-first').catch(() => {});
      await waitFor(fw, () => nonOwning.retryWaitWakers.size > 0, 'the turn asleep before its retry');
      // While the turn sleeps before its retry, a wait is recorded for its
      // model, as its own compression call's stated wait would be.
      internal.providerWaits.set('resident', 'zz-model', wait, 'zz recorded while the turn slept');
      await waitFor(fw, () => membrane.primary >= 2 || internal.providerAccelerationCooldowns.has('resident'),
        'the retry, sent or held');
      assert.equal(membrane.primary, 1, 'the retry is not sent inside the wait');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model', 'the retry is held by the wait');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the retry');

      clock.pass(wait);
      await waitFor(fw, () => membrane.primary >= 2, 'the held turn after the wait');
      assert.equal(membrane.primary, 2, 'exactly one call after the wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

for (const who of ['resident', 'conversation agent'] as const) {
  test(`a ${who}'s retry held at the last boundary leaves no inference open at the event gate`, async (t) => {
    await withStoreDir(async (path) => {
      holdClock(t);
      // Shorter than the retry's 1 s sleep, as in the test above.
      const wait = 400;
      const log = silence();
      // A setup failure with no stated wait: the error policy retries after 1 s.
      const flaky = () => new MembraneError({
        type: 'server', retryable: true, httpStatus: 500,
        message: 'zz overloaded, no hint', rawError: { status: 500 },
      });
      const membrane = new FailingAt(1, 'setup', flaky);
      const fw = await AgentFramework.create({
        storePath: path, membrane: membrane.asMembrane(),
        agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
        modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
        gate: { config: { policies: [], default: 'skip' } },
      });
      const internal = fw as unknown as NonOwning & { eventGate: { inferenceDiagnostics(): { inferring: string[] } } };
      try {
        if (who === 'resident') {
          // A scheduler wake (the gate's 'skip' default would drop an event).
          fw.getAgent('resident')!.getContextManager().addMessage('User', [{ type: 'text', text: 'zz-first' }]);
          internal.pendingRequests.push({ agentName: 'resident', reason: 'test', source: 'test', timestamp: Date.now() });
        } else void conversationTurn(fw, internal, 'zz-first').catch(() => {});
        await waitFor(fw, () => internal.retryWaitWakers.size > 0, 'the turn asleep before its retry');
        internal.providerWaits.set('resident', 'zz-model', wait, 'zz recorded while the turn slept');
        await waitFor(fw, () => membrane.primary >= 2 || internal.providerAccelerationCooldowns.has('resident'),
          'the retry, sent or held');
        assert.equal(membrane.primary, 1, 'the retry is held, not sent');
        // While a turn is open at the gate, every gate event buffers: a held
        // turn that left one open would stall every agent's wakes for the wait.
        assert.deepEqual(internal.eventGate.inferenceDiagnostics().inferring, [], 'the held turn leaves no inference open');
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

/** A direct message on an MCPL channel: with conversation routing, it spawns
 *  a conversation agent (a fork of the template) for its channel. */
function directMessage(channelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming', serverId: 'zz-server', channelId,
    messageId: `zz-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'zz-alice' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { mentioned: false, channel_type: 'im' },
    triggerInference: true,
  } as unknown as ProcessEvent;
}

test("a conversation agent's compression is refused by its own recorded wait, and records the wait its own call states, without a provider gate", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    // Conversation routing is deprecated (#235): creating it warns once.
    const warn = console.warn;
    console.warn = () => {};
    const membrane = new WaitingMembrane(0, undefined);
    const fw = await AgentFramework.create({
      storePath: path, membrane: membrane.asMembrane(),
      agents: [{ name: 'resident', model: 'zz-model', systemPrompt: 'system' }],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      conversations: { templateAgent: 'resident' },
    }).finally(() => { console.warn = warn; });
    const internal = fw as unknown as Internal & { providerGates: Map<string, unknown> };
    try {
      fw.pushEvent(directMessage('zz:D1', 'zz-hello'));
      await fw.runUntilIdle();
      const fork = 'conversation-zz-D1-g1';
      const agent = fw.getAgent(fork);
      assert.ok(agent, 'the direct message spawned a conversation agent');
      const compression = (agent.getContextManager() as unknown as {
        membrane: { complete(request: unknown): Promise<unknown> };
      }).membrane;

      internal.providerWaits.set(fork, 'zz-model', 60_000, 'zz held for the fork');
      const sent = membrane.auxiliary.length;
      await assert.rejects(compression.complete(auxRequest('zz-model')),
        (error: unknown) => (error as { providerAdmission?: string }).providerAdmission === 'deferred');
      assert.equal(membrane.auxiliary.length, sent, 'no call is made to the held model');
      await compression.complete(auxRequest('zz-other-model'));
      assert.equal(membrane.auxiliary.length, sent + 1, 'another model proceeds');

      membrane.auxiliaryFailure = rateLimited(60_000);
      await assert.rejects(compression.complete(auxRequest('zz-compression-model')), /zz rate limit reached/);
      assert.ok(fw.providerWaitSnapshot(fork).some((wait) => wait.model === 'zz-compression-model'),
        "the compression call's stated wait is recorded for the fork");
      assert.equal(internal.providerGates.has(fork), false, 'the fork takes no provider gate');
    } finally { await fw.stop(); log.restore(); }
  });
});

async function ephemeralRun(fw: AgentFramework, name: string) {
  const created = await fw.createEphemeralAgent({ name, model: 'zz-model', systemPrompt: 'Do the task.' });
  created.contextManager.addMessage('User', [{ type: 'text', text: 'zz-task' }]);
  const run = fw.runEphemeralToCompletion(created.agent, created.contextManager);
  const outcome = run.then((result) => ({ result }), (error: unknown) => ({ error: error as Error }));
  // Not awaited: a turn asleep in a retry wait would hold it until the wait ends.
  void drive(fw);
  // A run still asleep after this long is the defect itself: fail, don't hang.
  return Promise.race([outcome, sleep(5_000).then(() => ({ error: new Error('zz-unsettled: the run did not end within 5 s') }))]);
}

for (const site of ['stream', 'setup', 'throw'] as const) {
  test(`an ephemeral run whose stated wait is past the framework cap ends at once (${site}), saying why, and is never retried`, async () => {
    await withStoreDir(async (path) => {
      const log = silence();
      const membrane = new FailingAt(1, site, () => rateLimited(20 * 60_000));
      const { fw } = await framework(path, membrane);
      try {
        const outcome = await ephemeralRun(fw, `zz-ephemeral-long-${site}`);
        assert.ok('error' in outcome, 'the run ends with an error');
        assert.match(outcome.error.message, /zz rate limit reached/);
        assert.match(outcome.error.message, /the provider asked to wait 1200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now/);
        // Marked, so a host needn't read the words.
        assert.ok(outcome.error instanceof ProviderWaitNotSleptError, 'the rejection is a ProviderWaitNotSleptError');
        assert.equal(outcome.error.name, 'ProviderWaitNotSleptError');
        assert.equal(outcome.error.retryAfterMs, 20 * 60_000, 'it carries the stated wait');
        await sleep(100);
        assert.equal(membrane.primary, 1, 'no retry before the provider\'s time');
        assert.deepEqual(fw.providerWaitSnapshot(`zz-ephemeral-long-${site}`), [], 'nothing recorded for a single-use name');
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

// Each ending's words as published: a host may match them (connectome-host
// 0.10.2 does, one pattern per ending), so they don't change.
for (const [stated, says] of [
  [Number.NaN, /the provider's stated wait is not a number, and an ephemeral run sleeps only a stated wait of 600 s or less, so it ends now\)$/],
  [Number.POSITIVE_INFINITY, /the provider asked to wait longer than can be represented; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now\)$/],
] as const) {
  test(`an ephemeral run whose stated wait can't be represented (${stated}) ends at once too`, async () => {
    await withStoreDir(async (path) => {
      const log = silence();
      const membrane = new FailingAt(1, 'stream', () => rateLimited(stated));
      const { fw } = await framework(path, membrane);
      try {
        const outcome = await ephemeralRun(fw, `zz-ephemeral-${stated}`);
        assert.ok('error' in outcome, 'the run ends with an error');
        assert.match(outcome.error.message, says);
        assert.ok(outcome.error instanceof ProviderWaitNotSleptError);
        assert.equal(outcome.error.name, 'ProviderWaitNotSleptError');
        assert.ok(Object.is(outcome.error.retryAfterMs, stated), `it carries ${stated}, not ${outcome.error.retryAfterMs}`);
        assert.equal(membrane.primary, 1);
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

for (const [label, failure] of [
  ['refused', () => new MembraneError({
    type: 'invalid_request', retryable: false, httpStatus: 400,
    message: 'zz the request was refused', rawError: { status: 400 },
  })],
  // Not retryable, so its stated wait is no reason to wait: it ends as any failure does.
  ['not retryable, with a long stated wait', () => new MembraneError({
    type: 'invalid_request', retryable: false, httpStatus: 400, retryAfterMs: 20 * 60_000,
    message: 'zz the request was refused', rawError: { status: 400 },
  })],
] as const) {
  for (const site of ['stream', 'setup', 'throw'] as const) {
    test(`an ephemeral run that fails for another reason isn't marked as a stated wait (${label}, ${site})`, async () => {
      await withStoreDir(async (path) => {
        const log = silence();
        const membrane = new FailingAt(1, site, failure);
        const { fw } = await framework(path, membrane);
        try {
          const outcome = await ephemeralRun(fw, `zz-ephemeral-refused-${site}`);
          assert.ok('error' in outcome, 'the run ends with an error');
          assert.match(outcome.error.message, /zz the request was refused/);
          assert.doesNotMatch(outcome.error.message, /stated wait/);
          assert.ok(!(outcome.error instanceof ProviderWaitNotSleptError), 'a plain error');
          assert.equal(outcome.error.name, 'Error');
        } finally { await fw.stop(); log.restore(); }
      });
    });
  }
}

test('a stated wait just past the cap is named in whole seconds rounded up, past the cap', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new FailingAt(1, 'stream', () => rateLimited(600_001));
    const { fw } = await framework(path, membrane);
    try {
      const outcome = await ephemeralRun(fw, 'zz-ephemeral-just-past');
      assert.ok('error' in outcome, 'the run ends with an error');
      assert.match(outcome.error.message, /the provider asked to wait 601 s; an ephemeral run doesn't sleep a stated wait longer than 600 s/);
      assert.equal((outcome.error as ProviderWaitNotSleptError).retryAfterMs, 600_001);
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an ephemeral run sleeps a stated wait within the framework cap and retries', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new FailingAt(1, 'stream', () => rateLimited(300));
    const { fw } = await framework(path, membrane);
    try {
      const outcome = await ephemeralRun(fw, 'zz-ephemeral-short');
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.match(outcome.result.speech, /zz-recovered/);
      assert.equal(membrane.primary, 2, 'one retry, after the stated wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

/** Records a wait for the agent as membrane is handed the compiled request,
 *  as the agent's own compression call's stated wait would land while a turn
 *  compiles, and counts how often a stream is iterated: membrane sends then. */
class WaitDuringCompile extends WaitingMembrane {
  sent = 0;
  constructor(private readonly during: () => void) { super(0, undefined); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.during();
    const stream = super.streamYielding(request);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    Object.defineProperty(stream, Symbol.asyncIterator, { value: () => { this.sent++; return iterate(); } });
    return stream;
  }
}

test("a conversation agent's turn is held, sending nothing, when its own wait is recorded while the turn compiles", async (t) => {
  await withStoreDir(async (path) => {
    const clock = holdClock(t);
    const wait = 400;
    const log = silence();
    let record: (() => void) | undefined;
    const membrane = new WaitDuringCompile(() => { record?.(); record = undefined; });
    const { fw, internal } = await framework(path, membrane);
    record = () => internal.providerWaits.set('resident', 'zz-model', wait, 'zz recorded while the turn compiled');
    const nonOwning = internal as NonOwning;
    const traces: Array<{ type: string; error?: string }> = [];
    fw.onTrace((event) => {
      if (event.type.startsWith('inference:') && (event as { agentName?: string }).agentName === 'resident') traces.push(event as { type: string; error?: string });
    });
    try {
      await conversationTurn(fw, nonOwning, 'zz-first');
      assert.equal(membrane.sent, 0, 'nothing is sent into the wait');
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model', 'the turn is held, as at the boundary');
      assert.ok(log.lines.some((line) => /binds after the compile/.test(line)));
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.heldRequests.length, 1, 'the hold has the turn');
      // The turn started, so it ends with one terminal event, as a failure site's hold does.
      assert.deepEqual(traces.map((trace) => trace.type), ['inference:started', 'inference:failed']);
      assert.match(traces[1]!.error!, /^Provider wait: zz-model is held for resident until .*; no call was made$/);

      // Real time passes the wait, as on a loaded host, and the turn stays held.
      await clock.outlast(wait);
      assert.ok(internal.providerAccelerationCooldowns.has('resident'), 'the hold stands while the clock is inside the wait');
      assert.equal(membrane.sent, 0, 'still held while the clock is inside the wait');

      clock.pass(wait);
      await waitFor(fw, () => membrane.sent >= 1, 'the held turn after the wait');
      assert.equal(membrane.sent, 1, 'it is sent once, after the wait');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a release can name a disposed conversation agent whose wait the listing shows, and a name with neither is refused', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new FailingAt(1, 'stream', () => rateLimited(600_000));
    const { fw, internal } = await framework(path, membrane);
    const nonOwning = internal as NonOwning;
    const records = () => internal.store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length;
    try {
      await conversationTurn(fw, nonOwning, 'zz-first');
      await waitFor(fw, () => internal.providerAccelerationCooldowns.has('resident'), 'the hold');
      nonOwning.disposeConversationAgent('resident');
      assert.equal(fw.getAgent('resident'), null, 'the agent is gone');
      assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model'], 'its recorded wait is listed');
      const before = records();

      const refused = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'zz-typo', requesterName: 'zz-operator' });
      assert.equal(refused.ok, false, 'neither an agent nor the agent of a recorded wait');
      assert.match(String(refused.error), /Unknown agent/);
      assert.throws(() => fw.releaseProviderWait('zz-typo'), /Unknown agent/);
      assert.equal(records(), before, 'nothing is recorded for it');

      const released = await internal.handleHostCommand('zz-surface', { command: 'release-provider-wait', agentName: 'resident', requesterName: 'zz-operator' });
      assert.equal(released.ok, true, String(released.error));
      assert.deepEqual((released.released as Array<{ model: string; release: string }>).map((w) => [w.model, w.release]), [['zz-model', 'recorded']]);
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'what the listing showed is released');
      assert.equal(records(), before + 1, 'and the release is recorded');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('an ephemeral run is not held by the hold for unreadable records: it records nothing, so nothing is unknown for it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    try {
      unreadableWaits(internal);
      assert.ok(internal.providerWaits.active('resident', 'zz-model'), 'the records are unreadable, so a resident is held');
      const outcome = await ephemeralRun(fw, 'zz-ephemeral-unreadable');
      assert.ok('result' in outcome, `the run completes${'error' in outcome ? `: ${outcome.error.message}` : ''}`);
      assert.equal(membrane.primary, 1, 'its call went out');
    } finally { await fw.stop(); log.restore(); }
  });
});

test("the last boundary holds no agent the framework no longer has: a disposed fork's late retry installs no hold", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    const nonOwning = internal as NonOwning;
    try {
      const agent = fw.getAgent('resident')!;
      nonOwning.conversationAgentHomes.set('resident', 'world:zz');
      internal.providerWaits.set('resident', 'zz-model', 60_000, 'zz recorded for the fork');
      nonOwning.disposeConversationAgent('resident');
      // Its retry wakes after the disposal and reaches the boundary.
      await nonOwning.startAgentStream(agent, { agentName: 'resident', reason: 'conversation', source: 'test', timestamp: Date.now() });
      assert.equal(internal.providerAccelerationCooldowns.has('resident'), false, 'no hold under a name no agent has');
      assert.ok(!log.lines.some((line) => /binds at admission/.test(line)));
    } finally { await fw.stop(); log.restore(); }
  });
});

test("a provider's reason is kept on one line: a line break in it can't start a line of the framework's own", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const forged = () => new MembraneError({
      type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 60_000,
      message: 'zz rate limited\n[provider-wait] agent=resident model=zz-forged released by nobody', rawError: { status: 429 },
    });
    const membrane = new FailingAt(1, 'stream', forged);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      const [wait] = fw.providerWaitSnapshot('resident');
      assert.equal(wait?.reason, 'zz rate limited [provider-wait] agent=resident model=zz-forged released by nobody');
      const refusal = await internal.auxiliaryMembraneFor('resident').complete(auxRequest('zz-model')).then(() => undefined, (error: Error) => error);
      assert.ok(refusal && !/[\r\n]/.test(refusal.message), 'the refusal that quotes the reason is one line');
    } finally { await fw.stop(); log.restore(); }
  });
});

/** A MembraneError from another copy of membrane: the same name and fields,
 *  another class, as when the host's membrane isn't the framework's copy. */
const foreignRateLimit = (retryAfterMs: unknown) => Object.assign(new Error('zz rate limited, from another copy'), {
  name: 'MembraneError', type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs,
});

for (const who of ['resident', 'conversation agent', 'ephemeral run'] as const) {
  const outcome = who === 'ephemeral run' ? 'ends the run at once, marked' : 'is recorded, not slept in the turn';
  test(`a 429 from another copy of membrane that states a wait ${outcome} (${who})`, async () => {
    await withStoreDir(async (path) => {
      const log = silence();
      // An ephemeral run doesn't record: a wait past its cap ends it at once.
      const stated = who === 'ephemeral run' ? 1_200_000 : 400;
      const membrane = new FailingAt(1, 'stream', () => foreignRateLimit(stated));
      const { fw, internal } = await framework(path, membrane);
      const nonOwning = internal as NonOwning;
      try {
        if (who === 'ephemeral run') {
          const outcome = await ephemeralRun(fw, 'zz-ephemeral-foreign');
          assert.ok('error' in outcome, 'the run ends with an error');
          assert.match(outcome.error.message, /the provider asked to wait 1200 s/);
          assert.ok(outcome.error instanceof ProviderWaitNotSleptError);
          assert.equal(outcome.error.name, 'ProviderWaitNotSleptError');
          assert.equal(outcome.error.retryAfterMs, 1_200_000);
          assert.equal(membrane.primary, 1, 'never retried inside the stated wait');
          return;
        }
        if (who === 'resident') {
          fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
          await fw.runUntilIdle();
        } else {
          await conversationTurn(fw, nonOwning, 'zz-first');
        }
        assert.deepEqual(fw.providerWaitSnapshot('resident').map((w) => w.model), ['zz-model'], 'the stated wait is recorded');
        assert.equal(internal.providerAccelerationCooldowns.get('resident')?.waitModel, 'zz-model', 'the turn is held by it');
        assert.equal(membrane.primary, 1, 'not retried inside the wait');
        await waitFor(fw, () => membrane.primary >= 2, 'the held turn after the wait');
        assert.equal(membrane.primary, 2, 'run once after it');
      } finally { await fw.stop(); log.restore(); }
    });
  });
}

test('from another copy of membrane, a wait is stated only as a number, as the default policy reads it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const { fw, internal } = await framework(path, new WaitingMembrane(0, undefined));
    const paths = internal as unknown as {
      ephemeralRuns: Map<string, unknown>;
      recordProviderWait(agentName: string, model: string, error: Error): unknown;
      nonOwningProviderWait(agent: unknown, error: Error): 'held' | 'fail' | undefined;
    };
    const name = 'zz-ephemeral-unstated';
    try {
      const created = await fw.createEphemeralAgent({ name, model: 'zz-model', systemPrompt: 'Do the task.' });
      paths.ephemeralRuns.set(name, {});
      for (const unstated of [null, '1200000', undefined]) {
        const label = `retryAfterMs ${JSON.stringify(unstated)}`;
        assert.equal(paths.recordProviderWait('resident', 'zz-model', foreignRateLimit(unstated)), undefined, `recorded: ${label}`);
        assert.equal(paths.nonOwningProviderWait(created.agent, foreignRateLimit(unstated)), undefined, `left to the policy: ${label}`);
      }
      assert.deepEqual(fw.providerWaitSnapshot('resident'), [], 'nothing is held, least of all until released');
      assert.ok(paths.recordProviderWait('resident', 'zz-model', foreignRateLimit(60_000)), 'a number is a stated wait');
      assert.equal(paths.nonOwningProviderWait(created.agent, foreignRateLimit(1_200_000)), 'fail', 'and past the cap ends the run');
    } finally { paths.ephemeralRuns.delete(name); await fw.stop(); log.restore(); }
  });
});
