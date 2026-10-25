/**
 * A read-only direct mount (MountConfig.backend 'direct'): its tools read
 * disk as it is when they run, record nothing in the store, and give the
 * answers a 'chronicle' mount's tools give where the two should agree. And
 * the switch between the kinds, both ways.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { JsStore } from '@animalabs/chronicle';
// A namespace, so this file loads where the module lacks inOrder, and only
// the tests that call it fail there.
import * as workspaceModule from '../src/modules/workspace/index.js';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { BranchIntents } from '../src/modules/workspace/branch-intent.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';
import { changedAfterFstat, countingLoads, withFileHandle } from './helpers/file-handle.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==', 'base64');

type Alert = { kind: string; agent: string; message: string; data?: Record<string, unknown> };

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-direct-'));
  readonly ref = join(this.root, 'ref');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  events: ProcessEvent[] = [];
  alerts: Alert[] = [];
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.ref, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  file(rel: string, content: string | Buffer): void {
    mkdirSync(dirname(join(this.ref, rel)), { recursive: true });
    writeFileSync(join(this.ref, rel), content);
  }

  /** A module whose `ref` mount is direct and read-only unless `mount` says otherwise, with `more` mounts beside it. */
  async open(mount: Partial<MountConfig> = {}, more: MountConfig[] = []): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: [{ name: 'ref', path: this.ref, mode: 'read-only', backend: 'direct', ...mount }, ...more],
    });
    m.initStore(this.store);
    await m.start(this.context());
    this.live.push(m);
    return m;
  }

  /** A module context as a host gives one, recording events and ops alerts. */
  context(): ModuleContext {
    return {
      isRestart: false,
      getState: () => null,
      setState: () => {},
      pushEvent: (e: ProcessEvent) => this.events.push(e),
      notifyOps: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => this.alerts.push({ kind, agent, message, data }),
    } as unknown as ModuleContext;
  }

  /** Stop the module and start it again, with the store it has. */
  async restart(m: WorkspaceModule): Promise<void> {
    await m.stop();
    await m.start(this.context());
  }

  /** The same mount as a 'chronicle' one, read-write and unwatched. */
  openChronicle(): Promise<WorkspaceModule> {
    return this.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' });
  }

  async close(m: WorkspaceModule): Promise<void> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
  }

  stateIds(): string[] {
    return this.store.listStates().map((s) => s.id).sort();
  }
}

/** The mounts a module watches. */
function watched(m: WorkspaceModule): string[] {
  return [...(m as unknown as { watchers: Map<string, unknown> }).watchers.keys()];
}

/** Run `fn` with `node:fs/promises`'s `name`, as the module's imports see it, replaced by what `make` makes of it. */
async function withFsPromise<T>(name: 'lstat' | 'open' | 'realpath' | 'stat', make: (original: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any>, fn: () => Promise<T>): Promise<T> {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
  const original = fsp[name]!;
  fsp[name] = make(original);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fsp[name] = original;
    syncBuiltinESMExports();
  }
}

/**
 * The most calls of `node:fs/promises`'s `name` on the files `counted` names
 * under way at once while `fn` runs. The first are held until `width` of
 * them are under way, and half a second longer, in which a reader wider than
 * `width` would start more, so a reader `width` wide shows as `width` however
 * fast the file system answers each step before the call. A narrower one is
 * let go after 5 seconds, so it fails rather than hangs.
 */
async function mostAtOnce(name: 'lstat' | 'open', width: number, counted: RegExp, fn: () => Promise<unknown>): Promise<number> {
  let now = 0;
  let most = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const fallback = setTimeout(release, 5000);
  let settle: NodeJS.Timeout | undefined;
  try {
    await withFsPromise(name, (original) => async (...args: any[]) => {
      if (!counted.test(String(args[0]))) return original(...args);
      now++;
      most = Math.max(most, now);
      if (now === width && settle === undefined) settle = setTimeout(release, 500);
      try {
        await released;
        return await original(...args);
      } finally {
        now--;
      }
    }, fn);
  } finally {
    clearTimeout(fallback);
    clearTimeout(settle);
  }
  return most;
}

function call(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  return m.handleToolCall({ id: name, name, input });
}

async function data<T = Record<string, unknown>>(m: WorkspaceModule, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)}: ${result.error}`);
  return (result.structured ?? result.data) as T;
}

async function failure(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const result = await call(m, name, input);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} succeeded: ${JSON.stringify(result.data)}`);
  return result.error!;
}

test('a direct mount reads disk as it is now, and records nothing in the store from its start on', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'one\n');
  env.file('img/dot.png', PNG);
  const states = env.stateIds();
  const sequence = env.store.currentSequence();
  const m = await env.open();

  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/src/a.ts' })).content, '     1\tone');
  appendFileSync(join(env.ref, 'src/a.ts'), 'two\n');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/src/a.ts' })).content, '     1\tone\n     2\ttwo');
  await data(m, 'ls', { path: 'ref', recursive: true });
  await data(m, 'ls', { path: 'ref/src' });
  await data(m, 'glob', { pattern: '**/*.ts' });
  await data(m, 'grep', { pattern: 'two' });
  await data(m, 'read_image', { path: 'ref/img/dot.png' });
  await data(m, 'status');
  await data(m, 'sync');
  assert.deepEqual('data' in (await m.readBinary('ref/src/a.ts')), true);
  await m.onToolBatchComplete();

  assert.deepEqual(env.stateIds(), states, 'no state was made');
  assert.equal(env.store.currentSequence(), sequence, 'nothing was recorded, its disk evidence included');
  assert.deepEqual(env.events.filter((e) => e.type !== 'workspace:mounted').map((e) => e.type), [], 'no change was evented');
  assert.deepEqual(watched(m), [], 'no watcher runs, though watch is left out');
});

test("read on a direct mount refuses what a 'chronicle' mount never stores: a binary file, and one over the size limit", async (t) => {
  const env = new Env(t);
  env.file('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
  env.file('dot.png', PNG);
  env.file('big.txt', 'x'.repeat(9));
  env.file('fits.txt', 'x'.repeat(8));
  const m = await env.open({ maxFileSize: 8 });
  assert.equal(await failure(m, 'read', { path: 'ref/bin.dat' }), "ref/bin.dat is binary, so read doesn't show it as text.");
  assert.equal(await failure(m, 'read', { path: 'ref/dot.png' }), "ref/dot.png is over the size limit (8 bytes), so read doesn't show it.");
  assert.equal(await failure(m, 'read', { path: 'ref/big.txt' }), "ref/big.txt is over the size limit (8 bytes), so read doesn't show it.");
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/fits.txt' })).content, '     1\txxxxxxxx');

  const roomy = await env.open({ maxFileSize: 1024 });
  assert.equal(await failure(roomy, 'read', { path: 'ref/dot.png' }), "ref/dot.png is binary, so read doesn't show it as text; read it with read_image.");
});

test("read on a direct mount answers with the disk reader's refusals", async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  symlinkSync(join(env.ref, 'src/a.ts'), join(env.ref, 'link.ts'));
  symlinkSync(join(env.ref, 'src'), join(env.ref, 'srclink'));
  const m = await env.open();
  assert.equal(await failure(m, 'read', { path: 'ref/missing.ts' }), 'File not found: ref/missing.ts');
  assert.equal(await failure(m, 'read', { path: 'ref/src' }), 'Path is a directory: ref/src');
  assert.equal(await failure(m, 'read', { path: 'ref/link.ts' }), 'Symlinks are not allowed: ref/link.ts');
  assert.equal(
    await failure(m, 'read', { path: 'ref/srclink/a.ts' }),
    'ref/srclink/a.ts: "ref/srclink" is a symlink to "ref/src", which this mount does not follow; the mount\'s host can set followSymlinks: true',
  );
  assert.match(await failure(m, 'read', { path: 'ref/../escape.txt' }), /^Path traversal detected/);
});

test("read_image on a direct mount never shows the copy a 'chronicle' run stored", async (t) => {
  const env = new Env(t);
  const chronicle = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', autoMaterialize: true });
  assert.equal((await chronicle.writeBinary('ref/dot.img', PNG, 'image/png')).success, true);
  await env.close(chronicle);
  env.file('dot.img', GIF);
  const direct = await env.open();
  assert.deepEqual(env.alerts, [], 'it starts direct');
  const image = await data<Array<{ mimeType?: string; data?: string }>>(direct, 'read_image', { path: 'ref/dot.img' });
  assert.deepEqual([image[1]!.mimeType, image[1]!.data], ['image/gif', GIF.toString('base64')]);
});

test("read_image on a direct mount reads disk's image as it is now", async (t) => {
  const env = new Env(t);
  env.file('dot.img', PNG);
  const m = await env.open();
  const first = await data<Array<{ type: string; text?: string; data?: string; mimeType?: string }>>(m, 'read_image', { path: 'ref/dot.img' });
  assert.equal(first[0]!.text, `Path: ref/dot.img\nMIME: image/png\nBytes: ${PNG.byteLength}`);
  assert.equal(first[1]!.data, PNG.toString('base64'));
  env.file('dot.img', GIF);
  const second = await data<Array<{ mimeType?: string; data?: string }>>(m, 'read_image', { path: 'ref/dot.img' });
  assert.equal(second[1]!.mimeType, 'image/gif');
  assert.equal(second[1]!.data, GIF.toString('base64'));
});

test('ls on a direct mount lists disk\'s entries with their sizes and no state, and a link with why it isn\'t taken', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'abc');
  env.file('src/b.ts', 'bb');
  symlinkSync(join(env.ref, 'a.txt'), join(env.ref, 'link.txt'));
  const m = await env.open();
  assert.deepEqual((await data(m, 'ls', { path: 'ref' })).entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.txt', type: 'file', size: 3 },
    { name: 'link.txt', type: 'file', note: 'a symlink, which this mount does not follow' },
  ]);
  assert.deepEqual(await data(m, 'ls', { path: 'ref', recursive: true }), {
    path: 'ref',
    entries: [
      { path: 'a.txt', size: 3 },
      { path: 'link.txt', note: 'a symlink, which this mount does not follow' },
      { path: 'src/b.ts', size: 2 },
    ],
    count: 3,
  });

  const following = await env.open({ followSymlinks: true });
  assert.deepEqual((await data(following, 'ls', { path: 'ref' })).entries, [
    { name: 'src', type: 'directory' },
    { name: 'a.txt', type: 'file', size: 3 },
    { name: 'link.txt', type: 'file', size: 3 },
  ]);
});

test('the default ignore list keeps whole walks out of what it covers, and a path a tool names is walked', async (t) => {
  const env = new Env(t);
  env.file('src/a.js', 'needle\n');
  env.file('node_modules/pkg/index.js', 'needle\n');
  env.file('node_modules/pkg/dist/built.js', 'needle\n');
  env.file('dist/out.js', 'needle\n');
  const m = await env.open();
  // A whole walk passes over what the list covers, and doesn't count it as
  // a region it couldn't reach.
  assert.deepEqual(await data(m, 'ls', { path: 'ref' }), { path: 'ref', entries: [{ name: 'src', type: 'directory' }], count: 1 });
  assert.deepEqual(await data(m, 'glob', { pattern: '**/*.js' }), { pattern: '**/*.js', matches: [{ path: 'ref/src/a.js', size: 7 }], count: 1 });
  const grep = await data<{ results: Array<{ file: string }>; incomplete?: unknown }>(m, 'grep', { pattern: 'needle' });
  assert.deepEqual(grep.results.map((r) => r.file), ['ref/src/a.js']);
  assert.equal(grep.incomplete, undefined);
  // Named, by a path or a pattern's directory: walked, the rest of the list
  // applying beneath it.
  assert.deepEqual((await data(m, 'ls', { path: 'ref/node_modules/pkg' })).entries, [{ name: 'index.js', type: 'file', size: 7 }]);
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'node_modules/pkg/*.js' })).matches, [{ path: 'ref/node_modules/pkg/index.js', size: 7 }]);
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle', path: 'ref/node_modules' })).results.map((r) => r.file),
    ['ref/node_modules/pkg/index.js'],
  );
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle', glob: 'node_modules/**' })).results.map((r) => r.file),
    ['ref/node_modules/pkg/index.js'],
  );
  // A list the config names replaces it.
  const own = await env.open({ ignore: ['dist'] });
  assert.deepEqual(
    (await data<{ matches: Array<{ path: string }> }>(own, 'glob', { pattern: '**/*.js' })).matches.map((x) => x.path),
    ['ref/node_modules/pkg/index.js', 'ref/src/a.js'],
  );
});

test('glob and grep on a direct mount find a file the moment disk has it, as disk has it', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'alpha\n');
  env.file('src/notes.md', 'notes\n');
  const m = await env.open();
  assert.equal((await data<{ count: number }>(m, 'glob', { pattern: 'src/*.ts' })).count, 1);
  env.file('src/b.ts', 'beta\nalpha again\n');
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'src/*.ts' })).matches, [
    { path: 'ref/src/a.ts', size: 6 },
    { path: 'ref/src/b.ts', size: 17 },
  ]);
  assert.deepEqual(await data(m, 'grep', { pattern: 'alpha', path: 'ref/src', contextAfter: 1 }), {
    pattern: 'alpha',
    results: [
      { file: 'ref/src/a.ts', version: 'disk', matches: [{ line: 1, text: 'alpha', context: ['alpha'] }] },
      { file: 'ref/src/b.ts', version: 'disk', matches: [{ line: 2, text: 'alpha again', context: ['alpha again'] }] },
    ],
    totalMatches: 2,
  });
  assert.deepEqual((await data<{ results: unknown[] }>(m, 'grep', { pattern: 'beta', path: 'ref/src/b.ts' })).results, [
    { file: 'ref/src/b.ts', version: 'disk', matches: [{ line: 1, text: 'beta' }] },
  ]);
  assert.deepEqual(
    (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'alpha', glob: 'src/b.*' })).results.map((r) => r.file),
    ['ref/src/b.ts'],
  );
});

test("a direct mount's walks keep the cap, start where their pattern names, and say what they couldn't reach", async (t) => {
  const env = new Env(t);
  for (const name of ['1', '2', '3']) env.file(`node_modules/aaa/${name}.js`, 'x\n');
  env.file('node_modules/pkg/index.js', 'x\n');
  const m = await env.open({ walkCap: 2 });
  // The start descends into the directory the pattern names, past what the
  // cap would leave of a walk from above it.
  assert.deepEqual((await data<{ matches: unknown[] }>(m, 'glob', { pattern: 'node_modules/pkg/*.js' })).matches, [{ path: 'ref/node_modules/pkg/index.js', size: 2 }]);
  const capped = [
    { path: 'node_modules/aaa', reason: 'the walk cap (2) was reached before everything here was taken' },
    { path: 'node_modules/pkg', reason: 'not visited: the walk cap (2) was reached' },
  ];
  assert.deepEqual(await data(m, 'ls', { path: 'ref/node_modules', recursive: true }), {
    path: 'ref/node_modules',
    entries: [{ path: 'node_modules/aaa/1.js', size: 2 }, { path: 'node_modules/aaa/2.js', size: 2 }],
    count: 2,
    incomplete: capped,
  });
  assert.deepEqual(
    (await data<{ incomplete: unknown[] }>(m, 'grep', { pattern: 'x', path: 'ref/node_modules' })).incomplete,
    capped.map((region) => ({ ...region, path: `ref/${region.path}` })),
  );
});

