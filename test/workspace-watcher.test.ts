import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MountWatcher, type FsChange, type WatcherLifecycle } from '../src/modules/workspace/watcher.js';
import type { MountConfig } from '../src/modules/workspace/types.js';

// Much shorter than the watcher's defaults (a 300 ms debounce, a 2 s root
// poll), so a test isn't waiting on production timing.
const DEBOUNCE_MS = 50;
const WATCH_ROOT_POLL_MS = 50;
// After an end-to-end test's batch, how long it watches for a second entry
// for the same path: chokidar's awaitWriteFinish (stabilityThreshold 100)
// plus our debounce, with room to spare.
const SETTLE_MS = 350;
// How long a test waits for something it needs to happen (the watcher ready,
// a reattach, a change's batch) before it fails: far past what any of it
// takes here.
const EVENT_MS = 10_000;

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mw-test-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(): MountConfig {
  return {
    name: 'test',
    path: tmp,
    mode: 'read-write',
    watch: 'always',
    watchDebounceMs: DEBOUNCE_MS,
    watchRootPollMs: WATCH_ROOT_POLL_MS,
  };
}

function collect(
  lifecycle?: WatcherLifecycle,
  config: MountConfig = makeConfig(),
): { watcher: MountWatcher; batches: FsChange[][] } {
  const batches: FsChange[][] = [];
  const watcher = new MountWatcher(config, (changes) => {
    batches.push(changes);
  }, lifecycle);
  watcher.start();
  return { watcher, batches };
}

