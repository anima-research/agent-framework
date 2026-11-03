// The workspace's file tools write exactly what they're given or refuse,
// say when a change is stored but not on disk, number a file's lines as it
// has them, and edit the text disk holds now.
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { ToolResult } from '../src/types/events.js';

function setup(t: TestContext, opts: { autoMaterialize?: boolean; maxFileSize?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-file-tools-'));
  const dir = join(root, 'mount');
  mkdirSync(dir);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [{
      name: 'work', path: dir, mode: 'read-write', watch: 'never', autoMaterialize: opts.autoMaterialize ?? false,
      ...(opts.maxFileSize !== undefined ? { maxFileSize: opts.maxFileSize } : {}),
    }],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name: string, input: unknown): Promise<ToolResult> =>
    workspace.handleToolCall({ id: name, name, input } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const disk = (rel: string): Buffer | null => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null);
  const stored = async (rel: string): Promise<string> => {
    const result = await call('read', { path: `work/${rel}`, offsetChars: 0, limitChars: 100_000 });
    assert.equal(result.success, true, result.error);
    return (result.structured as { content: string }).content;
  };
  return { workspace, store, dir, call, disk, stored };
}

const MAY_WORK = "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.";
// On Windows a store error's OS error is a Win32 code, which isn't read as an errno.
const WIN32 = process.platform === 'win32';
const NO_SPACE = WIN32 ? 'IO error: No space left on device (os error 28)' : 'no space left on the disk';
const FULL_DISK = WIN32 ? `${NO_SPACE}. ${MAY_WORK}` : `${NO_SPACE}. Calling again won't change that; whoever runs this host can free space on its disk.`;
const unstored = (tool: string, path: string, words: string): string =>
  `The ${tool} of "${path}" stopped on an error the workspace didn't expect, before the ${tool === 'delete' ? 'deletion' : tool} was stored: ${words === 'no space' ? FULL_DISK : `${words}. ${MAY_WORK}`}`;

const errorOf = (result: ToolResult): string => {
  assert.equal(result.success, false, 'the call was refused');
  assert.equal(result.isError, true);
  return result.error ?? '';
};

// ---------------------------------------------------------------------------
// Part 1: exactly what was given, or a refusal
// ---------------------------------------------------------------------------

test('an edit writes its replacement as given, $ patterns and all', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'price.txt'), 'price: 10\n');
  const one = await call('edit', { path: 'work/price.txt', oldString: '10', newString: "$$5, $&, $', $`, $1" });
  assert.equal(one.success, true, one.error);
  assert.equal(disk('price.txt')!.toString(), "price: $$5, $&, $', $`, $1\n");

  writeFileSync(join(dir, 'pair.txt'), 'a-a\n');
  const all = await call('edit', { path: 'work/pair.txt', oldString: 'a', newString: '$&$&', replaceAll: true });
  assert.equal(all.success, true, all.error);
  assert.equal(disk('pair.txt')!.toString(), '$&$&-$&$&\n');
});

test("an edit of a file that isn't valid UTF-8 is refused and changes nothing, and a write still replaces it", async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  const latin1 = Buffer.from('caf\xe9 au lait\n', 'latin1');
  writeFileSync(join(dir, 'latin1.txt'), latin1);
  const refused = errorOf(await call('edit', { path: 'work/latin1.txt', oldString: 'au', newString: 'with' }));
  assert.equal(refused, "The edit did nothing: work/latin1.txt isn't valid UTF-8, so editing it would change bytes outside the text it replaces. "
    + 'Read shows each invalid byte sequence as U+FFFD, and a write replaces the whole file as UTF-8, so writing back what read shows puts U+FFFD in their place.');
  assert.deepEqual(disk('latin1.txt'), latin1, 'disk keeps every byte');

  const written = await call('write', { path: 'work/latin1.txt', content: 'café with milk\n' });
  assert.equal(written.success, true, written.error);
  assert.equal(disk('latin1.txt')!.toString('utf8'), 'café with milk\n');
});

test('a lone surrogate is refused in a write and in either of an edit\'s strings, and nothing changes', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  assert.match(errorOf(await call('write', { path: 'work/s.txt', content: 'a\ud800b' })),
    /^The write did nothing: "content" holds a lone UTF-16 surrogate/);
  assert.equal(disk('s.txt'), null);
  assert.match(errorOf(await call('write', { path: 'work/s\ud800.txt', content: 'x' })),
    /^The write did nothing: "work\/s\\ud800\.txt" holds a lone UTF-16 surrogate, which UTF-8 can't store, so no file on disk can have that name\. Give the name without it\.$/);

  writeFileSync(join(dir, 'e.txt'), 'pair \ud83d\ude00 here\n');
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: 'here', newString: 'x\udc00' })),
    /^The edit did nothing: "newString" holds a lone UTF-16 surrogate/);
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '\ud83d', newString: 'x' })),
    /^The edit did nothing: "oldString" holds a lone UTF-16 surrogate/);
  assert.equal(disk('e.txt')!.toString(), 'pair \ud83d\ude00 here\n');
  // A pair is one character, not a lone half.
  const paired = await call('edit', { path: 'work/e.txt', oldString: 'here', newString: '\ud83c\udf89' });
  assert.equal(paired.success, true, paired.error);
});

test('an empty oldString is refused, with replaceAll or without', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'e.txt'), 'abc\n');
  for (const replaceAll of [false, true]) {
    assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '', newString: 'X', replaceAll })),
      /^The edit did nothing: "oldString" is empty/);
  }
  assert.equal(disk('e.txt')!.toString(), 'abc\n');
});

test("a call whose input doesn't fit its tool's schema does nothing", async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'u.txt'), 'keep a\n');
  const cases: Array<[string, unknown, RegExp]> = [
    ['edit', { path: 'work/u.txt', oldString: 'a' }, /^The edit call did nothing: "newString" is required\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: 5 }, /"newString" must be a string, not 5\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: null }, /"newString" must be a string, not null\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: 'b', replaceAll: 'false' }, /"replaceAll" must be true or false, not a string\.$/],
    ['edit', { path: 'work/u.txt', oldString: 'a', newString: 'b', replaceAll: null }, /"replaceAll" must be true or false, not null\.$/],
    ['write', { path: 'work/u.txt', content: ['x'] }, /^The write call did nothing: "content" must be a string, not an array\.$/],
    ['write', { path: 3, content: 'x' }, /"path" must be a string, not 3\.$/],
    ['read', { path: 'work/u.txt', offset: '1' }, /"offset" must be a whole number of at least 1, not a string\.$/],
    ['grep', { pattern: 'a', contextBefore: -1 }, /"contextBefore" must be a whole number of at least 0, not -1\.$/],
    ['delete', null, /^The delete call did nothing: its input must be an object/],
  ];
  for (const [name, input, expected] of cases) {
    assert.match(errorOf(await call(name, input)), expected, `${name} ${JSON.stringify(input)}`);
  }
  assert.equal(disk('u.txt')!.toString(), 'keep a\n');
});

test('a write, edit or delete that is stored but refused by disk says so, in its text alone', async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });

  // A write over a disk change the workspace hasn't seen.
  writeFileSync(join(dir, 'w.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/w.txt' })).success, true);
  writeFileSync(join(dir, 'w.txt'), 'v2 from another writer\n');
  const write = await call('write', { path: 'work/w.txt', content: 'v3 agent\n' });
  assert.match(errorOf(write), /^The write of "work\/w\.txt" is stored in the workspace, so don't send it again\. Its push to disk didn't complete: stale copy: disk changed since it last agreed with the workspace \(conflict: both-changed\) — sync this path to adopt the disk version, or materialize it with force to overwrite it\.$/);
  assert.equal(write.data, undefined, "an error's data reaches neither the model nor a script");
  assert.equal(await stored('w.txt'), 'v3 agent\n');
  assert.equal(disk('w.txt')!.toString(), 'v2 from another writer\n');

  // An edit of a file with another name: the push writes in place, which
  // would change the other name's file too.
  writeFileSync(join(dir, 'h.txt'), 'shared\n');
  linkSync(join(dir, 'h.txt'), join(dir, 'h2.txt'));
  const edit = await call('edit', { path: 'work/h.txt', oldString: 'shared', newString: 'shared, edited' });
  assert.match(errorOf(edit), /^The edit of "work\/h\.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice\. Its push to disk didn't complete: not written: a file with other hard links/);
  assert.equal(edit.data, undefined);
  assert.equal(await stored('h.txt'), 'shared, edited\n');
  assert.equal(disk('h2.txt')!.toString(), 'shared\n');
  // Why the answer says not to send it again: the edit's text is still there
  // to match, so a second one applies the change twice.
  await call('edit', { path: 'work/h.txt', oldString: 'shared', newString: 'shared, edited' });
  assert.equal(await stored('h.txt'), 'shared, edited, edited\n');

  // A deletion whose disk copy changed since the workspace read it.
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  writeFileSync(join(dir, 'd.txt'), 'changed on disk\n');
  const del = await call('delete', { path: 'work/d.txt' });
  assert.match(errorOf(del), /^The deletion of "work\/d\.txt" is stored in the workspace, so don't send it again\. Its push to disk didn't complete: stale copy: disk changed since it last agreed with the workspace \(conflict: [a-z-]+\) — sync this path to adopt the disk version, or materialize it with force and applyDeletions to delete it\.$/);
  assert.equal(del.data, undefined);
  assert.equal(disk('d.txt')!.toString(), 'changed on disk\n');
});

test('a write, edit or delete that throws after its tree entry is set says the change is stored', async (t) => {
  const { workspace, dir, call, stored } = setup(t);
  const ws = workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> };
  const intents = ws.intents.get('work')!;
  const update = intents.update;
  writeFileSync(join(dir, 'e.txt'), 'line\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  // A draft the workspace made, which disk never agreed with: its deletion
  // clears the path's intent once the entry is gone. A deletion that leaves
  // a tombstone writes it first (the test after this one).
  assert.equal((await call('write', { path: 'work/d.txt', content: 'draft\n' })).success, true);
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    const write = await call('write', { path: 'work/w.txt', content: 'new\n' });
    assert.equal(errorOf(write), 'The write of "work/w.txt" is stored in the workspace, so don\'t send it again. The rest of the call failed: injected intent exception. ls shows the path\'s state.');
    assert.equal(write.data, undefined);
    const edit = await call('edit', { path: 'work/e.txt', oldString: 'line', newString: 'line, edited' });
    assert.match(errorOf(edit), /^The edit of "work\/e\.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice\. The rest of the call failed: injected intent exception\. ls shows the path's state\.$/);
    assert.equal(edit.data, undefined);
    const del = await call('delete', { path: 'work/d.txt' });
    assert.match(errorOf(del), /^The deletion of "work\/d\.txt" is stored in the workspace, so don't send it again\. The rest of the call failed: injected intent exception\. ls shows the path's state\.$/);
    assert.equal(del.data, undefined);
  } finally {
    intents.update = update;
  }
  assert.equal(await stored('w.txt'), 'new\n');
  assert.equal(await stored('e.txt'), 'line, edited\n');
  assert.equal((await call('read', { path: 'work/d.txt' })).success, false);
});

