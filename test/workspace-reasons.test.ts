import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ToolResult } from '../src/types/events.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const NO_PERMISSIONS = (process.platform === 'win32' && 'POSIX permissions') || (IS_ROOT && 'root writes past permissions');
const NO_FIFO = process.platform === 'win32' && 'no FIFOs';
const NO_LINKS = process.platform === 'win32' && 'symlinks need privileges on Windows';
const PERMISSIONS = 'whoever runs this host can change the permissions';

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-reasons-'));
  store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  at(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  async open(mounts: Array<Partial<MountConfig> & { name: string }>): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: mounts.map((mount) => {
        const path = mount.path ?? this.at(mount.name);
        mkdirSync(path, { recursive: true });
        return { path, mode: 'read-write', ...(mount.backend === 'direct' ? {} : { watch: 'never' }), ...mount } as MountConfig;
      }),
    });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {}, notifyOps: () => {} } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }
}

const call = (m: WorkspaceModule, name: string, input: unknown): Promise<ToolResult> =>
  m.handleToolCall({ id: name, name, input, callerAgentName: 'resident' } as Parameters<WorkspaceModule['handleToolCall']>[0]);

async function ok(m: WorkspaceModule, name: string, input: unknown): Promise<Record<string, any>> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)} failed: ${result.error}`);
  return result.data as Record<string, any>;
}

async function refused(m: WorkspaceModule, name: string, input: unknown): Promise<string> {
  const result = await call(m, name, input);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} succeeded: ${JSON.stringify(result.data)}`);
  return result.error!;
}

const skipped = (data: Record<string, any>): string[] => (data.skipped ?? []).map((s: { reason: string }) => s.reason);

