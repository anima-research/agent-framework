import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptRun } from '../src/code-execution/script-run.js';
import type { ExecResult } from '../src/code-execution/py-runner.js';

function harness() {
  let complete!: (result: ExecResult) => void;
  const notifications: boolean[] = [];
  const result = { stdout: 'done', stderr: '', returnCode: 0 };
  const run = new ScriptRun(new Promise<ExecResult>(r => { complete = r; }),
    (_result, notify) => { notifications.push(notify); });
  return { run, complete: () => complete(result), notifications, result };
}

describe('ScriptRun observation lifecycle', () => {
  it('completion within budget returns directly and does not request another turn', async () => {
    const h = harness();
    const wait = h.run.observe(10_000, 'end_turn');
    h.complete();
    assert.deepEqual(await wait, { result: h.result, endTurn: false });
    assert.deepEqual(h.notifications, [false]);
  });

  it('zero-budget yield arms completion before returning endTurn', async () => {
    const h = harness();
    assert.deepEqual(await h.run.observe(0, 'end_turn'), { result: undefined, endTurn: true });
    h.complete();
    await Promise.resolve();
    assert.deepEqual(h.notifications, [true]);
    assert.deepEqual(await h.run.observe(0, 'continue'), { result: h.result, endTurn: false });
    assert.deepEqual(h.notifications, [true], 'retrieval must not wake again');
  });

  it('a timed wait releases inference without settling execution', async () => {
    const h = harness();
    assert.deepEqual(await h.run.observe(10, 'continue'), { result: undefined, endTurn: false });
    assert.equal(h.run.result, undefined);
    h.complete();
    await Promise.resolve();
    assert.deepEqual(h.notifications, [true]);
  });

  it('rejoining before completion consumes the result without an extra wake', async () => {
    const h = harness();
    await h.run.observe(0, 'continue');
    const wait = h.run.observe(10_000, 'end_turn');
    h.complete();
    assert.equal((await wait).result, h.result);
    assert.deepEqual(h.notifications, [false]);
  });

  it('an unbounded observation waits for completion instead of timing out', async () => {
    const h = harness();
    let settled = false;
    const wait = h.run.observe(Infinity, 'continue').then((o) => { settled = true; return o; });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(settled, false, 'Infinity must not become an immediate timer');
    h.complete();
    assert.deepEqual(await wait, { result: h.result, endTurn: false });
    assert.deepEqual(h.notifications, [false]);
  });

  it('a rejected completion settles as a failed result instead of leaving the run pending', async () => {
    const notifications: boolean[] = [];
    const run = new ScriptRun(Promise.reject(new Error('runner broke')), (_r, notify) => { notifications.push(notify); });
    const observed = await Promise.race([
      run.observe(Infinity, 'continue'),
      new Promise<'pending'>(r => setTimeout(() => r('pending'), 500)),
    ]);
    assert.notEqual(observed, 'pending');
    const result = (observed as { result?: ExecResult }).result!;
    assert.equal(result.returnCode, 1);
    assert.equal(result.aborted, true);
    assert.match(result.stderr, /runner broke/);
    assert.deepEqual(notifications, [false]);
  });

  it('operator release ends all active observations and leaves execution alive', async () => {
    const h = harness();
    const a = h.run.observe(60_000, 'continue');
    const b = h.run.observe(60_000, 'continue');
    assert.equal(h.run.release(), 2);
    assert.equal(h.run.release(), 0);
    assert.equal((await a).endTurn, true);
    assert.equal((await b).endTurn, true);
    h.complete();
    await Promise.resolve();
    assert.deepEqual(h.notifications, [true]);
  });
});
