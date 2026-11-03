// edit and edit_many through one planner: a miss shows the closest region, a
// count that differs shows the lines that matched, CRLF and a BOM are kept,
// and edit_many stores every edit or none. Each answer keeps to the length
// its call's result may have (ToolCall.resultMaxChars), unless its head and
// its last line alone are longer; edit's receipt keeps its path and notes
// whatever their length, and where they alone are longer it shows no region.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { decodeForEdit, planFile, type FilePlan } from '../src/modules/workspace/edit-plan.js';
import { editReceipt, fitted, shownRegions } from '../src/modules/workspace/edit-text.js';

/** A receipt's text, which the model reads and the cap measures. */
const receiptText = (receipt: ToolResult): string => (receipt.data as Array<{ text: string }>)[0]!.text;
/** The changed regions a receipt shows, from its fields. */
const changedOf = (receipt: ToolResult): string => (receipt.structured as { changed: string }).changed;
import type { ToolResult } from '../src/types/events.js';

function setup(t: TestContext, opts: { autoMaterialize?: boolean; maxFileSize?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-edits-'));
  const dir = join(root, 'mount');
  const other = join(root, 'other');
  const shelf = join(root, 'shelf');
  for (const path of [dir, other, shelf]) mkdirSync(path);
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: dir,
        mode: 'read-write',
        watch: 'never',
        autoMaterialize: opts.autoMaterialize ?? false,
        ...(opts.maxFileSize !== undefined ? { maxFileSize: opts.maxFileSize } : {}),
      },
      { name: 'other', path: other, mode: 'read-write', watch: 'never' },
      { name: 'shelf', path: shelf, mode: 'read-only', watch: 'never' },
    ],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (name: string, input: unknown, resultMaxChars?: number): Promise<ToolResult> =>
    workspace.handleToolCall({ id: name, name, input, ...(resultMaxChars !== undefined ? { resultMaxChars } : {}) } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const disk = (rel: string): Buffer | null => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null);
  const stored = async (rel: string): Promise<string> => {
    const result = await call('read', { path: `work/${rel}`, offsetChars: 0, limitChars: 1_000_000 });
    assert.equal(result.success, true, result.error);
    return (result.structured as { content: string }).content;
  };
  /** A file the workspace holds, as a listing takes it in. */
  const file = async (rel: string, content: string | Buffer): Promise<void> => {
    writeFileSync(join(dir, rel), content);
    assert.equal((await call('ls', { path: 'work' })).success, true);
  };
  return { workspace, store, dir, call, disk, stored, file };
}

const errorOf = (result: ToolResult): string => {
  assert.equal(result.success, false, 'the call was refused');
  assert.equal(result.isError, true);
  return result.error ?? '';
};

/** A success's fields: a receipt's, a page's or grep's, which a script reads as structuredContent, or another tool's data. */
const dataOf = (result: ToolResult): Record<string, unknown> => {
  assert.equal(result.success, true, result.error);
  return (result.structured ?? result.data) as Record<string, unknown>;
};