describe("a push's reasons", () => {
  test("an unlink the directory refuses gives the cause in plain words, never the system's message with the host's path, and who can fix it", { skip: NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }, { name: 'auto', autoMaterialize: true }, { name: 'direct', backend: 'direct' }]);
    mkdirSync(env.at('work', 'locked'));
    await ok(m, 'write', { path: 'work/locked/x.txt', content: 'x' });
    await ok(m, 'materialize', { path: 'work/locked/x.txt' });
    await ok(m, 'delete', { path: 'work/locked/x.txt' });
    mkdirSync(env.at('auto', 'locked'));
    await ok(m, 'write', { path: 'auto/locked/y.txt', content: 'y' });
    mkdirSync(env.at('direct', 'locked'));
    writeFileSync(env.at('direct', 'locked', 'z.txt'), 'z');
    for (const dir of ['work', 'auto', 'direct']) chmodSync(env.at(dir, 'locked'), 0o555);
    let answers: string[];
    try {
      answers = [
        ...skipped(await ok(m, 'materialize', { path: 'work/locked/x.txt', applyDeletions: true })),
        await refused(m, 'delete', { path: 'auto/locked/y.txt' }),
        await refused(m, 'delete', { path: 'direct/locked/z.txt' }),
      ];
    } finally {
      for (const dir of ['work', 'auto', 'direct']) chmodSync(env.at(dir, 'locked'), 0o755);
    }
    assert.deepEqual(answers, [
      `locked/x.txt: not unlinked: could not unlink the file: permission denied — materializing again with applyDeletions won't change that; ${PERMISSIONS}, and materializing again with applyDeletions then gets past it`,
      'The deletion of "auto/locked/y.txt" is stored in the workspace, so don\'t send it again. Its push to disk didn\'t complete: '
        + `not unlinked: could not unlink the file: permission denied — materializing again with applyDeletions won't change that; ${PERMISSIONS}, and materializing again with applyDeletions then gets past it.`,
      `The delete did nothing to "direct/locked/z.txt": could not unlink the file: permission denied. Calling again won't change that; ${PERMISSIONS}.`,
    ]);
    for (const answer of answers) assert.ok(!answer.includes(env.root), answer);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/locked/x.txt', applyDeletions: true })), [], 'with the permissions changed, the materialize the answer names deletes it');
    assert.equal(existsSync(env.at('work', 'locked', 'x.txt')), false);
  });

  test('a name too long for the filesystem is told a shorter name gets past it', async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    const long = `${'n'.repeat(300)}.txt`;
    await ok(m, 'write', { path: `work/${long}`, content: 'one' });
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: `work/${long}` })), [
      `${long}: cannot verify disk copy (cannot stat (a name too long for the filesystem)) — materializing again won't change that; a shorter name would get past it`,
    ]);
  });

  test("a file or directory a push can't make gives the errno in plain words and who can fix it", { skip: NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    mkdirSync(env.at('work', 'ro'));
    mkdirSync(env.at('work', 'shut'));
    await ok(m, 'write', { path: 'work/ro/new.txt', content: 'one' });
    await ok(m, 'write', { path: 'work/shut/sub/a.txt', content: 'one' });
    chmodSync(env.at('work', 'ro'), 0o555);
    chmodSync(env.at('work', 'shut'), 0o555);
    let reasons: string[];
    try {
      reasons = skipped(await ok(m, 'materialize', { mount: 'work' }));
    } finally {
      chmodSync(env.at('work', 'ro'), 0o755);
      chmodSync(env.at('work', 'shut'), 0o755);
    }
    assert.deepEqual(reasons.sort(), [
      `ro/new.txt: not written: cannot create the file (permission denied) — materializing again won't change that; ${PERMISSIONS}, and materializing again then gets past it`,
      `shut/sub/a.txt: not written: cannot create the directory shut/sub (permission denied) — materializing again won't change that; ${PERMISSIONS}, and materializing again then gets past it`,
    ]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { mount: 'work' })), [], 'with the permissions changed, a materialize writes both');
    assert.equal(readFileSync(env.at('work', 'shut', 'sub', 'a.txt'), 'utf8'), 'one');
  });

  test("a symlink the mount doesn't follow, at the path, is named with what gets past it, forced or not", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    writeFileSync(env.at('outside.txt'), 'outside');
    symlinkSync(env.at('outside.txt'), env.at('work', 'link.txt'));
    await ok(m, 'write', { path: 'work/link.txt', content: 'over a link' });
    const why = 'disk has a symlink at this path, which this mount does not follow, and no push writes through one, forced or not — '
      + 'write the file under another path, or whoever runs this host can remove the link, and materializing again then gets past it';
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/link.txt' })), [`link.txt: ${why}`]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/link.txt', force: true })), [`link.txt: not written: ${why}`]);
    assert.equal(readFileSync(env.at('outside.txt'), 'utf8'), 'outside');
    rmSync(env.at('work', 'link.txt'));
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/link.txt' })), [], 'with the link removed, the materialize writes the file');
    assert.equal(readFileSync(env.at('work', 'link.txt'), 'utf8'), 'over a link');
  });

  const noPushUnlinks = [
    {
      shape: "over a symlink the mount doesn't follow",
      follow: false,
      path: 'gone.txt',
      lay: (env: Env, dir: string) => symlinkSync(env.at('outside', 'x.txt'), join(dir, 'gone.txt')),
      why: 'disk has a symlink at this path, which this mount does not follow, and no push unlinks one, forced or not — ask whoever runs this host if it should go',
    },
    {
      shape: 'over a symlink leading out of a mount that follows links',
      follow: true,
      path: 'gone.txt',
      lay: (env: Env, dir: string) => symlinkSync(env.at('outside', 'x.txt'), join(dir, 'gone.txt')),
      why: 'this path leads out of the mount through a symlink on it, and no push unlinks through one, forced or not — ask whoever runs this host if it should go',
    },
    {
      shape: 'beneath a symlink to a file, on a mount that follows links',
      follow: true,
      path: 'sub/gone.txt',
      lay: (env: Env, dir: string) => {
        writeFileSync(join(dir, 'afile'), 'a file');
        symlinkSync(join(dir, 'afile'), join(dir, 'sub'));
      },
      why: 'a symlink on this path does not lead to a directory inside the mount, so nothing beneath it is in this mount, and no push unlinks beneath one, forced or not — '
        + 'whoever runs this host can remove the link or make it lead to a directory inside the mount, and materializing again with applyDeletions then gets past it',
      clear: (dir: string) => rmSync(join(dir, 'sub')),
    },
    {
      shape: 'beneath a directory leading out of a mount that follows links',
      follow: true,
      path: 'sub/gone.txt',
      lay: (env: Env, dir: string) => symlinkSync(env.at('outside'), join(dir, 'sub')),
      why: 'a directory on this path leads out of the mount, and no push unlinks beneath one, forced or not — ask whoever runs this host if what is there should go',
    },
  ];
  for (const { shape, follow, path, lay, why, clear } of noPushUnlinks as Array<(typeof noPushUnlinks)[number] & { clear?: (dir: string) => void }>) {
    test(`a workspace deletion ${shape} is one no push makes: a forced push without applyDeletions says so, and one with it gives the same reason`, { skip: NO_LINKS }, async (t) => {
      const env = new Env(t);
      const m = await env.open([{ name: 'work', followSymlinks: follow }]);
      mkdirSync(env.at('outside'));
      writeFileSync(env.at('outside', 'x.txt'), 'outside');
      writeFileSync(env.at('outside', 'gone.txt'), 'outside');
      await ok(m, 'write', { path: `work/${path}`, content: 'one' });
      await ok(m, 'materialize', { path: `work/${path}` });
      await ok(m, 'delete', { path: `work/${path}` });
      rmSync(env.at('work', path.split('/')[0]!), { recursive: true });
      lay(env, env.at('work'));
      const forced = await ok(m, 'materialize', { path: `work/${path}`, force: true });
      assert.deepEqual(skipped(forced), [`${path}: ${why}`]);
      assert.equal(forced.workspaceDeletionsLeftOnDisk, undefined, 'not left for applyDeletions, which no push could make either');
      assert.deepEqual(skipped(await ok(m, 'materialize', { path: `work/${path}`, applyDeletions: true })), [`${path}: ${why}`]);
      assert.deepEqual(skipped(await ok(m, 'materialize', { path: `work/${path}`, applyDeletions: true, force: true })), [`${path}: not unlinked: ${why}`]);
      assert.deepEqual([readFileSync(env.at('outside', 'x.txt'), 'utf8'), readFileSync(env.at('outside', 'gone.txt'), 'utf8')], ['outside', 'outside'], 'what the link leads to stays');
      if (clear) {
        clear(env.at('work'));
        assert.deepEqual(skipped(await ok(m, 'materialize', { path: `work/${path}`, applyDeletions: true })), [], 'with the link removed, materializing again with applyDeletions gets past it');
      }
    });
  }

  test("a workspace deletion beneath a symlink the mount doesn't follow is one no push makes: a forced push without applyDeletions says so with the link's own words", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    mkdirSync(env.at('outside'));
    writeFileSync(env.at('outside', 'gone.txt'), 'outside');
    await ok(m, 'write', { path: 'work/sub/gone.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/sub/gone.txt' });
    await ok(m, 'delete', { path: 'work/sub/gone.txt' });
    rmSync(env.at('work', 'sub'), { recursive: true });
    symlinkSync(env.at('outside'), env.at('work', 'sub'));
    const why = '"work/sub" is a symlink leading outside the mount, which this mount does not follow; '
      + 'followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it';
    const forced = await ok(m, 'materialize', { path: 'work/sub/gone.txt', force: true });
    assert.deepEqual(skipped(forced), [`sub/gone.txt: ${why}`]);
    assert.equal(forced.workspaceDeletionsLeftOnDisk, undefined, 'not left for applyDeletions, which no push could make either');
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/sub/gone.txt', applyDeletions: true })), [`sub/gone.txt: cannot verify disk copy (${why})`]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/sub/gone.txt', applyDeletions: true, force: true })), [`sub/gone.txt: not unlinked: ${why}`]);
    assert.equal(readFileSync(env.at('outside', 'gone.txt'), 'utf8'), 'outside', 'what the link leads to stays');
  });

  test('a directory on the way that resolves outside a mount that follows links is named with what gets past it, forced or not', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outside'));
    mkdirSync(env.at('fl'));
    symlinkSync(env.at('outside'), env.at('fl', 'outdir'));
    const m = await env.open([{ name: 'fl', followSymlinks: true }]);
    await ok(m, 'write', { path: 'fl/outdir/new.txt', content: 'new' });
    const why = 'a directory on this path leads out of the mount, and no push writes beneath one, forced or not — write the file under another path';
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'fl/outdir/new.txt' })), [`outdir/new.txt: ${why}`]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'fl/outdir/new.txt', force: true })), [`outdir/new.txt: not written: ${why}`]);
    assert.equal(existsSync(env.at('outside', 'new.txt')), false, 'nothing was written outside the mount');
  });

  test('a pipe at the path is named with what gets past it, forced or not', { skip: NO_FIFO }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    await ok(m, 'write', { path: 'work/fifo.txt', content: 'one' });
    spawnSync('mkfifo', [env.at('work', 'fifo.txt')]);
    const why = 'disk has a pipe, socket or device at this path, or a symlink to one, and no push writes a file over it, forced or not — '
      + 'write the file under another path, or whoever runs this host can remove it, and materializing again then gets past it';
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/fifo.txt' })), [`fifo.txt: ${why}`]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/fifo.txt', force: true })), [`fifo.txt: not written: ${why}`]);
  });

  test("a failed read of disk's copy, verifying it before an overwrite, is said in plain words, and nothing is written", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    await ok(m, 'write', { path: 'work/v.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/v.txt' });
    await ok(m, 'write', { path: 'work/v.txt', content: 'two' });
    const probe = await open(env.at('probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
    await probe.close();
    const realRead = proto.read;
    proto.read = async function (this: unknown, ...args: unknown[]) {
      if (new Error().stack!.includes('hashAt')) throw Object.assign(new Error(`EIO: i/o error, read`), { code: 'EIO' });
      return realRead.apply(this, args);
    };
    let reasons: string[];
    try {
      reasons = skipped(await ok(m, 'materialize', { path: 'work/v.txt' }));
    } finally {
      proto.read = realRead;
    }
    assert.deepEqual(reasons, ['v.txt: not written: cannot verify the disk copy (an input/output error on the disk) — '
      + 'materializing again may get past it; if it fails the same way, whoever runs this host can check the disk']);
    assert.equal(readFileSync(env.at('work', 'v.txt'), 'utf8'), 'one', "disk's copy stays");
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/v.txt' })), [], 'materializing again writes it');
    assert.equal(readFileSync(env.at('work', 'v.txt'), 'utf8'), 'two');
  });

  test('a push that fails in a way its steps don\'t name, after its write began, says so in plain words and that whether disk holds the change isn\'t known', async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    await ok(m, 'write', { path: 'work/c.txt', content: 'one' });
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const original = fsp.open!;
    fsp.open = async (...args: any[]) => {
      const fromWrite = new Error().stack!.includes('writeContained');
      const handle = await original(...args);
      if (fromWrite) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    let reasons: string[];
    try {
      reasons = skipped(await ok(m, 'materialize', { path: 'work/c.txt' }));
    } finally {
      fsp.open = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(reasons, ['c.txt: the push failed: an input/output error on the disk — '
      + "whether disk holds the change isn't known until it's checked: a materialize of this path checks it and says how it ended"]);
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'work/c.txt' })), [], 'the materialize it names finds the write landed');
    assert.equal(readFileSync(env.at('work', 'c.txt'), 'utf8'), 'one');
  });

  test("a file replaced between the check of disk's copy and its verifying read is answered as a change, with calling again", { skip: process.platform === 'win32' && 'POSIX inodes' }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    await ok(m, 'write', { path: 'work/v.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/v.txt' });
    await ok(m, 'write', { path: 'work/v.txt', content: 'two' });
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const original = fsp.open!;
    let swapped = false;
    fsp.open = async (...args: any[]) => {
      if (!swapped && new Error().stack!.includes('hashAt')) {
        swapped = true;
        rmSync(env.at('work', 'v.txt'));
        writeFileSync(env.at('work', 'v.txt'), "another writer's");
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    let reasons: string[];
    try {
      reasons = skipped(await ok(m, 'materialize', { path: 'work/v.txt' }));
    } finally {
      fsp.open = original;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.deepEqual(reasons, ['v.txt: not written: disk changed since it was checked — materializing again checks it afresh']);
    assert.equal(readFileSync(env.at('work', 'v.txt'), 'utf8'), "another writer's", "the other writer's file stays");
  });

  const writeThroughLinks = [
    {
      shape: 'a symlink at the path leading out of a mount that follows links',
      config: {},
      lay: (env: Env) => symlinkSync(env.at('outside.txt'), env.at('fl', 'f.txt')),
      why: 'this path leads out of the mount through a symlink on it, and no push writes through one, forced or not — '
        + 'write the file under another path, or whoever runs this host can remove the link, and materializing again then gets past it',
    },
    {
      shape: "a file reached through a directory link whose landing the mount's include leaves out",
      config: { include: ['docs/**'] },
      lay: (env: Env) => symlinkSync(env.at('fl', 'other'), env.at('fl', 'docs', 'alias')),
      why: 'this path leads out of the mount through a symlink on it, and no push writes through one, forced or not — '
        + 'write the file under another path, or whoever runs this host can remove the link, and materializing again then gets past it',
    },
    {
      shape: 'a symlink to a directory at the path, on a mount that follows links',
      config: {},
      lay: (env: Env) => symlinkSync(env.at('fl', 'other'), env.at('fl', 'f.txt')),
      why: 'disk has a symlink to a directory at this path, and no push writes a file over it, forced or not — '
        + 'write the file under another path, or whoever runs this host can remove it, and materializing again then gets past it',
    },
  ];
  for (const { shape, config, lay, why } of writeThroughLinks) {
    test(`a write's push over ${shape} names what stands in the way, forced or not`, { skip: NO_LINKS }, async (t) => {
      const env = new Env(t);
      mkdirSync(env.at('fl', 'other'), { recursive: true });
      mkdirSync(env.at('fl', 'docs'), { recursive: true });
      writeFileSync(env.at('fl', 'other', 'f.txt'), 'other');
      writeFileSync(env.at('outside.txt'), 'outside');
      const path = 'include' in config ? 'docs/alias/f.txt' : 'f.txt';
      const m = await env.open([{ name: 'fl', followSymlinks: true, ...config }]);
      if ('include' in config) mkdirSync(env.at('fl', 'docs', 'alias'));
      await ok(m, 'write', { path: `fl/${path}`, content: 'one' });
      if ('include' in config) rmSync(env.at('fl', 'docs', 'alias'), { recursive: true });
      lay(env);
      assert.deepEqual(skipped(await ok(m, 'materialize', { path: `fl/${path}` })), [`${path}: ${why}`]);
      assert.deepEqual(skipped(await ok(m, 'materialize', { path: `fl/${path}`, force: true })), [`${path}: not written: ${why}`]);
      assert.deepEqual([readFileSync(env.at('outside.txt'), 'utf8'), readFileSync(env.at('fl', 'other', 'f.txt'), 'utf8')], ['outside', 'other'], 'nothing was written through the link');
    });
  }

  test("a write's push that fails after its bytes began says whether disk holds them isn't known, and the materialize it names says how it ended", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'auto', autoMaterialize: true }]);
    const probe = await open(env.at('probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as { writeFile: (data: Buffer) => Promise<void> };
    await probe.close();
    const realWriteFile = proto.writeFile;
    proto.writeFile = async function (this: unknown, data: Buffer) {
      await realWriteFile.call(this, Buffer.from(data).subarray(0, 3));
      throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    };
    let answer: string;
    try {
      answer = await refused(m, 'write', { path: 'auto/t.txt', content: 'one two' });
    } finally {
      proto.writeFile = realWriteFile;
    }
    assert.equal(answer, 'The write of "auto/t.txt" is stored in the workspace, so don\'t send it again. Its push to disk didn\'t complete: '
      + "could not write the file: an input/output error on the disk — whether disk holds the change isn't known until it's checked: "
      + 'a materialize of this path checks it and says how it ended.');
    const [reason] = skipped(await ok(m, 'materialize', { path: 'auto/t.txt' }));
    assert.match(reason ?? '', /^t\.txt: disk holds bytes that match neither .*\(conflict: interrupted\)/);
  });
});

