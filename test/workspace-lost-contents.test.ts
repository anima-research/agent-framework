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

/**
 * Whether storing a blob's bytes again replaces a file for them the store
 * can't read: one torn as Env.damage tears it, cut short by six bytes while
 * the store is closed, so no cache of an open store answers for it. Both
 * chronicles these tests run against are legitimate, and they differ here.
 * Released @animalabs/chronicle 0.4.0 takes any file already at the hash's
 * path as stored, so the bad file stays: a read answered from disk's matching
 * copy tells 'workspace-contents-unstored', and each read does so again.
 * Chronicle main's storeBlob, since the #60 series (stage each blob and rename
 * it into place), reads a file already there back and rewrites it where it
 * can't be read or holds other bytes, so storing disk's copy takes: the read
 * tells 'workspace-contents-restored' once, and the store answers the reads
 * after it. As the workspace module does, the probe judges by reading the
 * bytes back, not by what storeBlob returns.
 */
function probeRewritesTornBlob(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'af-ws-lost-probe-'));
  const storePath = join(root, 'probe.chronicle');
  const bytes = Buffer.from('a blob the probe tears\n');
  try {
    let store = JsStore.openOrCreate({ path: storePath });
    const hash = store.storeBlob(bytes, 'application/octet-stream');
    store.close();
    const file = join(storePath, 'blobs', hash.slice(0, 2), hash);
    writeFileSync(file, readFileSync(file).subarray(0, -6));
    store = JsStore.openOrCreate({ path: storePath });
    try {
      assert.throws(() => store.getBlob(hash), 'the probe tears its blob as Env.damage does');
      try {
        store.storeBlob(bytes, 'application/octet-stream');
      } catch {
        // A store that refuses them hasn't taken them, as the module reads it.
      }
      try {
        return store.getBlob(hash)?.equals(bytes) ?? false;
      } catch {
        return false;
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rewritesTornBlob = probeRewritesTornBlob();

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
    assert.ok(env.alerts[0]!.message.startsWith(`Blob ${hash}: the saved contents of work/a.txt were missing from the workspace's store, and were stored again from disk's copy`), env.alerts[0]!.message);

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
    assert.ok(env.alerts[0]!.message.startsWith(`Blob ${hash}: the saved contents of work/a.txt are missing from the workspace's store.`), env.alerts[0]!.message);
  });

  test("a store write that leaves a file it can't read is told with the store's error, and removing that file lets a read store the contents", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    const blob = join(env.storePath, 'blobs', hash.slice(0, 2), hash);
    m = await env.lose(m, hash);
    const store = env.store as unknown as { storeBlob: (content: Buffer, type: string) => string };
    const storeBlob = store.storeBlob.bind(env.store);
    store.storeBlob = () => {
      writeFileSync(blob, 'CHB');
      throw new Error('No space left on device');
    };

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored']);
    assert.equal(env.alerts[0]!.data!.unstored, 'No space left on device');
    assert.match(env.alerts[0]!.message, new RegExp(`^Blob ${hash}: the saved contents of work/a\\.txt are unreadable in the workspace's store \\(.+\\)\\. .*storing it again didn't take: No space left on device\\. .*where the file is damaged, removing it lets the next read store them\\.$`));
    assert.equal(typeof env.alerts[0]!.data!.storeError, 'string');

    store.storeBlob = storeBlob;
    rmSync(blob);
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.storedText(hash), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-restored']);
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
    assert.equal(error, "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy can't be read (Symlinks are not allowed: work/a.txt), so it can't be restored or read. Write the file again, or delete it.");
    assert.equal(env.store.getBlob(hash), null);
    assert.deepEqual(env.kinds(), ['workspace-contents-lost']);

    await ok(m, 'write', { path: 'work/a.txt', content: 'alpha again\n' });
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha again\n');
  });

  test("on a read-only mount, the answer says what a read or a sync does once disk's copy can be read, rather than offering a write, and a read then restores it", async (t) => {
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
      "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy can't be read (Symlinks are not allowed: work/a.txt), so it can't be restored or read. "
        + "Once disk's copy can be read, read the file again, which reads it from disk's copy if that copy has the same contents, or sync the path to keep disk's copy and give up the workspace's.");
    rmSync(join(env.dir, 'a.txt'));
    env.writeDisk('a.txt', 'alpha\n');
    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    assert.equal(env.storedText(hash), 'alpha\n');
    assert.deepEqual(env.kinds(), ['workspace-contents-lost', 'workspace-contents-restored']);
  });

  test('grep searches contents two files share once either restores them, whichever comes first, and tells no loss', async (t) => {
    for (const [unrestorable, restoring] of [['a.txt', 'b.txt'], ['b.txt', 'a.txt']]) {
      const env = new Env(t);
      let m = await env.open();
      const hash = await draft(env, m, unrestorable!, 'other\n', 'needle\n');
      assert.equal(await synced(env, m, restoring!, 'needle\n'), hash);
      m = await env.lose(m, hash);

      const found = await ok(m, 'grep', { pattern: 'needle' });
      assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt']);
      assert.equal(found.skipped, undefined);
      assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [['workspace-contents-restored', `work/${restoring}`]]);
      assert.equal(env.storedText(hash), 'needle\n');
    }
  });

  test('edit_many edits files that share contents once either restores them, and tells no loss', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'other\n', 'the same\n');
    assert.equal(await synced(env, m, 'b.txt', 'the same\n'), hash);
    m = await env.lose(m, hash);

    await ok(m, 'edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'same', newString: 'SAME' },
        { path: 'work/b.txt', oldString: 'same', newString: 'SAME' },
      ],
    });
    assert.equal(await textOf(m, 'work/a.txt'), 'the SAME\n');
    assert.equal(await textOf(m, 'work/b.txt'), 'the SAME\n');
    assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [['workspace-contents-restored', 'work/b.txt']]);
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
      "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored or read. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
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
      "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored or read. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
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
        `The read did nothing: the workspace's copy of ${path} is missing from the store, and disk has no copy, so it can't be restored or read. Write the file again, or delete it.`);
    }
    await ok(m, 'delete', { path: 'work/a.txt' });
    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /^The read did nothing: there's no file at "work\/a\.txt"/);
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

  test("grep tells each file's own state when files share contents the store lost", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'needle\n');
    assert.equal(await draft(env, m, 'b.txt', 'v1\n', 'needle\n'), hash);
    rmSync(join(env.dir, 'b.txt'));
    m = await env.lose(m, hash);

    const found = await ok(m, 'grep', { pattern: 'needle' });
    assert.deepEqual(found.results, []);
    assert.deepEqual(found.skipped, [
      { file: 'work/a.txt', reason: "the workspace's copy is missing from the store, and disk's copy holds other contents, so it was not searched" },
      { file: 'work/b.txt', reason: "the workspace's copy is missing from the store, and disk has no copy, so it was not searched" },
    ]);
    assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [
      ['workspace-contents-lost', 'work/a.txt'],
      ['workspace-contents-lost', 'work/b.txt'],
    ]);
    assert.match(env.alerts[0]!.message, /: disk's copy holds other contents\. /);
    assert.match(env.alerts[1]!.message, /: disk has no copy\. /);
  });

  test('disk bytes of the same size but other contents are not taken', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'abcdef\n', 'ghijkl\n');
    m = await env.lose(m, hash);

    assert.equal(await refused(m, 'read', { path: 'work/a.txt' }),
      "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy holds other contents, so it can't be restored or read. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
    assert.equal(env.store.getBlob(hash), null);
    assert.deepEqual(env.kinds(), ['workspace-contents-lost']);
  });

  test("on a mount that follows links, a copy disk holds through a link leading nowhere is one it can't read, not one it lacks", async (t) => {
    const env = new Env(t);
    let m = await env.open({ followSymlinks: true });
    const leaf = await draft(env, m, 'a.txt', 'v1\n', 'a draft\n');
    const beneath = await draft(env, m, 'dir/b.txt', 'v1\n', 'b draft\n');
    m = await env.restartAfter(m, (blobFile) => {
      rmSync(blobFile(leaf));
      rmSync(blobFile(beneath));
    }, { followSymlinks: true });
    rmSync(join(env.dir, 'a.txt'));
    symlinkSync(join(env.dir, 'gone.txt'), join(env.dir, 'a.txt'));
    rmSync(join(env.dir, 'dir'), { recursive: true });
    symlinkSync(join(env.dir, 'nowhere'), join(env.dir, 'dir'));

    assert.equal(await refused(m, 'read', { path: 'work/a.txt' }),
      "The read did nothing: the workspace's copy of work/a.txt is missing from the store, and disk's copy can't be read (File not found: work/a.txt), so it can't be restored or read. Write the file again, or delete it.");
    assert.equal(await refused(m, 'read', { path: 'work/dir/b.txt' }),
      "The read did nothing: the workspace's copy of work/dir/b.txt is missing from the store, and disk's copy can't be read (beneath a symlink that does not lead to a directory inside the mount), so it can't be restored or read. Write the file again, or delete it.");
  });

  test("a store closed while a read restores contents fails the read with the store's own error, and tells no damaged blob", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.lose(m, hash);
    const store = env.store as unknown as { storeBlob: (content: Buffer, type: string) => string };
    store.storeBlob = () => {
      env.store.close();
      throw new Error('Store has been closed');
    };

    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /Store has been closed/);
    assert.deepEqual(env.kinds(), []);
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
      "The read_image did nothing: the workspace's copy of work/q.png is missing from the store, and disk has no copy, so it can't be restored or read. Write the file again, or delete it.");
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
      `The read_image did nothing: the workspace's copy of work/p.png is missing from the store, and disk's copy holds other contents, so it can't be restored, and disk's copy can't be shown ("work/p.png" isn't a PNG, JPEG, GIF or WebP image, the formats read_image shows). Sync the path to keep disk's copy and give up the workspace's, or write the file again.`);
  });

  test("read_image gives disk's reason once where disk's copy can't be read", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    m = await env.lose(m, env.hashOf('p.png'));
    writeFileSync(join(env.outside, 'p.png'), PNG);
    rmSync(join(env.dir, 'p.png'));
    symlinkSync(join(env.outside, 'p.png'), join(env.dir, 'p.png'));

    assert.equal(await refused(m, 'read_image', { path: 'work/p.png' }),
      "The read_image did nothing: the workspace's copy of work/p.png is missing from the store, and disk's copy can't be read (Symlinks are not allowed: work/p.png), so it can't be restored or read. Write the file again, or delete it.");
  });

  test("read_image tells a loss while the disk-agreement evidence awaits reopening, since its read checks the root as before", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    assert.equal((await m.writeBinary('work/p.png', PNG, 'image/png')).success, true);
    await ok(m, 'materialize', { path: 'work/p.png' });
    m = await env.lose(m, env.hashOf('p.png'));
    rmSync(join(env.dir, 'p.png'));

    const store = env.store as unknown as { appendJson: (type: string, payload: unknown) => unknown };
    const append = store.appendJson;
    let fired = false;
    store.appendJson = function (this: unknown, type: string, payload: unknown) {
      const record = append.call(this, type, payload);
      if (!fired && type === 'workspace/disk-agreement') {
        fired = true;
        throw new Error('injected: the append landed, then the store failed');
      }
      return record;
    };
    try {
      await call(m, 'write', { path: 'work/b.txt', content: 'b\n' });
      await call(m, 'materialize', { path: 'work/b.txt' });
    } finally {
      store.appendJson = append;
    }
    assert.equal(fired, true);
    const reopen = "Calling again won't change that; whoever runs this host can reopen it with a restart.";
    const until = "the workspace can't check its files against disk until its store is reopened: an append to its record of what disk last agreed with failed inside the store, "
      + `so that record may lack what the append held. ${reopen}`;
    assert.equal(await refused(m, 'ls', { path: 'work' }), `The ls did nothing: ${until}`);

    assert.equal(await refused(m, 'read_image', { path: 'work/p.png' }),
      "The read_image did nothing: the workspace's copy of work/p.png is missing from the store, and disk has no copy, so it can't be restored or read. "
      + "Nothing you do clears this until the workspace's store is reopened, and calling again won't change that; whoever runs this host can reopen it with a restart. "
      + 'After that, write the file again, or delete it.');
    assert.equal(await refused(m, 'write', { path: 'work/p.png', content: 'x' }), `The write did nothing: ${until}`);
    assert.equal(await refused(m, 'delete', { path: 'work/p.png' }), `The delete did nothing: ${until}`);
    assert.deepEqual(env.kinds().filter((kind) => kind.startsWith('workspace-contents-')), ['workspace-contents-lost']);
  });

  test("on a mount configured direct that runs as 'chronicle', the answer names the sync it takes, not a write", async (t) => {
    const env = new Env(t);
    let m = await env.open({ backend: 'chronicle' });
    await ok(m, 'write', { path: 'work/drafted.txt', content: 'a draft\n' });
    const hash = env.hashOf('drafted.txt');
    m = await env.restartAfter(m, (blobFile) => rmSync(blobFile(hash)), { backend: 'direct', mode: undefined });
    assert.match(await refused(m, 'write', { path: 'work/other.txt', content: 'x\n' }), /is configured direct, and runs as 'chronicle' this session/);

    assert.equal(await refused(m, 'read', { path: 'work/drafted.txt' }),
      "The read did nothing: the workspace's copy of work/drafted.txt is missing from the store, and disk has no copy, so it can't be restored or read. Sync the path to take disk's deletion, which removes the workspace's copy.");
    await ok(m, 'sync', { path: 'work/drafted.txt' });
    assert.match(await refused(m, 'read', { path: 'work/drafted.txt' }), /^The read did nothing: there's no file at "work\/drafted\.txt"/);
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
    assert.ok(env.alerts[0]!.message.startsWith(`Blob ${hash}: the saved contents of work/a.txt are missing from the workspace's store, and no copy`), env.alerts[0]!.message);
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
    assert.equal(typeof env.alerts[0]!.data!.storeError, 'string');
    assert.equal(env.alerts[0]!.data!.blobHash, a);
    if (rewritesTornBlob) {
      // grep's read stored disk's copy in place of the bad file, so the read
      // after it is answered from the store, and nothing more is told.
      assert.deepEqual(env.kinds(), ['workspace-contents-restored']);
      assert.match(env.alerts[0]!.message, /^Blob [0-9a-f]+: the saved contents of work\/a\.txt were unreadable in the workspace's store \(.+\), and were stored again from disk's copy, whose bytes have their hash\.$/);
      assert.equal(env.storedText(a), 'needle a\n');
    } else {
      // The store kept the bad file, so grep and the read are each answered
      // from disk, and each tells it.
      assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-unstored']);
      assert.match(env.alerts[0]!.message, /unreadable in the workspace's store .*reads are answered from it, but storing it again didn't take: the store can't read its file for them/);
      assert.throws(() => env.store.getBlob(a));
    }
  });

  test("with other contents on disk, read says so, and a sync takes disk's copy in their place", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await draft(env, m, 'a.txt', 'v1\n', 'v2, a draft\n');
    m = await env.damage(m, hash);

    assert.match(await refused(m, 'read', { path: 'work/a.txt' }),
      /^The read did nothing: the workspace's copy of work\/a\.txt is unreadable in the store \(.+\), and disk's copy holds other contents, so it can't be restored or read\. Sync the path to keep disk's copy and give up the workspace's\.$/);
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
      /^The read did nothing: the workspace's copy of work\/a\.txt is unreadable in the store \(.+\), and disk has no copy, so it can't be restored or read\. Delete the file to clear it\.$/);
    await ok(m, 'delete', { path: 'work/a.txt' });
    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /^The read did nothing: there's no file at "work\/a\.txt"/);
  });
  test("files sharing contents whose blob the store can't read are all answered from the one file whose disk copy has them, told once", async (t) => {
    for (const [unrestorable, restoring] of [['a.txt', 'b.txt'], ['b.txt', 'a.txt']]) {
      for (const tool of ['grep', 'edit_many']) {
        const env = new Env(t);
        let m = await env.open();
        const hash = await draft(env, m, unrestorable!, 'other\n', 'the same needle\n');
        assert.equal(await synced(env, m, restoring!, 'the same needle\n'), hash);
        m = await env.damage(m, hash);

        if (tool === 'grep') {
          const found = await ok(m, 'grep', { pattern: 'needle' });
          assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt']);
          assert.equal(found.skipped, undefined);
        } else {
          await ok(m, 'edit_many', {
            edits: [
              { path: 'work/a.txt', oldString: 'needle', newString: 'NEEDLE' },
              { path: 'work/b.txt', oldString: 'needle', newString: 'NEEDLE' },
            ],
          });
          assert.equal(await textOf(m, 'work/a.txt'), 'the same NEEDLE\n');
          assert.equal(await textOf(m, 'work/b.txt'), 'the same NEEDLE\n');
        }
        if (rewritesTornBlob) {
          // The restoring file's copy was stored in place of the bad file, so
          // the store answers either file from now on, telling nothing more,
          // even the one whose disk copy holds other contents.
          assert.equal(env.storedText(hash), 'the same needle\n');
          if (tool === 'grep') {
            assert.equal(await textOf(m, 'work/a.txt'), 'the same needle\n');
            assert.equal(await textOf(m, 'work/b.txt'), 'the same needle\n');
          }
        } else {
          assert.throws(() => env.store.getBlob(hash));
        }
        const told = rewritesTornBlob ? 'workspace-contents-restored' : 'workspace-contents-unstored';
        assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [[told, `work/${restoring}`]], `${tool}, ${unrestorable} first`);
      }
    }
  });

  test("files sharing contents whose blob the store can't read, each with the matching copy on disk, are read from disk and told once", async (t) => {
    for (const tool of ['grep', 'edit_many']) {
      const env = new Env(t);
      let m = await env.open();
      const hash = await synced(env, m, 'a.txt', 'the same needle\n');
      assert.equal(await synced(env, m, 'b.txt', 'the same needle\n'), hash);
      m = await env.damage(m, hash);

      if (tool === 'grep') {
        const found = await ok(m, 'grep', { pattern: 'needle' });
        assert.deepEqual(found.results.map((r: { file: string }) => r.file), ['work/a.txt', 'work/b.txt']);
      } else {
        await ok(m, 'edit_many', {
          edits: [
            { path: 'work/a.txt', oldString: 'needle', newString: 'NEEDLE' },
            { path: 'work/b.txt', oldString: 'needle', newString: 'NEEDLE' },
          ],
        });
        assert.equal(await textOf(m, 'work/b.txt'), 'the same NEEDLE\n');
      }
      if (rewritesTornBlob) {
        // The first file's copy was stored in place of the bad file, so the
        // store answers both from now on, telling nothing more.
        assert.equal(env.storedText(hash), 'the same needle\n');
        if (tool === 'grep') {
          assert.equal(await textOf(m, 'work/a.txt'), 'the same needle\n');
          assert.equal(await textOf(m, 'work/b.txt'), 'the same needle\n');
        }
      } else {
        assert.throws(() => env.store.getBlob(hash));
      }
      const told = rewritesTornBlob ? 'workspace-contents-restored' : 'workspace-contents-unstored';
      assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]), [[told, 'work/a.txt']], tool);
    }
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
    if (rewritesTornBlob) {
      // Each plan's read also stored disk's copy in place of its bad file.
      assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]),
        [['workspace-contents-restored', 'work/a.txt'], ['workspace-contents-restored', 'work/b.txt']]);
      assert.deepEqual([env.storedText(a), env.storedText(b)], ['alpha\n', 'beta\n']);
    } else {
      assert.deepEqual(env.alerts.map(({ kind, data }) => [kind, data?.path]),
        [['workspace-contents-unstored', 'work/a.txt'], ['workspace-contents-unstored', 'work/b.txt']]);
      assert.throws(() => env.store.getBlob(a));
      assert.throws(() => env.store.getBlob(b));
    }
  });

  test('whoever runs the host is told that removing the unreadable blob file lets a read store the contents again, and it does', async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const hash = await synced(env, m, 'a.txt', 'alpha\n');
    m = await env.damage(m, hash);

    assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
    if (rewritesTornBlob) {
      // This chronicle replaces the bad file when the read stores disk's
      // copy, so there is nothing to remove: the read stores the contents
      // again itself, the notice offers no removal, and the next read is
      // answered from the store, telling nothing more.
      assert.deepEqual(env.kinds(), ['workspace-contents-restored']);
      assert.doesNotMatch(env.alerts[0]!.message, /removing it/);
      assert.equal(env.storedText(hash), 'alpha\n');
      assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
      assert.deepEqual(env.kinds(), ['workspace-contents-restored']);
    } else {
      assert.match(env.alerts[0]!.message, /Chronicle keeps a blob file it can't read in place, so where the file is damaged, removing it lets the next read store them\.$/);
      rmSync(join(env.storePath, 'blobs', hash.slice(0, 2), hash));
      assert.equal(await textOf(m, 'work/a.txt'), 'alpha\n');
      assert.equal(env.storedText(hash), 'alpha\n');
      assert.deepEqual(env.kinds(), ['workspace-contents-unstored', 'workspace-contents-restored']);
    }
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
    assert.match(done.skipped[0].reason, /^a\.txt: the workspace copy is unreadable in the store \(.+\) — a read of this path takes disk's copy where it can, and otherwise says what can be done$/);
    assert.deepEqual([env.readDisk('a.txt'), env.readDisk('b.txt')], ['v1\n', 'b draft\n']);
    assert.match(await refused(m, 'read', { path: 'work/a.txt' }), /so it can't be restored or read\. Sync the path to keep disk's copy and give up the workspace's\.$/,
      'the read the skip names says what can be done');
  });

  test("a forced materialize over disk's newer copy skips a file whose blob it can't read, saying why, and leaves disk's copy", async (t) => {
    const env = new Env(t);
    let m = await env.open();
    const a = await synced(env, m, 'a.txt', 'v1\n');
    m = await env.damage(m, a);
    env.writeDisk('a.txt', 'v2, on disk\n');

    const done = await ok(m, 'materialize', { path: 'work/a.txt', force: true });
    assert.deepEqual(done.materialized ?? [], []);
    assert.equal(done.skipped.length, 1);
    assert.match(done.skipped[0].reason, /^a\.txt: the workspace copy is unreadable in the store \(.+\) — a read of this path takes disk's copy where it can, and otherwise says what can be done$/);
    assert.equal(env.readDisk('a.txt'), 'v2, on disk\n');
    assert.equal(await textOf(m, 'work/a.txt'), 'v2, on disk\n', "the read the skip names takes disk's copy");
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