test("a direct listing names a directory it couldn't list", { skip: IS_ROOT ? 'root lists every directory' : false }, async (t) => {
  const env = new Env(t);
  env.file('open/a.ts', 'a\n');
  env.file('shut/b.ts', 'b\n');
  const m = await env.open();
  chmodSync(join(env.ref, 'shut'), 0o000);
  try {
    assert.deepEqual(await data(m, 'ls', { path: 'ref', recursive: true }), {
      path: 'ref',
      entries: [{ path: 'open/a.ts', size: 2 }],
      count: 1,
      incomplete: [{ path: 'shut', reason: 'cannot list (EACCES)' }],
    });
  } finally {
    chmodSync(join(env.ref, 'shut'), 0o755);
  }
});

test("a direct mount's read loads none of a file over the size limit and grep only its head, and both refuse one that grows past it as it's read", async (t) => {
  const env = new Env(t);
  env.file('grows.txt', 'x'.repeat(8));
  env.file('huge.txt', 'y'.repeat(100_000));
  const m = await env.open({ maxFileSize: 10 });
  const over = (path: string) => `${path} is over the size limit (10 bytes), so read doesn't show it.`;
  // Over the limit at its open: read loads none of it, and grep its head.
  const read = await countingLoads(() => call(m, 'read', { path: 'ref/huge.txt' }));
  assert.deepEqual([read.result.error, read.loaded], [over('ref/huge.txt'), 0]);
  const grep = await countingLoads(() => call(m, 'grep', { pattern: 'y', path: 'ref/huge.txt' }));
  assert.deepEqual((grep.result.structured as { skipped: unknown[] }).skipped, [{ file: 'ref/huge.txt', reason: 'over the size limit (10 bytes)', size: 100_000 }]);
  assert.equal(grep.loaded, 8192);
  // Grown past it after its open's fstat: no more than the limit and a byte.
  const grows = join(env.ref, 'grows.txt');
  const grown = await changedAfterFstat(grows, () => appendFileSync(grows, 'x'.repeat(1000)),
    () => countingLoads(() => call(m, 'read', { path: 'ref/grows.txt' })));
  assert.equal(grown.result.error, over('ref/grows.txt'));
  assert.ok(grown.loaded <= 11, `loaded ${grown.loaded}`);
  writeFileSync(grows, 'x'.repeat(8));
  const grownGrep = await changedAfterFstat(grows, () => appendFileSync(grows, 'x'.repeat(1000)),
    () => countingLoads(() => call(m, 'grep', { pattern: 'x', path: 'ref/grows.txt' })));
  assert.deepEqual((grownGrep.result.structured as { skipped: unknown[] }).skipped, [{ file: 'ref/grows.txt', reason: 'over the size limit (10 bytes)', size: 1008 }]);
  assert.ok(grownGrep.loaded <= 11, `loaded ${grownGrep.loaded}`);
});

test("a direct mount's read and grep say so where reading a file fails", async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'needle\n');
  const m = await env.open();
  const failing = { read: () => async function () { throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }); } };
  assert.equal((await withFileHandle(failing, () => call(m, 'read', { path: 'ref/a.txt' }))).error, 'Unable to read file: ref/a.txt (EIO)');
  assert.deepEqual((await withFileHandle(failing, () => call(m, 'grep', { pattern: 'needle' }))).structured, {
    pattern: 'needle',
    results: [],
    totalMatches: 0,
    skipped: [{ file: 'ref/a.txt', reason: 'cannot read (EIO)' }],
  });
});

test("read on a direct mount says why it couldn't open a file", { skip: IS_ROOT ? 'root opens every file' : false }, async (t) => {
  const env = new Env(t);
  env.file('noperm.txt', 'secret\n');
  env.file('shut/b.ts', 'b\n');
  const m = await env.open();
  chmodSync(join(env.ref, 'noperm.txt'), 0o000);
  chmodSync(join(env.ref, 'shut'), 0o000);
  try {
    assert.equal(await failure(m, 'read', { path: 'ref/noperm.txt' }), 'Unable to read file: ref/noperm.txt (EACCES)');
    assert.equal(await failure(m, 'read', { path: 'ref/shut/b.ts' }), 'Unable to read file: ref/shut/b.ts (EACCES)');
  } finally {
    chmodSync(join(env.ref, 'noperm.txt'), 0o644);
    chmodSync(join(env.ref, 'shut'), 0o755);
  }
});

test('a file gone between the walk that listed it and its read is neither listed nor searched', async (t) => {
  const env = new Env(t);
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const name of names) env.file(name, 'needle\n');
  const m = await env.open();
  const gone = join(env.ref, 'f30.txt');
  const left = names.filter((name) => name !== 'f30.txt');
  // grep reads 16 at a time, in order: the 31st file is opened only once the
  // 15th is done, so after the 2nd file's open, when it's removed.
  const grep = await changedAfterFstat(join(env.ref, 'f01.txt'), () => unlinkSync(gone),
    () => data<{ results: Array<{ file: string }>; skipped?: unknown }>(m, 'grep', { pattern: 'needle' }));
  assert.deepEqual(grep.results.map((r) => r.file), left.map((name) => `ref/${name}`));
  assert.equal(grep.skipped, undefined);
  // A listing looks at each file by its path, where this one is removed
  // first. The look is known by the file's name, since the listing reads
  // beneath the root it resolved, which on macOS isn't spelled as `env.ref`
  // is (/var there is a link to /private/var).
  env.file('f30.txt', 'needle\n');
  const listed = await withFsPromise('lstat', (lstat) => async (...args: any[]) => {
    if (basename(String(args[0])) === 'f30.txt') rmSync(gone, { force: true });
    return lstat(...args);
  }, () => data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true }));
  assert.deepEqual(listed.entries.map((e) => e.path), left);
});

test('grep on a direct mount lists what it doesn\'t search, with why', async (t) => {
  const env = new Env(t);
  env.file('text.txt', 'needle\n');
  env.file('bin.dat', Buffer.concat([Buffer.from('needle'), Buffer.from([0])]));
  env.file('dot.png', PNG);
  env.file('big.txt', 'needle '.repeat(40));
  symlinkSync(join(env.ref, 'text.txt'), join(env.ref, 'link.txt'));
  const m = await env.open({ maxFileSize: 100 });
  assert.deepEqual(await data(m, 'grep', { pattern: 'needle' }), {
    pattern: 'needle',
    results: [{ file: 'ref/text.txt', version: 'disk', matches: [{ line: 1, text: 'needle' }] }],
    totalMatches: 1,
    skipped: [
      { file: 'ref/big.txt', reason: 'over the size limit (100 bytes)', size: 280 },
      { file: 'ref/bin.dat', reason: 'binary: a NUL in its first 8 KB', size: 7 },
      { file: 'ref/dot.png', reason: 'binary: a NUL in its first 8 KB', size: PNG.byteLength, mimeType: 'image/png' },
      { file: 'ref/link.txt', reason: 'a symlink, which this mount does not follow' },
    ],
  });
});

test('grep on a direct mount that follows links names a link to a directory as its listing does', async (t) => {
  const env = new Env(t);
  env.file('dir/x.ts', 'needle\n');
  symlinkSync(join(env.ref, 'dir'), join(env.ref, 'linkdir'));
  const m = await env.open({ followSymlinks: true });
  const listed = await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true });
  assert.deepEqual(listed.entries.find((e) => e.path === 'linkdir'), { path: 'linkdir', note: 'a symlink to a directory, not walked' });
  assert.deepEqual((await data<{ skipped?: unknown[] }>(m, 'grep', { pattern: 'needle' })).skipped, [
    { file: 'ref/linkdir', reason: 'a symlink to a directory, not walked' },
  ]);
});

test("grep on a direct mount names a link to a directory it can't open as its listing does, and a file it can't open by the open's reason", { skip: IS_ROOT ? 'root opens everything' : false }, async (t) => {
  const env = new Env(t);
  env.file('shut/x.ts', 'needle\n');
  env.file('noperm.txt', 'needle\n');
  symlinkSync(join(env.ref, 'shut'), join(env.ref, 'linkshut'));
  const m = await env.open({ followSymlinks: true, ignore: ['shut'] });
  chmodSync(join(env.ref, 'shut'), 0o311);
  chmodSync(join(env.ref, 'noperm.txt'), 0o000);
  try {
    const listed = await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true });
    assert.deepEqual(listed.entries.find((e) => e.path === 'linkshut'), { path: 'linkshut', note: 'a symlink to a directory, not walked' });
    assert.deepEqual((await data<{ skipped?: unknown[] }>(m, 'grep', { pattern: 'needle' })).skipped, [
      { file: 'ref/linkshut', reason: 'a symlink to a directory, not walked' },
      { file: 'ref/noperm.txt', reason: 'cannot open (EACCES)' },
    ]);
  } finally {
    chmodSync(join(env.ref, 'shut'), 0o755);
    chmodSync(join(env.ref, 'noperm.txt'), 0o644);
  }
});

test("grep's results come in path order, however its reads finish", async (t) => {
  const env = new Env(t);
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const name of [...names].reverse()) env.file(`many/${name}`, `${name} needle\n`.repeat(1 + (names.indexOf(name) % 7) * 500));
  const m = await env.open();
  // The first file's reads wait until the other fifteen files read beside
  // it have been read, so it finishes after them.
  const first = String(statSync(join(env.ref, 'many', names[0]!), { bigint: true }).ino);
  const slow = new WeakSet<object>();
  const read = new WeakSet<object>();
  let othersRead = 0;
  let fifteenRead!: () => void;
  const fifteen = new Promise<void>((resolve) => { fifteenRead = resolve; });
  let readBeforeFirst = -1;
  const result = await withFileHandle({
    stat: (stat) => async function (this: object, ...args: unknown[]) {
      const seen = await stat.apply(this, args);
      if (String(seen.ino) === first) slow.add(this);
      return seen;
    },
    read: (original) => async function (this: object, ...args: unknown[]) {
      if (slow.has(this)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([fifteen, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
        clearTimeout(timer);
        readBeforeFirst = othersRead;
        return original.apply(this, args);
      }
      const answer = await original.apply(this, args);
      if (!read.has(this)) {
        read.add(this);
        if (++othersRead === 15) fifteenRead();
      }
      return answer;
    },
  }, () => data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle' }));
  assert.ok(readBeforeFirst >= 15, `${readBeforeFirst} other files were read before the first`);
  assert.deepEqual(result.results.map((r) => r.file), names.map((name) => `ref/many/${name}`));
});

test('a direct grep and listing read 16 files at a time', async (t) => {
  const env = new Env(t);
  for (let i = 0; i < 40; i++) env.file(`f${String(i).padStart(2, '0')}.txt`, 'needle\n');
  const m = await env.open();
  // The files' own calls: a walk's are on directories.
  const files = /[\\/]f\d\d\.txt$/;
  assert.equal(await mostAtOnce('open', 16, files, () => data(m, 'grep', { pattern: 'needle' })), 16);
  assert.equal(await mostAtOnce('lstat', 16, files, () => data(m, 'ls', { path: 'ref', recursive: true })), 16);
});

test("a direct mount's reads close every file they open, whatever they answer", async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'needle\n');
  env.file('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
  env.file('big.txt', 'x'.repeat(100));
  env.file('dot.png', PNG);
  const m = await env.open({ maxFileSize: 90 });
  // Each handle a read opens is fstat'd; a closed one's fd reads -1.
  const opened = new Set<{ fd: number }>();
  await withFileHandle({
    stat: (stat) => async function (this: { fd: number }, ...args: unknown[]) {
      opened.add(this);
      return stat.apply(this, args);
    },
  }, async () => {
    for (const path of ['ref/a.txt', 'ref/bin.dat', 'ref/big.txt']) await call(m, 'read', { path });
    await call(m, 'grep', { pattern: 'needle' });
    await call(m, 'read_image', { path: 'ref/dot.png' });
    await m.readBinary('ref/bin.dat');
  });
  assert.ok(opened.size >= 9, `opened ${opened.size}`);
  assert.deepEqual([...opened].map((handle) => handle.fd).filter((fd) => fd !== -1), []);
});

test("grep gives a skipped file's size as its reads found it, when the file changes as it's read", async (t) => {
  const env = new Env(t);
  env.file('grows.txt', 'x'.repeat(8));
  env.file('bin.dat', Buffer.from('a\0bcdefg'));
  const m = await env.open({ maxFileSize: 10 });
  // Grown past the limit after its open's fstat, then cut short before its
  // size is read again: at least a byte past the limit, as its reads found.
  const grows = join(env.ref, 'grows.txt');
  let stats = 0;
  const grown = await withFileHandle({
    stat: (stat) => async function (this: object, ...args: unknown[]) {
      stats++;
      if (stats === 2) truncateSync(grows, 5);
      const seen = await stat.apply(this, args);
      if (stats === 1) appendFileSync(grows, 'x'.repeat(1000));
      return seen;
    },
  }, () => data<{ skipped: unknown[] }>(m, 'grep', { pattern: 'x', path: 'ref/grows.txt' }));
  assert.deepEqual(grown.skipped, [{ file: 'ref/grows.txt', reason: 'over the size limit (10 bytes)', size: 11 }]);
  // Cut short after its fstat, within the limit: the bytes read.
  const bin = join(env.ref, 'bin.dat');
  const shrunk = await changedAfterFstat(bin, () => truncateSync(bin, 4), () => data<{ skipped: unknown[] }>(m, 'grep', { pattern: 'b', path: 'ref/bin.dat' }));
  assert.deepEqual(shrunk.skipped, [{ file: 'ref/bin.dat', reason: 'binary: a NUL in its first 8 KB', size: 4 }]);
});

test('a direct read that finds its root replaced as it opens the file says to read again', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'a\n');
  const m = await env.open();
  const error = await changedAfterFstat(join(env.ref, 'a.txt'), () => {
    renameSync(env.ref, `${env.ref}-before`);
    mkdirSync(env.ref);
  }, () => failure(m, 'read', { path: 'ref/a.txt' }));
  assert.equal(error, 'Mount unavailable: ref: the mount root was replaced as the file was opened: reading it again reads the directory there now');
  assert.equal(await failure(m, 'read', { path: 'ref/a.txt' }), 'File not found: ref/a.txt');
});

test("a direct mount takes each spelling of a path as a 'chronicle' mount does", async (t) => {
  const env = new Env(t);
  env.file('a.ts', 'alpha\n');
  env.file('dir/x.ts', 'alpha x\n');
  env.file('dot.png', PNG);
  const reads = ['ref/./a.ts', 'ref/dir/../a.ts', 'ref/dir//x.ts', 'ref/a.ts/', 'ref//a.ts', 'ref/dir/..', 'ref/../outside.txt', 'ref/dir/../../ref/a.ts'];
  const calls: Array<[string, Record<string, unknown>]> = [
    ...reads.map((path): [string, Record<string, unknown>] => ['read', { path }]),
    ['read_image', { path: 'ref/./dot.png' }],
    ['ls', { path: 'ref/./dir' }],
    ['ls', { path: 'ref/dir//' }],
    ['glob', { pattern: '*.ts', path: 'ref/dir/..' }],
    ['grep', { pattern: 'alpha', path: 'ref/./dir' }],
  ];
  const hostPaths = ['ref/a.ts/', 'ref/./dir/x.ts', 'ref/dir/../a.ts'];
  const direct = await env.open();
  const fromDisk = await answersOf(direct, calls, hostPaths);
  // Each spelling reaches what it names, and one that climbs out of the
  // mount is refused, by the parse every mount shares.
  assert.equal((fromDisk[0] as [string, unknown, { content: string }])[2].content, '     1\talpha');
  assert.match(await failure(direct, 'read', { path: 'ref/../outside.txt' }), /climbs above the root of mount "ref"/);
  await env.close(direct);
  assert.deepEqual(fromDisk, await answersOf(await env.openChronicle(), calls, hostPaths));
});

