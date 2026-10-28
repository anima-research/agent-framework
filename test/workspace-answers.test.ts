import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { systemWords } from '../src/modules/workspace/answers.js';
import { linkWords } from '../src/modules/workspace/observe.js';
import { DISK_AGREEMENT_RECORD_TYPE, callGate } from '../src/modules/workspace/disk-agreement.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HOST_LIMIT = "The limit is the mount's maxFileSize setting, which only whoever runs the host can change.";

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-answers-'));
  store = JsStore.openOrCreate({ path: join(this.root, 'ws.chronicle') });
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  dir(name: string): string {
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async open(mounts: Array<Partial<MountConfig> & { name: string }> = [{ name: 'work' }, { name: 'docs', mode: 'read-only' }]): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({
      mounts: mounts.map((mount) => ({ path: this.dir(mount.name), mode: 'read-write', ...(mount.backend === 'direct' ? {} : { watch: 'never' }), ...mount }) as MountConfig),
    });
    m.initStore(this.store);
    await m.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {}, notifyOps: () => {} } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }
}

const call = (m: WorkspaceModule, name: string, input: unknown, callerAgentName = 'resident'): Promise<ToolResult> =>
  m.handleToolCall({ id: name, name, input, callerAgentName } as Parameters<WorkspaceModule['handleToolCall']>[0]);

async function refused(m: WorkspaceModule, name: string, input: unknown, callerAgentName?: string): Promise<string> {
  const result = await call(m, name, input, callerAgentName);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} succeeded: ${JSON.stringify(result.data)}`);
  assert.equal(result.isError, true);
  return result.error!;
}

async function ok(m: WorkspaceModule, name: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)} failed: ${result.error}`);
  return result.data as Record<string, unknown>;
}

// A store error as Chronicle 0.4.0 throws one: a message naming the OS error, and no errno code.
const storeError = (message: string): Error => Object.assign(new Error(message), { code: 'GenericFailure' });
const WIN32 = process.platform === 'win32' && "a store error's OS error is a Win32 code on Windows, which isn't read as an errno";
const MAY_WORK = "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.";
const REOPEN = "The workspace can't check its files against disk until its store is reopened, so calling again won't change that; whoever runs this host can reopen it with a restart.";