/** Half of a surrogate pair without the other half. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const treeStateOf = (workspace: WorkspaceModule): string =>
  (workspace as unknown as { mounts: Map<string, { treeStateId: string }> }).mounts.get('work')!.treeStateId;

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

test('a miss shows the closest region, numbered, and stores nothing', async (t) => {
  const { call, stored, file } = setup(t);
  await file('m.txt', 'alpha\nbeta gamma\ndelta\n');
  const refusal = errorOf(await call('edit', { path: 'work/m.txt', oldString: 'beta  gamma', newString: 'x' }));
  assert.equal(refusal, "The edit did nothing: oldString isn't in work/m.txt.\n"
    + 'Closest region (line 2, similarity 0.95):\n     1\talpha\n     2\tbeta gamma\n     3\tdelta\n'
    + 'Match exactly, including whitespace and indentation.');
  assert.equal(await stored('m.txt'), 'alpha\nbeta gamma\ndelta\n');
});

test('a count that differs names the lines that matched and shows them, unless replaceAll', async (t) => {
  const { call, stored, file } = setup(t);
  await file('c.txt', 'one x\ntwo\nthree x\n');
  assert.equal(errorOf(await call('edit', { path: 'work/c.txt', oldString: 'x', newString: 'y' })),
    'The edit did nothing: oldString occurs 2 times in work/c.txt (on lines 1 and 3). '
    + 'Add the text around it to make it unique, or set replaceAll to replace every one.\n     1\tone x\n     3\tthree x');
  const all = dataOf(await call('edit', { path: 'work/c.txt', oldString: 'x', newString: 'y', replaceAll: true }));
  assert.equal(all.replacements, 2);
  assert.equal(all.note, 'The other replacements are on line 3.');
  assert.equal(await stored('c.txt'), 'one y\ntwo\nthree y\n');
});

test('the receipt shows two lines around the change, numbered, and no line past the end', async (t) => {
  const { call, file } = setup(t);
  await file('r.txt', 'a\nb\nc\nd\ne\nf\ng\n');
  const middle = dataOf(await call('edit', { path: 'work/r.txt', oldString: 'd', newString: 'D1\nD2' }));
  assert.deepEqual(middle, {
    path: 'work/r.txt',
    size: 18,
    replacements: 1,
    disk: 'waits for materialize',
    changed: '     2\tb\n     3\tc\n     4\tD1\n     5\tD2\n     6\te\n     7\tf',
  });
  const last = dataOf(await call('edit', { path: 'work/r.txt', oldString: 'g\n', newString: 'G\n' }));
  assert.equal(last.changed, '     6\te\n     7\tf\n     8\tG');
});

test('a CRLF file matches LF text and keeps its line ends on disk, as it keeps a BOM', async (t) => {
  const { call, disk, file } = setup(t, { autoMaterialize: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await file('w.txt', Buffer.concat([bom, Buffer.from('first\r\nsecond\r\n')]));
  const receipt = dataOf(await call('edit', { path: 'work/w.txt', oldString: 'first\nsecond', newString: 'first\nnew\nsecond' }));
  assert.equal(receipt.note, "The file's CRLF line ends are kept.");
  assert.deepEqual(disk('w.txt'), Buffer.concat([bom, Buffer.from('first\r\nnew\r\nsecond\r\n')]));
});

test('straight and curly quotes match as a second chance, and the receipt says so', async (t) => {
  const { call, stored, file } = setup(t);
  await file('q.txt', 'it’s “quoted”\n');
  const receipt = dataOf(await call('edit', { path: 'work/q.txt', oldString: 'it\'s "quoted"', newString: 'plain' }));
  assert.equal(receipt.note, 'The text matched with straight and curly quotes treated as equal.');
  assert.equal(await stored('q.txt'), 'plain\n');
});

test("an oldString carrying the file's BOM or a line's CR, as a character page shows them, matches without them, and the receipt says so", async (t) => {
  const { call, disk, file } = setup(t, { autoMaterialize: true });
  await file('cr.txt', 'alpha\r\nbeta\r\n');
  const receipt = dataOf(await call('edit', { path: 'work/cr.txt', oldString: 'alpha\r', newString: 'gamma\r' }));
  assert.equal(receipt.note, "The text matched without the BOM or the line end's CR it carried, which the file keeps. The file's CRLF line ends are kept.");
  assert.deepEqual(disk('cr.txt'), Buffer.from('gamma\r\nbeta\r\n'));
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await file('bom.txt', Buffer.concat([bom, Buffer.from('alpha\nbeta\n')]));
  const many = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/bom.txt', oldString: '\uFEFFalpha', newString: '\uFEFFgamma' },
      { path: 'work/bom.txt', oldString: 'beta', newString: 'delta' },
    ],
  }));
  assert.equal((many.files as Array<{ note?: string }>)[0]!.note, "Edit 1 matched without the BOM or the line end's CR its old text carried, which the file keeps.");
  assert.deepEqual(disk('bom.txt'), Buffer.concat([bom, Buffer.from('gamma\ndelta\n')]));
  // An edit whose only change is the CR the file keeps has nothing to change.
  assert.equal(errorOf(await call('edit', { path: 'work/cr.txt', oldString: 'gamma\r', newString: 'gamma' })),
    "The edit did nothing: oldString and newString are the same once the BOM or the line end's CR that oldString carries is read as work/cr.txt's own, which the file keeps, so there's nothing to change.");
  assert.deepEqual(disk('cr.txt'), Buffer.from('gamma\r\nbeta\r\n'));
});

test('a receipt and a refusal cut a line between characters, never inside a surrogate pair', async (t) => {
  const { store, call, file } = setup(t);
  // The change on this long line starts 80 code units past the start of a
  // pair's second half, where the receipt's excerpt of it starts.
  await file('e.txt', `${'😀'.repeat(1500)}xtarget${'😀'.repeat(1500)}\n`);
  const receipt = dataOf(await call('edit', { path: 'work/e.txt', oldString: 'target', newString: 'DONE' }));
  assert.doesNotMatch(receipt.changed as string, loneSurrogate);
  assert.match(receipt.changed as string, /^     1\t\[… 2920 chars before\] 😀/u);
  // A thrown message past 500 code points keeps its first 500, whole
  // pairs, and says how long it was.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  s.treeSet = () => { throw new Error('😀'.repeat(600)); };
  s.treeBatch = s.treeSet;
  try {
    const error = errorOf(await call('edit_many', { edits: [{ path: 'work/e.txt', oldString: 'DONE', newString: 'done' }] }));
    assert.doesNotMatch(error, loneSurrogate);
    assert.equal(error, `The edit_many stopped on an error the workspace didn't expect, before any of its edits was stored: ${'😀'.repeat(500)}… (600 characters). `
      + "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.");
  } finally {
    delete s.treeSet;
    delete s.treeBatch;
  }
});

test('a receipt shows a long line from shortly before the change on it, and its start where the change is there', async (t) => {
  const { call, file } = setup(t);
  await file('long.txt', `${'a'.repeat(2500)}target${'z'.repeat(10)}\nnext\n`);
  const late = dataOf(await call('edit', { path: 'work/long.txt', oldString: 'target', newString: 'DONE' }));
  assert.equal(late.changed, `     1\t[… 2420 chars before] ${'a'.repeat(80)}DONE${'z'.repeat(10)}\n     2\tnext`);
  await file('early.txt', `ab${'c'.repeat(2500)}\n`);
  const early = dataOf(await call('edit', { path: 'work/early.txt', oldString: 'ab', newString: 'AB' }));
  assert.equal(early.changed, `     1\tAB${'c'.repeat(1998)} [… 502 more chars]`);
  // Several edits' first changes on one long line: a stretch from shortly
  // before each, run together where they meet.
  await file('many.txt', `${'a'.repeat(3000)}one${'b'.repeat(100)}two${'c'.repeat(3000)}three${'d'.repeat(500)}\n`);
  const many = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/many.txt', oldString: 'three', newString: '3' },
      { path: 'work/many.txt', oldString: 'one', newString: '1' },
      { path: 'work/many.txt', oldString: 'two', newString: '2' },
    ],
  }));
  // Each stretch runs from 80 characters before its change for 2,000: the
  // first two meet and run together, and the third is apart.
  assert.equal(many.changed, `work/many.txt\n     1\t[… 2920 chars before] ${'a'.repeat(80)}1${'b'.repeat(100)}2${'c'.repeat(1919)}`
    + ` [… 1001 chars] ${'c'.repeat(80)}3${'d'.repeat(500)}`);
});

test("a receipt names the lines of an edit's other replacements, the first 20 and how many more", async (t) => {
  const { call, file } = setup(t);
  await file('lines.txt', 'x\n'.repeat(25));
  const all = dataOf(await call('edit', { path: 'work/lines.txt', oldString: 'x', newString: 'y', replaceAll: true }));
  assert.equal(all.replacements, 25);
  assert.equal(all.note, `The other replacements are on lines ${Array.from({ length: 20 }, (_, i) => i + 2).join(', ')} and 4 more.`);
});

test('identical strings are refused before the path is touched, as an empty oldString is', async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'same', newString: 'same' })),
    "The edit did nothing: oldString and newString are the same, so there's nothing to change.");
  // An edit keeps the file's line ends, so one that changes only those names write.
  assert.equal(errorOf(await call('edit', { path: 'nowhere/x.txt', oldString: 'a\r\nb', newString: 'a\nb' })),
    "The edit did nothing: oldString and newString are the same once their CRLF line ends are read as LF, so there's nothing to change: "
    + "an edit keeps the file's line ends, and write replaces the whole file, line ends included.");
});

test('edit refuses a problem in its own input before it looks its path up on disk', async (t) => {
  const { call, file } = setup(t);
  await file('a.txt', 'one\n');
  // A path that doesn't exist gets the same refusal as one that does: the
  // input's, given before the path is looked up.
  // The control: with nothing wrong in its input, the missing path is
  // looked up, and refused for that.
  const lookedUp = errorOf(await call('edit', { path: 'work/missing.txt', oldString: 'one', newString: 'ONE' }));
  for (const input of [{ oldString: '', newString: 'x' }, { oldString: 'one', newString: 'one' }, { oldString: '\ud83d', newString: 'x' }]) {
    const there = errorOf(await call('edit', { path: 'work/a.txt', ...input }));
    const missing = errorOf(await call('edit', { path: 'work/missing.txt', ...input }));
    assert.equal(missing.replaceAll('work/missing.txt', 'P'), there.replaceAll('work/a.txt', 'P'), JSON.stringify(input));
    assert.notEqual(missing, lookedUp, JSON.stringify(input));
  }
});

test('CRLF line ends in oldString and newString are read as LF, so a file keeps its own', async (t) => {
  const { call, stored, file } = setup(t);
  await file('lf.txt', 'a\nb\n');
  dataOf(await call('edit', { path: 'work/lf.txt', oldString: 'a\r\nb', newString: 'A\r\nB' }));
  assert.equal(await stored('lf.txt'), 'A\nB\n');
  await file('crlf.txt', 'a\r\nb\r\n');
  dataOf(await call('edit', { path: 'work/crlf.txt', oldString: 'a\r\nb', newString: 'A\r\nB' }));
  assert.equal(await stored('crlf.txt'), 'A\r\nB\r\n');
});

test("a line whose own text ends in a CR shows its CRLF end's CR too, so lines copied across it from a receipt or a closest region edit where they came from", async (t) => {
  const { call, stored, file } = setup(t);
  // Lines 2 and 3 end in a CR before their CRLF end; lines 5 and 6 hold the
  // same text with a CRLF end alone. Copied with one CR each, lines 2 and 3
  // would read as "xx\nyy" before a CRLF end, which is lines 5 and 6.
  const text = 'aa\r\nxx\r\r\nyy\r\r\nbb\r\nxx\r\nyy\r\n';
  const linesTwoAndThree = (listing: string) => listing.split('\n').filter((line) => /^ {5}[23]\t/.test(line)).map((line) => line.slice(7)).join('\n');
  await file('r.txt', text);
  const receipt = dataOf(await call('edit', { path: 'work/r.txt', oldString: 'aa', newString: 'AA' }));
  assert.equal(linesTwoAndThree(receipt.changed as string), 'xx\r\r\nyy\r\r');
  dataOf(await call('edit', { path: 'work/r.txt', oldString: linesTwoAndThree(receipt.changed as string), newString: 'XX\nYY' }));
  assert.equal(await stored('r.txt'), 'AA\r\nXX\r\nYY\r\nbb\r\nxx\r\nyy\r\n');
  await file('h.txt', text);
  const miss = errorOf(await call('edit', { path: 'work/h.txt', oldString: 'xx\nqq', newString: 'z' }));
  assert.match(miss, /Closest region \(line 2, /);
  dataOf(await call('edit', { path: 'work/h.txt', oldString: linesTwoAndThree(miss), newString: 'XX\nYY' }));
  assert.equal(await stored('h.txt'), 'aa\r\nXX\r\nYY\r\nbb\r\nxx\r\nyy\r\n');
  // A count refusal shows the lines it names the same way.
  await file('c.txt', text);
  assert.ok(errorOf(await call('edit', { path: 'work/c.txt', oldString: 'yy', newString: 'z' })).includes('     3\tyy\r\r\n     6\tyy'));
  // A last line with no line end shows its own CR alone, in each.
  const last = 'aa\r\nxx\r\r\nxx\r';
  await file('l.txt', last);
  assert.ok(errorOf(await call('edit', { path: 'work/l.txt', oldString: 'xx\nqq', newString: 'z' })).includes('     2\txx\r\r\n     3\txx\r\nMatch'));
  assert.ok(errorOf(await call('edit', { path: 'work/l.txt', oldString: 'xx', newString: 'z' })).endsWith('     2\txx\r\r\n     3\txx\r'));
  assert.equal(dataOf(await call('edit', { path: 'work/l.txt', oldString: 'aa', newString: 'AA' })).changed, '     1\tAA\n     2\txx\r\r\n     3\txx\r');
  // A long matched line shows the CR where its excerpt reaches its end, and
  // not where the excerpt is cut after a CR inside the line.
  const long = `aa\r\n${'q'.repeat(300)}mm\r\r\nmm${'q'.repeat(237)}\r${'q'.repeat(100)}\r\nmm\r\n`;
  await file('x.txt', long);
  assert.ok(errorOf(await call('edit', { path: 'work/x.txt', oldString: 'mm', newString: 'z' }))
    .endsWith(`     2\t\u2026${'q'.repeat(237)}mm\r\r\n     3\tmm${'q'.repeat(237)}\r\u2026\n     4\tmm`));
});

test("a receipt tells a line's own CRs from its line end's by the stored bytes, where the edit puts a CR before a line feed", async (t) => {
  const { call, stored, file } = setup(t);
  // A CR the edit puts before a bare LF makes the two a CRLF end on disk,
  // shown without the CR, so lines copied from the receipt edit lines 1 and
  // 2, not lines 3 and 4, whose first line's own text ends in a CR.
  await file('b.txt', 'p\nq\nx\r\r\nq\n');
  assert.equal(dataOf(await call('edit', { path: 'work/b.txt', oldString: 'p', newString: 'x\r' })).changed, '     1\tx\n     2\tq\n     3\tx\r\r');
  assert.equal(await stored('b.txt'), 'x\r\nq\nx\r\r\nq\n');
  dataOf(await call('edit', { path: 'work/b.txt', oldString: 'x\nq', newString: 'M\nN' }));
  assert.equal(await stored('b.txt'), 'M\r\nN\nx\r\r\nq\n');
  // One before a CRLF end is the line's own, and shows that end's CR too; two
  // before a bare LF are the line's own and the end's, and show as stored.
  await file('c.txt', 'a\r\nb\r\n');
  assert.equal(dataOf(await call('edit', { path: 'work/c.txt', oldString: 'a', newString: 'a\r' })).changed, '     1\ta\r\r\n     2\tb');
  await file('l.txt', 'a\nb\n');
  assert.equal(dataOf(await call('edit', { path: 'work/l.txt', oldString: 'a', newString: 'a\r\r' })).changed, '     1\ta\r\r\n     2\tb');
  await file('d.txt', 'a\r\nb\r\n');
  assert.equal(dataOf(await call('edit', { path: 'work/d.txt', oldString: 'a', newString: 'A\r\r' })).changed, '     1\tA\r\r\r\n     2\tb');
  // A long line's stretch that reaches its end shows the CR too.
  await file('x.txt', `aa\r\n${'q'.repeat(2500)}mm\r\r\n`);
  assert.ok((dataOf(await call('edit', { path: 'work/x.txt', oldString: 'mm', newString: 'MM' })).changed as string).endsWith(`${'q'.repeat(80)}MM\r\r`));
});

test("a receipt reads the stored bytes of its lines that end in a CR in one walk forward, not one from the start for each", () => {
  // A new text whose last 300 lines' own text ends in a CR, in a CRLF file of
  // 1,000 lines: its receipt shows each of them, searching the bytes once for
  // each line feed it passes and once for each such line's own, 1,099 times,
  // where a walk from the start for each would take some 195,000.
  const bytes = Buffer.from(`${'p\r\n'.repeat(1_000)}`);
  const last = planFile(decodeForEdit(bytes)!, bytes, [{ index: 0, oldText: `${'p\n'.repeat(999)}p`, newText: `${'p\n'.repeat(500)}${Array.from({ length: 300 }, () => 'y\r').join('\n')}`, expected: 1 }]);
  assert.ok('plan' in last);
  let finds = 0;
  const search = Buffer.prototype.indexOf;
  Object.defineProperty(last.plan.bytes, 'indexOf', {
    value(this: Buffer, ...args: unknown[]) {
      finds++;
      return Reflect.apply(search, this, args) as number;
    },
  });
  const changed = changedOf(editReceipt('edit', [{ path: 'work/c.txt', plan: last.plan, notes: [] }], 1, 10_000_000, 'done'));
  assert.equal((changed.match(/\ty\r\r/g) ?? []).length, 300);
  assert.ok(finds >= 300 && finds < 3_000, `${finds} searches of the bytes`);
});

test("an oldString with the file's BOM at its start or a CR at its end, found in more than one reading, is refused, naming each one's lines", async (t) => {
  const { call, stored, file } = setup(t);
  // Line 2's own text ends in one CR and line 3's in two, before CRLF ends,
  // so line 2 as read shows it, with its end's CR, is line 3's text as given.
  const text = 'aa\r\nxx\r\r\nxx\r\r\r\n';
  await file('r.txt', text);
  assert.equal(errorOf(await call('edit', { path: 'work/r.txt', oldString: 'xx\r\r', newString: 'YY' })),
    "The edit did nothing: oldString ends in a CR, and occurs in work/r.txt read more than one way, so which you mean can't be told. "
    + "Include more of the text around it, such as the line before or after it, to say which.\n"
    + "It occurs as given (on line 3) and with its last CR read as its CRLF line end's (on line 2).");
  assert.equal(await stored('r.txt'), text);
  // With its line end it's line 2's alone, and line 3 as read shows it is line 3's.
  dataOf(await call('edit', { path: 'work/r.txt', oldString: 'xx\r\r\n', newString: 'YY\n' }));
  assert.equal(await stored('r.txt'), 'aa\r\nYY\r\nxx\r\r\r\n');
  dataOf(await call('edit', { path: 'work/r.txt', oldString: 'xx\r\r\r', newString: 'ZZ' }));
  assert.equal(await stored('r.txt'), 'aa\r\nYY\r\nZZ\r\n');
  // A last line with no line end, and a copy that stops at a CR inside a
  // line, read two ways too; the text before or after the CR settles which.
  await file('e.txt', 'x\r\nx\r');
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: 'x\r', newString: 'Y\r' })), /\nIt occurs as given \(on line 2\) and with its last CR read as its CRLF line end's \(on line 1\)\.$/);
  dataOf(await call('edit', { path: 'work/e.txt', oldString: 'x\nx\r', newString: 'x\nY\r' }));
  assert.equal(await stored('e.txt'), 'x\r\nY\r');
  await file('i.txt', 'a\rb\r\na\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/i.txt', oldString: 'a\r', newString: 'c\r' })), /\nIt occurs as given \(on line 1\) and with its last CR read as its CRLF line end's \(on line 2\)\.$/);
  dataOf(await call('edit', { path: 'work/i.txt', oldString: 'a\rb', newString: 'c\rb' }));
  assert.equal(await stored('i.txt'), 'c\rb\r\na\r\n');
  // A BOM the same, in edit_many's words.
  await file('m.txt', '\uFEFFab\n\uFEFFab\n');
  assert.ok(errorOf(await call('edit_many', { edits: [{ path: 'work/m.txt', oldString: '\uFEFFab', newString: 'c' }] })).includes(
    "edit 1: oldString starts with a BOM, and occurs in work/m.txt read more than one way, so which you mean can't be told. "
    + "Include more of the text around it, such as the line before or after it, to say which.\n"
    + "It occurs as given (on line 2) and with its BOM read as the file's own (on line 1)."));
  assert.equal(await stored('m.txt'), '\uFEFFab\n\uFEFFab\n');
});

test("an oldString that is a CR or a BOM alone, found as given, is refused where it could be a CRLF end's CR or the file's BOM", async (t) => {
  const { call, stored, file } = setup(t);
  // Line 1's CRLF end's CR, as a character page shows it, or line 2's own CR.
  await file('r.txt', '\r\nx\r');
  assert.match(errorOf(await call('edit', { path: 'work/r.txt', oldString: '\r', newString: 'Y' })),
    /\nIt occurs as given \(on line 2\) and with its last CR read as its CRLF line end's \(on line 1\)\.$/);
  assert.equal(await stored('r.txt'), '\r\nx\r');
  // The file's BOM, which a character page shows before line 1, or the one in line 2's text.
  await file('b.txt', '\uFEFF\nx\uFEFFy\n');
  assert.match(errorOf(await call('edit', { path: 'work/b.txt', oldString: '\uFEFF', newString: 'Q' })),
    /\nIt occurs as given \(on line 2\) and with its BOM read as the file's own \(on line 1\)\.$/);
  assert.equal(await stored('b.txt'), '\uFEFF\nx\uFEFFy\n');
  // Not found as given, it's never read as the line end's CR or the file's
  // BOM alone, which would put its new text where they are: it misses.
  await file('m.txt', '\r\nx');
  assert.match(errorOf(await call('edit', { path: 'work/m.txt', oldString: '\r', newString: 'Y' })), /^The edit did nothing: oldString isn't in work\/m\.txt\./);
  await file('o.txt', '\uFEFFx\n');
  assert.match(errorOf(await call('edit', { path: 'work/o.txt', oldString: '\uFEFF', newString: 'Q' })), /^The edit did nothing: oldString isn't in work\/o\.txt\./);
  // Deleted, it misses too, though read that way it would change nothing.
  await file('n.txt', 'x\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/n.txt', oldString: '\r', newString: '' })), /^The edit did nothing: oldString isn't in work\/n\.txt\./);
  // Deleted, a copy of the line end's CR still may mean it, which the file
  // keeps, so the edit is refused, saying so; with the text around it, a
  // lone CR is deleted.
  await file('d.txt', 'a\rb\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/d.txt', oldString: '\r', newString: '' })),
    /\nIt occurs as given \(on line 1\) and with its last CR read as its CRLF line end's \(on line 1\)\.\nWhere it occurs with its last CR read as its CRLF line end's, the edit changes nothing, since the file keeps its line ends\.$/);
  assert.equal(await stored('d.txt'), 'a\rb\r\n');
  dataOf(await call('edit', { path: 'work/d.txt', oldString: 'a\rb', newString: 'ab' }));
  assert.equal(await stored('d.txt'), 'ab\r\n');
});

test("a single edit deleting a CR or a BOM, or a text ending or starting with one, is refused where a copy may mean the file's own, which it keeps", async (t) => {
  const { call, stored, file } = setup(t);
  // Each file holds the text as given somewhere else than where a character
  // page shows the line end's CR or the file's BOM; each edit, read that
  // way, changes nothing (Abigail-2676's cases).
  const cases: Array<[string, string, string, RegExp]> = [
    ['\r\nx\r', '\r', '', /as given \(on line 2\) and with its last CR read as its CRLF line end's \(on line 1\)\.\nWhere it occurs with its last CR read as its CRLF line end's, the edit changes nothing, since the file keeps its line ends\.$/],
    ['x\r\nx\r', 'x\r', 'x', /as given \(on line 2\) and with its last CR read as its CRLF line end's \(on line 1\)\.\nWhere it occurs with its last CR read as its CRLF line end's, the edit changes nothing, since the file keeps its line ends\.$/],
    ['p\r\nx\r\r\nq\r\n', '\r', '', /as given \(on line 2\) and with its last CR read as its CRLF line end's \(on lines 1, 2 and 3\)\.\nWhere it occurs with its last CR read as its CRLF line end's, the edit changes nothing, since the file keeps its line ends\.$/],
    ['\uFEFFab\uFEFFc\r\n', '\uFEFF', '', /as given \(on line 1\) and with its BOM read as the file's own \(on line 1\)\.\nWhere it occurs with its BOM read as the file's own, the edit changes nothing, since the file keeps its BOM\.$/],
    ['\uFEFFx\r\nz\uFEFFx\r\n', '\uFEFFx', 'x', /as given \(on line 2\) and with its BOM read as the file's own \(on line 1\)\.\nWhere it occurs with its BOM read as the file's own, the edit changes nothing, since the file keeps its BOM\.$/],
    ['\uFEFF\r\nx\uFEFF\r\n', '\uFEFF\r', '', /with its last CR read as its CRLF line end's \(on line 2\) and with its BOM read as the file's own and its last CR as a CRLF line end's \(on line 1\)\.\nWhere it occurs with its BOM read as the file's own and its last CR as a CRLF line end's, the edit changes nothing, since the file keeps its BOM and line ends\.$/],
  ];
  for (const [k, [text, oldString, newString, said]] of cases.entries()) {
    await file(`c${k}.txt`, text);
    assert.match(errorOf(await call('edit', { path: `work/c${k}.txt`, oldString, newString })), said, `case ${k}`);
    assert.equal(await stored(`c${k}.txt`), text, `case ${k}`);
  }
});

test("an oldString with the file's BOM at its start and a CR at its end is read as the BOM and an empty first line's CRLF end beside another reading", async (t) => {
  const { call, stored, file } = setup(t);
  // Line 2's BOM before its CRLF end is one reading; the file's BOM and the
  // empty line 1's CRLF end, as a character page shows them, is the other.
  await file('e.txt', '\uFEFF\r\nx\uFEFF\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '\uFEFF\r', newString: 'Y' })),
    /\nIt occurs with its last CR read as its CRLF line end's \(on line 2\) and with its BOM read as the file's own and its last CR as a CRLF line end's \(on line 1\)\.$/);
  assert.equal(await stored('e.txt'), '\uFEFF\r\nx\uFEFF\r\n');
  // Deleted, it's refused too, where the file's BOM and line 1's end are what
  // a character page's copy shows.
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '\uFEFF\r', newString: '' })),
    /\nWhere it occurs with its BOM read as the file's own and its last CR as a CRLF line end's, the edit changes nothing, since the file keeps its BOM and line ends\.$/);
  assert.equal(await stored('e.txt'), '\uFEFF\r\nx\uFEFF\r\n');
  // Made the BOM alone, the edit changes nothing in either reading, the one
  // that leaves nothing among them, and the refusal says so of both.
  assert.match(errorOf(await call('edit', { path: 'work/e.txt', oldString: '\uFEFF\r', newString: '\uFEFF' })),
    /\nIt occurs with its last CR read as its CRLF line end's \(on line 2\) and with its BOM read as the file's own and its last CR as a CRLF line end's \(on line 1\)\.\nWhere it occurs with its last CR read as its CRLF line end's or with its BOM read as the file's own and its last CR as a CRLF line end's, the edit changes nothing, since the file keeps its BOM and line ends\.$/);
  assert.equal(await stored('e.txt'), '\uFEFF\r\nx\uFEFF\r\n');
  // Where line 1 isn't empty, only line 2 holds it.
  await file('f.txt', '\uFEFFa\r\nx\uFEFF\r\n');
  dataOf(await call('edit', { path: 'work/f.txt', oldString: '\uFEFF\r', newString: 'Y' }));
  assert.equal(await stored('f.txt'), '\uFEFFa\r\nxY\r\n');
});

test("a replaceAll of a CR or a BOM alone replaces those in the text, keeping CRLF line ends and the file's BOM", async (t) => {
  const { call, stored, file } = setup(t);
  await file('c.txt', 'a\rb\r\nc\r\n');
  dataOf(await call('edit', { path: 'work/c.txt', oldString: '\r', newString: '|', replaceAll: true }));
  assert.equal(await stored('c.txt'), 'a|b\r\nc\r\n');
  await file('b.txt', '\uFEFFa\uFEFFb\n');
  dataOf(await call('edit', { path: 'work/b.txt', oldString: '\uFEFF', newString: '-', replaceAll: true }));
  assert.equal(await stored('b.txt'), '\uFEFFa-b\n');
  // Deleting every lone CR keeps the CRLF line ends.
  await file('d.txt', 'a\rb\r\nc\rd\r\n');
  dataOf(await call('edit', { path: 'work/d.txt', oldString: '\r', newString: '', replaceAll: true }));
  assert.equal(await stored('d.txt'), 'ab\r\ncd\r\n');
});

test("a replaceAll whose oldString, read as ending in a CRLF end's CR, changes nothing replaces the occurrences that change", async (t) => {
  const { call, stored, file } = setup(t);
  // Line 1's own text ends in a CR; line 2's "x" is "x\r" with its line end's
  // CR, as a character page shows it, which the file keeps. One edit is
  // refused, as a copy of line 2 may mean it; a replaceAll changes line 1.
  await file('x.txt', 'x\r\r\nx\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/x.txt', oldString: 'x\r', newString: 'x' })),
    /\nWhere it occurs with its last CR read as its CRLF line end's, the edit changes nothing, since the file keeps its line ends\.$/);
  dataOf(await call('edit', { path: 'work/x.txt', oldString: 'x\r', newString: 'x', replaceAll: true }));
  assert.equal(await stored('x.txt'), 'x\r\nx\r\n');
  // Where no occurrence changes, a replaceAll has nothing to change.
  await file('y.txt', 'x\r\ny\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/y.txt', oldString: 'x\r', newString: 'x', replaceAll: true })),
    /^The edit did nothing: oldString and newString are the same once the BOM or the line end's CR that oldString carries is read as work\/y\.txt's own/);
  assert.equal(await stored('y.txt'), 'x\r\ny\r\n');
});

test("an oldString found in two readings other than as given is refused, and one found in three names all three", async (t) => {
  const { call, file } = setup(t);
  // Line 1's own text ends in a CR, and line 2 starts with a BOM of its own
  // text. "\uFEFFxx\r" is line 1 read without the BOM and line 2 read without
  // the CR, and nowhere as given.
  await file('t.txt', '\uFEFFxx\r\r\n\uFEFFxx\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/t.txt', oldString: '\uFEFFxx\r', newString: 'Y' })),
    /\nIt occurs with its last CR read as its CRLF line end's \(on line 2\) and with its BOM read as the file's own \(on line 1\)\.$/);
  // Line 3 holds it as given.
  await file('u.txt', '\uFEFFxx\r\r\n\uFEFFxx\r\n\uFEFFxx\r\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/u.txt', oldString: '\uFEFFxx\r', newString: 'Y' })),
    /\nIt occurs as given \(on line 3\), with its last CR read as its CRLF line end's \(on line 2\) and with its BOM read as the file's own \(on line 1\)\.$/);
});

test("a reading leaves out of the new text only what it leaves out of the old", async (t) => {
  const { call, stored, file } = setup(t);
  // Read without its CR, the new text keeps the BOM it starts with.
  await file('c.txt', 'ab\r\nz\r\n');
  dataOf(await call('edit', { path: 'work/c.txt', oldString: 'ab\r', newString: '\uFEFFcd\r' }));
  assert.equal(await stored('c.txt'), '\uFEFFcd\r\nz\r\n');
  // Read without the file's BOM, the new text keeps the CR it ends with.
  await file('b.txt', '\uFEFFab\nz\n');
  dataOf(await call('edit', { path: 'work/b.txt', oldString: '\uFEFFab', newString: 'cd\r' }));
  assert.equal(await stored('b.txt'), '\uFEFFcd\r\nz\n');
});

test("a copy of a line whose own text ends in a CR is read without that CR before quotes are read as equal", async (t) => {
  const { call, stored, file } = setup(t);
  // Line 2, copied as read shows it, holds a curly quote; line 3, whose own
  // text ends in two CRs, a straight one. Read without its last CR, the copy
  // is line 2's, so line 2 is edited, not line 3, which the quote pass finds.
  await file('q.txt', "aa\r\nx\u2019\r\r\nx'\r\r\r\n");
  dataOf(await call('edit', { path: 'work/q.txt', oldString: 'x\u2019\r\r', newString: 'Y' }));
  assert.equal(await stored('q.txt'), "aa\r\nY\r\nx'\r\r\r\n");
});

test("an oldString that starts with a BOM of its own text and ends in a CR is read without its CR alone, and without both", async (t) => {
  const { call, stored, file } = setup(t);
  // Lines 2 and 3 start with a BOM of their own text. Line 2, copied as read
  // shows it, is line 3's text as given, and itself without its last CR.
  await file('b.txt', '\uFEFFaa\r\n\uFEFFxx\r\r\n\uFEFFxx\r\r\r\n');
  assert.equal(errorOf(await call('edit', { path: 'work/b.txt', oldString: '\uFEFFxx\r\r', newString: 'Y' })),
    "The edit did nothing: oldString starts with a BOM and ends in a CR, and occurs in work/b.txt read more than one way, so which you mean can't be told. "
    + "Include more of the text around it, such as the line before or after it, to say which.\n"
    + "It occurs as given (on line 3) and with its last CR read as its CRLF line end's (on line 2).");
  assert.equal(await stored('b.txt'), '\uFEFFaa\r\n\uFEFFxx\r\r\n\uFEFFxx\r\r\r\n');
  dataOf(await call('edit', { path: 'work/b.txt', oldString: '\uFEFFxx\r\r\n', newString: 'Y\n' }));
  assert.equal(await stored('b.txt'), '\uFEFFaa\r\nY\r\n\uFEFFxx\r\r\r\n');
  // Without both, the file's BOM and the end's CR: line 1.
  await file('c.txt', '\uFEFFab\r\n\uFEFFab\r\r\n');
  assert.match(errorOf(await call('edit', { path: 'work/c.txt', oldString: '\uFEFFab\r', newString: 'Y' })),
    /\nIt occurs as given \(on line 2\) and with its BOM read as the file's own and its last CR as a CRLF line end's \(on line 1\)\.$/);
});

test("the refusal of an oldString read more than one way counts each reading's occurrences and names the lines of its first 20", async (t) => {
  const { call, file } = setup(t);
  await file('n.txt', `${'xx\r\r\n'.repeat(25)}${'xx\r\r\r\n'.repeat(25)}`);
  const error = errorOf(await call('edit', { path: 'work/n.txt', oldString: 'xx\r\r', newString: 'Y', replaceAll: true }));
  assert.ok(error.endsWith("\nIt occurs as given (the first 20 on lines 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44 and 45) "
    + "and with its last CR read as its CRLF line end's (the first 20 on lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 and 20)."), error);
});

test("edit_many names the edit whose oldString reads more than one way, with no clash beside it", async (t) => {
  const { call, stored, file } = setup(t);
  const text = 'aa\r\nxx\r\r\nxx\r\r\r\n';
  await file('r.txt', text);
  assert.equal(errorOf(await call('edit_many', { edits: [
    { path: 'work/r.txt', oldString: 'xx', newString: 'yy', occurrences: 2 },
    { path: 'work/r.txt', oldString: 'xx\r\r', newString: 'Y' },
  ] })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + "edit 2: oldString ends in a CR, and occurs in work/r.txt read more than one way, so which you mean can't be told. "
    + "Include more of the text around it, such as the line before or after it, to say which.\n"
    + "It occurs as given (on line 3) and with its last CR read as its CRLF line end's (on line 2).");
  assert.equal(await stored('r.txt'), text);
});

test('replacing a whole file with nothing stores no bytes, and its receipt shows and names no line', async (t) => {
  const { call, stored, file } = setup(t);
  await file('e.txt', 'all of it\n');
  assert.deepEqual(dataOf(await call('edit', { path: 'work/e.txt', oldString: 'all of it\n', newString: '' })),
    { path: 'work/e.txt', size: 0, replacements: 1, disk: 'waits for materialize', changed: '' });
  assert.equal(await stored('e.txt'), '');
  // At a cap that leaves no room for any region, nothing is named either.
  await file('f.txt', 'all of it\n');
  assert.equal(dataOf(await call('edit', { path: 'work/f.txt', oldString: 'all of it\n', newString: '' }, 200)).changed, '');
});

test("an edit that would take a file past its mount's maxFileSize is refused", async (t) => {
  const { call, stored, file } = setup(t, { maxFileSize: 20 });
  await file('s.txt', 'small\n');
  // Exactly at the limit applies.
  assert.equal(dataOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'x'.repeat(19) })).size, 20);
  assert.equal((await call('edit', { path: 'work/s.txt', oldString: 'x'.repeat(19), newString: 'small' })).success, true);
  // An edit whose counts take the file past the limit is refused before its
  // text is built, from the least its bytes can be: its new texts' UTF-8
  // bytes, less the most each text they replace can take.
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'much, much, much larger' })),
    "The edit did nothing: work/s.txt would be at least 24 bytes with this edit, past the 20-byte limit this mount sets on a file, so the workspace couldn't keep it. "
    + "An edit that leaves the file within the limit applies. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
  // So is one that only its UTF-8 takes past it: 11 code units, 21 bytes.
  assert.equal(errorOf(await call('edit', { path: 'work/s.txt', oldString: 'small', newString: 'é'.repeat(10) })),
    "The edit did nothing: work/s.txt would be at least 21 bytes with this edit, past the 20-byte limit this mount sets on a file, so the workspace couldn't keep it. "
    + "An edit that leaves the file within the limit applies. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
  assert.equal(await stored('s.txt'), 'small\n');
  // One that the CRs of the line ends its new text takes in a CRLF file take
  // past it is built, and refused by its bytes: the least counts each new
  // line feed as one byte, so these 16 bytes are at least 20 with the edit,
  // within the limit, and each new line end keeps the file's CR.
  await file('c.txt', 'ab\r\n'.repeat(4));
  assert.equal(errorOf(await call('edit', { path: 'work/c.txt', oldString: 'b', newString: 'b\n', replaceAll: true })),
    "The edit did nothing: work/c.txt would be 24 bytes with this edit, past the 20-byte limit this mount sets on a file, so the workspace couldn't keep it. "
    + "An edit that leaves the file within the limit applies. The limit is the mount's maxFileSize setting, which only whoever runs the host can change.");
  assert.equal(await stored('c.txt'), 'ab\r\n'.repeat(4));
  // The least never refuses an edit that fits. Each line end it replaces in
  // a CRLF file is two bytes, so these 20 bytes stay 20:
  await file('d.txt', 'ab\r\n'.repeat(5));
  assert.equal(dataOf(await call('edit', { path: 'work/d.txt', oldString: 'b\n', newString: 'bcd', replaceAll: true })).size, 20);
  // and each curly quote it replaces, matched as straight, three, so these 8
  // bytes stay 8, at a limit of 8.
  const quotes = setup(t, { maxFileSize: 8 });
  await quotes.file('q.txt', '\u2018a\u2019\n');
  assert.equal(dataOf(await quotes.call('edit', { path: 'work/q.txt', oldString: "'a'", newString: "'bbbbb'" })).size, 8);
  // and each byte of a character it replaces, so "é" made "ab" stays 3 bytes,
  // at a limit of 3.
  const wide = setup(t, { maxFileSize: 3 });
  await wide.file('w.txt', '\u00e9\n');
  assert.equal(dataOf(await wide.call('edit', { path: 'work/w.txt', oldString: '\u00e9', newString: 'ab' })).size, 3);
});

// ---------------------------------------------------------------------------
// edit_many
// ---------------------------------------------------------------------------

test('edits in one file and across files are stored together, each matched in its file as read, in any order', async (t) => {
  const { call, disk, stored, file } = setup(t, { autoMaterialize: true });
  await file('a.txt', 'one\ntwo\n');
  await file('b.txt', 'three\n');
  const receipt = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/b.txt', oldString: 'three', newString: 'THREE' },
      { path: 'work/a.txt', oldString: 'two', newString: 'one' },
      { path: 'work/a.txt', oldString: 'one\n', newString: 'ONE\n' },
    ],
  }));
  assert.equal(await stored('a.txt'), 'ONE\none\n', "edit 3 didn't match edit 2's new text");
  assert.equal(disk('a.txt')!.toString(), 'ONE\none\n');
  assert.equal(disk('b.txt')!.toString(), 'THREE\n');
  assert.deepEqual(receipt, {
    edits: 3,
    replacements: 3,
    disk: 'done',
    files: [
      { path: 'work/b.txt', size: 6, replacements: 1, edits: [1] },
      { path: 'work/a.txt', size: 8, replacements: 2, edits: [2, 3] },
    ],
    changed: 'work/b.txt\n     1\tTHREE\n\nwork/a.txt\n     1\tONE\n     2\tone',
  });
});

test('one miss stores nothing in any file, and every problem is named in edit order', async (t) => {
  const { call, stored, file } = setup(t);
  await file('a.txt', 'one\n');
  await file('b.txt', 'two two\n');
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'one', newString: 'ONE' },
      { path: 'work/b.txt', oldString: 'two', newString: '2' },
      { path: 'work/a.txt', oldString: 'zzz', newString: 'y' },
      { path: 'work/a.txt', oldString: 'same', newString: 'same' },
      { path: 'nowhere/c.txt', oldString: 'x', newString: 'y' },
    ],
  }));
  assert.equal(refusal, 'The edit_many call stored none of its edits: 4 problems.\n\n'
    + 'edit 2: oldString occurs 2 times in work/b.txt (on line 1), not 1. '
    + 'Include more of the text around it to single out the one you mean, or set occurrences to 2 if every one should change.\n     1\ttwo two\n\n'
    + "edit 3: oldString isn't in work/a.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + "edit 4: oldString and newString are the same, so there's nothing to change.\n\n"
    + 'edit 5: "nowhere/c.txt" starts with "nowhere", which is no mount\'s name, and a path starts with its mount\'s name; the mounts are "work", "other" and "shelf".');
  assert.equal(await stored('a.txt'), 'one\n');
  assert.equal(await stored('b.txt'), 'two two\n');
});

test('overlapping matches are refused, and touching ones apply', async (t) => {
  const { call, stored, file } = setup(t);
  await file('o.txt', 'abcdef\n');
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/o.txt', oldString: 'abc', newString: 'X' },
      { path: 'work/o.txt', oldString: 'cde', newString: 'Y' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'edits 1 and 2 overlap in work/o.txt (from line 1); give each its own stretch of text, or make them one edit.');
  dataOf(await call('edit_many', {
    edits: [
      { path: 'work/o.txt', oldString: 'abc', newString: 'X' },
      { path: 'work/o.txt', oldString: 'def', newString: 'Y' },
    ],
  }));
  assert.equal(await stored('o.txt'), 'XY\n');
});

test('occurrences that overlap are counted until the refusal has those it shows, and it says "at least"', async (t) => {
  const { call, file } = setup(t);
  await file('run.txt', `${' '.repeat(5000)}\n`);
  assert.match(errorOf(await call('edit', { path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', replaceAll: true })),
    /^The edit did nothing: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), and they overlap, so they can't each be replaced\./);
  // A count the scan stopped at is a floor: it differs from one asked for only where it passes it.
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', occurrences: 30 }] })),
    /\n\nedit 1: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), and they overlap/);
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/run.txt', oldString: ' '.repeat(100), newString: 'x', occurrences: 5 }] })),
    /\n\nedit 1: oldString occurs at least 21 times in work\/run\.txt \(the first 20 on line 1\), not 5, and they overlap/);
});

test('a refusal at its cap counts the notes it leaves out apart from its problems', async (t) => {
  const { dir, call, file } = setup(t);
  const names = ['p', 'q', 'r'];
  for (const name of names) await file(`${name}.txt`, `${name} one\n`);
  for (const name of names) writeFileSync(join(dir, `${name}.txt`), `${name} two\n`);
  const refusal = errorOf(await call('edit_many', {
    edits: names.map((name) => ({ path: `work/${name}.txt`, oldString: 'absent', newString: 'x' })),
  }, 700));
  assert.ok(refusal.length <= 700, `${refusal.length} characters`);
  assert.match(refusal, /\n\nedit 3: oldString isn't in work\/r\.txt\./);
  assert.match(refusal, /\[To keep this answer within 700 characters, it leaves out [^\]]*\d notes? on the files' copies on disk\.\]$/);
  assert.doesNotMatch(refusal, /more problems?/);
});

test('occurrences sets the count each edit must find, and replaces every one', async (t) => {
  const { call, stored, file } = setup(t);
  await file('n.txt', 'x x x\n');
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 2 }] })),
    /^The edit_many call stored none of its edits: 1 problem\.\n\nedit 1: oldString occurs 3 times in work\/n\.txt \(on line 1\), not 2\. Include more of the text around it to single out the ones you mean, or set occurrences to 3 if every one should change\./);
  const receipt = dataOf(await call('edit_many', { edits: [{ path: 'work/n.txt', oldString: 'x', newString: 'y', occurrences: 3 }] }));
  assert.equal((receipt.files as Array<{ note?: string }>)[0]!.note, "Edit 1's other replacements are on line 1.");
  assert.equal(await stored('n.txt'), 'y y y\n');
});

test("one call edits one mount's files: other mounts, a read-only mount, an empty list and a malformed edit are refused", async (t) => {
  const { call } = setup(t);
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'a', newString: 'b' },
      { path: 'other/b.txt', oldString: 'a', newString: 'b' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'the edits name files in more than one mount (work, other); one call edits the files of one mount, so send the edits for each mount in a call of its own.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'shelf/a.txt', oldString: 'a', newString: 'b' }] })),
    'The edit_many call stored none of its edits: 1 problem.\n\nedit 1: mount "shelf" is read-only. Calling again won\'t change that; whoever runs this host can make it read-write. The mounts that take writes are "work" and "other".');
  assert.equal(errorOf(await call('edit_many', { edits: [] })), 'The edit_many call did nothing: "edits" is empty. Give at least one edit.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b' }, { path: 'work/a.txt', oldString: 'a' }] })),
    'The edit_many call did nothing: "edits" item 2: "newString" is required.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b', occurrences: 0 }] })),
    'The edit_many call did nothing: "edits" item 1: "occurrences" must be a whole number of at least 1, not 0.');
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b', occurrences: 1.5 }] })),
    'The edit_many call did nothing: "edits" item 1: "occurrences" must be a whole number of at least 1, not 1.5.');
  assert.equal(errorOf(await call('edit_many', { edits: 'work/a.txt' })),
    'The edit_many call did nothing: "edits" must be an array, not a string.');
});

test('a generated file is refused by the rule edit refuses it by: the agent\'s own is read-only, another\'s belongs to that agent', async (t) => {
  const { workspace } = setup(t);
  workspace.registerGeneratedTextFile('work/tools.md', () => 'generated\n', 'agent');
  const as = (callerAgentName: string, name: string, input: unknown) =>
    workspace.handleToolCall({ id: name, name, input, callerAgentName } as Parameters<WorkspaceModule['handleToolCall']>[0]);
  const edit = { path: 'work/tools.md', oldString: 'generated', newString: 'x' };
  const readOnly = `"work/tools.md" is generated from your tool presentation, so it's read-only; set_tool_visibility and set_tool_description change what it shows.`;
  const others = `"work/tools.md" is generated from another agent's tool presentation, and only that agent reads it. Calling again won't change that.`;
  assert.equal(errorOf(await as('agent', 'edit', edit)), `The edit did nothing: ${readOnly}`);
  assert.equal(errorOf(await as('agent', 'edit_many', { edits: [edit] })),
    `The edit_many call stored none of its edits: 1 problem.\n\nedit 1: ${readOnly}`);
  assert.equal(errorOf(await as('another', 'edit', edit)), `The edit did nothing: ${others}`);
  assert.equal(errorOf(await as('another', 'edit_many', { edits: [edit] })),
    `The edit_many call stored none of its edits: 1 problem.\n\nedit 1: ${others}`);
  // write and delete meet the same refusal, by the same rule.
  assert.equal(errorOf(await as('agent', 'write', { path: 'work/tools.md', content: 'x' })), `The write did nothing: ${readOnly}`);
  assert.equal(errorOf(await as('agent', 'delete', { path: 'work/tools.md' })), `The delete did nothing: ${readOnly}`);
  assert.equal(errorOf(await as('another', 'write', { path: 'work/tools.md', content: 'x' })), `The write did nothing: ${others}`);
});

test("a file that isn't valid UTF-8 is refused, and nothing is stored", async (t) => {
  const { call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('latin1.txt', Buffer.from('caf\xe9\n', 'latin1'));
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/a.txt', oldString: 'a', newString: 'A' },
      { path: 'work/latin1.txt', oldString: 'caf', newString: 'tea' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + "edit 2: work/latin1.txt isn't valid UTF-8, so editing it would change bytes outside the text it replaces. "
    + 'Read shows each invalid byte sequence as U+FFFD, and a write replaces the whole file as UTF-8, so writing back what read shows puts U+FFFD in their place.');
  assert.equal(await stored('a.txt'), 'a\n');
});

test('edits disk takes in part are all stored, and the answer names each file disk refused', async (t) => {
  const { dir, call, disk, stored, file } = setup(t, { autoMaterialize: true });
  await file('free.txt', 'free\n');
  await file('linked.txt', 'shared\n');
  linkSync(join(dir, 'linked.txt'), join(dir, 'linked-too.txt'));
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/free.txt', oldString: 'free', newString: 'FREE' },
      { path: 'work/linked.txt', oldString: 'shared', newString: 'SHARED' },
    ],
  }));
  assert.match(refusal, /^Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice\.\n\nDisk took 1 of the call's 2 files\. This file's push didn't complete:\n\nwork\/linked\.txt: not written: a file with other hard links/);
  assert.equal(await stored('free.txt'), 'FREE\n');
  assert.equal(await stored('linked.txt'), 'SHARED\n');
  assert.equal(disk('free.txt')!.toString(), 'FREE\n');
  assert.equal(disk('linked-too.txt')!.toString(), 'shared\n');

  // The one file of a call, and two files of three.
  for (const name of ['solo', 'left', 'right']) {
    await file(`${name}.txt`, `${name}\n`);
    linkSync(join(dir, `${name}.txt`), join(dir, `${name}-too.txt`));
  }
  await file('open.txt', 'open\n');
  const one = errorOf(await call('edit_many', { edits: [{ path: 'work/solo.txt', oldString: 'solo', newString: 'SOLO' }] }));
  assert.match(one, /\n\nDisk didn't take the call's one file\. Its push didn't complete:\n\nwork\/solo\.txt: not written: a file with other hard links/);
  const two = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/open.txt', oldString: 'open', newString: 'OPEN' },
      { path: 'work/left.txt', oldString: 'left', newString: 'LEFT' },
      { path: 'work/right.txt', oldString: 'right', newString: 'RIGHT' },
    ],
  }));
  assert.match(two, /\n\nDisk took 1 of the call's 3 files\. These files' pushes didn't complete, each with its reason:\n\nwork\/left\.txt: not written: a file with other hard links[^\n]*\n\nwork\/right\.txt: not written: a file with other hard links/);
});

test('every entry is set in one record: a call that fails after it says every edit is stored, and one that fails in it stores none', async (t) => {
  const { workspace, store, call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('b.txt', 'b\n');
  const edits = (from: string, to: string) => ({
    edits: [
      { path: 'work/a.txt', oldString: from, newString: to },
      { path: 'work/b.txt', oldString: from === 'a' ? 'b' : 'B', newString: to === 'A' ? 'B' : 'b' },
    ],
  });
  const intents = (workspace as unknown as { intents: Map<string, { update: (...args: unknown[]) => unknown }> }).intents.get('work')!;
  const update = intents.update;
  // Both entries are set, then the first file's intent fails.
  intents.update = () => { throw new Error('injected intent exception'); };
  try {
    assert.equal(errorOf(await call('edit_many', edits('a', 'A'))),
      "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
      + "The rest of the call failed: injected intent exception. ls shows each path's state.");
    // What failed stands for the whole call, so a cap too short for it keeps
    // it, cut as a problem's first line is.
    intents.update = () => { throw new Error(`injected ${'long '.repeat(200)}exception`); };
    const short = errorOf(await call('edit_many', edits('A', 'a'), 200));
    assert.match(short, /^Every edit of this call is stored[^\n]*\n\nThe rest of the call failed: injected [long ]+…\. ls shows each path's state\.$/);
    assert.ok(short.length < 600, `${short.length} characters`);
  } finally {
    intents.update = update;
  }
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');

  // A store that fails as it sets them, recording nothing, sets neither, as
  // reading them back shows, and the answer says so, with what the store
  // said, cut at its bound.
  let message = 'injected batch failure';
  (store as unknown as { treeBatch: () => never }).treeBatch = () => { throw new Error(message); };
  try {
    assert.equal(errorOf(await call('edit_many', edits('a', 'A'))), "The edit_many stopped on an error the workspace didn't expect, before any of its edits was stored: injected batch failure. Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.");
    message = `injected ${'long '.repeat(200)}failure`;
    const long = errorOf(await call('edit_many', edits('a', 'A')));
    // A head of the failure, cut with an ellipsis that names its whole length.
    const lead = "The edit_many stopped on an error the workspace didn't expect, before any of its edits was stored: ";
    const tail = "… (1016 characters). Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.";
    assert.ok(long.startsWith(lead) && long.endsWith(tail), long);
    const kept = long.slice(lead.length, long.length - tail.length);
    assert.ok(kept.length > 0 && kept.length < message.length && message.startsWith(kept), kept);
  } finally {
    delete (store as unknown as Record<string, unknown>).treeBatch;
  }
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');
});

test('a store that throws after recording the edits is read back: the answer says they are stored, and one it can\'t read back says it can\'t tell', async (t) => {
  const { store, workspace, call, stored, file } = setup(t);
  await file('a.txt', 'alpha\n');
  await file('b.txt', 'beta\n');
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = { treeBatch: store.treeBatch, treeSet: store.treeSet, treeGet: store.treeGet };
  const both = (from: [string, string], to: [string, string]) => ({
    edits: [
      { path: 'work/a.txt', oldString: from[0], newString: to[0] },
      { path: 'work/b.txt', oldString: from[1], newString: to[1] },
    ],
  });
  const storedAll = "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
    + 'The store failed after recording them: IO error: No space left on device (os error 28).';
  // The record lands, then the store throws, as Chronicle 0.4 does when the
  // auto-snapshot it writes after recording fails (anima-research/chronicle#39).
  s.treeBatch = (...args) => { real.treeBatch.apply(store, args as never); throw new Error('IO error: No space left on device (os error 28)'); };
  s.treeSet = (...args) => { real.treeSet.apply(store, args as never); throw new Error('IO error: No space left on device (os error 28)'); };
  try {
    assert.equal(errorOf(await call('edit_many', both(['alpha', 'beta'], ['ALPHA', 'BETA']))), storedAll);
    // One file's edits are set on their own, as edit's are.
    assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/b.txt', oldString: 'BETA', newString: 'beta' }] })), storedAll);
    assert.equal(errorOf(await call('edit', { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' })),
      'The edit of "work/b.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
      + 'The store failed after recording it: IO error: No space left on device (os error 28).');
  } finally {
    delete s.treeBatch;
    delete s.treeSet;
  }
  assert.equal(await stored('a.txt'), 'ALPHA\n');
  assert.equal(await stored('b.txt'), 'BETA\n');

  // A set that throws, and then the entries can't be read back either.
  let failed = false;
  s.treeBatch = () => { failed = true; throw new Error('injected batch failure'); };
  s.treeSet = () => { failed = true; throw new Error('injected set failure'); };
  s.treeGet = (...args) => {
    if (failed) throw new Error('injected read failure');
    return real.treeGet.apply(store, args as never);
  };
  try {
    assert.equal(errorOf(await call('edit_many', both(['ALPHA', 'BETA'], ['alpha', 'beta']))),
      "The edit_many call can't tell whether it stored its edits: the store failed as it set them (injected batch failure), "
      + 'and reading them back failed too (injected read failure). Read its files before sending it again: a second call can apply its edits twice.');
    failed = false;
    assert.equal(errorOf(await call('edit', { path: 'work/a.txt', oldString: 'ALPHA', newString: 'alpha' })),
      'Whether the edit of "work/a.txt" is stored isn\'t known: the store failed as it set it (injected set failure), '
      + 'and reading it back failed too (injected read failure). Read the file before sending the edit again: a second edit can apply the change twice.');
    // writeBinary throws it, as its peer callers take a throw: inChronicle
    // would tell them the file is there, which isn't known.
    failed = false;
    await assert.rejects(workspace.writeBinary('work/a.txt', Buffer.from('alpha\n'), 'text/plain'), {
      name: 'CommitUnknownError',
      message: "injected set failure; reading its entries back failed too (injected read failure), so whether the change is stored isn't known",
    });
  } finally {
    delete s.treeBatch;
    delete s.treeSet;
    delete s.treeGet;
  }
  assert.equal(await stored('a.txt'), 'ALPHA\n');

  // A change the tree already holds reads back the same whether or not the
  // set recorded it, so a call whose every change the tree holds already
  // says so with the store's failure: the tree is as it was either way.
  await file('q.txt', 'it’s\n');
  s.treeSet = () => { throw new Error('injected set failure'); };
  try {
    assert.equal(errorOf(await call('edit_many', {
      // Matched with quotes treated as equal, this edit leaves the file's bytes as they were.
      edits: [{ path: 'work/q.txt', oldString: "it's", newString: 'it’s' }],
    })), "The edit_many stopped on an error the workspace didn't expect: injected set failure. Its files already held what the call gave, so they hold that in the workspace either way.");
  } finally {
    delete s.treeSet;
  }
  assert.equal(await stored('q.txt'), 'it’s\n');
  assert.equal(await stored('a.txt'), 'ALPHA\n');
});

test('on a mount that pushes, edits whose store throws after recording them say their push didn\'t run, and a materialize writes them', async (t) => {
  const { store, call, disk, file } = setup(t, { autoMaterialize: true });
  await file('a.txt', 'alpha\n');
  await file('b.txt', 'beta\n');
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = store.treeBatch;
  s.treeBatch = (...args) => { real.apply(store, args as never); throw new Error('IO error: No space left on device (os error 28)'); };
  try {
    assert.equal(errorOf(await call('edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
      ],
    })), "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
      + "The store failed after recording them: IO error: No space left on device (os error 28). Their push to disk didn't run, so disk lacks them until a materialize of their files writes them.");
  } finally {
    delete s.treeBatch;
  }
  assert.equal(disk('a.txt')!.toString(), 'alpha\n');
  assert.equal(disk('b.txt')!.toString(), 'beta\n');
  assert.equal((await call('materialize', { mount: 'work' })).success, true);
  assert.equal(disk('a.txt')!.toString(), 'ALPHA\n');
  assert.equal(disk('b.txt')!.toString(), 'BETA\n');
});

test('the edits are set on the branch their files were read from: nothing awaits between the read and the set', async (t) => {
  const { store, workspace, call, file } = setup(t);
  await file('a.txt', 'alpha\n');
  const main = store.currentBranch().name;
  store.createBranch('other', main);
  const tree = treeStateOf(workspace);
  const read = store.treeGet(tree, 'a.txt')!.blobHash;
  // Reading the file queues a change of branch, which any await before the
  // set would let run first.
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const getBlob = store.getBlob;
  s.getBlob = (...args) => {
    if (args[0] === read) queueMicrotask(() => store.switchBranch('other'));
    return getBlob.apply(store, args as never);
  };
  try {
    dataOf(await call('edit', { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' }));
  } finally {
    delete s.getBlob;
  }
  const text = () => store.getBlob(store.treeGet(tree, 'a.txt')!.blobHash)!.toString();
  assert.equal(store.currentBranch().name, 'other', 'the branch changed during the call');
  assert.equal(text(), 'alpha\n', "the branch selected during the call doesn't have the edit");
  store.switchBranch(main);
  assert.equal(text(), 'ALPHA\n', 'the branch the file was read from has it');
});

test("edit_many refuses a file whose stored copy is missing from the store, and stores none of the call's edits", async (t) => {
  const { store, workspace, call, stored, file } = setup(t);
  await file('a.txt', 'alpha\n');
  await file('b.txt', 'beta\n');
  assert.equal((await call('write', { path: 'work/b.txt', content: 'beta, a draft\n' })).success, true);
  const missing = store.treeGet(treeStateOf(workspace), 'b.txt')!.blobHash;
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const getBlob = store.getBlob;
  s.getBlob = (...args) => (args[0] === missing ? null : getBlob.apply(store, args as never));
  try {
    assert.equal(errorOf(await call('edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
      ],
    })), "The edit_many call stored none of its edits: 1 problem.\n\nedit 2: The workspace's copy of work/b.txt is missing from the store, and disk's copy holds other contents, so it can't be restored, and edit 2 changed nothing. Sync the path to keep disk's copy and give up the workspace's, or write the file again.");
  } finally {
    delete s.getBlob;
  }
  assert.equal(await stored('a.txt'), 'alpha\n');
});

test('on a mount that doesn\'t push, the answer to a store that failed after recording the edits names the conflict the success answer would', async (t) => {
  const { dir, store, workspace, call, stored } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  // A listing records the conflict, before the store fails.
  assert.equal((await call('ls', { path: 'work' })).success, true);
  const copy = "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.";
  // The mount's tree records the edits, then the store throws.
  const tree = treeStateOf(workspace);
  const s = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = { treeBatch: store.treeBatch, treeSet: store.treeSet };
  const fail = (stateId: unknown, done: unknown) => {
    if (stateId === tree) throw new Error('IO error: No space left on device (os error 28)');
    return done;
  };
  s.treeBatch = (...args) => fail(args[0], real.treeBatch.apply(store, args as never));
  s.treeSet = (...args) => fail(args[0], real.treeSet.apply(store, args as never));
  try {
    assert.equal(errorOf(await call('edit', { path: 'work/k.txt', oldString: 'agent draft', newString: 'agent edit' })),
      'The edit of "work/k.txt" is stored in the workspace, so don\'t send it again: a second edit can apply the change twice. '
      + 'The store failed after recording it: IO error: No space left on device (os error 28). '
      + `The path is in conflict with disk (both-changed): the edit is in the workspace's copy. ${copy}`);
    assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/k.txt', oldString: 'agent edit', newString: 'agent edit 2' }] })),
      "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.\n\n"
      + 'The store failed after recording them: IO error: No space left on device (os error 28).\n\n'
      + `work/k.txt is in conflict with disk (both-changed): edit 1 is in the workspace's copy. ${copy}`);
  } finally {
    delete s.treeBatch;
    delete s.treeSet;
  }
  assert.equal(await stored('k.txt'), 'agent edit 2\n');
});

test("edit_many's refusal words each count: fewer than occurrences, quotes read as equal, and the same text twice", async (t) => {
  const { call, file } = setup(t);
  await file('w.txt', 'one x\ntwo x\nit’s\nit’s\nsame\n');
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/w.txt', oldString: 'x', newString: 'y', occurrences: 3 },
      { path: 'work/w.txt', oldString: "it's", newString: 'it is' },
    ],
  })), 'The edit_many call stored none of its edits: 2 problems.\n\n'
    + 'edit 1: oldString occurs 2 times in work/w.txt (on lines 1 and 2), not 3. Set occurrences to 2 if those are all.\n     1\tone x\n     2\ttwo x\n\n'
    + 'edit 2: oldString occurs 2 times in work/w.txt (on lines 3 and 4), with straight and curly quotes treated as equal, not 1. '
    + 'Include more of the text around it to single out the one you mean, or set occurrences to 2 if every one should change.\n     3\tit’s\n     4\tit’s');
  assert.equal(errorOf(await call('edit_many', {
    edits: [
      { path: 'work/w.txt', oldString: 'same', newString: 'A' },
      { path: 'work/w.txt', oldString: 'same', newString: 'B' },
    ],
  })), 'The edit_many call stored none of its edits: 1 problem.\n\nedits 1 and 2 replace the same text in work/w.txt (line 5); give each its own stretch of text.');
});

test('a call of 200,000 edits is refused with each of its problems named', async (t) => {
  const { call, file } = setup(t);
  // More edits than a spread passes as arguments, in one problem.
  const edits = Array.from({ length: 200_000 }, () => ({ path: 'shelf/a.txt', oldString: 'a', newString: 'b' }));
  edits.push({ path: 'nowhere/b.txt', oldString: 'a', newString: 'b' });
  const refusal = errorOf(await call('edit_many', { edits }));
  assert.match(refusal, /^The edit_many call stored none of its edits: 2 problems\.\n\nedits 1–200000: [^\n]*read-only[^\n]*\n\nedit 200001: /);
  // And as many problems from one file's planning.
  await file('m.txt', 'text\n');
  const misses = errorOf(await call('edit_many', { edits: Array.from({ length: 200_000 }, () => ({ path: 'work/m.txt', oldString: 'absent', newString: 'b' })) }));
  assert.match(misses, /^The edit_many call stored none of its edits: 200000 problems\.\n\nedit 1: oldString isn't in work\/m\.txt\./);
});

test('an edit reads its path in the one spelling every tool reads: an empty or "." segment, a ".." that takes one back, and a trailing "/" name the same file', async (t) => {
  const { dir, store, workspace, call, stored } = setup(t, { autoMaterialize: true });
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'one\ntwo\n');
  assert.equal((await call('ls', { path: 'work/sub' })).success, true);
  // Each spelling edits sub/b.txt, the one entry the workspace keeps for it.
  let text = 'one';
  for (const path of ['work/sub//b.txt', 'work/./sub/b.txt', 'work/sub/../sub/b.txt', 'work/sub/b.txt/']) {
    dataOf(await call('edit', { path, oldString: text, newString: `${text}+` }));
    text = `${text}+`;
  }
  assert.equal(await stored('sub/b.txt'), `${text}\ntwo\n`);
  assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf8'), `${text}\ntwo\n`);
  // Named two ways in one call, it's one file, planned once, so each edit is
  // matched in the text the call read.
  dataOf(await call('edit_many', {
    edits: [
      { path: 'work/sub/b.txt', oldString: text, newString: 'ONE' },
      { path: 'work/sub//b.txt', oldString: 'two', newString: 'TWO' },
    ],
  }));
  assert.equal(await stored('sub/b.txt'), 'ONE\nTWO\n');
  // A ".." with nothing before it to take back climbs above the mount's root,
  // even where it comes back in by the mount directory's own name ("mount"),
  // and a separator straight after the mount's name would make the rest an
  // absolute path, even one inside the mount: the parse refuses both, as it
  // does for every tool.
  assert.equal(errorOf(await call('edit', { path: 'work/../mount/sub/b.txt', oldString: 'ONE', newString: 'one' })),
    `The edit did nothing: "work/../mount/sub/b.txt" climbs above the root of mount "work" with "..", and a path can't leave its mount. Name a file from its own mount's name; the mounts are "work", "other" and "shelf".`);
  for (const path of [`work/${dir}`, `work/${dir}/sub/b.txt`]) {
    assert.equal(errorOf(await call('edit', { path, oldString: 'ONE', newString: 'one' })),
      `The edit did nothing: "${path}" has a separator right after mount "work", which makes it an absolute path: give it from the mount's root, as "work/<path>".`);
  }
  // These spellings of the mount's root, its bare name included, are refused
  // as naming no file.
  const root = (path: string) => `${JSON.stringify(path)} names the root of mount "work", which isn't a file; ls "work" lists the files in it.`;
  for (const path of ['work', 'work/', 'work/.', 'work/sub/..']) {
    assert.equal(errorOf(await call('edit', { path, oldString: 'ONE', newString: 'one' })), `The edit did nothing: ${root(path)}`);
  }
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/', oldString: 'ONE', newString: 'one' }] })),
    `The edit_many call stored none of its edits: 1 problem.\n\nedit 1: ${root('work/')}`);
  assert.equal(await stored('sub/b.txt'), 'ONE\nTWO\n');
  assert.deepEqual(store.treeList(treeStateOf(workspace), null).map((entry) => entry.path), ['sub/b.txt']);
  // Dots inside a name are part of the name: the edit reaches the file.
  for (const name of ['..b.txt', 'b.', 'a..b']) {
    writeFileSync(join(dir, 'sub', name), 'one\n');
    dataOf(await call('edit', { path: `work/sub/${name}`, oldString: 'one', newString: 'ONE' }));
    assert.equal(readFileSync(join(dir, 'sub', name), 'utf8'), 'ONE\n');
  }
});

test("edits that ask for more occurrences between them than the file's text is long are refused as crowded", async (t) => {
  const { call, stored, file } = setup(t);
  await file('x.txt', `${'x'.repeat(100)}\n`);
  assert.equal(errorOf(await call('edit_many', {
    edits: ['a', 'b', 'c'].map((newString) => ({ path: 'work/x.txt', oldString: 'x', newString, occurrences: 100 })),
  })), 'The edit_many call stored none of its edits: 1 problem.\n\n'
    + 'edits 1–3: they ask for 300 occurrences between them in work/x.txt, whose text, with its line ends read as LF, is 101 UTF-16 code units long, '
    + 'so some of their matches would overlap; give each its own stretch of text.');
  assert.equal(await stored('x.txt'), `${'x'.repeat(100)}\n`);
});

test("a call counts occurrences its edits don't need, across its files, only as many as its mount lets a file hold bytes, and says where a count is a floor", async (t) => {
  // The edit of a.txt counts all 1,000, 979 of them past its free 21, which
  // leaves 21 of the call's 1,000; the edit of b.txt counts its free 21,
  // those 21, and one more.
  const { call, file } = setup(t, { maxFileSize: 1_000 });
  await file('a.txt', 'a'.repeat(1_000));
  await file('b.txt', 'a'.repeat(1_000));
  const error = errorOf(await call('edit_many', { edits: [{ path: 'work/a.txt', oldString: 'a', newString: 'b' }, { path: 'work/b.txt', oldString: 'a', newString: 'c' }] }));
  assert.match(error, /edit 1: oldString occurs 1000 times in work\/a\.txt \(the first 20 on line 1\), not 1\. Include more of the text around it to single out the one you mean, or set occurrences to 1000 if every one should change\.\n/);
  const floor = /edit 2: oldString occurs at least (\d+) times in work\/b\.txt \(the first 20 on line 1\), not 1\. Include more of the text around it to single out the one you mean\.\nThis call counted as many occurrences as one call may, so \1 is a floor: sent in a call of its own, the edit has every one counted, unless they overlap\.\n/.exec(error);
  assert.ok(floor && Number(floor[1]) > 20 && Number(floor[1]) < 1_000, error);
  // Sent alone, it has every one counted.
  assert.match(errorOf(await call('edit_many', { edits: [{ path: 'work/b.txt', oldString: 'a', newString: 'c' }] })), /edit 1: oldString occurs 1000 times in work\/b\.txt/);
});

test("a file stored before its mount's limit was lowered sizes a call's count budget before any of its files is planned", async (t) => {
  // big.txt, 3,000 bytes, is stored under a limit of 3,000, and a module over
  // the same store lowers the limit to 1,000. The call's budget is 3,000, so
  // both edits of small.txt, planned before big.txt, count all 1,000 of
  // theirs; a budget of the limit would leave the second a floor of 43.
  const { store, dir, file } = setup(t, { maxFileSize: 3_000 });
  await file('small.txt', 'a'.repeat(1_000));
  await file('big.txt', 'a'.repeat(3_000));
  const lowered = new WorkspaceModule({ mounts: [{ name: 'work', path: dir, mode: 'read-write', watch: 'never', autoMaterialize: false, maxFileSize: 1_000 }] });
  lowered.initStore(store);
  const error = errorOf(await lowered.handleToolCall({ id: 'edit_many', name: 'edit_many', input: { edits: [
    { path: 'work/small.txt', oldString: 'a', newString: 'b' },
    { path: 'work/small.txt', oldString: 'a', newString: 'c' },
    { path: 'work/big.txt', oldString: 'a', newString: 'd' },
  ] } } as Parameters<WorkspaceModule['handleToolCall']>[0]));
  assert.match(error, /\nedit 1: oldString occurs 1000 times in work\/small\.txt /);
  assert.match(error, /\nedit 2: oldString occurs 1000 times in work\/small\.txt /);
});

test("an edit asking for more than 20 counts those it asks for freely, after the call's budget is spent", async (t) => {
  // The two edits of "a" spend the call's budget of 1,030; the edit of "b"
  // still counts its 30, and one more, freely, and finds what it asks for.
  const { call, file } = setup(t, { maxFileSize: 1_030 });
  await file('ab.txt', `${'a'.repeat(1_000)}${'b'.repeat(30)}`);
  const error = errorOf(await call('edit_many', { edits: [
    { path: 'work/ab.txt', oldString: 'a', newString: 'x' },
    { path: 'work/ab.txt', oldString: 'a', newString: 'y' },
    { path: 'work/ab.txt', oldString: 'b', newString: 'z', occurrences: 30 },
  ] }));
  assert.match(error, /^The edit_many call stored none of its edits: 2 problems\./);
  assert.doesNotMatch(error, /edit 3/);
});

test("an edit matched with quotes read as equal, or read without its CR, counts against the call's budget too", async (t) => {
  const { call, file } = setup(t, { maxFileSize: 1_000 });
  await file('q.txt', "'".repeat(1_000));
  const quoted = errorOf(await call('edit_many', { edits: ['b', 'c'].map((newString) => ({ path: 'work/q.txt', oldString: '\u2019', newString })) }));
  const quotedFloor = /edit 2: oldString occurs at least (\d+) times in work\/q\.txt \(the first 20 on line 1\), with straight and curly quotes treated as equal, not 1\. Include more of the text around it to single out the one you mean\.\nThis call counted as many occurrences as one call may, so \1 is a floor/.exec(quoted);
  assert.ok(quotedFloor && Number(quotedFloor[1]) > 20 && Number(quotedFloor[1]) < 1_000, quoted);
  // At a limit of 3,000, the first three edits count 979 each past their
  // free 21, which leaves 63.
  const crlf = setup(t, { maxFileSize: 3_000 });
  await crlf.file('c.txt', 'x\r\n'.repeat(1_000));
  const read = errorOf(await crlf.call('edit_many', { edits: ['a', 'b', 'c', 'd'].map((newString) => ({ path: 'work/c.txt', oldString: 'x\r', newString })) }));
  const lines = `${Array.from({ length: 19 }, (_, k) => k + 1).join(', ')} and 20`;
  const crlfFloor = new RegExp(`edit 4: oldString occurs at least (\\d+) times in work/c\\.txt \\(the first 20 on lines ${lines}\\), not 1\\. `
    + 'Include more of the text around it to single out the one you mean\\.\\nThis call counted as many occurrences as one call may, so \\1 is a floor').exec(read);
  assert.ok(crlfFloor && Number(crlfFloor[1]) > 20 && Number(crlfFloor[1]) < 1_000, read);
});

test("edit_many's refusal of 200 edits of an oldString read more than one way names each it has room for as read that way, and counts the rest", async (t) => {
  // Lines alternate between "x" with a CR of its own and "x" alone, before
  // CRLF ends, so "x\r" reads as given on the one and without its CR on the
  // other. That each edit's other reading stops once it has those a refusal
  // shows is pinned in the planner's tests, where its count can be read.
  const { call, file } = setup(t);
  await file('m.txt', 'x\r\r\nx\r\n'.repeat(400_000));
  const error = errorOf(await call('edit_many', { edits: Array.from({ length: 200 }, (_, k) => ({ path: 'work/m.txt', oldString: 'x\r', newString: `${k}` })) }));
  assert.match(error, /^The edit_many call stored none of its edits: 200 problems\./);
  assert.match(error, /\n\nedit 1: oldString ends in a CR, and occurs in work\/m\.txt read more than one way, so which you mean can't be told\./);
  // The answer fits what it can of 200 problems and counts the rest: each
  // it shows is the edit's oldString read more than one way, and those with
  // the rest come to 200.
  const shown = error.match(/\n\nedit \d+: [^\n]*/g) ?? [];
  assert.ok(shown.length > 0 && shown.every((line) => line.includes("oldString ends in a CR, and occurs in work/m.txt read more than one way, so which you mean can't be told.")), shown.find((line) => !line.includes('read more than one way')));
  assert.equal(shown.length + Number(/(\d+) more problems?\b/.exec(error)?.[1] ?? 0), 200);
});

