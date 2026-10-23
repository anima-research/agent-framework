/**
 * glob and grep's glob filter take a mount-prefixed pattern, like every other
 * workspace path. Before, the pattern was matched only against paths relative
 * to the search root while results came back mount-prefixed, so
 * `notes/diary/2026-10-13.md` answered "no matches" for a file that was there.
 * A `**` path segment matches zero or more directories, so a pattern for every
 * `.ts` file under `project/src` also finds `project/src/main.ts`.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';

/** Two mounts; `project` has a subdirectory named like the other mount. Files
 *  are written straight to disk, as another process would. */
function setup(t: TestContext, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-glob-prefix-'));
  const dirs = { notes: join(root, 'notes'), project: join(root, 'project') };
  const files: Record<string, string> = {
    'notes/README.md': 'notes readme',
    'notes/diary/2026-10-12.md': 'entry twelve',
    'notes/diary/2026-10-13.md': 'entry thirteen',
    'project/README.md': 'project readme',
    'project/docs/guide.md': 'guide entry',
    'project/notes/todo.md': 'todo entry',
    'project/src/main.ts': 'export const entry = 1;',
    'project/src/lib/util.ts': 'export const helper = 2;',
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    const [mount, ...rest] = path.split('/');
    const full = join(dirs[mount as keyof typeof dirs], ...rest);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [
      { name: 'notes', path: dirs.notes, mode: 'read-write', watch: 'never' },
      { name: 'project', path: dirs.project, mode: 'read-write', watch: 'never' },
    ],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const glob = async (input: Record<string, unknown>) => {
    const r = await workspace.handleToolCall({ id: 'g', name: 'glob', input });
    assert.equal(r.success, true, JSON.stringify(r));
    return ((r.data as { matches: Array<{ path: string }> }).matches).map((m) => m.path).sort();
  };
  const grepFiles = async (input: Record<string, unknown>) => {
    const r = await workspace.handleToolCall({ id: 'r', name: 'grep', input });
    assert.equal(r.success, true, JSON.stringify(r));
    return ((r.data as { results: Array<{ file: string }> }).results).map((x) => x.file).sort();
  };
  return { glob, grepFiles };
}

test('a mount-prefixed pattern naming one file finds it', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: 'notes/diary/2026-10-13.md' }), ['notes/diary/2026-10-13.md']);
});

test('a mount-prefixed wildcard matches within that mount only', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: 'notes/diary/*.md' }), ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ pattern: 'project/**/*.md' }), ['project/README.md', 'project/docs/guide.md', 'project/notes/todo.md']);
  assert.deepEqual(await glob({ pattern: 'project/*.md' }), ['project/README.md']);
});

test('relative patterns match relative to every mount', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: '**/*.md' }), [
    'notes/README.md', 'notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md',
    'project/README.md', 'project/docs/guide.md', 'project/notes/todo.md',
  ]);
  assert.deepEqual(await glob({ pattern: '*.md' }), ['notes/README.md', 'project/README.md']);
  // In every other mount, a pattern whose first segment is a mount's name is
  // read as written: project/notes/ matches, beside the notes mount's root.
  assert.deepEqual(await glob({ pattern: 'notes/*.md' }), ['notes/README.md', 'project/notes/todo.md']);
});

test('with a path, the pattern may be relative to it or mount-prefixed', async (t) => {
  const { glob } = setup(t);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: '*-13.md' }), ['notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/diary/*-13.md' }), ['notes/diary/2026-10-13.md']);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'project/**' }), []);
});

test('a first segment that is a brace group or a wildcard names no mount', async (t) => {
  // Read as written in every mount, so neither finds notes/diary's files,
  // which notes/diary/*.md finds.
  const { glob } = setup(t);
  assert.deepEqual(await glob({ pattern: '{notes,project}/diary/*.md' }), []);
  assert.deepEqual(await glob({ pattern: 'note?/diary/*.md' }), []);
});

