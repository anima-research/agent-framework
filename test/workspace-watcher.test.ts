import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs, { existsSync, mkdtempSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MountWatcher, identityOf, type FsChange, type WatcherLifecycle } from '../src/modules/workspace/watcher.js';
import { changesFlow, isProbe } from './helpers/watcher-flow.js';
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
  others: readonly string[] = [],
): { watcher: MountWatcher; batches: FsChange[][] } {
  const batches: FsChange[][] = [];
  const watcher = new MountWatcher(config, (changes) => {
    batches.push(changes);
  }, lifecycle, others);
  watcher.start();
  return { watcher, batches };
}

/** Sets chokidar's backend for the instances made next, and returns what puts it back. */
function useChokidarBackend(usePolling: boolean): () => void {
  const previousUsePolling = process.env.CHOKIDAR_USEPOLLING;
  const previousInterval = process.env.CHOKIDAR_INTERVAL;
  process.env.CHOKIDAR_USEPOLLING = String(usePolling);
  if (usePolling) process.env.CHOKIDAR_INTERVAL = '25';
  return () => {
    if (previousUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = previousUsePolling;
    if (previousInterval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = previousInterval;
  };
}

/** The backend for the instance `start` makes; a re-attach's later instance takes the default. */
function withChokidarBackend<T>(usePolling: boolean, start: () => T): T {
  const restore = useChokidarBackend(usePolling);
  try {
    return start();
  } finally {
    restore();
  }
}

/**
 * chokidar's polling backend for every instance made while `fn` runs,
 * re-attaches' included. It sends no raw rename, so only the watcher's own
 * checks re-attach it.
 */
async function withPollingThroughout<T>(fn: () => Promise<T>): Promise<T> {
  const restore = useChokidarBackend(true);
  try {
    return await fn();
  } finally {
    restore();
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
  others?: readonly string[],
): { watcher: MountWatcher; batches: FsChange[][] } {
  return withNativeBackend(() => collect(lifecycle, config, others));
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

function rootPolls(watcher: MountWatcher): () => number {
  const internals = watcher as unknown as { checkRootLiveness(opts?: { force?: boolean }): Promise<void> };
  const check = internals.checkRootLiveness.bind(watcher);
  let polls = 0;
  internals.checkRootLiveness = (opts) => {
    polls++;
    return check(opts);
  };
  return () => polls;
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
  const chokidar = chokidarOf(watcher);
  for (const [event, path] of events) chokidar.emit(event, join(tmp, path));
}

/**
 * The watcher's chokidar instance, an EventEmitter, so a test can hand it an
 * event as chokidar emits one. A re-attach replaces it, and while one closes
 * the old instance there is none.
 */
function chokidarOf(watcher: MountWatcher): { emit(event: string, ...args: unknown[]): boolean; close(): Promise<void> } {
  return (watcher as unknown as { watcher: { emit(event: string, ...args: unknown[]): boolean; close(): Promise<void> } }).watcher;
}

/** Makes `watcher`'s chokidar instance fail its close, once it has closed. */
function failClose(watcher: MountWatcher): void {
  const chokidar = chokidarOf(watcher);
  const close = chokidar.close.bind(chokidar);
  chokidar.close = async () => {
    await close();
    throw new Error('close failed');
  };
}

/**
 * The process's open descriptors of `path`, a real path, as Linux's /proc names
 * them: the path, or the path and " (deleted)" once it has been removed.
 */
function descriptorsOf(path: string): string[] {
  return readdirSync('/proc/self/fd').flatMap((fd) => {
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return []; // closed since the listing, as the listing's own is
    }
    return target === path || target === `${path} (deleted)` ? [target] : [];
  });
}

/**
 * Runs `fn` with node:fs's `name` replaced by what `make` makes of the
 * original. The watcher imports it by name, so the binding is synced both
 * ways, and the test's own imports of it get the replacement too.
 */
async function withFs<T>(
  name: 'openSync' | 'statSync' | 'fstatSync' | 'closeSync',
  make: (original: (...args: any[]) => any) => (...args: any[]) => any,
  fn: () => Promise<T>,
): Promise<T> {
  const target = fs as unknown as Record<string, (...args: any[]) => any>;
  const original = target[name]!;
  target[name] = make(original);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    target[name] = original;
    syncBuiltinESMExports();
  }
}

const fsError = (code: string, syscall: string, path: string) => Object.assign(new Error(`${code}: refused by the test, ${syscall} '${path}'`), { code, syscall, path });

/** Runs `fn` with `openSync` refusing `path`, as at the process's file limit. */
function withOpenRefused<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withFs('openSync', (openSync) => (file: unknown, ...rest: unknown[]) => {
    if (String(file) === path) throw fsError('EMFILE', 'open', path);
    return openSync(file, ...rest);
  }, fn);
}

describe('MountWatcher root identity', () => {
  it('keeps a root the same where its birth time follows its ctime, as where statx is unavailable, and tells a later-born one apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-watch-id-'));
    try {
      const s = statSync(dir);
      const as = (fields: Partial<fs.Stats>) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, fields) as fs.Stats;
      const before = as({ ctimeMs: s.ctimeMs, birthtimeMs: s.ctimeMs });
      const after = as({ ctimeMs: s.ctimeMs + 5, birthtimeMs: s.ctimeMs + 5 });
      assert.deepStrictEqual(identityOf(after), identityOf(before), 'an entry made in the root moves both');
      const born = as({ ctimeMs: s.ctimeMs + 5, birthtimeMs: s.ctimeMs - 1000 });
      const reborn = as({ ctimeMs: s.ctimeMs + 9, birthtimeMs: s.ctimeMs + 1 });
      assert.notDeepStrictEqual(identityOf(reborn), identityOf(born), 'a birth time apart from the ctime still tells');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
      // what it starts from (ignoreInitial), or of the poll's first stat, just
      // after onReady, and then is never reported.
      await waitFor(() => ready, 'onReady should have fired');
      await changesFlow(nested, batches, []);
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
    const { watcher, batches } = collectWithNative({
      onReady: () => { readyCount++; },
      onReattach: () => { reattachCount++; },
    });

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      // The watcher holds its root open, so the root's removal sends no rename
      // until the hold ends, and the root poll finds the root made again.
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
    const polls = rootPolls(watcher);

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');

      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });

      await waitFor(() => reattachCount > 0, 'expected watcher to reattach');
      await waitFor(() => readyCount > 1, 'expected reattached watcher ready');
      const polled = polls();
      await waitFor(() => polls() >= polled + 3, 'expected three root polls after the re-attach');

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
    const polls = rootPolls(watcher);

    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      await changesFlow(tmp, batches, []);

      const file = join(tmp, 'normal.md');
      writeFileSync(file, 'v1');
      await changeFor(batches, 'normal.md', 'created');
      writeFileSync(file, 'v2');
      await changeFor(batches, 'normal.md', 'modified');
      // Root polls run through the traffic and after it, and none re-attaches.
      const polled = polls();
      await waitFor(() => polls() >= polled + 3, 'expected three root polls after the traffic');

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
    const polls = rootPolls(watcher);
    watcher.start();

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      const root = realpathSync(tmp);
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      rmSync(tmp, { recursive: true, force: true });
      // A poll that finds the root gone lets go of it, so its file system
      // isn't held busy while the mount waits for it.
      await waitFor(() => descriptorsOf(root).length === 0, 'expected the watcher to let go of its removed root');
      // Root polls run through this window and find the root gone. A mount
      // that watched the missing root again would fire onReady again, which
      // is what this test counts: the root stays absent either way, and
      // onReattach needs it back.
      const polled = polls();
      await waitFor(() => polls() >= polled + 3, 'expected three root polls that find the root gone');
      assert.ok(!existsSync(tmp), 'read-only mount must not recreate its deleted root');
      assert.strictEqual(readyCount, 1, 'a read-only mount must not watch its missing root again');
      assert.strictEqual(reattachCount, 0);
    } finally {
      await watcher.stop();
    }
  });

  // libuv reports a rename of an entry named like the root under that name,
  // as it reports the root's own removal or move. On Linux the watcher holds
  // its root, whose identity tells them apart.
  it("doesn't re-attach for an entry named like its held root, made, saved over or removed anywhere beneath it", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(tmp, 'work');
    mkdirSync(join(root, 'sub'), { recursive: true });
    let ready = false;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      { onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } },
      // The root poll is past the test's deadline, so within it only a rename
      // could re-attach.
      { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
    );
    // Each step waits for the batch its change comes in, which comes after
    // the change's rename and the check that rename runs, or for a re-attach,
    // which loses the change's events.
    const step = async (what: string, change: () => void, path: string, op?: FsChange['op']) => {
      batches.length = 0;
      change();
      const reported = () => batches.flat().some((c) => c.path === path && (op === undefined || c.op === op));
      await waitFor(() => reported() || reattachCount > 0, `expected ${op ? `a ${op} entry` : 'a change'} for ${path}`);
      assert.strictEqual(reattachCount, 0, `${what} re-attached the watcher`);
    };

    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      await step('a file named like the root, made', () => writeFileSync(join(root, 'work'), 'v1'), 'work', 'created');
      await step('a file named like the root, made in a subdirectory', () => writeFileSync(join(root, 'sub', 'work'), 'v1'), 'sub/work', 'created');
      await step('a file named like the root, saved over by a rename', () => {
        writeFileSync(join(root, '.work.tmp'), 'v2');
        renameSync(join(root, '.work.tmp'), join(root, 'work'));
      }, 'work');
      await step('a file named like the root, removed', () => unlinkSync(join(root, 'work')), 'work', 'deleted');
      await step('a file named like the root, removed from a subdirectory', () => unlinkSync(join(root, 'sub', 'work')), 'sub/work', 'deleted');
      // A directory's own making isn't reported, so this step waits for a
      // file made in it after it.
      await step('a directory named like the root, made', () => {
        mkdirSync(join(root, 'work'));
        writeFileSync(join(root, 'work', 'x.md'), 'x');
      }, 'work/x.md', 'created');
    } finally {
      await watcher.stop();
    }
  });

  // On Linux a removed directory's inode number can go to the next directory
  // made, as ext4 gives it, so a root made again could look unchanged. The
  // watcher holds its root open, and a number held isn't given out.
  it('holds its root open while it watches, and re-attaches to a root made again in its place', {
    skip: process.platform !== 'linux',
  }, async (t) => {
    // Whether this disk gives a removed directory's number to the next one
    // made. tmpfs doesn't, and there the test has nothing to show. Another
    // process can take the number first on a busy disk, so it's tried a few
    // times.
    const scratch = join(tmp, 'scratch');
    const givesNumberBack = (): boolean => {
      mkdirSync(scratch);
      const removed = statSync(scratch).ino;
      rmdirSync(scratch);
      mkdirSync(scratch);
      const again = statSync(scratch).ino === removed;
      rmdirSync(scratch);
      return again;
    };
    if (![1, 2, 3, 4, 5].some(givesNumberBack)) {
      t.skip("this disk didn't give a removed directory's inode number to the next one made, in five tries");
      return;
    }
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative(
      { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: root },
    );

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      rmdirSync(root);
      mkdirSync(root);
      await waitFor(() => reattachCount > 0 && readyCount > 1, 'expected the watcher to re-attach to the root made again');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds the root made again, having let the removed one go');
    } finally {
      await watcher.stop();
    }
    assert.deepStrictEqual(descriptorsOf(root), [], 'a stopped watcher holds nothing of its root');
  });

  // The identity is read from the descriptor held, so it's the held
  // directory's even when the root is replaced between the open and the read.
  // Here the replacement happens inside the open, and a poll finds it. The
  // poll is driven at once, before chokidar's first instance is ready, as a
  // loaded host's timer can run it first: the re-attach then closes that
  // instance, whose ready never comes. So the test waits for a ready after
  // the re-attach, which is what the watcher promises, not for two readies.
  it('reads the held root identity from what it holds, so a root replaced as it was opened is found', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let replaced = false;
    await withFs('openSync', (openSync) => (file: unknown, ...rest: unknown[]) => {
      const fd = openSync(file, ...rest);
      if (String(file) === root && !replaced) {
        replaced = true;
        renameSync(root, `${root}.away`);
        mkdirSync(root);
      }
      return fd;
    }, async () => {
      let reattachCount = 0;
      let readyAfterReattach = false;
      const { watcher } = collectWithNative(
        { onReady: () => { if (reattachCount > 0) readyAfterReattach = true; }, onReattach: () => { reattachCount++; } },
        { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
      );
      try {
        await (watcher as unknown as { checkRootLiveness(): Promise<void> }).checkRootLiveness();
        assert.strictEqual(reattachCount, 1, 'a poll finds the root replaced as it was opened, and re-attaches');
        await waitFor(() => readyAfterReattach, 'expected the watcher ready after the re-attach');
        assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds the root at its path');
        assert.deepStrictEqual(descriptorsOf(`${root}.away`), [], 'the watcher still holds the directory moved away');
      } finally {
        await watcher.stop();
      }
    });
  });

  // The watcher holds, and checks, the root it watches: the configured path
  // resolved. A link followed by `..` in that path makes the directory the
  // kernel opens for the path as written another one, and a root held or
  // checked there would read as replaced at every poll.
  it('holds and checks the root it watches when a link and .. in its configured path lead elsewhere', {
    skip: process.platform !== 'linux',
  }, async () => {
    const base = realpathSync(tmp);
    const root = join(base, 'work');
    mkdirSync(root);
    mkdirSync(join(base, 'elsewhere', 'inner'), { recursive: true });
    mkdirSync(join(base, 'elsewhere', 'work'));
    symlinkSync(join(base, 'elsewhere', 'inner'), join(base, 'link'));
    let ready = false;
    let reattachCount = 0;
    const { watcher } = collectWithNative(
      { onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: `${base}/link/../work` },
    );
    // Counts the root's checks, so the test waits for polls, not for a time.
    const internals = watcher as unknown as { checkRootLiveness(opts?: { force?: boolean }): Promise<void> };
    const check = internals.checkRootLiveness.bind(watcher);
    let checks = 0;
    internals.checkRootLiveness = (opts) => {
      checks++;
      return check(opts);
    };
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds the root it watches');
      const polled = checks;
      await waitFor(() => checks >= polled + 3, 'expected three root polls');
      assert.strictEqual(reattachCount, 0, 'the watcher re-attached to the root it watches');
    } finally {
      await watcher.stop();
    }
  });

  it('lets go of its root at a stop whose close of chokidar fails', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    const { watcher } = collectWithNative({ onReady: () => { ready = true; } }, { ...makeConfig(), path: root });
    let stopped = false;
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      failClose(watcher);
      stopped = true;
      await assert.rejects(watcher.stop(), /close failed/);
      assert.deepStrictEqual(descriptorsOf(root), [], 'the stopped watcher still holds its root');
    } finally {
      // A watcher left running keeps the test process alive.
      if (!stopped) await watcher.stop();
    }
  });

  it('lets go of its removed root at a re-attach whose close of chokidar fails', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    const errors: Error[] = [];
    const { watcher } = collectWithNative(
      { onReady: () => { ready = true; }, onError: (err) => { errors.push(err); } },
      { ...makeConfig(), path: root },
    );
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      failClose(watcher);
      rmdirSync(root);
      mkdirSync(root);
      await waitFor(() => errors.some((e) => e.message === 'close failed'), "expected the re-attach to report its close's failure");
      // A later poll may have attached to the root made again by now, so only
      // the removed one is looked for.
      assert.ok(!descriptorsOf(root).includes(`${root} (deleted)`), 'the watcher still holds its removed root');
    } finally {
      await watcher.stop();
    }
  });

  // chokidar removes its listeners before it closes, so a re-attach whose
  // close of the old instance fails reports that and attaches again, here to
  // a root that hasn't changed, which no poll would re-attach.
  it('attaches again after a re-attach whose close of chokidar fails', async () => {
    await withPollingThroughout(async () => {
      let readyCount = 0;
      const errors: Error[] = [];
      const { watcher, batches } = collect(
        { onReady: () => { readyCount++; }, onError: (err) => { errors.push(err); } },
      );
      try {
        await waitFor(() => readyCount === 1, 'expected initial watcher ready');
        failClose(watcher);
        await (watcher as unknown as { reattach(): Promise<void> }).reattach();
        assert.ok(errors.some((e) => e.message === 'close failed'), "the re-attach reported its close's failure");
        await waitFor(() => readyCount === 2, 'expected the watcher to attach again');
        await changesFlow(tmp, batches, []);
        writeFileSync(join(tmp, 'after.md'), 'x');
        await changeFor(batches, 'after.md', 'created');
      } finally {
        await watcher.stop();
      }
    });
  });

  // close(2) frees a descriptor on Linux whatever it returns, so an error
  // closing the held root is reported and the stop goes on.
  it('reports an error closing its root, and still closes chokidar at the stop', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    const errors: Error[] = [];
    const { watcher } = collectWithNative(
      { onReady: () => { ready = true; }, onError: (err) => { errors.push(err); } },
      { ...makeConfig(), path: root },
    );
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
    } catch (err) {
      // A watcher left running keeps the test process alive.
      await watcher.stop();
      throw err;
    }
    const chokidar = chokidarOf(watcher);
    try {
      await withFs('closeSync', (closeSync) => (fd: unknown) => {
        closeSync(fd);
        throw fsError('EIO', 'close', root);
      }, () => watcher.stop());
    } catch (err) {
      // A stop that failed before closing chokidar leaves it running.
      await watcher.stop();
      throw err;
    }
    assert.ok(errors.some((e) => /EIO/.test(e.message)), "the close's error was reported");
    assert.strictEqual(chokidar.emit('add', join(root, 'late.md')), false, 'the stopped watcher still listens to chokidar');
  });

  // A root the watcher doesn't hold has its identity read from its path,
  // which a root made again can share with the removed one, so a rename named
  // like it forces a re-attach, as it always did. On Linux that's a root it
  // can't open, as without read permission or at the process's file limit;
  // elsewhere it holds no root. chokidar polls throughout, so the renames are
  // the ones the test emits, and the root put in the root's place can only be
  // found by a poll.
  it("reads a root it doesn't hold from its path: a poll finds it replaced, and a rename named like it re-attaches it", async () => {
    const root = join(tmp, 'work');
    mkdirSync(root);
    const unheld = <T>(fn: () => Promise<T>): Promise<T> => (process.platform === 'linux' ? withOpenRefused(root, fn) : fn());
    await withPollingThroughout(() => unheld(async () => {
      let readyCount = 0;
      let reattachCount = 0;
      const { watcher } = collect(
        { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
        { ...makeConfig(), path: root },
      );
      // Counts the root's checks, so the test waits for polls, not for a time.
      const internals = watcher as unknown as { checkRootLiveness(opts?: { force?: boolean }): Promise<void> };
      const check = internals.checkRootLiveness.bind(watcher);
      let checks = 0;
      internals.checkRootLiveness = (opts) => {
        checks++;
        return check(opts);
      };
      try {
        await waitFor(() => readyCount > 0, 'expected initial watcher ready');
        const first = chokidarOf(watcher);
        // A re-attach takes the instance away at once, so these need no wait.
        first.emit('raw', 'rename', 'other.md', { watchedPath: root });
        assert.strictEqual(chokidarOf(watcher), first, 'a rename named otherwise re-attached the watcher');
        const polled = checks;
        await waitFor(() => checks >= polled + 3, 'expected three root polls');
        assert.strictEqual(chokidarOf(watcher), first, 'a poll re-attached the watcher to its unchanged root');
        // The rename libuv reports for the root's own removal, as chokidar emits it.
        first.emit('raw', 'rename', 'work', { watchedPath: root });
        await waitFor(() => reattachCount === 1 && readyCount === 2, 'expected the rename to re-attach the watcher');
        // A directory put in the root's place, the root moved aside so the new
        // one can't take its number, is found by a poll.
        renameSync(root, `${root}.aside`);
        mkdirSync(root);
        await waitFor(() => reattachCount === 2, "expected a poll to re-attach the watcher to the root put in the root's place");
      } finally {
        await watcher.stop();
      }
    }));
  });

  // libuv gives a rename without a name for a file whose path it can't read
  // (its kqueue backend, macOS's for files).
  it('passes over a rename that comes without a name', async () => {
    let ready = false;
    const { watcher } = withPollingBackend(() => collect({ onReady: () => { ready = true; } }));
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      const first = chokidarOf(watcher);
      first.emit('raw', 'rename', null, { watchedPath: join(tmp, 'a.md') });
      // A re-attach takes the instance away at once.
      assert.strictEqual(chokidarOf(watcher), first, 'a rename without a name re-attached the watcher');
    } finally {
      await watcher.stop();
    }
  });

  // On a file system whose inode numbers a server gives out, a root made again
  // can take the removed one's number, held or not. The held directory's link
  // count still says it was removed. Here the root's path reads as the
  // removed root, as such a file system can show it.
  it('re-attaches when its held root is removed, though the root made again reads as the removed one', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    const removed = statSync(root);
    await withFs('statSync', (stat) => (file: unknown, ...rest: unknown[]) => (String(file) === root ? removed : stat(file, ...rest)), async () => {
      let readyCount = 0;
      let reattachCount = 0;
      const { watcher } = collectWithNative(
        { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
        { ...makeConfig(), path: root },
      );
      try {
        await waitFor(() => readyCount > 0, 'expected initial watcher ready');
        rmdirSync(root);
        mkdirSync(root);
        await waitFor(() => reattachCount > 0, 'expected the watcher to re-attach to the root made again');
      } finally {
        await watcher.stop();
      }
    });
  });

  // A held directory that can't be read any more, as a stale one on a network
  // file system, counts as removed.
  it("re-attaches when it can't read the root it holds", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher } = collectWithNative(
      { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: root },
    );
    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      const held = (watcher as unknown as { rootFd: number | null }).rootFd;
      assert.notStrictEqual(held, null, 'the watcher holds its root');
      let refused = false;
      await withFs('fstatSync', (fstat) => (fd: unknown, ...rest: unknown[]) => {
        if (fd === held && !refused) {
          refused = true;
          throw fsError('ESTALE', 'fstat', root);
        }
        return fstat(fd, ...rest);
      }, () => waitFor(() => reattachCount > 0, 'expected the watcher to re-attach'));
    } finally {
      await watcher.stop();
    }
  });

  // A held root that has been removed is let go of though its path fails with
  // another error than ENOENT, as when one of its parents becomes a file.
  it('lets go of its removed root when its path fails with another error', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    const { watcher } = collectWithNative(
      { onReady: () => { ready = true; } },
      { ...makeConfig(), path: root, mode: 'read-only' },
    );
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher holds its root');
      await withFs('statSync', (stat) => (file: unknown, ...rest: unknown[]) => {
        if (String(file) === root) throw fsError('ENOTDIR', 'stat', root);
        return stat(file, ...rest);
      }, async () => {
        rmdirSync(root);
        await waitFor(() => descriptorsOf(root).length === 0, 'expected the watcher to let go of its removed root');
      });
    } finally {
      await watcher.stop();
    }
  });

  // A path that fails with another error than ENOENT can't say whether the
  // root is still there, as when a parent loses search permission, so a held
  // root that hasn't been removed stays held and attached.
  it('keeps a root in place held when its path fails with another error', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    let ready = false;
    let reattachCount = 0;
    const { watcher } = collectWithNative(
      { onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: root },
    );
    // Counts the root's checks, so the test waits for polls, not for a time.
    const internals = watcher as unknown as { checkRootLiveness(opts?: { force?: boolean }): Promise<void> };
    const check = internals.checkRootLiveness.bind(watcher);
    let checks = 0;
    internals.checkRootLiveness = (opts) => {
      checks++;
      return check(opts);
    };
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      await withFs('statSync', (stat) => (file: unknown, ...rest: unknown[]) => {
        if (String(file) === root) throw fsError('EACCES', 'stat', root);
        return stat(file, ...rest);
      }, async () => {
        const polled = checks;
        await waitFor(() => checks >= polled + 3, 'expected three root polls');
      });
      assert.deepStrictEqual(descriptorsOf(root), [root], 'the watcher let go of its root in place');
      assert.strictEqual(reattachCount, 0, 'the watcher re-attached to its root in place');
    } finally {
      await watcher.stop();
    }
  });

  // What the watcher opened of a root whose identity it then can't read isn't
  // held: the attach reports the error, and the next check attaches again.
  it("holds nothing of a root it opened but couldn't read", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    const errors: Error[] = [];
    await withFs('fstatSync', () => () => {
      throw fsError('EIO', 'fstat', root);
    }, async () => {
      // The root poll is past the test, so no check attaches again.
      const { watcher } = collectWithNative({ onError: (err) => { errors.push(err); } }, { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 });
      try {
        // The attach ran in start(), before chokidar's own reads begin.
        assert.ok(errors.some((e) => /EIO/.test(e.message)), "the attach reported the root's failed read");
        assert.deepStrictEqual(descriptorsOf(root), [], 'the watcher holds the root it could not read');
      } finally {
        await watcher.stop();
      }
    });
  });

  // A root whose link count reads 0 as it's opened isn't held: if that's the
  // file system's count for a directory in place, every later check would
  // take the root for removed. Its polls leave it be.
  it("a root in place whose link count reads 0 isn't taken for removed: its polls leave it be", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    mkdirSync(root);
    await withFs('fstatSync', (fstat) => (fd: unknown, ...rest: unknown[]) => Object.assign(fstat(fd, ...rest), { nlink: 0 }), async () => {
      let readyCount = 0;
      let reattachCount = 0;
      const { watcher } = collectWithNative(
        { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
        { ...makeConfig(), path: root },
      );
      // Counts the root's checks, so the test waits for polls, not for a time.
      const internals = watcher as unknown as { checkRootLiveness(opts?: { force?: boolean }): Promise<void> };
      const check = internals.checkRootLiveness.bind(watcher);
      let checks = 0;
      internals.checkRootLiveness = (opts) => {
        checks++;
        return check(opts);
      };
      try {
        await waitFor(() => readyCount > 0, 'expected initial watcher ready');
        const polled = checks;
        await waitFor(() => checks >= polled + 3, 'expected three root polls');
        assert.strictEqual(reattachCount, 0, 'a poll re-attached the watcher to its root in place');
      } finally {
        await watcher.stop();
      }
    });
  });

  // A FIFO at the root's path would block an open until a writer came, so the
  // watcher opens its root only as a directory. A file there isn't held either.
  it("holds nothing at a root path that isn't a directory", {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(realpathSync(tmp), 'work');
    writeFileSync(root, 'x');
    const watcher = new MountWatcher({ ...makeConfig(), path: root, mode: 'read-only', watchRootPollMs: EVENT_MS * 6 }, () => {});
    watcher.start();
    try {
      assert.deepStrictEqual(descriptorsOf(root), [], 'the watcher holds a file at its root path');
    } finally {
      await watcher.stop();
    }
  });

  // A root moved away and back before its renames are handled is the
  // directory the watcher holds, so the checks find it unchanged, and its
  // watches go on reporting. Both moves come before any event is handled.
  it('goes on reporting a root moved away and back at once', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(tmp, 'work');
    mkdirSync(root);
    let ready = false;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      { onReady: () => { ready = true; }, onReattach: () => { reattachCount++; } },
      { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
    );
    try {
      await waitFor(() => ready, 'expected initial watcher ready');
      renameSync(root, `${root}.away`);
      renameSync(`${root}.away`, root);
      writeFileSync(join(root, 'after.md'), 'x');
      await changeFor(batches, 'after.md', 'created');
      assert.strictEqual(reattachCount, 0, 'the watcher re-attached to the root moved back');
    } finally {
      await watcher.stop();
    }
  });

  // A root moved away is found at its rename, which comes for a move even
  // while the root is held: the check finds nothing at the root's path.
  it('re-attaches at the rename when its root is moved away', {
    skip: process.platform !== 'linux',
  }, async () => {
    const root = join(tmp, 'work');
    mkdirSync(root);
    let readyCount = 0;
    let reattachCount = 0;
    const { watcher, batches } = collectWithNative(
      { onReady: () => { readyCount++; }, onReattach: () => { reattachCount++; } },
      // The root poll is past the test's deadline, so within it only the
      // rename re-attaches.
      { ...makeConfig(), path: root, watchRootPollMs: EVENT_MS * 6 },
    );

    try {
      await waitFor(() => readyCount > 0, 'expected initial watcher ready');
      renameSync(root, `${root}.away`);
      await waitFor(() => reattachCount > 0 && readyCount > 1, 'expected the watcher to re-attach at the rename');
      // A read-write mount makes its root again, and the watcher reports what's
      // written there.
      writeFileSync(join(root, 'after.md'), 'x');
      await changeFor(batches, 'after.md', 'created');
    } finally {
      await watcher.stop();
    }
  });
});

