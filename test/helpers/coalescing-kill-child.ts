/**
 * Subprocess for the SIGKILL durability tests (test/mcpl-coalescing.test.ts,
 * round 5): runs the fixture on the given store directory, reaches the
 * requested boundary, reports over IPC, and then waits to be killed. No
 * stop(), no close(), no sync() of its own.
 */
import { fixture } from './coalescing-fixture.js';

const [dir, mode] = process.argv.slice(2);
const f = await fixture({ dir });
if (mode === 'accept') {
  const r = await f.send('push/event', f.params('1', 'killed_fallback', { deferred: true, data: { k: 'v' } }));
  process.send!({ port: f.port, receipt: r.result });
} else {
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  f.renderer(() => { reached(); return new Promise(() => { /* held until the kill */ }); });
  await f.send('push/event', f.params('1', 'render_fallback', { deferred: true }));
  void f.framework.runUntilIdle();
  await started;
  process.send!({ port: f.port, receipt: null });
}
await new Promise(() => { /* wait for SIGKILL */ });