describe('a reason disk gave for what it holds', () => {
  test("in a disk copy a push couldn't verify, a nested mount's place is the way on, with nothing added", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outer', 'a', 'b'), { recursive: true });
    writeFileSync(env.at('outer', 'a', 'b', 'x.txt'), "the inner mount's\n");
    const m = await env.open([{ name: 'outer', followSymlinks: true }, { name: 'inner', path: env.at('outer', 'a', 'b') }]);
    await ok(m, 'write', { path: 'outer/flink.txt', content: 'outer wrote\n' });
    symlinkSync(env.at('outer', 'a', 'b', 'x.txt'), env.at('outer', 'flink.txt'));
    assert.deepEqual(skipped(await ok(m, 'materialize', { path: 'outer/flink.txt' })), [
      'flink.txt: cannot verify disk copy ("outer/flink.txt" leads into mount "inner", nested in mount "outer": use "inner/x.txt" in its place)',
    ]);
  });

  test("beneath a followed symlink into a nested mount's directory, a file's reason names that mount's place, not a link that leads out of the mount", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outer', 'a', 'b'), { recursive: true });
    const m = await env.open([{ name: 'outer', followSymlinks: true }, { name: 'inner', path: env.at('outer', 'a', 'b') }]);
    for (const name of ['y.txt', 'z.txt']) await ok(m, 'write', { path: `outer/l/sub/${name}`, content: 'outer wrote\n' });
    await ok(m, 'materialize', { mount: 'outer' });
    await ok(m, 'delete', { path: 'outer/l/sub/z.txt' });
    rmSync(env.at('outer', 'l'), { recursive: true });
    symlinkSync(env.at('outer', 'a', 'b'), env.at('outer', 'l'));
    const why = '"outer/l" leads into mount "inner", nested in mount "outer": use "inner" in its place';
    assert.deepEqual(skipped(await ok(m, 'sync', { path: 'outer/l/sub/y.txt' })), [`disk could not be checked: ${why}`]);
    const forced = await ok(m, 'materialize', { path: 'outer/l/sub/z.txt', force: true });
    assert.deepEqual(skipped(forced), [`l/sub/z.txt: ${why}`], 'a deletion there is one no push makes');
    assert.equal(forced.workspaceDeletionsLeftOnDisk, undefined);
  });

  test("beneath a followed symlink to a directory outside the mount, a file's reason says nothing beneath the link is in this mount", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outside'));
    const m = await env.open([{ name: 'fl', followSymlinks: true }]);
    await ok(m, 'write', { path: 'fl/l/sub/y.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'fl/l/sub/y.txt' });
    rmSync(env.at('fl', 'l'), { recursive: true });
    symlinkSync(env.at('outside'), env.at('fl', 'l'));
    assert.deepEqual(skipped(await ok(m, 'sync', { path: 'fl/l/sub/y.txt' })), ["disk could not be checked: beneath a symlink that does not lead to a directory inside the mount — syncing this path again won't change that; "
      + 'nothing beneath it is in this mount, and whoever runs this host can make it lead to a directory inside the mount, or, where it leads to a directory outside, mount that directory']);
  });

  test("a mount whose path came to name another directory during a sync says listing it checks it afresh, and who can check the mount's directory", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('first'));
    mkdirSync(env.at('second'));
    writeFileSync(env.at('first', 'a.txt'), 'first\n');
    writeFileSync(env.at('second', 'a.txt'), 'second\n');
    symlinkSync(env.at('first'), env.at('link'));
    const m = await env.open([{ name: 'd', path: env.at('link') }]);
    await ok(m, 'sync', {});
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const realpath = fsp.realpath;
    let repointed = false;
    fsp.realpath = async (...args: unknown[]) => {
      const got = await realpath(...args);
      if (!repointed && args[0] === env.at('link') && (new Error().stack ?? '').includes('locateRoot')) {
        repointed = true;
        rmSync(env.at('link'));
        symlinkSync(env.at('second'), env.at('link'));
      }
      return got;
    };
    syncBuiltinESMExports();
    let data: Record<string, any>;
    try {
      data = await ok(m, 'sync', {});
    } finally {
      fsp.realpath = realpath;
      syncBuiltinESMExports();
    }
    assert.ok(repointed, "the mount's path came to name another directory during the sync");
    assert.ok((data.incomplete ?? []).some((r: { reason: string }) => r.reason.endsWith(
      "listing it checks it afresh; if it's still unavailable, whoever runs this host can check the mount's directory and its path")), JSON.stringify(data));
  });

  test("sync's skip names what gets past what disk holds at the path", { skip: NO_FIFO || NO_LINKS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'nf' }, { name: 'fl', followSymlinks: true }]);
    for (const path of ['nf/fifo.txt', 'nf/dir.txt', 'fl/ldir.txt', 'fl/sub/a.txt']) {
      await ok(m, 'write', { path, content: 'one' });
      await ok(m, 'materialize', { path });
    }
    rmSync(env.at('nf', 'fifo.txt'));
    spawnSync('mkfifo', [env.at('nf', 'fifo.txt')]);
    rmSync(env.at('nf', 'dir.txt'));
    mkdirSync(env.at('nf', 'dir.txt'));
    mkdirSync(env.at('fl', 'real'));
    rmSync(env.at('fl', 'ldir.txt'));
    symlinkSync(env.at('fl', 'real'), env.at('fl', 'ldir.txt'));
    writeFileSync(env.at('fl', 'afile'), 'a file');
    rmSync(env.at('fl', 'sub'), { recursive: true });
    symlinkSync(env.at('fl', 'afile'), env.at('fl', 'sub'));
    const skip = async (path: string) => skipped(await ok(m, 'sync', { path }));
    assert.deepEqual(await skip('nf/fifo.txt'), ["disk could not be checked: not a regular file — syncing this path again won't change that; whoever runs this host can put a regular file there, and a sync of this path then takes it in"]);
    assert.deepEqual(await skip('nf/dir.txt'), ["disk could not be checked: a directory — syncing this path again won't change that; ls of this path lists what's in it"]);
    assert.deepEqual(await skip('fl/ldir.txt'), ["disk could not be checked: a symlink to a directory, not walked — syncing this path again won't change that; ls of the directory it leads to lists what's in it"]);
    assert.deepEqual(await skip('fl/sub/a.txt'), ["disk could not be checked: beneath a symlink that does not lead to a directory inside the mount — syncing this path again won't change that; "
      + 'nothing beneath it is in this mount, and whoever runs this host can make it lead to a directory inside the mount, or, where it leads to a directory outside, mount that directory']);
  });

  test("sync's skip of a file disk won't let it read names who can fix it", { skip: NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/a.txt' });
    writeFileSync(env.at('work', 'a.txt'), 'shell');
    chmodSync(env.at('work', 'a.txt'), 0o000);
    let data: Record<string, any>;
    try {
      data = await ok(m, 'sync', { path: 'work/a.txt' });
    } finally {
      chmodSync(env.at('work', 'a.txt'), 0o644);
    }
    assert.deepEqual(skipped(data), [`disk could not be checked: cannot open (permission denied) — syncing this path again won't change that; ${PERMISSIONS}, and a sync of this path then takes it in`]);
    assert.equal((await ok(m, 'sync', { path: 'work/a.txt' })).totalSynced, 1, 'with the permissions changed, the sync takes it in');
  });

  test("a directory the walk can't list is named in plain words with who can fix it, in ls and sync", { skip: NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    mkdirSync(env.at('work', 'closed'));
    writeFileSync(env.at('work', 'closed', 'x.txt'), 'x');
    await ok(m, 'write', { path: 'work/closed/t.txt', content: 'tracked' });
    await ok(m, 'materialize', { path: 'work/closed/t.txt' });
    chmodSync(env.at('work', 'closed'), 0o000);
    let ls: Record<string, any>;
    let sync: Record<string, any>;
    try {
      ls = await ok(m, 'ls', { path: 'work', recursive: true });
      sync = await ok(m, 'sync', { mount: 'work' });
    } finally {
      chmodSync(env.at('work', 'closed'), 0o755);
    }
    const why = `cannot list (permission denied) — listing it won't change that; ${PERMISSIONS}, and the workspace then reaches it`;
    assert.deepEqual(ls.incomplete, [{ path: 'closed', reason: why }]);
    assert.deepEqual(sync.incomplete, [{ mount: 'work', path: 'closed', reason: why }]);
    assert.deepEqual(sync.skipped, [{ mount: 'work', path: 'closed/t.txt',
      reason: `disk could not be checked: cannot list (permission denied) — syncing this path again won't change that; ${PERMISSIONS}, and a sync of this path then takes it in` }], "a tracked file there gets the same way on");
  });

  test("a directory the walk can list but not search gives its subdirectory's errno in plain words with who can fix it", { skip: NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    mkdirSync(env.at('work', 'half', 'sub'), { recursive: true });
    chmodSync(env.at('work', 'half'), 0o444);
    let ls: Record<string, any>;
    try {
      ls = await ok(m, 'ls', { path: 'work', recursive: true });
    } finally {
      chmodSync(env.at('work', 'half'), 0o755);
    }
    assert.deepEqual(ls.incomplete, [{ path: 'half/sub', reason: `cannot stat (permission denied) — listing it won't change that; ${PERMISSIONS}, and the workspace then reaches it` }]);
  });

  test("sync's skip of what its walk passes over names the sync of the path, which checks it by its path", { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('elsewhere'));
    writeFileSync(env.at('elsewhere', 'x.txt'), 'elsewhere');
    const m = await env.open([{ name: 'ig', ignore: ['*.log'] }, { name: 'nf' }]);
    for (const path of ['ig/a.log', 'ig/notes.txt~', 'nf/d/x.txt']) {
      await ok(m, 'write', { path, content: 'one' });
      await ok(m, 'materialize', { path });
    }
    writeFileSync(env.at('ig', 'a.log'), 'shell');
    rmSync(env.at('nf', 'd'), { recursive: true });
    symlinkSync(env.at('elsewhere'), env.at('nf', 'd'));
    const tracked = (data: Record<string, any>, path: string) => (data.skipped ?? []).filter((s: { path: string }) => s.path === path).map((s: { reason: string }) => s.reason);
    const ig = await ok(m, 'sync', { mount: 'ig' });
    assert.deepEqual(tracked(ig, 'a.log'), ['disk could not be checked: ignored by the mount — a sync of this path checks it']);
    assert.deepEqual(tracked(ig, 'notes.txt~'), ["disk could not be checked: an editor's swap or backup file — a sync of this path checks it"]);
    assert.equal((await ok(m, 'sync', { path: 'ig/a.log' })).totalSynced, 1, 'the sync of the path takes it in');
    assert.equal(env.store.getBlob(env.store.treeGet('workspace/ig/tree', 'a.log')!.blobHash)?.toString('utf8'), 'shell');
    assert.deepEqual(tracked(await ok(m, 'sync', { mount: 'nf' }), 'd/x.txt'), ['disk could not be checked: a symlink, not walked — a sync of this path checks it']);
    assert.deepEqual(tracked(await ok(m, 'sync', { path: 'nf/d/x.txt' }), 'd/x.txt'), ['disk could not be checked: "nf/d" is a symlink leading outside the mount, which this mount does not follow; '
      + 'followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it'], 'the sync of the path names the link and what gets past it');
  });

  for (const [state, leave] of [['gone', (_at: string) => {}], ['a file now', (at: string) => writeFileSync(at, 'a file')]] as const) {
    test(`a mount whose directory is ${state} says who can put it back, in materialize, sync and ls`, async (t) => {
      const env = new Env(t);
      const m = await env.open([{ name: 'gone' }]);
      await ok(m, 'write', { path: 'gone/a.txt', content: 'one' });
      rmSync(env.at('gone'), { recursive: true });
      leave(env.at('gone'));
      const back = "whoever runs this host can put the mount's directory back at its path";
      assert.deepEqual(skipped(await ok(m, 'materialize', { mount: 'gone' })), [`a.txt: the mount root is unavailable — materializing again won't change that; ${back}, and materializing again then gets past it`]);
      assert.deepEqual((await ok(m, 'sync', { mount: 'gone' })).incomplete, [{ mount: 'gone', path: '', reason: `the mount root is unavailable — listing it won't change that; ${back}, and the workspace then reaches it` }]);
      assert.deepEqual((await ok(m, 'ls', { path: 'gone' })).incomplete, [{ path: '', reason: `the mount root is unavailable — listing it won't change that; ${back}, and the workspace then reaches it` }]);
    });
  }
});

