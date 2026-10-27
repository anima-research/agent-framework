// On a disk that folds names (macOS's default folds case, and Unicode
// normalization), a path spelled otherwise than disk spells it reaches disk's
// file. The workspace's tools take such a path as disk spells it, unless it
// names a workspace entry exactly, or a deletion or conflict the workspace
// records there, or does once its directories take disk's spelling, so they
// name each file by one name and take nothing in twice. Most of these tests
// need a temp directory that folds case, and skip, saying why, where it
// doesn't, since a disk that tells spellings apart has nothing to respell.
// A draft not yet on disk takes the spelling of a workspace entry it equals
// in simple case folding, on a disk that folds case. Neither applies where
// disk's spelling puts the path in a nested mount's directory.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '../src/modules/workspace/index.js';
import { beneathNested, beneathRoot, diskSpelling, foldsCase, nestedAtReal, nestedGuess, nestedHolder, nestedRootAtReal, nestedStep, realSegments, restBeneath, sameRoot } from '../src/modules/workspace/observe.js';
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
const CASE_NOT_SHARP_S_ONLY = folds.case && !folds.sharpS ? false
  : 'these need a temp directory that folds case and keeps \u00df apart from ss';
const NORMALIZATION_APART_ONLY = folds.normalization
  ? 'the temp directory folds NFC with NFD, so a name in each form is one directory here' : false;

/** A mount whose writes stay drafts until they're materialized, as by default. */
const drafts = (dir: string): MountConfig[] => [{ name: 'work', path: dir, mode: 'read-write', watch: 'never' }];