test("a crowded edit whose count stopped short of its ask, which no crowded problem names, is named by its count as a floor", async (t) => {
  const { call, file } = setup(t, { maxFileSize: 2_500 });
  await file('ab.txt', 'ab'.repeat(1_000));
  const error = errorOf(await call('edit_many', { edits: [
    { path: 'work/ab.txt', oldString: 'a', newString: 'x', occurrences: 1_500 },
    { path: 'work/ab.txt', oldString: 'b', newString: 'y', occurrences: 1_500 },
    { path: 'work/ab.txt', oldString: 'ab', newString: 'z', occurrences: 900 },
  ] }));
  assert.match(error, /^The edit_many call stored none of its edits: 3 problems\./);
  const floor = /\nedit 3: oldString occurs at least (\d+) times in work\/ab\.txt \(the first 20 on line 1\)\. Whether it occurs the 900 times it asks for can't be told from this call\.\nThis call counted as many occurrences as one call may, so \1 is a floor: sent in a call of its own, the edit has every one counted, unless they overlap\.\n/.exec(error);
  assert.ok(floor && Number(floor[1]) > 20 && Number(floor[1]) < 900, error);
  // Stopped at just what it asks for, it's a floor all the same.
  const counted = Number(floor[1]);
  const atAsk = errorOf(await call('edit_many', { edits: [
    { path: 'work/ab.txt', oldString: 'a', newString: 'x', occurrences: 1_500 },
    { path: 'work/ab.txt', oldString: 'b', newString: 'y', occurrences: 1_500 },
    { path: 'work/ab.txt', oldString: 'ab', newString: 'z', occurrences: counted },
  ] }));
  assert.ok(atAsk.includes(`\nedit 3: oldString occurs at least ${counted} times in work/ab.txt (the first 20 on line 1). Whether it occurs the ${counted} times it asks for can't be told from this call.\n`), atAsk);
});