describe("a direct mount's delete", () => {
  test('of a file another writer replaces while it is checked says to call again, and calling again deletes it', { skip: process.platform === 'win32' && 'POSIX inodes' }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'direct', backend: 'direct' }]);
    writeFileSync(env.at('direct', 'f.txt'), 'one');
    // The file is replaced by another just after the unlink's first look at it.
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const original = fsp.lstat!;
    let swapped = false;
    fsp.lstat = async (...args: any[]) => {
      const info = await original(...args);
      if (!swapped && String(args[0]).endsWith(`${sep}f.txt`) && new Error().stack!.includes('unlinkContained')) {
        swapped = true;
        rmSync(env.at('direct', 'f.txt'));
        writeFileSync(env.at('direct', 'f.txt'), "another writer's");
      }
      return info;
    };
    syncBuiltinESMExports();
    try {
      assert.equal(await refused(m, 'delete', { path: 'direct/f.txt' }), 'The delete did nothing to "direct/f.txt": disk changed since it was checked. Calling again checks it afresh.');
    } finally {
      fsp.lstat = original;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.equal(readFileSync(env.at('direct', 'f.txt'), 'utf8'), "another writer's", "the other writer's file stays");
    await ok(m, 'delete', { path: 'direct/f.txt' });
    assert.equal(existsSync(env.at('direct', 'f.txt')), false, 'calling again deletes it');
  });
});