function withChokidarBackend<T>(usePolling: boolean, start: () => T): T {
  const previousUsePolling = process.env.CHOKIDAR_USEPOLLING;
  const previousInterval = process.env.CHOKIDAR_INTERVAL;
  process.env.CHOKIDAR_USEPOLLING = String(usePolling);
  if (usePolling) process.env.CHOKIDAR_INTERVAL = '25';
  try {
    return start();
  } finally {
    if (previousUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = previousUsePolling;
    if (previousInterval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = previousInterval;
  }
}

function withPollingBackend<T>(start: () => T): T {
  return withChokidarBackend(true, start);
}

function withNativeBackend<T>(start: () => T): T {
  return withChokidarBackend(false, start);
}

function collectWithPolling(lifecycle?: WatcherLifecycle): {
  watcher: MountWatcher;
  batches: FsChange[][];
} {
  return withPollingBackend(() => collect(lifecycle));
}

function collectWithNative(
  lifecycle?: WatcherLifecycle,
  config?: MountConfig,
): { watcher: MountWatcher; batches: FsChange[][] } {
  return withNativeBackend(() => collect(lifecycle, config));
}

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = EVENT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  assert.fail(message);
}

/**
 * A polling watcher, once chokidar's first scan is done. A change made before
 * then can be part of the files chokidar starts from (ignoreInitial), and is
 * then never reported. If the watcher has reported an error and isn't ready
 * when the wait checks, the wait fails with that error, and a watcher that
 * doesn't get ready is stopped.
 */
async function readyWithPolling(): Promise<{ watcher: MountWatcher; batches: FsChange[][] }> {
  let ready = false;
  let failed: Error | undefined;
  const collected = collectWithPolling({ onReady: () => { ready = true; }, onError: (err) => { failed ??= err; } });
  try {
    await waitFor(() => ready || failed !== undefined, 'expected the watcher to be ready');
    if (!ready) throw failed;
  } catch (error) {
    await collected.watcher.stop();
    throw error;
  }
  return collected;
}

/**
 * Waits until a batch names `path`, with `op` when one is given: the batch is
 * what a test's assertions read.
 */
async function changeFor(batches: FsChange[][], path: string, op?: FsChange['op']): Promise<void> {
  await waitFor(
    () => batches.flat().some(c => c.path === path && (op === undefined || c.op === op)),
    `expected ${op ? `a ${op} entry` : 'a change'} for ${path}`,
  );
}

/**
 * Hands the watcher chokidar's events for paths under the mount, as chokidar
 * reports them: chokidar's FSWatcher is an EventEmitter, and its own
 * emitWithAll calls emit. So a test can show how events merge with no file
 * system timing in it.
 */
function emitChokidar(watcher: MountWatcher, events: Array<['add' | 'change' | 'unlink', string]>): void {
  const chokidar = (watcher as unknown as { watcher: { emit(event: string, path: string): boolean } }).watcher;
  for (const [event, path] of events) chokidar.emit(event, join(tmp, path));
}

describe('MountWatcher mergeOp', () => {
  // Each merge rule, from chokidar's events handed in within one debounce
  // window: what the batch says once the window closes. Nothing else changes
  // the directory, so that batch is the only one, and no window is needed
  // after it. They use the polling backend, since they need no real events.
  for (const [name, events, op] of [
    ['an unlink then an add → modified (atomic save)', [['unlink', 'a.md'], ['add', 'a.md']], 'modified'],
    ['an add then a change → created (still new)', [['add', 'a.md'], ['change', 'a.md']], 'created'],
    ['an add then an unlink → deleted (a trailing delete wins)', [['add', 'a.md'], ['unlink', 'a.md']], 'deleted'],
  ] as Array<[string, Array<['add' | 'change' | 'unlink', string]>, FsChange['op']]>) {
    it(name, async () => {
      const { watcher, batches } = collectWithPolling();
      try {
        emitChokidar(watcher, events);
        await changeFor(batches, 'a.md');
      } finally {
        await watcher.stop();
      }
      assert.deepStrictEqual(batches, [[{ path: 'a.md', op }]]);
    });
  }

  // End to end, under polling: what a real save comes out as, one entry with
  // the right op. Both steps run in one synchronous stretch, so a poll sees
  // the state between them only if its stat lands there, and these pass with
  // any merge rule removed: the rule tests above pin the merges. Each then
  // watches SETTLE_MS more for a second entry for the file.
  it('an atomic save (unlink, then write) comes out as one modified entry', async () => {
    const file = join(tmp, 'ticket.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = await readyWithPolling();

    try {
      unlinkSync(file);
      writeFileSync(file, 'v2');

      // Its batch, then SETTLE_MS more to see any second entry.
      await changeFor(batches, 'ticket.md');
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }

    const flat = batches.flat();
    const forFile = flat.filter(c => c.path === 'ticket.md');
    assert.strictEqual(forFile.length, 1, `expected 1 change, got ${JSON.stringify(flat)}`);
    assert.strictEqual(forFile[0].op, 'modified');
  });

  it('a new file written twice comes out as one created entry', async () => {
    const { watcher, batches } = await readyWithPolling();

    try {
      const file = join(tmp, 'new.md');
      writeFileSync(file, 'hello');
      writeFileSync(file, 'hello updated');

      await changeFor(batches, 'new.md');
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }

    const forFile = batches.flat().filter(c => c.path === 'new.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'created');
  });
});

describe('MountWatcher lifecycle', () => {
  it('mkdir -p covers missing parent dir at attach time (case C repro)', async () => {
    const nested = join(tmp, 'parent-also-missing', 'tickets');
    assert.ok(!existsSync(nested), 'precondition: nested path should not exist');

    const batches: FsChange[][] = [];
    let ready = false;
    const watcher = withPollingBackend(() => {
      const mounted = new MountWatcher(
        { name: 'tickets', path: nested, mode: 'read-write', watch: 'always', watchDebounceMs: DEBOUNCE_MS },
        (changes) => { batches.push(changes); },
        { onReady: () => { ready = true; } },
      );
      mounted.start();
      return mounted;
    });

    try {
      assert.ok(existsSync(nested), 'start() should have created the watched path');
      // A file written before chokidar's first scan is done can be part of
      // what it starts from (ignoreInitial), and then is never reported.
      await waitFor(() => ready, 'onReady should have fired');
      writeFileSync(join(nested, 'ticket.md'), 'hi');
      await changeFor(batches, 'ticket.md');
    } finally {
      await watcher.stop();
    }

    const created = batches.flat().find(c => c.path === 'ticket.md');
    assert.ok(created, `expected created event for ticket.md, got ${JSON.stringify(batches.flat())}`);
    assert.strictEqual(created.op, 'created');
  });

  it('read-only mount does not create the watched path', async () => {
    const roPath = join(tmp, 'read-only-missing');
    const watcher = new MountWatcher(
      { name: 'ro', path: roPath, mode: 'read-only', watch: 'always', watchDebounceMs: DEBOUNCE_MS },
      () => {},
    );
    watcher.start();
    try {
      await wait(50);
      assert.ok(!existsSync(roPath), 'read-only mount must not mkdir -p behind the user\'s back');
    } finally {
      await watcher.stop();
    }
  });

  // Root-liveness re-attach cases are authoritative on Linux (written around
  // inode-reuse semantics there). Under Node 24 on macOS the native watcher
  // delivers a different event stream — root not recreated, duplicate
  // reattach, read-only root re-attached — tracked in #130.
  it('read-write mount recreates a deleted root and re-attaches', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      rmSync(tmp, { recursive: true, force: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to recreate and reattach');
      await waitFor(() => readyCount > 1, 'expected recreated watcher ready');
      assert.ok(existsSync(tmp), 'read-write mount should recreate its deleted root');
    } finally {
      await watcher.stop();
    }
  });

  // Sandboxed macOS rejects native fs.watch handles with EMFILE. Keep this
  // production-backend integration assertion authoritative on Linux.
  it('re-attaches after the root is removed and recreated', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      {
        onReady: () => { readyCount++; },
        onReattach: () => { reattachCount++; },
      },
      // The root poll is past the test's deadline, so within it only the raw
      // rename event can re-attach.
      { ...makeConfig(), watchRootPollMs: EVENT_MS * 6 },
    );

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');

      writeFileSync(join(tmp, 'after-recreate.md'), 'hello');
      await changeFor(batches, 'after-recreate.md');

      const created = batches.flat().find(c => c.path === 'after-recreate.md');
      assert.ok(created, `expected created event after reattach, got ${JSON.stringify(batches.flat())}`);
      assert.strictEqual(created.op, 'created');
    } finally {
      await watcher.stop();
    }
  });

  // Linux-only for the same reason as above (#130).
  it('fires onReattach exactly once for one remove and recreate cycle', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');
      await wait(WATCH_ROOT_POLL_MS * 4);

      assert.strictEqual(reattachCount, 1);
    } finally {
      await watcher.stop();
    }
  });

  it('does not re-attach for normal create and modify traffic', async () => {
    let ready = false;
    let reattachCount = 0;
    const { watcher, batches } = collectWithPolling({
      onReady: () => { ready = true; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => ready, 'expected initial watcher ready');

      const file = join(tmp, 'normal.md');
      writeFileSync(file, 'v1');
      await changeFor(batches, 'normal.md', 'created');
      writeFileSync(file, 'v2');
      await changeFor(batches, 'normal.md', 'modified');
      // Root polls run through the traffic and after it, and none re-attaches.
      await wait(WATCH_ROOT_POLL_MS * 4);

      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });

  // Linux-only for the same reason as above (#130).
  it('keeps a deleted read-only root detached and stops cleanly', {
    skip: process.platform !== 'linux',
  }, async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const watcher = new MountWatcher(
      { ...makeConfig(), mode: 'read-only' },
      () => {},
      {
        onReady: () => { readyCount++; },
        onReattach: () => { reattachCount++; },
      },
    );
    watcher.start();

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      rmSync(tmp, { recursive: true, force: true });
      // Root polls run through this window and find the root gone. A mount
      // that watched the missing root again would fire onReady again, which
      // is what this test counts: the root stays absent either way, and
      // onReattach needs it back.
      await wait(WATCH_ROOT_POLL_MS * 4);
      assert.ok(!existsSync(tmp), 'read-only mount must not recreate its deleted root');
      assert.strictEqual(readyCount, 1, 'a read-only mount must not watch its missing root again');
      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });
});
