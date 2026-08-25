/**
 * Mount containment on Windows (path-separator regression).
 *
 * The mount boundary checks (parsePath traversal guard, sync's safePath)
 * appended a POSIX '/' to the mount root before prefix-matching, but
 * node's resolve() emits backslash-separated paths on Windows — so the
 * prefix never matched and EVERY legitimate in-mount path was rejected:
 * read/write threw "Path traversal detected" and syncFromFs reported every
 * real file as outside its mount. ls was unaffected (tree listing takes a
 * different path), which made a populated mount look empty-but-haunted.
 *
 * These tests drive the public tool surface over a real tmpdir mount, so
 * they exercise the platform's actual separators: on Windows they fail
 * against the unfixed guards; on POSIX the fix is a no-op and they pin
 * the behavior either way. The traversal rejection itself is asserted
 * too — the fix must not widen the boundary.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { ToolResult } from '../src/types/events.js';

function makeWorkspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'af-path-containment-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: mountDir, mode: 'read-write', watch: 'never' }],
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { mountDir, workspace };
}

function call(workspace: WorkspaceModule, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return workspace.handleToolCall({ id: `call-${name}`, name, input });
}

function resultText(result: ToolResult): string {
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');
}

test('sync + read reach a real file inside the mount', async (t) => {
  const { mountDir, workspace } = makeWorkspace(t);
  writeFileSync(join(mountDir, 'hello.txt'), 'hola desde el mount\n');

  const sync = await call(workspace, 'sync', { mount: 'work' });
  assert.equal(sync.success, true, `sync should succeed: ${sync.error ?? ''}`);
  assert.ok(
    !resultText(sync).includes('outside'),
    'sync must not report an in-mount file as outside the mount',
  );

  const read = await call(workspace, 'read', { path: 'work/hello.txt' });
  assert.equal(read.success, true, `read should succeed: ${read.error ?? ''}`);
  assert.ok(resultText(read).includes('hola desde el mount'), 'read returns the file content');
});

test('write lands inside the mount', async (t) => {
  const { workspace } = makeWorkspace(t);
  const write = await call(workspace, 'write', { path: 'work/out.txt', content: 'producto' });
  assert.equal(write.success, true, `write should succeed: ${write.error ?? ''}`);

  const read = await call(workspace, 'read', { path: 'work/out.txt' });
  assert.equal(read.success, true);
  assert.ok(resultText(read).includes('producto'));
});

test('nested files sync and read under /-separated logical paths', async (t) => {
  const { mountDir, workspace } = makeWorkspace(t);
  mkdirSync(join(mountDir, 'sub', 'deep'), { recursive: true });
  writeFileSync(join(mountDir, 'sub', 'deep', 'nested.txt'), 'anidado\n');

  const sync = await call(workspace, 'sync', { mount: 'work' });
  assert.equal(sync.success, true, `sync should succeed: ${sync.error ?? ''}`);

  // Logical workspace paths are '/'-separated everywhere — the walker must
  // not leak platform separators into tree paths (relative() emits
  // backslashes on Windows).
  const ls = await call(workspace, 'ls', { path: 'work', recursive: true });
  assert.equal(ls.success, true);
  const listing = resultText(ls);
  assert.ok(listing.includes('sub/deep/nested.txt'), `listing should use '/' paths, got: ${listing.slice(0, 300)}`);
  assert.ok(!listing.includes('sub\\deep'), 'listing must not contain backslash-separated paths');

  const read = await call(workspace, 'read', { path: 'work/sub/deep/nested.txt' });
  assert.equal(read.success, true, `nested read should succeed: ${read.error ?? ''}`);
  assert.ok(resultText(read).includes('anidado'));
});

test('traversal outside the mount is still rejected', async (t) => {
  const { workspace } = makeWorkspace(t);

  const read = await call(workspace, 'read', { path: 'work/../escape.txt' });
  assert.equal(read.success, false, 'escaping read must be rejected');
  assert.match(read.error ?? '', /traversal/i);

  const write = await call(workspace, 'write', { path: 'work/../../evil.txt', content: 'nope' });
  assert.equal(write.success, false, 'escaping write must be rejected');
  assert.match(write.error ?? '', /traversal/i);
});