test('every path is checked before any entry is set: a check that fails at the second file stores neither', async (t) => {
  const { workspace, store, call, stored, file } = setup(t);
  await file('a.txt', 'a\n');
  await file('b.txt', 'b\n');
  const agreement = (workspace as unknown as { agreement: { barrier: () => void } }).agreement;
  const barrier = agreement.barrier;
  const storeBlob = store.storeBlob;
  // The commit starts once the call has stored its new texts' blobs. From
  // then on each path's check makes the agreement durable first, and the
  // second check fails.
  let armed = false;
  let barriers = 0;
  (store as unknown as { storeBlob: (...args: unknown[]) => unknown }).storeBlob = (...args: unknown[]) => {
    armed = true;
    return (storeBlob as (...a: unknown[]) => unknown).apply(store, args);
  };
  const needsBarrier = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(agreement), 'needsBarrier')!.get!;
  Object.defineProperty(agreement, 'needsBarrier', { configurable: true, get: () => armed || needsBarrier.call(agreement) });
  agreement.barrier = () => {
    if (armed && ++barriers === 2) throw new Error('injected barrier failure');
    barrier.call(agreement);
  };
  try {
    assert.equal(errorOf(await call('edit_many', {
      edits: [
        { path: 'work/a.txt', oldString: 'a', newString: 'A' },
        { path: 'work/b.txt', oldString: 'b', newString: 'B' },
      ],
    })), "The edit_many stopped on an error the workspace didn't expect, before any of its edits was stored: injected barrier failure. "
      + "Calling again may work; if it fails the same way, whoever runs this host can find the whole error in this host's log.");
  } finally {
    delete (store as unknown as Record<string, unknown>).storeBlob;
    delete (agreement as unknown as Record<string, unknown>).needsBarrier;
    delete (agreement as unknown as Record<string, unknown>).barrier;
  }
  assert.equal(await stored('a.txt'), 'a\n');
  assert.equal(await stored('b.txt'), 'b\n');
});

