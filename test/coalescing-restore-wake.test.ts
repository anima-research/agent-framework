/**
 * A batch restored from the coalescing snapshot still owes its agent a wake
 * (RFC-006 §14 v41), asked for at boot with nothing awaiting it. A wake that
 * fails there is logged, never left as an unhandled rejection, which Node's
 * default mode turns into the host's exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/index.js';
import { fixture, eventually, crash } from './helpers/coalescing-fixture.js';

test('a restored batch whose wake fails is logged, not left unhandled', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'restored_batch', { deferred: true, initial: true }));
  await crash(f);
  const proto = AgentFramework.prototype as unknown as { queueCoalescedWakes: (...args: unknown[]) => Promise<void> };
  const queueCoalescedWakes = proto.queueCoalescedWakes;
  proto.queueCoalescedWakes = () => Promise.reject(new Error('the wake could not be queued'));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await f.create();
    await eventually(() => logged.some((line) => line.includes('the wake could not be queued')), 'the failed wake logged');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    proto.queueCoalescedWakes = queueCoalescedWakes;
    process.off('unhandledRejection', onUnhandled);
    console.error = consoleError;
  }
  assert.deepEqual(unhandled, []);
});
