import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ToolResult } from '../src/types/events.js';

const TREE = 'workspace/work/tree';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

type Alert = { kind: string; agent: string; message: string; data?: Record<string, unknown> };

class Env {
  readonly root = mkdtempSync(join(tmpdir(), 'af-ws-lost-'));
  readonly dir = join(this.root, 'work');
  readonly outside = join(this.root, 'outside');
  readonly storePath = join(this.root, 'ws.chronicle');
  store: JsStore;
  alerts: Alert[] = [];
  private live: WorkspaceModule[] = [];

  constructor(t: TestContext) {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.outside, { recursive: true });
    this.store = JsStore.openOrCreate({ path: this.storePath });
    t.after(async () => {
      for (const m of this.live) await m.stop().catch(() => {});
      if (!this.store.isClosed()) this.store.close();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  async open(mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    const m = new WorkspaceModule({ mounts: [{ name: 'work', path: this.dir, mode: 'read-write', watch: 'never', ...mount }] });
    m.initStore(this.store);
    await m.start({
      isRestart: false,
      getState: () => null,
      setState: () => {},
      pushEvent: () => {},
      notifyOps: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => this.alerts.push({ kind, agent, message, data }),
    } as unknown as ModuleContext);
    this.live.push(m);
    return m;
  }

  async restartAfter(m: WorkspaceModule, change: (blobFile: (hash: string) => string) => void, mount: Partial<MountConfig> = {}): Promise<WorkspaceModule> {
    await m.stop();
    this.live = this.live.filter((x) => x !== m);
    this.store.close();
    change((hash) => join(this.storePath, 'blobs', hash.slice(0, 2), hash));
    this.store = JsStore.openOrCreate({ path: this.storePath });
    return this.open(mount);
  }

  lose(m: WorkspaceModule, ...hashes: string[]): Promise<WorkspaceModule> {
    return this.restartAfter(m, (blobFile) => {
      for (const hash of hashes) rmSync(blobFile(hash));
    });
  }

  damage(m: WorkspaceModule, ...hashes: string[]): Promise<WorkspaceModule> {
    return this.restartAfter(m, (blobFile) => {
      for (const hash of hashes) writeFileSync(blobFile(hash), readFileSync(blobFile(hash)).subarray(0, -6));
    });
  }

  hashOf(path: string): string {
    return this.store.treeGet(TREE, path)!.blobHash;
  }

  storedText(hash: string): string | null {
    return this.store.getBlob(hash)?.toString('utf8') ?? null;
  }

  writeDisk(path: string, content: string | Buffer): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  readDisk(path: string): string {
    return readFileSync(join(this.dir, path), 'utf8');
  }

  kinds(): string[] {
    return this.alerts.map((a) => a.kind);
  }
}

async function call(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return m.handleToolCall({ id: 't', name, input });
}

async function ok(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<any> {
  const result = await call(m, name, input);
  assert.equal(result.success, true, `${name} ${JSON.stringify(input)} failed: ${result.error}`);
  return result.structured ?? result.data;
}

async function refused(m: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<string> {
  const result = await call(m, name, input);
  assert.equal(result.success, false, `${name} ${JSON.stringify(input)} unexpectedly succeeded`);
  return String(result.error);
}

async function textOf(m: WorkspaceModule, path: string): Promise<string> {
  return (await ok(m, 'read', { path, offsetChars: 0, limitChars: 1_000_000 })).content as string;
}

async function synced(env: Env, m: WorkspaceModule, path: string, content: string): Promise<string> {
  await ok(m, 'write', { path: `work/${path}`, content });
  await ok(m, 'materialize', { path: `work/${path}` });
  assert.equal(env.readDisk(path), content);
  return env.hashOf(path);
}

async function draft(env: Env, m: WorkspaceModule, path: string, disk: string, content: string): Promise<string> {
  await synced(env, m, path, disk);
  await ok(m, 'write', { path: `work/${path}`, content });
  assert.equal(env.readDisk(path), disk);
  return env.hashOf(path);
}

describe('contents the store lost, where disk holds the same bytes', () => {
  test('read answers with them, the store holds them again, and whoever runs the host is told once', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\nneedle\n');
    m = await env.lose(m, hash);
    assert.equal(env.store.getBlob(hash), null);

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\nneedle\n');
    assert.equal(env.storedText(hash), 'alpha\nneedle\n');
    assert.deepEqual(env.alerts.map(({ kind, agent, data }) => ({ kind, agent, data })), [
      { kind: 'workspace-contents-restored', agent: 'workspace', data: { mount: 'work', path: 'work/a.txt', blobHash: hash } },
    ]);
    assert.match(env.alerts[0]!.message, /work\/a\.txt.*missing.*stored again from disk's copy/);

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\nneedle\n');
    assert.equal(env.alerts.length, 1, 'contents back in the store need no restore');
  });

  test('edit and edit_many make their edits to them', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await synced(env, m, 'a.txt', 'alpha\n');
    const b = await synced(env, m, 'b.txt', 'beta\n');
    const c = await synced(env, m, 'c.txt', 'gamma\n');
    m = await env.lose(m, a, b, c);

    await ok(m, 'edit', { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' });
    await ok(m, 'edit_many', {
      edits: [
        { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
        { path: 'work/c.txt', oldString: 'gamma', newString: 'GAMMA' },
      ],
    });
    assert.equal(await textOf(m, 'work/a.txt'), 'ALPHA\n');
    assert.equal(await textOf(m, 'work/b.txt'), 'BETA\n');
    assert.equal(await textOf(m, 'work/c.txt'), 'GAMMA\n');
    await ok(m, 'materialize', { path: 'work' });
    assert.deepEqual(['a.txt', 'b.txt', 'c.txt'].map((p) => env.readDisk(p)), ['ALPHA\n', 'BETA\n', 'GAMMA\n']);
    assert.deepEqual(env.kinds(), ['workspace-contents-restored', 'workspace-contents-restored', 'workspace-contents-restored']);
  });

  test('grep searches them, in path order among the files around them', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await synced(env, m, 'a.txt', 'needle a\n');
    const b = await synced(env, m, 'b.txt', 'needle b\n');
    await synced(env, m, 'c.txt', 'needle c\n');
    m = await env.lose(m, b);

    const found = await ok(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt', 'work/c.txt']);
    assert.equal(found.skipped, undefined);
    assert.equal(env.storedText(b), 'needle b\n');
  });

  test('read_image and readBinary answer with them', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    const png = env.hashOf('p.png');
    const text = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.lose(m, png, text);

    const image = await ok(m, 'read_image', { path: 'work/p.png' });
    assert.deepEqual(Buffer.from(image.find((b: { type: string }) => b.type === 'image').data, 'base64'), PNG);
    assert.equal(image.find((b: { type: string }) => b.type === 'text').text, `Path: work/p.png\nMIME: image/png\nBytes: ${PNG.byteLength}`);
    const read = await m.readBinary('work/a.txt');
    assert.ok('data' in read, JSON.stringify(read));
    assert.equal(read.data.toString(), 'alpha\n');
    assert.deepEqual(env.store.getBlob(png), PNG);
  });

  test('contents the store took though its write then failed are told as restored', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.lose(m, hash);
    const store = env.store as unknown as { storeBlob: (content: Buffer, type: string) => string };
    const storeBlob = store.storeBlob.bind(env.store);
    store.storeBlob = (content, type) => {
      storeBlob(content, type);
      throw new Error('fsync failed after the write');
    };

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.storedText(hash), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-restored']);
  });

  test('a store write that fails is told, and the read answers from disk', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.lose(m, hash);
    const store = env.store as unknown as { storeBlob: (content: Buffer, type: string) => string };
    store.storeBlob = () => {
      throw new Error('No space left on device');
    };

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.store.getBlob(hash), null);
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored']);
    assert.equal(env.alerts[0]!.data!.unstored, 'No space left on device');
  });

  test("a copy disk holds only through a link the mount doesn't follow isn't taken", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'alpha\n');
    m = await env.lose(m, hash);
    writeFileSync(join(env.outside, 'a.txt'), 'alpha\n');
    rmSync(join(env.dir, 'a.txt'));
    symlinkSync(join(env.outside, 'a.txt'), join(env.dir, 'a.txt'));

    const error = await refused(m, 'read', { path: 'work/a.txt' });
    assert.equal(error, "The workspace's copy of work/a.txt is missing from the store, and disk's copy can't be read (Symlinks are not allowed: work/a.txt), so it can't be restored or read. Write the file again, or delete it.");
    assert.equal(env.store.getBlob(hash), null);
    assert.deepEqual(env.kinds(), ['workspace-contents-lost']);

    await ok(m, 'write', { path: 'work/a.txt', content: 'alpha again\n' });
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha again\n');
  });

  test("on a read-only mount, the answer asks for a change on disk rather than a write, and once disk's copy can be read a read restores it", async (t) => {
    const env = new Env(t);
    let m = await env.open({ mode: 'read-only' });
    env.writeDisk('a.txt', 'alpha\n');
    await ok(m, 'ls', { path: 'work' });
    const hash = env.hashOf('a.txt');
    m = await env.restartAfter(m, (blobFile) => rmSync(blobFile(hash)), { mode: 'read-only' });
    writeFileSync(join(env.outside, 'a.txt'), 'alpha\n');
    rmSync(join(env.dir, 'a.txt'));
    symlinkSync(join(env.outside, 'a.txt'), join(env.dir, 'a.txt'));

    assert.equal(await refused(m, 'read', { path: 'work/a.txt' }),
      "The workspace's copy of work/a.txt is missing from the store, and disk's copy can't be read (Symlinks are not allowed: work/a.txt), so it can't be restored or read. "
        + "Only a change on disk can end this: once disk's copy can be read, read the file again, which restores it from a copy with the same contents, or sync the path to keep disk's copy and give up the workspace's.");
    rmSync(join(env.dir, 'a.txt'));
    env.writeDisk('a.txt', 'alpha\n');
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.storedText(hash), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-lost', 'workspace-contents-restored']);
  });

  test('grep searches contents two files share once either restores them, whichever comes first', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'other\n', 'needle\n');
    assert.equal(await synced(env, m, 'b.txt', 'needle\n'), hash);
    m = await env.lose(m, hash);

    const found = await ok(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt']);
    assert.equal(found.skipped, undefined);
    assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [
      ['workspace-contents-lost', 'work/a.txt'],
      ['workspace-contents-restored', 'work/b.txt'],
    ]);
  });

  test("edit_many that restores one file still says what it took in from disk for another", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await synced(env, m, 'a.txt', 'alpha\n');
    await synced(env, m, 'b.txt', 'beta\n');
    m = await env.lose(m, a);
    env.writeDisk('b.txt', 'beta, from disk\n');

    const result = await call(m, 'edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
      ],
    });
    assert.equal(result.success, true, result.error);
    assert.match(JSON.stringify(result.data), /Disk's copy of work\/b\.txt had changed since the workspace last agreed with it, so it was taken in first, and edit 2 applied to that text\./);
    assert.equal(await textOf(m, 'work/a.txt'), 'ALPHA\n');
    assert.equal(await textOf(m, 'work/b.txt'), 'BETA, from disk\n');
  });

  test('two reads restoring the same contents at once both answer, and whoever runs the host is told once', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    m = await env.lose(m, env.hashOf('p.png'));

    const images = await Promise.all([ok(m, 'read_image', { path: 'work/p.png' }), ok(m, 'read_image', { path: 'work/p.png' })]);
    for (const image of images) assert.deepEqual(Buffer.from(image.find((b: { type: string }) => b.type === 'image').data, 'base64'), PNG);
    assert.deepEqual(env.kinds(), ['workspace-contents-restored']);
  });
});