test("a file disk changed is taken in first, and the edits that use it say so", async (t) => {
  const { dir, call, stored, file } = setup(t);
  await file('d.txt', 'v1 line\n');
  writeFileSync(join(dir, 'd.txt'), 'v2 line\n');
  const receipt = dataOf(await call('edit_many', { edits: [{ path: 'work/d.txt', oldString: 'line', newString: 'LINE' }] }));
  assert.equal((receipt.files as Array<{ note?: string }>)[0]!.note,
    "Disk's copy of work/d.txt had changed since the workspace last agreed with it, so it was taken in first, and edit 1 applied to that text.");
  assert.equal(await stored('d.txt'), 'v2 LINE\n');
});

test("a conflict says what a sync does from what disk holds now, whatever kind was recorded, and the sync does it", async (t) => {
  const { dir, call, disk } = setup(t);
  for (const name of ['gone.txt', 'changed-then-gone.txt', 'gone-then-back.txt', 'turned-binary.txt']) {
    writeFileSync(join(dir, name), 'base\n');
    assert.equal((await call('read', { path: `work/${name}` })).success, true);
    assert.equal((await call('write', { path: `work/${name}`, content: 'agent draft\n' })).success, true);
  }
  // Disk deletes a file the workspace holds a draft of.
  rmSync(join(dir, 'gone.txt'));
  // A listing records each file's conflict as disk then has it, and a
  // recorded conflict keeps its kind: both-changed while disk deletes the
  // file, and deleted-on-disk while disk writes it again.
  writeFileSync(join(dir, 'changed-then-gone.txt'), 'another writer\n');
  rmSync(join(dir, 'gone-then-back.txt'));
  assert.equal((await call('ls', { path: 'work' })).success, true);
  rmSync(join(dir, 'changed-then-gone.txt'));
  writeFileSync(join(dir, 'gone-then-back.txt'), 'another writer\n');
  // A disk copy the workspace can't hold.
  const binary = [0, 1, 2, 0, 255, 0];
  writeFileSync(join(dir, 'turned-binary.txt'), Buffer.from(binary));

  const deletion = "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk.";
  const copy = "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.";
  const one = await call('edit', { path: 'work/gone.txt', oldString: 'agent draft', newString: 'agent edit' });
  assert.equal(one.success, true, one.error);
  assert.equal((one.structured as { note?: string }).note,
    `The path is in conflict with disk (deleted-on-disk): the edit is in the workspace's copy. ${deletion}`);
  // A refusal over the same file says the same.
  assert.ok(errorOf(await call('edit', { path: 'work/gone.txt', oldString: 'absent', newString: 'x' })).endsWith(deletion));
  const many = await call('edit_many', {
    edits: [
      { path: 'work/changed-then-gone.txt', oldString: 'agent draft', newString: 'agent edit' },
      { path: 'work/gone-then-back.txt', oldString: 'agent draft', newString: 'agent edit' },
      { path: 'work/turned-binary.txt', oldString: 'agent draft', newString: 'agent edit' },
    ],
  });
  assert.equal(many.success, true, many.error);
  assert.deepEqual((many.structured as { files: Array<{ note?: string }> }).files.map((file) => file.note), [
    `work/changed-then-gone.txt is in conflict with disk (both-changed): edit 1 is in the workspace's copy. ${deletion}`,
    `work/gone-then-back.txt is in conflict with disk (deleted-on-disk): edit 2 is in the workspace's copy. ${copy}`,
    `work/turned-binary.txt is in conflict with disk (both-changed): edit 3 is in the workspace's copy. ${copy}`,
  ]);
  // Each sync does what its note says: it takes the deletion, or keeps disk's
  // copy and gives up the workspace's, taking in none it can't hold.
  for (const name of ['gone.txt', 'gone-then-back.txt', 'turned-binary.txt']) {
    assert.equal((await call('sync', { path: `work/${name}` })).success, true, name);
  }
  assert.equal(errorOf(await call('read', { path: 'work/gone.txt' })), `The read did nothing: there's no file at "work/gone.txt". ls or glob lists the files that exist.`);
  assert.equal(disk('gone-then-back.txt')!.toString(), 'another writer\n');
  assert.match(JSON.stringify((await call('read', { path: 'work/gone-then-back.txt' })).structured), /another writer/);
  assert.equal(errorOf(await call('read', { path: 'work/turned-binary.txt' })),
    `The read did nothing: "work/turned-binary.txt" is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. read, edit and delete act only on the files it stores, so calling again won't change that.`);
  assert.deepEqual([...disk('turned-binary.txt')!], binary);
});