/**
 * What a 'chronicle' mount and a direct one both answer, kind by kind alike:
 * whether a call is refused, a file's text, and the names a listing, glob or
 * grep gives. A refusal's words are each kind's own, except where they come
 * from what the kinds share, which the tests check by name.
 */
function alike(result: ToolResult): unknown {
  if (!result.success) return { refused: true };
  const d = (result.structured ?? result.data) as Record<string, any>;
  if (Array.isArray(d)) return { text: d[0].text.split('\n')[0] };
  return {
    path: d.path,
    content: d.content,
    entries: d.entries?.map((e: { path?: string; name: string }) => e.path ?? e.name).sort(),
    matches: d.matches?.map((m: { path: string }) => m.path).sort(),
    results: d.results?.map((r: { file: string }) => r.file).sort(),
  };
}

/** Each call's answer as `alike` gives it, with the host's reads of each of `hostPaths` beside them. */
async function answersOf(m: WorkspaceModule, calls: Array<[string, Record<string, unknown>]>, hostPaths: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [name, input] of calls) out.push([name, input, alike(await call(m, name, input))]);
  for (const path of hostPaths) {
    const binary = await m.readBinary(path);
    const fromDisk = await m.readBinaryFromDisk(path);
    const text = await m.readFileFromDisk(path).then((read) => read.bytes.toString(), (err: unknown) => (err instanceof WorkspaceReadError ? `refused: ${err.code}` : 'threw'));
    out.push([path, 'error' in binary, 'error' in fromDisk, text, m.resolveAbsolutePath(path) !== null]);
  }
  return out;
}

test("a direct mount's include holds as a 'chronicle' mount's does", async (t) => {
  const env = new Env(t);
  for (const path of ['gate.json', 'gate.json.bak', 'notes.md', 'other.txt', 'sub/gate.json', 'sub/x.md', 'sub/y.txt', 'docs/a/b.txt', 'docsx/c.txt']) {
    env.file(path, `${path} needle\n`);
  }
  env.file('pic.png', PNG);
  env.file('docs/pic.png', PNG);
  const include = ['gate.json', '*.md', 'docs/**'];
  const calls: Array<[string, Record<string, unknown>]> = [
    ['ls', { path: 'ref', recursive: true }],
    ['ls', { path: 'ref/sub' }],
    ['ls', { path: 'ref/docsx' }],
    ['ls', { path: 'ref/other.txt' }],
    ['glob', { pattern: '**/*' }],
    ['glob', { pattern: '*.txt', path: 'ref/docs' }],
    ['glob', { pattern: '*', path: 'ref/other.txt' }],
    ['grep', { pattern: 'needle' }],
    ['grep', { pattern: 'needle', path: 'ref/docsx' }],
    ['grep', { pattern: 'needle', path: 'ref/sub/y.txt' }],
    ['read', { path: 'ref/notes.md' }],
    ['read', { path: 'ref/other.txt' }],
    ['read', { path: 'ref/sub/y.txt' }],
    ['read', { path: 'ref/docsx' }],
    ['read_image', { path: 'ref/other.txt' }],
    ['read_image', { path: 'ref/pic.png' }],
    ['read_image', { path: 'ref/docs/pic.png' }],
  ];
  const hostPaths = ['ref/notes.md', 'ref/other.txt', 'ref/docsx/c.txt', 'ref/pic.png'];
  const direct = await env.open({ include });
  const fromDisk = await answersOf(direct, calls, hostPaths);
  // The include's refusal is the shared parse's, in the same words, and `ls`
  // without a path lists it beside the kind.
  const said = /^"ref\/other\.txt" is outside the mount's include: mount "ref" holds only gate\.json, \*\.md, docs\/\*\*\./;
  assert.match(await failure(direct, 'read', { path: 'ref/other.txt' }), said);
  // An image the include leaves out is refused in the include's words too,
  // and one it covers is read.
  assert.match(await failure(direct, 'read_image', { path: 'ref/pic.png' }), /^"ref\/pic\.png" is outside the mount's include: mount "ref" holds only /);
  assert.ok((await call(direct, 'read_image', { path: 'ref/docs/pic.png' })).success);
  assert.deepEqual((await data<{ mounts: Array<Record<string, unknown>> }>(direct, 'ls')).mounts[0]!.include, include);
  assert.deepEqual((fromDisk[0] as [string, unknown, { entries: string[] }])[2].entries, ['docs/a/b.txt', 'docs/pic.png', 'gate.json', 'notes.md', 'sub/gate.json', 'sub/x.md']);
  await env.close(direct);
  assert.deepEqual(fromDisk, await answersOf(await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', include }), calls, hostPaths));
});

test("on a direct mount that follows links, a covered link that lands on a file its include leaves out is no file of the mount's, as on a 'chronicle' mount", async (t) => {
  const env = new Env(t);
  env.file('other.txt', 'needle\n');
  env.file('notes.md', 'needle\n');
  symlinkSync(join(env.ref, 'other.txt'), join(env.ref, 'link.md'));
  symlinkSync(join(env.ref, 'notes.md'), join(env.ref, 'also.md'));
  const include = ['*.md'];
  const calls: Array<[string, Record<string, unknown>]> = [
    ['read', { path: 'ref/link.md' }],
    ['read', { path: 'ref/also.md' }],
    ['ls', { path: 'ref', recursive: true }],
    ['grep', { pattern: 'needle' }],
  ];
  const direct = await env.open({ include, followSymlinks: true });
  const fromDisk = await answersOf(direct, calls, ['ref/link.md']);
  assert.match(await failure(direct, 'read', { path: 'ref/link.md' }), /Symlink escape detected: ref\/link\.md/);
  assert.deepEqual((fromDisk[3] as [string, unknown, { results: string[] }])[2].results, ['ref/also.md', 'ref/notes.md']);
  await env.close(direct);
  assert.deepEqual(fromDisk, await answersOf(await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', include, followSymlinks: true }), calls, ['ref/link.md']));
});

test("a path in a mount nested in a direct one is that mount's, whatever the direct mount's include says, as on a 'chronicle' mount", async (t) => {
  const env = new Env(t);
  env.file('inner/x.json', '{}\n');
  env.file('inner/y.md', 'y\n');
  env.file('top.md', 't\n');
  const inner: MountConfig = { name: 'inner', path: join(env.ref, 'inner'), mode: 'read-only', watch: 'never', include: ['*.json'] };
  const calls: Array<[string, Record<string, unknown>]> = [
    ['read', { path: 'ref/inner/x.json' }],
    ['read', { path: 'ref/inner/y.md' }],
    ['ls', { path: 'ref', recursive: true }],
    ['ls', { path: 'ref/inner' }],
  ];
  const direct = await env.open({ include: ['*.md'] }, [inner]);
  const fromDisk = await answersOf(direct, calls, ['ref/inner/x.json']);
  assert.match(await failure(direct, 'read', { path: 'ref/inner/y.md' }), /lies in mount "inner", nested in mount "ref"/);
  await env.close(direct);
  assert.deepEqual(fromDisk, await answersOf(await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never', include: ['*.md'] }, [inner]), calls, ['ref/inner/x.json']));
});

test("what a mount's history holds outside its include keeps no mount configured direct from starting direct", async (t) => {
  const env = new Env(t);
  env.file('notes.md', 'disk\n');
  // A 'chronicle' run with no include left a draft of a file the include
  // now leaves out.
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/src/b.ts', content: 'draft\n' });
  await env.close(chronicle);
  // And an intent it can't read, there too.
  env.store.treeSet('workspace/ref/intent', 'src/zz.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
  const m = await env.open({ include: ['*.md'] });
  assert.deepEqual(env.alerts, []);
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'direct');
});

test("a direct mount judges a path's scope by disk, not by history a 'chronicle' run of it left", async (t) => {
  const env = new Env(t);
  env.file('x.md', 'x\n');
  env.file('gone/a.md', 'a\n');
  // A 'chronicle' run took in x.md as a file and gone/a.md.
  const chronicle = await env.openChronicle();
  await data(chronicle, 'read', { path: 'ref/x.md' });
  await data(chronicle, 'read', { path: 'ref/gone/a.md' });
  await env.close(chronicle);
  // Since then x.md has become a directory, and gone/ has gone.
  rmSync(join(env.ref, 'x.md'));
  env.file('x.md/inner.md', 'needle\n');
  rmSync(join(env.ref, 'gone'), { recursive: true });
  const m = await env.open({ include: ['*.md'] });
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'direct');
  // grep takes x.md as the directory disk has, and searches what's in it.
  assert.deepEqual((await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'needle', path: 'ref/x.md' })).results.map((r) => r.file), ['ref/x.md/inner.md']);
  // gone, which the include doesn't cover, is no scope on disk, and history
  // the 'chronicle' run left doesn't make it one.
  assert.match(await failure(m, 'ls', { path: 'ref/gone' }), /outside the mount's include/);
});

test("a direct mount whose root is repointed through a link reads the mounts where they lie now", async (t) => {
  const env = new Env(t);
  // `ref` reaches `a` through a link, and `work` lies at `b/work` with a
  // draft disk lacks.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work', 'sub'), { recursive: true });
  writeFileSync(join(a, 'work', 'file.txt'), 'a\n');
  writeFileSync(join(b, 'work', 'file.txt'), 'disk\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  await data(m, 'write', { path: 'work/file.txt', content: 'draft\n' });
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/work/file.txt' })).content, '     1\ta');

  // Repointed to `b`, `ref/work` is `work`'s directory, for every read.
  rmSync(link);
  symlinkSync(b, link);
  const all = await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'disk' });
  assert.deepEqual(all.results.map((r) => r.file).filter((file) => file.startsWith('ref/')), []);
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);
  await assert.rejects(m.readFileFromDisk('ref/work/file.txt'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
  assert.deepEqual((await data(m, 'ls', { path: 'ref', recursive: true })).entries, []);
  assert.deepEqual((await data<{ results: unknown[] }>(m, 'grep', { pattern: 'disk', path: 'ref' })).results, []);
  const named = await data<{ results: unknown[]; incomplete: Array<{ path: string; reason: string }> }>(m, 'grep', { pattern: 'disk', path: 'ref/work' });
  assert.deepEqual([named.results, named.incomplete], [[], [{ path: 'ref/work', reason: 'it lies in mount "work", nested in this one: use "work"' }]]);
  assert.deepEqual((await data(m, 'ls', { path: 'ref/work' })).incomplete, [{ path: 'work', reason: 'it lies in mount "work", nested in this one: use "work"' }]);
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'work/file.txt' })).content, '     1\tdraft');

  // Pointed back at `a`, `ref/work` is `ref`'s own again.
  rmSync(link);
  symlinkSync(a, link);
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/work/file.txt' })).content, '     1\ta');

  // Repointed into `work`'s directory, `ref` reads what's there, and `work`
  // keeps the start's placement until the next start: the directory is
  // still its own too.
  rmSync(link);
  symlinkSync(join(b, 'work', 'sub'), link);
  writeFileSync(join(b, 'work', 'sub', 'inside.txt'), 'i\n');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/inside.txt' })).content, '     1\ti');
  const listed = await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'work', recursive: true });
  assert.ok(listed.entries.some((e) => e.path === 'sub/inside.txt'), JSON.stringify(listed.entries));
});

test("a direct mount moved away from a mount nested in it reads what's there as its own, in read, the host's read, ls and grep", async (t) => {
  const env = new Env(t);
  // `ref` starts at `b` through a link, where `work` lies nested at `b/work`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(a, 'work', 'file.txt'), 'mine\n');
  writeFileSync(join(b, 'work', 'file.txt'), 'theirs\n');
  const link = join(env.root, 'link');
  symlinkSync(b, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);

  // Repointed to `a`, nothing lies nested in `ref`, so `a/work` is its own.
  rmSync(link);
  symlinkSync(a, link);
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/work/file.txt' })).content, '     1\tmine');
  assert.equal((await m.readFileFromDisk('ref/work/file.txt')).bytes.toString(), 'mine\n');
  assert.deepEqual((await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true })).entries.map((e) => e.path), ['work/file.txt']);
  assert.deepEqual((await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'mine', path: 'ref/work' })).results.map((r) => r.file), ['ref/work/file.txt']);
});

test("a mount configured beneath a direct mount's path is nested where its moved root now puts it, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `ref` is configured through `link`, and `work` beneath it at
  // `link/work`, as a deploy's `current` link and a mount inside it are. In
  // `b`, a link to `work` and one to its file.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(a, 'work', 'file.txt'), 'old\n');
  writeFileSync(join(b, 'work', 'file.txt'), 'new\n');
  writeFileSync(join(b, 'top.txt'), 'top\n');
  symlinkSync('work', join(b, 'alias'));
  symlinkSync(join('work', 'file.txt'), join(b, 'alias.txt'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'work', path: join(link, 'work'), mode: 'read-write', watch: 'never' }]];
  const moved = await env.open(...mounts);

  // Repointed to `b`, `work`'s path leads to `b/work`, which is still
  // `work`'s: by its directory, and by where a link into it lands.
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await failure(m, 'read', { path: 'ref/work/file.txt' }),
    throughLink: await failure(m, 'read', { path: 'ref/alias/file.txt' }),
    fileLink: await call(m, 'read', { path: 'ref/alias.txt' }),
    disk: await m.readFileFromDisk('ref/work/file.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    listed: (await data<{ entries: unknown[] }>(m, 'ls', { path: 'ref', recursive: true })).entries,
    found: await data(m, 'grep', { pattern: 'new', path: 'ref' }),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read, /lies in mount "work", nested in mount "ref"/);
  assert.match(fromStart.throughLink, /"ref\/alias\/file\.txt" leads into mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'other_mount');
  assert.deepEqual((fromStart.found as { results: unknown[] }).results, []);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a moved direct root, at a directory that's a link there, is nested as a start there nests it", async (t) => {
  const env = new Env(t);
  // `work` is configured at `link/work`, and in `b` that's a link to
  // `real-work`, a directory beside it.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'real-work'), { recursive: true });
  symlinkSync('real-work', join(b, 'work'));
  writeFileSync(join(b, 'real-work', 'file.txt'), 'b work\n');
  writeFileSync(join(b, 'own.txt'), 'own\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'work', path: join(link, 'work'), mode: 'read-write', watch: 'never' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await failure(m, 'read', { path: 'ref/real-work/file.txt' }),
    disk: await m.readFileFromDisk('ref/real-work/file.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    own: (await data<{ content: string }>(m, 'read', { path: 'ref/own.txt' })).content,
    listed: (await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true })).entries.map((e) => e.path),
    found: (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'b work', path: 'ref' })).results.map((r) => r.file),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read, /lies in mount "work", nested in mount "ref"/);
  assert.deepEqual([fromStart.disk, fromStart.found], ['other_mount', []]);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a moved direct root, at a link that leads above it, is nested by its directory alone, as a start there nests it", async (t) => {
  const env = new Env(t);
  // In `b`, `work` leads to `b`'s parent, which holds `b`: through it,
  // `work` would claim every path of `ref`'s.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(b, { recursive: true });
  symlinkSync('..', join(b, 'work'));
  writeFileSync(join(b, 'own.txt'), 'own\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'work', path: join(link, 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    own: (await data<{ content: string }>(m, 'read', { path: 'ref/own.txt' })).content,
    listed: (await data<{ entries: Array<{ path: string }> }>(m, 'ls', { path: 'ref', recursive: true })).entries.map((e) => e.path),
  });
  const fromStart = await answers(started);
  assert.equal(fromStart.own, '     1\town');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a file tool's parse judges where a link on the way leads beneath the root it resolved, though the root moves after", async (t) => {
  const env = new Env(t);
  // At `b`, `alias` is a link into `work`'s directory; at `a`, a directory of
  // `ref`'s own.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'alias'), { recursive: true });
  writeFileSync(join(a, 'alias', 'file.txt'), 'mine\n');
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'file.txt'), 'theirs\n');
  symlinkSync('work', join(b, 'alias'));
  const link = join(env.root, 'link');
  symlinkSync(b, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  const atB = await m.readFileFromDisk('ref/alias/file.txt').then(() => null, (e: unknown) => e);
  assert.ok(atB instanceof WorkspaceReadError, String(atB));
  // The parse resolves the root at `b`, and the link is repointed to `a` as
  // that answers: the parse's check of where the path leads is made beneath
  // `b`, as its nesting is, the link on the way included, so the read
  // answers as one made at `b` does.
  let repointed = false;
  const err = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(a, link);
    }
    return real;
  }, () => m.readFileFromDisk('ref/alias/file.txt').then(() => null, (e: unknown) => e));
  assert.ok(repointed);
  assert.ok(err instanceof WorkspaceReadError, String(err));
  assert.deepEqual([err.code, err.stage, err.message], [atB.code, atB.stage, atB.message]);
  assert.deepEqual([err.code, err.stage], ['other_mount', 'readlink']);
});