test("a deletion whose tombstone can't be written is refused and stores nothing, so it can be sent again and a materialize deletes the file", async (t) => {
  const { workspace, store, dir, call, stored, disk } = setup(t);
  const ws = workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown; get(path: string): unknown }> };
  const intents = ws.intents.get('work')!;
  const update = intents.update;
  const pendingDeletions = async () => ((await call('status', { mount: 'work' })).data as Record<string, { pendingWorkspaceDeletions: number }>).work!.pendingWorkspaceDeletions;
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  // agent-framework #553's case: the removal's record lands and the store
  // throws after it (anima-research/chronicle#39), and every intent write
  // fails. Stored without its tombstone, the deletion would read as a file
  // this branch doesn't have, which no materialize deletes and no second
  // delete can reach. The tombstone is written first, so its failure stops
  // the deletion before the removal.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const realRemove = store.treeRemove;
  let removals = 0;
  s.treeRemove = (...args) => {
    removals++;
    realRemove.apply(store, args as never);
    throw new Error('IO error: No space left on device (os error 28)');
  };
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    assert.equal(errorOf(await call('delete', { path: 'work/d.txt' })), unstored('delete', 'work/d.txt', 'injected intent exception'));
  } finally {
    delete s.treeRemove;
    intents.update = update;
  }
  assert.equal(removals, 0, 'the removal never ran');
  // The tombstone's record lands and the store throws after it: the
  // deletion stops there too, and the tombstone is put back.
  intents.update = (...args: unknown[]) => {
    update.apply(intents, args);
    throw new Error('IO error: No space left on device (os error 28)');
  };
  try {
    assert.equal(errorOf(await call('delete', { path: 'work/d.txt' })), unstored('delete', 'work/d.txt', 'no space'));
  } finally {
    intents.update = update;
  }
  assert.equal(intents.get('d.txt'), null, 'the tombstone was put back');
  assert.equal(await pendingDeletions(), 0);
  assert.equal(await stored('d.txt'), 'doomed\n');
  assert.equal(disk('d.txt')!.toString(), 'doomed\n');
  const del = await call('delete', { path: 'work/d.txt' });
  assert.equal(del.success, true, del.error);
  assert.equal(await pendingDeletions(), 1);
  const deleted = await call('materialize', { path: 'work/d.txt', applyDeletions: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(disk('d.txt'), null);
});

test("a deletion that lands gives up its path's store origin, and one whose removal fails puts the path's intent back as it was", async (t) => {
  const { workspace, store, dir, call, stored } = setup(t);
  type Intent = { tombstone?: unknown; origin?: string };
  const ws = workspace as unknown as { intents: Map<string, { get(path: string): Intent | null; update(path: string, change: (cur: Intent) => Intent): void }> };
  const intents = ws.intents.get('work')!;
  writeFileSync(join(dir, 'k.txt'), 'kept\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  // A store origin, given here directly. A draft keeps one while a push of
  // it is pending or interrupted, which is when a deletion that keeps a
  // tombstone meets one, and the tombstone's write gives it up.
  intents.update('k.txt', (cur) => ({ ...cur, origin: 'store' }));
  // A damaged intent record, whose blob the store lacks: what it held is
  // unknown, so the put-back restores the record itself.
  writeFileSync(join(dir, 'u.txt'), 'unknown\n');
  assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
  const intentTree = (workspace as unknown as { intents: Map<string, { treeStateId: string }> }).intents.get('work')!.treeStateId;
  store.treeSet(intentTree, 'u.txt', { blobHash: 'f'.repeat(64), size: 2, mode: 0 });
  const damaged = store.treeGet(intentTree, 'u.txt');
  assert.ok('unreadable' in (intents.get('u.txt') ?? {}));
  // A deletion that lands leaves its tombstone alone, the origin given up,
  // as before the tombstone was written first.
  writeFileSync(join(dir, 'o.txt'), 'other\n');
  assert.equal((await call('read', { path: 'work/o.txt' })).success, true);
  intents.update('o.txt', (cur) => ({ ...cur, origin: 'store' }));
  const mountTree = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;
  const deleted = store.treeGet(mountTree, 'o.txt')!.blobHash;
  assert.equal((await call('delete', { path: 'work/o.txt' })).success, true);
  assert.deepEqual(intents.get('o.txt'), { tombstone: { hash: deleted } });
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  s.treeRemove = () => { throw new Error('injected store failure'); };
  try {
    assert.equal(errorOf(await call('delete', { path: 'work/k.txt' })), unstored('delete', 'work/k.txt', 'injected store failure'));
    assert.equal(errorOf(await call('delete', { path: 'work/u.txt' })), unstored('delete', 'work/u.txt', 'injected store failure'));
  } finally {
    delete s.treeRemove;
  }
  assert.deepEqual(intents.get('k.txt'), { origin: 'store' }, 'the intent as it was, with no tombstone and its origin');
  assert.deepEqual(store.treeGet(intentTree, 'u.txt'), damaged, 'the damaged record as it was');
  assert.equal(await stored('k.txt'), 'kept\n');
});

test("a tombstone a put-back couldn't take back deletes nothing, is no deletion to status or a bare materialize, and goes at the next agreement", async (t) => {
  const { workspace, store, dir, call, stored, disk } = setup(t);
  const ws = workspace as unknown as { intents: Map<string, { get(path: string): { tombstone?: unknown } | null }> };
  const intents = ws.intents.get('work')!;
  const pendingDeletions = async () => ((await call('status', { mount: 'work' })).data as Record<string, { pendingWorkspaceDeletions: number }>).work!.pendingWorkspaceDeletions;
  writeFileSync(join(dir, 'k.txt'), 'kept\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  // The removal fails, and so does the put-back, which removes the record
  // the tombstone's write made. The put-back's failure is logged, naming the
  // mount and the path, and the call answers with the removal's error.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  s.treeRemove = () => { throw new Error('injected store failure'); };
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    assert.equal(errorOf(await call('delete', { path: 'work/k.txt' })), unstored('delete', 'work/k.txt', 'injected store failure'));
  } finally {
    delete s.treeRemove;
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0]!, /Mount "work": a change to k\.txt failed, and putting its branch intent back threw too \(injected store failure\)/);
  assert.ok(intents.get('k.txt')?.tombstone, 'the tombstone is still beside the entry');
  assert.equal(await pendingDeletions(), 0);
  // Disk changes since it agreed. A bare materialize, forced, leaves an
  // agreed entry out, the tombstone notwithstanding, so disk's change stays.
  writeFileSync(join(dir, 'k.txt'), 'changed on disk\n');
  const forced = await call('materialize', { force: true, applyDeletions: true });
  assert.equal(forced.success, true, forced.error);
  assert.equal(disk('k.txt')!.toString(), 'changed on disk\n');
  // The next sync adopts disk's change, which clears the tombstone.
  const synced = await call('sync', {});
  assert.equal(synced.success, true, synced.error);
  assert.equal(await stored('k.txt'), 'changed on disk\n');
  assert.equal(intents.get('k.txt'), null);
});

test("a deletion whose removal lands while reading the tree back fails keeps its tombstone, so the deletion stays pending", async (t) => {
  const { workspace, store, dir, call, disk } = setup(t);
  const ws = workspace as unknown as {
    intents: Map<string, { get(path: string): { tombstone?: unknown } | null }>;
    mounts: Map<string, { treeStateId: string }>;
  };
  const intents = ws.intents.get('work')!;
  const mountTree = ws.mounts.get('work')!.treeStateId;
  const pendingDeletions = async () => ((await call('status', { mount: 'work' })).data as Record<string, { pendingWorkspaceDeletions: number }>).work!.pendingWorkspaceDeletions;
  writeFileSync(join(dir, 'l.txt'), 'landed\n');
  assert.equal((await call('read', { path: 'work/l.txt' })).success, true);
  // The removal's record lands and the store throws after it
  // (anima-research/chronicle#39), and reading the tree back throws once, so
  // nothing can tell whether the removal landed. Putting the tombstone back
  // here would leave #553's state: an entry gone with no tombstone, which no
  // materialize deletes.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const realRemove = store.treeRemove;
  const realGet = store.treeGet;
  let failRead = false;
  s.treeRemove = (...args) => {
    const record = realRemove.apply(store, args as never);
    if (args[0] !== mountTree) return record;
    failRead = true;
    throw new Error('IO error: No space left on device (os error 28)');
  };
  s.treeGet = (...args) => {
    if (failRead && args[0] === mountTree) {
      failRead = false;
      throw new Error('injected read failure');
    }
    return realGet.apply(store, args as never);
  };
  try {
    assert.equal(errorOf(await call('delete', { path: 'work/l.txt' })), 'The delete of "work/l.txt" stopped on an error the workspace didn\'t expect: '
      + `the store failed as it set the change (${NO_SPACE}), and reading it back failed too (injected read failure). `
      + 'Whether it changed anything isn\'t known: read "work/l.txt" to see what the workspace holds there now. '
      + (WIN32 ? MAY_WORK : "Calling again won't change that; whoever runs this host can free space on its disk."));
  } finally {
    delete s.treeRemove;
    delete s.treeGet;
  }
  assert.ok(intents.get('l.txt')?.tombstone, 'the tombstone stays');
  assert.equal(await pendingDeletions(), 1);
  const deleted = await call('materialize', { path: 'work/l.txt', applyDeletions: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(disk('l.txt'), null);
});

test("a write over a deleted path clears its tombstone, and one that stops before its intent update leaves it beside the entry, which status doesn't count as a deletion", async (t) => {
  const { workspace, dir, call, disk } = setup(t);
  const ws = workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown; get(path: string): { tombstone?: unknown } | null }> };
  const intents = ws.intents.get('work')!;
  const update = intents.update;
  const pendingDeletions = async () => ((await call('status', { mount: 'work' })).data as Record<string, { pendingWorkspaceDeletions: number }>).work!.pendingWorkspaceDeletions;
  writeFileSync(join(dir, 'h.txt'), 'gone\n');
  assert.equal((await call('read', { path: 'work/h.txt' })).success, true);
  assert.equal((await call('delete', { path: 'work/h.txt' })).success, true);
  assert.ok(intents.get('h.txt')?.tombstone);
  assert.equal((await call('write', { path: 'work/h.txt', content: 'back\n' })).success, true);
  assert.equal(intents.get('h.txt'), null, 'the write took the tombstone away');
  writeFileSync(join(dir, 'g.txt'), 'gone\n');
  assert.equal((await call('read', { path: 'work/g.txt' })).success, true);
  assert.equal((await call('delete', { path: 'work/g.txt' })).success, true);
  assert.equal(await pendingDeletions(), 1);
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    assert.match(errorOf(await call('write', { path: 'work/g.txt', content: 'back\n' })), /^The write of "work\/g\.txt" is stored in the workspace/);
  } finally {
    intents.update = update;
  }
  assert.ok(intents.get('g.txt')?.tombstone, 'the write left the tombstone');
  assert.equal(await pendingDeletions(), 0);
  const materialized = await call('materialize', { path: 'work/g.txt', applyDeletions: true });
  assert.equal(materialized.success, true, materialized.error);
  assert.equal(disk('g.txt')!.toString(), 'back\n');
});