describe('a symlink among a path\'s directories', () => {
  test('that leads inside the mount names its own path to use, and the setting whoever runs the host can change', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('nf', 'real'), { recursive: true });
    writeFileSync(env.at('nf', 'real', 'a.txt'), 'inside');
    symlinkSync(env.at('nf', 'real'), env.at('nf', 'indir'));
    const m = await env.open([{ name: 'nf' }]);
    const why = '"nf/indir" is a symlink to "nf/real", which this mount does not follow; use "nf/real" in place of "nf/indir", '
      + 'or whoever runs this host can set followSymlinks: true on mount "nf".';
    assert.equal(await refused(m, 'read', { path: 'nf/indir/a.txt' }), `The read did nothing: "nf/indir/a.txt" isn't in the workspace, and disk couldn't be checked: ${why}`);
    assert.equal(await refused(m, 'read_image', { path: 'nf/indir/a.png' }), `The read_image did nothing: "nf/indir/a.png" can't be reached: ${why}`);
    assert.match(JSON.stringify(await ok(m, 'read', { path: 'nf/real/a.txt' })), /inside/, 'the path it names reads the file');
  });

  test('that leads outside the mount, or nowhere, says what gets past it', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outside'));
    writeFileSync(env.at('outside', 'a.png'), 'outside');
    mkdirSync(env.at('nf'));
    symlinkSync(env.at('outside'), env.at('nf', 'outdir'));
    symlinkSync(env.at('nowhere'), env.at('nf', 'nodir'));
    writeFileSync(env.at('afile'), 'a file');
    symlinkSync(join(env.at('afile'), 'below'), env.at('nf', 'belowfile'));
    symlinkSync(env.at('nf', 'loop'), env.at('nf', 'loop'));
    const m = await env.open([{ name: 'nf' }]);
    assert.equal(await refused(m, 'read_image', { path: 'nf/outdir/a.png' }),
      'The read_image did nothing: "nf/outdir/a.png" can\'t be reached: "nf/outdir" is a symlink leading outside the mount, which this mount does not follow; '
      + 'followed or not, nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it.');
    assert.equal(await refused(m, 'read_image', { path: 'nf/nodir/a.png' }),
      'The read_image did nothing: "nf/nodir/a.png" can\'t be reached: "nf/nodir" is a symlink that leads nowhere, which this mount does not follow; '
      + 'whoever runs this host can remove it or make it lead to what it stood for.');
    for (const link of ['belowfile', 'loop']) {
      assert.equal(await refused(m, 'read_image', { path: `nf/${link}/a.png` }),
        `The read_image did nothing: "nf/${link}/a.png" can't be reached: "nf/${link}" is a symlink that leads nowhere, which this mount does not follow; `
        + 'whoever runs this host can remove it or make it lead to what it stood for.');
    }
  });
});