test("a file tool's parse judges where a followed link lands against the include beneath the root it resolved, though the root moves after", async (t) => {
  const env = new Env(t);
  // At `b`, `link.md` leads to a file the include leaves out; at `a`, it's a
  // covered file of its own.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'link.md'), 'a link.md\n');
  writeFileSync(join(b, 'other.txt'), 'b other\n');
  symlinkSync('other.txt', join(b, 'link.md'));
  const link = join(env.root, 'link');
  symlinkSync(b, link);
  const m = await env.open({ path: link, followSymlinks: true, include: ['*.md'] });
  // The parse resolves the root at `b`, and the link is repointed to `a` as
  // that answers: the parse's check of where the path lands is made beneath
  // `b`, where it lands on a file the include leaves out.
  let repointed = false;
  const err = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(a, link);
    }
    return real;
  }, () => m.readFileFromDisk('ref/link.md').then(() => null, (e: unknown) => e));
  assert.ok(repointed);
  assert.ok(err instanceof WorkspaceReadError, String(err));
  assert.deepEqual([err.code, err.message], ['escape', 'Symlink escape detected: ref/link.md']);
});

test("a file tool's parse reads a link on the way beneath the root it resolved, so a root moved after names nothing another mount's include leaves out", async (t) => {
  const env = new Env(t);
  // At `a`, `alias` leads into `old`, nested there; at `b`, an `alias` leads
  // to a file `private`'s include leaves out.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'old'), { recursive: true });
  writeFileSync(join(a, 'old', 'public.json'), '{}\n');
  symlinkSync(join('old', 'public.json'), join(a, 'alias'));
  mkdirSync(join(b, 'private'), { recursive: true });
  writeFileSync(join(b, 'private', 'secret.env'), 'S=1\n');
  symlinkSync(join('private', 'secret.env'), join(b, 'alias'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [
    { name: 'old', path: join(link, 'old'), mode: 'read-only', backend: 'direct' },
    { name: 'private', path: join(b, 'private'), mode: 'read-only', backend: 'direct', include: ['*.json'] },
  ]);
  // The parse resolves the root at `a`, and the link is repointed to `b` as
  // that answers: the refusal reads `alias` beneath `a`, where it leads into
  // `old`.
  let repointed = false;
  const err = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => m.readFileFromDisk('ref/alias').then(() => null, (e: unknown) => e));
  assert.ok(repointed);
  assert.ok(err instanceof WorkspaceReadError, String(err));
  assert.equal(err.code, 'other_mount');
  assert.match(err.message, /old/);
  assert.doesNotMatch(err.message, /private|secret/);
});