describe('an error no handler threw on purpose', () => {
  test('before a change is stored, names the call and its path, says nothing was stored, and gives a store fault in plain words for whoever runs the host', { skip: WIN32 }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.store.storeBlob = () => { throw storeError('IO error: No space left on device (os error 28)'); };
    assert.equal(await refused(m, 'write', { path: 'work/b.txt', content: 'two' }),
      'The write of "work/b.txt" stopped on an error the workspace didn\'t expect, before the write was stored: no space left on the disk. '
      + "Calling again won't change that; whoever runs this host can free space on its disk.");
    assert.equal((await call(m, 'read', { path: 'work/b.txt' })).success, false, 'nothing was stored');
  });

  test("a real store error, from store directories nothing may write, is read for its errno", { skip: WIN32 || (IS_ROOT && 'root writes past directory permissions') }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const dirs = [join(env.root, 'ws.chronicle')];
    for (let i = 0; i < dirs.length; i++) {
      for (const entry of readdirSync(dirs[i], { withFileTypes: true })) if (entry.isDirectory()) dirs.push(join(dirs[i], entry.name));
    }
    for (const dir of dirs) chmodSync(dir, 0o555);
    try {
      assert.equal(await refused(m, 'write', { path: 'work/b.txt', content: `a blob the store doesn't hold yet` }),
        'The write of "work/b.txt" stopped on an error the workspace didn\'t expect, before the write was stored: permission denied. '
        + "Calling again won't change that; whoever runs this host can change the permissions.");
    } finally {
      for (const dir of dirs) chmodSync(dir, 0o755);
    }
    assert.equal((await call(m, 'read', { path: 'work/b.txt' })).success, false, 'nothing was stored');
  });

  test('an errno a second call can get past says so, and who can fix it if not', { skip: WIN32 }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    env.store.storeBlob = () => { throw storeError('IO error: Input/output error (os error 5)'); };
    assert.equal(await refused(m, 'edit', { path: 'work/a.txt', oldString: 'one', newString: 'two' }),
      'The edit of "work/a.txt" stopped on an error the workspace didn\'t expect, before the edit was stored: an input/output error on the disk. '
      + 'Calling again may work; if it fails the same way, whoever runs this host can check the disk.');
    assert.equal(((await call(m, 'read', { path: 'work/a.txt', offsetChars: 0, limitChars: 100 })).structured as { content: string }).content, 'one', 'nothing was stored');
  });

  test('quotes an error without an errno, cut at its bound, and says a second call may get past it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    env.store.storeBlob = () => { throw new Error(`IO error: failed to fill whole buffer ${'x'.repeat(600)}`); };
    const said = `IO error: failed to fill whole buffer ${'x'.repeat(500 - 38)}… (638 characters)`;
    assert.equal(await refused(m, 'edit', { path: 'work/a.txt', oldString: 'one', newString: 'two' }),
      `The edit of "work/a.txt" stopped on an error the workspace didn't expect, before the edit was stored: ${said}. ${MAY_WORK}`);
  });

  test("a call that may have changed files says that isn't known, and how to look", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'work', 'a.txt'), 'one');
    env.store.treeList = () => { throw new Error('IO error: failed to fill whole buffer'); };
    assert.equal(await refused(m, 'sync', { mount: 'work' }),
      'The sync of mount "work" stopped on an error the workspace didn\'t expect: IO error: failed to fill whole buffer. '
      + "Whether it changed anything isn't known: ls with path \"work\" and recursive: true shows how each file there stands against disk now. "
      + MAY_WORK);
  });

  test("a call that changes nothing doesn't say whether it did", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.store.treeList = () => { throw new Error('IO error: failed to fill whole buffer'); };
    assert.equal(await refused(m, 'status', { mount: 'work' }),
      `The status of mount "work" stopped on an error the workspace didn't expect: IO error: failed to fill whole buffer. ${MAY_WORK}`);
  });

  test('an error before a write, edit or delete reaches its change says nothing was stored', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    (m as unknown as { parseFilePath: () => Promise<never> }).parseFilePath = async () => { throw new Error('IO error: failed to fill whole buffer'); };
    for (const [tool, input, done] of [
      ['write', { path: 'work/a.txt', content: 'two' }, 'write'],
      ['edit', { path: 'work/a.txt', oldString: 'one', newString: 'two' }, 'edit'],
      ['delete', { path: 'work/a.txt' }, 'deletion'],
    ] as const) {
      assert.equal(await refused(m, tool, input),
        `The ${tool} of "work/a.txt" stopped on an error the workspace didn't expect, before the ${done} was stored: IO error: failed to fill whole buffer. ${MAY_WORK}`);
    }
    await assert.rejects(m.readFileFromDisk('work/a.txt'), (err: unknown) => err instanceof Error && err.message === 'IO error: failed to fill whole buffer' && !('code' in err));
    delete (m as unknown as Record<string, unknown>).parseFilePath;
    assert.equal(((await call(m, 'read', { path: 'work/a.txt', offsetChars: 0, limitChars: 100 })).structured as { content: string }).content, 'one', 'nothing was stored');
  });

  test("a store error that isn't an I/O failure keeps its words, though it names an OS error", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    env.store.storeBlob = () => { throw storeError('Invalid operation: blob store unusable (os error 2)'); };
    assert.equal(await refused(m, 'write', { path: 'work/b.txt', content: 'two' }),
      `The write of "work/b.txt" stopped on an error the workspace didn't expect, before the write was stored: Invalid operation: blob store unusable (os error 2). ${MAY_WORK}`);
  });

  test("a change stored before its push's append fails inside the store says so, and that only a restart ends the state it leaves", async (t) => {
    const failed = 'The rest of the call failed: IO error: No space left on device (os error 28).';
    const answers: Record<string, string> = {};
    for (const [tool, input] of [
      ['write', { path: 'auto/a.txt', content: 'two' }],
      ['edit', { path: 'auto/a.txt', oldString: 'one', newString: 'two' }],
      ['edit_many', { edits: [{ path: 'auto/a.txt', oldString: 'one', newString: 'two' }] }],
      ['delete', { path: 'auto/a.txt' }],
    ] as const) {
      const env = new Env(t);
      const m = await env.open([{ name: 'auto', autoMaterialize: true }]);
      await ok(m, 'write', { path: 'auto/a.txt', content: 'one' });
      env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
      answers[tool] = await refused(m, tool, input);
    }
    const env = new Env(t);
    const m = await env.open([{ name: 'auto', autoMaterialize: true }]);
    env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
    const binary = await m.writeBinary('auto/b.bin', Buffer.from([0, 1, 2]), 'application/octet-stream');
    assert.equal(binary.error, `Stored "auto/b.bin" in Chronicle, but the rest of the write failed: IO error: No space left on device (os error 28). ${REOPEN}`);
    assert.deepEqual(answers, {
      write: `The write of "auto/a.txt" is stored in the workspace, so don't send it again. ${failed} ${REOPEN}`,
      edit: `The edit of "auto/a.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice. ${failed} ${REOPEN}`,
      edit_many: `Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n${failed} ${REOPEN}`,
      delete: `The deletion of "auto/a.txt" is stored in the workspace, so don't send it again. ${failed} ${REOPEN}`,
    });
  });

  test('an append that fails inside the store says the store must be reopened, and later calls did nothing', { skip: WIN32 }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'work', 'a.txt'), 'one');
    env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
    assert.equal(await refused(m, 'sync', { path: 'work/a.txt' }),
      `The sync of "work/a.txt" stopped on an error the workspace didn't expect: no space left on the disk. ${REOPEN} Whether it changed anything isn't known until then.`);
    assert.match(await refused(m, 'ls', { path: 'work' }), /^The ls did nothing: the workspace can't check its files against disk until its store is reopened/);
  });

  test('the store coming to await its reopening after a materialize wrote to disk says it stopped partway', async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }, { name: 'other' }]);
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    await ok(m, 'write', { path: 'other/b.txt', content: 'two' });
    const agreement = (m as unknown as { agreement: { set: (mount: string, path: string, ...rest: unknown[]) => unknown } }).agreement;
    const set = agreement.set.bind(agreement);
    let latched = false;
    agreement.set = (mount: string, path: string, ...rest: unknown[]) => {
      if (!latched && mount === 'work' && existsSync(join(env.root, 'work', 'a.txt'))) {
        latched = true;
        const append = env.store.appendJson;
        env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
        // Outside the materialize's own context, as another call's append would be.
        callGate.exit(() => assert.throws(() => set('other', 'b.txt', { kind: 'absent' })));
        env.store.appendJson = append;
      }
      return set(mount, path, ...rest);
    };
    const error = await refused(m, 'materialize', { path: 'work/a.txt' });
    assert.equal(latched, true, 'the latch came after the push wrote the file');
    assert.equal(error, 'The materialize of "work/a.txt" stopped partway: the workspace can\'t check its files against disk until its store is reopened: an append to its record of what disk last agreed with failed inside the store, '
      + "so that record may lack what the append held. Calling again won't change that; whoever runs this host can reopen it with a restart. Whether it changed anything before it stopped isn't known until then.");
    assert.equal(existsSync(join(env.root, 'work', 'a.txt')), true, 'the push wrote the file before the refusal');
  });

  test("a change the store recorded before failing, while another call's append left the store awaiting its reopening, says the materialize that writes it works once the store is reopened", async (t) => {
    const latchOnRecord = async () => {
      const env = new Env(t);
      const m = await env.open([{ name: 'auto', autoMaterialize: true }, { name: 'other' }]);
      await ok(m, 'write', { path: 'other/b.txt', content: 'two' });
      const inner = m as unknown as { agreement: { set: (mount: string, path: string, value: unknown) => void }; mounts: Map<string, { treeStateId: string }> };
      const tree = inner.mounts.get('auto')!.treeStateId;
      const treeSet = env.store.treeSet.bind(env.store);
      env.store.treeSet = (...args: Parameters<typeof treeSet>) => {
        const recorded = treeSet(...args);
        if (args[0] !== tree) return recorded;
        const append = env.store.appendJson;
        env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
        callGate.exit(() => assert.throws(() => inner.agreement.set('other', 'b.txt', { kind: 'absent' })));
        env.store.appendJson = append;
        throw storeError('IO error: No space left on device (os error 28)');
      };
      return m;
    };
    const failed = 'failed after recording it: IO error: No space left on device (os error 28).';
    const later = `Its push to disk didn't run, so disk lacks the change until a materialize of the path writes it, once the store is reopened. ${REOPEN}`;
    assert.equal(await refused(await latchOnRecord(), 'write', { path: 'auto/a.txt', content: 'one' }),
      `The write of "auto/a.txt" is stored in the workspace, so don't send it again. The store ${failed} ${later}`);
    assert.equal((await (await latchOnRecord()).writeBinary('auto/b.bin', Buffer.from([0, 1, 2]), 'application/octet-stream')).error,
      `Stored "auto/b.bin" in Chronicle, but the store ${failed} ${later}`);
  });

  test("the store coming to await its reopening while a call reads its path, before the call reaches its change, says the call did nothing", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }, { name: 'other', autoMaterialize: true }]);
    const inner = m as unknown as { parseFilePath: (path: string) => Promise<unknown> };
    const parse = inner.parseFilePath.bind(m);
    let other = '';
    inner.parseFilePath = async (path: string) => {
      const parsed = await parse(path);
      if (path === 'work/a.txt') {
        const append = env.store.appendJson;
        env.store.appendJson = () => { throw storeError('IO error: No space left on device (os error 28)'); };
        other = await refused(m, 'write', { path: 'other/c.txt', content: 'three' });
        env.store.appendJson = append;
      }
      return parsed;
    };
    assert.equal(await refused(m, 'write', { path: 'work/a.txt', content: 'one' }),
      'The write did nothing: the workspace can\'t check its files against disk until its store is reopened: an append to its record of what disk last agreed with failed inside the store, '
      + "so that record may lack what the append held. Calling again won't change that; whoever runs this host can reopen it with a restart.");
    assert.match(other, /^The write of "other\/c\.txt" is stored in the workspace, so don't send it again\./, 'the other call is the one whose append failed');
    const work = (m as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!;
    assert.equal(env.store.treeGet(work.treeStateId, 'a.txt'), null, 'nothing was stored');
    assert.equal(existsSync(join(env.root, 'work', 'a.txt')), false, 'nothing reached disk');
  });
});

