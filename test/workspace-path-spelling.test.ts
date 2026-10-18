// On a disk that folds names (macOS's default folds case, and Unicode
// normalization), a path spelled otherwise than disk spells it reaches disk's
// file. The workspace's tools take such a path as disk spells it, so they
// name each file by one name and take nothing in twice. Most of these tests
// need a temp directory that folds case, and skip, saying why, where it
// doesn't, since a disk that tells spellings apart has nothing to respell;
// one needs it to fold normalization, and three to fold ß with ss, ſ with s
// and ς with σ. Two run only where the disk tells case apart, and those about
// starting and stopping run anywhere.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { diskSpelling } from '../src/modules/workspace/observe.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';

/** What the temp directory folds: case, NFC against NFD, ß with ss, ſ with s, and ς with σ. */
const folds = ((): { case: boolean; normalization: boolean; sharpS: boolean; longS: boolean; finalSigma: boolean } => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-folds-'));
  try {
    writeFileSync(join(dir, 'Fold'), '');
    writeFileSync(join(dir, 'caf\u00e9'), '');
    writeFileSync(join(dir, 'stra\u00dfe'), '');
    writeFileSync(join(dir, '\u017foap'), '');
    writeFileSync(join(dir, '\u03bf\u03b4\u03bf\u03c2'), '');
    return {
      case: existsSync(join(dir, 'FOLD')),
      normalization: existsSync(join(dir, 'cafe\u0301')),
      sharpS: existsSync(join(dir, 'STRASSE')),
      longS: existsSync(join(dir, 'SOAP')),
      finalSigma: existsSync(join(dir, '\u03bf\u03b4\u03bf\u03c3')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FOLDING_ONLY = folds.case ? false
  : "the temp directory tells case apart, so a path spelled in another case reaches nothing: these run on a disk that folds case, such as macOS's default";
const NORMALIZATION_FOLDING_ONLY = folds.normalization ? false
  : 'the temp directory tells NFC and NFD apart, so a name in the other form reaches nothing';
const SHARP_S_FOLDING_ONLY = folds.sharpS ? false
  : 'the temp directory keeps \u00df apart from ss, so STRASSE reaches nothing where disk has stra\u00dfe';
const LONG_S_FOLDING_ONLY = folds.longS ? false
  : 'the temp directory keeps \u017f apart from s, so SOAP reaches nothing where disk has \u017foap';
const FINAL_SIGMA_FOLDING_ONLY = folds.finalSigma ? false
  : 'the temp directory keeps \u03c2 apart from \u03c3, so \u039f\u0394\u039f\u03a3 reaches nothing where disk has \u03bf\u03b4\u03bf\u03c2';
const CASE_SENSITIVE_ONLY = folds.case
  ? 'the temp directory folds case, so two names that differ only in case are one name here' : false;

async function setup(t: TestContext, mounts: (dir: string) => MountConfig[] = (dir) => [
  { name: 'work', path: dir, mode: 'read-write', watch: 'never', autoMaterialize: true },
]) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: mounts(dir) });
  workspace.initStore(store);
  const events: ProcessEvent[] = [];
  await workspace.start({
    isRestart: false, getState: () => null, setState: () => {}, pushEvent: (e: ProcessEvent) => events.push(e),
  } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, input: unknown): Promise<ToolResult> => {
    const result = await workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(result.success, true, `${name}: ${result.error}`);
    return result;
  };
  /** The created, modified and deleted events pushed since the last call, as `op path`. */
  const pushed = (): string[] => events.splice(0)
    .filter((e) => /^workspace:(created|modified|deleted)$/.test(e.type))
    .flatMap((e) => (e as unknown as { paths: string[] }).paths.map((p) => `${e.type.slice('workspace:'.length)} ${p}`));
  return { workspace, dir, call, pushed };
}

test('a search whose path is spelled in another case names what it finds as disk does, and takes nothing in twice',
  { skip: FOLDING_ONLY }, async (t) => {
    const { call, pushed } = await setup(t);
    await call('ls', { path: 'work', recursive: true });
    assert.deepEqual(pushed(), ['created work/src/a.ts']);

    const glob = await call('glob', { pattern: '*.ts', path: 'work/SRC' });
    assert.deepEqual((glob.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path), ['work/src/a.ts']);
    const grep = await call('grep', { pattern: 'const', path: 'work/Src' });
    assert.deepEqual((grep.data as { results: Array<{ file: string }> }).results.map((r) => r.file), ['work/src/a.ts']);
    const ls = await call('ls', { path: 'work/SRC' });
    assert.equal((ls.data as { path: string }).path, 'work/src');
    assert.deepEqual(pushed(), [], 'nothing was taken in under the spelling given');

    const all = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((all.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), [], 'and nothing was deleted when the whole mount was listed');
  });

test('a read, write, edit and delete spelled in another case act on disk\'s file, under its own name',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call, pushed } = await setup(t);
    await call('ls', { path: 'work', recursive: true });
    pushed();

    const read = await call('read', { path: 'work/SRC/A.TS', offsetChars: 0, limitChars: 100 });
    assert.deepEqual(read.data, {
      path: 'work/src/a.ts', totalChars: 20, offsetChars: 0, nextOffsetChars: null, content: 'export const a = 1;\n',
    });
    const write = await call('write', { path: 'work/SRC/b.ts', content: 'export const b = 2;\n' });
    assert.equal((write.data as { path: string }).path, 'work/src/b.ts');
    const edit = await call('edit', { path: 'work/Src/B.ts', oldString: '2', newString: '3' });
    assert.equal((edit.data as { path: string }).path, 'work/src/b.ts');
    assert.equal(readFileSync(join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = 3;\n');

    const listed = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(pushed(), [], 'the write is held under the name disk lists, so listing the mount moves nothing');

    const deleted = await call('delete', { path: 'work/SRC/B.TS' });
    assert.deepEqual(deleted.data, { path: 'work/src/b.ts', deleted: true });
    assert.equal(existsSync(join(dir, 'src', 'b.ts')), false);
    const after = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((after.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), []);
  });

test('beneath a directory disk has, a name disk doesn\'t have keeps the spelling given',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call } = await setup(t);
    const write = await call('write', { path: 'work/SRC/New/x.ts', content: 'x\n' });
    assert.equal((write.data as { path: string }).path, 'work/src/New/x.ts');
    assert.equal(readFileSync(join(dir, 'src', 'New', 'x.ts'), 'utf8'), 'x\n');
  });

