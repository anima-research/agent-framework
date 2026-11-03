/**
 * grep's glob filter. One with no "/" picks files by name at any depth, as
 * ripgrep's --glob does, with or without a `path`. One with a "/" is matched
 * from the mount's root, whatever the `path`, or read mount-prefixed in the
 * mount it names, and a `path` and such a filter whose directories lie
 * apart, neither holding the other, are refused rather than answered with
 * no matches, as glob's mount-prefixed pattern is, unless the path lies in
 * another mount's directory, which is said to be that mount's. The filter's
 * cases each run on both kinds of mount.
 */

import test, { describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { ModuleContext } from '../src/types/module.js';

const FILES = ['top.ts', 'notes.md', 'src/main.ts', 'src/main.md', 'src/deep/er/b.ts', 'lib/c.ts'];

const KINDS: Array<[string, Partial<MountConfig>]> = [
  ['a chronicle mount', { mode: 'read-write', watch: 'never' }],
  ['a direct mount', { mode: 'read-only', backend: 'direct' }],
];

/** A module with one mount, `work`, holding FILES and `more`, each with a needle, and the mounts `nested` makes of its directory. */
async function opened(t: TestContext, mount: Partial<MountConfig>, more: string[] = [], nested: (dir: string) => MountConfig[] = () => []): Promise<{ m: WorkspaceModule; store: JsStore }> {
  const root = mkdtempSync(join(tmpdir(), 'af-ws-grep-filter-'));
  const dir = join(root, 'work');
  for (const file of [...FILES, ...more]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'a needle\n');
  }
  const store = JsStore.openOrCreate({ path: join(root, 'ws.chronicle') });
  const m = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, ...mount } as MountConfig, ...nested(dir)] });
  m.initStore(store);
  await m.start({
    isRestart: false,
    getState: () => null,
    setState: () => {},
    pushEvent: () => {},
    notifyOps: () => {},
  } as unknown as ModuleContext);
  t.after(async () => {
    await m.stop().catch(() => {});
    if (!store.isClosed()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { m, store };
}

/** The files a grep for the needle finds, sorted. */
async function grepped(m: WorkspaceModule, input: Record<string, unknown>): Promise<string[]> {
  const res = await m.handleToolCall({ id: 't', name: 'grep', input: { pattern: 'needle', ...input } });
  assert.equal(res.success, true, `grep ${JSON.stringify(input)} failed: ${res.error}`);
  return ((res.structured as { results: Array<{ file: string }> }).results).map((r) => r.file).sort();
}

/** The files a glob finds, sorted. */
async function globbed(m: WorkspaceModule, input: Record<string, unknown>): Promise<string[]> {
  const res = await m.handleToolCall({ id: 't', name: 'glob', input });
  assert.equal(res.success, true, `glob ${JSON.stringify(input)} failed: ${res.error}`);
  return ((res.data as { matches: Array<{ path: string }> }).matches).map((r) => r.path).sort();
}

/** The error a glob is refused with. */
async function globRefusal(m: WorkspaceModule, input: Record<string, unknown>): Promise<string> {
  const res = await m.handleToolCall({ id: 't', name: 'glob', input });
  assert.equal(res.success, false, `glob ${JSON.stringify(input)} unexpectedly succeeded: ${JSON.stringify(res.data)}`);
  assert.equal(res.isError, true, 'a refusal is an error the agent sees');
  return String(res.error);
}

/** The error a grep for the needle is refused with. */
async function refusal(m: WorkspaceModule, input: Record<string, unknown>): Promise<string> {
  const res = await m.handleToolCall({ id: 't', name: 'grep', input: { pattern: 'needle', ...input } });
  assert.equal(res.success, false, `grep ${JSON.stringify(input)} unexpectedly succeeded: ${JSON.stringify(res.structured)}`);
  assert.equal(res.isError, true, 'a refusal is an error the agent sees');
  return String(res.error);
}

const quoted = (text: string) => new Set([...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]));

for (const [kind, mount] of KINDS) {
  describe(`grep's glob filter, on ${kind}`, () => {
    test('a filter with no "/" picks files by name at any depth', async (t) => {
      const { m } = await opened(t, mount);
      assert.deepEqual(await grepped(m, { glob: '*.ts' }), ['work/lib/c.ts', 'work/src/deep/er/b.ts', 'work/src/main.ts', 'work/top.ts']);
      assert.deepEqual(await grepped(m, { glob: '*.{ts,md}' }), FILES.map((f) => `work/${f}`).sort());
      assert.deepEqual(await grepped(m, { glob: 'b.ts' }), ['work/src/deep/er/b.ts']);
    });

    test('a filter with no "/" picks files by name beneath a directory path', async (t) => {
      const { m } = await opened(t, mount);
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: '*.ts' }), ['work/src/deep/er/b.ts', 'work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src/deep', glob: '*.ts' }), ['work/src/deep/er/b.ts']);
    });

    test('a filter with no "/" lets through the file a path names when its name matches', async (t) => {
      const { m } = await opened(t, mount);
      assert.deepEqual(await grepped(m, { path: 'work/src/main.ts', glob: '*.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src/main.ts', glob: '*.md' }), []);
    });

    test('a filter with no "/" still matches the whole path, so a "**" in it spans directories as before', async (t) => {
      const { m } = await opened(t, mount);
      assert.deepEqual(await grepped(m, { glob: 'src**' }), ['work/src/deep/er/b.ts', 'work/src/main.md', 'work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: 'src**' }), ['work/src/deep/er/b.ts', 'work/src/main.md', 'work/src/main.ts']);
    });

    test('a filter with a "/" is matched from the mount\'s root, whatever the path', async (t) => {
      const { m } = await opened(t, mount);
      assert.deepEqual(await grepped(m, { glob: 'src/*.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: 'src/*.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src/main.ts', glob: 'src/*.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: 'src/deep/**' }), ['work/src/deep/er/b.ts']);
      // A "/" anywhere in the filter, a brace group's included, keeps it
      // matched against the path alone: this one names src's .ts files and
      // the root's, not lib's.
      assert.deepEqual(await grepped(m, { glob: '{src/,}*.ts' }), ['work/src/main.ts', 'work/top.ts']);
      // One whose first segment is a wildcard or a brace group names no
      // directory, so a path never lies apart from it, and it isn't refused.
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: '*/main.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: '{src,lib}/*.ts' }), ['work/src/main.ts']);
    });

    test('a directory path and a filter with a "/" that can\'t overlap are refused, naming the filter that reaches beneath it', async (t) => {
      const { m } = await opened(t, mount);
      const said = await refusal(m, { path: 'work/src/deep', glob: 'er/*.ts' });
      assert.ok(said.includes("from the mount's root"), said);
      assert.deepEqual(quoted(said), new Set(['er/*.ts', 'work/src/deep', 'work/src/deep/er/*.ts']), said);
      assert.deepEqual(await grepped(m, { path: 'work/src/deep', glob: 'work/src/deep/er/*.ts' }), ['work/src/deep/er/b.ts']);
    });

    test('the filter a refusal names writes the path\'s own glob characters as "?", so it still reaches beneath the path', async (t) => {
      // pXqY's file matches the suggested filter too, and stays out, since
      // the search stays beneath the path.
      const { m } = await opened(t, mount, ['{name}/a/x.ts', 'p*q?/a/y.ts', 'pXqY/a/z.ts']);
      assert.match(await refusal(m, { path: 'work/{name}', glob: 'a/*.ts' }), / To filter beneath it, write "work\/\?name\?\/a\/\*\.ts"\.$/);
      assert.deepEqual(await grepped(m, { path: 'work/{name}', glob: 'work/?name?/a/*.ts' }), ['work/{name}/a/x.ts']);
      assert.match(await refusal(m, { path: 'work/p*q?', glob: 'a/*.ts' }), / To filter beneath it, write "work\/p\?q\?\/a\/\*\.ts"\.$/);
      assert.deepEqual(await grepped(m, { path: 'work/p*q?', glob: 'work/p?q?/a/*.ts' }), ['work/p*q?/a/y.ts']);
    });

    test('a refusal names no filter for one with an empty, "." or ".." segment, which no prefix makes match', async (t) => {
      const { m } = await opened(t, mount);
      for (const glob of ['./er/*.ts', '../src/deep/er/*.ts', 'er//*.ts', 'er/..', 'er/']) {
        const said = await refusal(m, { path: 'work/src/deep', glob });
        assert.ok(said.includes("from the mount's root"), said);
        assert.deepEqual(quoted(said), new Set([glob, 'work/src/deep']), said);
      }
    });

    test('a filter naming the mount is read mount-prefixed, and refused by the directory of that reading', async (t) => {
      const { m } = await opened(t, mount);
      // As written, work/src lies apart from src's own path; read
      // mount-prefixed, its directory is src, which holds the path's.
      assert.deepEqual(await grepped(m, { path: 'work/src', glob: 'work/src/*.ts' }), ['work/src/main.ts']);
      const said = await refusal(m, { path: 'work/src', glob: 'work/lib/*.ts' });
      assert.ok(said.includes('mount-prefixed'), said);
      assert.deepEqual(quoted(said), new Set(['work/lib/*.ts', 'work', 'work/src', 'work/src/lib/*.ts']), said);
    });

    test('glob refuses a path its mount-prefixed pattern can\'t overlap, as grep does', async (t) => {
      const { m } = await opened(t, mount);
      const said = await globRefusal(m, { path: 'work/src', pattern: 'work/lib/*.ts' });
      assert.ok(said.includes('mount-prefixed'), said);
      assert.deepEqual(quoted(said), new Set(['work/lib/*.ts', 'work', 'work/src', 'work/src/lib/*.ts']), said);
      const ofFile = await globRefusal(m, { path: 'work/src/main.ts', pattern: 'work/lib/*.ts' });
      assert.ok(ofFile.includes('mount-prefixed'), ofFile);
      assert.deepEqual(quoted(ofFile), new Set(['work/lib/*.ts', 'work', 'work/src/main.ts']), ofFile);
      assert.deepEqual(await globbed(m, { path: 'work/src', pattern: 'work/src/*.ts' }), ['work/src/main.ts']);
      // A pattern as written is relative to the path, so it isn't refused:
      // main.ts names the file directly in the path, and lib/*.ts names
      // nothing there.
      assert.deepEqual(await globbed(m, { path: 'work/src', pattern: 'main.ts' }), ['work/src/main.ts']);
      assert.deepEqual(await globbed(m, { path: 'work/src', pattern: 'lib/*.ts' }), []);
    });

    test('glob, given the pattern its refusal names (the path\'s braces written as "?"), finds the file beneath the path and not a sibling\'s; its refusal names no pattern where one has a "." segment', async (t) => {
      // XnameX's file matches the suggested pattern too, and stays out, since
      // the search stays beneath the path.
      const { m } = await opened(t, mount, ['{name}/a/x.ts', 'XnameX/a/z.ts']);
      assert.match(await globRefusal(m, { path: 'work/{name}', pattern: 'work/a/*.ts' }), / To match beneath it, write "work\/\?name\?\/a\/\*\.ts"\.$/);
      assert.deepEqual(await globbed(m, { path: 'work/{name}', pattern: 'work/?name?/a/*.ts' }), ['work/{name}/a/x.ts']);
      // One with a "." segment gets no suggestion.
      assert.equal(
        await globRefusal(m, { path: 'work/src', pattern: 'work/./lib/*.ts' }),
        'The glob did nothing: its pattern "work/./lib/*.ts" is read mount-prefixed, from the root of mount "work", so no file within "work/src" matches it.',
      );
    });

    test('glob\'s refusal leaves a path in a nested mount\'s directory to that mount, as grep does', async (t) => {
      const { m } = await opened(t, mount, ['a/b/lib/x.ts'], (dir) => [{ ...mount, name: 'deep', path: join(dir, 'a/b') } as MountConfig]);
      for (const [name, input] of [
        ['glob', { path: 'work/a/b', pattern: 'work/lib/*.ts' }],
        ['grep', { pattern: 'needle', path: 'work/a/b', glob: 'work/lib/*.ts' }],
      ] as const) {
        const res = await m.handleToolCall({ id: 't', name, input });
        assert.equal(res.success, true, `${name} ${JSON.stringify(input)} failed: ${res.error}`);
        const incomplete = ((res.structured ?? res.data) as { incomplete?: Array<{ path: string; reason: string }> }).incomplete ?? [];
        assert.deepEqual(incomplete.map((region) => region.path), ['work/a/b'], name);
        assert.match(incomplete[0]!.reason, /it lies in mount "deep", nested in this one/, name);
      }
    });

    test('a file path and a filter with a "/" that can\'t overlap are refused', async (t) => {
      const { m } = await opened(t, mount);
      const said = await refusal(m, { path: 'work/src/main.ts', glob: 'lib/*.ts' });
      assert.ok(said.includes("from the mount's root"), said);
      assert.deepEqual(quoted(said), new Set(['lib/*.ts', 'work/src/main.ts']), said);
    });
  });
}

test('grep\'s glob description says how a filter with a "/" and one without are read', async (t) => {
  const { m } = await opened(t, KINDS[0]![1]);
  const grep = m.getTools().find((tool) => tool.name === 'grep')!;
  const glob = (grep.inputSchema.properties as Record<string, { description: string }>).glob!;
  assert.match(glob.description, /one with a "\/" is matched from the mount's root, whatever the path \(e\.g\., "src\/\*\*\/\*\.ts"\), and in the mount its first segment names, read mount-prefixed \(e\.g\., "project\/src\/\*\*\/\*\.ts"\), in every other mount as written; one with no "\/" also matches a file's name at any depth/);
});