describe('a system error with no code', () => {
  test('is quoted, cut at its bound, where an errno would be given in plain words', () => {
    assert.equal(systemWords('EACCES', new Error('EACCES: permission denied, open \'/host/path\'')), 'permission denied');
    assert.equal(systemWords(undefined, new Error('the stat was cut short')), 'the stat was cut short');
    assert.equal(systemWords(undefined, new Error('x'.repeat(600))), `${'x'.repeat(500)}… (600 characters)`);
    assert.equal(linkWords('work', { unsure: 'a', code: 'the readlink was cut short' }, null),
      'cannot tell whether "work/a" is a symlink (the readlink was cut short); calling again checks it afresh; if the same reason comes back, whoever runs this host can fix it on disk');
  });

  test("a read that fails without a code isn't called a pipe, a socket or a device", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'work', 'a.png'), PNG);
    (m as unknown as { openContainedFile: () => Promise<never> }).openContainedFile = async () => {
      throw new WorkspaceReadError('not_found', 'Unable to read file: work/a.png', 'lstat');
    };
    assert.equal(await refused(m, 'read_image', { path: 'work/a.png' }),
      'The read_image did nothing: "work/a.png" can\'t be read from disk: an error the system gave no code for. Calling again may work.');
  });
});

describe('a call the workspace refuses says what it did not do, quotes what it was given, and gives the way on', () => {
  test("a mount's root names no file, for write, read, read_image, delete and writeBinary", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const root = '"work" names the root of mount "work", which isn\'t a file; ls "work" lists the files in it.';
    assert.equal((await m.writeBinary('work', Buffer.from('x'), 'text/plain')).error, root);
    assert.equal(await refused(m, 'write', { path: 'work', content: 'x' }), `The write did nothing: ${root}`);
    assert.equal(await refused(m, 'read', { path: 'work' }), `The read did nothing: ${root}`);
    assert.equal(await refused(m, 'read_image', { path: 'work' }), `The read_image did nothing: ${root}`);
    assert.equal(await refused(m, 'delete', { path: 'work' }), `The delete did nothing: ${root}`);
  });

  test('an unknown tool lists the tools there are', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const error = await refused(m, 'reed', { path: 'work/a.txt' });
    assert.ok(error.startsWith('There\'s no tool "workspace--reed", so nothing ran. The workspace module\'s tools are workspace--read, '), error);
    assert.ok(error.includes('workspace--write') && error.endsWith('workspace--sync.'), error);
  });

  test("a path whose mount doesn't exist says a path starts with its mount's name, names the mounts, and offers the closest", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal(await refused(m, 'read', { path: 'notes/todo.md' }),
      'The read did nothing: "notes/todo.md" starts with "notes", which is no mount\'s name, and a path starts with its mount\'s name; the mounts are "work" and "docs".');
    assert.equal(await refused(m, 'read', { path: 'Work/todo.md' }),
      'The read did nothing: "Work/todo.md" starts with "Work", which is no mount\'s name, and a path starts with its mount\'s name; the mounts are "work" and "docs". Did you mean "work/todo.md"?');
    assert.equal(await refused(m, 'write', { path: '/work/todo.md', content: 'x' }),
      'The write did nothing: "/work/todo.md" starts with "/", and a path starts with its mount\'s name: give "work/todo.md".');
    assert.equal(await refused(m, 'ls', { path: 'Docs' }), 'The ls did nothing: "Docs" is no mount\'s name; the mounts are "work" and "docs". Did you mean "docs"?');
  });

  test('a mount field naming no mount quotes it, names the mounts, and says leaving it out covers them all', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const answer = '"mount" is "Docs", which is no mount\'s name; the mounts are "work" and "docs". Did you mean "docs"? Leaving "mount" out ';
    assert.equal(await refused(m, 'status', { mount: 'Docs' }), `The status did nothing: ${answer}covers every mount.`);
    assert.equal(await refused(m, 'materialize', { mount: 'Docs' }),
      `The materialize did nothing: ${answer}covers every mount that takes writes and doesn't already write them straight to disk.`);
    assert.equal(await refused(m, 'sync', { mount: 'Docs' }), `The sync did nothing: ${answer}covers every mount.`);
  });

  test('a path that climbs out of its mount says how to name a file', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal(await refused(m, 'read', { path: 'work/../secrets.txt' }),
      'The read did nothing: "work/../secrets.txt" climbs above the root of mount "work" with "..", and a path can\'t leave its mount. Name a file from its own mount\'s name; the mounts are "work" and "docs".');
  });

  test('a directory is named a directory, with ls to list it', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    mkdirSync(join(env.root, 'work', 'pics'));
    const dir = '"work/pics" is a directory, not a file; ls "work/pics" lists what\'s in it.';
    assert.equal(await refused(m, 'read', { path: 'work/pics' }), `The read did nothing: ${dir}`);
    assert.equal(await refused(m, 'delete', { path: 'work/pics' }), `The delete did nothing: ${dir}`);
    assert.equal(await refused(m, 'read_image', { path: 'work/pics' }), `The read_image did nothing: ${dir}`);
  });

  test('a missing file says no file is there, with ls and glob to find what is', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    const none = 'there\'s no file at "work/nope.md". ls or glob lists the files that exist.';
    assert.equal(await refused(m, 'read', { path: 'work/nope.md' }), `The read did nothing: ${none}`);
    assert.equal(await refused(m, 'edit', { path: 'work/nope.md', oldString: 'a', newString: 'b' }), `The edit did nothing: ${none}`);
    assert.equal(await refused(m, 'delete', { path: 'work/nope.md' }), `The delete did nothing: ${none}`);
    assert.equal(await refused(m, 'read_image', { path: 'work/nope.md' }), `The read_image did nothing: ${none}`);
  });

  test('a read-only mount says calling again changes nothing, who can, and which mounts take writes', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'docs', 'a.txt'), 'a');
    const readOnly = 'mount "docs" is read-only. Calling again won\'t change that; whoever runs this host can make it read-write. The mounts that take writes are "work".';
    assert.equal(await refused(m, 'write', { path: 'docs/a.txt', content: 'x' }), `The write did nothing: ${readOnly}`);
    assert.equal(await refused(m, 'edit', { path: 'docs/a.txt', oldString: 'a', newString: 'b' }), `The edit did nothing: ${readOnly}`);
    assert.equal(await refused(m, 'delete', { path: 'docs/a.txt' }), `The delete did nothing: ${readOnly}`);
    assert.deepEqual(await m.writeBinary('docs/x.png', PNG, 'image/png'), { success: false, error: readOnly, isError: true });
  });

  test("content over a mount's size limit gives the path, the size, the limit and who sets it", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'small', maxFileSize: 16 }]);
    const over = `"small/a.txt" would be 40 bytes, past the 16-byte limit this mount sets on a file, so the workspace couldn't keep it. Content within the limit is written. ${HOST_LIMIT}`;
    assert.equal(await refused(m, 'write', { path: 'small/a.txt', content: 'x'.repeat(40) }), `The write did nothing: ${over}`);
    assert.deepEqual(await m.writeBinary('small/a.txt', Buffer.alloc(40), 'application/octet-stream'), { success: false, error: over, isError: true });
  });

  test("a generated file says whose it is and what changes it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    m.registerGeneratedTextFile('work/tools.md', () => 'catalogue', 'resident');
    assert.equal(await refused(m, 'reed', { path: 'work/tools.md' }), await refused(m, 'reed', { path: 'work/a.txt' }));
    assert.equal(await refused(m, 'read', { path: 'work/tools.md' }, 'someone-else'),
      'The read did nothing: "work/tools.md" is generated from another agent\'s tool presentation, and only that agent reads it. Calling again won\'t change that.');
    assert.equal(await refused(m, 'write', { path: 'work/tools.md', content: 'x' }),
      'The write did nothing: "work/tools.md" is generated from your tool presentation, so it\'s read-only; set_tool_visibility and set_tool_description change what it shows.');
  });

  test('read_image says what about the file stops it, and what would work', async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }, { name: 'small', maxFileSize: 16 }]);
    const work = join(env.root, 'work');
    writeFileSync(join(work, 'sig.png'), Buffer.concat([PNG.subarray(0, 16), Buffer.alloc(8)]));
    writeFileSync(join(work, 'short.png'), PNG.subarray(0, 4));
    writeFileSync(join(work, 'notes.bmp'), 'text, not an image');
    writeFileSync(join(work, 'empty.png'), '');
    writeFileSync(join(env.root, 'small', 'big.png'), PNG);
    const stays = "Calling again won't change that; only a whole image in its place would.";
    assert.equal(await refused(m, 'read_image', { path: 'work/sig.png' }), `The read_image did nothing: "work/sig.png" starts as a PNG image, but its data doesn't hold together as one. ${stays}`);
    assert.equal(await refused(m, 'read_image', { path: 'work/short.png' }), `The read_image did nothing: "work/short.png" is too short to be an image: it ends inside an image format's signature. ${stays}`);
    assert.equal(await refused(m, 'read_image', { path: 'work/notes.bmp' }), 'The read_image did nothing: "work/notes.bmp" isn\'t a PNG, JPEG, GIF or WebP image, the formats read_image shows. read shows it, if it\'s text.');
    assert.equal(await refused(m, 'read_image', { path: 'work/empty.png' }), `The read_image did nothing: "work/empty.png" is empty, so there's no image in it. ${stays}`);
    assert.equal(await refused(m, 'read_image', { path: 'small/big.png' }),
      `The read_image did nothing: "small/big.png" is ${PNG.length} bytes, past the 16-byte limit this mount sets on a file, so read_image doesn't show it. ${HOST_LIMIT}`);
  });

  test("read_image of a symlink its mount doesn't follow, or one leading out of it", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'work' }, { name: 'follow', followSymlinks: true }]);
    writeFileSync(join(env.dir('outside'), 'o.png'), PNG);
    symlinkSync(join(env.root, 'outside', 'o.png'), join(env.root, 'work', 'link.png'));
    symlinkSync(join(env.root, 'outside', 'o.png'), join(env.root, 'follow', 'out.png'));
    assert.equal(await refused(m, 'read_image', { path: 'work/link.png' }),
      'The read_image did nothing: "work/link.png" is a symlink, and its mount doesn\'t follow symlinks, so the workspace\'s tools don\'t go through it. Calling again won\'t change that; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere.');
    assert.equal(await refused(m, 'read_image', { path: 'follow/out.png' }),
      'The read_image did nothing: "follow/out.png" leads through a symlink to a place outside its mount, so the workspace\'s tools don\'t reach it. Calling again won\'t change that; whoever runs this host can mount it, or a directory that holds it.');
  });

  test('a file disk refuses to read says why in plain words, and who can change it', { skip: IS_ROOT && 'root reads past file modes' }, async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'work', 'locked.png'), PNG);
    writeFileSync(join(env.root, 'work', 'locked.txt'), 'text');
    chmodSync(join(env.root, 'work', 'locked.png'), 0o000);
    chmodSync(join(env.root, 'work', 'locked.txt'), 0o000);
    assert.equal(await refused(m, 'read_image', { path: 'work/locked.png' }),
      'The read_image did nothing: "work/locked.png" can\'t be read from disk: permission denied. Calling again won\'t change that; whoever runs this host can change the permissions.');
    assert.equal(await refused(m, 'read', { path: 'work/locked.txt' }),
      'The read did nothing: "work/locked.txt" isn\'t in the workspace, and disk couldn\'t be checked: cannot open (permission denied). Calling again won\'t change that; whoever runs this host can change the permissions, and a read then reaches it.');
  });

  test("a mount whose directory is gone, or is now a file, says who can put it back", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'gone' }, { name: 'dgone', backend: 'direct' }, { name: 'dfile', backend: 'direct' }]);
    rmSync(join(env.root, 'gone'), { recursive: true });
    rmSync(join(env.root, 'dgone'), { recursive: true });
    rmSync(join(env.root, 'dfile'), { recursive: true });
    writeFileSync(join(env.root, 'dfile'), 'a file where the directory was\n');
    const back = "Calling again won't change that; whoever runs this host can put the mount's directory back at its path.";
    assert.equal(await refused(m, 'read_image', { path: 'gone/a.png' }), `The read_image did nothing: the directory of mount "gone" isn't on disk, so nothing in it can be read. ${back}`);
    assert.equal(await refused(m, 'read', { path: 'dgone/a.txt' }), `The read did nothing: the directory of mount "dgone" isn't on disk, so nothing in it can be read. ${back}`);
    assert.equal(await refused(m, 'read', { path: 'gone/a.txt' }),
      'The read did nothing: "gone/a.txt" isn\'t in the workspace, and disk couldn\'t be checked: the mount root is unavailable. '
      + "Calling again won't change that; whoever runs this host can put the mount's directory back at its path, and a read then reaches it.");
    assert.equal(await refused(m, 'delete', { path: 'dgone/a.txt' }), `The delete did nothing to "dgone/a.txt": the mount root isn't on disk. ${back}`);
    assert.equal(await refused(m, 'write', { path: 'dgone/a.txt', content: 'x' }), `The write did nothing to "dgone/a.txt": the mount root is unavailable. ${back}`);
    assert.equal(await refused(m, 'write', { path: 'dfile/a.txt', content: 'x' }), `The write did nothing to "dfile/a.txt": the mount root is unavailable. ${back}`);
    assert.equal(await refused(m, 'read', { path: 'dfile/a.txt' }), `The read did nothing: the directory of mount "dfile" isn't on disk, so nothing in it can be read. ${back}`);
  });

  test("a mount directory a read, a write or a delete can't check gives its errno's fix where it has one, else says calling again may work and who can check it, and where its path came to name another directory, calling again does", async (t) => {
    const recheck = "Calling again may work; if it fails the same way, whoever runs this host can check the mount's directory and its path.";
    const fsp = createRequire(import.meta.url)('node:fs/promises') as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const realpath = fsp.realpath;
    const repointedDuring = async (env: Env, during: string, act: () => Promise<string>): Promise<string> => {
      let repointed = false;
      fsp.realpath = async (...args: unknown[]) => {
        const got = await realpath(...args);
        if (!repointed && args[0] === join(env.root, 'link') && (new Error().stack ?? '').includes(during)) {
          repointed = true;
          renameSync(join(env.root, 'first'), join(env.root, 'first-old'));
          symlinkSync(join(env.root, 'second'), join(env.root, 'first'));
        }
        return got;
      };
      syncBuiltinESMExports();
      try {
        const answer = await act();
        assert.ok(repointed, `the mount's path came to name another directory during ${during}`);
        return answer;
      } finally {
        fsp.realpath = realpath;
        syncBuiltinESMExports();
      }
    };
    const mount = async (): Promise<{ env: Env; m: WorkspaceModule }> => {
      const env = new Env(t);
      writeFileSync(join(env.dir('first'), 'a.txt'), 'first\n');
      writeFileSync(join(env.dir('second'), 'a.txt'), 'second\n');
      symlinkSync(join(env.root, 'first'), join(env.root, 'link'));
      return { env, m: await env.open([{ name: 'd', path: join(env.root, 'link'), backend: 'direct' }]) };
    };

    const read = await mount();
    assert.equal(await repointedDuring(read.env, 'readRoot', () => refused(read.m, 'read', { path: 'd/a.txt' })),
      `The read did nothing: the directory of mount "d" can't be checked at its path, so nothing in it can be read. ${recheck}`);
    assert.match(JSON.stringify(await ok(read.m, 'read', { path: 'd/a.txt' })), /second/);

    const write = await mount();
    assert.equal(await repointedDuring(write.env, 'diskView', () => refused(write.m, 'write', { path: 'd/a.txt', content: 'new\n' })),
      `The write did nothing to "d/a.txt": the mount root is unavailable. ${recheck}`);
    assert.equal(readFileSync(join(write.env.root, 'second', 'a.txt'), 'utf8'), 'second\n', 'the refused write wrote nothing');
    assert.equal(readFileSync(join(write.env.root, 'first-old', 'a.txt'), 'utf8'), 'first\n', 'the refused write wrote nothing');
    await ok(write.m, 'write', { path: 'd/a.txt', content: 'new\n' });
    assert.equal(readFileSync(join(write.env.root, 'second', 'a.txt'), 'utf8'), 'new\n');

    const stale = await mount();
    fsp.realpath = async (...args: unknown[]) => {
      if (args[0] === join(stale.env.root, 'link')) throw Object.assign(new Error('injected'), { code: 'ESTALE' });
      return realpath(...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(await refused(stale.m, 'read', { path: 'd/a.txt' }),
        `The read did nothing: the directory of mount "d" can't be read: a stale network file handle. ${recheck}`);
      assert.equal(await refused(stale.m, 'write', { path: 'd/a.txt', content: 'new\n' }),
        `The write did nothing to "d/a.txt": cannot resolve the directory (a stale network file handle). ${recheck}`);
    } finally {
      fsp.realpath = realpath;
      syncBuiltinESMExports();
    }

    const denied = await mount();
    fsp.realpath = async (...args: unknown[]) => {
      if (args[0] === join(denied.env.root, 'link')) throw Object.assign(new Error('injected'), { code: 'EACCES' });
      return realpath(...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(await refused(denied.m, 'write', { path: 'd/a.txt', content: 'new\n' }),
        'The write did nothing to "d/a.txt": cannot resolve the directory (permission denied). Calling again won\'t change that; whoever runs this host can change the permissions.');
    } finally {
      fsp.realpath = realpath;
      syncBuiltinESMExports();
    }

    const staleStat = await mount();
    const stat = fsp.stat;
    const rootReal = realpathSync(join(staleStat.env.root, 'first'));
    fsp.stat = async (...args: unknown[]) => {
      if (args[0] === rootReal && (args[1] as { bigint?: boolean } | undefined)?.bigint === true) throw Object.assign(new Error('injected'), { code: 'ESTALE' });
      return stat(...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(await refused(staleStat.m, 'delete', { path: 'd/a.txt' }),
        `The delete did nothing to "d/a.txt": the mount root can't be read: a stale network file handle. ${recheck}`);
    } finally {
      fsp.stat = stat;
      syncBuiltinESMExports();
    }
    assert.equal(readFileSync(join(staleStat.env.root, 'first', 'a.txt'), 'utf8'), 'first\n');
  });

  test("a disk read while the store holds no whole record of what disk agreed says nothing helps until the store is reopened, even with its mount directory gone, and a host's read is refused at the root's stage with what is at its path", async (t) => {
    const env = new Env(t);
    const store = env.store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
    const append = store.appendJson;
    store.appendJson = function (this: unknown, type: string, payload: unknown) {
      if (type === DISK_AGREEMENT_RECORD_TYPE) throw new Error('injected: the store refused the append');
      return append.call(this, type, payload);
    };
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: env.dir('work'), mode: 'read-write', watch: 'never' }] });
    try {
      assert.throws(() => m.initStore(env.store), /injected/);
    } finally {
      store.appendJson = append;
    }
    rmSync(join(env.root, 'work'), { recursive: true });
    assert.equal(await refused(m, 'read_image', { path: 'work/a.png' }),
      "The read_image did nothing: the workspace can't check its files against disk until its store is reopened: an append to its record of what disk last agreed with failed inside the store, "
      + "so that record may lack what the append held. Calling again won't change that; whoever runs this host can reopen it with a restart.");
    await assert.rejects(m.readFileFromDisk('work/a.txt'), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError);
      assert.equal(err.code, 'mount_unavailable');
      assert.equal(err.stage, 'root');
      assert.equal(err.errno, 'ENOENT');
      assert.match(err.message, /^Mount unavailable: work: the workspace can't check its files against disk until its store is reopened: /);
      return true;
    });
  });

  test("a file on disk the workspace doesn't store says why, and what reads it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    writeFileSync(join(env.root, 'work', 'data.bin'), Buffer.from([0, 1, 2, 0xff]));
    writeFileSync(join(env.root, 'work', 'shot.png'), PNG);
    const notStored = (path: string) => `"${path}" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit.`;
    const only = "read, edit and delete act only on the files it stores, so calling again won't change that";
    assert.equal(await refused(m, 'read', { path: 'work/data.bin' }), `The read did nothing: ${notStored('work/data.bin')} ${only}.`);
    assert.equal(await refused(m, 'edit', { path: 'work/data.bin', oldString: 'a', newString: 'b' }), `The edit did nothing: ${notStored('work/data.bin')} ${only}.`);
    assert.equal(await refused(m, 'delete', { path: 'work/data.bin' }), `The delete did nothing: ${notStored('work/data.bin')} ${only}.`);
    assert.equal(await refused(m, 'read', { path: 'work/shot.png' }),
      `The read did nothing: ${notStored('work/shot.png')} ${only}; read_image shows it, if its data holds together as an image.`);
    assert.equal((await call(m, 'read_image', { path: 'work/shot.png' })).success, true, 'read_image shows it');
    const small = await env.open([{ name: 'small', maxFileSize: 16 }]);
    writeFileSync(join(env.root, 'small', 'shot.png'), PNG);
    assert.equal(await refused(small, 'read', { path: 'small/shot.png' }), `The read did nothing: ${notStored('small/shot.png')} ${only}.`);
  });

  test("a followed symlink that leads nowhere or out of the mount says what it is", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'follow', followSymlinks: true }]);
    symlinkSync(join(env.root, 'nowhere.txt'), join(env.root, 'follow', 'dangling.txt'));
    writeFileSync(join(env.dir('outside'), 'o.txt'), 'outside');
    symlinkSync(join(env.root, 'outside', 'o.txt'), join(env.root, 'follow', 'out.txt'));
    assert.equal(await refused(m, 'read', { path: 'follow/dangling.txt' }),
      'The read did nothing: "follow/dangling.txt" isn\'t in the workspace, and disk couldn\'t be checked: a symlink whose target cannot be read (nothing is there). Calling again checks it afresh; if the same reason comes back, whoever runs this host can fix it on disk.');
    assert.equal(await refused(m, 'read', { path: 'follow/out.txt' }),
      'The read did nothing: "follow/out.txt" isn\'t in the workspace, and disk couldn\'t be checked: a symlink that leaves the mount. Calling again won\'t change that; nothing done through this mount reaches what it leads to, and whoever runs this host can mount it, or a directory that holds it.');
  });

  test('a direct mount says what stops a write or an edit, and the way on', async (t) => {
    const env = new Env(t);
    const ref = env.dir('dref');
    writeFileSync(join(ref, 'a.txt'), 'one two');
    writeFileSync(join(ref, 'bin.dat'), Buffer.from([0, 1, 2, 0xff]));
    mkdirSync(join(ref, 'sub'));
    const m = await env.open([{ name: 'dref', backend: 'direct' }, { name: 'dsmall', backend: 'direct', path: ref, maxFileSize: 4 }]);
    assert.equal(await refused(m, 'write', { path: 'dref/sub', content: 'x' }),
      'The write did nothing to "dref/sub": a directory. A file can\'t be written over a directory; give another path.');
    assert.equal(await refused(m, 'edit', { path: 'dref/bin.dat', oldString: 'a', newString: 'b' }),
      'The edit did nothing: "dref/bin.dat" is binary, so the workspace doesn\'t edit it as text. A write replaces the whole file, if that\'s what you mean to do.');
    assert.equal(await refused(m, 'edit', { path: 'dsmall/a.txt', oldString: 'one', newString: 'three' }),
      `The edit did nothing: "dsmall/a.txt" is 7 bytes, past the 4-byte limit this mount sets on a file, so the workspace doesn't edit it. ${HOST_LIMIT}`);
  });

  test("a direct write its directory refuses gives the errno in plain words, and who can change it", { skip: IS_ROOT && 'root writes past directory modes' }, async (t) => {
    const env = new Env(t);
    const ref = env.dir('dref');
    mkdirSync(join(ref, 'sub'));
    const m = await env.open([{ name: 'dref', backend: 'direct' }]);
    chmodSync(join(ref, 'sub'), 0o555);
    assert.equal(await refused(m, 'write', { path: 'dref/sub/n.txt', content: 'x' }),
      'The write did nothing to "dref/sub/n.txt": cannot make the staged file in its directory (permission denied): a direct write needs to write the file\'s directory as well as the file. '
      + "Calling again won't change that; whoever runs this host can change the permissions.");
    assert.equal(await refused(m, 'write', { path: 'dref/sub/new/n.txt', content: 'x' }),
      'The write did nothing to "dref/sub/new/n.txt": cannot create the directory sub/new (permission denied). '
      + "Calling again won't change that; whoever runs this host can change the permissions.");
    writeFileSync(join(ref, 'f.txt'), 'a file');
    assert.equal(await refused(m, 'write', { path: 'dref/f.txt/n.txt', content: 'x' }),
      'The write did nothing to "dref/f.txt/n.txt": a parent path is not a directory. Calling again won\'t change that while something other than a directory stands where the path needs one; another path, or removing what stands there, would.');
    assert.equal(await refused(m, 'write', { path: `dref/${'n'.repeat(300)}.txt`, content: 'x' }),
      `The write did nothing to "dref/${'n'.repeat(300)}.txt": cannot stat the file (a name too long for the filesystem). Calling again won't change that; a shorter name would.`);
  });

  test("readBinary gives a file neither the workspace nor disk has in readFileFromDisk's words, so a host can tell they're one reason", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.deepEqual(await m.readBinary('work/none.txt'), { error: 'File not found: work/none.txt' });
    await assert.rejects(m.readFileFromDisk('work/none.txt'), { message: 'File not found: work/none.txt' });
  });

  test('read paging that can\'t be honoured says which values work', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/a.txt', content: 'ab😀cd' });
    assert.equal(await refused(m, 'read', { path: 'work/a.txt', offset: 1, offsetChars: 0 }),
      'The read did nothing: it was given both "offset"/"limit", which page by lines, and "offsetChars"/"limitChars", which page by characters. Give one pair.');
    assert.equal(await refused(m, 'read', { path: 'work/a.txt', offsetChars: 3 }),
      'The read did nothing: "offsetChars" 3 falls between the two halves of a surrogate pair, one character in UTF-16. Give 2 or 4; a page\'s nextOffsetChars never splits one.');
  });

  test("grep's pattern that isn't a regular expression says why and how to match a character as itself", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal(await refused(m, 'grep', { pattern: 'foo(' }),
      'The grep did nothing: "pattern" "foo(" isn\'t a valid regular expression (Unterminated group). To match a character such as "(", "[" or "*" as itself, put "\\" before it.');
  });

  test('acceptRoot with a path says which field it takes', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    assert.equal(await refused(m, 'sync', { path: 'work/a.txt', acceptRoot: true }),
      'The sync did nothing: acceptRoot takes a whole mount\'s root, so it isn\'t given with "path" ("work/a.txt"). Give "mount" ("work") with acceptRoot to take that mount\'s root, or leave acceptRoot out to sync the path.');
    assert.equal(await refused(m, 'sync', { path: '/work/a.txt', acceptRoot: true }),
      'The sync did nothing: acceptRoot takes a whole mount\'s root, so it isn\'t given with "path" ("/work/a.txt"). Give "mount", naming the mount whose root to take, with acceptRoot, or leave acceptRoot out to sync the path.');
  });
});