/** Workspace entries at these paths, as the spelling step reads them, in path order as the store lists them, in a mount whose root folds case or not. */
const entriesOf = (paths: string[], rootFoldsCase = true) => ({
  has: (path: string) => paths.includes(path),
  under: (prefix: string) => paths.filter((path) => path.startsWith(prefix)).sort(),
  holder: () => undefined,
  rootFoldsCase,
});

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
    assert.deepEqual((grep.structured as { results: Array<{ file: string }> }).results.map((r) => r.file), ['work/src/a.ts']);
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
    assert.deepEqual(read.structured, {
      path: 'work/src/a.ts', totalChars: 20, offsetChars: 0, nextOffsetChars: null, content: 'export const a = 1;\n',
    });
    const write = await call('write', { path: 'work/SRC/b.ts', content: 'export const b = 2;\n' });
    assert.equal((write.data as { path: string }).path, 'work/src/b.ts');
    const edit = await call('edit', { path: 'work/Src/B.ts', oldString: '2', newString: '3' });
    assert.equal((edit.structured as { path: string }).path, 'work/src/b.ts');
    assert.equal(readFileSync(join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = 3;\n');
    // edit_many takes two spellings of one file as that file, planned once
    // from one text, and names it as disk does.
    const many = await call('edit_many', { edits: [
      { path: 'work/SRC/B.TS', oldString: 'b', newString: 'c' },
      { path: 'work/src/b.ts', oldString: '3', newString: '4' },
    ] });
    assert.deepEqual((many.structured as { files: Array<{ path: string; edits: number[] }> }).files.map((f) => [f.path, f.edits]), [['work/src/b.ts', [1, 2]]]);
    assert.equal(readFileSync(join(dir, 'src', 'b.ts'), 'utf8'), 'export const c = 4;\n');

    const listed = await call('ls', { path: 'work', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(pushed(), [], 'the write is held under the name disk lists, so listing the mount moves nothing');

    const deleted = await call('delete', { path: 'work/SRC/B.TS' });
    assert.deepEqual(deleted.data, { path: 'work/src/b.ts', deleted: true, disk: 'done' });
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
    for (const path of ['outer/Inner/x.txt', 'outer/inner/x.txt']) {
      const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
      refusedAsInner(read, 'inner/x.txt', path);
      assert.equal(workspace.resolveAbsolutePath(path), null, path);
    }
    const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/Inner/y.txt', content: 'y\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    refusedAsInner(write, 'inner/y.txt', 'outer/Inner/y.txt');
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
  assert.equal((read.structured as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('where disk folds ß with ss, a name spelled with ss takes disk\'s ß', { skip: SHARP_S_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  writeFileSync(join(dir, 'src', 'stra\u00dfe.txt'), 'sharp s\n');
  const read = await call('read', { path: 'work/src/STRASSE.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/stra\u00dfe.txt');
});

test('where disk folds ſ with s, a name spelled with s takes disk\'s ſ', { skip: LONG_S_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  writeFileSync(join(dir, 'src', '\u017foap.txt'), 'long s\n');
  const read = await call('read', { path: 'work/src/SOAP.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/\u017foap.txt');
});

test('where disk folds ς with σ, a name spelled with σ takes disk\'s ς', { skip: FINAL_SIGMA_FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // Lower case keeps them apart here: ΟΔΟΣ.txt lowers to οδοσ.txt, since a letter follows the dot.
  writeFileSync(join(dir, 'src', '\u03bf\u03b4\u03bf\u03c2.txt'), 'final sigma\n');
  const read = await call('read', { path: 'work/src/\u039f\u0394\u039f\u03a3.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/\u03bf\u03b4\u03bf\u03c2.txt');
});

test('a name with dotless ı, spelled in another case, takes disk\'s spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t);
  // ı's upper case, I, lowers to i, which Unicode's case folding keeps apart from ı.
  writeFileSync(join(dir, 'src', 'k\u0131r.txt'), 'dotless i\n');
  const read = await call('read', { path: 'work/src/K\u0131r.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/k\u0131r.txt');
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
  assert.equal((read.structured as { path: string }).path, 'work/\u304b\u3099/a.txt');
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

test('a path whose part after the mount\'s name is absolute is refused before the step reads it', async (t) => {
  const { workspace, dir } = await setup(t);
  // The mount holds a directory spelled as the first segment of its own
  // absolute path in another case, so on a disk that folds case, walking
  // that path from the mount's root would respell it and lead to a place
  // outside the mount. The path's reader refuses a separator right after the
  // mount's name before the step sees the path, on any disk.
  const first = dir.split('/')[1]!;
  mkdirSync(join(dir, first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase()));
  const fromDisk = await workspace.readBinaryFromDisk(`work/${join(dir, 'src', 'a.ts')}`);
  assert.ok('error' in fromDisk, JSON.stringify(fromDisk));
  assert.match(fromDisk.error, /has a separator right after mount "work", which makes it an absolute path/);
});

// A mount's include decides what a tool may name, and disk's spelling of a
// name is something about the file: a refusal that showed it would tell
// whether a file is there.
test('a name a mount\'s include doesn\'t cover is refused as given, whether disk has it in another spelling or not', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', include: ['*.ts'] },
  ]);
  writeFileSync(join(dir, 'secret.txt'), 'secret\n');
  for (const name of ['SECRET.TXT', 'NOPE.TXT']) {
    const path = `work/${name}`;
    const refusal = `"${path}" is outside the mount's include: mount "work" holds only *.ts. The host's operator sets the include in the mount's configuration, so calling again with this path changes nothing.`;
    for (const tool of ['read', 'write', 'ls', 'glob', 'grep', 'sync', 'materialize']) {
      const input = tool === 'glob' || tool === 'grep' ? { path, pattern: 's' } : tool === 'write' ? { path, content: 'x' } : { path };
      const result = await workspace.handleToolCall({ id: tool, name: tool, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
      assert.equal(result.error, refusal, `${tool} ${path}`);
    }
    await assert.rejects(workspace.readFileFromDisk(path),
      (err: unknown) => err instanceof WorkspaceReadError && err.code === 'outside_include' && err.message === refusal);
  }
  assert.equal(readFileSync(join(dir, 'secret.txt'), 'utf8'), 'secret\n');
});

test("through a link a mount follows, the include judges where the path lands as disk spells it, whatever spelling the link's target gives", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir, call } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', followSymlinks: true, include: ['*.json', 'via/**', 'ELSE/**'] },
  ]);
  // Disk spells the first file outside the include, and the link's target spells it inside it.
  writeFileSync(join(dir, 'Y.JSON'), 'outside the include as disk spells it\n');
  symlinkSync('y.json', join(dir, 'x.json'));
  // And the other way round: a covered file the link's target spells otherwise reads through.
  writeFileSync(join(dir, 'k.json'), '{"covered": 1}\n');
  symlinkSync('K.JSON', join(dir, 'w.json'));
  // A listing from where a link leads judges each file there as disk spells its directory, too.
  mkdirSync(join(dir, 'else', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'else', 'sub', 'y.txt'), 'outside the include as disk spells it\n');
  symlinkSync('ELSE', join(dir, 'via'));
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/x.json' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false);
  assert.ok(String(read.error).endsWith('Symlink escape detected: work/x.json'), String(read.error));
  await assert.rejects(workspace.readFileFromDisk('work/x.json'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'escape');
  await call('sync', {});
  assert.equal((((await call('grep', { path: 'work', pattern: 'outside the include' })).structured) as { totalMatches: number }).totalMatches, 0);
  assert.match(JSON.stringify((await call('read', { path: 'work/w.json' })).structured), /covered/);
  const listing = JSON.stringify((await call('ls', { path: 'work/via/sub' })).data);
  assert.ok(!listing.includes('y.txt'), listing);
});

test("a covered name whose file disk spells otherwise is outside the include, judged as disk spells it", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', include: ['gate.json'] },
  ]);
  writeFileSync(join(dir, 'GATE.JSON'), '{}\n');
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/gate.json' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false);
  assert.match(String(read.error), /"work\/gate\.json" is outside the mount's include/);
});

test("a segment on a path's way that isn't a directory and that the include doesn't cover is named as disk spells it, as every answer but the include's own refusal names a path", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', include: ['*.json'] },
  ]);
  writeFileSync(join(dir, 'secret.txt'), 'outside the include\n');
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'a.json'), '{}\n');
  symlinkSync('real', join(dir, 'link'));
  for (const [path, given, disk, segment] of [['work/SECRET.TXT/a.json', 'SECRET.TXT', 'secret.txt', 'secret.txt'], ['work/LINK/a.json', 'LINK', '"work/link"', 'link']] as const) {
    // Nothing beneath it is served, and the refusal names the segment in the one spelling, disk's, and never
    // as the caller spelled it.
    const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(read.success, false, path);
    assert.ok(String(read.error).includes(disk) && !String(read.error).includes(given), `${path}: ${read.error}`);
    let message = '';
    await assert.rejects(workspace.readFileFromDisk(path), (err: unknown) => { message = String((err as Error).message); return err instanceof WorkspaceReadError; });
    assert.ok(message.includes(disk) && !message.includes(given), `${path}: ${message}`);
    const deleted = await workspace.handleToolCall({ id: 'delete', name: 'delete', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(deleted.success, false, path);
    assert.ok(String(deleted.error).includes(disk) && !String(deleted.error).includes(given), `${path}: ${deleted.error}`);
    // What a sync of the path says it skipped names it the same way.
    const synced = JSON.stringify(await workspace.handleToolCall({ id: 'sync', name: 'sync', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]));
    assert.ok(!synced.includes(given), `${path}: ${synced}`);
    // Beneath a link the mount doesn't follow, the sync names what it skipped in disk's spelling; beneath a
    // file, there's nothing to take in or skip.
    if (segment === 'link') assert.ok(synced.includes('link/a.json'), `the sync names what it skipped in disk's spelling: ${synced}`);
    else assert.ok(synced.includes('"totalSynced":0') && !synced.includes('skipped'), `nothing beneath a file: ${synced}`);
  }
  // The include's own refusal answers the path asked about, as given.
  const outside = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/SECRET.TXT' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(outside.success, false);
  assert.match(String(outside.error), /"work\/SECRET\.TXT" is outside the mount's include/);
});

test("a path is judged as disk spells it, and the include's own refusal shows it as given", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', followSymlinks: true, include: ['LINK/**', 'real/**'] },
  ]);
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'a.txt'), 'covered where it lands\n');
  symlinkSync('real', join(dir, 'link'));
  // Disk spells the path `link/a.txt`, which `LINK/**` doesn't cover.
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/LINK/a.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false);
  assert.match(String(read.error), /"work\/LINK\/a\.txt" is outside the mount's include/);
});

test("a link's target is judged and named as disk spells it, on a mount that doesn't follow links", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'work', path: d, mode: 'read-write', watch: 'never', include: ['*.json'] },
  ]);
  // The link's target spells a file inside the include that disk spells outside it, and the other way round.
  writeFileSync(join(dir, 'Y.JSON'), 'outside the include as disk spells it\n');
  symlinkSync('y.json', join(dir, 'l.json'));
  writeFileSync(join(dir, 'k.json'), '{}\n');
  symlinkSync('K.JSON', join(dir, 'w.json'));
  const said = async (path: string): Promise<string> => {
    let message = '';
    await assert.rejects(workspace.readFileFromDisk(path), (err: unknown) => { message = String((err as Error).message); return err instanceof WorkspaceReadError; });
    return message;
  };
  // A link on a path's way is described by where it leads; one at the path itself is refused as a link.
  const uncovered = await said('work/l.json/a.json');
  assert.ok(!/y\.json/i.test(uncovered), uncovered);
  assert.match(await said('work/w.json/a.json'), /"work\/w\.json" is a symlink to "work\/k\.json"/);
});

test("a key no spelling names, as an earlier version stored, spells no path a write takes", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir, call } = await setup(t);
  // What an earlier version stored for `work/Docs/`, a key with a trailing separator.
  const store = (workspace as unknown as { getStore(): JsStore }).getStore();
  const bytes = Buffer.from('stale\n');
  store.treeSet('workspace/work/tree', 'Docs/', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.length, mode: 0o644 });
  await call('write', { path: 'work/docs/new.txt', content: 'new\n' });
  assert.deepEqual(readdirSync(dir).sort(), ['docs', 'src'], 'the directory takes the caller\'s spelling, not the stale key\'s');
});

test("past the innermost nested mount's directory a path stays as given, with two levels nested", { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'a', 'b'), { recursive: true });
    // Disk has the file, so taken as disk spells it the tail would be `x.txt`.
    writeFileSync(join(d, 'a', 'b', 'x.txt'), 'the inner mount\'s\n');
    return [
      { name: 'work', path: d, mode: 'read-write', watch: 'never' },
      { name: 'inner1', path: join(d, 'a'), mode: 'read-write', watch: 'never' },
      { name: 'inner2', path: join(d, 'a', 'b'), mode: 'read-write', watch: 'never' },
    ];
  });
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/a/B/X.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false);
  assert.match(String(read.error), /use "inner2\/X\.txt"/);
});

// Past a nested mount's directory a path is that mount's, and its own include
// decides what a tool may name there, so the outer mount's answers show the
// rest of the path as given. The directory itself takes disk's spelling, as a
// listing names it.
test('past a nested mount\'s directory, an answer shows the path as given', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'hidden.txt'), 'hidden\n');
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
    ];
  });
  for (const name of ['HIDDEN.TXT', 'NOPE.TXT']) {
    const path = `outer/INNER/${name}`;
    const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(read.error, `"outer/inner/${name}" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/${name}".`);
    await assert.rejects(workspace.readFileFromDisk(path),
      (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount' && err.message === read.error);
    for (const tool of ['ls', 'glob', 'grep', 'sync', 'materialize']) {
      const input = tool === 'glob' || tool === 'grep' ? { path, pattern: 'h' } : { path };
      const answer = JSON.stringify(await workspace.handleToolCall({ id: tool, name: tool, input } as Parameters<WorkspaceModule['handleToolCall']>[0]));
      assert.ok(answer.includes(`inner/${name}`), `${tool} ${path}: ${answer}`);
      assert.ok(!answer.includes('hidden.txt'), `${tool} ${path} shows disk's spelling: ${answer}`);
    }
  }
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
    assert.match(err.message, /it (?:lies|may lie) in mount "nested", nested in mount "outer": .*use "nested\/sub" in place of "outer\/l"/);
    return true;
  });
});

test('resolveAbsolutePath takes a nested mount\'s directory in any spelling disk folds to it as that mount\'s', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never', include: ['a.json'] },
    ];
  });
  // Configured and listed as `inner`, so the last three spell it neither way.
  for (const path of ['outer/inner/x.txt', 'outer/INNER/x.txt', 'outer/Inner/x.txt', 'outer/INNER']) {
    assert.equal(workspace.resolveAbsolutePath(path), null, path);
  }
  assert.notEqual(workspace.resolveAbsolutePath('outer/src/a.ts'), null, "the outer mount's own file");
});

test('resolveAbsolutePath takes a nested mount\'s directory where the real roots place it as that mount\'s in any spelling disk folds to it, as it does the configured one', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'real', 'inner'), { recursive: true });
    writeFileSync(join(d, 'real', 'inner', 'x.txt'), 'inner\n');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      // Configured through a link: its directory is link/inner as configured, and real/inner where disk has it.
      { name: 'inner', path: join(d, 'link', 'inner'), mode: 'read-write', watch: 'never' },
    ];
  });
  for (const path of ['outer/real/inner/x.txt', 'outer/REAL/inner/x.txt', 'outer/real/INNER/x.txt', 'outer/link/INNER/x.txt']) {
    assert.equal(workspace.resolveAbsolutePath(path), null, path);
  }
  assert.notEqual(workspace.resolveAbsolutePath('outer/src/a.ts'), null, "the outer mount's own file");
});

test('resolveAbsolutePath takes a nested mount\'s directory in the other normalization form as that mount\'s, on every disk', async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'caf\u00e9'), { recursive: true });
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'cafe', path: join(d, 'caf\u00e9'), mode: 'read-write', watch: 'never' },
    ];
  });
  for (const path of ['outer/caf\u00e9/x.txt', 'outer/cafe\u0301/x.txt']) assert.equal(workspace.resolveAbsolutePath(path), null, path);
});

test('on a disk that tells case apart, a directory spelled otherwise than a nested mount\'s only in case is no mount\'s: the tools refuse it saying the workspace can\'t tell the two apart, resolveAbsolutePath gives null, and a listing passes over it',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const { workspace, call, dir } = await setup(t, (d) => {
      mkdirSync(join(d, 'inner'), { recursive: true });
      mkdirSync(join(d, 'Inner'), { recursive: true });
      writeFileSync(join(d, 'Inner', 'x.txt'), 'outer\n');
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
        { name: 'inner', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
      ];
    });
    const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/Inner/x.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(read.error, '"outer/Inner/x.txt" may lie in mount "inner", nested in mount "outer", which neither reads nor writes it: this workspace can\'t tell ' +
      '"outer/Inner" from "outer/inner", mount "inner"\'s directory. If you meant that mount\'s directory, use "inner/x.txt". If you meant one of this mount\'s own, ' +
      'for a new file use a path outside "outer/Inner" and "outer/inner", and for one already there ask whoever runs this workspace to rename one of "outer/Inner" and "outer/inner".');
    const wrote = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/Inner/x.txt', content: 'written\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.match(String(wrote.error), /^"outer\/Inner\/x\.txt" may lie in mount "inner", nested in mount "outer"/);
    assert.equal(readFileSync(join(dir, 'Inner', 'x.txt'), 'utf8'), 'outer\n');
    assert.equal(workspace.resolveAbsolutePath('outer/Inner/x.txt'), null);
    const listed = await call('ls', { path: 'outer', recursive: true });
    assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
  });

async function twoDeepRig(t: TestContext, followSymlinks: boolean, alphaInclude: string[] = ['keep.md']) {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-two-deep-'));
  const dir = join(root, 'mount');
  for (const d of [['a', 'Bin'], ['a', 'bin'], ['A', 'Bin']]) mkdirSync(join(dir, ...d), { recursive: true });
  writeFileSync(join(dir, 'a', 'Bin', 'secret.md'), 'taken in before the nesting\n');
  writeFileSync(join(dir, 'a', 'bin', 'x.md'), "bin's\n");
  writeFileSync(join(dir, 'A', 'Bin', 'hidden.md'), 'taken in before the nesting\n');
  writeFileSync(join(dir, 'a', 'keep.md'), 'kept\n');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const work: MountConfig = { name: 'work', path: dir, mode: 'read-write', watch: 'never', ...(followSymlinks ? { followSymlinks: true } : {}) };
  const before = new WorkspaceModule({ mounts: [work] });
  before.initStore(store);
  await before.start(ctx);
  const synced = await before.handleToolCall({ id: 's', name: 'sync', input: {} } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(synced.success, true, String(synced.error));
  const held = await before.handleToolCall({ id: 'ls', name: 'ls', input: { path: 'work', recursive: true } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.deepEqual((held.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path).sort(), ['A/Bin/hidden.md', 'a/Bin/secret.md', 'a/bin/x.md', 'a/keep.md']);
  await before.stop();
  for (const [link, target] of [['l', 'a/Bin/secret.md'], ['m', 'a/keep.md'], ['b', 'a/bin/x.md'], ['h', 'A/Bin/hidden.md'], ['d', 'a/Bin']]) symlinkSync(target!, join(dir, link!));
  const workspace = new WorkspaceModule({ mounts: [
    work,
    { name: 'alpha', path: join(dir, 'a'), mode: 'read-write', watch: 'never', include: alphaInclude },
    { name: 'bin', path: join(dir, 'a', 'bin'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const tool = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  return { workspace, tool };
}

test('on a disk that tells case apart, a place in a nested mount\'s directory is named by a listing only where each nested mount that may hold it names it, out to the first that surely holds it', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const { tool } = await twoDeepRig(t, false);
  const listed = await tool('ls', { path: 'work', recursive: true });
  assert.equal(listed.success, true, String(listed.error));
  const entries = (listed.data as { entries: Array<{ path: string; note?: string }> }).entries;
  assert.deepEqual(entries.map((e) => e.path), ['a/bin/x.md', 'a/keep.md', 'b', 'd', 'h', 'l', 'm']);
  assert.equal(entries[0]!.note, 'it lies in mount "bin", nested in this one: use "bin/x.md"');
  const inA = await tool('ls', { path: 'work/a' });
  assert.deepEqual((inA.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name), ['bin', 'keep.md']);
  const status = await tool('status', { mount: 'work' });
  assert.equal((status.data as { work: { fileCount: number } }).work.fileCount, 2);
});

test('on a disk that tells case apart, a link into a nested mount\'s directory names the place only where each nested mount that may hold it names it, out to the first that surely holds it, followed or not', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const code = (read: Promise<unknown>) => read.then(() => 'read', (err: unknown) => (err as WorkspaceReadError).code);
  const unfollowed = await twoDeepRig(t, false);
  const u = async (link: string) => String((await unfollowed.tool('read', { path: `work/${link}` })).error);
  for (const link of ['l', 'h']) {
    assert.equal(await u(link), `work/${link}: "work/${link}" is a symlink, which this mount does not follow`);
    assert.equal(await code(unfollowed.workspace.readFileFromDisk(`work/${link}`)), 'symlink', link);
  }
  assert.match(await u('m'), /lies in mount "alpha", nested in mount "work": use "alpha\/keep\.md" in place of "work\/m"$/);
  assert.match(await u('b'), /lies in mount "bin", nested in mount "work": use "bin\/x\.md" in place of "work\/b"$/);
  assert.match(await u('d'), /may lie in mount "bin", nested in mount "work".*use "bin" in place of "work\/d"/);
  for (const link of ['m', 'b', 'd']) assert.equal(await code(unfollowed.workspace.readFileFromDisk(`work/${link}`)), 'other_mount', link);
  const followed = await twoDeepRig(t, true);
  const f = async (link: string) => String((await followed.tool('read', { path: `work/${link}` })).error);
  for (const link of ['l', 'h']) {
    assert.equal(await f(link), `Symlink escape detected: work/${link}`);
    assert.equal(await code(followed.workspace.readFileFromDisk(`work/${link}`)), 'escape', link);
  }
  assert.equal(await f('m'), '"work/m" leads into mount "alpha", nested in mount "work", which neither reads nor writes it: use "alpha/keep.md".');
  assert.equal(await f('b'), '"work/b" leads into mount "bin", nested in mount "work", which neither reads nor writes it: use "bin/x.md".');
  assert.match(await f('d'), /^"work\/d" may lead into mount "bin", nested in mount "work".*use "bin"\./);
  for (const link of ['m', 'b', 'd']) assert.equal(await code(followed.workspace.readFileFromDisk(`work/${link}`)), 'other_mount', link);
});

test('on a disk that tells case apart, each nested mount that may hold a place judges it by the place\'s own path beneath that mount\'s root', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const unfollowed = await twoDeepRig(t, false, ['keep.md', 'Bin/**']);
  const listed = await unfollowed.tool('ls', { path: 'work', recursive: true });
  const secret = (listed.data as { entries: Array<{ path: string; note?: string }> }).entries.find((e) => e.path === 'a/Bin/secret.md');
  assert.match(String(secret?.note), /^it may lie in mount "bin", nested in this one: .*use "bin\/secret\.md"/, JSON.stringify(listed.data));
  assert.match(String((await unfollowed.tool('read', { path: 'work/l' })).error), /may lie in mount "bin", nested in mount "work".*use "bin\/secret\.md" in place of "work\/l"/);
  const followed = await twoDeepRig(t, true, ['keep.md', 'Bin/**']);
  assert.match(String((await followed.tool('read', { path: 'work/l' })).error), /^"work\/l" may lead into mount "bin", nested in mount "work".*use "bin\/secret\.md"/);
});

test('a nested mount\'s directory is matched level by level as any disk may compare names: in either normalization form and in any case, as fully as a disk that folds names may, at every level', () => {
  const m = { dir: 'fold/m' };
  assert.equal(beneathNested(['fold', 'm', 'x.txt'], m), true);
  assert.equal(beneathNested(['fold', 'M', 'x.txt'], m), true, 'another case');
  assert.equal(beneathNested(['FOLD', 'm'], m), true, 'another case at the level above');
  assert.equal(beneathNested(['fold', 'n'], m), false, 'another name');
  assert.equal(beneathNested(['fold'], m), false, 'a path above the directory is not in it');
  assert.equal(beneathNested([''], { dir: '\u200d' }), false, 'the mount\'s root, beside a directory named only by a default-ignorable code point');
  assert.equal(beneathNested(['\u200b'], { dir: '\u200d' }), true, 'a name of only another default-ignorable code point');
  for (const [given, dir, what] of [
    ['cafe\u0301', 'caf\u00e9', 'the other normalization form'],
    ['CAFE\u0301', 'caf\u00e9', 'the other form in another case'],
    ['\u0436', '\u0416', 'case past ASCII'],
    ['STRASSE', 'stra\u00dfe', 'a pair only a full folding joins'],
    ['strasse', 'stra\u00dfe', 'that pair in lower case'],
    ['in\u00adner', 'inner', 'a soft hyphen'],
    ['in\u200dner', 'inner', 'a zero-width joiner'],
    ['inner\ufe0f', 'inner', 'a variation selector'],
    ['\u03aa\u0301', '\u0390', 'Greek letters whose case mapping decomposes'],
    ['\u03b1\u0345\u0313', '\u1f80', 'marks in another order around a combining ypogegrammeni, whose upper case is a letter'],
  ] as const) assert.equal(beneathNested([given, 'x.txt'], { dir }), true, what);
  assert.equal(restBeneath('STRASSE/a/b', { dir: 'stra\u00dfe' }), 'a/b');
  assert.equal(restBeneath('cafe\u0301', { dir: 'caf\u00e9' }), '');
  const real = (...segments: string[]) => ['', ...segments].join(sep);
  const inner = { dir: 'm', name: 'inner', real: real('w', 'sub', 'm') };
  assert.equal(nestedRootAtReal(real('w', 'sub', 'M', 'x.txt'), [inner])?.depth, 4);
  assert.equal(nestedRootAtReal(real('w', 'SUB', 'm', 'x.txt'), [inner])?.depth, 4, 'another case at a level above the root');
  assert.equal(nestedRootAtReal(real('w', 'sub', 'n', 'x.txt'), [inner]), undefined, 'another name');
  const looks = [
    { dir: 'cafe\u0301', name: 'nfd', real: real('w', 'cafe\u0301') },
    { dir: 'caf\u00e9', name: 'nfc', real: real('w', 'caf\u00e9') },
  ];
  assert.equal(nestedRootAtReal(real('w', 'caf\u00e9', 'x.txt'), looks)?.mount.name, 'nfc');
  assert.equal(nestedRootAtReal(real('w', 'cafe\u0301', 'x.txt'), [...looks].reverse())?.mount.name, 'nfd');
  assert.equal(nestedHolder('caf\u00e9/x.txt', looks)?.name, 'nfc');
  assert.equal(nestedHolder('cafe\u0301/x.txt', [...looks].reverse())?.name, 'nfd');
  assert.equal(nestedHolder('inner/x.txt', [{ dir: 'inner', name: 'guessed', guessed: true }, { dir: 'inner', name: 'placed' }])?.name, 'placed',
    'a directory start placed surely before one it only guessed at');
  assert.equal(nestedHolder('a/caf\u00e9/x.txt', [{ dir: 'a', name: 'shallow' }, { dir: 'a/cafe\u0301', name: 'deep' }])?.name, 'deep',
    'the deeper first, even where only the comparison\'s guess joins the path to it');
  assert.deepEqual(realSegments(sep), ['']);
  assert.deepEqual(realSegments(real('data')), ['', 'data']);
  assert.equal(beneathRoot(real('data', 'inner'), sep), 'data/inner');
  assert.equal(beneathRoot(sep, sep), undefined, 'the root itself lies beneath nothing');
  assert.equal(sameRoot(sep, sep), true);
  assert.equal(nestedRootAtReal(real('x', 'y'), [{ dir: 'x', name: 'all', real: sep }])?.depth, 1);
});

test('before a start, a name in another case than a nested mount\'s directory may lie in it, and is refused saying so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-unstarted-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(dir, 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  const wrote = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/INNER/new.md', content: 'x\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(wrote.success, false);
  assert.match(String(wrote.error), /^"outer\/INNER\/new\.md" may lie in mount "inner", nested in mount "outer"/);
});

test('a followed link\'s landing beneath a placement start only guessed at is named as the landing spells it, beside the nested directory\'s spelling where the landing matches it only loosely', async () => {
  const real = (...segments: string[]) => ['', 'workspace-path-spelling-not-on-disk', ...segments].join(sep);
  const inner = { dir: 'inner', guessed: true as const, name: 'inner', real: real('cafe\u0301', 'inner') };
  const at = { name: 'outer', rootReal: real('caf\u00e9') };
  assert.deepEqual((await nestedAtReal(real('caf\u00e9', 'inner', 'x.txt'), [inner], at))?.guess, { placed: 'outer/inner', leads: 'outer/inner/x.txt' });
  assert.deepEqual((await nestedAtReal(real('caf\u00e9', 'INNER', 'x.txt'), [inner], at))?.guess, { placed: 'outer/INNER', dir: 'outer/inner', leads: 'outer/INNER/x.txt' });
});

test('a path lies surely in a nested mount\'s directory only where each level is exact, and otherwise a text naming that mount shows what the workspace can\'t tell apart', () => {
  const nested = { dir: 'sub/inner' };
  assert.equal(nestedGuess('outer', ['sub', 'inner', 'x.md'], nested), undefined, 'exact');
  const shown = (given: string, dir: string) => ({ given, dir });
  assert.deepEqual(nestedGuess('outer', ['sub', 'INNER', 'x.md'], nested), shown('outer/sub/INNER', 'outer/sub/inner'), 'another case, on any disk');
  assert.deepEqual(nestedGuess('outer', ['SUB', 'INNER'], nested), shown('outer/SUB/INNER', 'outer/sub/inner'), 'another case at each level');
  assert.deepEqual(nestedGuess('outer', ['caf\u00e9', 'INNER'], { dir: 'cafe\u0301/inner' }), shown('outer/caf\\u00e9/INNER', 'outer/cafe\\u0301/inner'), 'another form above another case');
  assert.deepEqual(nestedGuess('outer', ['caf\u00e9', 'x.txt'], { dir: 'cafe\u0301' }), shown('outer/caf\\u00e9', 'outer/cafe\\u0301'), 'one name in NFC, shown by its code points');
  assert.deepEqual(nestedGuess('outer', ['SUB', 'caf\u00e9'], { dir: 'sub/cafe\u0301' }), shown('outer/SUB/caf\\u00e9', 'outer/sub/cafe\\u0301'), 'each level shown as it differs');
  assert.deepEqual(nestedGuess('outer', ['\u{1d15e}'], { dir: '\u{1d157}\u{1d165}' }), shown('outer/\\u{1d15e}', 'outer/\\u{1d157}\\u{1d165}'), 'past the BMP');
  assert.deepEqual(nestedGuess('outer', ['strasse'], { dir: 'stra\u00dfe' }), shown('outer/strasse', 'outer/stra\\u00dfe'), 'a pair only a full folding joins');
  assert.deepEqual(nestedGuess('outer', ['in\u00adner'], { dir: 'inner' }), shown('outer/in\\u00adner', 'outer/inner'), 'a default-ignorable code point, which a disk that folds case may keep');
  assert.deepEqual(nestedGuess('outer', ['ilik'], { dir: '\u0131l\u0131k' }), shown('outer/ilik', 'outer/\\u0131l\\u0131k'), 'a dotless i beside its look-alike');
  assert.deepEqual(nestedGuess('outer', ['\u10d0'], { dir: '\u1c90' }), shown('outer/\\u10d0', 'outer/\\u1c90'), 'case past ASCII, which a disk with an older folding table may keep apart');
  assert.deepEqual(nestedGuess('outer', ['caf\u00e9-\\u00e9'], { dir: 'cafe\u0301-\\u00e9' }), shown('outer/caf\\u00e9-\\\\u00e9', 'outer/cafe\\u0301-\\\\u00e9'), 'a backslash of the name\'s own, doubled');
  assert.deepEqual(nestedGuess('outer', ['inner', 'x.txt'], { dir: 'inner', guessed: true }), { placed: 'outer/inner' }, 'a placement start only guessed at, however exactly the path matches');
  assert.deepEqual(nestedGuess('outer', ['INNER', 'x.txt'], { dir: 'inner', guessed: true }), { placed: 'outer/INNER', dir: 'outer/inner' }, 'a guessed placement before any guess beneath it');
  const inner = (guess?: ReturnType<typeof nestedGuess>) => ({ name: 'inner', use: 'inner/x.txt', ...(guess === undefined ? {} : { guess }) });
  assert.equal(nestedStep(inner(), { after: ' in its place' }), 'use "inner/x.txt" in its place');
  assert.equal(nestedStep(inner(shown('outer/caf\\u00e9', 'outer/cafe\\u0301')), { named: true }),
    'this workspace can\'t tell "outer/caf\\u00e9" from "outer/cafe\\u0301", mount "inner"\'s directory. If you meant that mount\'s directory, use "inner/x.txt". ' +
    'If you meant one of this mount\'s own, for a new file use a path outside "outer/caf\\u00e9" and "outer/cafe\\u0301", and for one already there ask whoever runs this workspace to rename one of "outer/caf\\u00e9" and "outer/cafe\\u0301"');
  assert.equal(nestedStep(inner({ ...shown('outer/sub/INNER', 'outer/sub/inner'), leads: 'outer/sub/INNER/x.txt' }), { after: ' in its place' }),
    'it leads to "outer/sub/INNER/x.txt", and this workspace can\'t tell "outer/sub/INNER" from "outer/sub/inner", mount "inner"\'s directory. ' +
    'If you meant that mount\'s directory, use "inner/x.txt" in its place. If not, ask whoever runs this workspace to rename one of "outer/sub/INNER" and "outer/sub/inner"');
  assert.equal(nestedStep(inner({ placed: 'outer/inner' }), { named: true }),
    'this workspace can\'t tell whether "outer/inner" is mount "inner"\'s directory, since the two mounts\' roots are configured in spellings it can\'t tell apart. ' +
    'If you meant that mount\'s directory, use "inner/x.txt". If you meant one of this mount\'s own, for a new file use a path outside "outer/inner", and for one ' +
    'already there ask whoever runs this workspace to check where the two mounts are configured');
  assert.equal(nestedStep(inner({ placed: 'outer/INNER', dir: 'outer/inner' }), { named: true, after: ' in its place' }),
    'this workspace can\'t tell whether "outer/INNER" is mount "inner"\'s directory, since the two mounts\' roots are configured in spellings it can\'t tell apart. ' +
    'If you meant that mount\'s directory, use "inner/x.txt" in its place. If you meant one of this mount\'s own, for a new file use a path outside "outer/INNER" ' +
    'and "outer/inner", and for one already there ask whoever runs this workspace to check where the two mounts are configured');
  assert.equal(nestedStep(inner({ placed: 'outer/inner', leads: 'outer/inner/x.txt' })),
    'it leads to "outer/inner/x.txt", and this workspace can\'t tell whether "outer/inner" is mount "inner"\'s directory, since the two mounts\' roots are configured in ' +
    'spellings it can\'t tell apart. If you meant that mount\'s directory, use "inner/x.txt". If not, ask whoever runs this workspace to check where the two mounts are configured');
  assert.equal(nestedStep(inner(null), { after: ' in its place' }),
    'this workspace can\'t tell whether where it leads is that mount\'s directory. If you meant that mount\'s directory, use "inner/x.txt" in its place; if not, ask whoever runs this workspace');
});

test('on a disk that tells case apart, a link into a directory the comparison only guessed is a nested mount\'s is refused saying so, followed or not', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const madeAfterStart = (dir: string) => {
    mkdirSync(join(dir, 'sub', 'INNER'));
    writeFileSync(join(dir, 'sub', 'INNER', 'x.txt'), "the outer mount's\n");
  };
  const unfollowed = await nestedRig(t, 'sub/inner', { before: (d) => {
    mkdirSync(join(d, 'sub'));
    symlinkSync(join('sub', 'INNER', 'x.txt'), join(d, 'l'));
  } });
  madeAfterStart(unfollowed.dir);
  const since = 'mount "inner"\'s directory. If you meant that mount\'s directory';
  const remedy = 'If not, ask whoever runs this workspace to rename one of "outer/sub/INNER" and "outer/sub/inner"';
  const read = await unfollowed.tool('read', { path: 'outer/l', offsetChars: 0, limitChars: 100 });
  assert.equal(read.success, false);
  assert.equal(read.error, 'outer/l: "outer/l" is a symlink to "outer/sub/INNER/x.txt", which this mount does not follow; it may lie in mount "inner", ' +
    `nested in mount "outer": this workspace can't tell "outer/sub/INNER" from "outer/sub/inner", ${since}, use "inner/x.txt" in place of "outer/l". ${remedy}`);
  const followed = await nestedRig(t, 'sub/inner', { follow: true, before: (d) => {
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'l'), 'a file at first\n');
  } });
  assert.equal((await followed.tool('sync', {})).success, true);
  madeAfterStart(followed.dir);
  rmSync(join(followed.dir, 'l'));
  symlinkSync(join('sub', 'INNER', 'x.txt'), join(followed.dir, 'l'));
  const leads = 'it leads to "outer/sub/INNER/x.txt", and this workspace can\'t tell "outer/sub/INNER" from "outer/sub/inner"';
  assert.equal((await followed.tool('read', { path: 'outer/l', offsetChars: 0, limitChars: 100 })).error,
    `"outer/l" may lead into mount "inner", nested in mount "outer", which neither reads nor writes it: ${leads}, ${since}, use "inner/x.txt". ${remedy}.`);
  const sync = await followed.tool('sync', {});
  const skipped = ((sync.data as { skipped?: Array<{ path?: string; reason: string }> }).skipped ?? []).find((e) => e.path === 'l');
  assert.equal(skipped?.reason, `disk could not be checked: "outer/l" may lead into mount "inner", nested in mount "outer": ${leads}, ${since}, use "inner/x.txt" in its place. ${remedy}`, JSON.stringify(sync.data));
});

test('on a disk that tells case apart, a followed link whose landing outside the mount the comparison only guessed is a nested mount\'s shows no path of the host', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-outside-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join('..', 'elsewhere'), join(dir, 'linkdir'));
  symlinkSync(join('linkdir', 'INNER', 'x.txt'), join(dir, 'l'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: join(dir, 'linkdir', 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'elsewhere', 'INNER'));
  writeFileSync(join(root, 'elsewhere', 'INNER', 'x.txt'), 'elsewhere\n');
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/l', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.error, '"outer/l" may lead into mount "inner", nested in mount "outer", which neither reads nor writes it: this workspace can\'t tell whether where it leads ' +
    'is that mount\'s directory. If you meant that mount\'s directory, use "inner/x.txt"; if not, ask whoever runs this workspace.');
  assert.ok(!String(read.error).includes(root), 'no path of the host');
});

test('on a disk that keeps the normalization forms apart, a nested mount start placed only by its root\'s other form may lie there, and is refused naming no host path', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-placed-'));
  const nfc = join(root, 'caf\u00e9');
  const nfd = join(root, 'cafe\u0301');
  mkdirSync(join(nfc, 'inner'), { recursive: true });
  writeFileSync(join(nfc, 'inner', 'x.txt'), "the outer mount's own\n");
  mkdirSync(join(nfd, 'inner'), { recursive: true });
  writeFileSync(join(nfd, 'inner', 'y.txt'), "the inner mount's\n");
  symlinkSync(join('inner', 'x.txt'), join(nfc, 'l'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: nfc, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: join(nfd, 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  try {
    await workspace.start(ctx);
  } finally {
    console.warn = warn;
  }
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.ok(warnings.some((w) => w.includes('contains mount "inner" where it may lie on disk, at inner/')), warnings.join('\n'));
  const read = (path: string) => workspace.handleToolCall({ id: 'r', name: 'read', input: { path, offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const told = 'this workspace can\'t tell whether "outer/inner" is mount "inner"\'s directory, since the two mounts\' roots are configured in spellings it can\'t tell ' +
    'apart. If you meant that mount\'s directory, use "inner/x.txt".';
  const direct = (await read('outer/inner/x.txt')).error;
  assert.equal(direct, `"outer/inner/x.txt" may lie in mount "inner", nested in mount "outer", which neither reads nor writes it: ${told} If you meant one of this ` +
    'mount\'s own, for a new file use a path outside "outer/inner", and for one already there ask whoever runs this workspace to check where the two mounts are configured.');
  const linked = (await read('outer/l')).error;
  assert.equal(linked, `"outer/l" may lead into mount "inner", nested in mount "outer", which neither reads nor writes it: it leads to "outer/inner/x.txt", and ${told} ` +
    'If not, ask whoever runs this workspace to check where the two mounts are configured.');
  for (const error of [direct, linked]) assert.ok(!String(error).includes(root), 'no path of the host');
});

test('on a disk that keeps the normalization forms apart, a placement start guessed at is named as the path or the link spells it, by its code points where the path guessed at it too', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-placed-forms-'));
  const nfc = join(root, 'caf\u00e9');
  mkdirSync(join(nfc, 'na\u00efve'), { recursive: true });
  writeFileSync(join(nfc, 'na\u00efve', 'x.txt'), "the outer mount's own\n");
  symlinkSync(join('na\u00efve', 'x.txt'), join(nfc, 'l'));
  const nfd = join(root, 'cafe\u0301', 'nai\u0308ve');
  mkdirSync(nfd, { recursive: true });
  writeFileSync(join(nfd, 'y.txt'), "the inner mount's\n");
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const warn = console.warn;
  console.warn = () => {};
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: nfc, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'inner', path: nfd, mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  try {
    await workspace.start(ctx);
  } finally {
    console.warn = warn;
  }
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (path: string) => workspace.handleToolCall({ id: 'r', name: 'read', input: { path, offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const told = 'this workspace can\'t tell whether "outer/na\\u00efve" is mount "inner"\'s directory, since the two mounts\' roots are configured in spellings it can\'t ' +
    'tell apart. If you meant that mount\'s directory, use "inner/x.txt".';
  assert.equal((await read('outer/na\u00efve/x.txt')).error, `"outer/na\u00efve/x.txt" may lie in mount "inner", nested in mount "outer", which neither reads nor writes it: ${told} ` +
    'If you meant one of this mount\'s own, for a new file use a path outside "outer/na\\u00efve" and "outer/nai\\u0308ve", and for one already there ask whoever runs this ' +
    'workspace to check where the two mounts are configured.');
  assert.equal((await read('outer/l')).error, '"outer/l" may lead into mount "inner", nested in mount "outer", which neither reads nor writes it: it leads to ' +
    `"outer/na\\u00efve/x.txt", and ${told} If not, ask whoever runs this workspace to check where the two mounts are configured.`);
});

test('on a disk that keeps the normalization forms apart, start\'s warning names where a nested mount lies surely and where it only may', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-warning-'));
  const nfc = join(root, 'caf\u00e9');
  mkdirSync(nfc);
  mkdirSync(join(root, 'cafe\u0301', 'real'), { recursive: true });
  symlinkSync(join(root, 'cafe\u0301', 'real'), join(nfc, 'inner'));
  symlinkSync(nfc, join(root, 'alias'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: nfc, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(root, 'alias', 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  try {
    await workspace.start(ctx);
  } finally {
    console.warn = warn;
  }
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.ok(warnings.includes('[workspace] Mount "outer" contains mount "inner" where it lies on disk, at inner/, and where it may lie on disk, at real/ ' +
    '— passing over it as another mount\'s directory'), warnings.join('\n'));
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/inner/x.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.error, '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
});

test('on a disk that keeps the normalization forms apart, a directory start placed both surely and by a guess is placed surely', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-both-ways-'));
  const nfc = join(root, 'caf\u00e9');
  mkdirSync(nfc);
  mkdirSync(join(root, 'cafe\u0301', 'inner'), { recursive: true });
  writeFileSync(join(root, 'cafe\u0301', 'inner', 'x.txt'), "the inner mount's\n");
  symlinkSync(join(root, 'cafe\u0301', 'inner'), join(nfc, 'inner'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: nfc, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(nfc, 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/inner/x.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.error, '"outer/inner/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
});

test('on a disk that keeps the normalization forms apart, of two placements at one depth, the one a path matches exactly names the mount', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-two-placements-'));
  const dir = join(root, 'outer');
  mkdirSync(join(dir, 'cafe\u0301'), { recursive: true });
  writeFileSync(join(dir, 'cafe\u0301', 'x.txt'), "the inner mount's\n");
  symlinkSync('cafe\u0301', join(dir, 'caf\u00e9'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(dir, 'caf\u00e9'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/cafe\u0301/x.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.error, '"outer/cafe\u0301/x.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/x.txt".');
});

test('on a disk that keeps the normalization forms apart, a directory in the other form of a nested mount\'s is refused showing both by their code points', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const { tool } = await nestedRig(t, 'cafe\u0301', { history: ['caf\u00e9/held.txt'], before: (d) => {
    mkdirSync(join(d, 'caf\u00e9'));
    writeFileSync(join(d, 'caf\u00e9', 'x.txt'), "the outer mount's\n");
  } });
  const told = 'this workspace can\'t tell "outer/caf\\u00e9" from "outer/cafe\\u0301", mount "inner"\'s directory. If you meant that mount\'s directory, use';
  assert.equal((await tool('read', { path: 'outer/caf\u00e9/x.txt', offsetChars: 0, limitChars: 100 })).error,
    `"outer/caf\u00e9/x.txt" may lie in mount "inner", nested in mount "outer", which neither reads nor writes it: ${told} "inner/x.txt". ` +
    'If you meant one of this mount\'s own, for a new file use a path outside "outer/caf\\u00e9" and "outer/cafe\\u0301", and for one already there ask whoever runs this workspace to rename one of "outer/caf\\u00e9" and "outer/cafe\\u0301".');
  const listed = (await tool('ls', { path: 'outer', recursive: true })).data as { entries: Array<{ path: string; note?: string }> };
  assert.equal(listed.entries.find((e) => e.path === 'caf\u00e9/held.txt')?.note,
    `it may lie in mount "inner", nested in this one: ${told} "inner/held.txt". If not, ask whoever runs this workspace to rename one of "outer/caf\\u00e9" and "outer/cafe\\u0301"`, JSON.stringify(listed));
});

test('on a disk that folds case, a name in another case than a nested mount\'s directory lies in it where disk has the directory to spell the path by, and otherwise may, and is refused saying so', { skip: FOLDING_ONLY }, async (t) => {
  const absent = await nestedRig(t, 'inner');
  assert.equal((await absent.tool('write', { path: 'outer/INNER/new.md', content: 'x\n' })).error,
    '"outer/INNER/new.md" may lie in mount "inner", nested in mount "outer", which neither reads nor writes it: this workspace can\'t tell "outer/INNER" from ' +
    '"outer/inner", mount "inner"\'s directory. If you meant that mount\'s directory, use "inner/new.md". If you meant one of this mount\'s own, for a new file use a path ' +
    'outside "outer/INNER" and "outer/inner", and for one already there ask whoever runs this workspace to rename one of "outer/INNER" and "outer/inner".');
  const present = await nestedRig(t, 'inner', { before: (d) => mkdirSync(join(d, 'inner')) });
  assert.equal((await present.tool('write', { path: 'outer/INNER/new.md', content: 'x\n' })).error,
    '"outer/inner/new.md" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/new.md".');
});

test('where disk folds case and keeps \u00df apart from ss, a directory spelled with ss beside a nested mount at \u00df is that mount\'s, erring toward it', { skip: CASE_NOT_SHARP_S_ONLY }, async (t) => {
  const { workspace, call } = await setup(t, (d) => {
    mkdirSync(join(d, 'stra\u00dfe'), { recursive: true });
    mkdirSync(join(d, 'strasse'), { recursive: true });
    writeFileSync(join(d, 'strasse', 'x.txt'), 'outer\n');
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'nested', path: join(d, 'stra\u00dfe'), mode: 'read-write', watch: 'never' },
    ];
  });
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/strasse/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.error, '"outer/strasse/x.txt" may lie in mount "nested", nested in mount "outer", which neither reads nor writes it: this workspace can\'t tell ' +
    '"outer/strasse" from "outer/stra\\u00dfe", mount "nested"\'s directory. If you meant that mount\'s directory, use "nested/x.txt". If you meant one of this ' +
    'mount\'s own, for a new file use a path outside "outer/strasse" and "outer/stra\\u00dfe", and for one already there ask whoever runs this workspace to rename one of "outer/strasse" and "outer/stra\\u00dfe".');
  assert.equal(workspace.resolveAbsolutePath('outer/strasse/x.txt'), null);
  const listed = await call('ls', { path: 'outer', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
});

test('resolveAbsolutePath takes a nested mount\'s directory in another case as that mount\'s, whether or not it was on disk at start', async (t) => {
  const { workspace, dir } = await setup(t, (d) => [
    { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
    { name: 'later', path: join(d, 'later'), mode: 'read-write', watch: 'never' },
  ]);
  mkdirSync(join(dir, 'later'), { recursive: true });
  // A spelling that may reach the directory gives null, as one that does.
  for (const path of ['outer/later/x.txt', 'outer/LATER/x.txt']) assert.equal(workspace.resolveAbsolutePath(path), null, path);
  assert.notEqual(workspace.resolveAbsolutePath('outer/src/a.ts'), null, "the outer mount's own file");
  // And so after a start that finds the directory.
  await workspace.stop();
  await workspace.start({ isRestart: true, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  for (const path of ['outer/later/x.txt', 'outer/LATER/x.txt']) assert.equal(workspace.resolveAbsolutePath(path), null, `${path} after a start found later`);
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

test('before its first start, resolveAbsolutePath takes a nested mount\'s directory in another case as that mount\'s', (t) => {
  const { workspace } = nestedWorkspace(t, 'never');
  for (const path of ['outer/inner/x.txt', 'outer/INNER/x.txt']) assert.equal(workspace.resolveAbsolutePath(path), null, path);
});

test('before its first start, each level of a nested mount\'s directory is compared loosely, and the outer mount\'s own paths resolve', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-unstarted-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'a', 'caf\u00e9'), { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'deep', path: join(dir, 'a', 'caf\u00e9'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  // Another case at the first level, and the other normalization form at the second.
  for (const path of ['outer/a/caf\u00e9/x.txt', 'outer/A/caf\u00e9/x.txt', 'outer/a/cafe\u0301/x.txt', 'outer/A/CAFE\u0301/x.txt']) {
    assert.equal(workspace.resolveAbsolutePath(path), null, path);
  }
  assert.equal(workspace.resolveAbsolutePath('outer/a/x.txt'), join(dir, 'a', 'x.txt'), "the outer mount's own path");
});

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
    // Nor do the two links make the directory look as if it folds case.
    assert.equal(await foldsCase(root), false);
  });

test("a walk through a link that spells a directory above a nested mount's otherwise than disk does passes over that mount's directory", { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-walk-alias-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'a', 'sub', 'in'), { recursive: true });
  writeFileSync(join(dir, 'a', 'sub', 'in', 'secret.txt'), 'not the nested mount\'s\n');
  writeFileSync(join(dir, 'a', 'sub', 'in', 'kept.json'), '{}\n');
  writeFileSync(join(dir, 'a', 'sub', 'own.txt'), 'the outer mount\'s\n');
  // The link spells the directory above the nested one in another case than disk does.
  symlinkSync('A', join(dir, 'x'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'nested', path: join(dir, 'a', 'sub', 'in'), mode: 'read-write', watch: 'never', include: ['*.json'] },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const tool = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(res.success, true, `${name}: ${String(res.error)}`);
    return (res.structured ?? res.data) as Record<string, unknown>;
  };
  const listing = await tool('ls', { path: 'outer/x/sub', recursive: true });
  assert.deepEqual((listing.entries as Array<{ path: string }>).map((e) => e.path), ['x/sub/own.txt']);
  const synced = await tool('sync', { path: 'outer/x/sub' });
  // The nested root was passed over as another mount's directory, not left as one the walk didn't reach.
  assert.ok(JSON.stringify(synced.passedOver ?? []).includes("another mount's directory"), JSON.stringify(synced));
  assert.ok(!JSON.stringify([listing, synced]).includes('not visited'), JSON.stringify([listing, synced]));
  const grepped = await tool('grep', { path: 'outer/x/sub', pattern: 'mount' });
  assert.deepEqual((grepped.results as Array<{ file: string }>).map((r) => r.file), ['outer/x/sub/own.txt']);
  const answers = JSON.stringify([listing, synced, grepped]);
  assert.ok(!answers.includes('secret') && !answers.includes('kept.json'), answers);
});

test('through a link that spells a nested mount\'s directory otherwise than disk, that mount\'s include judges the place', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-nested-include-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  writeFileSync(join(dir, 'inner', 'kept.json'), '{}\n');
  writeFileSync(join(dir, 'inner', 'hidden.txt'), 'not the nested mount\'s\n');
  symlinkSync('INNER/kept.json', join(dir, 'k.json'));
  symlinkSync('INNER/hidden.txt', join(dir, 'h.txt'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'nested', path: join(dir, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const code = async (path: string): Promise<string> => {
    let answer = '';
    await assert.rejects(workspace.readFileFromDisk(path), (err: unknown) => {
      assert.ok(err instanceof WorkspaceReadError, String(err));
      answer = `${err.code}: ${err.message}`;
      return true;
    });
    return answer;
  };
  assert.match(await code('outer/k.json'), /^other_mount: .*use "nested\/kept\.json"/);
  assert.equal(await code('outer/h.txt'), 'escape: Symlink escape detected: outer/h.txt');
  const synced = await workspace.handleToolCall({ id: 'sync', name: 'sync', input: { path: 'outer/h.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.deepEqual((synced.data as { skipped: unknown[] }).skipped, [{ mount: 'outer', path: 'h.txt', reason: 'disk could not be checked: a symlink that leaves the mount' }]);
});

test('through a link that spells a nested mount\'s directory otherwise than disk, the outer mount reads, lists, writes and makes nothing there', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'x.txt'), 'nested\n');
    writeFileSync(join(d, 'own.txt'), 'not nested\n');
    symlinkSync('INNER/x.txt', join(d, 'f.txt'));
    symlinkSync('INNER', join(d, 'k'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'nested', path: join(d, 'inner'), mode: 'read-write', watch: 'never' },
    ];
  });
  const tool = (name: string, input: Record<string, unknown>) =>
    workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  for (const path of ['outer/f.txt', 'outer/k/x.txt', 'outer/k/X.TXT']) {
    const read = await tool('read', { path });
    assert.equal(read.success, false, path);
    assert.match(String(read.error), /(?:leads|may lead) into mount "nested", nested in mount "outer".*use "nested\/x\.txt"/, path);
  }
  await assert.rejects(workspace.readFileFromDisk('outer/f.txt'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
  for (const [path, content] of [['outer/f.txt', 'outer\n'], ['outer/k/new.txt', 'outer\n']] as const) {
    const wrote = await tool('write', { path, content });
    assert.equal(wrote.success, false, path);
    assert.match(String(wrote.error), /(?:leads|may lead) into mount "nested"/, path);
  }
  const listed = await tool('ls', { path: 'outer/k' });
  assert.deepEqual((listed.data as { entries: unknown[] }).entries, []);
  assert.match(JSON.stringify((listed.data as { incomplete: unknown[] }).incomplete), /(?:leads|may lead) into mount \\"nested\\"/);
  const grepped = await tool('grep', { path: 'outer', pattern: 'nested' });
  assert.deepEqual((grepped.structured as { results: Array<{ file: string }> }).results.map((r) => r.file), ['outer/own.txt']);
  assert.equal(readFileSync(join(dir, 'inner', 'x.txt'), 'utf8'), 'nested\n');
  assert.deepEqual(readdirSync(join(dir, 'inner')), ['x.txt']);
});

test('a link that spells a directory as disk does is refused as leading into a nested mount configured in another spelling', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'x.txt'), 'nested\n');
    symlinkSync('inner', join(d, 'kd'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'nested', path: join(d, 'INNER'), mode: 'read-write', watch: 'never' },
    ];
  });
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'outer/kd/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false);
  assert.match(String(read.error), /^"outer\/kd\/x\.txt" (?:leads|may lead) into mount "nested", nested in mount "outer".*use "nested\/x\.txt"/);
  await assert.rejects(workspace.readFileFromDisk('outer/kd/x.txt'), (err: unknown) => err instanceof WorkspaceReadError && err.code === 'other_mount');
});

test('a mount configured through a link that spells the outer mount\'s root otherwise than disk is found nested in it at start', { skip: FOLDING_ONLY }, async (t) => {
  const warned: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  const { workspace, call } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'x.txt'), 'nested\n');
    const root = join(d, '..');
    symlinkSync(join(root, basename(d).toUpperCase(), 'inner'), join(root, 'alias'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'nested', path: join(root, 'alias'), mode: 'read-write', watch: 'never' },
    ];
  });
  assert.ok(warned.some((w) => /contains mount "nested" where it (?:lies|may lie) on disk, at inner\//.test(w)), JSON.stringify(warned));
  const listed = await call('ls', { path: 'outer', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'outer/inner/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.match(String(read.error), /^"outer\/inner\/x\.txt" (?:lies|may lie) in mount "nested", nested in mount "outer".*use "nested\/x\.txt"/);
  assert.equal(workspace.resolveAbsolutePath('outer/inner/x.txt'), null);
});

test('a nested mount\'s directory renamed in another case since start, or made since in another case, is still that mount\'s', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir } = await setup(t, (d) => {
    mkdirSync(join(d, 'fold', 'm'), { recursive: true });
    writeFileSync(join(d, 'fold', 'm', 'x.txt'), 'nested\n');
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never' },
      { name: 'nested', path: join(d, 'fold', 'm'), mode: 'read-write', watch: 'never' },
      { name: 'later', path: join(d, 'late', 'n'), mode: 'read-write', watch: 'never' },
    ];
  });
  renameSync(join(dir, 'fold', 'm'), join(dir, 'fold', 'tmp'));
  renameSync(join(dir, 'fold', 'tmp'), join(dir, 'fold', 'M'));
  mkdirSync(join(dir, 'late', 'N'), { recursive: true });
  writeFileSync(join(dir, 'late', 'N', 'y.txt'), 'later\n');
  const tool = (name: string, input: Record<string, unknown>) =>
    workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  for (const [path, refusal] of [
    ['outer/fold/M/x.txt', /may lie in mount "nested", nested in mount "outer".*can't tell "outer\/fold\/M" from "outer\/fold\/m", mount "nested"'s directory\. If you meant that mount's directory, use "nested\/x\.txt"\. If you meant one of this mount's own/],
    ['outer/late/N/y.txt', /may lie in mount "later", nested in mount "outer".*can't tell "outer\/late\/N" from "outer\/late\/n", mount "later"'s directory\. If you meant that mount's directory, use "later\/y\.txt"\. If you meant one of this mount's own/],
  ] as const) {
    const read = await tool('read', { path });
    assert.equal(read.success, false, path);
    assert.match(String(read.error), refusal, path);
    const wrote = await tool('write', { path: path.replace(/[xy]\.txt$/, 'new.txt'), content: 'outer\n' });
    assert.equal(wrote.success, false, path);
  }
  const listed = await tool('ls', { path: 'outer', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
  const above = await tool('ls', { path: 'outer/fold' });
  assert.deepEqual((above.data as { entries: unknown[] }).entries, [], JSON.stringify(above.data));
  assert.deepEqual(readdirSync(join(dir, 'fold', 'M')), ['x.txt']);
});

test('a mount whose configured path reaches the outer mount\'s root through a directory spelled otherwise than disk is nested by its configured path', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-through-'));
  mkdirSync(join(root, 'o'));
  writeFileSync(join(root, 'o', 'x.txt'), "the outer mount's\n");
  mkdirSync(join(root, 'e'));
  symlinkSync(join(root, 'e'), join(root, 'o', 'via'));
  symlinkSync(join(root, 'o'), join(root, 'e', 'self'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: join(root, 'o'), mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'self', path: join(root, 'O', 'via', 'self'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'outer/via/self/x.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.match(String(read.error), /^"outer\/via\/self\/x\.txt" (?:lies|may lie) in mount "self", nested in mount "outer", which neither reads nor writes it: .*use "self\/x\.txt"/);
});

test('a mount configured as a link to the outer mount\'s own root, spelled otherwise than disk, is nested by its configured path alone, and refuses none of the outer mount\'s other paths', { skip: FOLDING_ONLY }, async (t) => {
  // The link's target spells the outer root otherwise, which realpath keeps on Linux.
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-self-'));
  mkdirSync(join(root, 'outer'));
  writeFileSync(join(root, 'outer', 'x.txt'), "the outer mount's\n");
  symlinkSync(join(root, 'OUTER'), join(root, 'outer', 'self'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: join(root, 'outer'), mode: 'read-write', watch: 'never', followSymlinks: true },
    { name: 'self', path: join(root, 'outer', 'self'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const tool = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const read = await tool('read', { path: 'outer/x.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { content: string } | undefined)?.content, "the outer mount's\n", String(read.error));
  const write = await tool('write', { path: 'outer/y.txt', content: 'outer wrote\n' });
  assert.equal(write.success, true, String(write.error));
  const through = await tool('read', { path: 'outer/self/x.txt' });
  assert.equal(through.error, '"outer/self/x.txt" lies in mount "self", nested in mount "outer", which neither reads nor writes it: use "self/x.txt".');
});

test('a nested mount whose root isn\'t made yet holds a place beneath it before the mount it\'s nested in does', async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'a'), { recursive: true });
    symlinkSync('a', join(d, 'l'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'upper', path: join(d, 'a'), mode: 'read-write', watch: 'never' },
      { name: 'lower', path: join(d, 'a', 'b'), mode: 'read-write', watch: 'never' },
    ];
  });
  const wrote = await workspace.handleToolCall({ id: 'write', name: 'write', input: { path: 'outer/l/b/new.txt', content: 'x\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(wrote.success, false);
  assert.equal(wrote.error, '"outer/l/b/new.txt" leads into mount "lower", nested in mount "outer", which neither reads nor writes it: use "lower/new.txt".');
});

for (const { letter, as, gate } of [
  { letter: '\u00df', as: 'ss', gate: SHARP_S_FOLDING_ONLY },
  { letter: '\u017f', as: 's', gate: LONG_S_FOLDING_ONLY },
  { letter: '\u03c2', as: '\u03c3', gate: FINAL_SIGMA_FOLDING_ONLY },
]) {
  test(`where disk folds ${letter} with ${as}, a nested mount's directory spelled with ${as} is that mount's through ${letter}, typed or by a link`, { skip: gate }, async (t) => {
    const { workspace } = await setup(t, (d) => {
      mkdirSync(join(d, 'x', `a${as}`), { recursive: true });
      writeFileSync(join(d, 'x', `a${as}`, 'hidden.txt'), 'nested\n');
      symlinkSync(`x/a${letter}`, join(d, 'l'));
      return [
        { name: 'outer', path: d, mode: 'read-write', watch: 'never', followSymlinks: true },
        { name: 'nested', path: join(d, 'x', `a${as}`), mode: 'read-write', watch: 'never' },
      ];
    });
    // Through the link, where it leads keeps the link's spelling where
    // realpath keeps it, as on Linux, so the refusal there can say it may lead.
    const typed = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: `outer/x/a${letter}/hidden.txt` } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.match(String(typed.error), /lies in mount "nested", nested in mount "outer".*: use "nested\/hidden\.txt"\.$/);
    const linked = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'outer/l/hidden.txt' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    if (process.platform === 'linux') {
      const esc = (name: string) => [...name].map((c) => (c.charCodeAt(0) < 0x80 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('');
      assert.equal(linked.error, `"outer/l/hidden.txt" may lead into mount "nested", nested in mount "outer", which neither reads nor writes it: it leads to ` +
        `"outer/x/a${esc(letter)}/hidden.txt", and this workspace can't tell "outer/x/a${esc(letter)}" from "outer/x/a${esc(as)}", mount "nested"'s directory. ` +
        `If you meant that mount's directory, use "nested/hidden.txt". If not, ask whoever runs this workspace to rename one of "outer/x/a${esc(letter)}" and "outer/x/a${esc(as)}".`);
    } else {
      assert.match(String(linked.error), /(leads into|may lead into) mount "nested", nested in mount "outer".*use "nested\/hidden\.txt"/);
    }
  });
}

test('through a link a mount follows into a nested mount, that mount\'s include judges the place as disk spells it', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace } = await setup(t, (d) => {
    mkdirSync(join(d, 'inner'), { recursive: true });
    writeFileSync(join(d, 'inner', 'A.JSON'), '{}\n');
    writeFileSync(join(d, 'inner', 'b.json'), '{}\n');
    symlinkSync('inner', join(d, 'k'));
    return [
      { name: 'outer', path: d, mode: 'read-write', watch: 'never', followSymlinks: true },
      { name: 'nested', path: join(d, 'inner'), mode: 'read-write', watch: 'never', include: ['*.json'] },
    ];
  });
  await assert.rejects(workspace.readFileFromDisk('outer/k/a.json'), (err: unknown) =>
    err instanceof WorkspaceReadError && err.code === 'escape' && !err.message.includes('nested'));
  await assert.rejects(workspace.readFileFromDisk('outer/k/B.JSON'), (err: unknown) =>
    err instanceof WorkspaceReadError && err.code === 'other_mount' && /use "nested\/b\.json"/.test(err.message));
});

test('on a disk that tells case apart, an empty directory with no letter in its name, or with a link at its flipped name, or that is a link to its flipped twin, tells case apart',
  { skip: CASE_SENSITIVE_ONLY }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-own-name-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '2025'));
    assert.equal(await foldsCase(join(root, '2025')), false, 'as the directory holding it');
    mkdirSync(join(root, 'proj'));
    symlinkSync('proj', join(root, 'PROJ'));
    assert.equal(await foldsCase(join(root, 'proj')), false, 'a link at the flipped name is another file');
    mkdirSync(join(root, 'LNK'));
    symlinkSync('LNK', join(root, 'lnk'));
    assert.equal(await foldsCase(join(root, 'lnk')), false, 'a root that is a link to its flipped twin is found as itself');
  });

test('a second draft spelled in another case is the first one, and a push writes one file', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call, pushed } = await setup(t, drafts);
  await call('write', { path: 'work/src/New.txt', content: 'first\n' });
  const second = await call('write', { path: 'work/src/NEW.txt', content: 'second\n' });
  assert.equal((second.data as { path: string }).path, 'work/src/New.txt');
  const listed = await call('ls', { path: 'work', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path).sort(), ['src/New.txt', 'src/a.ts']);
  const read = await call('read', { path: 'work/SRC/new.TXT', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/New.txt');
  assert.equal((read.structured as { content: string }).content, 'second\n');
  const materialized = await call('materialize', { mount: 'work' });
  assert.deepEqual(materialized.data, { materialized: [{ mount: 'work', path: 'src/New.txt' }], count: 1 });
  assert.deepEqual(readdirSync(join(dir, 'src')).sort(), ['New.txt', 'a.ts']);
  assert.equal(readFileSync(join(dir, 'src', 'New.txt'), 'utf8'), 'second\n');
  pushed();
  await call('sync', { mount: 'work' });
  assert.deepEqual(pushed(), [], 'a sync finds disk as the workspace has it');
});

test('two directory drafts that differ only in case are one directory', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call, pushed } = await setup(t, drafts);
  await call('sync', { mount: 'work' });
  pushed();
  await call('write', { path: 'work/Docs/a.txt', content: 'A\n' });
  const second = await call('write', { path: 'work/DOCS/b.txt', content: 'B\n' });
  assert.equal((second.data as { path: string }).path, 'work/Docs/b.txt');
  await call('materialize', { mount: 'work' });
  assert.deepEqual(readdirSync(dir).sort(), ['Docs', 'src']);
  assert.deepEqual(readdirSync(join(dir, 'Docs')).sort(), ['a.txt', 'b.txt']);
  pushed();
  await call('sync', { mount: 'work' });
  assert.deepEqual(pushed(), [], 'a sync moves no entry to another spelling');
});

test('a draft that disk lists in another case is reached by its own path, and deleting it leaves disk\'s file', { skip: FOLDING_ONLY }, async (t) => {
  const { dir, call } = await setup(t, drafts);
  await call('write', { path: 'work/src/Late.txt', content: 'draft\n' });
  // A file made on disk in another case before the draft is pushed: disk now
  // lists that spelling, and the workspace holds the draft under its own.
  writeFileSync(join(dir, 'src', 'LATE.txt'), 'made on disk\n');
  const read = await call('read', { path: 'work/src/Late.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/src/Late.txt');
  assert.equal((read.structured as { content: string }).content, 'draft\n');
  const deleted = await call('delete', { path: 'work/src/Late.txt' });
  assert.equal((deleted.data as { path: string }).path, 'work/src/Late.txt');
  const listed = await call('ls', { path: 'work', recursive: true });
  assert.ok(!(listed.data as { entries: Array<{ path: string }> }).entries.some((e) => e.path === 'src/Late.txt'), 'the draft is gone');
  assert.deepEqual(readdirSync(join(dir, 'src')).sort(), ['LATE.txt', 'a.ts']);
  assert.equal(readFileSync(join(dir, 'src', 'LATE.txt'), 'utf8'), 'made on disk\n');
});

test('a draft in a directory disk comes to list in another case is still reached by its own path', { skip: FOLDING_ONLY }, async (t) => {
  // Ezra-2423's probe: disk comes to list the draft's directory as docs
  // before the draft is materialized.
  const { dir, call } = await setup(t, drafts);
  await call('write', { path: 'work/Docs/a.txt', content: 'draft\n' });
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'x.txt'), 'made on disk\n');
  const read = await call('read', { path: 'work/Docs/a.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((read.structured as { path: string }).path, 'work/Docs/a.txt');
  assert.equal((read.structured as { content: string }).content, 'draft\n');
  const again = await call('write', { path: 'work/Docs/a.txt', content: 'again\n' });
  assert.equal((again.data as { path: string }).path, 'work/Docs/a.txt');
  const listed = await call('ls', { path: 'work', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path).filter((p) => p.toLowerCase() === 'docs/a.txt'), ['Docs/a.txt'], 'one entry');
  const deleted = await call('delete', { path: 'work/Docs/a.txt' });
  assert.equal((deleted.data as { path: string }).path, 'work/Docs/a.txt');
  assert.equal(readFileSync(join(dir, 'docs', 'x.txt'), 'utf8'), 'made on disk\n');
});

test('a file the workspace deleted, which disk comes to list in another case, is still reached by its own path', { skip: FOLDING_ONLY }, async (t) => {
  // Greptile's case on the pull request: a file taken in from disk, which
  // disk then lists in another case, deleted in the workspace with its disk
  // copy kept.
  const { workspace, dir, call } = await setup(t, drafts);
  writeFileSync(join(dir, 'src', 'Name.txt'), 'taken in\n');
  await call('sync', { path: 'work/src/Name.txt' });
  rmSync(join(dir, 'src', 'Name.txt'));
  writeFileSync(join(dir, 'src', 'NAME.txt'), 'taken in\n');
  const deleted = await call('delete', { path: 'work/src/Name.txt' });
  assert.equal((deleted.data as { path: string }).path, 'work/src/Name.txt');
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/src/Name.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false, 'the read takes nothing in');
  assert.match(String(read.error), /work\/src\/Name\.txt was deleted in the workspace/);
  await call('materialize', { path: 'work/src/Name.txt', applyDeletions: true });
  assert.deepEqual(readdirSync(join(dir, 'src')).sort(), ['a.ts'], 'the deletion reached disk\'s file');
  const listed = await call('ls', { path: 'work', recursive: true });
  assert.deepEqual((listed.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path), ['src/a.ts']);
});

test('a file the workspace deleted, which disk then changed and lists in another case, is in conflict by its own path, and a sync of that path settles it with one entry', { skip: FOLDING_ONLY }, async (t) => {
  const { workspace, dir, call } = await setup(t, drafts);
  writeFileSync(join(dir, 'src', 'Name.txt'), 'taken in\n');
  await call('sync', { path: 'work/src/Name.txt' });
  await call('delete', { path: 'work/src/Name.txt' });
  rmSync(join(dir, 'src', 'Name.txt'));
  writeFileSync(join(dir, 'src', 'NAME.txt'), 'changed on disk\n');
  const read = await workspace.handleToolCall({ id: 'read', name: 'read', input: { path: 'work/src/Name.txt', offsetChars: 0, limitChars: 100 } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, false, 'the read takes nothing in');
  assert.match(String(read.error), /work\/src\/Name\.txt is in conflict/);
  await call('sync', { path: 'work/src/Name.txt' });
  const status = (await call('status', {})).data as { work: { conflicts: number; pendingWorkspaceDeletions: number } };
  assert.deepEqual([status.work.conflicts, status.work.pendingWorkspaceDeletions], [0, 0], 'the sync settled the conflict and the deletion');
  const again = await call('read', { path: 'work/src/Name.txt', offsetChars: 0, limitChars: 100 });
  assert.equal((again.structured as { content: string }).content, 'changed on disk\n');
  const listed = await call('ls', { path: 'work', recursive: true });
  assert.equal((listed.data as { entries: Array<{ path: string }> }).entries.filter((e) => e.path.toLowerCase() === 'src/name.txt').length, 1, 'one entry for the file');
});

test('the step takes an entry\'s name where disk has nothing, keeps an entry\'s own spelling, and normalizes nothing', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-entries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'LATE.txt'), '');
  writeFileSync(join(root, 'src', 'Real.txt'), '');
  const entries = entriesOf(['src/New.txt', 'src/Late.txt', 'src/REAL.txt', 'src/caf\u00e9.txt', 'Docs/Sub/a.txt', 'DOCS/c.txt']);
  assert.equal(await diskSpelling(root, 'src/NEW.txt', entries), 'src/New.txt');
  assert.equal(await diskSpelling(root, 'src/Late.txt', entries), 'src/Late.txt', 'an entry\'s own spelling, where disk lists LATE.txt');
  assert.equal(await diskSpelling(root, 'SRC/Late.txt', entries), 'src/Late.txt', 'the last segment\'s, once the directory takes disk\'s spelling');
  mkdirSync(join(root, 'lower'));
  assert.equal(await diskSpelling(root, 'LOWER/a.txt', entriesOf(['LOWER/a.txt'])), 'LOWER/a.txt', 'a path at an entry kept whole, where disk lists its directory as lower');
  assert.equal(await diskSpelling(root, 'src/late.txt', entries), 'src/LATE.txt', 'disk\'s spelling first, where no entry has this one');
  assert.equal(await diskSpelling(root, 'src/Real.txt', entries), 'src/Real.txt', 'a name disk lists as given');
  assert.equal(await diskSpelling(root, 'Docs/d.txt', entries), 'Docs/d.txt', 'a directory spelled as an entry has it keeps that spelling, though DOCS comes first');
  assert.equal(await diskSpelling(root, 'docs/d.txt', entries), 'DOCS/d.txt', 'else the first in path order equal to it in lower case');
  assert.equal(await diskSpelling(root, 'docs/./SUB/b.txt', entriesOf(['Docs/Sub/a.txt'])), 'Docs/./Sub/b.txt', 'passing over . among entries');
  // Simple case folding, letter by letter, so a word's last Σ is σ and ς is
  // σ, ſ is s, µ is μ and ᾈ, whose upper case is two letters, is ᾀ; İ,
  // whose lower case is two letters, and dotless ı stay as they are.
  const greek = entriesOf(['src/\u039f\u0394\u039f\u03a3.txt', 'src/\u0130.txt', 'src/\u017foap.txt', 'src/\u00b5.txt', 'src/\u0131x.txt', 'src/\u1f80.txt']);
  assert.equal(await diskSpelling(root, 'src/\u03bf\u03b4\u03bf\u03c2.txt', greek), 'src/\u039f\u0394\u039f\u03a3.txt');
  assert.equal(await diskSpelling(root, 'src/\u03bf\u03b4\u03bf\u03c3.txt', greek), 'src/\u039f\u0394\u039f\u03a3.txt');
  assert.equal(await diskSpelling(root, 'src/i\u0307.txt', greek), 'src/i\u0307.txt');
  assert.equal(await diskSpelling(root, 'src/SOAP.txt', greek), 'src/\u017foap.txt');
  assert.equal(await diskSpelling(root, 'src/\u039c.txt', greek), 'src/\u00b5.txt');
  assert.equal(await diskSpelling(root, 'src/IX.txt', greek), 'src/IX.txt');
  assert.equal(await diskSpelling(root, 'src/\u1f88.txt', greek), 'src/\u1f80.txt');
  assert.equal(await diskSpelling(root, 'DOCS/../docs/b.txt', entries), 'DOCS/../docs/b.txt', 'a `..` among entries keeps the rest');
  assert.equal(await diskSpelling(root, 'src/CAFE\u0301.txt', entries), 'src/CAFE\u0301.txt', 'no entry is equal to it in lower case without normalizing');
  assert.equal(await diskSpelling(root, 'src/NEW.txt'), 'src/NEW.txt', 'without entries, as before');
  // A name with nothing to flip is looked up as given: disk has it, so no
  // entry spells it.
  writeFileSync(join(root, 'src', '\u03c2'), '');
  assert.equal(await diskSpelling(root, 'src/\u03c2', entriesOf(['src/\u03a3'])), 'src/\u03c2', 'disk lists \u03c2 as given');
  // Where disk has nothing for it, a draft's spelling stands, and where disk
  // lists it in another spelling, the listing settles it.
  mkdirSync(join(root, 'nv'));
  assert.equal(await diskSpelling(root, 'nv/\u03c2', entriesOf(['nv/\u03a3'])), 'nv/\u03a3', 'disk has no \u03c2 here');
  await t.test('a name with no variant that disk lists in a spelling only a fuller folding joins', { skip: FINAL_SIGMA_FOLDING_ONLY }, async () => {
    mkdirSync(join(root, 'fs'));
    writeFileSync(join(root, 'fs', '\u03c3'), '');
    assert.equal(await diskSpelling(root, 'fs/\u03c2', entriesOf(['fs/\u03c3'])), 'fs/\u03c3', 'disk lists \u03c3, which an entry spells');
  });
  // A path that names an entry reads no other entry, even where disk lacks
  // its directory or spells it otherwise.
  let listings = 0;
  let lookups = 0;
  const counted = entriesOf(['Gone/a.txt', 'LOWER/a.txt', 'lower/a.txt']);
  const counting = {
    ...counted,
    has: (path: string) => { lookups += 1; return counted.has(path); },
    under: (prefix: string) => { listings += 1; return counted.under(prefix); },
  };
  assert.equal(await diskSpelling(root, 'Gone/a.txt', counting), 'Gone/a.txt');
  assert.equal(await diskSpelling(root, 'LOWER/a.txt', counting), 'LOWER/a.txt');
  assert.equal(listings, 0, 'no entries listed for a path at an entry');
  assert.equal(lookups, 2, 'one lookup each, of the path itself');
  // Whether a directory folds case: the root's as read at start, and beneath
  // it, as the directory holding it did when the walk looked its name up
  // flipped, or for a name with no letter to flip, as the nearest above:
  // 2024 has no other spelling at all, and \u304c has another normalization
  // form but no case.
  mkdirSync(join(root, '2024'));
  mkdirSync(join(root, '\u304c'));
  assert.equal(await diskSpelling(root, 'src/NEW.txt', entriesOf(['src/New.txt'], false)), 'src/New.txt', 'src was found as SRC');
  assert.equal(await diskSpelling(root, 'DOCS/b.txt', entriesOf(['Docs/a.txt'], false)), 'DOCS/b.txt', 'the root, read at start as telling case apart');
  assert.equal(await diskSpelling(root, '2024/NEW.txt', entriesOf(['2024/New.txt'])), '2024/New.txt', 'as the root');
  assert.equal(await diskSpelling(root, '2024/NEW.txt', entriesOf(['2024/New.txt'], false)), '2024/NEW.txt', 'as the root');
  assert.equal(await diskSpelling(root, '\u304c/NEW.txt', entriesOf(['\u304c/New.txt'])), '\u304c/New.txt', 'as the root');
  assert.equal(await diskSpelling(root, '\u304c/NEW.txt', entriesOf(['\u304c/New.txt'], false)), '\u304c/NEW.txt', 'as the root');
});

test('a directory folds case if a name it lists does, flipped, or where none tells, if its own name does, or the directory holding it', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-folds-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A name with no letter to flip, so only a name it lists can tell.
  mkdirSync(join(root, '2024', 'src'), { recursive: true });
  assert.equal(await foldsCase(join(root, '2024')), true);
  mkdirSync(join(root, 'empty'));
  assert.equal(await foldsCase(join(root, 'empty')), true);
  mkdirSync(join(root, '2025'));
  assert.equal(await foldsCase(join(root, '2025')), true, 'as the directory holding it');
  // A root that is a link to an empty directory: Ezra-2423's probe.
  mkdirSync(join(root, 'real'));
  symlinkSync('real', join(root, 'proj'));
  assert.equal(await foldsCase(join(root, 'proj')), true, 'a link, found as itself under its flipped name');
});

test('a mount whose root is empty, or not there yet, at start takes a draft\'s spelling at its top level', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-new-roots-'));
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, '2026'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'empty', path: join(root, 'empty'), mode: 'read-write', watch: 'never' },
    { name: 'later', path: join(root, 'later'), mode: 'read-write', watch: 'never' },
    { name: 'digits', path: join(root, '2026'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const mount of ['empty', 'later', 'digits']) {
    const first = await workspace.handleToolCall({ id: 'w1', name: 'write', input: { path: `${mount}/Notes.md`, content: 'one\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(first.success, true, String(first.error));
    const second = await workspace.handleToolCall({ id: 'w2', name: 'write', input: { path: `${mount}/NOTES.md`, content: 'two\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal((second.data as { path: string }).path, `${mount}/Notes.md`, mount);
  }
});

test('an entry\'s spelling takes no path out of a nested mount\'s directory that holds it as disk spells it', { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-nested-entries-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  mkdirSync(join(dir, 'caf\u00e9'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'outer', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(dir, 'inner'), mode: 'read-write', watch: 'never' },
    { name: 'later', path: join(dir, 'later'), mode: 'read-write', watch: 'never' },
    { name: 'cafe', path: join(dir, 'caf\u00e9'), mode: 'read-write', watch: 'never' },
    { name: 'deep', path: join(dir, 'proj', 'inner'), mode: 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  // Entries the outer mount holds from before: a file named as the nested
  // mount inner's directory in another case, and one beneath that directory;
  // one beneath the directory of the nested mount later, which isn't on
  // disk, spelled as configured; one beneath cafe's directory in the other
  // normalization form; and one in another spelling of proj, the directory
  // that holds deep's, which isn't on disk either.
  const entry = { blobHash: 'a'.repeat(64), size: 1, mode: 0o100644 };
  store.treeSet('workspace/outer/tree', 'Inner', entry);
  store.treeSet('workspace/outer/tree', 'later/z.txt', entry);
  store.treeSet('workspace/outer/tree', 'cafe\u0301/x.txt', entry);
  store.treeSet('workspace/outer/tree', 'Proj/z.txt', entry);
  store.treeSet('workspace/outer/tree', 'inner/Late.txt', entry);
  const call = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const refusedAs = async (tool: string, input: { path: string; [field: string]: unknown }, mount: string) => {
    const result = await call(tool, input);
    assert.equal(result.success, false, input.path);
    assert.match(String(result.error), new RegExp(`lies in mount "${mount}"`), input.path);
  };
  // Disk's spelling puts each in a nested mount's directory: disk lists
  // Inner as inner and the NFD name as NFC, and has nothing for proj, so
  // the paths through it keep the configured spelling they're given. The
  // entry's spelling wouldn't.
  await refusedAs('read', { path: 'outer/Inner', offsetChars: 0, limitChars: 10 }, 'inner');
  await refusedAs('write', { path: 'outer/proj/inner/x.txt', content: 'x\n' }, 'deep');
  await refusedAs('write', { path: 'outer/proj/other/../inner/x.txt', content: 'x\n' }, 'deep');
  await t.test('in the other normalization form', { skip: NORMALIZATION_FOLDING_ONLY }, async () => {
    await refusedAs('read', { path: 'outer/cafe\u0301/x.txt', offsetChars: 0, limitChars: 10 }, 'cafe');
  });
  // Where both spellings lie in one nested mount's directory, the refusal
  // names disk's, as without the entries.
  const late = await call('write', { path: 'outer/inner/LATE.txt', content: 'x\n' });
  assert.equal(late.error, '"outer/inner/LATE.txt" lies in mount "inner", nested in mount "outer", which neither reads nor writes it: use "inner/LATE.txt".');
  // As configured, a path is later's.
  await refusedAs('write', { path: 'outer/later/y.txt', content: 'y\n' }, 'later');
  assert.match(String((await call('write', { path: 'outer/LATER/y.txt', content: 'y\n' })).error),
    /^"outer\/LATER\/y\.txt" may lie in mount "later", nested in mount "outer".*can't tell "outer\/LATER" from "outer\/later"/);
  // Outside deep's directory, the entry's spelling stands: beside it, and
  // for the directory that holds it.
  const sibling = await call('write', { path: 'outer/PROJ/z.txt', content: 'z\n' });
  assert.equal((sibling.data as { path: string }).path, 'outer/Proj/z.txt');
  const listed = await call('ls', { path: 'outer/PROJ' });
  assert.equal((listed.data as { path: string }).path, 'outer/Proj');
});

test('a stop made while start reads whether a mount\'s root folds case leaves the workspace stopped', async (t) => {
  const { workspace, ls } = nestedWorkspace(t, 'never');
  const original = fs.promises.readdir;
  let stopped: Promise<void> | undefined;
  fs.promises.readdir = ((path: fs.PathLike, ...rest: unknown[]) => {
    // Start lists the inner mount's root only for whether it folds case,
    // after it has placed the nested mounts: stop then.
    if (basename(String(path)) === 'inner') stopped ??= workspace.stop();
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  try {
    await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  } finally {
    fs.promises.readdir = original;
    syncBuiltinESMExports();
  }
  assert.notEqual(stopped, undefined, 'start listed a root');
  await stopped;
  const listed = await ls();
  assert.equal(listed.success, false);
  assert.match(String(listed.error), /The workspace has stopped/);
});

test('a restart takes no call while it reads whether a mount\'s root folds case', async (t) => {
  const { workspace, ls } = nestedWorkspace(t, 'never');
  let saved: unknown = null;
  const ctx = { isRestart: false, getState: () => saved, setState: (state: unknown) => { saved = state; }, pushEvent: () => {} };
  await workspace.start(ctx as unknown as ModuleContext);
  await workspace.stop();
  const original = fs.promises.readdir;
  let during: Promise<ToolResult> | undefined;
  fs.promises.readdir = ((path: fs.PathLike, ...rest: unknown[]) => {
    // Start lists the inner mount's root only for whether it folds case.
    if (basename(String(path)) === 'inner') during ??= ls();
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  try {
    await workspace.start({ ...ctx, isRestart: true } as unknown as ModuleContext);
  } finally {
    fs.promises.readdir = original;
    syncBuiltinESMExports();
  }
  assert.notEqual(during, undefined, 'start listed a root');
  const answer = await during!;
  assert.equal(answer.success, false);
  assert.match(String(answer.error), /The workspace has stopped/);
  const after = await ls();
  assert.equal(after.success, true, String(after.error));
});

test('on a disk that tells case apart, two drafts that differ only in case stay two files', { skip: CASE_SENSITIVE_ONLY }, async (t) => {
  const { dir, call } = await setup(t, drafts);
  await call('write', { path: 'work/src/New.txt', content: 'first\n' });
  const second = await call('write', { path: 'work/src/NEW.txt', content: 'second\n' });
  assert.equal((second.data as { path: string }).path, 'work/src/NEW.txt');
  await call('write', { path: 'work/DOCS/b.txt', content: 'B\n' });
  const third = await call('write', { path: 'work/docs/c.txt', content: 'C\n' });
  assert.equal((third.data as { path: string }).path, 'work/docs/c.txt');
  await call('materialize', { mount: 'work' });
  assert.deepEqual(readdirSync(join(dir, 'src')).sort(), ['NEW.txt', 'New.txt', 'a.ts']);
  assert.deepEqual(readdirSync(dir).sort(), ['DOCS', 'docs', 'src']);
});

test("only history the mount's include covers spells a draft's path: an entry the include leaves out, from before it, doesn't respell a covered one", { skip: FOLDING_ONLY }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'NOTES'), { recursive: true });
  writeFileSync(join(dir, 'NOTES', 'old.bin'), 'taken in before the include\n');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  let workspace: WorkspaceModule | undefined;
  t.after(async () => { await workspace?.stop(); if (!store.isClosed()) store.close(); rmSync(root, { recursive: true, force: true }); });
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const before = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never' }] });
  before.initStore(store);
  await before.start(ctx);
  const taken = JSON.stringify(await before.handleToolCall({ id: 's', name: 'sync', input: {} } as Parameters<WorkspaceModule['handleToolCall']>[0]));
  assert.ok(taken.includes('"synced":["NOTES/old.bin"]'), `history takes in the entry that could spell the directory: ${taken}`);
  await before.stop();
  // Disk no longer has the directory, so only history could spell it. It's removed by the spelling the write
  // names: a disk that keeps each spelling's lookup a while, as the test's passthrough does for a second,
  // would otherwise still show `notes` there.
  rmSync(join(dir, 'notes'), { recursive: true, force: true });
  assert.ok(!existsSync(join(dir, 'notes')), 'disk has no directory to spell the draft');
  workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never', include: ['notes/**'] }] });
  workspace.initStore(store);
  await workspace.start(ctx);
  const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/notes/new.md', content: 'covered\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(write.success, true, String(write.error));
  const read = await workspace.handleToolCall({ id: 'r', name: 'read', input: { path: 'work/notes/new.md' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(read.success, true, String(read.error));
  const listed = JSON.stringify(await workspace.handleToolCall({ id: 'l', name: 'ls', input: { path: 'work', recursive: true } } as Parameters<WorkspaceModule['handleToolCall']>[0]));
  assert.ok(listed.includes('notes/new.md') && !listed.includes('NOTES'), listed);
});

test("a draft in another case than a nested mount's directory, with history there that mount's include leaves out and nothing on disk, is refused as one that may lie in that mount", { skip: FOLDING_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-'));
  const dir = join(root, 'mount');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  writeFileSync(join(dir, 'inner', 'secret.md'), 'taken in before the nesting\n');
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  t.after(() => { if (!store.isClosed()) store.close(); rmSync(root, { recursive: true, force: true }); });
  const before = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never' }] });
  before.initStore(store);
  await before.start(ctx);
  const taken = JSON.stringify(await before.handleToolCall({ id: 's', name: 'sync', input: {} } as Parameters<WorkspaceModule['handleToolCall']>[0]));
  assert.ok(taken.includes('"synced":["inner/secret.md"]'), `history takes in the entry that spells the directory: ${taken}`);
  await before.stop();
  // Removed by the spelling the write names, as in the test above.
  rmSync(join(dir, 'INNER'), { recursive: true, force: true });
  assert.ok(!existsSync(join(dir, 'INNER')), 'disk has no directory to spell the draft');
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'work', path: dir, mode: 'read-write', watch: 'never' },
    { name: 'inner', path: join(dir, 'inner'), mode: 'read-write', watch: 'never', include: ['keep.md'] },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  try {
    const write = await workspace.handleToolCall({ id: 'w', name: 'write', input: { path: 'work/INNER/new.md', content: 'through the outer mount\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    assert.equal(write.success, false, `the outer mount took ${JSON.stringify(write.data)}`);
    assert.match(String(write.error), /^"work\/INNER\/new\.md" may lie in mount "inner", nested in mount "work".*can't tell "work\/INNER" from "work\/inner".*use "inner\/new\.md"/);
  } finally {
    await workspace.stop();
  }
});

async function nestedRig(t: TestContext, innerDir: string, opts: { history?: string[]; before?: (dir: string) => void; follow?: boolean; direct?: boolean; innerMode?: 'read-only' | 'read-write' } = {}) {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-nested-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const outer: MountConfig = { name: 'outer', path: dir, mode: 'read-write', watch: 'never', ...(opts.follow ? { followSymlinks: true } : {}), ...(opts.direct ? { backend: 'direct' as const } : {}) };
  if (opts.history) {
    for (const f of opts.history) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'history\n');
    }
    const before = new WorkspaceModule({ mounts: [outer] });
    before.initStore(store);
    await before.start(ctx);
    await before.handleToolCall({ id: 's', name: 'sync', input: {} } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    await before.stop();
    for (const top of readdirSync(dir)) rmSync(join(dir, top), { recursive: true, force: true });
  }
  opts.before?.(dir);
  const workspace = new WorkspaceModule({ mounts: [
    outer,
    { name: 'inner', path: join(dir, ...innerDir.split('/')), mode: opts.innerMode ?? 'read-write', watch: 'never' },
  ] });
  workspace.initStore(store);
  await workspace.start(ctx);
  t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const tool = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const listed = async (path: string) => ((await tool('ls', { path, recursive: true })).data as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
  return { dir, workspace, tool, listed };
}

function refusedAsInner(result: ToolResult, use: string, what: string): void {
  assert.equal(result.success, false, `${what}: the outer mount took it (${JSON.stringify(result.data)})`);
  assert.match(String(result.error), new RegExp(`(lies in|may lie in|leads into|may lead into) mount "inner", nested in mount "outer".*use "${use.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), what);
}

test('on a disk that keeps the normalization forms apart, a direct mount\'s write into a read-only nested mount\'s directory, in either form of its name, is refused, and nothing reaches the disk', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const { tool, dir } = await nestedRig(t, 'caf\u00e9', { direct: true, innerMode: 'read-only', before: (d) => {
    mkdirSync(join(d, 'caf\u00e9'));
    writeFileSync(join(d, 'caf\u00e9', 'x.txt'), 'inner\n');
  } });
  refusedAsInner(await tool('write', { path: 'outer/cafe\u0301/new.md', content: 'x\n' }), 'inner/new.md', 'the other form');
  refusedAsInner(await tool('write', { path: 'outer/caf\u00e9/new.md', content: 'x\n' }), 'inner/new.md', 'the same form');
  assert.deepEqual(readdirSync(join(dir, 'caf\u00e9')), ['x.txt']);
  assert.equal(existsSync(join(dir, 'cafe\u0301')), false, 'nothing was made in the other form');
});

test('where disk folds case, a direct mount\'s write into a read-only nested mount\'s directory spelled in another case is refused, and nothing reaches the disk', { skip: FOLDING_ONLY }, async (t) => {
  const { tool, dir } = await nestedRig(t, 'inner', { direct: true, innerMode: 'read-only', before: (d) => {
    mkdirSync(join(d, 'inner'));
    writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
  } });
  for (const path of ['outer/INNER/new.md', 'outer/Inner/new.md']) refusedAsInner(await tool('write', { path, content: 'x\n' }), 'inner/new.md', path);
  assert.deepEqual(readdirSync(join(dir, 'inner')), ['x.txt']);
});

test('a draft naming a nested mount\'s directory or its parent in another case is that mount\'s, with nothing there on disk or in history', { skip: FOLDING_ONLY }, async (t) => {
  for (const [innerDir, draft] of [['inner', 'INNER/new.md'], ['inner', 'Inner/new.md'], ['sub/inner', 'SUB/INNER/new.md'], ['sub/inner', 'Sub/inner/new.md']] as const) {
    const { tool } = await nestedRig(t, innerDir);
    refusedAsInner(await tool('write', { path: `outer/${draft}`, content: 'x\n' }), 'inner/new.md', draft);
  }
  const { tool } = await nestedRig(t, 'sub/inner');
  assert.equal((await tool('write', { path: 'outer/SUB/other.md', content: 'x\n' })).success, true);
});

test('a nested mount\'s directory or its parent on disk in another case, from before start or made since, is that mount\'s in any case', { skip: FOLDING_ONLY }, async (t) => {
  {
    const { tool } = await nestedRig(t, 'sub/inner', { before: (d) => mkdirSync(join(d, 'Sub')) });
    refusedAsInner(await tool('write', { path: 'outer/SUB/INNER/new.md', content: 'x\n' }), 'inner/new.md', 'the parent on disk at start as Sub');
  }
  for (const [innerDir, made, draft] of [['sub/inner', 'Sub', 'SUB/INNER/new.md'], ['inner', 'Inner', 'INNER/new.md']] as const) {
    const { tool, dir } = await nestedRig(t, innerDir);
    mkdirSync(join(dir, made));
    refusedAsInner(await tool('write', { path: `outer/${draft}`, content: 'x\n' }), 'inner/new.md', `${made} made after start`);
  }
  const { tool, dir, listed } = await nestedRig(t, 'inner', { before: (d) => { mkdirSync(join(d, 'inner')); writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n'); } });
  renameSync(join(dir, 'inner'), join(dir, 'renamed'));
  renameSync(join(dir, 'renamed'), join(dir, 'INNER'));
  refusedAsInner(await tool('read', { path: 'outer/INNER/x.txt' }), 'inner/x.txt', 'renamed by case after start');
  refusedAsInner(await tool('read', { path: 'outer/INNER/X.TXT' }), 'inner/X.TXT', 'past the directory, as given');
  assert.deepEqual(await listed('outer'), []);
});

test('a draft through history that spells a nested mount\'s parent otherwise is that mount\'s', { skip: FOLDING_ONLY }, async (t) => {
  for (const draft of ['Sub/INNER/new.md', 'sub/INNER/new.md']) {
    const { tool } = await nestedRig(t, 'sub/inner', { history: ['SUB/x.md'] });
    refusedAsInner(await tool('write', { path: `outer/${draft}`, content: 'x\n' }), 'inner/new.md', draft);
  }
});

test('a draft the outer mount held before a read-only mount was nested at its directory in another case is passed over by the outer mount\'s materialize', { skip: FOLDING_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-nested-draft-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  t.after(() => { if (!store.isClosed()) store.close(); rmSync(root, { recursive: true, force: true }); });
  const outer: MountConfig = { name: 'outer', path: dir, mode: 'read-write', watch: 'never' };
  const before = new WorkspaceModule({ mounts: [outer] });
  before.initStore(store);
  await before.start(ctx);
  const drafted = await before.handleToolCall({ id: 'w', name: 'write', input: { path: 'outer/INNER/x.txt', content: 'drafted before the nesting\n' } } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  assert.equal(drafted.success, true, String(drafted.error));
  await before.stop();
  mkdirSync(join(dir, 'inner'));
  const workspace = new WorkspaceModule({ mounts: [outer, { name: 'inner', path: join(dir, 'inner'), mode: 'read-only', watch: 'never' }] });
  workspace.initStore(store);
  await workspace.start(ctx);
  try {
    const call = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    const materialized = (await call('materialize', { mount: 'outer' })).data as { materialized: unknown[] };
    assert.deepEqual(materialized.materialized, [], JSON.stringify(materialized));
    assert.deepEqual(readdirSync(join(dir, 'inner')), [], "nothing written into the read-only mount's directory");
    const listed = ((await call('ls', { path: 'outer', recursive: true })).data as { entries: Array<{ path: string; note?: string }> }).entries;
    assert.deepEqual(listed.map((e) => [e.path, e.note]), [['INNER/x.txt', 'it may lie in mount "inner", nested in this one: this workspace can\'t tell "outer/INNER" from "outer/inner", ' +
      'mount "inner"\'s directory. If you meant that mount\'s directory, use "inner/x.txt". If not, ask whoever runs this workspace to rename one of "outer/INNER" and "outer/inner"']]);
  } finally {
    await workspace.stop();
  }
});

test('where disk folds \u00df with ss, a path typed with \u00df names a nested mount\'s directory at ss, whether or not the directory is on disk', { skip: SHARP_S_FOLDING_ONLY }, async (t) => {
  const empty = await nestedRig(t, 'strasse');
  refusedAsInner(await empty.tool('write', { path: 'outer/stra\u00dfe/new.md', content: 'x\n' }), 'inner/new.md', 'a draft typed with \u00df, nothing on disk');
  const onDisk = await nestedRig(t, 'strasse', { before: (d) => { mkdirSync(join(d, 'strasse')); writeFileSync(join(d, 'strasse', 'hidden.txt'), 'inner\n'); } });
  refusedAsInner(await onDisk.tool('read', { path: 'outer/stra\u00dfe/hidden.txt' }), 'inner/hidden.txt', 'typed with \u00df, on disk');
});

test('on a disk that keeps the normalization forms apart, a directory named in the other form of a nested mount\'s is that mount\'s: no mount\'s, refused rather than read', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const { tool, listed } = await nestedRig(t, 'caf\u00e9', { before: (d) => {
    mkdirSync(join(d, 'caf\u00e9'));
    mkdirSync(join(d, 'cafe\u0301'));
    writeFileSync(join(d, 'cafe\u0301', 'x.txt'), 'outer\n');
  } });
  refusedAsInner(await tool('read', { path: 'outer/cafe\u0301/x.txt' }), 'inner/x.txt', 'the other form');
  assert.deepEqual(await listed('outer'), []);
});

test('on a disk that keeps the normalization forms apart, a listing or glob through a link passes over a file named in the other form of a nested mount\'s directory, as one without the link does, and lists a link so named, which a read through it reads, on a chronicle mount and a direct one', { skip: NORMALIZATION_APART_ONLY }, async (t) => {
  const ctx = { isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext;
  for (const backend of ['chronicle', 'direct'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'workspace-path-spelling-alias-'));
    const dir = join(root, 'mount');
    mkdirSync(join(dir, 'caf\u00e9'), { recursive: true });
    writeFileSync(join(dir, 'cafe\u0301'), 'a file in the other form\n');
    writeFileSync(join(dir, 'a.txt'), "the outer mount's own\n");
    mkdirSync(join(dir, 'na\u00efve'));
    symlinkSync('a.txt', join(dir, 'nai\u0308ve'));
    symlinkSync('.', join(dir, 'alias'));
    const store = JsStore.openOrCreate({ path: join(root, 'store') });
    const outer: MountConfig = backend === 'direct'
      ? { name: 'outer', path: dir, mode: 'read-only', watch: 'never', followSymlinks: true, backend }
      : { name: 'outer', path: dir, mode: 'read-write', watch: 'never', followSymlinks: true };
    const workspace = new WorkspaceModule({ mounts: [
      outer,
      { name: 'inner', path: join(dir, 'caf\u00e9'), mode: 'read-write', watch: 'never' },
      { name: 'second', path: join(dir, 'na\u00efve'), mode: 'read-write', watch: 'never' },
    ] });
    workspace.initStore(store);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await workspace.start(ctx);
    } finally {
      console.warn = warn;
    }
    t.after(async () => { await workspace.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
    const tool = (name: string, input: unknown) => workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
    const paths = async (name: 'ls' | 'glob', input: unknown): Promise<string[]> => {
      const result = await tool(name, input);
      assert.equal(result.success, true, `${backend}, ${name}: ${result.error}`);
      const data = result.data as { entries?: Array<{ path: string }>; matches?: Array<{ path: string }> };
      return (data.entries ?? data.matches ?? []).map((e) => e.path).sort();
    };
    assert.deepEqual(await paths('ls', { path: 'outer', recursive: true }), ['a.txt', 'alias'], backend);
    assert.deepEqual(await paths('ls', { path: 'outer/alias', recursive: true }), ['alias/a.txt', 'alias/alias', 'alias/nai\u0308ve'], backend);
    assert.deepEqual(await paths('glob', { pattern: '*', path: 'outer/alias' }), ['outer/alias/a.txt', 'outer/alias/alias', 'outer/alias/nai\u0308ve'], backend);
    refusedAsInner(await tool('read', { path: 'outer/alias/cafe\u0301', offsetChars: 0, limitChars: 100 }), 'inner', `${backend}, a read through the link`);
    for (const path of ['outer/alias/a.txt', 'outer/alias/nai\u0308ve']) {
      const own = await tool('read', { path, offsetChars: 0, limitChars: 100 });
      assert.equal((own.structured as { content?: string } | undefined)?.content, "the outer mount's own\n", `${backend}, ${path}: ${own.error}`);
    }
  }
});

test('through a link the outer mount follows, a target that spells a nested mount\'s directory otherwise leads into it', { skip: FOLDING_ONLY }, async (t) => {
  const { tool, dir } = await nestedRig(t, 'inner', { follow: true, before: (d) => {
    mkdirSync(join(d, 'inner'));
    writeFileSync(join(d, 'inner', 'x.txt'), 'inner\n');
    symlinkSync('INNER', join(d, 'l'));
  } });
  refusedAsInner(await tool('read', { path: 'outer/l/x.txt' }), 'inner/x.txt', 'a read through the link');
  refusedAsInner(await tool('write', { path: 'outer/l/new.md', content: 'x\n' }), 'inner/new.md', 'a write through the link');
  assert.deepEqual(readdirSync(join(dir, 'inner')), ['x.txt']);
});