test('a write, edit or delete whose store throws after recording it says the change is stored', async (t) => {
  const { workspace, store, dir, call, stored } = setup(t);
  writeFileSync(join(dir, 'e.txt'), 'line\n');
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  // The change's record lands, then the store throws, as Chronicle 0.4 does
  // when the auto-snapshot it writes after recording fails
  // (anima-research/chronicle#39). Only that record's set throws: the
  // intents' own records go through, a deletion's tombstone before it among
  // them.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const mountTree = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;
  let armed = false;
  for (const name of ['treeSet', 'treeRemove']) {
    const real = s[name]!;
    s[name] = (...args) => {
      const record = real.apply(store, args);
      if (!armed || args[0] !== mountTree) return record;
      armed = false;
      throw new Error('IO error: No space left on device (os error 28)');
    };
  }
  try {
    armed = true;
    assert.equal(errorOf(await call('write', { path: 'work/w.txt', content: 'new\n' })),
      `The write of "work/w.txt" is stored in the workspace, so don't send it again. The store failed after recording it: IO error: No space left on device (os error 28).`);
    armed = true;
    assert.equal(errorOf(await call('edit', { path: 'work/e.txt', oldString: 'line', newString: 'line, edited' })),
      'The edit of "work/e.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
      + 'The store failed after recording it: IO error: No space left on device (os error 28).');
    armed = true;
    assert.equal(errorOf(await call('delete', { path: 'work/d.txt' })),
      'The deletion of "work/d.txt" is stored in the workspace, so don\'t send it again. The store failed after recording it: IO error: No space left on device (os error 28).');
    // writeBinary's peer callers read inChronicle as the file being there.
    armed = true;
    assert.deepEqual(await workspace.writeBinary('work/b.bin', Buffer.from([0, 1, 2]), 'application/octet-stream'), {
      success: false,
      isError: true,
      error: 'Stored "work/b.bin" in Chronicle, but the store failed after recording it: IO error: No space left on device (os error 28).',
      data: { inChronicle: true },
    });
    assert.equal(armed, false);
  } finally {
    delete s.treeSet;
    delete s.treeRemove;
  }
  assert.equal(await stored('w.txt'), 'new\n');
  assert.equal(await stored('e.txt'), 'line, edited\n');
  assert.equal((await call('read', { path: 'work/d.txt' })).success, false);
  // Its tombstone went in before the removal, so the deletion is pending,
  // for a materialize with applyDeletions (on a mount that pushes, the test
  // after this one makes it).
  assert.equal(((await call('status', { mount: 'work' })).data as Record<string, { pendingWorkspaceDeletions: number }>).work!.pendingWorkspaceDeletions, 1);

  // A store that throws before recording a change leaves it unstored, as
  // reading it back shows, and the store's error is the answer.
  writeFileSync(join(dir, 'k.txt'), 'kept\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  for (const name of ['treeSet', 'treeRemove']) s[name] = () => { throw new Error('injected store failure'); };
  try {
    assert.equal(errorOf(await call('write', { path: 'work/k.txt', content: 'changed\n' })), unstored('write', 'work/k.txt', 'injected store failure'));
    assert.equal(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'kept', newString: 'changed' })), unstored('edit', 'work/k.txt', 'injected store failure'));
    assert.equal(errorOf(await call('delete', { path: 'work/k.txt' })), unstored('delete', 'work/k.txt', 'injected store failure'));
  } finally {
    delete s.treeSet;
    delete s.treeRemove;
  }
  assert.equal(await stored('k.txt'), 'kept\n');
  // The read-back compares the whole entry, its mode included. An overwrite
  // keeps the file's mode, so no tool sets the same bytes under another mode;
  // the commit is called here as one would. A set the store records before
  // throwing reads back as landed, and one it doesn't, as not.
  const internals = workspace as unknown as {
    mounts: Map<string, { treeStateId: string }>;
    withMount<T>(mount: unknown, fn: () => Promise<T>): Promise<T>;
    commitToolChanges(mount: unknown, changes: Array<{ path: string; change: { kind: 'set'; blobHash: string; size: number; mode: number } }>): Promise<unknown>;
  };
  const mount = internals.mounts.get('work')!;
  const treeStateId = mount.treeStateId;
  store.treeSet(treeStateId, 'k.txt', { ...store.treeGet(treeStateId, 'k.txt')!, mode: 0o755 });
  const held = store.treeGet(treeStateId, 'k.txt')!;
  const asMode644 = () => internals.withMount(mount, () => internals.commitToolChanges(mount,
    [{ path: 'k.txt', change: { kind: 'set', blobHash: held.blobHash, size: held.size, mode: 0o644 } }]));
  const realSet = store.treeSet;
  for (const records of [false, true]) {
    let once = true;
    s.treeSet = (...args) => {
      if (!once) return realSet.apply(store, args as never);
      once = false;
      if (records) realSet.apply(store, args as never);
      throw new Error('IO error: No space left on device (os error 28)');
    };
    try {
      // Whether the commit recorded it shows in the mode stored, below.
      await assert.rejects(asMode644());
    } finally {
      delete s.treeSet;
    }
    assert.equal(store.treeGet(treeStateId, 'k.txt')!.mode, records ? 0o644 : 0o755);
  }
  // The written path's intent followed the record, so the new file is a draft
  // the workspace made, not a file disk may have deleted.
  const edited = await call('edit', { path: 'work/w.txt', oldString: 'new', newString: 'newer' });
  assert.equal(edited.success, true, edited.error);
  assert.doesNotMatch(String((edited.structured as { note?: string }).note ?? ''), /nothing records/);
});

test('on a mount that pushes, a write, edit or delete whose store throws after recording it says its push didn\'t run, and a materialize takes it to disk', async (t) => {
  const { workspace, store, dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'e.txt'), 'line\n');
  writeFileSync(join(dir, 'd.txt'), 'doomed\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  assert.equal((await call('read', { path: 'work/d.txt' })).success, true);
  // As in the test above, only the change's own record throws.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const mountTree = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;
  let armed = false;
  for (const name of ['treeSet', 'treeRemove']) {
    const real = s[name]!;
    s[name] = (...args) => {
      const record = real.apply(store, args);
      if (!armed || args[0] !== mountTree) return record;
      armed = false;
      throw new Error('IO error: No space left on device (os error 28)');
    };
  }
  const failed = 'The store failed after recording it: IO error: No space left on device (os error 28). ';
  const writes = "Its push to disk didn't run, so disk lacks the change until a materialize of the path writes it.";
  try {
    armed = true;
    assert.equal(errorOf(await call('write', { path: 'work/w.txt', content: 'new\n' })),
      `The write of "work/w.txt" is stored in the workspace, so don't send it again. ${failed}${writes}`);
    armed = true;
    assert.equal(errorOf(await call('edit', { path: 'work/e.txt', oldString: 'line', newString: 'line, edited' })),
      `The edit of "work/e.txt" is stored in the workspace, so don't send it again: a second edit can apply the change twice. ${failed}${writes}`);
    armed = true;
    assert.equal(errorOf(await call('delete', { path: 'work/d.txt' })),
      `The deletion of "work/d.txt" is stored in the workspace, so don't send it again. ${failed}`
      + "Its push to disk didn't run, so disk keeps the file until a materialize of the path with applyDeletions deletes it.");
    armed = true;
    assert.deepEqual(await workspace.writeBinary('work/b.bin', Buffer.from([0, 1, 2]), 'application/octet-stream'), {
      success: false,
      isError: true,
      error: `Stored "work/b.bin" in Chronicle, but the store failed after recording it: IO error: No space left on device (os error 28). `
        + "Its push to disk didn't run, so disk lacks the change until a materialize of the path writes it.",
      data: { inChronicle: true },
    });
    assert.equal(armed, false);
  } finally {
    delete s.treeSet;
    delete s.treeRemove;
  }
  assert.equal(disk('w.txt'), null);
  assert.equal(disk('b.bin'), null);
  assert.equal(disk('e.txt')!.toString(), 'line\n');
  assert.equal(disk('d.txt')!.toString(), 'doomed\n');
  // As each answer says, a materialize of the path takes the change to disk.
  for (const path of ['work/w.txt', 'work/b.bin', 'work/e.txt']) {
    const result = await call('materialize', { path });
    assert.equal(result.success, true, result.error);
  }
  const deleted = await call('materialize', { path: 'work/d.txt', applyDeletions: true });
  assert.equal(deleted.success, true, deleted.error);
  assert.equal(disk('w.txt')!.toString(), 'new\n');
  assert.deepEqual([...disk('b.bin')!], [0, 1, 2]);
  assert.equal(disk('e.txt')!.toString(), 'line, edited\n');
  assert.equal(disk('d.txt'), null);

  // A write of the bytes its path holds already leaves nothing a read back
  // could tell apart, so a set that throws says the file already holds
  // them, with the store's error, whether it recorded first or not.
  const treeStateId = (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;
  const realSet = store.treeSet;
  for (const records of [false, true]) {
    const sets: unknown[][] = [];
    s.treeSet = (...args) => {
      sets.push(args.slice(0, 2));
      if (records) realSet.apply(store, args as never);
      throw new Error('IO error: No space left on device (os error 28)');
    };
    try {
      assert.equal(errorOf(await call('write', { path: 'work/e.txt', content: 'line, edited\n' })),
        `The write of "work/e.txt" stopped on an error the workspace didn't expect: ${NO_SPACE}. "work/e.txt" already held what the call gave, so it holds that in the workspace either way.`);
    } finally {
      delete s.treeSet;
    }
    assert.deepEqual(sets, [[treeStateId, 'e.txt']]);
  }
  assert.equal(disk('e.txt')!.toString(), 'line, edited\n');
});

// ---------------------------------------------------------------------------
// Part 2: a read numbers the lines the file has
// ---------------------------------------------------------------------------

test('a final line end ends the last line, and an empty file reads as empty', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  assert.deepEqual((await call('read', { path: 'work/nl.txt' })).structured, {
    path: 'work/nl.txt', totalLines: 2, fromLine: 1, toLine: 2, content: '     1\ta\n     2\tb',
  });
  writeFileSync(join(dir, 'blank.txt'), 'a\n\n');
  assert.equal(((await call('read', { path: 'work/blank.txt' })).structured as { totalLines: number }).totalLines, 2,
    'an empty line before the final line end is a line');
  writeFileSync(join(dir, 'empty.txt'), '');
  assert.deepEqual((await call('read', { path: 'work/empty.txt' })).structured, { path: 'work/empty.txt', totalLines: 0, content: '' });
});

test('grep numbers lines as read does: no match on an empty line after the last', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'g.txt'), 'x\n');
  const result = await call('grep', { pattern: '^$' });
  assert.equal(result.success, true, result.error);
  assert.deepEqual((result.structured as { results: unknown[] }).results, []);
});