test("with a path, a pattern naming the path's mount reads mount-prefixed, within the path", async (t) => {
  const { glob, grepFiles } = setup(t, { 'notes/drafts/one.md': 'one', 'notes/diary/notes1': 'a note', 'notes/diary/notes/x.md': 'x' });
  const diary = ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md', 'notes/diary/notes/x.md'];
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/**/*.md' }), diary);
  // notes/README.md lies outside the path, and so does notes/drafts. And a
  // pattern relative to the path that starts with the mount's name names the
  // mount: notes/diary/notes/x.md is found by its path as the tools show it.
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/*.md' }), []);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/diary/notes/*.md' }), ['notes/diary/notes/x.md']);
  assert.deepEqual(await glob({ pattern: 'notes/diary/notes/*.md' }), ['notes/diary/notes/x.md']);
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes/drafts/*.md' }), []);
  assert.deepEqual(await grepFiles({ pattern: 'entry', path: 'notes/diary', glob: 'notes/diary/*-13.md' }), ['notes/diary/2026-10-13.md']);
  assert.deepEqual(await grepFiles({ pattern: 'readme', glob: 'notes/*.md' }), ['notes/README.md']);
  assert.deepEqual(await grepFiles({ pattern: 'readme', path: 'notes/diary', glob: 'notes/*.md' }), []);
  // A pattern with no `/` names no mount, even one that starts with a
  // mount's name, so it's read relative to the path.
  assert.deepEqual(await glob({ path: 'notes/diary', pattern: 'notes1' }), ['notes/diary/notes1']);
});

test('a `**/` matches zero or more directories, in a relative or a mount-prefixed pattern', async (t) => {
  const { glob, grepFiles } = setup(t);
  const sources = ['project/src/lib/util.ts', 'project/src/main.ts'];
  assert.deepEqual(await glob({ pattern: 'project/src/**/*.ts' }), sources);
  assert.deepEqual(await glob({ pattern: 'src/**/*.ts' }), sources);
  assert.deepEqual(await glob({ path: 'project/src', pattern: '**/*.ts' }), sources);
  assert.deepEqual(await glob({ pattern: '**/README.md' }), ['notes/README.md', 'project/README.md']);
  assert.deepEqual(await grepFiles({ pattern: 'export', glob: 'project/src/**/*.ts' }), sources);
});

test("a `**/` right after a brace group needs a directory there where the alternative before it doesn't end one", async (t) => {
  // Not the start of a path segment, so the `**` is any run of characters.
  const { glob } = setup(t, { 'notes/drafts.md': 'drafts', 'notes/drafts/one.md': 'one' });
  assert.deepEqual(await glob({ pattern: 'notes/draft{s,ing}**/*.md' }), ['notes/drafts/one.md']);
});

test('after a brace group, a `**/` matches zero or more directories after an alternative that ends one', async (t) => {
  const { glob } = setup(t, { 'notes/draft.md': 'draft', 'notes/drafts/one.md': 'one', 'notes/ac.md': 'ac', 'notes/ab/c.md': 'abc', 'notes/ax/c.md': 'axc' });
  const sources = ['project/src/lib/util.ts', 'project/src/main.ts'];
  assert.deepEqual(await glob({ pattern: 'project/{src/,docs/}**/*.ts' }), sources);
  assert.deepEqual(await glob({ pattern: 'project/{src,docs}/**/*.ts' }), sources);
  // Beside an alternative that doesn't end one, which still needs a directory.
  assert.deepEqual(await glob({ pattern: 'notes/{diary/,draft}**/*.md' }), ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md', 'notes/drafts/one.md']);
  // An empty alternative ends a directory only where the group starts one.
  assert.deepEqual(await glob({ pattern: 'project/src/{,lib/}**/*.ts' }), sources);
  assert.deepEqual(await glob({ pattern: 'notes/a{,b/}**/c.md' }), ['notes/ab/c.md', 'notes/ax/c.md']);
});

test("a `**/` that starts a brace alternative reads as the alternative's place in the path does", async (t) => {
  const { glob } = setup(t, { 'notes/ac.md': 'ac', 'notes/ax/c.md': 'axc' });
  // At a segment's start: zero or more directories.
  assert.deepEqual(await glob({ pattern: 'project/src/{**/,lib/}*.ts' }), ['project/src/lib/util.ts', 'project/src/main.ts']);
  // Not at a segment's start: any run of characters, then a directory.
  assert.deepEqual(await glob({ pattern: 'notes/a{**/,b/}c.md' }), ['notes/ax/c.md']);
});

test('a `**` that ends a brace alternative, with a `/` after the group, matches zero or more directories there, as the expansion does', async (t) => {
  // `{src/**,docs}/*.ts` names what `src/**/*.ts` and `docs/*.ts` name.
  const { glob } = setup(t, { 'project/docs/guide.ts': 'guide' });
  const all = ['project/docs/guide.ts', 'project/src/lib/util.ts', 'project/src/main.ts'];
  assert.deepEqual(await glob({ pattern: 'project/{src/**,docs}/*.ts' }), all);
  assert.deepEqual(await glob({ pattern: 'project/{src/**,docs/**}/*.ts' }), all);
  // Without a `/` after the group, the `**` is any run of characters, as before.
  assert.deepEqual(await glob({ pattern: 'project/{src/**,docs}.ts' }), ['project/src/lib/util.ts', 'project/src/main.ts']);
});

test("a pattern's other characters match themselves", async (t) => {
  const { glob } = setup(t, { 'project/src/a+b.ts': 'plus', 'project/src/aaab.ts': 'decoy', 'project/src/a.b(c).ts': 'dots', 'project/src/axbc-ts': 'decoy', 'project/src/axb(c).ts': 'decoy' });
  assert.deepEqual(await glob({ pattern: 'project/src/a+b.ts' }), ['project/src/a+b.ts']);
  assert.deepEqual(await glob({ pattern: 'project/src/a.b(c).ts' }), ['project/src/a.b(c).ts']);
});

test("grep's glob filter takes a mount-prefixed pattern", async (t) => {
  const { grepFiles } = setup(t);
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: 'notes/diary/*.md' }), ['notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md']);
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: 'project/src/*.ts' }), ['project/src/main.ts']);
  // In every other mount, a filter naming a mount is read as written.
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: 'notes/*.md' }), ['project/notes/todo.md']);
  // Relative filters still match relative to each mount.
  assert.deepEqual(await grepFiles({ pattern: 'entry', glob: '**/*.md' }), [
    'notes/diary/2026-10-12.md', 'notes/diary/2026-10-13.md', 'project/docs/guide.md', 'project/notes/todo.md',
  ]);
});