describe('what the answers say elsewhere', () => {
  test("grep's skipped conflict whose disk version was never stored says how to settle it", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/bin.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/bin.txt' });
    await ok(m, 'write', { path: 'work/bin.txt', content: 'two' });
    writeFileSync(join(env.root, 'work', 'bin.txt'), Buffer.from([0, 1, 2, 3, 0xff]));
    await ok(m, 'materialize', { path: 'work/bin.txt' });
    const result = await call(m, 'grep', { pattern: 'two', path: 'work/bin.txt' });
    assert.equal(result.success, true);
    const text = (result.data as Array<{ text: string }>)[0]!.text;
    assert.ok(text.includes("work/bin.txt: conflict: the disk version is binary or over the size limit, so the workspace never stored it, and grep searches only what it stores; "
      + "sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's (5 bytes)"), text);
  });

  test("grep's skipped conflict on a read-only mount offers no materialize", async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/bin.txt', content: 'one' });
    await ok(m, 'materialize', { path: 'work/bin.txt' });
    await ok(m, 'write', { path: 'work/bin.txt', content: 'two' });
    writeFileSync(join(env.root, 'work', 'bin.txt'), Buffer.from([0, 1, 2, 3, 0xff]));
    await ok(m, 'materialize', { path: 'work/bin.txt' });
    await m.stop();
    const ro = await env.open([{ name: 'work', mode: 'read-only' }]);
    const result = await call(ro, 'grep', { pattern: 'two', path: 'work/bin.txt' });
    assert.equal(result.success, true, result.error);
    const text = (result.data as Array<{ text: string }>)[0]!.text;
    assert.ok(text.includes("grep searches only what it stores; sync the path to keep disk's copy and give up the workspace's. "
      + "The mount is read-only, so nothing writes the workspace's copy to disk (5 bytes)"), text);
  });

  test("the wake notice's conflicts line says how to settle them", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'auto', wakeOnChange: true }]);
    const response = await m.onProcess({ type: 'workspace:modified', mount: 'auto', paths: ['auto/a.txt'], conflicts: ['auto/a.txt'] } as unknown as ProcessEvent, {} as never);
    const text = (response.addMessages![0]!.content[0] as { text: string }).text;
    assert.equal(text, '[workspace event · modified · auto/a.txt]\n[conflicts with disk: auto/a.txt; reading each shows how to settle it]');
  });

  test('ls of a missing path or of a file, and materialize or sync of a path held nowhere, say so in a note', async (t) => {
    const env = new Env(t);
    const m = await env.open();
    await ok(m, 'write', { path: 'work/a.txt', content: 'one' });
    assert.equal((await ok(m, 'ls', { path: 'work/nowhere' })).note, '"work/nowhere" isn\'t a directory in the workspace or on disk, so there\'s nothing to list.');
    assert.equal((await ok(m, 'ls', { path: 'work/a.txt' })).note, `"work/a.txt" is a file, not a directory, so there's nothing in it to list.`);
    assert.equal((await ok(m, 'materialize', { path: 'work/never.txt' })).note, 'The workspace holds nothing at "work/never.txt", so there was nothing to write there.');
    assert.equal((await ok(m, 'sync', { path: 'work/never.txt' })).note, 'Neither the workspace nor disk has anything at "work/never.txt", so there was nothing to sync.');
    mkdirSync(join(env.root, 'work', 'empty'));
    assert.equal((await ok(m, 'ls', { path: 'work/empty' })).note, undefined, 'an empty directory is an answer');
  });
});