test('grep matches and shows a CRLF file\'s lines without the CR, as read shows them', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'crlf.txt'), 'alpha\r\nfoo\r\nomega\r\n');
  writeFileSync(join(dir, 'mixed.txt'), 'foo\r\nbar\n');
  writeFileSync(join(dir, 'lf.txt'), 'foo\n');
  writeFileSync(join(dir, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('foo\n')]));
  const result = await call('grep', { pattern: '^foo$', contextBefore: 1, contextAfter: 1 });
  assert.equal(result.success, true, result.error);
  type Result = { file: string; lineEndings?: string; matches: unknown[] };
  const byFile = Object.fromEntries((result.structured as { results: Result[] }).results.map((r) => [r.file, r]));
  assert.deepEqual(byFile['work/crlf.txt'], {
    file: 'work/crlf.txt', state: 'synced', version: 'workspace', lineEndings: 'CRLF',
    matches: [{ line: 2, text: 'foo', context: ['alpha', 'foo', 'omega'] }],
  });
  assert.equal(byFile['work/mixed.txt'].lineEndings, 'mixed');
  assert.equal('lineEndings' in byFile['work/lf.txt'], false);
  // A BOM is no part of the first line, as read doesn't show it.
  assert.deepEqual(byFile['work/bom.txt'].matches, [{ line: 1, text: 'foo', context: ['foo'] }]);
  // The cost: a pattern written to find the CR at a line's end no longer
  // does, and the answer says why.
  const noteFor = (files: string) => `The pattern names a CR, and ${files}. Lines are matched as read shows them, `
    + "which leaves out a CRLF end's CR unless the line's own text ends in a CR. read with offsetChars shows every CR in the workspace's copy.";
  const note = noteFor('1 file searched has CRLF line ends: work/crlf.txt (CRLF)');
  for (const pattern of ['\\r', '\r', 'o[\\r]?$', '\\\\\\r', '\\x0d', '\\x0D', '\\u000d', '\\u000D', '\\cM', '\\cm', '\\015', '[\\x0d]', '\\\r']) {
    const cr = await call('grep', { pattern, path: 'work/crlf.txt' });
    const data = cr.structured as { results: Array<{ matches: unknown[] }>; note?: string };
    assert.equal(data.note, note, JSON.stringify(pattern));
    if (pattern !== 'o[\\r]?$') assert.deepEqual(data.results, [], JSON.stringify(pattern));
  }
  // A pattern that names no CR, and a CR pattern over files without a CRLF
  // end, get no note.
  for (const [pattern, path] of [['foo', 'work/crlf.txt'], ['\\\\r', 'work/crlf.txt'], ['\\\\x0d', 'work/crlf.txt'], ['\\\\cM', 'work/crlf.txt'],
    ['\\\\u000d', 'work/crlf.txt'], ['\\R', 'work/crlf.txt'], ['\\X0D', 'work/crlf.txt'], ['\\U000D', 'work/crlf.txt'], ['\\CM', 'work/crlf.txt'], ['\\r', 'work/lf.txt']]) {
    const data = (await call('grep', { pattern, path })).structured as object;
    assert.equal('note' in data, false, JSON.stringify([pattern, path]));
  }
  writeFileSync(join(dir, 'lone.txt'), 'a\rb\n');
  const lone = (await call('grep', { pattern: '\\r', path: 'work/lone.txt' })).structured as { results: Array<{ matches: unknown[] }> };
  assert.equal('note' in lone, false);
  assert.deepEqual(lone.results[0].matches, [{ line: 1, text: 'a\rb' }]);
  // Any CRLF file searched gives the note, whatever comes after it: here an LF
  // file is searched on either side of the CRLF one, whichever order the walk
  // takes. A file the glob passes over isn't searched, so it gives none: here
  // the glob takes a.txt alone, which the search finds.
  mkdirSync(join(dir, 'many'));
  writeFileSync(join(dir, 'many', 'a.txt'), 'x\n');
  writeFileSync(join(dir, 'many', 'b.txt'), 'x\r\n');
  writeFileSync(join(dir, 'many', 'c.txt'), 'x\n');
  assert.equal(((await call('grep', { pattern: '\\r', path: 'work/many' })).structured as { note?: string }).note,
    noteFor('1 file searched has CRLF line ends: work/many/b.txt (CRLF)'));
  const globbed = (await call('grep', { pattern: 'x|\\r', path: 'work/many', glob: 'many/a.txt' })).structured as { results: Array<{ file: string }> };
  assert.deepEqual(globbed.results.map((r) => r.file), ['work/many/a.txt']);
  assert.equal('note' in globbed, false);
});

test("grep says a BOM isn't part of the first line when a pattern for U+FEFF searched a file that starts with one", async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('foo\n')]));
  writeFileSync(join(dir, 'inner.txt'), 'a\uFEFFb\n');
  const noteFor = (file: string) => `The pattern names U+FEFF, and 1 file searched starts with a BOM: ${file}. Lines are matched as read shows them, `
    + "and a BOM isn't part of the first line. read with offsetChars shows any BOM the workspace's copy has.";
  const note = noteFor('work/bom.txt');
  for (const pattern of ['\\uFEFF', '^\\ufeff', '\uFEFF', '\\\uFEFF']) {
    const data = (await call('grep', { pattern, path: 'work/bom.txt' })).structured as { results: unknown[]; note?: string };
    assert.equal(data.note, note, JSON.stringify(pattern));
    assert.deepEqual(data.results, [], JSON.stringify(pattern));
  }
  // An escaped backslash names no U+FEFF, nor does \U, an identity escape,
  // and a U+FEFF inside a line, in a file with no BOM, is found with no note.
  for (const pattern of ['\\\\uFEFF', '\\UFEFF']) {
    assert.equal('note' in ((await call('grep', { pattern, path: 'work/bom.txt' })).structured as object), false, JSON.stringify(pattern));
  }
  const inner = (await call('grep', { pattern: '\\uFEFF', path: 'work/inner.txt' })).structured as { results: Array<{ matches: unknown[] }> };
  assert.equal('note' in inner, false);
  assert.deepEqual(inner.results[0].matches, [{ line: 1, text: 'a\uFEFFb' }]);
  // A CR pattern over the BOM file, which has no CRLF end, and a U+FEFF
  // pattern over a CRLF file with no BOM, get no note.
  writeFileSync(join(dir, 'crlf.txt'), 'x\r\n');
  assert.equal('note' in ((await call('grep', { pattern: '\\r', path: 'work/bom.txt' })).structured as object), false);
  assert.equal('note' in ((await call('grep', { pattern: '\\uFEFF', path: 'work/crlf.txt' })).structured as object), false);
  // Any BOM file searched gives the note, whatever comes after it: a file
  // without one is searched on either side of the BOM file.
  mkdirSync(join(dir, 'boms'));
  writeFileSync(join(dir, 'boms', 'a.txt'), 'x\n');
  writeFileSync(join(dir, 'boms', 'b.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')]));
  writeFileSync(join(dir, 'boms', 'c.txt'), 'x\n');
  assert.equal(((await call('grep', { pattern: '\\uFEFF', path: 'work/boms' })).structured as { note?: string }).note, noteFor('work/boms/b.txt'));
  // A pattern that names both, over a file with a BOM and CRLF ends, gets both
  // notes, the CR's first.
  writeFileSync(join(dir, 'both.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\n')]));
  const crNote = "The pattern names a CR, and 1 file searched has CRLF line ends: work/both.txt (CRLF). Lines are matched as read shows them, "
    + "which leaves out a CRLF end's CR unless the line's own text ends in a CR. read with offsetChars shows every CR in the workspace's copy.";
  const both = (await call('grep', { pattern: '^\\uFEFF|\\r$', path: 'work/both.txt' })).structured as { results: unknown[]; note?: string };
  assert.equal(both.note, `${crNote} ${noteFor('work/both.txt')}`);
  assert.deepEqual(both.results, []);
});

test("grep's note on a pattern for a CR or U+FEFF names the files searched that have CRLF ends or a BOM, counting every one and naming at most 20", async (t) => {
  const { dir, call } = setup(t, { maxFileSize: 1000 });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(join(dir, 'lf.txt'), 'a\nb\n');
  writeFileSync(join(dir, 'win.bat'), 'echo one\r\necho two\r\n');
  writeFileSync(join(dir, 'mixed.cfg'), 'x=1\r\ny=2\nz=3\r\n');
  writeFileSync(join(dir, 'bom.txt'), Buffer.concat([bom, Buffer.from('first\n')]));
  writeFileSync(join(dir, 'both.json'), Buffer.concat([bom, Buffer.from('{}\r\n')]));
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `src${i}.ts`), `export const v${i} = ${i};\n`);
  // Files grep doesn't search, binary or over the size limit, are listed as
  // skipped and named in no note.
  writeFileSync(join(dir, 'blob.bin'), Buffer.concat([bom, Buffer.from('x\r\n\0y\r\n')]));
  writeFileSync(join(dir, 'big.txt'), Buffer.concat([bom, Buffer.from('z\r\n'.repeat(400))]));
  const tail = "Lines are matched as read shows them, which leaves out a CRLF end's CR unless the line's own text ends in a CR. "
    + "read with offsetChars shows every CR in the workspace's copy.";
  // On main, \r$ found these files' lines; here no line keeps a CRLF end's
  // CR, so the note names the files, mixed ends as such, sorted as results are.
  const cr = (await call('grep', { pattern: '\\r$' })).structured as { results: unknown[]; totalMatches: number; note?: string; skipped?: Array<{ file: string }> };
  assert.deepEqual([cr.results, cr.totalMatches], [[], 0]);
  assert.deepEqual(cr.skipped?.map((s) => s.file), ['work/big.txt', 'work/blob.bin']);
  assert.equal(cr.note, 'The pattern names a CR, and 3 files searched have CRLF line ends: '
    + `work/both.json (CRLF), work/mixed.cfg (mixed), work/win.bat (CRLF). ${tail}`);
  const boms = (await call('grep', { pattern: '^\\uFEFF' })).structured as { results: unknown[]; note?: string };
  assert.deepEqual(boms.results, []);
  assert.equal(boms.note, 'The pattern names U+FEFF, and 2 files searched start with a BOM: work/bom.txt, work/both.json. '
    + "Lines are matched as read shows them, and a BOM isn't part of the first line. read with offsetChars shows any BOM the workspace's copy has.");
  // Past 20 files the count stays exact, and the rest are found by narrowing.
  mkdirSync(join(dir, 'many'));
  for (let i = 0; i < 23; i++) writeFileSync(join(dir, 'many', `f${String(i).padStart(2, '0')}.txt`), 'x\r\n');
  const many = (await call('grep', { pattern: '\\r', path: 'work/many' })).structured as { note?: string };
  const first20 = Array.from({ length: 20 }, (_, i) => `work/many/f${String(i).padStart(2, '0')}.txt (CRLF)`).join(', ');
  assert.equal(many.note, `The pattern names a CR, and 23 files searched have CRLF line ends: ${first20}, and 3 more; narrow with path or glob. ${tail}`);
  const narrowed = (await call('grep', { pattern: '\\r', path: 'work/many', glob: 'many/f2*.txt' })).structured as { note?: string };
  assert.equal(narrowed.note, 'The pattern names a CR, and 3 files searched have CRLF line ends: '
    + `work/many/f20.txt (CRLF), work/many/f21.txt (CRLF), work/many/f22.txt (CRLF). ${tail}`);
});

test('text copied from a read or a grep of a CRLF file matches in an edit, and the file keeps its line ends and BOM', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(join(dir, 'w.txt'), Buffer.concat([bom, Buffer.from('one\r\ntwo\r\nthree\r\n')]));
  // Two lines as the read shows them, each without its number and tab.
  const page = (await call('read', { path: 'work/w.txt' })).structured as { content: string };
  const copied = page.content.split('\n').slice(0, 2).map((line) => line.slice(line.indexOf('\t') + 1)).join('\n');
  assert.equal(copied, 'one\ntwo');
  const edit = await call('edit', { path: 'work/w.txt', oldString: copied, newString: 'ONE\nTWO' });
  assert.equal(edit.success, true, edit.error);
  assert.deepEqual(disk('w.txt'), Buffer.concat([bom, Buffer.from('ONE\r\nTWO\r\nthree\r\n')]));
  // A grep match's text copies the same way.
  const found = await call('grep', { pattern: '^three$', path: 'work/w.txt' });
  const text = (found.structured as { results: Array<{ matches: Array<{ text: string }> }> }).results[0].matches[0].text;
  const second = await call('edit', { path: 'work/w.txt', oldString: text, newString: 'THREE' });
  assert.equal(second.success, true, second.error);
  assert.deepEqual(disk('w.txt'), Buffer.concat([bom, Buffer.from('ONE\r\nTWO\r\nTHREE\r\n')]));
});

