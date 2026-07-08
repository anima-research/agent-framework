import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MountWatcher, type FsChange, type WatcherLifecycle } from '../src/modules/workspace/watcher.js';
import type { MountConfig } from '../src/modules/workspace/types.js';

// Keep file-event delivery deterministic in sandboxed macOS runners where
// chokidar's fs.watch backend can emit EMFILE on ordinary writes. The root
// replacement detector under test still uses MountWatcher's watchRootPollMs.
process.env.CHOKIDAR_USEPOLLING = 'true';
process.env.CHOKIDAR_INTERVAL = '25';

// Short debounce keeps each test under ~200ms.
const DEBOUNCE_MS = 50;
const WATCH_ROOT_POLL_MS = 50;
// Chokidar's awaitWriteFinish (stabilityThreshold:100) + our debounce means
// each emission takes ~150ms to land; wait at least 300ms.
const SETTLE_MS = 350;

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

function collect(lifecycle?: WatcherLifecycle): { watcher: MountWatcher; batches: FsChange[][] } {
  const batches: FsChange[][] = [];
  const watcher = new MountWatcher(makeConfig(), (changes) => {
    batches.push(changes);
  }, lifecycle);
  watcher.start();
  return { watcher, batches };
}

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 800) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(25);
  }
  assert.fail(message);
}

describe('MountWatcher mergeOp', () => {
  it('unlink + add within debounce window → modified (atomic save)', async () => {
    // Seed a file before starting the watcher, so add+unlink+add reduces to
    // unlink+add (atomic save shape).
    const file = join(tmp, 'ticket.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = collect();
    await wait(100); // let chokidar initialize

    // Atomic save: unlink then write
    unlinkSync(file);
    writeFileSync(file, 'v2');

    await wait(SETTLE_MS);
    await watcher.stop();

    const flat = batches.flat();
    const forFile = flat.filter(c => c.path === 'ticket.md');
    // Expect exactly one batch entry for the file, with op=modified.
    assert.strictEqual(forFile.length, 1, `expected 1 change, got ${JSON.stringify(flat)}`);
    assert.strictEqual(forFile[0].op, 'modified');
  });

  it('create + modify within window → created (net new)', async () => {
    const { watcher, batches } = collect();
    await wait(100);

    const file = join(tmp, 'new.md');
    writeFileSync(file, 'hello');
    // awaitWriteFinish coalesces rapid writes, so spacing the second write
    // slightly increases the chance chokidar surfaces both add and change.
    await wait(10);
    writeFileSync(file, 'hello updated');

    await wait(SETTLE_MS);
    await watcher.stop();

    const forFile = batches.flat().filter(c => c.path === 'new.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'created');
  });

  it('delete + create of a pre-existing file → modified (covers atomic-save shape without relying on chokidar add/unlink coalesce timing)', async () => {
    // Seed so the watcher's first observation is the unlink of a real file.
    const file = join(tmp, 'a.md');
    writeFileSync(file, 'v1');

    const { watcher, batches } = collect();
    await wait(100);

    // Double-flip: unlink + recreate + unlink + recreate inside one window.
    unlinkSync(file);
    writeFileSync(file, 'v2');

    await wait(SETTLE_MS);
    await watcher.stop();

    const forFile = batches.flat().filter(c => c.path === 'a.md');
    assert.strictEqual(forFile.length, 1);
    assert.strictEqual(forFile[0].op, 'modified');
  });
});

describe('MountWatcher lifecycle', () => {
  it('mkdir -p covers missing parent dir at attach time (case C repro)', async () => {
    const nested = join(tmp, 'parent-also-missing', 'tickets');
    assert.ok(!existsSync(nested), 'precondition: nested path should not exist');

    const batches: FsChange[][] = [];
    let ready = false;
    const watcher = new MountWatcher(
      { name: 'tickets', path: nested, mode: 'read-write', watch: 'always', watchDebounceMs: DEBOUNCE_MS },
      (changes) => { batches.push(changes); },
      { onReady: () => { ready = true; } },
    );
    watcher.start();

    await wait(150);
    assert.ok(existsSync(nested), 'start() should have created the watched path');

    writeFileSync(join(nested, 'ticket.md'), 'hi');
    await wait(SETTLE_MS);
    await watcher.stop();

    assert.ok(ready, 'onReady should have fired');
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
    await wait(50);
    assert.ok(!existsSync(roPath), 'read-only mount must not mkdir -p behind the user\'s back');
    await watcher.stop();
  });

  it('re-attaches after the root is removed and recreated', async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher, batches } = collect({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');

      writeFileSync(join(tmp, 'after-recreate.md'), 'hello');
      await wait(SETTLE_MS);

      const created = batches.flat().find(c => c.path === 'after-recreate.md');
      assert.ok(created, `expected created event after reattach, got ${JSON.stringify(batches.flat())}`);
      assert.strictEqual(created.op, 'created');
    } finally {
      await watcher.stop();
    }
  });

  it('fires onReattach exactly once for one remove and recreate cycle', async () => {
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collect({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

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
    const { watcher, batches } = collect({
      onReady: () => { ready = true; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => ready, 'expected initial watcher ready');

      const file = join(tmp, 'normal.md');
      writeFileSync(file, 'v1');
      await wait(SETTLE_MS);
      writeFileSync(file, 'v2');
      await wait(SETTLE_MS + WATCH_ROOT_POLL_MS * 4);

      assert.strictEqual(reattachCount, 0);
      const flat = batches.flat();
      assert.ok(flat.some(c => c.path === 'normal.md'), `expected normal file event, got ${JSON.stringify(flat)}`);
    } finally {
      await watcher.stop();
    }
  });

  it('stops cleanly during a detached root window', async () => {
    let ready = false;
    const { watcher } = collect({
      onReady: () => { ready = true; },
    });

    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      rmSync(tmp, { recursive: true, force: true });
      await wait(WATCH_ROOT_POLL_MS * 2);
    } finally {
      await watcher.stop();
    }
  });
});