describe('MountWatcher ignores what a walk passes over by design (connectome-host #278)', () => {
  // The mount sits under a directory with a dot in its name, as one under
  // ~/.local does: chokidar's own filter for editors' files tested the whole
  // path, so there it hid every `*.swp` beneath the root.
  async function reported(
    collectOn: (lifecycle?: WatcherLifecycle, config?: MountConfig, others?: readonly string[]) => { watcher: MountWatcher; batches: FsChange[][] },
    ignore: string[],
    files: string[],
    expected: string[],
    others: readonly string[] = [],
  ): Promise<string[]> {
    const root = join(tmp, '.local', 'work');
    mkdirSync(join(root, 'cache'), { recursive: true });
    mkdirSync(join(root, 'drafts~'), { recursive: true });
    for (const other of others) mkdirSync(join(root, other), { recursive: true });
    for (const f of files) mkdirSync(join(root, dirname(f)), { recursive: true });
    let ready = false;
    const { watcher, batches } = collectOn({ onReady: () => { ready = true; } }, { ...makeConfig(), path: root, ignore }, others);
    try {
      await waitFor(() => ready, 'expected the watcher to be ready', 10_000);
      // Probes in each directory a file must be reported from.
      await changesFlow(root, batches, [...new Set(expected.map((f) => (dirname(f) === '.' ? '' : dirname(f))))]);
      for (const f of files) writeFileSync(join(root, f), 'x');
      // What must be reported, then time for anything that mustn't be.
      const seen = (p: string) => batches.flat().some((c) => c.path === p);
      await waitFor(() => expected.every(seen), `expected ${expected.join(', ')} to be reported`, 10_000);
      await wait(SETTLE_MS);
    } finally {
      await watcher.stop();
    }
    return [...new Set(batches.flat().map((c) => c.path))].filter((p) => !isProbe(p)).sort();
  }

  const EDITORS = ['.gate.json.swp', '.gate.json.swx', 'gate.json~', '.x.subl3f9.tmp', 'drafts~/x.txt'];
  const PLAIN = ['notes.swp', 'report.v2.swp', 'notes.sublime.tmpl', 'backup.txt.bak', 'kept.txt'];

  for (const [backend, collectOn] of [
    ['native', collectWithNative],
    ['polling', (l?: WatcherLifecycle, c?: MountConfig, o?: readonly string[]) => withPollingBackend(() => collect(l, c, o))],
  ] as const) {
    it(`reports a plain name and passes over editors' files, by their own name (${backend})`, async () => {
      assert.deepEqual(await reported(collectOn, [], [...EDITORS, ...PLAIN], PLAIN), [...PLAIN].sort());
    });

    it(`passes over another mount's directory nested in this one, and reports what lies beside it (${backend})`, async () => {
      const files = ['inner/mount/x.txt', 'inner/kept.txt', 'kept.txt'];
      assert.deepEqual(await reported(collectOn, [], files, ['inner/kept.txt', 'kept.txt'], ['inner/mount']), ['inner/kept.txt', 'kept.txt']);
    });

    it(`passes over a directory a trailing "/" names, and reports a file of that name (${backend})`, async () => {
      assert.deepEqual(await reported(collectOn, ['out/'], ['out/x.txt', 'deep/out/y.txt', 'sub/out', 'kept.txt'], ['sub/out', 'kept.txt']), ['kept.txt', 'sub/out']);
    });

    it(`reports nothing when a directory a trailing "/" names is removed, and reports a file of that name removed (${backend})`, async () => {
      const root = join(tmp, 'work');
      for (const f of ['out/x.txt', 'sub/out', 'kept.txt']) {
        mkdirSync(join(root, dirname(f)), { recursive: true });
        writeFileSync(join(root, f), 'x');
      }
      let ready = false;
      const { watcher, batches } = collectOn({ onReady: () => { ready = true; } }, { ...makeConfig(), path: root, ignore: ['out/'] });
      try {
        await waitFor(() => ready, 'expected the watcher to be ready', 10_000);
        await changesFlow(root, batches, ['', 'sub']);
        rmSync(join(root, 'out'), { recursive: true });
        unlinkSync(join(root, 'sub/out'));
        writeFileSync(join(root, 'after.txt'), 'x');
        const seen = (p: string) => batches.flat().some((c) => c.path === p);
        await waitFor(() => seen('sub/out') && seen('after.txt'), 'expected sub/out and after.txt to be reported', 10_000);
        await wait(SETTLE_MS);
      } finally {
        await watcher.stop();
      }
      const changes = batches.flat().filter((c) => !isProbe(c.path));
      assert.deepEqual(changes.filter((c) => c.path === 'out' || c.path.startsWith('out/')), []);
      assert.ok(changes.some((c) => c.path === 'sub/out' && c.op === 'deleted'), JSON.stringify(changes));
    });
  }

  it("passes over what the mount's ignore list covers, by the path relative to the mount", async () => {
    assert.deepEqual(await reported(collectWithNative, ['*.log', 'cache/**'], ['new.log', 'cache/blob.txt', 'kept.txt'], ['kept.txt']), ['kept.txt']);
  });
});