test('lines whose own text ends in a CR, copied from a read, edit the lines they came from', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  // Lines 1 and 2 end in a CR before their CRLF end; lines 3 and 4 hold the
  // same text with a CRLF end alone.
  writeFileSync(join(dir, 'cr.txt'), 'x\r\r\ny\r\r\nx\r\ny\r\n');
  const page = (await call('read', { path: 'work/cr.txt' })).structured as { content: string; note: string };
  assert.equal(page.note, 'Line ends are CRLF, shown without the CR, except on 2 lines whose own text ends in a CR, which show both CRs. '
    + 'An edit matches text as read shows it, and keeps the CRLF ends.');
  const copied = page.content.split('\n').slice(0, 2).map((line) => line.slice(line.indexOf('\t') + 1)).join('\n');
  assert.equal(copied, 'x\r\r\ny\r\r');
  const edit = await call('edit', { path: 'work/cr.txt', oldString: copied, newString: 'Q\nR' });
  assert.equal(edit.success, true, edit.error);
  assert.equal(disk('cr.txt')!.toString(), 'Q\r\nR\r\nx\r\ny\r\n');
  // A grep match's text copies the same way.
  writeFileSync(join(dir, 'one.txt'), 'w\r\r\nw\r\n');
  const found = await call('grep', { pattern: '^w', path: 'work/one.txt' });
  const texts = (found.structured as { results: Array<{ matches: Array<{ text: string }> }> }).results[0].matches.map((m) => m.text);
  assert.deepEqual(texts, ['w\r\r', 'w']);
  const second = await call('edit', { path: 'work/one.txt', oldString: texts[0], newString: 'V' });
  assert.equal(second.success, true, second.error);
  assert.equal(disk('one.txt')!.toString(), 'V\r\nw\r\n');
});

test('an offset or limit that is not a whole number of at least 1 is refused', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  for (const input of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { offset: null }, { limit: 0 }, { limit: 2.5 }]) {
    assert.match(errorOf(await call('read', { path: 'work/nl.txt', ...input })),
      /^The read call did nothing: "(offset|limit)" must be a whole number of at least 1, not /, JSON.stringify(input));
  }
});

test('an offset past the last line answers empty, with the line count and no range', async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
  writeFileSync(join(dir, 'empty.txt'), '');
  assert.deepEqual((await call('read', { path: 'work/empty.txt', offset: 2 })).structured, {
    path: 'work/empty.txt', totalLines: 0, note: 'Line 2 is past the end: the file has 0 lines.', content: '',
  });
  for (const offset of [3, 10]) {
    assert.deepEqual((await call('read', { path: 'work/nl.txt', offset })).structured, {
      path: 'work/nl.txt', totalLines: 2, note: `Line ${offset} is past the end: the file has 2 lines.`, content: '',
    });
  }
});

// ---------------------------------------------------------------------------
// Part 2: an edit applies to the text disk holds now
// ---------------------------------------------------------------------------

test("an edit applies to disk's text when disk changed and the store didn't, and says so", async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 's.txt'), 'v1 line\n');
  assert.equal((await call('read', { path: 'work/s.txt' })).success, true);
  writeFileSync(join(dir, 's.txt'), 'v2 line from another writer\n');

  const edit = await call('edit', { path: 'work/s.txt', oldString: 'line', newString: 'LINE' });
  assert.equal(edit.success, true, edit.error);
  assert.match((edit.structured as { note: string }).note, /^Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit applied to that text\.$/);
  assert.equal(disk('s.txt')!.toString(), 'v2 LINE from another writer\n');
  assert.equal(await stored('s.txt'), 'v2 LINE from another writer\n');

  // Text only the older copy held isn't there to replace, and the refusal says why.
  writeFileSync(join(dir, 's.txt'), 'v3 from another writer\n');
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'LINE', newString: 'x' })),
    "The edit did nothing: oldString isn't in work/s.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + "Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit looked in that text.");
  writeFileSync(join(dir, 's.txt'), 'v4 twice twice\n');
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'twice', newString: 'x' })),
    'The edit did nothing: oldString occurs 2 times in work/s.txt (on line 1). '
    + 'Add the text around it to make it unique, or set replaceAll to replace every one.\n     1\tv4 twice twice\n\n'
    + "Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit looked in that text.");
});

test('an edit of a draft whose disk copy also changed applies to the draft and names the conflict', async (t) => {
  const { dir, call, disk, stored } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');

  // A miss says so too: the text the agent sought may be disk's.
  assert.equal(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'another', newString: 'x' })),
    "The edit did nothing: oldString isn't in work/k.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + "The path is in conflict with disk (both-changed): the edit looked in the workspace's copy. Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
  assert.equal(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'a', newString: 'x' })),
    'The edit did nothing: oldString occurs 2 times in work/k.txt (on line 1). Add the text around it to make it unique, or set replaceAll to replace every one.\n'
    + '     1\tagent draft\n\n'
    + "The path is in conflict with disk (both-changed): the edit looked in the workspace's copy. Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
  const edit = await call('edit', { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' });
  assert.equal(edit.success, true, edit.error);
  assert.equal((edit.structured as { note: string }).note,
    "The path is in conflict with disk (both-changed): the edit is in the workspace's copy. Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
  assert.equal(await stored('k.txt'), 'agent draft, edited\n');
  assert.equal(disk('k.txt')!.toString(), 'another writer\n');
});

test("an edit refused for a workspace copy that isn't valid UTF-8 names the path's conflict too", async (t) => {
  const { store, dir, call } = setup(t);
  // An entry from before the evidence, beside a disk copy that differs:
  // nothing records which is newer.
  const latin1 = Buffer.from('caf\xe9\n', 'latin1');
  store.treeSet('workspace/work/tree', 'c.txt', { blobHash: store.storeBlob(latin1, 'text/plain'), size: latin1.byteLength, mode: 0o644 });
  writeFileSync(join(dir, 'c.txt'), 'disk copy\n');
  assert.match(errorOf(await call('edit', { path: 'work/c.txt', oldString: 'caf', newString: 'tea' })),
    /^The edit did nothing: work\/c\.txt isn't valid UTF-8, .*\n\nThe path is in conflict with disk \(unknown-provenance\): the edit looked in the workspace's copy\. Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's\.$/);
});

test("a read shows disk's text when disk changed and the store didn't, and says so", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'r.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/r.txt' })).success, true);
  writeFileSync(join(dir, 'r.txt'), 'v2 from another writer\n');
  const taken = "Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and this read shows that text.";
  assert.deepEqual((await call('read', { path: 'work/r.txt' })).structured, {
    path: 'work/r.txt', totalLines: 1, fromLine: 1, toLine: 1, note: taken, content: '     1\tv2 from another writer',
  });
  // That's the workspace's copy now, so the next read has nothing to say.
  assert.deepEqual((await call('read', { path: 'work/r.txt' })).structured, {
    path: 'work/r.txt', totalLines: 1, fromLine: 1, toLine: 1, content: '     1\tv2 from another writer',
  });
  // A character page settles and says so too.
  writeFileSync(join(dir, 'r.txt'), 'v3\n');
  assert.deepEqual((await call('read', { path: 'work/r.txt', offsetChars: 0 })).structured, {
    path: 'work/r.txt', totalChars: 3, offsetChars: 0, nextOffsetChars: null, note: taken, content: 'v3\n',
  });
});

test('a read of a file disk deleted since the workspace read it says so', async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'g.txt'), 'here\n');
  assert.equal((await call('read', { path: 'work/g.txt' })).success, true);
  rmSync(join(dir, 'g.txt'));
  assert.equal(errorOf(await call('read', { path: 'work/g.txt' })),
    `The read did nothing: there's no file at "work/g.txt" any more: disk's copy was deleted since the workspace last agreed with it, and the workspace took that in first. ls or glob lists the files that exist.`);
});

test('a read of a draft whose disk copy also changed shows the draft and names the conflict', async (t) => {
  const { dir, call, disk } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  assert.deepEqual((await call('read', { path: 'work/k.txt' })).structured, {
    path: 'work/k.txt', totalLines: 1, fromLine: 1, toLine: 1,
    note: "The path is in conflict with disk (both-changed): this read shows the workspace's copy. "
      + "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.",
    content: '     1\tagent draft',
  });
  assert.equal(disk('k.txt')!.toString(), 'another writer\n', 'the read left disk as it was');
});

test("a read of a draft whose disk copy turned binary says a sync keeps disk's copy and gives up the draft, which it does", async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'm.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/m.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/m.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'm.txt'), Buffer.from([0, 1, 2, 0, 255, 0]));
  assert.equal(((await call('read', { path: 'work/m.txt' })).structured as { note: string }).note,
    "The path is in conflict with disk (both-changed): this read shows the workspace's copy. "
      + "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
  // The workspace can't hold disk's copy, so the sync takes nothing in: the
  // draft goes, and disk keeps its bytes.
  assert.equal((await call('sync', { path: 'work/m.txt' })).success, true);
  assert.equal(errorOf(await call('read', { path: 'work/m.txt' })),
    `The read did nothing: "work/m.txt" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. read, edit and delete act only on the files it stores, so calling again won't change that.`);
  assert.deepEqual([...readFileSync(join(dir, 'm.txt'))], [0, 1, 2, 0, 255, 0]);
});

test('a read of a draft whose disk copy was deleted says a sync takes the deletion, and each way out does what it says', async (t) => {
  const { dir, call, disk } = setup(t);
  for (const name of ['d.txt', 'e.txt']) {
    writeFileSync(join(dir, name), 'base\n');
    assert.equal((await call('read', { path: `work/${name}` })).success, true);
    assert.equal((await call('write', { path: `work/${name}`, content: 'agent draft\n' })).success, true);
    rmSync(join(dir, name));
    assert.deepEqual((await call('read', { path: `work/${name}` })).structured, {
      path: `work/${name}`, totalLines: 1, fromLine: 1, toLine: 1,
      note: "The path is in conflict with disk (deleted-on-disk): this read shows the workspace's copy. "
        + "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk.",
      content: '     1\tagent draft',
    });
  }
  // A conflict recorded before disk deleted the file keeps its kind, and the
  // note follows what disk holds now.
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/f.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/f.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'f.txt'), 'another writer\n');
  const noteOf = async (path: string) => ((await call('read', { path })).structured as { note: string }).note;
  assert.match(await noteOf('work/f.txt'), /^The path is in conflict with disk \(both-changed\): .*Sync the path to keep disk's copy and give up the workspace's/);
  rmSync(join(dir, 'f.txt'));
  assert.equal(await noteOf('work/f.txt'),
    "The path is in conflict with disk (both-changed): this read shows the workspace's copy. "
      + "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk.");
  // A sync of the path takes the deletion: the draft goes.
  assert.equal((await call('sync', { path: 'work/d.txt' })).success, true);
  assert.equal(errorOf(await call('read', { path: 'work/d.txt' })), `The read did nothing: there's no file at "work/d.txt". ls or glob lists the files that exist.`);
  // A forced materialize of the path writes the draft back.
  assert.equal((await call('materialize', { path: 'work/e.txt', force: true })).success, true);
  assert.equal(disk('e.txt')!.toString(), 'agent draft\n');
});

