/**
 * Provider waits: a provider's stated retry-after is a lower bound on the next
 * call to that model, for that agent, across restarts and branch switches.
 *
 * Unit cases drive ProviderWaits on a real Chronicle store; framework cases
 * drive a real AgentFramework whose membrane answers with classified errors
 * carrying retryAfterMs.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, ApiServer } from '../src/index.js';
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
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e20, '60', undefined]) {
      assert.equal(waitDeadline(unusable, 1_000), null, String(unusable));
    }
    assert.equal(waitDeadline(8.64e15 - 1_000, 1_000), 8.64e15, 'the last representable instant');
    assert.equal(waitDeadline(8.64e15, 1_000), null, 'one past it');
  });

  it('is the moment it was stated for a negative wait: already over, never held (PR #251 review)', () => {
    for (const negative of [-1, -1_000, -0.4, -0, -1e20, -Number.MAX_VALUE]) {
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
      for (const stated of [-1, -1_000]) {
        waits.set('ada', 'zz-model', stated, `retry now (${stated})`);
        assert.equal(waits.active('ada', 'zz-model'), undefined, `${stated} binds nothing`);
      }
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
  const fail = { appendJson: 0, sync: 0, read: false };
  const surface = {
    getRecordIdsByType: (type: string) => { if (fail.read) throw new Error('zz unreadable record'); return store.getRecordIdsByType(type); },
    getRecord: (id: string) => store.getRecord(id),
    appendJson: (type: string, data: unknown) => { if (fail.appendJson > 0) { fail.appendJson--; throw new Error('zz append refused'); } return store.appendJson(type, data); },
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

  it('an unrecorded binding wait is recorded at the next act, even one that leaves the binding unchanged', () => withStoreDir((path) => {
    const time = clock();
    let store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      fail.appendJson = 1; // refused before reaching the store
      assert.equal(waits.set('ada', 'zz-model', Number.POSITIVE_INFINITY, 'zz indefinite').wait.until, null);
      assert.equal(store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length, 0, 'nothing recorded yet');
      const shorter = waits.set('ada', 'zz-model', 1_000, 'zz shorter');
      assert.equal(shorter.changed, false);
      assert.equal(shorter.wait.until, null, 'the indefinite wait still binds');
      assert.equal(store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length, 1, 'the pending set was recorded by the later act');
      store.close();

      store = JsStore.openOrCreate({ path });
      assert.equal(new ProviderWaits(store, { now: time.now, ...quiet }).active('ada', 'zz-model')?.until, null, 'and survives a reopen');
    } finally { if (!store.isClosed()) store.close(); }
  }));

  it('absent any later act, an unrecorded wait is offered again from admission checks', () => withStoreDir((path) => {
    const time = clock();
    const store = JsStore.openOrCreate({ path });
    try {
      const { surface, fail } = flaky(store);
      const waits = new ProviderWaits(surface, { now: time.now, ...quiet });
      fail.appendJson = 1;
      waits.set('ada', 'zz-model', 3_600_000, 'zz 429');
      waits.active('ada', 'zz-model');
      assert.equal(store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length, 0, 'not retried at once');
      time.advance(30_000);
      waits.active('ada', 'zz-model');
      assert.equal(store.getRecordIdsByType(PROVIDER_WAIT_RECORD_TYPE).length, 1, 'retried after the interval');
    } finally { store.close(); }
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

test('a primary 429 with retry-after holds the turn, without a failure marker, and resumes once after it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 400);
    const { fw, internal } = await framework(path, membrane);
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'no retry inside the wait');
      assert.equal(internal.consecutiveInferenceFailures.get('resident') ?? 0, 0, 'capacity is not a failure streak');
      const health = fw.healthSnapshot() as { agents: Array<{ providerAdmission: { providerWaits: Array<{ model: string; until: string | null }> } }> };
      assert.equal(health.agents[0].providerAdmission.providerWaits[0].model, 'zz-model');

      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-arrived while waiting', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'an arrival during the wait is held, not inferred');

      await sleep(550);
      await fw.runUntilIdle();
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

test('a retry policy delay past one timer is waited in full, and stop() ends the wait', async () => {
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
        onInferenceError: (_e: Error, _a: string, attempt: number) => (attempt < 2 ? { retry: true, delayMs: 3_000_000_000 } : { retry: false }),
      },
    });
    let stopped = false;
    try {
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      void fw.runUntilIdle();
      await sleep(300);
      assert.equal(membrane.primary, 1, 'a 34-day delay does not fire almost at once');
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

test('a non-retryable failure with a stated wait keeps its terminal disposition; the wait binds the calls after it', async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(1, 400);
    // The first primary call is refused outright (not retryable), with a hint.
    const refuse = (request: NormalizedRequest) => new MembraneError({
      type: 'invalid_request', retryable: false, httpStatus: 400, retryAfterMs: 400,
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

      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-during the wait', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 1, 'a later wake is held by the stated wait');

      await sleep(550);
      await fw.runUntilIdle();
      assert.equal(membrane.primary, 2, 'and runs once after it');
    } finally { await fw.stop(); log.restore(); }
  });
});

test('a primary wake parked behind an auxiliary call is held by the wait that call\'s failure records', async () => {
  await withStoreDir(async (path) => {
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

      fail(rateLimited(400));
      await aux;
      await sleep(100);
      assert.equal(membrane.primary, 0, 'not started into the wait its parked-behind call recorded');
      assert.ok(log.lines.some((line) => /binds at admission/.test(line)));

      await sleep(500);
      await fw.runUntilIdle();
      await run;
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

test("once the records read again, a hold takes the recorded wait's deadline: it neither stays indefinite nor ends early", async () => {
  await withStoreDir(async (path) => {
    const log = silence();
    const membrane = new WaitingMembrane(0, undefined);
    const { fw, internal } = await framework(path, membrane);
    try {
      const recorded = internal.providerWaits.set('resident', 'zz-model', 900, 'zz recorded before the reads failed').wait;
      const fail = unreadableWaits(internal);
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'zz-first', metadata: {} });
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, Number.POSITIVE_INFINITY);

      await sleep(100);
      fail.read = false;
      await sleep(200);
      await fw.runUntilIdle();
      assert.equal(internal.providerAccelerationCooldowns.get('resident')?.until, recorded.until, 'the recorded deadline, not the stand-in');
      assert.equal(membrane.primary, 0, 'and not before it');

      await sleep(Math.max(0, recorded.until! - Date.now()) + 150);
      await fw.runUntilIdle();
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

      await sleep(Math.max(0, paced.until - Date.now()) + 150);
      await fw.runUntilIdle();
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
      for (const model of ['', null, 42, ['zz-model'], {}]) {
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
      await sleep(Math.max(0, hold.until - Date.now()) + 150);
      await fw.runUntilIdle();
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