describe('contents the store lost, where disk holds no copy of them', () => {
  test('a lost draft: read says disk holds other contents, nothing is stored for them, and a sync takes disk\'s copy in their place', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    m = await env.lose(m, hash);

    assert.equal(await refused(m, 'read', { path: 'work/a.txt' }),
      "The workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored or read. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    assert.equal(env.store.getBlob(hash), null);
    assert.equal(env.store.getBlob(sha('v1\n'))?.toString(), 'v1\n', "disk's own text is the version it was synced at");
    assert.deepEqual(env.alerts.map(({ kind, data }) => ({ kind, data })), [
      { kind: 'workspace-contents-lost', data: { mount: 'work', path: 'work/a.txt', blobHash: hash } },
    ]);

    await ok(m, 'sync', { path: 'work/a.txt' });
    assert.equal(await textOf(m, 'work/a.txt'), 'v1\n');
  });

  test('a lost draft: edit refuses it, and writing the file again replaces it', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    m = await env.lose(m, hash);

    assert.equal(await refused(m, 'edit', { path: 'work/a.txt', oldString: 'draft', newString: 'DRAFT' }),
      "The workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and the edit changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    await ok(m, 'write', { path: 'work/a.txt', content: 'v3\n' });
    assert.equal(await textOf(m, 'work/a.txt'), 'v3\n');
  });

  test('a conflict whose workspace copy is lost: a sync takes the copy disk holds now', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, the workspace\n');
    env.writeDisk('a.txt', 'v3, disk\n');
    m = await env.lose(m, hash);

    assert.equal(await refused(m, 'read', { path: 'work/a.txt' }),
      "The workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored or read. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    assert.equal(await refused(m, 'edit', { path: 'work/a.txt', oldString: 'v2', newString: 'V2' }),
      "The workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and the edit changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    await ok(m, 'sync', { path: 'work/a.txt' });
    assert.equal(await textOf(m, 'work/a.txt'), 'v3, disk\n');
  });

  test('disk has no copy: read says so, and deleting the file or writing it again settles it', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await draft(env, m, 'a.txt', 'v1\n', 'a draft\n');
    const b = await draft(env, m, 'b.txt', 'v1\n', 'b draft\n');
    rmSync(join(env.dir, 'a.txt'));
    rmSync(join(env.dir, 'b.txt'));
    m = await env.lose(m, a, b);

    for (const path of ['work/a.txt', 'work/b.txt']) {
      assert.equal(await refused(m, 'read', { path }),
        `The workspace's copy of ${path} is missing from the store, and disk has no copy, so it can't be restored or read. Write the file again, or delete it.`);
    }
    await ok(m, 'delete', { path: 'work/a.txt' });
    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /^File not found/);
    await ok(m, 'write', { path: 'work/b.txt', content: 'b again\n' });
    assert.equal(await textOf(m, 'work/b.txt'), 'b again\n');
  });

  test('edit_many refuses a file whose contents are lost, and stores none of its edits', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await synced(env, m, 'a.txt', 'alpha\n');
    const b = await draft(env, m, 'b.txt', 'beta\n', 'beta, a draft\n');
    m = await env.lose(m, b);

    assert.equal(await refused(m, 'edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
      ],
    }), "The edit_many call stored none of its edits: 1 problem.\n\nedit 2: The workspace's copy of work/b.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and edit 2 changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(await refused(m, 'edit', { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' }),
      "The workspace's copy of work/b.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and the edit changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
  });

  test('grep lists it as not searched, saying why', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'needle in a draft\n');
    m = await env.lose(m, hash);

    const found = await ok(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(found.results, []);
    assert.deepEqual(found.skipped, [
      { file: 'work/a.txt', reason: "the workspace's copy is missing from the store, and disk's copy holds other contents, so it was not searched" },
    ]);
  });

  test("read_image serves disk's other image saying whose it is, and with none on disk says the copy is lost", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    assert.equal((await m.writeBinary('work/q.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/q.png' });
    m = await env.lose(m, env.hashOf('p.png'));
    env.writeDisk('p.png', GIF);
    rmSync(join(env.dir, 'q.png'));

    const image = await ok(m, 'read_image', { path: 'work/p.png' });
    assert.deepEqual(Buffer.from(image.find((b: { type: string }) => b.type === 'image').data, 'base64'), GIF);
    assert.equal(image.find((b: { type: string }) => b.type === 'text').text,
      `Path: work/p.png\nMIME: image/gif\nBytes: ${GIF.byteLength}\nThe workspace's copy of work/p.png is missing from the store, so this is disk's copy, which holds other contents.`);
    assert.equal(await refused(m, 'read_image', { path: 'work/q.png' }),
      "The workspace's copy of work/q.png is missing from the store, and disk has no copy, so it can't be restored or read. Write the file again, or delete it.");
  });
  test("edit_many tells each file's own state when files share contents the store lost", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'the same draft\n');
    assert.equal(await draft(env, m, 'b.txt', 'v1\n', 'the same draft\n'), hash);
    rmSync(join(env.dir, 'b.txt'));
    m = await env.lose(m, hash);

    assert.equal(await refused(m, 'edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'same', newString: 'SAME' },
        { path: 'work/b.txt', oldString: 'same', newString: 'SAME' },
      ],
    }), 'The edit_many call stored none of its edits: 2 problems.\n\n'
      + "edit 1: The workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and edit 1 changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.\n\n"
      + "edit 2: The workspace's copy of work/b.txt is missing from the store, and disk has no copy, so it can't be restored, and edit 2 changed nothing. Write the file again, or delete it.");
    assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [
      ['workspace-contents-lost', 'work/a.txt'],
      ['workspace-contents-lost', 'work/b.txt'],
    ]);
  });

  test("read_image says the workspace's copy is lost where disk's copy isn't an image it can show", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    m = await env.lose(m, env.hashOf('p.png'));
    env.writeDisk('p.png', 'not an image\n');

    assert.equal(await refused(m, 'read_image', { path: 'work/p.png' }),
      "The workspace's copy of work/p.png is missing from the store, and disk's copy holds other contents, so it can't be restored, and disk's copy can't be shown (Unsupported image format: work/p.png). Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
  });

  test("on a mount configured direct that runs as 'chronicle', the answer names the sync it takes, not a write", async (t) => {
    const env = new Env(t);
    let m = await env.open({ backend: 'chronicle' });
    await ok(m, 'write', { path: 'work/drafted.txt', content: 'a draft\n' });
    const hash = env.hashOf('drafted.txt');
    m = await env.restartAfter(m, (blobFile) => rmSync(blobFile(hash)), { backend: 'direct', mode: undefined });
    assert.match(await refused(m, 'write', { path: 'work/other.txt', content: 'x\n' }), /is configured direct, and runs as 'chronicle' this session/);

    assert.equal(await refused(m, 'read', { path: 'work/drafted.txt' }),
      "The workspace's copy of work/drafted.txt is missing from the store, and disk has no copy, so it can't be restored or read. Sync the path to take disk's deletion, which removes the workspace's copy.");
    await ok(m, 'sync', { path: 'work/drafted.txt' });
    assert.match(await refused(m, 'read', { path: 'work/drafted.txt' }), /^File not found/);
  });

  test("whoever runs the host is told that putting back the store's blob file brings the contents back, and it does", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    const blob = join(env.storePath, 'blobs', hash.slice(0, 2), hash);
    const saved = readFileSync(blob);
    m = await env.lose(m, hash);

    await refused(m, 'read', { path: 'work/a.txt' });
    assert.deepEqual(env.kinds(), ['workspace-contents-lost']);
    assert.match(env.alerts[0]!.message, new RegExp(`\\(blob ${hash}\\)`));
    assert.match(env.alerts[0]!.message, /Putting back the store's blob file for that hash, from a copy of the store, brings them back\.$/);
    writeFileSync(blob, saved);
    assert.equal(await textOf(m, 'work/a.txt'), 'v2, a draft\n');
  });
});