test("a read whose disk copy can't be checked says it shows the workspace's copy", async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'u.txt'), 'held\n');
  assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
  rmSync(join(dir, 'u.txt'));
  mkdirSync(join(dir, 'u.txt'));
  assert.deepEqual((await call('read', { path: 'work/u.txt' })).structured, {
    path: 'work/u.txt', totalLines: 1, fromLine: 1, toLine: 1,
    note: "The path couldn't be checked against disk (a directory), so this read shows the workspace's copy.",
    content: '     1\theld',
  });
});

test("a read of a held file whose mount's root is gone says disk couldn't be checked, and doesn't say to read again", async (t) => {
  // The pass reports the path as unverified and leaves the root's region
  // incomplete. It didn't give up on a branch that kept changing, so reading
  // again won't check it.
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'u.txt'), 'held\n');
  assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
  renameSync(dir, join(dir, '..', 'gone'));
  assert.deepEqual((await call('read', { path: 'work/u.txt' })).structured, {
    path: 'work/u.txt', totalLines: 1, fromLine: 1, toLine: 1,
    note: "The path couldn't be checked against disk (the mount root is unavailable), so this read shows the workspace's copy.",
    content: '     1\theld',
  });
});

test("a read of a file disk lacks, with nothing to say whether disk deleted it, says it shows the workspace's copy", async (t) => {
  const { store, call } = setup(t);
  // An entry from before the evidence (as three-way's legacyEntry makes it).
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  assert.deepEqual((await call('read', { path: 'work/l.txt' })).structured, {
    path: 'work/l.txt', totalLines: 1, fromLine: 1, toLine: 1,
    note: "Disk has no copy of this file, and nothing records whether it was deleted there, so this read shows the workspace's copy.",
    content: '     1\tlegacy line',
  });
});

test("a read of a file disk made binary answers the disk-only text, not a deletion", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'b.txt'), 'text\n');
  assert.equal((await call('read', { path: 'work/b.txt' })).success, true);
  writeFileSync(join(dir, 'b.txt'), Buffer.from([0, 1, 2, 0, 255, 0]));
  assert.equal(errorOf(await call('read', { path: 'work/b.txt' })),
    `The read did nothing: "work/b.txt" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. read, edit and delete act only on the files it stores, so calling again won't change that.`);
});

test('readBinary serves a binary file the workspace holds as it holds it, though disk changed it', async (t) => {
  // A settle would drop the held copy, since the tree takes in no binary disk
  // copy, and readBinary, a reader of binary content, would find nothing.
  const { workspace, dir } = setup(t, { autoMaterialize: true });
  const held = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  assert.equal((await workspace.writeBinary('work/i.png', held, 'image/png')).success, true);
  writeFileSync(join(dir, 'i.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));
  const read = await workspace.readBinary('work/i.png');
  assert.ok('data' in read, JSON.stringify(read));
  assert.deepEqual([...read.data], [...held]);
});

// ---------------------------------------------------------------------------
// Part 5: smaller texts
// ---------------------------------------------------------------------------

test("grep's refusal of an invalid pattern gives the parser's reason", async (t) => {
  const { dir, call } = setup(t);
  writeFileSync(join(dir, 'g.txt'), 'x\n');
  assert.match(errorOf(await call('grep', { pattern: '(' })), /^The grep did nothing: "pattern" "\(" isn't a valid regular expression \(Unterminated group\)\. To match a character such as "\(", "\[" or "\*" as itself, put "\\" before it\.$/);
});

test('a refusal raised inside a tool reads without an "Error: " prefix', async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('read', { path: 'zzz/a.txt' })), `The read did nothing: "zzz/a.txt" starts with "zzz", which is no mount's name, and a path starts with its mount's name; the mounts are "work".`);
});

test("a push that disk's shape refuses names what's in the way and the way out", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  mkdirSync(join(dir, 'sub'));
  assert.match(errorOf(await call('write', { path: 'work/sub', content: 'x\n' })),
    /Its push to disk didn't complete: disk has a directory at this path, and no push writes a file over one, forced or not — move or remove that directory on disk and materialize again, or write the file under another path\./);
  const forced = await call('materialize', { path: 'work/sub', force: true });
  assert.match(JSON.stringify(forced.data), /not written: disk has a directory at this path, and no push writes a file over one, forced or not/);

  writeFileSync(join(dir, 'f.txt'), 'file\n');
  assert.match(errorOf(await call('write', { path: 'work/f.txt/x.txt', content: 'x\n' })),
    /Its push to disk didn't complete: not written: disk has a file or a symlink where this path needs a directory, and no push writes below one, forced or not — move or remove it on disk and materialize again, or write the file under another path\./);
});

test('a deletion whose path disk has made a directory is not told to write the file elsewhere', async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'gone.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/gone.txt' })).success, true);
  rmSync(join(dir, 'gone.txt'));
  mkdirSync(join(dir, 'gone.txt'));
  const refused = errorOf(await call('delete', { path: 'work/gone.txt' }));
  assert.match(refused, /^The deletion of "work\/gone\.txt" is stored in the workspace/);
  assert.doesNotMatch(refused, /write the file under another path/, 'nothing is being written');
  assert.match(refused, /Its push to disk didn't complete: disk has a directory at this path, and no push unlinks one, forced or not — if it should go, move or remove it on disk\.$/);
});

// ---------------------------------------------------------------------------
// The fix round of the first review (af-ws-fix)
// ---------------------------------------------------------------------------

test('an edit that would replace nothing is refused, with replaceAll too', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'r.txt'), 'abc\n');
  assert.equal(errorOf(await call('edit', { path: 'work/r.txt', oldString: 'zzz', newString: 'y', replaceAll: true })),
    "The edit did nothing: oldString isn't in work/r.txt.\nMatch exactly, including whitespace and indentation.");
  assert.equal(disk('r.txt')!.toString(), 'abc\n');
});

test('an edit of a file disk deleted since the workspace read it says so', async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'g.txt'), 'here\n');
  assert.equal((await call('read', { path: 'work/g.txt' })).success, true);
  rmSync(join(dir, 'g.txt'));
  assert.equal(errorOf(await call('edit', { path: 'work/g.txt', oldString: 'here', newString: 'x' })),
    `The edit did nothing: there's no file at "work/g.txt" any more: disk's copy was deleted since the workspace last agreed with it, and the workspace took that in first. ls or glob lists the files that exist.`);
  assert.equal(existsSync(join(dir, 'g.txt')), false, 'the edit put nothing back');
});

test("an edit whose disk copy can't be checked says it used the workspace's copy, stored or not", async (t) => {
  for (const autoMaterialize of [false, true]) {
    const { dir, call, stored } = setup(t, { autoMaterialize });
    writeFileSync(join(dir, 'u.txt'), 'held\n');
    assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
    rmSync(join(dir, 'u.txt'));
    mkdirSync(join(dir, 'u.txt'));
    const used = "The path couldn't be checked against disk (a directory), so the edit applied to the workspace's copy.";
    const edit = await call('edit', { path: 'work/u.txt', oldString: 'held', newString: 'held, edited' });
    if (autoMaterialize) {
      // Its push meets the directory, and the stored answer carries the note.
      assert.equal(errorOf(edit), 'The edit of "work/u.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
        + "Its push to disk didn't complete: disk has a directory at this path, and no push writes a file over one, forced or not — "
        + `move or remove that directory on disk and materialize again, or write the file under another path. ${used}`);
    } else {
      assert.equal(edit.success, true, edit.error);
      assert.equal((edit.structured as { note: string }).note, used);
    }
    assert.equal(await stored('u.txt'), 'held, edited\n');
    assert.equal(errorOf(await call('edit', { path: 'work/u.txt', oldString: 'zzz', newString: 'x' })),
      "The edit did nothing: oldString isn't in work/u.txt.\nMatch exactly, including whitespace and indentation.\n\n"
      + "The path couldn't be checked against disk (a directory), so the edit looked in the workspace's copy.");
  }
});

test('a write, edit or delete that fails before its change is stored answers only the failure', async (t) => {
  const { workspace, dir, call, stored } = setup(t);
  writeFileSync(join(dir, 'e.txt'), 'line\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  // Every write, edit and delete takes the mount's turn before anything else.
  const ws = workspace as unknown as { withMount: (...args: unknown[]) => Promise<unknown> };
  const withMount = ws.withMount;
  ws.withMount = async () => { throw new Error('injected before the entry'); };
  try {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['write', { path: 'work/w.txt', content: 'new\n' }],
      ['edit', { path: 'work/e.txt', oldString: 'line', newString: 'x' }],
      ['delete', { path: 'work/e.txt' }],
    ];
    for (const [name, input] of calls) {
      const result = await call(name, input);
      assert.equal(errorOf(result), unstored(name, input.path as string, 'injected before the entry'), name);
    }
  } finally {
    ws.withMount = withMount;
  }
  assert.equal(await stored('e.txt'), 'line\n');
  assert.equal((await call('read', { path: 'work/w.txt' })).success, false, 'nothing was stored');
});

test('an edit of a draft whose disk copy also changed, on a mount that pushes, names the conflict its push met', async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  // The write's push is refused, so the workspace keeps it as a draft.
  assert.match(errorOf(await call('write', { path: 'work/k.txt', content: 'agent draft\n' })), /^The write of "work\/k\.txt" is stored in the workspace/);
  const edit = await call('edit', { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' });
  assert.equal(errorOf(edit), 'The edit of "work/k.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
    + "Its push to disk didn't complete: stale copy: disk changed since it last agreed with the workspace (conflict: both-changed) — "
    + 'sync this path to adopt the disk version, or materialize it with force to overwrite it.');
  assert.equal(await stored('k.txt'), 'agent draft, edited\n');
  assert.equal(disk('k.txt')!.toString(), 'another writer\n');

  // An edit that makes the draft agree with disk settles the conflict as its
  // push meets it, so its answer names none.
  const agreed = await call('edit', { path: 'work/k.txt', oldString: 'agent draft, edited', newString: 'another writer' });
  assert.equal(agreed.success, true, agreed.error);
  assert.equal((agreed.structured as { note?: string }).note, undefined, 'no conflict remains to name');
  assert.equal(await stored('k.txt'), 'another writer\n');
  assert.equal(disk('k.txt')!.toString(), 'another writer\n');
  const after = await call('materialize', { path: 'work/k.txt' });
  assert.equal(after.success, true, after.error);
  assert.doesNotMatch(JSON.stringify(after.data), /conflict/, 'and a materialize meets none');
});

test('an edit that fails after its change is stored, having taken disk\'s change in, says both', async (t) => {
  const { workspace, dir, call, stored } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'e.txt'), 'v1 line\n');
  assert.equal((await call('read', { path: 'work/e.txt' })).success, true);
  writeFileSync(join(dir, 'e.txt'), 'v2 line from another writer\n');
  const ws = workspace as unknown as { pushUnlocked: (...args: unknown[]) => Promise<unknown> };
  const push = ws.pushUnlocked;
  ws.pushUnlocked = async () => { throw new Error('injected push exception'); };
  try {
    const edit = await call('edit', { path: 'work/e.txt', oldString: 'line', newString: 'LINE' });
    assert.equal(errorOf(edit), 'The edit of "work/e.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
      + "The rest of the call failed: injected push exception. ls shows the path's state. "
      + "Disk's copy had changed since the workspace last agreed with it, so it was taken in first, and the edit applied to that text.");
  } finally {
    ws.pushUnlocked = push;
  }
  assert.equal(await stored('e.txt'), 'v2 LINE from another writer\n');
});