describe('a symlink the mount does not follow, read or synced by its own path', () => {
  test('one that leads nowhere, or into a loop, is given the step for that too', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('nf'));
    symlinkSync('nowhere', env.at('nf', 'dang'));
    symlinkSync('loop', env.at('nf', 'loop'));
    const m = await env.open([{ name: 'nf' }]);
    const step = 'whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere';
    for (const link of ['dang', 'loop']) {
      assert.equal(await refused(m, 'read', { path: `nf/${link}` }),
        `The read did nothing: "nf/${link}" isn't in the workspace, and disk couldn't be checked: a symlink, which this mount does not follow. Calling again won't change that; ${step}.`);
      assert.deepEqual(skipped(await ok(m, 'sync', { path: `nf/${link}` })),
        [`disk could not be checked: a symlink, which this mount does not follow — syncing this path again won't change that; ${step}`]);
    }
  });
});

describe('a symlink whose target this process may not search', () => {
  test("isn't called one that leads nowhere", { skip: NO_LINKS || NO_PERMISSIONS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('locked', 'dir'), { recursive: true });
    mkdirSync(env.at('nf'));
    symlinkSync(env.at('locked', 'dir'), env.at('nf', 'l'));
    const m = await env.open([{ name: 'nf' }]);
    chmodSync(env.at('locked'), 0o000);
    let answer: string;
    try {
      answer = await refused(m, 'read_image', { path: 'nf/l/a.png' });
    } finally {
      chmodSync(env.at('locked'), 0o755);
    }
    assert.equal(answer, 'The read_image did nothing: "nf/l/a.png" can\'t be reached: "nf/l" is a symlink, which this mount does not follow; '
      + 'whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere.');
  });
});