test('edit_many names a conflict with disk, and a file disk lacks, for each file it applies to or refuses', async (t) => {
  const { store, dir, call } = setup(t);
  writeFileSync(join(dir, 'k.txt'), 'base\n');
  assert.equal((await call('read', { path: 'work/k.txt' })).success, true);
  assert.equal((await call('write', { path: 'work/k.txt', content: 'agent draft\n' })).success, true);
  writeFileSync(join(dir, 'k.txt'), 'another writer\n');
  // An entry from before the evidence, so nothing says whether disk deleted it.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  const conflict = "work/k.txt is in conflict with disk (both-changed): edit 1 %s the workspace's copy. "
    + "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.";

  // A miss in the conflicted file says which copy it looked in.
  assert.equal(errorOf(await call('edit_many', { edits: [{ path: 'work/k.txt', oldString: 'another', newString: 'x' }] })),
    "The edit_many call stored none of its edits: 1 problem.\n\nedit 1: oldString isn't in work/k.txt.\nMatch exactly, including whitespace and indentation.\n\n"
    + conflict.replace('%s', 'looked in'));

  const receipt = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/k.txt', oldString: 'draft', newString: 'draft, edited' },
      { path: 'work/l.txt', oldString: 'legacy', newString: 'edited' },
    ],
  }));
  const both = dataOf(await call('edit_many', {
    edits: [
      { path: 'work/k.txt', oldString: 'agent', newString: 'the agent' },
      { path: 'work/k.txt', oldString: 'edited', newString: 'edited twice' },
    ],
  }));
  assert.equal((both.files as Array<{ note?: string }>)[0]!.note, conflict.replace('edit 1 %s', 'edits 1 and 2 are in'));
  assert.deepEqual((receipt.files as Array<{ note?: string }>).map((file) => file.note), [
    conflict.replace('%s', 'is in'),
    "Disk has no copy of work/l.txt, and nothing records whether it was deleted there, so edit 2 applied to the workspace's copy. "
      + 'A materialize of work/l.txt puts it back on disk; if it was deleted there on purpose, delete it here too.',
  ]);
});

