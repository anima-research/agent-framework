/**
 * The handshake a watcher test makes, on either of chokidar's backends, before
 * it writes what it means to hear: changesFlow, and the probe files it writes
 * (isProbe).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FsChange } from '../../src/modules/workspace/watcher.js';

/** How long changesFlow waits in all, as long as a watcher test waits for an event. */
const EVENT_MS = 10_000;

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

// The probe files changesFlow writes, which a test's results leave out by name.
const PROBE_PREFIX = 'probe-';
export const isProbe = (path: string): boolean => basename(path).startsWith(PROBE_PREFIX);

/**
 * Waits until the watcher reports a change in each of `dirs`, relative to the
 * mount's root `root` (the root itself when `dirs` names none), so what a test
 * writes there next is written while changes are delivered. `onReady` says
 * chokidar's first scan is done, not that the platform delivers events yet. By
 * our reading of libuv, on macOS `fs.watch` of a directory returns before
 * libuv's own thread has made the FSEventStream that reports it, a stream that
 * starts "since now" and is made again for every watched directory each time
 * one is added. So a file written in between isn't reported until a later
 * change in its directory, when chokidar reads the directory again, and a probe
 * reported in one directory can come from a stream made before another
 * directory's watch. chokidar's polling backend starts a directory's poll just
 * before `onReady` too, and the poll's first stat is what each later one is
 * compared with, so a file written before that stat is never reported. Each
 * attempt writes a new probe in each directory still unreported and waits up
 * to a second, since the next probe is that later change. The probes stay in
 * the batches, and a test's results leave them out (isProbe).
 */
export async function changesFlow(root: string, batches: FsChange[][], dirs: readonly string[]): Promise<void> {
  const where = dirs.length ? dirs : [''];
  const start = Date.now();
  const left = () => Date.now() - start < EVENT_MS;
  const reportedIn = (dir: string) => batches.flat().some((c) => isProbe(c.path) && dirname(c.path) === (dir || '.'));
  for (let n = 0; left(); n++) {
    for (const dir of where) if (!reportedIn(dir)) writeFileSync(join(root, dir, `${PROBE_PREFIX}${n}.txt`), String(n));
    for (const attempt = Date.now(); Date.now() - attempt < 1_000 && left(); await wait(25)) {
      if (where.every(reportedIn)) return;
    }
  }
  const seen = [...new Set(batches.flat().map((c) => c.path))];
  assert.fail(`expected the watcher to report a probe in each of ${where.map((d) => d || '.').join(', ')}; it reported ${seen.join(', ') || 'nothing'}`);
}