test('a deletion whose disk copy is not a regular file says no push unlinks it, forced or not', { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'q.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/q.txt' })).success, true);
  rmSync(join(dir, 'q.txt'));
  assert.equal(spawnSync('mkfifo', [join(dir, 'q.txt')]).status, 0, 'mkfifo');
  const noPush = 'disk has a pipe, socket or device at this path, or a symlink to one, and no push unlinks it, forced or not — '
    + 'ask whoever runs this host if it should go';
  assert.equal(errorOf(await call('delete', { path: 'work/q.txt' })), 'The deletion of "work/q.txt" is stored in the workspace, so don\'t send it again. '
    + `Its push to disk didn't complete: ${noPush}.`);
  const forced = await call('materialize', { path: 'work/q.txt', force: true, applyDeletions: true });
  assert.equal(forced.success, true, forced.error);
  assert.deepEqual((forced.data as { skipped?: unknown }).skipped, [{ mount: 'work', reason: `q.txt: not unlinked: ${noPush}` }]);
  assert.equal(statSync(join(dir, 'q.txt')).isFIFO(), true, 'the FIFO stays');
});

// ---------------------------------------------------------------------------
// The fix round of the second review (af-ws-fix-r1)
// ---------------------------------------------------------------------------

test("an edit of a file disk made binary answers the disk-only text, not a deletion", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'b.txt'), 'text\n');
  assert.equal((await call('read', { path: 'work/b.txt' })).success, true);
  writeFileSync(join(dir, 'b.txt'), Buffer.from([0, 1, 2, 0, 255, 0]));
  assert.equal(errorOf(await call('edit', { path: 'work/b.txt', oldString: 'text', newString: 'x' })),
    `The edit did nothing: "work/b.txt" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. read, edit and delete act only on the files it stores, so calling again won't change that.`);
  assert.deepEqual([...readFileSync(join(dir, 'b.txt'))], [0, 1, 2, 0, 255, 0], 'disk keeps its bytes');
});

test('a deletion of a draft that met a disk file the workspace never saw completes, leaves that file alone, and says so', async (t) => {
  const { dir, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'c.txt'), 'disk text\n');
  // The workspace never read c.txt, so its write is a draft that collides.
  assert.match(errorOf(await call('write', { path: 'work/c.txt', content: 'agent text\n' })), /conflict: store-origin-collision/);
  // Deleting the draft gives up the workspace's side, and disk never agreed
  // with it: nothing is pushed, disk's file is a sync's to observe, and the
  // answer says nothing was unlinked.
  const deleted = await call('delete', { path: 'work/c.txt' });
  assert.equal(deleted.success, true, String(deleted.error));
  assert.match(String((deleted.data as { note?: string }).note), /^nothing was unlinked: /);
  assert.equal(disk('c.txt')!.toString(), 'disk text\n');
});

test('a deletion of such a draft whose store throws after recording it says it unlinked nothing, and no push was owed', async (t) => {
  const { dir, store, call, disk } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'c.txt'), 'disk text\n');
  assert.match(errorOf(await call('write', { path: 'work/c.txt', content: 'agent text\n' })), /conflict: store-origin-collision/);
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = store.treeRemove;
  let armed = true;
  s.treeRemove = (...args) => {
    const record = real.apply(store, args as never);
    if (!armed) return record;
    armed = false;
    throw new Error('IO error: No space left on device (os error 28)');
  };
  try {
    // The deletion gives up the workspace's side, so it owes disk no push:
    // the answer doesn't say one didn't run, and keeps its note.
    assert.equal(errorOf(await call('delete', { path: 'work/c.txt' })),
      'The deletion of "work/c.txt" is stored in the workspace, so don\'t send it again. The store failed after recording it: IO error: No space left on device (os error 28). '
      + 'Nothing was unlinked: when last observed, disk held a file at work/c.txt that the workspace never took in (conflict: store-origin-collision), '
      + 'and a sync observes whatever disk holds there.');
    assert.equal(armed, false);
  } finally {
    delete s.treeRemove;
  }
  assert.equal(disk('c.txt')!.toString(), 'disk text\n');
});

test("a forced deletion over a directory says no push unlinks one", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'gone.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/gone.txt' })).success, true);
  rmSync(join(dir, 'gone.txt'));
  mkdirSync(join(dir, 'gone.txt'));
  assert.match(errorOf(await call('delete', { path: 'work/gone.txt' })), /^The deletion of "work\/gone\.txt" is stored in the workspace/);
  const forced = await call('materialize', { path: 'work/gone.txt', force: true, applyDeletions: true });
  assert.match(JSON.stringify(forced.data), /not unlinked: disk has a directory at this path, and no push unlinks one, forced or not — if it should go, move or remove it on disk/);
  assert.equal(statSync(join(dir, 'gone.txt')).isDirectory(), true, 'the directory stays');
});

test("a write over a FIFO is told what's in the way and the ways past it, with no force", { skip: process.platform === 'win32' ? 'no FIFOs' : false }, async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  assert.equal(spawnSync('mkfifo', [join(dir, 'p.txt')]).status, 0, 'mkfifo');
  assert.equal(errorOf(await call('write', { path: 'work/p.txt', content: 'x\n' })), 'The write of "work/p.txt" is stored in the workspace, so don\'t send it again. '
    + "Its push to disk didn't complete: disk has a pipe, socket or device at this path, or a symlink to one, and no push writes a file over it, forced or not — "
    + 'write the file under another path, or whoever runs this host can remove it, and materializing again then gets past it.');
  assert.equal(statSync(join(dir, 'p.txt')).isFIFO(), true, 'the FIFO stays');
});

// ---------------------------------------------------------------------------
// The fix round of the third review (af-ws-fix-r2)
// ---------------------------------------------------------------------------

test("a write over a symlink the mount doesn't follow is told what's in the way and the ways past it, with no force", async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  writeFileSync(join(dir, 'target.txt'), 'target\n');
  symlinkSync('target.txt', join(dir, 'l.txt'));
  assert.equal(errorOf(await call('write', { path: 'work/l.txt', content: 'x\n' })), 'The write of "work/l.txt" is stored in the workspace, so don\'t send it again. '
    + "Its push to disk didn't complete: disk has a symlink at this path, which this mount does not follow, and no push writes through one, forced or not — "
    + 'write the file under another path, or whoever runs this host can remove the link, and materializing again then gets past it.');
  assert.equal(lstatSync(join(dir, 'l.txt')).isSymbolicLink(), true, 'the link stays');
  assert.equal(readFileSync(join(dir, 'target.txt'), 'utf8'), 'target\n');
});