test("edit_many says when a file disk lacks went back with its push, and when a path couldn't be checked", async (t) => {
  const { store, call, disk } = setup(t, { autoMaterialize: true });
  // An entry from before the evidence, so nothing says whether disk deleted it.
  const bytes = Buffer.from('legacy line\n');
  store.treeSet('workspace/work/tree', 'l.txt', { blobHash: store.storeBlob(bytes, 'text/plain'), size: bytes.byteLength, mode: 0o644 });
  const pushed = dataOf(await call('edit_many', { edits: [{ path: 'work/l.txt', oldString: 'legacy', newString: 'edited' }] }));
  assert.equal((pushed.files as Array<{ note?: string }>)[0]!.note,
    "Disk has no copy of work/l.txt, and nothing records whether it was deleted there, so edit 1 applied to the workspace's copy. "
    + "This call's push put work/l.txt back on disk; if it was deleted there on purpose, delete it here too.");
  assert.equal(disk('l.txt')!.toString(), 'edited line\n');

  // A path disk made a directory can't be checked; on a mount that doesn't push, the edit applies to the workspace's copy.
  const quiet = setup(t);
  await quiet.file('u.txt', 'held\n');
  rmSync(join(quiet.dir, 'u.txt'));
  mkdirSync(join(quiet.dir, 'u.txt'));
  const held = dataOf(await quiet.call('edit_many', { edits: [{ path: 'work/u.txt', oldString: 'held', newString: 'held, edited' }] }));
  assert.equal((held.files as Array<{ note?: string }>)[0]!.note,
    "work/u.txt couldn't be checked against disk (a directory), so edit 1 applied to the workspace's copy.");
});

// ---------------------------------------------------------------------------
// Answers within the call's resultMaxChars
// ---------------------------------------------------------------------------

test("a refusal keeps to the call's resultMaxChars: every problem is named before any is explained, then counted", async (t) => {
  const { call, file } = setup(t);
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'words '.repeat(20)}`).join('\n');
  await file('l.txt', long);
  const edits = Array.from({ length: 12 }, (_, i) => ({ path: 'work/l.txt', oldString: `line ${i} words  words`, newString: 'x' }));
  const named = (refusal: string) => [...refusal.matchAll(/^edit (\d+): /gm)].map((match) => Number(match[1]));
  const explained = (refusal: string) => refusal.split('\n\n').filter((part) => /^edit \d+: [^\n]*\nClosest region/.test(part)).length;

  // Room for every problem's first line, and the details of only some.
  const cut = errorOf(await call('edit_many', { edits }, 2000));
  assert.ok(cut.length <= 2000, `${cut.length} characters, within 2,000`);
  assert.deepEqual(named(cut), Array.from({ length: 12 }, (_, i) => i + 1), 'every edit named, in order');
  const left = Number(/\[To keep this answer within 2,000 characters, it leaves out the details of (\d+) of these\.\]$/.exec(cut)?.[1]);
  assert.ok(left > 0 && left < 12, `${left} left out their details`);
  assert.equal(explained(cut), 12 - left);

  // Room for some first lines only: the rest are counted, and the call is to be sent again for them.
  const dropped = errorOf(await call('edit_many', { edits }, 500));
  assert.ok(dropped.length <= 500, `${dropped.length} characters, within 500`);
  const shown = named(dropped);
  const counts = /\[To keep this answer within 500 characters, it leaves out the details of (\d+) of these and (\d+) more problems?\. Answer the problems shown and send the call again to see the rest\.\]$/.exec(dropped);
  assert.ok(counts, dropped);
  assert.deepEqual(shown, Array.from({ length: shown.length }, (_, i) => i + 1));
  assert.equal(Number(counts[1]), shown.length);
  assert.equal(shown.length + Number(counts[2]), 12);

  const whole = errorOf(await call('edit_many', { edits }));
  assert.equal(explained(whole), 12, 'the default leaves room for every closest region');

  // Below the least a residence or an agent can set, no problem may fit, and the last line asks nothing of the agent.
  const none = errorOf(await call('edit_many', { edits }, 200));
  assert.equal(named(none).length, 0);
  assert.match(none, /\[To keep this answer within 200 characters, it leaves out 12 more problems\.\]$/);
});

test("a receipt keeps to the call's resultMaxChars, naming the regions past it by their lines", async (t) => {
  const { call, file } = setup(t);
  await file('g.txt', Array.from({ length: 300 }, (_, i) => `row ${i} ${'pad '.repeat(30)}`).join('\n'));
  const edits = Array.from({ length: 30 }, (_, i) => ({ path: 'work/g.txt', oldString: `row ${i * 10} `, newString: `ROW ${i * 10} ` }));
  const max = 3000;
  const result = await call('edit_many', { edits }, max);
  assert.ok(receiptText(result).length <= max, `${receiptText(result).length} characters, within ${max}`);
  assert.match(changedOf(result), /\[not shown, to keep this answer within 3,000 characters: lines \d+–\d+, /);
  assert.match(changedOf(result), /^work\/g\.txt\n     1\tROW 0 /);
});

test("edit's refusal and receipt keep to its call's resultMaxChars too", async (t) => {
  const { call, file } = setup(t);
  await file('l.txt', `${Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n`);
  // Sixty occurrences: the refusal shows the first twenty lines, which pass
  // 1,000 characters at the default.
  const refusal = errorOf(await call('edit', { path: 'work/l.txt', oldString: 'line', newString: 'LINE' }, 1_000));
  assert.ok(refusal.length <= 1_000, `${refusal.length} characters, within 1,000`);
  assert.match(refusal, /^The edit did nothing: oldString occurs 60 times in work\/l\.txt /);
  assert.ok(errorOf(await call('edit', { path: 'work/l.txt', oldString: 'line', newString: 'LINE' })).length > 1_000);
  // A change of eighty lines is named by its lines.
  const receipt = await call('edit', { path: 'work/l.txt', oldString: 'line 0 ', newString: `${`${'A'.repeat(30)}\n`.repeat(80)}line 0 ` }, 1_000);
  assert.ok(receiptText(receipt).length <= 1_000, `${receiptText(receipt).length} characters, within 1,000`);
  assert.match(changedOf(receipt), /^\[not shown, to keep this answer within 1,000 characters: lines 1–\d+\]$/);
});

test("a receipt's regions are measured as its text holds them, where a quote or a backslash takes one character", async (t) => {
  const { call, file } = setup(t);
  await file('q.txt', 'start\n');
  // Eight lines of sixty characters, 120 each as JSON: counted as the text
  // holds them they fit what this receipt has left for its regions, and as
  // JSON they wouldn't.
  const quoted = Array.from({ length: 8 }, () => '"\\'.repeat(30)).join('\n');
  const receipt = await call('edit', { path: 'work/q.txt', oldString: 'start', newString: quoted }, 1_000);
  assert.ok(receiptText(receipt).length <= 1_000, `${receiptText(receipt).length} characters, within 1,000`);
  assert.ok(JSON.stringify(receipt.structured).length > 1_000, 'as JSON the receipt would pass 1,000');
  assert.equal(changedOf(receipt), quoted.split('\n').map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n'));
});

test('a receipt names a region too long to show by its lines without building it whole', async () => {
  // A new text of a million lines, which the receipt names by its lines: it
  // used to slice the whole region and number every line before measuring.
  const bytes = Buffer.from('a\n');
  const planned = planFile(decodeForEdit(bytes)!, bytes, [{ index: 0, oldText: 'a', newText: 'x\n'.repeat(1_000_000), expected: 1 }]);
  assert.ok('plan' in planned);
  const text = planned.plan.updated;
  let sliced = 0;
  const counted = {
    length: text.length,
    indexOf: (search: string, from?: number) => text.indexOf(search, from),
    lastIndexOf: (search: string, from?: number) => text.lastIndexOf(search, from),
    slice: (from: number, to?: number) => {
      const part = text.slice(from, to);
      sliced += part.length;
      return part;
    },
  };
  const shown = shownRegions({ ...planned.plan, updated: counted as unknown as string } as FilePlan, { left: 500 }, 1_000);
  assert.deepEqual(shown, ['[not shown, to keep this answer within 1,000 characters: lines 1–1000001]']);
  assert.ok(sliced < 5_000, `sliced ${sliced} code units`);
});

/**
 * The plan of a file of `lines` empty lines but for `m<line>` on each line
 * in `marks`, which ascend, with an edit of each to `M<line>`.
 */
function markedPlan(lines: number, marks: number[]): FilePlan {
  const parts: string[] = [];
  let at = 0;
  for (const mark of marks) {
    parts.push('\n'.repeat(mark - 1 - at), `m${mark}\n`);
    at = mark;
  }
  parts.push('\n'.repeat(lines - at));
  const bytes = Buffer.from(parts.join(''));
  const planned = planFile(decodeForEdit(bytes)!, bytes, marks.map((mark, index) => ({ index, oldText: `m${mark}`, newText: `M${mark}`, expected: 1 })));
  assert.ok('plan' in planned);
  return planned.plan;
}

test('a receipt keeps to its cap with the longest notes it adds after its budget: twenty regions of eight-digit lines', () => {
  // Two files of 10,000,400 lines, each with 25 edits far apart near its end:
  // past what the regions may take, the note naming them lists twenty
  // ranges of eight-digit line numbers.
  const lines = 10_000_400;
  const plan = markedPlan(lines, Array.from({ length: 25 }, (_, k) => lines - 400 + k * 15));
  const files = [0, 1].map((i) => ({ path: `work/f${i}.txt`, plan, notes: i ? [`Disk's copy of work/f${i}.txt had changed.`] : [] }));
  for (let maxChars = 700; maxChars <= 1_700; maxChars++) {
    const length = receiptText(editReceipt('edit_many', files, 50, maxChars, 'done')).length;
    if (length > maxChars) assert.fail(`${length} characters at a cap of ${maxChars}`);
  }
});

test("a receipt keeps aside the longest note any of its files could add, not its last file's", () => {
  // A file of 100,500 lines with 25 edits far apart near its end, then a file
  // of one edit: past what the regions may take, the first file's note lists
  // twenty ranges of six-digit lines, where the last file's would name line 1.
  const lines = 100_500;
  const files = [
    { path: 'work/long.txt', plan: markedPlan(lines, Array.from({ length: 25 }, (_, k) => lines - 400 + k * 15)), notes: [] },
    { path: 'work/short.txt', plan: markedPlan(1, [1]), notes: [] },
  ];
  const twenty = /lines \d{6}–\d{6}(?:, \d{6}–\d{6}){19}/;
  let named = 0;
  for (let maxChars = 700; maxChars <= 1_700; maxChars++) {
    const receipt = editReceipt('edit_many', files, 26, maxChars, 'done');
    const length = receiptText(receipt).length;
    if (length > maxChars) assert.fail(`${length} characters at a cap of ${maxChars}`);
    if (twenty.test(changedOf(receipt))) named++;
  }
  assert.ok(named > 0, "no receipt named twenty of the first file's regions");
});