describe("contents whose blob file the store can't read", () => {
  test("a read is answered from disk's matching copy, whoever runs the host is told the store kept the bad file, and grep searches the rest", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await synced(env, m, 'a.txt', 'needle a\n');
    await synced(env, m, 'b.txt', 'needle b\n');
    m = await env.damage(m, a);
    assert.throws(() => env.store.getBlob(a));

    const found = await ok(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt']);
    assert.equal(await textOf(m, 'work/a.txt'), 'needle a\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-unstored']);
    assert.equal(typeof env.alerts[0]!.data!.storeError, 'string');
    assert.match(env.alerts[0]!.message, /unreadable in the workspace's store .*reads are answered from it, but storing it again didn't take: the store still can't read its file for them/);
    assert.equal(env.alerts[0]!.data!.blobHash, a);
  });

  test("with other contents on disk, read says so, and a sync takes disk's copy in their place", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    m = await env.damage(m, hash);

    assert.match(await refused(m, 'read', { path: 'work/a.txt' }),
      /^The workspace's copy of work\/a\.txt is unreadable in the store \(.+\), and disk's copy holds other contents, so it can't be restored or read\. Sync the path to keep disk's copy and give up the workspace's\.$/);
    await ok(m, 'sync', { path: 'work/a.txt' });
    assert.equal(await textOf(m, 'work/a.txt'), 'v1\n');
  });

  test('with no copy on disk, deleting the file clears it', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    rmSync(join(env.dir, 'a.txt'));
    m = await env.damage(m, hash);

    assert.match(await refused(m, 'read', { path: 'work/a.txt' }),
      /^The workspace's copy of work\/a\.txt is unreadable in the store \(.+\), and disk has no copy, so it can't be restored or read\. Delete the file to clear it\.$/);
    await ok(m, 'delete', { path: 'work/a.txt' });
    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /^File not found/);
  });
  test('edit and edit_many plan from disk\'s matching copy and store their change', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await synced(env, m, 'a.txt', 'alpha\n');
    const b = await synced(env, m, 'b.txt', 'beta\n');
    m = await env.damage(m, a, b);

    await ok(m, 'edit', { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' });
    await ok(m, 'edit_many', { edits: [{ path: 'work/b.txt', oldString: 'beta', newString: 'BETA' }] });
    await ok(m, 'materialize', { path: 'work' });
    assert.deepEqual([env.readDisk('a.txt'), env.readDisk('b.txt')], ['ALPHA\n', 'BETA\n']);
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-unstored']);
  });

  test('whoever runs the host is told that removing the unreadable blob file lets a read store the contents again, and it does', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.damage(m, hash);

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.match(env.alerts[0]!.message, /Chronicle keeps a blob file it can't read in place, so where the file is damaged, removing it lets the next read store them\.$/);
    rmSync(join(env.storePath, 'blobs', hash.slice(0, 2), hash));
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.storedText(hash), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-restored']);
  });

  test('materialize lists a draft whose blob it can\'t read as skipped, saying why, and writes the rest', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await draft(env, m, 'a.txt', 'v1\n', 'a draft\n');
    await draft(env, m, 'b.txt', 'v1\n', 'b draft\n');
    m = await env.damage(m, a);

    const done = await ok(m, 'materialize', { path: 'work' });
    assert.deepEqual(done.materialized, [{ mount: 'work', path: 'b.txt' }]);
    assert.equal(done.skipped.length, 1);
    assert.match(done.skipped[0].reason, /^a\.txt: the workspace copy is unreadable in the store \(.+\)$/);
    assert.deepEqual([env.readDisk('a.txt'), env.readDisk('b.txt')], ['v1\n', 'b draft\n']);
  });

  test("a branch intent whose blob the store can't read leaves its path unverified, saying why, rather than failing the listing", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    await synced(env, m, 'a.txt', 'alpha\n');
    await ok(m, 'delete', { path: 'work/a.txt' });
    const intent = env.store.treeGet('workspace/work/intent', 'a.txt');
    assert.ok(intent, 'the deletion is recorded as an intent');
    m = await env.damage(m, intent.blobHash);

    const listed = (await ok(m, 'ls', { path: 'work' })).entries.find((e: { name: string }) => e.name === 'a.txt');
    assert.equal(listed?.state, 'unverified');
    assert.match(String(listed?.note), /its branch intent can't be read: its record's blob can't be read from the store \(.+\)/);
  });
});