describe('a read of a file the workspace doesn\'t hold', () => {
  test('beneath a directory that resolves outside a mount that follows links says nothing done through the mount reaches it, and who can mount it', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('outside'));
    writeFileSync(env.at('outside', 'a.txt'), 'outside');
    mkdirSync(env.at('fl'));
    symlinkSync(env.at('outside'), env.at('fl', 'outdir'));
    const m = await env.open([{ name: 'fl', followSymlinks: true }]);
    assert.equal(await refused(m, 'read', { path: 'fl/outdir/a.txt' }),
      'The read did nothing: "fl/outdir/a.txt" isn\'t in the workspace, and disk couldn\'t be checked: a parent directory resolves outside the mount. '
      + "Calling again won't change that; nothing done through this mount reaches where it resolves, and whoever runs this host can mount that place.");
  });

  test('that another writer replaces while it is read says calling again checks it afresh, and calling again reads it', { skip: process.platform === 'win32' && 'POSIX inodes' }, async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }]);
    writeFileSync(env.at('work', 'c.txt'), 'one');
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: any[]) => Promise<any>>;
    const original = fsp.realpath!;
    let swapped = false;
    fsp.realpath = async (...args: any[]) => {
      const opened = new Error().stack!.includes('openContained');
      const real = await original(...args);
      if (!swapped && opened && String(args[0]).endsWith(`${sep}c.txt`)) {
        swapped = true;
        rmSync(env.at('work', 'c.txt'));
        writeFileSync(env.at('work', 'c.txt'), "another writer's");
      }
      return real;
    };
    syncBuiltinESMExports();
    let answer: string;
    try {
      answer = await refused(m, 'read', { path: 'work/c.txt' });
    } finally {
      fsp.realpath = original;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.equal(answer, 'The read did nothing: "work/c.txt" isn\'t in the workspace, and disk couldn\'t be checked: the file changed while it was read. Calling again checks it afresh.');
    assert.match(JSON.stringify(await ok(m, 'read', { path: 'work/c.txt' })), /another writer's/, 'calling again reads it');
  });

  test('beneath a symlink to a file, or at a symlink to a directory, on a mount that follows links, says what gets past it', { skip: NO_LINKS }, async (t) => {
    const env = new Env(t);
    mkdirSync(env.at('fl', 'real'), { recursive: true });
    writeFileSync(env.at('fl', 'afile'), 'a file');
    symlinkSync(env.at('fl', 'afile'), env.at('fl', 'sub'));
    symlinkSync(env.at('fl', 'real'), env.at('fl', 'ldir.txt'));
    const m = await env.open([{ name: 'fl', followSymlinks: true }]);
    assert.equal(await refused(m, 'read', { path: 'fl/sub/a.txt' }),
      'The read did nothing: "fl/sub/a.txt" isn\'t in the workspace, and disk couldn\'t be checked: beneath a symlink that does not lead to a directory inside the mount. '
      + "Calling again won't change that; nothing beneath it is in this mount, and whoever runs this host can make it lead to a directory inside the mount, or, where it leads to a directory outside, mount that directory.");
    assert.equal(await refused(m, 'read', { path: 'fl/ldir.txt' }),
      'The read did nothing: "fl/ldir.txt" isn\'t in the workspace, and disk couldn\'t be checked: a symlink to a directory, not walked. '
      + "Calling again won't change that; ls of the directory it leads to lists what's in it.");
  });
});