test("edit_many's receipt keeps to its cap with a last line that counts each of the four things it leaves out", () => {
  // Five files of 25 edits, each with a note: as the cap falls, files are
  // listed without their notes, then without their edits' numbers, then not
  // at all, and those listed past the budget show no region.
  const text = Array.from({ length: 25 }, (_, k) => `line ${k}\n`).join('');
  const bytes = Buffer.from(text);
  const planned = planFile(decodeForEdit(bytes)!, bytes, Array.from({ length: 25 }, (_, k) => ({ index: k, oldText: `line ${k}\n`, newText: `LINE ${k}\n`, expected: 1 })));
  assert.ok('plan' in planned);
  const files = [0, 1, 2, 3, 4].map((i) => ({
    path: `work/f${i}.txt`,
    plan: planned.plan,
    notes: [`Disk's copy of work/f${i}.txt had changed since the workspace last read it, and the call took that in first.`],
  }));
  const allFour = /\[To keep this answer within [\d,]+ characters, it leaves out \d+ of the call's 5 files, the changed regions of \d+ more files?, the notes of \d+ files? and the edit numbers of \d+ files?\.\]$/;
  let counted = 0;
  for (let maxChars = 700; maxChars <= 2_500; maxChars++) {
    const receipt = editReceipt('edit_many', files, 125, maxChars, 'done');
    const length = receiptText(receipt).length;
    if (length > maxChars) assert.fail(`${length} characters at a cap of ${maxChars}`);
    if (allFour.test(changedOf(receipt))) counted++;
  }
  assert.ok(counted > 0, 'no receipt counted all four');
});

test('a receipt keeps aside only what its own call can add: one edit of a file of one long line shows its region where it fits', () => {
  // The note naming the region of this call's one edit, were it left out,
  // would name line 1 alone. Kept aside as twenty ranges of numbers as long
  // as the file is in code units, it took more than the 300 characters this
  // receipt has to spare.
  const bytes = Buffer.from(`x${'a'.repeat(999_999)}`);
  const planned = planFile(decodeForEdit(bytes)!, bytes, [{ index: 0, oldText: 'x', newText: 'y', expected: 1 }]);
  assert.ok('plan' in planned);
  const files = [{ path: 'work/long.txt', plan: planned.plan, notes: [] }];
  for (const [tool, start] of [['edit', /^ {5}1\ty/], ['edit_many', /^work\/long\.txt\n {5}1\ty/]] as const) {
    const whole = receiptText(editReceipt(tool, files, 1, 1_000_000, 'done')).length;
    const receipt = editReceipt(tool, files, 1, whole + 300, 'done');
    assert.match(changedOf(receipt), start, tool);
    assert.ok(receiptText(receipt).length <= whole + 300);
  }
});

test("a receipt counts the line feed between each of its region's lines, so a region of many short lines keeps to its cap", () => {
  // Three hundred lines of one character: each line feed is a third of a
  // line's own length or more, so a region counted without them would show
  // where its text passes the cap.
  const bytes = Buffer.from('start\n');
  const planned = planFile(decodeForEdit(bytes)!, bytes, [{ index: 0, oldText: 'start', newText: Array.from({ length: 300 }, () => 'x').join('\n'), expected: 1 }]);
  assert.ok('plan' in planned);
  const files = [{ path: 'work/s.txt', plan: planned.plan, notes: [] }];
  let shown = 0;
  for (let maxChars = 2_000; maxChars <= 3_500; maxChars++) {
    const receipt = editReceipt('edit', files, 1, maxChars, 'done');
    const length = receiptText(receipt).length;
    if (length > maxChars) assert.fail(`${length} characters at a cap of ${maxChars}`);
    if (!changedOf(receipt).startsWith('[not shown')) shown++;
  }
  assert.ok(shown > 0, 'the region shows at the larger caps');
});

test("what a receipt keeps aside doesn't grow with a line's length: twenty edits of a long line show their region with what twenty of a short one need", () => {
  // For the note naming the region of twenty edits on one line, a receipt
  // keeps aside twenty ranges that end by line 3, however long the line. Kept
  // aside as twenty ranges as wide as the file is long in code units, it took
  // 120 characters more for the long line than for the short one.
  const start = Array.from({ length: 20 }, (_, k) => `m${k}|`.padEnd(50, 'a')).join('');
  const showsAt = (text: string) => {
    const bytes = Buffer.from(text);
    const planned = planFile(decodeForEdit(bytes)!, bytes, Array.from({ length: 20 }, (_, k) => ({ index: k, oldText: `m${k}|`, newText: `M${k}|`, expected: 1 })));
    assert.ok('plan' in planned);
    const files = [{ path: 'work/line.txt', plan: planned.plan, notes: [] }];
    const whole = receiptText(editReceipt('edit_many', files, 20, 1_000_000, 'done')).length;
    // Whether the region shows with `spare` characters past the whole receipt.
    return (spare: number) => /^work\/line\.txt\n {5}1\t/.test(changedOf(editReceipt('edit_many', files, 20, whole + spare, 'done')));
  };
  const short = showsAt(start);
  const long = showsAt(start + 'a'.repeat(1_000_000));
  let spare = 0;
  while (!short(spare)) if (++spare > 2_000) assert.fail("the short line's region never showed");
  assert.ok(long(spare), `the long line's region needs more than the ${spare} characters the short line's does`);
});

test("one call's misses share one search for closest regions across its files", async (t) => {
  const { call, file } = setup(t);
  // Each file is just over half of what one call may search.
  const big = 'filler text\n'.repeat(90_000);
  await file('big1.txt', big);
  await file('big2.txt', big);
  const refusal = errorOf(await call('edit_many', {
    edits: [
      { path: 'work/big1.txt', oldString: 'absent', newString: 'x' },
      { path: 'work/big2.txt', oldString: 'absent', newString: 'x' },
    ],
  }));
  assert.match(refusal, /\n\nedit 1: oldString isn't in work\/big1\.txt\.\nMatch exactly/);
  assert.match(refusal, /\n\nedit 2: oldString isn't in work\/big2\.txt\.\n\(No closest region: this call's other misses used its 2,097,152 UTF-16 code units of search; find the text with grep\.\)/);
});

test('a receipt lists its files while they fit and counts the rest, and counts the files whose regions it leaves out', async (t) => {
  const { call, file } = setup(t);
  for (let i = 0; i < 30; i++) await file(`f${i}.txt`, `value ${i}\n`);
  const edits = (from: string, to: string) =>
    Array.from({ length: 30 }, (_, i) => ({ path: `work/f${i}.txt`, oldString: `${from} ${i}`, newString: `${to} ${i}` }));

  const shortAnswer = await call('edit_many', { edits: edits('value', 'VALUE') }, 1500);
  const short = dataOf(shortAnswer);
  assert.ok(receiptText(shortAnswer).length <= 1500, `${receiptText(shortAnswer).length} characters`);
  const listed = (short.files as unknown[]).length;
  assert.ok(listed > 0 && listed < 30);
  assert.equal(short.filesNotListed, 30 - listed);
  // Its last line counts them too.
  assert.match(short.changed as string, new RegExp(`\\[To keep this answer within 1,500 characters, it leaves out ${30 - listed} of the call's 30 files[^\\]]*\\.\\]$`));

  const longerAnswer = await call('edit_many', { edits: edits('VALUE', 'value') }, 2200);
  const longer = dataOf(longerAnswer);
  assert.ok(receiptText(longerAnswer).length <= 2200, `${receiptText(longerAnswer).length} characters`);
  assert.equal((longer.files as unknown[]).length, 30);
  assert.match(longer.changed as string, /^work\/f0\.txt\n     1\tvalue 0\n\n/);
  assert.match(longer.changed as string, /\[To keep this answer within 2,200 characters, it leaves out the changed regions of \d+ more files\.\]$/);
});

test('at the least cap a residence or an agent can set, a refusal still names its problems, however long their labels or paths', async (t) => {
  const { dir, call, file } = setup(t);
  // Three hundred edits of one file that can't be edited are one problem, labelled as a range.
  await file('latin1.txt', Buffer.from('caf\xe9\n', 'latin1'));
  const many = errorOf(await call('edit_many', {
    edits: Array.from({ length: 300 }, (_, i) => ({ path: 'work/latin1.txt', oldString: `caf${i}`, newString: 'tea' })),
  }, 1000));
  assert.ok(many.length <= 1000, `${many.length} characters, within 1,000`);
  assert.match(many, /^The edit_many call stored none of its edits: 1 problem\.\n\nedits 1–300: work\/latin1\.txt isn't valid UTF-8/);
  // Edits that alternate with another file's are named ten at a time, and the rest counted.
  await file('plain.txt', 'plain\n');
  const scattered = errorOf(await call('edit_many', {
    edits: Array.from({ length: 60 }, (_, i) => (i % 2
      ? { path: 'work/plain.txt', oldString: `absent ${i}`, newString: 'x' }
      : { path: 'work/latin1.txt', oldString: `caf${i}`, newString: 'tea' })),
  }, 1000));
  assert.ok(scattered.length <= 1000, `${scattered.length} characters, within 1,000`);
  assert.match(scattered, /\n\nedits 1, 3, 5, 7, 9, 11, 13, 15, 17, 19 and 20 more: work\/latin1\.txt isn't valid UTF-8/);

  // A path so long its problem's first line is cut, beside a second problem
  // that still fits; the first's closest region, a long line, doesn't.
  const deep = `${'d'.repeat(200)}/${'e'.repeat(200)}.txt`;
  mkdirSync(join(dir, 'd'.repeat(200)));
  await file(deep, `${'text '.repeat(400)}\n`);
  const long = errorOf(await call('edit_many', {
    edits: [
      { path: `work/${deep}`, oldString: 'texts', newString: 'x' },
      { path: `work/${deep}`, oldString: 'text', newString: 'text' },
    ],
  }, 1000));
  assert.ok(long.length <= 1000, `${long.length} characters, within 1,000`);
  assert.match(long, /\n\nedit 1: oldString isn't in work\/d+\/e+…\n\nedit 2: oldString and newString are the same/);
});

test('the answer to edits stored, within the cap, lists the files disk refused and never says to send the call again', async (t) => {
  const { dir, call, file } = setup(t, { autoMaterialize: true });
  const edits = [];
  for (let i = 0; i < 12; i++) {
    await file(`h${i}.txt`, `held ${i}\n`);
    linkSync(join(dir, `h${i}.txt`), join(dir, `h${i}-too.txt`));
    edits.push({ path: `work/h${i}.txt`, oldString: `held ${i}`, newString: `HELD ${i}` });
  }
  const answer = errorOf(await call('edit_many', { edits }, 1000));
  assert.ok(answer.length <= 1000, `${answer.length} characters, within 1,000`);
  assert.match(answer, /^Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice\.\n\nDisk took 0 of the call's 12 files\. These files' pushes didn't complete, each with its reason:/);
  assert.match(answer, /\n\nwork\/h0\.txt: not written: a file with other hard links/);
  const listed = [...answer.matchAll(/^work\/h\d+\.txt: /gm)].length;
  const left = Number(/\[To keep this answer within 1,000 characters, it leaves out (\d+) more files? disk refused\. ls shows each path's state\.\]$/.exec(answer)?.[1]);
  assert.equal(listed + left, 12, `${listed} listed and ${left} counted`);
  assert.doesNotMatch(answer, /send the call again to see/);
});

test("the answer to edits stored points to ls once: in its last line only when that leaves out files disk refused", () => {
  const stored = 'Every edit of this call is stored.';
  const notes = ['note one '.repeat(30), 'note two '.repeat(30)];
  const notesLeft = fitted(`${stored}\n\nThe rest of the call failed: boom. ls shows each path's state.`, [], notes, 300, 'stored');
  assert.match(notesLeft, /\[To keep this answer within 300 characters, it leaves out 2 notes on the files' copies on disk\.\]$/);
  assert.equal([...notesLeft.matchAll(/ls shows/g)].length, 1);
  const filesLeft = fitted(stored, ['work/a.txt: not written '.repeat(12), 'work/b.txt: not written '.repeat(12)], notes, 300, 'stored');
  assert.match(filesLeft, /it leaves out 2 more files disk refused and 2 notes on the files' copies on disk\. ls shows each path's state\.\]$/);
});

test("a receipt's notes are bounded, and a file whose notes don't fit is listed without them", async (t) => {
  const { call, file } = setup(t);
  const key = (i: number) => `t${String(i).padStart(2, '0')}`;
  await file('n.txt', Array.from({ length: 30 }, (_, i) => `${key(i)} ${key(i)}`).join('\n'));
  const edits = Array.from({ length: 30 }, (_, i) => ({ path: 'work/n.txt', oldString: key(i), newString: key(i).toUpperCase(), occurrences: 2 }));
  const whole = dataOf(await call('edit_many', { edits }));
  const notes = ((whole.files as Array<{ note: string }>)[0]!.note).split(/(?<=\.) /);
  assert.equal(notes.length, 21, 'twenty edits named, and a count of the rest');
  assert.equal(notes[0], "Edit 1's other replacements are on line 1.");
  assert.equal(notes[20], '10 more edits made other replacements too.');

  const short = dataOf(await call('edit_many', { edits: edits.map((edit) => ({ ...edit, oldString: edit.newString, newString: edit.oldString })) }, 1300));
  assert.ok(JSON.stringify(short).length <= 1300, `${JSON.stringify(short).length} characters`);
  assert.deepEqual(short.files, [{ path: 'work/n.txt', size: 239, replacements: 60, edits: Array.from({ length: 30 }, (_, i) => i + 1) }]);
  assert.match(short.changed as string, /the notes of 1 file\.\]$/);

  // A file of 300 edits is named, without its edits' numbers, rather than left out.
  const words = Array.from({ length: 300 }, (_, i) => `w${String(i).padStart(3, '0')}`);
  await file('w.txt', `${words.join(' ')}\n`);
  const many = dataOf(await call('edit_many', { edits: words.map((word) => ({ path: 'work/w.txt', oldString: word, newString: word.toUpperCase() })) }, 1000));
  assert.ok(JSON.stringify(many).length <= 1000, `${JSON.stringify(many).length} characters`);
  assert.deepEqual(many.files, [{ path: 'work/w.txt', size: 1500, replacements: 300 }]);
  assert.match(many.changed as string, /the edit numbers of 1 file\.\]$/);
});