test("a mount configured in a moved direct root's new directory, through a link to that directory, is nested as a start there nests it", async (t) => {
  const env = new Env(t);
  // `work` is configured at `b/work`, a link to `b` itself, so a start with
  // `ref` at `b` nests `work` at `work`, by its configured path alone, and
  // not at `b/work`, which `b` holds too, as no directory above `b` is `b`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'b', 'work'), { recursive: true });
  writeFileSync(join(b, 'file.txt'), 'b file\n');
  writeFileSync(join(b, 'b', 'work', 'own.txt'), 'b own\n');
  symlinkSync('.', join(b, 'work'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'work', path: join(b, 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/work/file.txt' }),
    disk: await m.readFileFromDisk('ref/work/file.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    own: (await data<{ content: string }>(m, 'read', { path: 'ref/file.txt' })).content,
    alike: (await data<{ content: string }>(m, 'read', { path: 'ref/b/work/own.txt' })).content,
    found: (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'b file', path: 'ref' })).results.map((r) => r.file),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'other_mount');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured at a link into a moved direct root's new directory is nested where the link leads, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `work` is configured at `w`, a link to `b/deep/work`, so a start with
  // `ref` at `b` nests it by its real root alone: no directory above `w`
  // is `b`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'deep', 'work'), { recursive: true });
  writeFileSync(join(b, 'deep', 'work', 'file.txt'), 'work file\n');
  writeFileSync(join(b, 'own.txt'), 'b own file\n');
  symlinkSync(join(b, 'deep', 'work'), join(env.root, 'w'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'work', path: join(env.root, 'w'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/deep/work/file.txt' }),
    disk: await m.readFileFromDisk('ref/deep/work/file.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    found: (await data<{ results: Array<{ file: string }> }>(m, 'grep', { pattern: 'file', path: 'ref' })).results.map((r) => r.file),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'other_mount');
  assert.deepEqual(fromStart.found, ['ref/own.txt']);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a moved direct root, through a directory there that's the root itself, is nested beneath that directory too, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `work` is configured at `link/sub/work`. At `b`, `sub` and `work` are
  // links to `.`, so a start with `ref` at `b` nests `work` at `sub/work`
  // and, beneath `sub`, which is `b` itself, at `work`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'sub', 'work'), { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'file.txt'), 'b file\n');
  symlinkSync('.', join(b, 'sub'));
  symlinkSync('.', join(b, 'work'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'work', path: join(link, 'sub', 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/work/file.txt' }),
    disk: await m.readFileFromDisk('ref/work/file.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    ls: await call(m, 'ls', { path: 'ref/work' }),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'other_mount');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a moved direct root is nested beneath a directory on the way that's the root though it's not the first, and beneath none that isn't", async (t) => {
  const env = new Env(t);
  // `work` is configured at `link/x/y/work`. At `b`, `x` is a directory and
  // `x/y` leads to `..`, `b` itself, and `work` to `.`: a start with `ref` at
  // `b` nests `work` at `x/y/work` and, beneath `x/y`, at `work`, and not
  // beneath `x`, which isn't `b`, so `y/work` is `ref`'s own.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'x', 'y', 'work'), { recursive: true });
  mkdirSync(join(b, 'x'), { recursive: true });
  mkdirSync(join(b, 'y', 'work'), { recursive: true });
  writeFileSync(join(b, 'file.txt'), 'b file\n');
  writeFileSync(join(b, 'y', 'work', 'own.txt'), 'b own\n');
  symlinkSync('..', join(b, 'x', 'y'));
  symlinkSync('.', join(b, 'work'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'work', path: join(link, 'x', 'y', 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/work/file.txt' }),
    own: await call(m, 'read', { path: 'ref/y/work/own.txt' }),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.equal((fromStart.own.structured as { content: string }).content, '     1\tb own');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a direct root moved to a directory beneath its own configured path nests no mount by where the last start found a directory beneath that path", async (t) => {
  const env = new Env(t);
  // `work` is configured at `link/sub/work`. The start, with `link` at `a`,
  // finds `link/sub` at `a/sub`; then `link` leads to `a/sub`, where
  // `sub/work` is `work`'s directory and `work` is `ref`'s own.
  const a = join(env.root, 'a');
  mkdirSync(join(a, 'sub', 'sub', 'work'), { recursive: true });
  mkdirSync(join(a, 'sub', 'work'), { recursive: true });
  writeFileSync(join(a, 'sub', 'work', 'own.txt'), 'sub own\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'work', path: join(link, 'sub', 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(join(a, 'sub'), link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    own: await call(m, 'read', { path: 'ref/work/own.txt' }),
    nested: await call(m, 'read', { path: 'ref/sub/work/x.txt' }),
  });
  const fromStart = await answers(started);
  assert.equal((fromStart.own.structured as { content: string }).content, '     1\tsub own');
  assert.match(fromStart.nested.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a direct root moved to a directory above its configured path is nested beneath that directory too, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `ref` is configured at `b/link`, which leads first to `a` and then to
  // `.`, `b` itself; `work` is configured at `b/link/work`. A start with
  // `ref` at `b` nests `work` at `work` and, beneath `b`, at `link/work`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'f.txt'), 'work f\n');
  const link = join(b, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'work', path: join(link, 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync('.', link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/link/work/f.txt' }),
    disk: await m.readFileFromDisk('ref/link/work/f.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'other_mount');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured at a moved direct root's own path is nested nowhere in it, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `ref` and `twin` are both configured at `link`. It leads first to `a`,
  // which lies in `b` as `sub`, and then to `b`, where a start nests
  // neither mount in the other.
  const b = join(env.root, 'b');
  const a = join(b, 'sub');
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, 'f.txt'), 'sub f\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'twin', path: link, mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/sub/f.txt' }),
    disk: await m.readFileFromDisk('ref/sub/f.txt').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
  });
  const fromStart = await answers(started);
  assert.equal((fromStart.read.structured as { content: string }).content, '     1\tsub f');
  assert.equal(fromStart.disk, 'read');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured at a moved direct root's own path is nested beneath a directory above that path that's the root now, as a start there nests it", async (t) => {
  const env = new Env(t);
  // `ref` and `twin` are both configured at `b/link`, which leads first to
  // `b/sub` and then to `.`, `b` itself: a start there nests `twin` in `ref`
  // at `link`, beneath `b`, the directory above `b/link`.
  const b = join(env.root, 'b');
  mkdirSync(join(b, 'sub'), { recursive: true });
  writeFileSync(join(b, 'f.txt'), 'b f\n');
  const link = join(b, 'link');
  symlinkSync(join(b, 'sub'), link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link, followSymlinks: true }, [{ name: 'twin', path: link, mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync('.', link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    read: await call(m, 'read', { path: 'ref/link/f.txt' }),
    own: (await data<{ content: string }>(m, 'read', { path: 'ref/f.txt' })).content,
  });
  const fromStart = await answers(started);
  assert.match(fromStart.read.error ?? '', /lies in mount "twin", nested in mount "ref"/);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a mount configured beneath a direct root whose path's own directory above leads elsewhere now is nested as a start there nests it", async (t) => {
  const env = new Env(t);
  // `ref` is configured at `current/ref` and `work` at `current/ref/work`.
  // `current` leads first to `a` and then to `b`, where `ref` and `work` lead
  // to `.`: a start there finds `current` at `b`, the root, and nests `work`
  // at `work` and, beneath `current`, at `ref/work`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'ref', 'work'), { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'file.txt'), 'b file\n');
  symlinkSync('.', join(b, 'ref'));
  symlinkSync('.', join(b, 'work'));
  const current = join(env.root, 'current');
  symlinkSync(a, current);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: join(current, 'ref'), followSymlinks: true }, [{ name: 'work', path: join(current, 'ref', 'work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(current);
  symlinkSync(b, current);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    through: await call(m, 'read', { path: 'ref/ref/work/file.txt' }),
    read: await call(m, 'read', { path: 'ref/work/file.txt' }),
  });
  const fromStart = await answers(started);
  assert.match(fromStart.through.error ?? '', /lies in mount "work", nested in mount "ref"/);
  assert.deepEqual(await answers(moved), fromStart);
});

test("a direct mount whose moved root can't be looked at for a reason other than absence nests what a start there would, not what the last start placed", async (t) => {
  const env = new Env(t);
  // `work` lies at `b/work`, outside `a`, so the start with `ref` at `a`
  // nests nothing; at `b`, it's nested at `work`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'file.txt'), 'work file\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-only', backend: 'direct' }]);
  rmSync(link);
  symlinkSync(b, link);
  // A look at the moved root fails, as on an I/O error, though everything
  // else reads it: the nesting is still judged beneath it.
  const realB = realpathSync(b);
  const answer = await withFsPromise('stat', (original) => async (...args: any[]) => {
    if (args[0] === realB) throw Object.assign(new Error(`EIO: i/o error, stat '${realB}'`), { code: 'EIO' });
    return original(...args);
  }, () => call(m, 'read', { path: 'ref/work/file.txt' }));
  assert.match(answer.error ?? '', /lies in mount "work", nested in mount "ref"/);
});

test("a direct grep of a named file reads it beneath the root its read resolved, though the root is repointed before the open", async (t) => {
  const env = new Env(t);
  // `b` lies in `a` as `sub`, and at `b`, `file.txt` is a link into `work`'s
  // directory there, at a file `work`'s include leaves out.
  const a = join(env.root, 'a');
  const b = join(a, 'sub');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(a, 'file.txt'), 'a needle\n');
  writeFileSync(join(b, 'work', 'secret.env'), 'S=needle\n');
  symlinkSync(join('work', 'secret.env'), join(b, 'file.txt'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link, followSymlinks: true }, [{ name: 'work', path: join(link, 'work'), mode: 'read-only', backend: 'direct', include: ['*.json'] }]);
  // The parse resolves the root at `a`, and the read resolves it again; the
  // link is repointed to `b` as that answers, before the file is opened.
  let resolved = 0;
  const found = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (args[0] === link && ++resolved === 2) {
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => data<{ results: Array<{ file: string; matches: Array<{ text: string }> }> }>(m, 'grep', { pattern: 'needle', path: 'ref/file.txt' }));
  assert.equal(resolved, 2);
  assert.deepEqual(found.results.map((r) => [r.file, r.matches.map((x) => x.text)]), [['ref/file.txt', ['a needle']]]);
});

test("a direct grep judges whether a path it's given names a file beneath the root its parse resolved, though the root moves after", async (t) => {
  const env = new Env(t);
  // At `a`, `notes` is a file; at `b`, a directory.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'notes'), { recursive: true });
  writeFileSync(join(a, 'notes'), 'a needle\n');
  writeFileSync(join(b, 'notes', 'inner.md'), 'b needle\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link });
  // The parse resolves the root at `a`, and the link is repointed to `b` as
  // that answers: the path is judged a file beneath `a`, and the read,
  // which resolves the root again, finds a directory there.
  let repointed = false;
  const found = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => data<{ results: unknown[]; skipped: Array<{ file: string; reason: string }> }>(m, 'grep', { pattern: 'needle', path: 'ref/notes' }));
  assert.ok(repointed);
  assert.deepEqual([found.results, found.skipped], [[], [{ file: 'ref/notes', reason: 'a directory' }]]);
});

test("a direct listing judges whether a path its include leaves out is a directory beneath the root its parse resolved, though the root moves after", async (t) => {
  const env = new Env(t);
  // The include covers `*.md` alone. At `a`, `dir` is a directory, which a
  // listing may name; at `b`, a file it leaves out.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'dir'), { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'dir'), 'b dir\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link, include: ['*.md'] });
  assert.match(await failure(await new Env(t).open({ path: b, include: ['*.md'] }), 'ls', { path: 'ref/dir' }), /is outside the mount's include/);
  let repointed = false;
  const listed = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => call(m, 'ls', { path: 'ref/dir' }));
  assert.ok(repointed);
  assert.doesNotMatch(listed.error ?? '', /is outside the mount's include/);
});

test("a direct mount whose root moves between a read's parse and its open names the mount a link on the way leads into, by the root it opens under", async (t) => {
  const env = new Env(t);
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'file.txt'), 'disk\n');
  symlinkSync('work', join(b, 'alias'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  // The parse resolves the root at `a`, which has no `alias`; the open finds
  // `b`, where `alias` is a link into `work`'s directory.
  let repointed = false;
  const err = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => m.readFileFromDisk('ref/alias/file.txt').then(() => null, (e: unknown) => e));
  assert.ok(repointed);
  assert.ok(err instanceof WorkspaceReadError, String(err));
  assert.match(err.message, /lies in mount "work", nested in mount "ref"/);
});

test("a direct mount whose root has moved resolves no other mount's root but those configured beneath its path", async (t) => {
  const env = new Env(t);
  // `ref` reaches `a` through `link`, and `x` is configured through a link
  // of its own, elsewhere.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  const c = join(env.root, 'c');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(join(c, 'x'), { recursive: true });
  writeFileSync(join(b, 'own.txt'), 'own\n');
  const link = join(env.root, 'link');
  const xlink = join(env.root, 'xlink');
  symlinkSync(a, link);
  symlinkSync(c, xlink);
  const m = await env.open({ path: link }, [{ name: 'x', path: join(xlink, 'x'), mode: 'read-only', backend: 'direct' }]);
  rmSync(link);
  symlinkSync(b, link);
  const resolved: string[] = [];
  await withFsPromise('realpath', (original) => async (...args: any[]) => {
    resolved.push(String(args[0]));
    return original(...args);
  }, async () => {
    assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/own.txt' })).content, '     1\town');
    await data(m, 'ls', { path: 'ref', recursive: true });
    await data(m, 'grep', { pattern: 'own', path: 'ref' });
    await m.readFileFromDisk('ref/own.txt');
  });
  assert.ok(resolved.some((path) => path === link), JSON.stringify(resolved));
  assert.deepEqual(resolved.filter((path) => path.startsWith(xlink) || path.startsWith(c)), []);
});

test("a direct mount whose root hasn't moved keeps the start's placement, of a mount configured beneath it whose directory has moved since too", async (t) => {
  const env = new Env(t);
  // `work` is configured at `ref/work`, a link to `x1` at the start.
  env.file('x1/f.txt', 'x1\n');
  env.file('x2/f.txt', 'x2\n');
  symlinkSync('x1', join(env.ref, 'work'));
  const m = await env.open({}, [{ name: 'work', path: join(env.ref, 'work'), mode: 'read-only', backend: 'direct' }]);
  assert.match(await failure(m, 'read', { path: 'ref/x1/f.txt' }), /lies in mount "work", nested in mount "ref"/);
  // Repointed to `x2`, `work`'s files are there now, and `ref`'s root is
  // where the start placed it, so `x1` stays `work`'s until the next start.
  rmSync(join(env.ref, 'work'));
  symlinkSync('x2', join(env.ref, 'work'));
  assert.match(await failure(m, 'read', { path: 'ref/x1/f.txt' }), /lies in mount "work", nested in mount "ref"/);
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/x2/f.txt' })).content, '     1\tx2');
});

/** Whether the temp directory folds case, as macOS's default disk does. */
const FOLDS_CASE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-direct-folds-'));
  try {
    writeFileSync(join(dir, 'Fold'), '');
    return existsSync(join(dir, 'FOLD'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

test("on a disk that folds case, a mount configured beneath a moved direct root, spelled otherwise than disk spells it, is nested as a start there nests it", {
  skip: FOLDS_CASE ? false : "the temp directory tells case apart, so a path spelled in another case reaches nothing: this runs on a disk that folds case, such as macOS's default",
}, async (t) => {
  const env = new Env(t);
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'file.txt'), 'new\n');
  writeFileSync(join(b, 'top.txt'), 'top\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  // Configured as `Work`, which disk spells `work`.
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'work', path: join(link, 'Work'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    asDisk: await call(m, 'read', { path: 'ref/work/file.txt' }),
    otherwise: await call(m, 'read', { path: 'ref/WORK/file.txt' }),
    listed: (await data<{ entries: unknown[] }>(m, 'ls', { path: 'ref', recursive: true })).entries,
    found: await data(m, 'grep', { pattern: 'new', path: 'ref' }),
  });
  const fromStart = await answers(started);
  assert.equal(fromStart.asDisk.success, false);
  assert.deepEqual(await answers(moved), fromStart);
});

test("on a disk that folds case, a path past the directory of a mount nested in a moved direct root keeps the caller's spelling there, as a start there keeps it", {
  skip: FOLDS_CASE ? false : "the temp directory tells case apart, so a path spelled in another case reaches nothing: this runs on a disk that folds case, such as macOS's default",
}, async (t) => {
  const env = new Env(t);
  // `sub` is configured at `b/sub`, which lies in `ref` once `ref` is moved to `b`.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'sub'), { recursive: true });
  writeFileSync(join(b, 'sub', 'file.txt'), 'sub\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [{ path: link }, [{ name: 'sub', path: join(b, 'sub'), mode: 'read-only', backend: 'direct' }]];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => await failure(m, 'read', { path: 'ref/SUB/File.TXT' });
  const fromStart = await answers(started);
  assert.match(fromStart, /"ref\/sub\/File\.TXT" lies in mount "sub", nested in mount "ref".*use "sub\/File\.TXT"/);
  assert.equal(await answers(moved), fromStart);
});

test("a direct mount whose root is gone, beneath a link, keeps the start's placement, as one beneath no link does", async (t) => {
  const env = new Env(t);
  // `ref` is configured beneath `link`, so its root as the start placed it
  // is `a/ref`, spelled otherwise than its configured path.
  const a = join(env.root, 'a');
  mkdirSync(join(a, 'ref', 'work'), { recursive: true });
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: join(link, 'ref') }, [{ name: 'work', path: join(a, 'ref', 'work'), mode: 'read-only', backend: 'direct' }]);
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);
  rmSync(join(a, 'ref'), { recursive: true, force: true });
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);
});

test("a direct mount whose root now leads through a file keeps the start's placement, as one that's gone does", async (t) => {
  const env = new Env(t);
  // The start, with `link` at `a`, nests `work` at `work`; then `link` leads
  // beneath a file, where nothing can be.
  const a = join(env.root, 'a');
  mkdirSync(join(a, 'work'), { recursive: true });
  writeFileSync(join(env.root, 'plain'), 'a file\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(a, 'work'), mode: 'read-only', backend: 'direct' }]);
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);
  rmSync(link);
  symlinkSync(join(env.root, 'plain', 'sub'), link);
  assert.match(await failure(m, 'read', { path: 'ref/work/file.txt' }), /lies in mount "work", nested in mount "ref"/);
});

test("a direct mount whose root moves between a read's parse and its open judges the file by the root it opens under", async (t) => {
  const env = new Env(t);
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(a, 'work', 'file.txt'), 'a\n');
  writeFileSync(join(b, 'work', 'file.txt'), 'disk\n');
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  // The parse resolves the root at `a`, where nothing is nested, and the
  // link is repointed to `b` as that answers, so the open finds `b`, where
  // `work` lies.
  let repointed = false;
  const err = await withFsPromise('realpath', (original) => async (...args: any[]) => {
    const real = await original(...args);
    if (!repointed && args[0] === link) {
      repointed = true;
      rmSync(link);
      symlinkSync(b, link);
    }
    return real;
  }, () => m.readFileFromDisk('ref/work/file.txt').then(() => null, (e: unknown) => e));
  assert.ok(repointed);
  assert.ok(err instanceof WorkspaceReadError, String(err));
  assert.deepEqual([err.code, err.stage], ['other_mount', 'realpath']);
});

test("a link inside a moved direct root that leads into a mount nested there is refused as that mount's, at a path only its draft has", async (t) => {
  const env = new Env(t);
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  symlinkSync('work', join(b, 'alias'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const m = await env.open({ path: link, followSymlinks: true }, [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }]);
  await data(m, 'write', { path: 'work/new.txt', content: 'draft\n' });
  rmSync(link);
  symlinkSync(b, link);
  assert.match(await failure(m, 'read', { path: 'ref/alias/new.txt' }), /"ref\/alias\/new\.txt" leads into mount "work", nested in mount "ref"/);
});

test("a mount nested in a moved direct root is judged by its own include there, as a start there judges it", async (t) => {
  const env = new Env(t);
  // In `b`, a link to a file `work`'s include leaves out, and one to a file
  // it covers.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(join(a, 'work'), { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(b, 'work', 'x.md'), 'needle x\n');
  writeFileSync(join(b, 'work', 'y.json'), 'needle y\n');
  symlinkSync(join('work', 'x.md'), join(b, 'l.md'));
  symlinkSync(join('work', 'y.json'), join(b, 'k.json'));
  const link = join(env.root, 'link');
  symlinkSync(a, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [
    { path: link, followSymlinks: true },
    [{ name: 'work', path: join(link, 'work'), mode: 'read-write', watch: 'never', include: ['*.json'] }],
  ];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(b, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => ({
    outside: await failure(m, 'read', { path: 'ref/l.md' }),
    covered: await failure(m, 'read', { path: 'ref/k.json' }),
    disk: await m.readFileFromDisk('ref/l.md').then(() => 'read', (err: unknown) => (err instanceof WorkspaceReadError ? err.code : String(err))),
    listed: (await data<{ entries: unknown[] }>(m, 'ls', { path: 'ref', recursive: true })).entries,
    found: await data(m, 'grep', { pattern: 'needle', path: 'ref' }),
  });
  const fromStart = await answers(started);
  // A place `work`'s include leaves out is no mount's, so the link leaves
  // `ref`; one it covers is `work`'s.
  assert.equal(fromStart.outside, 'Symlink escape detected: ref/l.md');
  assert.match(fromStart.covered, /"ref\/k\.json" leads into mount "work", nested in mount "ref"/);
  assert.equal(fromStart.disk, 'escape');
  assert.deepEqual(await answers(moved), fromStart);
});

test("a direct mount moved away from a mount nested in it judges a path its include leaves out by disk there, as a start there does", async (t) => {
  const env = new Env(t);
  // `ref` starts at `b`, where `work` lies nested at `b/work`; in `a`, `work`
  // is a file the include leaves out.
  const a = join(env.root, 'a');
  const b = join(env.root, 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(join(b, 'work'), { recursive: true });
  writeFileSync(join(a, 'work'), 'needle\n');
  writeFileSync(join(a, 'notes.md'), 'needle\n');
  const link = join(env.root, 'link');
  symlinkSync(b, link);
  const mounts: [Partial<MountConfig>, MountConfig[]] = [
    { path: link, include: ['*.md'] },
    [{ name: 'work', path: join(b, 'work'), mode: 'read-write', watch: 'never' }],
  ];
  const moved = await env.open(...mounts);
  rmSync(link);
  symlinkSync(a, link);
  const started = await new Env(t).open(...mounts);
  const answers = async (m: WorkspaceModule) => [
    await call(m, 'ls', { path: 'ref/work' }),
    await call(m, 'glob', { pattern: '*', path: 'ref/work' }),
    await call(m, 'grep', { pattern: 'needle', path: 'ref/work' }),
    await call(m, 'read', { path: 'ref/work' }),
    await call(m, 'sync', { path: 'ref/work' }),
    await call(m, 'materialize', { path: 'ref/work' }),
  ];
  const fromStart = await answers(started);
  // Nothing is nested in `ref` at `a`, so `work` is a file of `ref`'s that
  // its include leaves out, and no scope.
  for (const result of fromStart) assert.match(result.error ?? '', /^"ref\/work" is outside the mount's include/);
  assert.deepEqual(await answers(moved), fromStart);
});

test("ls without a path and status give a direct mount's kind and ignore list, and a 'chronicle' mount's as before", async (t) => {
  const env = new Env(t);
  const work = join(env.root, 'work');
  mkdirSync(work);
  const m = await env.open({}, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]);
  const ignore = ['node_modules', 'dist', '.git', 'build', 'coverage', 'target', '__pycache__', '.venv'];
  assert.deepEqual((await data(m, 'ls')).mounts, [
    { name: 'ref', path: env.ref, mode: 'read-only', backend: 'direct', ignore },
    { name: 'work', path: work, mode: 'read-write' },
  ]);
  const status = await data<Record<string, Record<string, unknown>>>(m, 'status');
  assert.deepEqual(status.ref, { path: env.ref, mode: 'read-only', backend: 'direct', ignore });
  assert.deepEqual(Object.keys(status.work!).sort(), [
    'canMaterialize', 'conflicts', 'currentBranch', 'currentSeq', 'fileCount', 'initialSyncDone', 'lastMaterializedBranch',
    'lastMaterializedSeq', 'mode', 'path', 'pendingChanges', 'pendingWorkspaceDeletions', 'watch',
  ]);
  const named = await env.open({ ignore: ['vendor'] });
  assert.deepEqual((await data<Record<string, Record<string, unknown>>>(named, 'status')).ref!.ignore, ['vendor']);
});

test('a direct mount refuses every tool that writes, edit_many and materialize included, as read-only', async (t) => {
  const env = new Env(t);
  env.file('a.ts', 'alpha\n');
  const m = await env.open();
  const states = env.stateIds();
  const calls: Array<[string, Record<string, unknown>]> = [
    ['write', { path: 'ref/a.ts', content: 'beta\n' }],
    ['edit', { path: 'ref/a.ts', oldString: 'alpha', newString: 'beta' }],
    ['edit_many', { edits: [{ path: 'ref/a.ts', oldString: 'alpha', newString: 'beta' }] }],
    ['delete', { path: 'ref/a.ts' }],
  ];
  for (const [name, input] of calls) assert.match(await failure(m, name, input), /Mount "ref" is read-only/, name);
  // materialize names a read-only mount among what it skipped, as on any.
  const materialized = await data<{ count: number; skipped: unknown[] }>(m, 'materialize', { mount: 'ref' });
  assert.deepEqual([materialized.count, materialized.skipped], [0, [{ mount: 'ref', reason: 'a read-only mount: materialize writes nothing to it' }]]);
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/a.ts' })).content, '     1\talpha');
  assert.deepEqual(env.stateIds(), states, 'no state was made');
});

test('sync passes over a direct mount, and says so rather than that nothing changed', async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  const m = await env.open();
  const reason = "a direct mount: its tools read disk as it is, so there's nothing to take in";
  assert.deepEqual(await data(m, 'sync'), { results: [], totalSynced: 0, totalConflicts: 0, skipped: [{ mount: 'ref', path: '', reason }] });
  assert.deepEqual((await data(m, 'sync', { mount: 'ref', acceptRoot: true })).skipped, [{ mount: 'ref', path: '', reason }]);
  assert.deepEqual((await data(m, 'sync', { path: 'ref/src' })).skipped, [{ mount: 'ref', path: 'src', reason }]);
  assert.deepEqual((await data(m, 'materialize', { mount: 'ref' })).skipped, [{ mount: 'ref', reason: 'a read-only mount: materialize writes nothing to it' }]);
});

test("readBinary reads a direct mount's disk, a binary file included, up to the mount's size limit", async (t) => {
  const env = new Env(t);
  env.file('bin.dat', Buffer.from([1, 0, 2]));
  env.file('big.dat', Buffer.alloc(9));
  const m = await env.open({ maxFileSize: 8 });
  assert.deepEqual(await m.readBinary('ref/bin.dat'), { data: Buffer.from([1, 0, 2]) });
  assert.deepEqual(await m.readBinary('ref/big.dat'), { error: 'File too large: 9 > 8 bytes' });
  assert.deepEqual(await m.readBinary('ref/none.dat'), { error: 'File not found on disk: ref/none.dat' });
});

test('a direct mount reads beneath whatever directory is at its root now', async (t) => {
  const env = new Env(t);
  env.file('a.txt', 'old\n');
  // A 'chronicle' run records the root it agreed with.
  const chronicle = await env.openChronicle();
  assert.equal((await data<{ content: string }>(chronicle, 'read', { path: 'ref/a.txt' })).content, '     1\told');
  await env.close(chronicle);
  // The checkout is cloned again: another directory at the same path.
  renameSync(env.ref, join(env.root, 'ref-before'));
  env.file('a.txt', 'new\n');
  env.file('sub/x.txt', 'x\n');
  // A cap of one entry, so a search's start that the old root's identity
  // stopped short would leave its directory unvisited.
  const direct = await env.open({ walkCap: 1 });
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/a.txt' })).content, '     1\tnew');
  assert.deepEqual((await data<{ matches: unknown[] }>(direct, 'glob', { pattern: '*.txt' })).matches, [{ path: 'ref/a.txt', size: 4 }]);
  assert.deepEqual((await data<{ matches: unknown[] }>(direct, 'glob', { pattern: 'sub/*.txt' })).matches, [{ path: 'ref/sub/x.txt', size: 2 }]);
  await env.close(direct);
  // A 'chronicle' run checks the root against the one it agreed with.
  const again = await env.openChronicle();
  assert.match(JSON.stringify((await data(again, 'ls', { path: 'ref' })).incomplete), /not the directory disk last agreed with/);
});

test('a direct mount whose config sets what would never act there is refused, naming the mount and each setting', () => {
  const base: MountConfig = { name: 'ref', path: '/tmp/af-ws-direct-none', mode: 'read-only', backend: 'direct' };
  const refused = (mount: Partial<MountConfig>): string => {
    try {
      new WorkspaceModule({ mounts: [{ ...base, ...mount }] });
    } catch (err) {
      return (err as Error).message;
    }
    assert.fail(`accepted ${JSON.stringify(mount)}`);
  };
  const lead = '[workspace] Mount "ref" is direct, which reads disk as it is with no store, watcher or push: ';
  assert.equal(refused({ watch: 'always' }), `${lead}watch "always" would watch nothing (leave it out, or set 'never')`);
  assert.equal(refused({ watch: 'on-agent-action' }), `${lead}watch "on-agent-action" would watch nothing (leave it out, or set 'never')`);
  assert.equal(refused({ watchDebounceMs: 100 }), `${lead}watchDebounceMs would tune no watcher (leave it out)`);
  assert.equal(refused({ watchRootPollMs: 100 }), `${lead}watchRootPollMs would tune no watcher (leave it out)`);
  assert.equal(refused({ wakeOnChange: true }), `${lead}wakeOnChange would never wake (leave it out)`);
  assert.equal(refused({ wakeOnChange: ['created'] }), `${lead}wakeOnChange would never wake (leave it out)`);
  assert.equal(refused({ autoMaterialize: true }), `${lead}autoMaterialize would never push (leave it out)`);
  assert.equal(
    refused({ mode: 'read-write', watch: 'always', autoMaterialize: true }),
    `${lead}watch "always" would watch nothing (leave it out, or set 'never'); autoMaterialize would never push (leave it out)`,
  );
  // Either mode is a direct mount's own, and one that names none writes, as any mount does.
  for (const accepted of [{}, { mode: 'read-write' as const }, { mode: undefined }, { watch: 'never' as const }, { wakeOnChange: false }, { wakeOnChange: [] }, { autoMaterialize: false }]) {
    new WorkspaceModule({ mounts: [{ ...base, ...accepted } as MountConfig] });
  }
  assert.throws(
    () => new WorkspaceModule({ mounts: [{ ...base, backend: 'disk' as MountConfig['backend'] }] }),
    { message: `[workspace] Mount "ref": backend must be 'chronicle' or 'direct', not "disk"` },
  );
});

test('tool descriptions mention the direct kind only on a host with a direct mount', async (t) => {
  const env = new Env(t);
  const descriptions = (m: WorkspaceModule) => Object.fromEntries(m.getTools().map((tool) => [tool.name, tool.description]));
  const chronicle = descriptions(await env.openChronicle());
  for (const [name, description] of Object.entries(chronicle)) assert.doesNotMatch(description, /\bdirect\b/, name);
  // A host with a writable 'chronicle' mount beside a direct one, as one
  // coding in a checkout with its neighbours mounted to read.
  const work = join(env.root, 'work');
  mkdirSync(work);
  for (const direct of [descriptions(await env.open()), descriptions(await env.open({}, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]))]) {
    for (const name of Object.keys(chronicle)) {
      if (name === 'ls' || name === 'glob' || name === 'grep' || name === 'sync') {
        assert.ok(direct[name]!.startsWith(chronicle[name]!) && direct[name]!.length > chronicle[name]!.length, name);
        assert.match(direct[name]!, /direct mount/, name);
      } else {
        assert.equal(direct[name], chronicle[name], name);
      }
    }
  }
});

test("a mount the store holds changes on that disk lacks runs as 'chronicle', says so, and starts direct once they're given up", async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  env.file('deleted.ts', 'kept on disk\n');
  env.file('both.ts', 'v1\n');
  env.file('dot.img', GIF);
  const chronicle = await env.openChronicle();
  await data(chronicle, 'ls', { path: 'ref' });
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await data(chronicle, 'delete', { path: 'ref/deleted.ts' });
  await data(chronicle, 'write', { path: 'ref/both.ts', content: 'v2\n' });
  assert.equal((await chronicle.writeBinary('ref/dot.img', PNG, 'image/png')).success, true);
  env.file('both.ts', 'v3\n');
  assert.equal((await data<{ entries: Array<{ name: string; state: string }> }>(chronicle, 'ls', { path: 'ref' })).entries.find((e) => e.name === 'both.ts')!.state, 'conflict');
  await env.close(chronicle);

  const warned = t.mock.method(console, 'warn', () => {});
  const held = await env.open({ walkCap: 1 });
  warned.mock.restore();
  const message = "A mount configured direct runs as 'chronicle' this session. To start it direct, settle each held change, then "
    + "start it again: sync its path to take disk's copy, or materialize it by name, a read-only one configured read-write "
    + "first, and follow the answer. Meanwhile it takes no writes. "
    + 'Mount "ref" holds 4 changes that disk lacks: "ref/both.ts" (in conflict), "ref/deleted.ts" (deleted in the workspace), '
    + '"ref/dot.img" (in conflict), "ref/drafted.ts" (changed in the workspace).';
  assert.deepEqual(env.alerts, [{ kind: 'workspace-mount-not-direct', agent: 'framework', message, data: { held: { ref: 4 } } }]);
  assert.deepEqual(warned.mock.calls.map((c) => c.arguments), [[`[workspace] ${message}`]]);
  // As a 'chronicle' mount, unwatched, with no catch-up scan to take turns
  // with its syncs, its changes in view, and saying what it runs as and the
  // ignore list it walks by.
  const ignore = ['node_modules', 'dist', '.git', 'build', 'coverage', 'target', '__pycache__', '.venv'];
  assert.deepEqual((await data(held, 'ls')).mounts, [{ name: 'ref', path: env.ref, mode: 'read-only', backend: 'chronicle', ignore }]);
  const status = await data<Record<string, Record<string, unknown>>>(held, 'status');
  assert.equal(status.ref!.backend, 'chronicle');
  assert.deepEqual(status.ref!.ignore, ignore);
  assert.equal(status.ref!.watch, 'never');
  assert.deepEqual(watched(held), []);
  assert.equal(status.ref!.pendingChanges, 4);
  const capped = (await data<{ incomplete: Array<{ path: string; reason: string }> }>(held, 'sync')).incomplete.map((region) => region.reason);
  assert.ok(capped.some((reason) => /^the walk cap \(1\) was reached: the next sync of the mount resumes after ref\//.test(reason)), JSON.stringify(capped));
  assert.ok(held.getTools().every((tool) => !/\bdirect\b/.test(tool.description)));
  await env.close(held);

  // Every tool reads the workspace's copy there, the draft and the image.
  env.alerts = [];
  const again = await env.open();
  assert.equal(env.alerts.length, 1, 'each start that finds them says so');
  assert.equal((await data<{ content: string }>(again, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
  assert.equal((await data<{ entries: Array<{ name: string; state?: string }> }>(again, 'ls', { path: 'ref' })).entries.find((e) => e.name === 'drafted.ts')?.state, 'workspace-draft');
  assert.deepEqual((await data<{ matches: Array<{ path: string; state?: string }> }>(again, 'glob', { pattern: 'drafted.ts' })).matches.map((x) => [x.path, x.state]), [['ref/drafted.ts', 'workspace-draft']]);
  assert.deepEqual((await data<{ results: Array<{ file: string; version: string }> }>(again, 'grep', { pattern: 'draft' })).results.map((r) => [r.file, r.version]), [['ref/drafted.ts', 'workspace']]);
  assert.equal((await data<Array<{ mimeType?: string }>>(again, 'read_image', { path: 'ref/dot.img' }))[1]!.mimeType, 'image/png');
  assert.deepEqual(await again.readBinary('ref/dot.img'), { data: PNG });

  for (const path of ['ref/drafted.ts', 'ref/deleted.ts', 'ref/both.ts', 'ref/dot.img']) await data(again, 'sync', { path });
  await env.close(again);
  env.alerts = [];
  const direct = await env.open();
  assert.deepEqual(env.alerts, []);
  assert.equal((await data<Record<string, Record<string, unknown>>>(direct, 'status')).ref!.backend, 'direct');
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdisk');
});

test("the changes that keep a mount from starting direct are named ten at a time, an intent that can't be read among them", async (t) => {
  const env = new Env(t);
  env.file('d00.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'ls', { path: 'ref' });
  for (let i = 0; i < 11; i++) await data(chronicle, 'write', { path: `ref/d${String(i).padStart(2, '0')}.ts`, content: `${i}\n` });
  await env.close(chronicle);
  // Recorded intents whose blob the store doesn't hold: one alone, and one at
  // a changed file, which is named for the intent.
  for (const path of ['aa.ts', 'd00.ts']) env.store.treeSet('workspace/ref/intent', path, { blobHash: 'f'.repeat(64), size: 2, mode: 0 });

  await env.open();
  assert.equal(env.alerts.length, 1);
  const unreadable = (path: string) => `"ref/${path}" (its workspace intent can't be read; a sync of the path settles it or says why not)`;
  const shown = [unreadable('aa.ts'), unreadable('d00.ts'), ...Array.from({ length: 8 }, (_, i) => `"ref/d0${i + 1}.ts" (changed in the workspace)`)];
  // An intent it can't read is counted as one, not as a change.
  assert.ok(env.alerts[0]!.message.endsWith(`Mount "ref" holds 10 changes that disk lacks and 2 intents it can't read: ${shown.join(', ')}, and 2 more.`), env.alerts[0]!.message);
  assert.deepEqual(env.alerts[0]!.data, { held: { ref: 12 } });
});

test("the ways out say to sync the path of an intent it can't read, where one is held past the ten paths named too", async (t) => {
  const env = new Env(t);
  const chronicle = await env.openChronicle();
  for (let i = 0; i < 11; i++) await data(chronicle, 'write', { path: `ref/d${String(i).padStart(2, '0')}.ts`, content: `${i}\n` });
  await env.close(chronicle);
  const sentence = "Meanwhile it takes no writes. Sync the path of an intent it can't read. Mount \"ref\" holds";

  await env.close(await env.open());
  assert.ok(!env.alerts[0]!.message.includes('Sync the path'), env.alerts[0]!.message);
  // One that sorts after every change, so it isn't among the ten named.
  env.store.treeSet('workspace/ref/intent', 'zz.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
  env.alerts = [];
  await env.open();
  assert.ok(!env.alerts[0]!.message.includes('"ref/zz.ts"'), env.alerts[0]!.message);
  assert.ok(env.alerts[0]!.message.includes(sentence), env.alerts[0]!.message);
});

test("an intent it can't read where the workspace holds no copy is left by materialize and settled by a sync of its path, as the alert says", async (t) => {
  const env = new Env(t);
  env.file('u.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  env.store.treeSet('workspace/ref/intent', 'u.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
  await env.close(chronicle);
  await env.close(await env.open());
  assert.match(env.alerts[0]!.message, /Sync the path of an intent it can't read\./);

  // The alert's materialize route, forced too, neither settles it nor names it.
  const again = await env.openChronicle();
  for (const input of [{ mount: 'ref' }, { mount: 'ref', force: true }]) {
    assert.deepEqual(await data(again, 'materialize', input), { materialized: [], count: 0 });
  }
  assert.notEqual(env.store.treeGet('workspace/ref/intent', 'u.ts'), null);
  // A sync of its path settles it, and the next start runs direct.
  assert.deepEqual((await data<{ totalSynced: number }>(again, 'sync', { path: 'ref/u.ts' })).totalSynced, 1);
  assert.equal(env.store.treeGet('workspace/ref/intent', 'u.ts'), null);
  await env.close(again);
  env.alerts = [];
  const direct = await env.open();
  assert.deepEqual([env.alerts.length, (await data<Record<string, Record<string, unknown>>>(direct, 'status')).ref!.backend], [0, 'direct']);
});

test('each kind of change the store holds keeps a mount configured direct from starting direct on its own, until a sync of its path settles it', async (t) => {
  const cases: Array<[string, (env: Env) => Promise<void>, string, string]> = [
    ['a workspace deletion', async (env) => {
      env.file('gone.ts', 'kept on disk\n');
      const chronicle = await env.openChronicle();
      await data(chronicle, 'ls', { path: 'ref' });
      await data(chronicle, 'delete', { path: 'ref/gone.ts' });
      await env.close(chronicle);
    }, '1 change that disk lacks', '"ref/gone.ts" (deleted in the workspace)'],
    ['a conflict', async (env) => {
      await env.close(await env.openChronicle());
      new BranchIntents(env.store, 'workspace/ref/intent').put('c.ts', { conflict: { kind: 'both-changed', at: 0, disk: null } });
    }, '1 change that disk lacks', '"ref/c.ts" (in conflict)'],
    ["an intent that can't be read", async (env) => {
      await env.close(await env.openChronicle());
      env.store.treeSet('workspace/ref/intent', 'u.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
    }, "1 intent it can't read", `"ref/u.ts" (its workspace intent can't be read; a sync of the path settles it or says why not)`],
  ];
  for (const [kind, hold, counted, named] of cases) {
    const env = new Env(t);
    await hold(env);
    const m = await env.open();
    assert.equal(env.alerts.length, 1, kind);
    assert.ok(env.alerts[0]!.message.endsWith(`Mount "ref" holds ${counted}: ${named}.`), env.alerts[0]!.message);
    assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'chronicle', kind);

    // The alert's way out: a sync of the path, then the next start is direct.
    await data(m, 'sync', { path: named.slice(1, named.indexOf('"', 1)) });
    await env.close(m);
    env.alerts = [];
    const again = await env.open();
    assert.deepEqual(env.alerts, [], kind);
    assert.equal((await data<Record<string, Record<string, unknown>>>(again, 'status')).ref!.backend, 'direct', kind);
  }
});

test("a tombstone beside an entry that's still there keeps no mount configured direct from starting direct, and holds it once the entry is gone", async (t) => {
  const env = new Env(t);
  env.file('k.ts', 'kept\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'ls', { path: 'ref' });
  await env.close(chronicle);
  // A deletion whose removal failed after its tombstone was written, and
  // whose put-back failed too, leaves its tombstone beside the entry
  // (commitToolChanges); it's given here directly. Disk agreed with the
  // entry, which is still there, so the store holds no change disk lacks.
  const entry = env.store.treeGet('workspace/ref/tree', 'k.ts');
  assert.ok(entry);
  const intents = new BranchIntents(env.store, 'workspace/ref/intent');
  intents.put('k.ts', { tombstone: { hash: entry.blobHash } });
  const m = await env.open();
  assert.deepEqual(env.alerts, []);
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'direct');
  assert.deepEqual(intents.get('k.ts'), { tombstone: { hash: entry.blobHash } }, 'a direct start leaves the store as it was');

  // With the entry gone, the same tombstone is a workspace deletion disk
  // lacks, and the mount runs as 'chronicle'.
  await env.close(m);
  env.store.treeRemove('workspace/ref/tree', 'k.ts');
  env.alerts = [];
  const held = await env.open();
  assert.equal(env.alerts.length, 1);
  assert.ok(env.alerts[0]!.message.endsWith('Mount "ref" holds 1 change that disk lacks: "ref/k.ts" (deleted in the workspace).'), env.alerts[0]!.message);
  assert.equal((await data<Record<string, Record<string, unknown>>>(held, 'status')).ref!.backend, 'chronicle');
});

test('mounts configured direct that the store holds changes on are named in one alert', async (t) => {
  const env = new Env(t);
  const other = join(env.root, 'other');
  mkdirSync(other);
  const chronicle = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' }, [{ name: 'other', path: other, mode: 'read-write', watch: 'never' }]);
  await data(chronicle, 'write', { path: 'ref/a.ts', content: 'a\n' });
  await data(chronicle, 'write', { path: 'other/b.ts', content: 'b\n' });
  await data(chronicle, 'write', { path: 'other/c.ts', content: 'c\n' });
  await env.close(chronicle);

  const both = await env.open({}, [{ name: 'other', path: other, mode: 'read-only', backend: 'direct' }]);
  assert.equal(env.alerts.length, 1);
  assert.equal(env.alerts[0]!.message, "Mounts configured direct run as 'chronicle' this session. To start a mount direct, settle each change "
    + "held at it, then start it again: sync its path to take disk's copy, or materialize it by name, a read-only one "
    + "configured read-write first, and follow the answer. Meanwhile it takes no writes. "
    + 'Mounts "ref" (1 change that disk lacks) and "other" (2 changes that disk lacks) hold: "ref/a.ts" (changed in the workspace), '
    + '"other/b.ts" (changed in the workspace), "other/c.ts" (changed in the workspace).');
  assert.deepEqual(env.alerts[0]!.data, { held: { ref: 1, other: 2 } });
  await env.close(both);

  // An intent it can't read, in either mount, is counted as one.
  env.store.treeSet('workspace/other/intent', 'u.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
  env.alerts = [];
  await env.open({}, [{ name: 'other', path: other, mode: 'read-only', backend: 'direct' }]);
  assert.ok(env.alerts[0]!.message.includes("Mounts \"ref\" (1 change that disk lacks) and \"other\" (2 changes that disk lacks and 1 intent it can't read) hold: "), env.alerts[0]!.message);
});

test("the alert's ways out come within the start a webhook keeps of it, however many mounts it names and however long their names", async (t) => {
  const env = new Env(t);
  const extra = ['another-checkout-whose-name-is-rather-long', 'a-third-checkout-with-a-long-name-too'].map((name) => {
    mkdirSync(join(env.root, name));
    return { name, path: join(env.root, name) };
  });
  const chronicle = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' }, extra.map((m) => ({ ...m, mode: 'read-write' as const, watch: 'never' as const })));
  for (const name of ['ref', ...extra.map((m) => m.name)]) await data(chronicle, 'write', { path: `${name}/draft.ts`, content: 'draft\n' });
  await env.close(chronicle);
  // An intent it can't read too, whose sentence is the last of the ways out.
  env.store.treeSet('workspace/ref/intent', 'u.ts', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });

  await env.open({}, extra.map((m) => ({ ...m, mode: 'read-only' as const, backend: 'direct' as const })));
  const message = env.alerts[0]!.message;
  // The framework's webhook keeps the first 346 characters of an alert over
  // 500, with its end (framework.ts, OPS_WEBHOOK_MESSAGE_MAX_CHARS and
  // boundFailureText).
  assert.ok(message.length > 500, `${message.length}`);
  const last = "Sync the path of an intent it can't read.";
  const at = message.indexOf(last);
  assert.ok(at >= 0 && at + last.length <= 340, `${at}`);
});

test('a start of the same module decides again whether a mount configured direct runs direct', async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);

  const m = await env.open();
  assert.equal(env.alerts.length, 1);
  await env.restart(m);
  assert.equal(env.alerts.length, 2, 'a start that finds the change still held says so again');
  await data(m, 'sync', { path: 'ref/drafted.ts' });
  await env.restart(m);
  assert.equal(env.alerts.length, 2, 'the start that finds none says nothing');
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'direct');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdisk');
});

test('whichever of start and initStore comes first, a mount configured direct is decided once the store is given, and said once', async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);
  const config = { mounts: [{ name: 'ref', path: env.ref, mode: 'read-only' as const, backend: 'direct' as const }] };
  const status = async (m: WorkspaceModule) => (await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend;

  // The host's order: start, then initStore.
  const host = new WorkspaceModule(config);
  try {
    await host.start(env.context());
    assert.deepEqual(env.alerts, []);
    host.initStore(env.store);
    assert.equal(env.alerts.length, 1);
    assert.equal(await status(host), 'chronicle');
    assert.equal((await data<{ content: string }>(host, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
  } finally {
    await host.stop();
  }

  // The store first: decided before start, so a read between the two reads
  // the change, and start says so once.
  env.alerts = [];
  const early = new WorkspaceModule(config);
  try {
    early.initStore(env.store);
    assert.equal(await status(early), 'chronicle');
    assert.equal((await data<{ content: string }>(early, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
    await early.start(env.context());
    assert.equal(env.alerts.length, 1);
    await data(early, 'sync', { path: 'ref/drafted.ts' });
  } finally {
    await early.stop();
  }

  // With nothing held, a mount that ran as 'chronicle' is direct from
  // initStore on.
  const settled = new WorkspaceModule(config);
  try {
    settled.initStore(env.store);
    assert.equal(await status(settled), 'direct');
  } finally {
    await settled.stop();
  }
});

test("a decision that can't read the store leaves a mount that ran as 'chronicle' as it was, never direct", async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);
  type Deciding = { heldChanges: () => never };
  const unreadable = () => { throw new Error('the evidence could not be read'); };

  // At a later start, the earlier decision stands, and the start fails.
  const m = await env.open();
  const atStart = t.mock.method(m as unknown as Deciding, 'heldChanges', unreadable);
  await assert.rejects(env.restart(m), /the evidence could not be read/);
  atStart.mock.restore();
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'chronicle');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');

  // At initStore, before any decision has been made, it isn't direct.
  const fresh = new WorkspaceModule({ mounts: [{ name: 'ref', path: env.ref, mode: 'read-only', backend: 'direct' }] });
  const atInit = t.mock.method(fresh as unknown as Deciding, 'heldChanges', unreadable);
  assert.throws(() => fresh.initStore(env.store), /the evidence could not be read/);
  atInit.mock.restore();
  assert.equal((await data<{ content: string }>(fresh, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
});

test('a decision that fails at a later mount sets none of the mounts it decided before it', async (t) => {
  const env = new Env(t);
  const other = join(env.root, 'other');
  mkdirSync(other);
  env.file('drafted.ts', 'disk\n');
  const chronicle = await env.open({ backend: 'chronicle', mode: 'read-write', watch: 'never' }, [{ name: 'other', path: other, mode: 'read-write', watch: 'never' }]);
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await data(chronicle, 'ls', { path: 'other' });
  await env.close(chronicle);

  const m = await env.open({}, [{ name: 'other', path: other, mode: 'read-only', backend: 'direct' }]);
  const status = async () => {
    const all = await data<Record<string, Record<string, unknown>>>(m, 'status');
    return [all.ref!.backend, all.other!.backend];
  };
  assert.deepEqual(await status(), ['chronicle', 'direct']);
  // "ref" is settled, so a decision would start it direct, but reading
  // "other", decided after it, fails.
  await data(m, 'sync', { path: 'ref/drafted.ts' });
  type Deciding = { heldChanges: (state: { config: { name: string } }) => unknown };
  const original = (m as unknown as Deciding).heldChanges;
  const failing = t.mock.method(m as unknown as Deciding, 'heldChanges', function (this: unknown, state: { config: { name: string } }) {
    if (state.config.name === 'other') throw new Error('the evidence could not be read');
    return original.call(this, state);
  });
  await assert.rejects(env.restart(m), /the evidence could not be read/);
  failing.mock.restore();
  assert.deepEqual(await status(), ['chronicle', 'direct']);
  await env.restart(m);
  assert.deepEqual(await status(), ['direct', 'direct']);
});

test('changes held on a branch not selected at the start keep no mount from starting direct', async (t) => {
  const env = new Env(t);
  env.file('drafted.ts', 'disk\n');
  const main = env.store.currentBranch().name;
  env.store.createBranch('side', main);
  env.store.switchBranch('side');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);

  env.store.switchBranch(main);
  const m = await env.open();
  assert.deepEqual(env.alerts, [], 'the branch selected holds none');
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'direct');
  // The same module, started again on the branch that holds it, runs
  // store-backed and says so.
  await m.stop();
  env.store.switchBranch('side');
  await m.start(env.context());
  assert.equal(env.alerts.length, 1, 'the branch that holds it keeps the mount store-backed');
  assert.equal((await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!.backend, 'chronicle');
  assert.equal((await data<{ content: string }>(m, 'read', { path: 'ref/drafted.ts' })).content, '     1\tdraft');
});

test("a mount configured direct with no ignore list walks by the direct kind's default while it runs as 'chronicle'", async (t) => {
  const env = new Env(t);
  env.file('src/a.ts', 'a\n');
  env.file('node_modules/p/i.js', 'i\n');
  env.file('.git/HEAD', 'ref: refs/heads/main\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);

  const held = await env.open();
  assert.equal(env.alerts.length, 1, "it runs as 'chronicle'");
  const listed = (await data<{ entries: Array<{ path: string }> }>(held, 'ls', { path: 'ref', recursive: true })).entries.map((e) => e.path);
  assert.deepEqual(listed.filter((path) => !['drafted.ts', 'src/a.ts'].includes(path)), []);
  assert.deepEqual(env.store.treeList('workspace/ref/tree').map((e) => e.path).sort(), ['drafted.ts', 'src/a.ts']);
});

test("a mount configured direct that runs as 'chronicle' is still direct to getMounts, and its agents' saved positions still give the notice", async (t) => {
  const env = new Env(t);
  // A direct session's scout position, saved at its stop, on a branch gone since.
  const direct = await env.open({ mode: 'read-write' });
  (direct as unknown as { directHeads: Map<string, Map<string, unknown>> }).directHeads.set('ref', new Map([['scout', { branchId: 'zz-a-branch-gone-since', after: 1, notice: null }]]));
  await env.close(direct);
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);
  // Naming no mode, so it's writable.
  const m = await env.open({ mode: undefined });
  assert.equal(env.alerts.length, 1, "it runs as 'chronicle'");
  // Its directory is a checkout either way, so the framework's files pass over it.
  assert.equal(m.getMounts()[0]?.backend, 'direct');
  // And status gives its mode as writable, as when it runs direct.
  const status = (await data<Record<string, Record<string, unknown>>>(m, 'status')).ref!;
  assert.deepEqual([status.mode, status.backend], ['read-write', 'chronicle']);
  // And the writes the scout made while it ran direct are on disk.
  assert.deepEqual(m.headMoveNotice('scout')?.mounts, ['ref']);
  await env.close(m);
  // A mode it names is given as named, and a store-backed mount naming none shows none, as on main.
  const named = await env.open({ mode: 'read-only' });
  const namedStatus = (await data<Record<string, Record<string, unknown>>>(named, 'status')).ref!;
  assert.deepEqual([namedStatus.mode, namedStatus.backend], ['read-only', 'chronicle']);
  await env.close(named);
  const plain = await env.open({ backend: 'chronicle', mode: undefined, watch: 'never' });
  assert.equal((await data<Record<string, Record<string, unknown>>>(plain, 'status')).ref!.mode, undefined);
});

test("a writable mount configured direct that runs as 'chronicle' takes no writes, edits or deletions until what's held is settled, and a materialize naming it settles it", async (t) => {
  const env = new Env(t);
  env.file('kept.ts', 'disk\n');
  const chronicle = await env.openChronicle();
  await data(chronicle, 'write', { path: 'ref/drafted.ts', content: 'draft\n' });
  await env.close(chronicle);
  const m = await env.open({ mode: undefined });
  assert.equal(env.alerts.length, 1, "it runs as 'chronicle'");
  const why = 'Mount "ref" is configured direct, and runs as \'chronicle\' this session because its start found the store holding changes there that disk lacks, '
    + 'so it takes no writes this session, and calling again is refused the same way. To run it direct again, settle what\'s held '
    + '(sync each held path to take disk\'s copy, or materialize mount "ref" by name to write the store\'s copies to disk), and the host\'s next start runs it direct';
  // And getMounts gives it as read-only this session, so a caller choosing where to save passes over it.
  assert.deepEqual(m.getMounts().map(({ name, mode, backend }) => ({ name, mode, backend })), [{ name: 'ref', mode: 'read-only', backend: 'direct' }]);
  const pending = async () => (await data<Record<string, { pendingChanges: number }>>(m, 'status')).ref!.pendingChanges;
  assert.equal(await pending(), 1);
  assert.equal(await failure(m, 'write', { path: 'ref/new.ts', content: 'x\n' }), why);
  assert.match(await failure(m, 'edit', { path: 'ref/kept.ts', oldString: 'disk', newString: 'edited' }), new RegExp(`${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(await failure(m, 'edit_many', { edits: [{ path: 'ref/kept.ts', oldString: 'disk', newString: 'edited' }] }), new RegExp(`${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(await failure(m, 'delete', { path: 'ref/kept.ts' }), why);
  assert.deepEqual(await m.writeBinary('ref/dot.img', Buffer.from('img'), 'image/png'), { success: false, isError: true, error: why });
  // Nothing reached disk or the store, so what's held is as it was.
  assert.equal(readFileSync(join(env.ref, 'kept.ts'), 'utf8'), 'disk\n');
  assert.equal(existsSync(join(env.ref, 'new.ts')), false);
  assert.equal(await pending(), 1);
  // A materialize naming it writes the store's copy to disk, and the next start runs it direct.
  await data(m, 'materialize', { mount: 'ref' });
  assert.equal(readFileSync(join(env.ref, 'drafted.ts'), 'utf8'), 'draft\n');
  await env.close(m);
  const direct = await env.open({ mode: undefined });
  assert.equal(env.alerts.length, 1, 'no new alert: it runs direct');
  await data(direct, 'write', { path: 'ref/new.ts', content: 'x\n' });
  assert.equal(readFileSync(join(env.ref, 'new.ts'), 'utf8'), 'x\n');
});

test("a mount that ran direct takes in what disk changed meanwhile when it runs as 'chronicle' again", async (t) => {
  const env = new Env(t);
  env.file('changed.ts', 'before\n');
  env.file('removed.ts', 'gone soon\n');
  const first = await env.openChronicle();
  assert.equal((await data<{ count: number }>(first, 'ls', { path: 'ref', recursive: true })).count, 2);
  await env.close(first);

  const direct = await env.open();
  env.file('changed.ts', 'after\n');
  unlinkSync(join(env.ref, 'removed.ts'));
  env.file('added.ts', 'new\n');
  assert.equal((await data<{ content: string }>(direct, 'read', { path: 'ref/changed.ts' })).content, '     1\tafter');
  await env.close(direct);

  const again = await env.openChronicle();
  assert.deepEqual((await data(again, 'ls', { path: 'ref', recursive: true })).entries, [
    { path: 'added.ts', state: 'synced', size: 4 },
    { path: 'changed.ts', state: 'synced', size: 6 },
  ]);
  assert.equal((await data<{ content: string }>(again, 'read', { path: 'ref/changed.ts' })).content, '     1\tafter');
  const status = (await data<Record<string, Record<string, unknown>>>(again, 'status')).ref!;
  assert.deepEqual([status.pendingChanges, status.conflicts], [0, 0]);
});

test("a direct mount's listings pass over another mount's directory, naming the mount to use", async (t) => {
  const env = new Env(t);
  env.file('inner/x.ts', 'x\n');
  env.file('top.ts', 't\n');
  const m = await env.open({}, [{ name: 'inner', path: join(env.ref, 'inner'), mode: 'read-only', watch: 'never' }]);
  assert.deepEqual((await data(m, 'ls', { path: 'ref' })).entries, [{ name: 'top.ts', type: 'file', size: 2 }]);
  assert.deepEqual(await data(m, 'ls', { path: 'ref/inner' }), {
    path: 'ref/inner',
    entries: [],
    count: 0,
    incomplete: [{ path: 'inner', reason: 'it lies in mount "inner", nested in this one: use "inner"' }],
  });
  assert.match(await failure(m, 'read', { path: 'ref/inner/x.ts' }), /lies in mount "inner", nested in mount "ref"/);
});

test("a direct mount's read shows a file's text as a 'chronicle' mount's does: lines without a CRLF end's CR, no BOM, a long line cut, and each page held to the call's result limit, with the notes that say so", async (t) => {
  const env = new Env(t);
  env.file('crlf.txt', 'one\r\ntwo\r\n');
  env.file('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\n')]));
  env.file('bad.txt', Buffer.from([0x61, 0xff, 0x62, 0x0a]));
  env.file('mixed.txt', 'a\r\nb\nc\r\r\nd\n');
  env.file('long.txt', `${'x'.repeat(60000)}\ny\n`);
  env.file('big.txt', Array.from({ length: 3000 }, (_, i) => `line ${i + 1} of a file with fairly ordinary lines`).join('\n'));
  // Each file read as a page of lines and as a page of characters, at a
  // model's limit, at a small one, and with none, as an in-process call makes it.
  const reads: Array<[Record<string, unknown>, number | undefined]> = [];
  for (const path of ['crlf.txt', 'bom.txt', 'bad.txt', 'mixed.txt', 'long.txt', 'big.txt']) {
    for (const cap of [24000, 1000, undefined]) {
      reads.push([{ path: `ref/${path}` }, cap], [{ path: `ref/${path}`, offsetChars: 0, limitChars: 5000 }, cap]);
    }
  }
  const answers = async (m: WorkspaceModule): Promise<Array<[Record<string, unknown>, number | undefined, Record<string, any>]>> => {
    const out: Array<[Record<string, unknown>, number | undefined, Record<string, any>]> = [];
    for (const [input, cap] of reads) {
      const r = await m.handleToolCall({ id: 'read', name: 'read', input, ...(cap !== undefined ? { resultMaxChars: cap } : {}) });
      // Every page a call with a result limit asked for fits it, as its text measures it.
      const text = r.success ? (r.data as Array<{ text: string }>)[0]!.text : '';
      if (cap !== undefined) assert.ok(text.length <= cap, `${String(input.path)}${'offsetChars' in input ? ' in characters' : ''} at ${cap}: ${text.length}`);
      out.push([input, cap, r.success ? r.structured as Record<string, any> : { error: r.error }]);
    }
    return out;
  };
  const direct = await env.open();
  const fromDisk = await answers(direct);
  const page = (path: string, cap: number | undefined, chars = false) =>
    fromDisk.find(([input, c]) => input.path === `ref/${path}` && c === cap && ('offsetChars' in input) === chars)![2];
  assert.equal(page('crlf.txt', 24000).content, '     1\tone\n     2\ttwo');
  assert.match(page('crlf.txt', 24000).note, /^Line ends are CRLF, shown without the CR\./);
  assert.equal(page('bom.txt', 24000).content, '     1\tfirst');
  assert.match(page('bom.txt', 24000).note, /BOM/);
  assert.match(page('bad.txt', 24000).note, /isn't valid UTF-8/);
  assert.equal(page('mixed.txt', 24000).content, '     1\ta\n     2\tb\n     3\tc\r\r\n     4\td');
  assert.equal(page('long.txt', 24000).content, `     1\t${'x'.repeat(2000)} [… read the rest with offsetChars=2000 and limitChars=58000]\n     2\ty`);
  // Every page a call asked for is a page.
  for (const [input, cap, d] of fromDisk) {
    const label = `${String(input.path)}${'offsetChars' in input ? ' in characters' : ''} at ${cap}`;
    assert.equal(typeof d.content, 'string', `${label}: ${JSON.stringify(d).slice(0, 200)}`);
  }
  assert.ok(page('big.txt', 24000).toLine < 3000);
  assert.equal(page('long.txt', undefined).content.length, '     1\t'.length + 60000 + '\n     2\ty'.length);
  await env.close(direct);
  // The same answers as a 'chronicle' mount's, whose first read of a file
  // takes it in with nothing more to say of it.
  assert.deepEqual(fromDisk, await answers(await env.openChronicle()));
});

test("a direct mount's grep matches lines as read shows them, as a 'chronicle' mount's grep does, with each file's lineEndings and the notes on a pattern for a CR or U+FEFF", async (t) => {
  const env = new Env(t);
  env.file('crlf.txt', 'alpha\r\nfoo\r\nomega\r\n');
  env.file('mixed.txt', 'foo\r\nbar\n');
  env.file('lf.txt', 'foo\n');
  env.file('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('foo\n')]));
  env.file('both.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\n')]));
  const calls: Array<Record<string, unknown>> = [
    { pattern: '^foo$' },
    { pattern: '\\r$', path: 'ref/crlf.txt' },
    { pattern: '^\\uFEFF', path: 'ref/bom.txt' },
    { pattern: '^\\uFEFF|\\r$', path: 'ref/both.txt' },
    { pattern: '\\r', path: 'ref/lf.txt' },
  ];
  // A 'chronicle' mount labels each result with its path's state and the
  // workspace's copy, a direct mount's with disk's file: the rest is the same,
  // but for where the notes say read shows what lines leave out.
  const answers = async (m: WorkspaceModule): Promise<Array<[Record<string, unknown>, Array<Record<string, unknown>>, string | null]>> => {
    const out: Array<[Record<string, unknown>, Array<Record<string, unknown>>, string | null]> = [];
    for (const input of calls) {
      const d = await data<{ results: Array<Record<string, unknown>>; note?: string }>(m, 'grep', input);
      out.push([input, d.results.map(({ state: _state, version: _version, ...rest }) => rest), d.note ?? null]);
    }
    return out;
  };
  const direct = await env.open();
  const fromDisk = await answers(direct);
  const byFile = Object.fromEntries(fromDisk[0]![1].map((r) => [r.file, r]));
  assert.deepEqual(byFile['ref/crlf.txt'], { file: 'ref/crlf.txt', lineEndings: 'CRLF', matches: [{ line: 2, text: 'foo' }] });
  assert.equal(byFile['ref/mixed.txt']!.lineEndings, 'mixed');
  assert.deepEqual(byFile['ref/bom.txt'], { file: 'ref/bom.txt', matches: [{ line: 1, text: 'foo' }] });
  assert.deepEqual(byFile['ref/lf.txt'], { file: 'ref/lf.txt', matches: [{ line: 1, text: 'foo' }] });
  // Each note names the files searched that have what it's about.
  const cr = (file: string) => `The pattern names a CR, and 1 file searched has CRLF line ends: ${file} (CRLF). Lines are matched as read shows them, `
    + "which leaves out a CRLF end's CR unless the line's own text ends in a CR. read with offsetChars shows every CR in the workspace's copy";
  const bom = (file: string) => `The pattern names U+FEFF, and 1 file searched starts with a BOM: ${file}. Lines are matched as read shows them, `
    + "and a BOM isn't part of the first line. read with offsetChars shows any BOM";
  // On a host with a direct mount, which keeps no workspace copy, the notes
  // name disk's file too; on a host with none, the workspace's copy alone.
  const onDisk = ", or in disk's file on a direct mount.";
  const notes = (crEnd: string, bomEnd: string) => [
    `${cr('ref/crlf.txt')}${crEnd}`, `${bom('ref/bom.txt')}${bomEnd}`, `${cr('ref/both.txt')}${crEnd} ${bom('ref/both.txt')}${bomEnd}`, null];
  assert.deepEqual(fromDisk.slice(1).map(([, results, note]) => [results.length, note]),
    notes(onDisk, ` in the workspace's copy${onDisk}`).map((n) => [0, n]));
  await env.close(direct);
  const fromStore = await answers(await env.openChronicle());
  assert.deepEqual(fromStore.map(([input, results]) => [input, results]), fromDisk.map(([input, results]) => [input, results]));
  assert.deepEqual(fromStore.slice(1).map(([, , note]) => note), notes('.', " the workspace's copy has."));
});

test("on a host with a direct mount, grep's notes name disk's file too where the search was of a 'chronicle' mount beside it", async (t) => {
  const env = new Env(t);
  const work = join(env.root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'crlf.txt'), 'alpha\r\nomega\r\n');
  writeFileSync(join(work, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('foo\n')]));
  // The tools' descriptions mention direct mounts on this host, and so do
  // the notes, whichever of its mounts a grep searched.
  const m = await env.open({}, [{ name: 'work', path: work, mode: 'read-write', watch: 'never' }]);
  const onDisk = ", or in disk's file on a direct mount.";
  const cr = await data<{ results: unknown[]; note?: string }>(m, 'grep', { pattern: '\\r$', path: 'work/crlf.txt' });
  assert.deepEqual(cr.results, []);
  assert.ok(cr.note?.endsWith(`read with offsetChars shows every CR in the workspace's copy${onDisk}`), cr.note);
  const bom = await data<{ results: unknown[]; note?: string }>(m, 'grep', { pattern: '^\\uFEFF', path: 'work/bom.txt' });
  assert.deepEqual(bom.results, []);
  assert.ok(bom.note?.endsWith(`read with offsetChars shows any BOM in the workspace's copy${onDisk}`), bom.note);
});

test('inOrder hands each result on in order, at most `width` at once', async () => {
  const settle: Array<() => void> = [];
  const settled: number[] = [];
  const order: number[] = [];
  let running = 0;
  let most = 0;
  const done = workspaceModule.inOrder([0, 1, 2, 3, 4, 5, 6, 7], 3, (i) => {
    running++;
    most = Math.max(most, running);
    return new Promise<number>((resolve) => {
      settle[i] = () => {
        running--;
        settled.push(i);
        resolve(i * 10);
      };
    });
  }, (result, i) => {
    assert.equal(result, i * 10);
    order.push(i);
  });
  // Each window's works settle last to first, so each settles before the
  // ones ahead of it are handed on.
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  for (const window of [[2, 1, 0], [5, 4, 3], [7, 6]]) {
    await turn();
    for (const i of window) {
      settle[i]!();
      await turn();
    }
  }
  await done;
  assert.deepEqual(settled, [2, 1, 0, 5, 4, 3, 7, 6]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(most, 3);
});

test('inOrder lets each result go once it has handed it on', async () => {
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  const handed: Array<WeakRef<object>> = [];
  let firstKept: boolean | undefined;
  // Each work ends in a later task than the one before it, so a WeakRef made
  // in one is no longer held for its task when gc runs in another.
  await workspaceModule.inOrder(Array.from({ length: 10 }, (_, i) => i), 2, async (i) => {
    await new Promise((resolve) => setImmediate(resolve));
    return { i, bytes: Buffer.alloc(64 * 1024) };
  }, (result, i) => {
    handed.push(new WeakRef(result));
    if (i === 9) {
      gc();
      firstKept = handed[0]!.deref() !== undefined;
    }
  });
  assert.equal(firstKept, false);
});

test('inOrder rejects in turn for a work that rejects before its turn, leaving no rejection unhandled', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', record);
  try {
    let second!: () => void;
    const secondRejected = new Promise<void>((resolve) => { second = resolve; });
    const seen: number[] = [];
    await assert.rejects(workspaceModule.inOrder([0, 1, 2], 3, async (i) => {
      if (i === 1) {
        queueMicrotask(second);
        throw new Error('the second');
      }
      // The first finishes only after the second has rejected and a turn of
      // the event loop has passed, when Node reports a rejection unhandled.
      if (i === 0) {
        await secondRejected;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return i;
    }, (_, i) => { seen.push(i); }), { message: 'the second' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [0]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});