test('a disk copy the workspace cannot read is offered force on the condition force needs', async (t) => {
  const { dir, call } = setup(t, { autoMaterialize: true });
  for (const name of ['r.txt', 'n.txt', 's.txt']) writeFileSync(join(dir, name), 'v1\n');
  for (const name of ['r.txt', 'n.txt', 's.txt']) assert.equal((await call('read', { path: `work/${name}` })).success, true);
  chmodSync(join(dir, 'r.txt'), 0o200);
  chmodSync(join(dir, 'n.txt'), 0o000);
  chmodSync(join(dir, 's.txt'), 0o200);
  t.after(() => { for (const name of ['r.txt', 'n.txt']) if (existsSync(join(dir, name))) chmodSync(join(dir, name), 0o600); });
  try {
    readFileSync(join(dir, 'r.txt'));
    t.skip('this user can read a mode-0200 file (Windows or root)');
    return;
  } catch { /* unreadable, as intended */ }

  const writeRefusal = (path: string): string => `The write of "work/${path}" is stored in the workspace, so don't send it again. `
    + "Its push to disk didn't complete: cannot verify disk copy (cannot open (permission denied)) — materializing again won't change that; whoever runs this host can change the permissions, and materializing again then gets past it, "
    + 'or, if disk lets the workspace write the file, materialize it with force to overwrite it.';
  assert.equal(errorOf(await call('write', { path: 'work/r.txt', content: 'v2\n' })), writeRefusal('r.txt'));
  assert.equal(errorOf(await call('write', { path: 'work/n.txt', content: 'v2\n' })), writeRefusal('n.txt'));
  // Force gets past the read where disk lets the file be written, and not
  // where it doesn't, which is why the offer carries its condition.
  const forced = await call('materialize', { force: true });
  assert.equal(forced.success, true, forced.error);
  assert.match(JSON.stringify(forced.data), /n\.txt: not written: [^"]*permission denied/);
  chmodSync(join(dir, 'r.txt'), 0o600);
  chmodSync(join(dir, 'n.txt'), 0o600);
  assert.equal(readFileSync(join(dir, 'r.txt'), 'utf8'), 'v2\n');
  assert.equal(readFileSync(join(dir, 'n.txt'), 'utf8'), 'v1\n');

  // A deletion's forced unlink needs its directory, not the file's own
  // permissions: this one unlinks it.
  assert.equal(errorOf(await call('delete', { path: 'work/s.txt' })), 'The deletion of "work/s.txt" is stored in the workspace, so don\'t send it again. '
    + "Its push to disk didn't complete: cannot verify disk copy (cannot open (permission denied)) — materializing again with applyDeletions won't change that; whoever runs this host can change the permissions, and materializing again with applyDeletions then gets past it, "
    + 'or, if disk lets the workspace unlink the file, materialize it with force and applyDeletions to delete it.');
  const unlinked = await call('materialize', { path: 'work/s.txt', force: true, applyDeletions: true });
  assert.equal(unlinked.success, true, unlinked.error);
  assert.equal(existsSync(join(dir, 's.txt')), false, 'the forced materialize unlinked it');
});

test("a path whose branch intent can't be read is told to sync the path, which replaces the intent once it sees disk's copy", async (t) => {
  const { store, dir, call } = setup(t);
  writeFileSync(join(dir, 'u.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
  const junk = Buffer.from('not an intent');
  store.treeSet('workspace/work/intent', 'u.txt', { blobHash: store.storeBlob(junk, 'text/plain'), size: junk.byteLength, mode: 0o644 });
  const refused = await call('materialize', { path: 'work/u.txt' });
  assert.match(JSON.stringify(refused.data),
    /u\.txt: its branch intent can't be read: its record is not a branch intent — sync this path to adopt the disk version, which replaces the intent"/);
  const synced = await call('sync', { path: 'work/u.txt' });
  assert.equal(synced.success, true, synced.error);
  const again = await call('materialize', { path: 'work/u.txt' });
  assert.equal(again.success, true, again.error);
  assert.doesNotMatch(JSON.stringify(again.data), /branch intent/, 'the sync replaced it');

  // While disk holds what the mount can't see, a sync leaves the intent, so
  // the refusal names what disk holds first.
  writeFileSync(join(dir, 'w.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/w.txt' })).success, true);
  store.treeSet('workspace/work/intent', 'w.txt', { blobHash: store.storeBlob(junk, 'text/plain'), size: junk.byteLength, mode: 0o644 });
  rmSync(join(dir, 'w.txt'));
  symlinkSync('u.txt', join(dir, 'w.txt'));
  const unseen = /w\.txt: its branch intent can't be read: its record is not a branch intent, and disk's copy can't be verified \(a symlink, which this mount does not follow\) — once it can be, sync this path to adopt the disk version, which replaces the intent"/;
  assert.match(JSON.stringify((await call('materialize', { path: 'work/w.txt' })).data), unseen);
  const blind = await call('sync', { path: 'work/w.txt' });
  assert.equal(blind.success, true, blind.error);
  // A sync asks for an adoption, which gets past the intent's check and stops
  // at the symlink, before anything is adopted: its note is the symlink's,
  // where a pass that adopts nothing answers the intent's.
  assert.match(JSON.stringify(blind.data), /"path":"w\.txt","reason":"disk could not be checked: a symlink, which this mount does not follow — syncing this path again won't change that; whoever runs this host can set followSymlinks: true on this mount if it leads inside the mount, mount what it leads to, or a directory that holds it, if it leads outside, or remove it if it leads nowhere"/);
  assert.match(JSON.stringify((await call('materialize', { path: 'work/w.txt' })).data), unseen, "a sync that can't see disk's copy leaves the intent");
  rmSync(join(dir, 'w.txt'));
  // Absent is a copy a sync sees, so the reason names the sync alone, and
  // says that it takes disk's deletion.
  assert.match(JSON.stringify((await call('materialize', { path: 'work/w.txt' })).data),
    /w\.txt: its branch intent can't be read: its record is not a branch intent — sync this path to take disk's deletion, which removes the workspace's copy and replaces the intent"/);
  const seen = await call('sync', { path: 'work/w.txt' });
  assert.equal(seen.success, true, seen.error);
  const removed = await call('read', { path: 'work/w.txt' });
  assert.equal(removed.success, false, "the sync took disk's deletion");
  assert.equal(removed.error, `The read did nothing: there's no file at "work/w.txt". ls or glob lists the files that exist.`);
  assert.doesNotMatch(JSON.stringify((await call('materialize', { path: 'work/w.txt' })).data), /branch intent/, 'once it sees disk, the sync replaces it');
});

for (const autoMaterialize of [false, true]) {
  test(`an edit of a file disk lacks, with nothing to say whether disk deleted it, says so, ${autoMaterialize ? 'and its push writes it back' : 'and a materialize writes it back'}`, async (t) => {
    const { store, call, disk } = setup(t, { autoMaterialize });
    // An entry from before the evidence (as three-way's legacyEntry makes it).
    const bytes = Buffer.from('legacy line\n');
    store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
    const edit = await call('edit', { path: 'work/l.txt', oldString: 'legacy', newString: 'edited' });
    assert.equal(edit.success, true, edit.error);
    assert.equal((edit.structured as { note?: string }).note,
      "Disk has no copy of this file, and nothing records whether it was deleted there, so the edit applied to the workspace's copy. "
      + (autoMaterialize ? 'Its push put the file back on disk' : 'A materialize of the path puts it back on disk')
      + '; if it was deleted there on purpose, delete it here too.');
    if (autoMaterialize) assert.equal(disk('l.txt')!.toString(), 'edited line\n', 'the push put it back before the answer');
    if (!autoMaterialize) {
      assert.equal(disk('l.txt'), null, "a mount that doesn't push leaves disk as it was");
      const materialized = await call('materialize', {});
      assert.equal(materialized.success, true, materialized.error);
    }
    assert.equal(disk('l.txt')!.toString(), 'edited line\n');
  });
}

test("an edit of a file disk lacks whose push is refused doesn't say the file went back", async (t) => {
  const { store, dir, call, disk, stored } = setup(t, { autoMaterialize: true });
  // An entry from before the evidence, below a path disk holds as a file, so
  // the edit's push can't write it.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'f.txt/l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  writeFileSync(join(dir, 'f.txt'), 'file\n');
  assert.equal(errorOf(await call('edit', { path: 'work/f.txt/l.txt', oldString: 'legacy', newString: 'edited' })),
    'The edit of "work/f.txt/l.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
    + "Its push to disk didn't complete: not written: disk has a file or a symlink where this path needs a directory, and no push writes below one, forced or not — move or remove it on disk and materialize again, or write the file under another path. "
    + "Disk has no copy of this file, and nothing records whether it was deleted there, so the edit applied to the workspace's copy.");
  assert.equal(await stored('f.txt/l.txt'), 'edited line\n');
  assert.equal(disk('f.txt')!.toString(), 'file\n', "the refused push left disk's file as it was");
});

// ---------------------------------------------------------------------------
// Where disk has deleted the file, a sync takes the deletion
// ---------------------------------------------------------------------------

const DELETION_WAYS = "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk.";

test("an edit of a draft whose disk copy was deleted says what a sync and a forced materialize do", async (t) => {
  const { dir, call, disk } = setup(t);
  for (const name of ['s.txt', 'f.txt']) {
    writeFileSync(join(dir, name), 'base\n');
    assert.equal((await call('read', { path: `work/${name}` })).success, true);
    assert.equal((await call('write', { path: `work/${name}`, content: 'agent draft\n' })).success, true);
    rmSync(join(dir, name));
  }
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'missing', newString: 'x' })),
    "The edit did nothing: oldString isn't in work/s.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + `The path is in conflict with disk (deleted-on-disk): the edit looked in the workspace's copy. ${DELETION_WAYS}`);
  const edit = await call('edit', { path: 'work/f.txt', oldString: 'draft', newString: 'draft, edited' });
  assert.equal(edit.success, true, edit.error);
  assert.equal((edit.structured as { note?: string }).note,
    `The path is in conflict with disk (deleted-on-disk): the edit is in the workspace's copy. ${DELETION_WAYS}`);
  // Each way out does what the note says.
  assert.equal((await call('sync', { path: 'work/s.txt' })).success, true);
  assert.equal((await call('read', { path: 'work/s.txt' })).success, false, "the sync took disk's deletion");
  const forced = await call('materialize', { path: 'work/f.txt', force: true });
  assert.equal(forced.success, true, forced.error);
  assert.equal(disk('f.txt')!.toString(), 'agent draft, edited\n', "the forced materialize wrote the workspace's copy back");
});

test('a recorded conflict whose disk copy has since been deleted is answered for what disk holds now', async (t) => {
  const { store, dir, call, disk } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  // The edit's pass records the conflict as both-changed.
  assert.match(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'missing', newString: 'x' })),
    / \(both-changed\): the edit looked in the workspace's copy\. Sync the path to keep disk's copy and give up the workspace's/);
  rmSync(join(dir, 'k.txt'));
  assert.equal(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'missing', newString: 'x' })),
    "The edit did nothing: oldString isn't in work/k.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + `The path is in conflict with disk (both-changed): the edit looked in the workspace's copy. ${DELETION_WAYS}`);
  assert.match(JSON.stringify((await call('materialize', { path: 'work/k.txt' })).data),
    /k\.txt: disk has no copy of this file \(conflict: both-changed\) — sync this path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back"/);

  // A conflict with nothing to say which side is newer still needs its push
  // named: an entry from before the evidence, beside a different disk copy.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'n.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  writeFileSync(join(dir, 'n.txt'), 'disk copy\n');
  assert.match(errorOf(await call('edit', { path: 'work/n.txt', oldString: 'missing', newString: 'x' })), / \(unknown-provenance\): /);
  rmSync(join(dir, 'n.txt'));
  assert.match(JSON.stringify((await call('materialize', { path: 'work/n.txt' })).data),
    /n\.txt: disk has no copy of this file \(conflict: unknown-provenance\) — sync this path to take disk's deletion, which removes the workspace's copy, or materialize this path with force to write the workspace's copy back"/);
  const forced = await call('materialize', { path: 'work/n.txt', force: true });
  assert.equal(forced.success, true, forced.error);
  assert.equal(disk('n.txt')!.toString(), 'legacy line\n', "the forced materialize of the named path wrote the workspace's copy back");
});

test("a push where disk has deleted the file says what a sync and a forced materialize do", async (t) => {
  const { dir, call, disk, stored } = setup(t, { autoMaterialize: true });
  // Disk deleted a file the workspace holds unchanged.
  writeFileSync(join(dir, 'u.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/u.txt' })).success, true);
  rmSync(join(dir, 'u.txt'));
  assert.match(JSON.stringify((await call('materialize', { path: 'work/u.txt' })).data),
    /u\.txt: stale copy: disk changed since it last agreed with the workspace, which did not — sync this path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back"/);
  // A write over a file disk deleted since the workspace read it.
  writeFileSync(join(dir, 'w.txt'), 'v1\n');
  assert.equal((await call('read', { path: 'work/w.txt' })).success, true);
  rmSync(join(dir, 'w.txt'));
  assert.equal(errorOf(await call('write', { path: 'work/w.txt', content: 'v2\n' })),
    'The write of "work/w.txt" is stored in the workspace, so don\'t send it again. '
    + "Its push to disk didn't complete: disk has no copy of this file (conflict: deleted-on-disk) — sync this path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back.");
  assert.equal(await stored('w.txt'), 'v2\n');
  const forced = await call('materialize', { path: 'work/w.txt', force: true });
  assert.equal(forced.success, true, forced.error);
  assert.equal(disk('w.txt')!.toString(), 'v2\n', "the forced materialize wrote the workspace's copy back");
});

// The workspace doesn't store a disk copy with a null byte (binary), or one
// past the mount's maxFileSize.
for (const [kind, limit, copy] of [
  ['binary', undefined, Buffer.from('bin\0ary\n')],
  ['past the size limit', 16, Buffer.from(`${'x'.repeat(40)}\n`)],
] as const) {
  test(`an edit of a draft whose disk copy the workspace can't hold (${kind}) says a sync keeps disk's copy and gives up the workspace's`, async (t) => {
    const { dir, call, disk } = setup(t, { maxFileSize: limit });
    writeFileSync(join(dir, 'b.txt'), 'base\n');
    assert.equal((await call('read', { path: 'work/b.txt' })).success, true);
    assert.equal((await call('write', { path: 'work/b.txt', content: 'agent draft\n' })).success, true);
    writeFileSync(join(dir, 'b.txt'), copy);
    assert.equal(errorOf(await call('edit', { path: 'work/b.txt', oldString: 'missing', newString: 'x' })),
      "The edit did nothing: oldString isn't in work/b.txt.\nMatch exactly, including whitespace and indentation.\n\n"
      + "The path is in conflict with disk (both-changed): the edit looked in the workspace's copy. "
      + "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
    assert.equal((await call('sync', { path: 'work/b.txt' })).success, true);
    const after = await call('read', { path: 'work/b.txt' });
    assert.equal(after.success, false, "the sync gave up the workspace's copy");
    assert.equal(after.error, `The read did nothing: "work/b.txt" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. read, edit and delete act only on the files it stores, so calling again won't change that.`);
    const listed = (await call('ls', { path: 'work' })).data as { entries: Array<{ name: string; state: string }> };
    assert.equal(listed.entries.find((e) => e.name === 'b.txt')?.state, 'disk-only', 'the listing shows it disk-only');
    assert.deepEqual(disk('b.txt'), copy, 'disk keeps its copy');
  });
}