test('a nested mount whose directory is configured as disk spells it is that mount\'s in another spelling too',
  { skip: FOLDING_ONLY }, async (t) => {
    const { workspace, dir } = await setup(t, (d) => [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
    ]);
    mkdirSync(join(dir, 'inner'), { recursive: true });
    writeFileSync(join(dir, 'inner', 'x.txt'), 'inner\n');
    const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/INNER/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(read.success, false);
    assert.equal(read.error, '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
    await assert.rejects(workspace.readFileFromDisk('outer/INNER/x.txt'),
      (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
    assert.deepEqual(await workspace.readBinary('outer/INNER/x.txt'), { error: read.error });
  });

test('a nested mount whose directory is configured in another spelling than disk\'s is that mount\'s in either',
  { skip: FOLDING_ONLY }, async (t) => {
    const { workspace, dir, call, pushed } = await setup(t, (d) => {
      mkdirSync(join(d, 'inner'), { recursive: true });
      writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
        { name: 'inner', path: join(d, 'Inner'), mode: 'read-write', watch: 'never' },
      ];
    });
    const refusal = '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".';
    for (const path of ['outer/Inner/x.txt', 'outer/inner/x.txt']) {
      const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
      assert.equal(read.error, refusal, path);
      assert.equal(workspace.resolveAbsolutePath(path), null, path);
    }
    const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/Inner/y.txt', content: 'y\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(write.error, '"outer/inner/y.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/y.txt".');
    assert.equal(existsSync(join(dir, 'inner', 'y.txt')), false);
    const synced = await call('sync', { path: 'outer/Inner' });
    assert.equal((synced.data as { totalSynced: number }).totalSynced, 0);
    const listed = await call('ls', { path: 'outer', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(pushed(), ['created outer/src/a.ts'], 'the outer mount takes nothing of the inner one\'s in');
  });

test('a sync and a materialize of a path spelled in another case act on disk\'s file, under its own name',
  { skip: FOLDING_ONLY }, async (t) => {
    const { dir, call, pushed } = await setup(t, (d) => [{ name: 'work', path: d, mode: 'read-write', watch: 'never' }]);
    await call('ls', { path: 'work', recursive: true });
    pushed();
    writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
    await call('sync', { path: 'work/SRC/B.TS' });
    assert.deepEqual(pushed(), ['created work/src/b.ts']);
    await call('write', { path: 'work/src/a.ts', content: 'export const a = 2;\n' });
    assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n', 'not on disk until materialized');
    await call('materialize', { path: 'work/SRC/A.TS' });
    assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
    const listed = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(pushed(), [], 'nothing announced: the materialize wrote disk\'s file, which the listing finds as the workspace holds it');
  });

test('read_image of a path spelled in another case names the file as disk does', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // A 1x1 PNG.
  writeFileSync(join(dir, 'src', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const image = await call('read_image', { path: 'work/SRC/DOT.PNG' });
  const text = (image.data as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
  assert.match(text, /^Path: work\/src\/dot\.png\n/);
});

test('a name with ß, spelled in another case, takes disk\'s spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // ß's upper case is two letters, SS, which a disk whose folding is simple doesn't fold to ß.
  writeFileSync(join(dir, 'src', 'stra\u00dfe.txt'), 'sharp s\n');
  const read = await call('read', { path: 'work/src/Stra\u00dfe.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('where disk folds ß with ss, a name spelled with ss takes disk\'s ß', { skip: SHARP_S_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  writeFileSync(join(dir, 'src', 'stra\u00dfe.txt'), 'sharp s\n');
  const read = await call('read', { path: 'work/src/STRASSE.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('where disk folds ſ with s, a name spelled with s takes disk\'s ſ', { skip: LONG_S_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  writeFileSync(join(dir, 'src', '\u017foap.txt'), 'long s\n');
  const read = await call('read', { path: 'work/src/SOAP.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/\u017foap.txt');
});

test('where disk folds ς with σ, a name spelled with σ takes disk\'s ς', { skip: FINAL_SIGMA_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // Lower case keeps them apart here: ΟΔΟΣ.txt lowers to οδοσ.txt, since a letter follows the dot.
  writeFileSync(join(dir, 'src', '\u03bf\u03b4\u03bf\u03c2.txt'), 'final sigma\n');
  const read = await call('read', { path: 'work/src/\u039f\u0394\u039f\u03a3.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/\u03bf\u03b4\u03bf\u03c2.txt');
});

test('a name with dotless ı, spelled in another case, takes disk\'s spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // ı's upper case, I, lowers to i, which Unicode's case folding keeps apart from ı.
  writeFileSync(join(dir, 'src', 'k\u0131r.txt'), 'dotless i\n');
  const read = await call('read', { path: 'work/src/K\u0131r.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/src/k\u0131r.txt');
});

test('the public readers and writer take a path as disk spells it too', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir, call } = await setup(t);
  await call('ls', { path: 'work', recursive: true });
  assert.deepEqual(await workspace.readBinary('work/SRC/A.TS'), { data: Buffer.from('export const a = 1;\n') });
  const fromDisk = await workspace.readBinaryFromDisk('work/SRC/a.ts');
  assert.ok('absolutePath' in fromDisk, JSON.stringify(fromDisk));
  assert.equal(fromDisk.absolutePath, join(dir, 'src', 'a.ts'));
  const written = await workspace.writeBinary('work/SRC/c.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
  assert.equal(written.success, true, written.error);
  assert.equal((written.data as { path: string }).path, 'work/src/c.bin');
});

test('a name in the other Unicode normalization form takes the form disk lists', { skip: NORMALIZATION_FOLDING_ONLY }, async (t) => {
  const { dir, call, pushed } = await setup(t);
  // が has no case, so only its normalization forms tell this name apart: NFD on disk, NFC in the path.
  mkdirSync(join(dir, '\u304b\u3099'));
  writeFileSync(join(dir, '\u304b\u3099', 'a.txt'), 'nfd\n');
  await call('ls', { path: 'work', recursive: true });
  pushed();
  const read = await call('read', { path: 'work/\u304c/a.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.data as { path: string }).path, 'work/\u304b\u3099/a.txt');
  await call('ls', { path: 'work', recursive: true });
  assert.deepEqual(pushed(), []);
});

test('the step reads no further than a symlink or a `..` at the root, goes back up at any other `..`, and passes over `.` and empty segments', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real', 'sub'), { recursive: true });
  symlinkSync('real', join(root, 'lnk'));
  assert.equal(await diskSpelling(root, 'REAL/SUB'), 'real/sub');
  assert.equal(await diskSpelling(root, 'LNK/SUB'), 'lnk/SUB');
  assert.equal(await diskSpelling(root, 'REAL/../REAL'), 'real/../real');
  assert.equal(await diskSpelling(root, 'REAL/SUB/../SUB'), 'real/sub/../sub');
  assert.equal(await diskSpelling(root, `../${basename(root)}/REAL`), `../${basename(root)}/REAL`, 'a `..` at the root lists nothing above it');
  assert.equal(await diskSpelling(root, 'REAL/./SUB'), 'real/./sub');
  assert.equal(await diskSpelling(root, 'REAL//SUB'), 'real//sub');
  assert.equal(await diskSpelling(root, '/REAL/SUB'), '/REAL/SUB', 'an absolute path is not walked from the mount\'s root');
});

test('a path whose part after the mount\'s name is absolute keeps its spelling, so a disk reader reads the file it names', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t);
  // The mount holds a directory spelled as the first segment of its own
  // absolute path in another case, so walking that path from the mount's
  // root would respell it and lead to a place outside the mount.
  const first = dir.split('/')[1]!;
  mkdirSync(join(dir, first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase()));
  const fromDisk = await workspace.readBinaryFromDisk(`work/${join(dir, 'src', 'a.ts')}`);
  assert.ok('absolutePath' in fromDisk, JSON.stringify(fromDisk));
  assert.equal(fromDisk.absolutePath, join(dir, 'src', 'a.ts'));
});

test('a link into a nested mount\'s directory configured in another spelling than disk\'s is refused as that mount\'s', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-nested-link-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'inner', 'sub', 'x.txt'), 'inner\n');
  // The link spells the directory as disk does, and the nested mount is
  // configured in another spelling.
  symlinkSync('inner/sub', join(dir, 'l'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'nested', path: join(dir, 'Inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(workspace.readFileFromDisk('outer/l/x.txt'), (err: unknown) => {
    assert.ok(err instanceof WorkspaceReadError, String(err));
    assert.equal(err.code, 'other_mount', err.message);
    assert.match(err.message, /it lies in mount "nested", nested in mount "outer": use "nested\/sub" in place of "outer\/l"/);
    return true;
  });
});

test('on a disk that tells case apart, a directory spelled otherwise than a nested mount\'s is the outer mount\'s own',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const { workspace, call } = await setup(t, (d) => {
      mkdirSync(join(d, 'inner'), { recursive: true });
      mkdirSync(join(d, 'Inner'), { recursive: true });
      writeFileSync(join(d, 'Inner', 'x.txt'), 'outer\n');
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
        { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
      ];
    });
    const read = await call('read', { path: 'outer/Inner/x.txt', offsetChars: 0, limitChars: 100 });
    assert.equal((read.data as { content: string }).content, 'outer\n');
    assert.notEqual(workspace.resolveAbsolutePath('outer/Inner/x.txt'), null);
    const listed = await call('ls', { path: 'outer', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['Inner/x.txt', 'src/a.ts']);
  });

/** A workspace with a mount nested in another, stored but not yet started. */
function nestedWorkspace(t: TestContext, watch?: 'never'): { workspace: WorkspaceModule; ls: () => Promise<ToolResult> } {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-start-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', ...(watch ? { watch } : {}) },
    { name: 'inner', path: join(dir, 'inner'), mode: 'read-write', ...(watch ? { watch } : {}) },
  ] });
  workspace.initStore(store);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const ls = () => workspace.handleToolCall({ id: 'l', name: 'ls', input: { path: 'outer' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  return { workspace, ls };
}

test('a stop made while start reads a nested mount\'s directory leaves the workspace stopped, watching nothing', async (t) => {
  // Both mounts watch by default, so a start that went on after the stop
  // would start their watchers and announce the mounts.
  const { workspace, ls } = nestedWorkspace(t);
  const events: ProcessEvent[] = [];
  const started = workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: (e: ProcessEvent) => events.push(e) } as unknown as ModuleContext);
  await workspace.stop();
  const atStop = events.length;
  await started;
  assert.deepEqual(events.slice(atStop).map((e) => e.type), [], 'nothing announced, so no watcher started, after stop returned');
  const listed = await ls();
  assert.equal(listed.success, false);
  assert.match(String(listed.error), /The workspace has stopped/);
});

test('a restart takes no call before it has read the nested mounts\' directories', async (t) => {
  const { workspace, ls } = nestedWorkspace(t, 'never');
  let saved: unknown = null;
  const ctx = { isRestart: false, getState: () => saved, setState: (state: unknown) => { saved = state; }, pushEvent: () => {} };
  await workspace.start(ctx as unknown as ModuleContext);
  await workspace.stop();
  const restarted = workspace.start({ ...ctx, isRestart: true } as unknown as ModuleContext);
  const during = await ls();
  await restarted;
  assert.equal(during.success, false);
  assert.match(String(during.error), /The workspace has stopped/);
  const after = await ls();
  assert.equal(after.success, true, String(after.error));
});

test('a write still reading disk for its path when stop begins finishes before stop does', async (t) => {
  const { workspace, dir } = await setup(t);
  const write = workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/src/late.ts', content: 'late\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  await workspace.stop();
  assert.equal(readFileSync(join(dir, 'src', 'late.ts'), 'utf8'), 'late\n', 'on disk when stop returns');
  assert.equal((await write).success, true);
});

test('a write taken while stop drains finishes before stop does', async (t) => {
  const { workspace, dir } = await setup(t);
  const stopping = workspace.stop();
  // stop takes calls until it has drained, so this one, made after it began, is taken.
  const write = workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/src/late.ts', content: 'late\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  await stopping;
  assert.equal(readFileSync(join(dir, 'src', 'late.ts'), 'utf8'), 'late\n', 'on disk when stop returns');
  assert.equal((await write).success, true);
});

test('a writeBinary still reading disk for its path when stop begins finishes before stop does', async (t) => {
  const { workspace, dir } = await setup(t);
  const written = workspace.writeBinary('work/src/late.bin', Buffer.from('late'), 'application/octet-stream');
  await workspace.stop();
  assert.equal(readFileSync(join(dir, 'src', 'late.bin'), 'utf8'), 'late', 'on disk when stop returns');
  assert.equal((await written).success, true);
});

test('a readBinary still reading disk for its path when stop begins finishes before stop does', async (t) => {
  const { workspace } = await setup(t);
  let finished = false;
  const read = workspace.readBinary('work/src/a.ts').then((result) => { finished = true; return result; });
  await workspace.stop();
  // Its promise settles a microtask or two after the read does; a read stop
  // didn't wait for is still waiting on disk then.
  for (let i = 0; i < 3; i++) await null;
  assert.equal(finished, true, 'finished when stop returns');
  assert.deepEqual(await read, { data: Buffer.from('export const a = 1;\n') });
});

test('on a disk that tells case apart, two hard links that differ only in case keep their own names',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-links-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // Each name's case flipped is the other, the same file, so the step lists
    // the directory for either, and each name, listed as given, keeps it.
    writeFileSync(join(root, 'a.txt'), 'one file\n');
    linkSync(join(root, 'a.txt'), join(root, 'A.TXT'));
    assert.equal(await diskSpelling(root, 'A.TXT'), 'A.TXT');
    assert.equal(await diskSpelling(root, 'a.txt'), 'a.txt');
    assert.equal(await diskSpelling(root, 'SRC/a.ts'), 'SRC/a.ts', 'a name disk lacks keeps its spelling');
  });