describe('an empty mount or path', () => {
  for (const tool of ['materialize', 'sync'] as const) {
    test(`${tool} refuses "mount": "" and "path": "", quoting the field, and acts on no mount`, async (t) => {
      const env = new Env(t);
      const m = await env.open([{ name: 'one' }, { name: 'two' }]);
      await ok(m, 'write', { path: 'one/a.txt', content: 'a' });
      writeFileSync(env.at('two', 'new.txt'), 'new');
      assert.match(await refused(m, tool, { mount: '' }), new RegExp(`^The ${tool} did nothing: "mount" is "", which is no mount's name; the mounts are "one" and "two"\\.`));
      const every = tool === 'materialize' ? "every mount that takes writes and doesn't already write them straight to disk" : 'every mount';
      assert.equal(await refused(m, tool, { path: '' }), `The ${tool} did nothing: "path" is "", which names no file or directory. Leaving "path" out covers ${every}.`);
      const empty = `The ${tool} did nothing: "path" is "", which names no file or directory.`;
      assert.equal(await refused(m, tool, { path: '', mount: 'one' }), `${empty} Leaving "path" out covers mount "one".`);
      assert.equal(await refused(m, tool, { path: '', mount: '' }), `${empty} "mount" is "" too; leaving both out covers ${every}.`);
      assert.equal(await refused(m, tool, { path: '', mount: 'three' }),
        `${empty} "mount" is "three", which is no mount's name; the mounts are "one" and "two". Leaving both out covers ${every}.`);
      assert.equal(existsSync(env.at('one', 'a.txt')), false, 'nothing was written');
      assert.equal(env.store.treeGet('workspace/two/tree', 'new.txt'), null, 'nothing was taken in');
    });
  }
});