describe('false texts', () => {
  test("a forced push to a followed symlink that leads nowhere says that, not that something appeared", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'follow', followSymlinks: true }]);
    await ok(m, 'write', { path: 'follow/dl.txt', content: 'one' });
    symlinkSync(join(env.root, 'nowhere.txt'), join(env.root, 'follow', 'dl.txt'));
    const data = await ok(m, 'materialize', { path: 'follow/dl.txt', force: true });
    assert.deepEqual(data.skipped, [{
      mount: 'follow',
      reason: 'dl.txt: not written: a symlink that leads nowhere is at this path, and a push makes a file only where nothing is, forced or not; '
        + 'whoever runs this host can remove the link, and materializing again then gets past it',
    }]);
  });

  test("a materialize held back by a diverged branch names what judges the branch, and ls shows it", async (t) => {
    const env = new Env(t);
    const m = await env.open([{ name: 'pin' }]);
    await ok(m, 'write', { path: 'pin/a.txt', content: 'one' });
    await ok(m, 'materialize', {});
    const forkAt = env.store.currentSequence();
    await ok(m, 'write', { path: 'pin/b.txt', content: 'two' });
    await ok(m, 'materialize', {});
    env.store.createBranchAt('earlier', env.store.currentBranch().name, forkAt);
    env.store.switchBranch('earlier');
    await ok(m, 'write', { path: 'pin/c.txt', content: 'three' });
    const error = await refused(m, 'materialize', {});
    assert.match(error, /^The materialize did nothing: mount "pin": current branch "earlier" has diverged from the branch last materialized to disk \("main" at seq \d+\) — disk may hold state the current branch never had\. ls with path "pin" and recursive: true shows how each file of the current branch stands against disk; if the current branch is what disk should hold, pass force: true to overwrite disk from it\.$/);
    const listed = (await ok(m, 'ls', { path: 'pin', recursive: true })).entries as Array<{ path: string; state: string }>;
    assert.deepEqual(listed.map(({ path, state }) => [path, state]), [['a.txt', 'synced'], ['b.txt', 'not-in-branch'], ['c.txt', 'workspace-draft']]);
  });
});
