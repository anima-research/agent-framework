import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule } from '../src/modules/workspace/index.js';

async function setup(t: TestContext, content: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-read-text-'));
  const store = JsStore.openOrCreate({ path: join(root, 'store') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: root, mode: 'read-write', watch: 'never' }],
  });
  workspace.initStore(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await workspace.writeBinary('work/text.txt', Buffer.from(content), 'text/plain')).success, true);
  // A call the framework dispatched carries the most of its result it stores
  // (resultMaxChars); one without it is made in process.
  const read = (input: Record<string, unknown> = {}, resultMaxChars?: number) => workspace.handleToolCall({
    id: 'read', name: 'read', input: { path: 'work/text.txt', ...input }, ...(resultMaxChars !== undefined ? { resultMaxChars } : {}),
  });
  return { workspace, read };
}

type LinePage = { totalLines: number; fromLine?: number; toLine?: number; note?: string; content: string };
type CharPage = { totalChars: number; offsetChars: number; nextOffsetChars: number | null; note?: string; content: string };
/** The text the model reads of a page: its one text block. */
const textOf = (result: { data?: unknown }): string => {
  const blocks = result.data as Array<{ type: string; text: string }>;
  assert.equal(blocks.length, 1);
  return blocks[0]!.text;
};
/** How long a page is as the result limit measures it: its text's length. */
const stored = (result: { data?: unknown }): number => textOf(result).length;
/** A page's text, as read writes it: its fields, one to a line, then its content under its label. */
const pageText = (page: Record<string, unknown>): string => [
  ...Object.entries(page).filter(([key, value]) => key !== 'content' && value !== undefined).map(([key, value]) => `${key}: ${String(value)}`),
  ...(page.content ? [`--- content ---\n${String(page.content)}`] : []),
].join('\n');
// A running script's call's resultMaxChars at the default 128 MiB of script memory.
const SCRIPT_LIMIT = 7_456_527;

test('line reads retain numbering, ranges, and the 2000-line default', async t => {
  const { read } = await setup(t, Array.from({ length: 2005 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await read({ offset: 2, limit: 2 });
  assert.deepEqual(result.structured, {
    path: 'work/text.txt', totalLines: 2005, fromLine: 2, toLine: 3,
    note: 'Truncated at 2 lines (file has 2005). Use offset/limit to read more.',
    content: '     2\tline 2\n     3\tline 3',
  });
  // A script's call can take far more than a turn's, so its default page is the 2000 lines.
  const defaults = (await read({}, SCRIPT_LIMIT)).structured as LinePage;
  assert.equal(defaults.toLine, 2000);
  assert.equal(defaults.content.split('\n').length, 2000);
});

test('a CRLF file reads as its lines without the CR, and says so', async t => {
  const { read } = await setup(t, 'one\r\ntwo\r\n');
  assert.deepEqual((await read()).structured, {
    path: 'work/text.txt', totalLines: 2, fromLine: 1, toLine: 2,
    note: 'Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.',
    content: '     1\tone\n     2\ttwo',
  });
  const { read: readMixed } = await setup(t, 'a\r\nb\nc\r\nd');
  const page = (await readMixed()).structured as LinePage;
  assert.equal(page.content, '     1\ta\n     2\tb\n     3\tc\n     4\td');
  assert.equal(page.note, 'Line ends are mixed, 2 CRLF and 1 LF, and a CRLF end is shown without its CR. An edit matches text as read shows it, and keeps each line\'s end.');
  // One line whose own text ends in a CR, in a file of mixed ends: the note counts it, in the singular.
  const { read: readKept } = await setup(t, 'x\r\r\ny\nz\r\n');
  const kept = (await readKept()).structured as LinePage;
  assert.equal(kept.content, '     1\tx\r\r\n     2\ty\n     3\tz');
  assert.equal(kept.note, 'Line ends are mixed, 2 CRLF and 1 LF, and a CRLF end is shown without its CR, except on 1 line whose own text ends in a CR, which shows both CRs. An edit matches text as read shows it, and keeps each line\'s end.');
  // A CR that doesn't end a line is the line's own.
  const { read: readCr } = await setup(t, 'a\rb\n');
  assert.deepEqual((await readCr()).structured, { path: 'work/text.txt', totalLines: 1, fromLine: 1, toLine: 1, content: '     1\ta\rb' });
});

test('a BOM is noted and not shown, and bytes that aren\'t UTF-8 are noted', async t => {
  const { read } = await setup(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond\n')]));
  assert.deepEqual((await read()).structured, {
    path: 'work/text.txt', totalLines: 2, fromLine: 1, toLine: 2,
    note: 'The file starts with a UTF-8 BOM, which isn\'t shown. An edit keeps it.',
    content: '     1\tfirst\n     2\tsecond',
  });
  // Character paging reads the stored text as it is, the BOM included.
  assert.equal(((await read({ offsetChars: 0, limitChars: 3 })).structured as CharPage).content, '\ufefffi');
  // A BOM alone is an empty file that has one.
  const { read: readBomOnly } = await setup(t, Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual((await readBomOnly()).structured, {
    path: 'work/text.txt', totalLines: 0, note: 'The file starts with a UTF-8 BOM, which isn\'t shown. An edit keeps it.', content: '',
  });
  const notUtf8 = 'The file isn\'t valid UTF-8: each invalid byte sequence shows as U+FFFD. Edit refuses this file, and write replaces it whole.';
  const { read: readLatin1 } = await setup(t, Buffer.from('caf\xe9\n', 'latin1'));
  assert.deepEqual((await readLatin1()).structured, {
    path: 'work/text.txt', totalLines: 1, fromLine: 1, toLine: 1, note: notUtf8, content: '     1\tcaf\ufffd',
  });
  assert.equal(((await readLatin1({ offsetChars: 0 })).structured as CharPage).note, notUtf8);
});

test('a long line is cut at 2000 characters, with the offsetChars and limitChars that read the rest', async t => {
  // A BOM and a CRLF before the long line, so its offset counts both.
  const long = 'x'.repeat(1999) + '😀' + 'y'.repeat(1000);
  const { read } = await setup(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`short\r\n${long}\r\nlast\r\n`)]));
  const page = (await read({}, 24_000)).structured as LinePage;
  const lines = page.content.split('\n');
  assert.equal(lines.length, 3);
  // The cut doesn't split the emoji's surrogate pair: it falls before it.
  const rest = long.length - 1999;
  const at = 1 + 'short\r\n'.length + 1999;
  assert.equal(lines[1], `     2\t${'x'.repeat(1999)} [… read the rest with offsetChars=${at} and limitChars=${rest}]`);
  // A script's call cuts the line the same way.
  assert.equal(((await read({}, SCRIPT_LIMIT)).structured as LinePage).content.split('\n')[1], lines[1]);
  const more = (await read({ offsetChars: at, limitChars: rest })).structured as CharPage;
  assert.equal(more.content, '😀' + 'y'.repeat(1000));
  assert.equal(lines[2], '     3\tlast');
  // Where the cut line ends the page, its note names the offset its marker does.
  const two = (await read({ limit: 2 }, 24_000)).structured as LinePage;
  assert.ok(two.note!.startsWith(`Truncated at 2 lines (file has 3). Line 2 is cut: read its rest with offsetChars=${at} and limitChars=${rest}. Use offset/limit to read more.`), two.note);
});

test('a line page stops before its result would pass the limit, and says where to continue', async t => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}: ${'"'.repeat(i % 7)}`).join('\n');
  const { read } = await setup(t, text);
  for (const limit of [24_000, 5_000, 1_000]) {
    const result = await read({}, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.structured as LinePage;
    assert.ok(page.toLine! < 2000);
    assert.equal(page.note, `Stopped at line ${page.toLine} to stay within the ${limit}-character result limit (file has 3000). Continue with offset=${page.toLine! + 1}.`);
    // One more line would have passed the limit.
    const more = await read({ limit: page.toLine! + 1 }, 5_000_000);
    const withNext = { ...(result.structured as object), toLine: page.toLine! + 1, content: (more.structured as LinePage).content };
    assert.ok(pageText(withNext).length > limit);
    // Continuing reads on from the next line, ends at the line its last shown
    // line is, and says to go on after it.
    const next = (await read({ offset: page.toLine! + 1 }, limit)).structured as LinePage;
    assert.equal(next.fromLine, page.toLine! + 1);
    assert.ok(next.content.startsWith(`${String(page.toLine! + 1).padStart(6)}\tline ${page.toLine! + 1}:`));
    const lastShown = next.content.slice(next.content.lastIndexOf('\n') + 1);
    assert.ok(lastShown.startsWith(`${String(next.toLine).padStart(6)}\tline ${next.toLine}:`), lastShown);
    assert.equal(next.note, `Stopped at line ${next.toLine} to stay within the ${limit}-character result limit (file has 3000). Continue with offset=${next.toLine! + 1}.`);
  }
});

test('a line page is the longest that fits, though the page that ends where it was asked to carries a shorter note', async t => {
  // The page that ends the file has no stop note, so it can fit where a
  // shorter page with one doesn't: both lines, rather than the first cut short.
  const { read } = await setup(t, `${'x'.repeat(900)}\na\n`);
  const both = await read({}, 1_000);
  assert.ok(stored(both) <= 1_000, `${stored(both)}`);
  assert.deepEqual(both.structured, { path: 'work/text.txt', totalLines: 2, fromLine: 1, toLine: 2, content: `     1\t${'x'.repeat(900)}\n     2\ta` });
  const { read: readThree } = await setup(t, `${'a'.repeat(300)}\n${'b'.repeat(550)}\nc\n`);
  const three = await readThree({}, 1_000);
  assert.ok(stored(three) <= 1_000, `${stored(three)}`);
  assert.equal((three.structured as LinePage).toLine, 3);
  assert.equal((three.structured as LinePage).note, undefined);
  // The page at the line limit says so in fewer words than a stop, so it fits
  // at its own length, where the page a line shorter, with a stop note, doesn't.
  const { read: readLimit } = await setup(t, `${'a'.repeat(800)}\nb\nc\n`);
  const atLimit = await readLimit({ limit: 2 }, 5_000_000);
  assert.equal((atLimit.structured as LinePage).note, 'Truncated at 2 lines (file has 3). Use offset/limit to read more.');
  assert.deepEqual((await readLimit({ limit: 2 }, stored(atLimit))).structured, atLimit.structured);
  // The page that ends at a cut line names that line's rest, in more words
  // than a page that ends at a whole line: so the page of lines 1 and 2 fits
  // where the page of line 1 alone, cut at 2,000 characters, doesn't.
  const { read: readCut } = await setup(t, `${'q'.repeat(2500)}\nz\n${'w'.repeat(300)}\n`);
  const two = (limit: number) => ({
    path: 'work/text.txt', totalLines: 3, fromLine: 1, toLine: 2,
    note: `Stopped at line 2 to stay within the ${limit}-character result limit (file has 3). Continue with offset=3.`,
    content: `     1\t${'q'.repeat(2000)} [… read the rest with offsetChars=2000 and limitChars=500]\n     2\tz`,
  });
  const limit = pageText(two(9_999)).length;
  assert.equal(String(limit).length, 4, 'the limit has as many digits as the 9,999 it was measured with');
  assert.deepEqual((await readCut({}, limit)).structured, two(limit));
});

test('a page with notes holds to the result limit with its notes', async t => {
  // A CRLF file's note shares a line page's room with its lines and its stop note.
  const { read } = await setup(t, Array.from({ length: 300 }, (_, i) => `l${i}`).join('\r\n') + '\r\n');
  for (const limit of [1_000, 1_500]) {
    const result = await read({}, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.structured as LinePage;
    assert.equal(page.note, `Stopped at line ${page.toLine} to stay within the ${limit}-character result limit (file has 300). Continue with offset=${page.toLine! + 1}. Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.`);
    // One more line would have passed the limit.
    const more = await read({ limit: page.toLine! + 1 }, 5_000_000);
    assert.ok(pageText({ ...page, toLine: page.toLine! + 1, content: (more.structured as LinePage).content }).length > limit);
  }
  // An invalid-UTF-8 file's note shares a character page's room.
  const { read: readBad } = await setup(t, Buffer.concat([Buffer.from('a'.repeat(5000)), Buffer.from([0xff]), Buffer.from('b'.repeat(5000))]));
  for (const limit of [1_000, 1_500]) {
    const result = await readBad({ offsetChars: 0, limitChars: 100_000 }, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.structured as CharPage;
    assert.equal(page.note, `Stopped at character ${page.nextOffsetChars} to stay within the ${limit}-character result limit; read the rest of what you asked for with offsetChars=${page.nextOffsetChars} and limitChars=${page.totalChars - page.nextOffsetChars!}. The file isn't valid UTF-8: each invalid byte sequence shows as U+FFFD. Edit refuses this file, and write replaces it whole.`);
  }
});

test('a generated file reads under the call\'s result limit too', async t => {
  const { workspace } = await setup(t, 'unused');
  const catalogue = Array.from({ length: 500 }, (_, i) => `tool ${i + 1}: a description long enough to fill a page`).join('\n');
  workspace.registerGeneratedTextFile('work/tools.md', () => catalogue, 'ada');
  const read = (resultMaxChars?: number) => workspace.handleToolCall({
    id: 'generated', name: 'read', input: { path: 'work/tools.md' }, callerAgentName: 'ada', ...(resultMaxChars !== undefined ? { resultMaxChars } : {}),
  });
  const limited = await read(1_000);
  assert.ok(stored(limited) <= 1_000, `${stored(limited)}`);
  const page = limited.structured as LinePage;
  assert.equal(page.note, `Stopped at line ${page.toLine} to stay within the 1000-character result limit (file has 500). Continue with offset=${page.toLine! + 1}.`);
  // A call made in process takes it whole.
  assert.equal(((await read()).structured as LinePage).toLine, 500);
});

test('a first line that alone would pass the limit is cut where it fits', async t => {
  const { read } = await setup(t, '"'.repeat(1500) + '\nnext\n');
  const result = await read({}, 1_000);
  assert.ok(stored(result) <= 1_000, `${stored(result)}`);
  const page = result.structured as LinePage;
  assert.equal(page.toLine, 1);
  const [, shown, at, rest] = /^ {5}1\t("*) \[… read the rest with offsetChars=(\d+) and limitChars=(\d+)\]$/.exec(page.content)!;
  assert.ok(shown.length > 0);
  assert.equal(Number(at), shown.length);
  assert.equal(shown.length + Number(rest), 1500);
  // Reading on in order means the rest of line 1 first, so the note names it.
  assert.equal(page.note, `Stopped at line 1 to stay within the 1000-character result limit (file has 2). Line 1 is cut: read its rest with offsetChars=${at} and limitChars=${rest}, then continue with offset=2.`);
  // The cut is the most the page has room for: one character more passes the
  // limit, on a page that goes on and on one that ends the file.
  const oneMore = (cutPage: LinePage, chars: number) => {
    const more = chars + 1;
    return pageText({
      ...cutPage,
      ...(cutPage.note !== undefined ? { note: cutPage.note.replace(/offsetChars=\d+ and limitChars=\d+/, `offsetChars=${more} and limitChars=${1500 - more}`) } : {}),
      content: `     1\t${'"'.repeat(more)} [… read the rest with offsetChars=${more} and limitChars=${1500 - more}]`,
    }).length;
  };
  assert.ok(oneMore(page, shown.length) > 1_000, `${oneMore(page, shown.length)}`);
  const { read: readOneLine } = await setup(t, '"'.repeat(1500));
  const last = await readOneLine({}, 1_000);
  assert.ok(stored(last) <= 1_000, `${stored(last)}`);
  const lastPage = last.structured as LinePage;
  const lastShown = /^ {5}1\t("*) \[/.exec(lastPage.content)![1].length;
  // The page ends the file, and its last line is cut, so its note names the rest.
  assert.equal(lastPage.toLine, lastPage.totalLines);
  assert.equal(lastPage.note, `Line 1 is cut: read its rest with offsetChars=${lastShown} and limitChars=${1500 - lastShown}.`);
  assert.ok(oneMore(lastPage, lastShown) > 1_000, `${oneMore(lastPage, lastShown)}`);
  // Shown whole, a line carries no marker and its note no cut, so its page can
  // fit where a cut one character shorter doesn't: it is shown whole.
  const { read: readFits } = await setup(t, 'x'.repeat(900));
  const fitting = await readFits({}, 1_000);
  assert.ok(stored(fitting) <= 1_000, `${stored(fitting)}`);
  assert.deepEqual(fitting.structured, { path: 'work/text.txt', totalLines: 1, fromLine: 1, toLine: 1, content: `     1\t${'x'.repeat(900)}` });
  // A limit with no room beside the page's own fields still shows where the line's text is.
  const tiny = (await read({}, 50)).structured as LinePage;
  assert.equal(tiny.toLine, 1);
  assert.equal(tiny.content, '     1\t [… read the rest with offsetChars=0 and limitChars=1500]');
  assert.match(tiny.note!, /Line 1 is cut: read its rest with offsetChars=0 and limitChars=1500, then continue with offset=2\.$/);
});

test("a first line cut to fit stays within 2,000 characters, though a longer cut would fit once its rest loses a digit", async t => {
  const { read } = await setup(t, 'a'.repeat(3_000));
  const withCut = (page: LinePage, cut: number) => pageText({
    ...page,
    note: `Line 1 is cut: read its rest with offsetChars=${cut} and limitChars=${3_000 - cut}.`,
    content: `     1\t${'a'.repeat(cut)} [… read the rest with offsetChars=${cut} and limitChars=${3_000 - cut}]`,
  }).length;
  const shape = (await read({}, 24_000)).structured as LinePage;
  // At this limit the cut at 2,000 is a character too long, and the cut at
  // 2,001 would fit, since its rest's length, 999, has a digit fewer than
  // 1,000, in the marker and in the note.
  const limit = withCut(shape, 2_000) - 1;
  assert.equal(withCut(shape, 2_001), limit);
  const result = await read({}, limit);
  assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
  const page = result.structured as LinePage;
  assert.equal(/^ {5}1\t(a*) \[/.exec(page.content)![1].length, 1_999);
  assert.equal(stored(result), withCut(page, 1_999));
});

test("a first line cut to fit is the longest cut that fits, where the rest's length loses a digit too", async t => {
  // The rest's length is in the marker and in the note, so at the cut where it
  // goes from 1,000 to 999 the page loses two characters for the one it gains,
  // and is a character shorter than at the cut before. Each letter takes one
  // character of the page's text, so some limit in this range lands on that dip.
  const { read } = await setup(t, 'a'.repeat(1_500));
  const withCut = (page: LinePage, cut: number) => pageText({
    ...page,
    note: `Line 1 is cut: read its rest with offsetChars=${cut} and limitChars=${1_500 - cut}.`,
    content: `     1\t${'a'.repeat(cut)} [… read the rest with offsetChars=${cut} and limitChars=${1_500 - cut}]`,
  }).length;
  const cuts = new Set<number>();
  for (let limit = 700; limit <= 760; limit++) {
    const result = await read({}, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.structured as LinePage;
    const cut = /^ {5}1\t(a*) \[/.exec(page.content)![1].length;
    cuts.add(cut);
    assert.equal(withCut(page, cut), stored(result));
    for (let more = 1; more <= 4; more++) assert.ok(withCut(page, cut + more) > limit, `at ${limit}, a cut of ${cut + more} fits where ${cut} was shown`);
  }
  // The range covers the dip. Cuts of 499 and 500 are never the longest that
  // fits, since the page of each is as long as the page two cuts on.
  assert.ok(cuts.has(498) && cuts.has(501) && !cuts.has(499) && !cuts.has(500), [...cuts].join(' '));
});

test('a first line cut to fit, read from a later offset, is numbered and placed in the file', async t => {
  const { read } = await setup(t, `a\nb\n${'"'.repeat(1500)}\nnext\n`);
  const page = (await read({ offset: 3 }, 1_000)).structured as LinePage;
  assert.deepEqual([page.fromLine, page.toLine], [3, 3]);
  const [, shown, at, rest] = /^ {5}3\t("*) \[… read the rest with offsetChars=(\d+) and limitChars=(\d+)\]$/.exec(page.content)!;
  assert.ok(shown.length > 0 && shown.length < 1500, `${shown.length}`);
  // The rest starts past lines 1 and 2, "a\n" and "b\n", in the stored text.
  assert.equal(Number(at), 4 + shown.length);
  assert.equal(page.note, `Stopped at line 3 to stay within the 1000-character result limit (file has 4). Line 3 is cut: read its rest with offsetChars=${at} and limitChars=${rest}, then continue with offset=4.`);
  // The rest read with both reads to the line's end and no further.
  const more = (await read({ offsetChars: Number(at), limitChars: Number(rest) }, 24_000)).structured as CharPage;
  assert.equal(more.content, '"'.repeat(Number(rest)));
  assert.equal(more.nextOffsetChars, 4 + 1500);
});

test("a cut line's rest read through several character pages, following only the notes, ends where the line does", async t => {
  // A rest longer than a page at a limit of 1,000, with more lines after it:
  // each character page that stops gives what's left of the rest, so reading
  // on as the notes say reaches the line's end and no further.
  const long = 'z'.repeat(5_000);
  const { read } = await setup(t, `head\n${long}\n${Array.from({ length: 50 }, (_, i) => `after ${i}`).join('\n')}\n`);
  // From line 2, the line is cut to fit the page.
  const linePage = (await read({ offset: 2 }, 1_000)).structured as LinePage;
  const [, at, left] = /Line 2 is cut: read its rest with offsetChars=(\d+) and limitChars=(\d+), then continue with offset=3\.$/.exec(linePage.note!)!;
  const lineEnd = 'head\n'.length + long.length;
  assert.equal(Number(at) + Number(left), lineEnd);
  let offsetChars = Number(at);
  let limitChars = Number(left);
  let rest = '';
  let pages = 0;
  for (;;) {
    assert.ok(++pages < 100, 'every page moves on');
    const result = await read({ offsetChars, limitChars }, 1_000);
    assert.ok(stored(result) <= 1_000, `${stored(result)}`);
    const page = result.structured as CharPage;
    rest += page.content;
    const next = page.note === undefined ? null : /read the rest of what you asked for with offsetChars=(\d+) and limitChars=(\d+)/.exec(page.note);
    if (next === null) {
      // The last page holds all it was asked for, and ends at the line's end.
      assert.equal(page.note, undefined);
      assert.equal(page.nextOffsetChars, lineEnd);
      break;
    }
    offsetChars = Number(next[1]);
    limitChars = Number(next[2]);
    assert.equal(offsetChars + limitChars, lineEnd);
  }
  assert.ok(pages > 2, `${pages} pages`);
  assert.equal(rest, long.slice(Number(at) - 'head\n'.length));
});

test('a page whose last line is cut names where its rest starts before the next line', async t => {
  const long = 'z'.repeat(3000);
  const { read } = await setup(t, `short\n${long}\n${long}\n${long}\n`);
  const at = (line: number) => 'short\n'.length + (line - 2) * (long.length + 1) + 2000;
  // The limit stops the page at the cut line.
  const byLimit = (await read({ limit: 2 }, 24_000)).structured as LinePage;
  assert.equal(byLimit.toLine, 2);
  assert.equal(byLimit.note, `Truncated at 2 lines (file has 4). Line 2 is cut: read its rest with offsetChars=${at(2)} and limitChars=1000. Use offset/limit to read more.`);
  // The result limit stops it there: line 4 would pass 5,000 characters.
  const byBudget = (await read({}, 5_000)).structured as LinePage;
  assert.equal(byBudget.toLine, 3);
  assert.equal(byBudget.note, `Stopped at line 3 to stay within the 5000-character result limit (file has 4). Line 3 is cut: read its rest with offsetChars=${at(3)} and limitChars=1000, then continue with offset=4.`);
  // A cut line inside a page has its rest named by its own marker alone. The
  // page that ends the file names its cut last line too: toLine is the last
  // line, but the file isn't read whole until that line's rest is.
  const whole = (await read({}, 24_000)).structured as LinePage;
  assert.equal(whole.toLine, 4);
  assert.equal(whole.note, `Line 4 is cut: read its rest with offsetChars=${at(4)} and limitChars=1000.`);
  // A page that ends the file on a line shown whole has nothing to say.
  const { read: readShort } = await setup(t, `${long}\nshort\n`);
  assert.equal(((await readShort({}, 24_000)).structured as LinePage).note, undefined);
});

test('a call that carries no resultMaxChars pages by its line limit alone, with every line whole', async t => {
  // Such a call is made in process, and its caller takes the data itself, as
  // connectome-host's file viewer does with limit 5000 and a cap of its own.
  const long = 'q'.repeat(3000);
  const lines = Array.from({ length: 3000 }, (_, i) => (i === 10 ? long : `line ${i + 1} of a file long enough to pass 24,000 characters`));
  const { read } = await setup(t, lines.join('\r\n'));
  const page = (await read({ limit: 2500 })).structured as LinePage;
  assert.equal(page.toLine, 2500);
  assert.equal(page.note, 'Truncated at 2500 lines (file has 3000). Use offset/limit to read more. Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.');
  const shown = page.content.split('\n');
  assert.equal(shown.length, 2500);
  assert.equal(shown[10], `    11\t${long}`);
  assert.ok(pageText(page).length > 100_000, `${pageText(page).length}`);
  // The default is 2000 lines, and the page that ends the file has no note but the text's.
  assert.equal(((await read()).structured as LinePage).toLine, 2000);
  const end = (await read({ offset: 2001 })).structured as LinePage;
  assert.equal(end.toLine, 3000);
  assert.equal(end.note, 'Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.');
  // A character page gives its limitChars whole too.
  const chars = (await read({ offsetChars: 0, limitChars: 100_000 })).structured as CharPage;
  assert.equal(chars.content.length, 100_000);
  assert.equal(chars.nextOffsetChars, 100_000);
  assert.equal(chars.note, undefined);
});

test('a character page stops at the result limit too, with nextOffsetChars', async t => {
  // A control character, which JSON wrote six characters long, takes one in the page's text.
  const text = 'abc\u0001'.repeat(20_000);
  const { read } = await setup(t, text);
  for (const limit of [24_000, 1_000]) {
    // Following each page's note, from a first page asked for more than the file holds.
    let offsetChars = 0;
    let limitChars = 100_000;
    let recovered = '';
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 1_000, 'every page moves on');
      const result = await read({ offsetChars, limitChars }, limit);
      assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
      const page = result.structured as CharPage;
      recovered += page.content;
      if (page.nextOffsetChars === null) break;
      // What's left of what was asked for is the rest of the text.
      assert.equal(page.note, `Stopped at character ${page.nextOffsetChars} to stay within the ${limit}-character result limit; read the rest of what you asked for with offsetChars=${page.nextOffsetChars} and limitChars=${text.length - page.nextOffsetChars}.`);
      offsetChars = page.nextOffsetChars;
      limitChars = text.length - page.nextOffsetChars;
    }
    assert.equal(recovered, text);
  }
  // A limit with no room beside the page's own fields still moves the page on.
  const tiny = (await read({ offsetChars: 5, limitChars: 100 }, 50)).structured as CharPage;
  assert.equal(tiny.offsetChars, 5);
  assert.equal(tiny.nextOffsetChars, 6);
  assert.equal(tiny.content, text[5]);
  // A surrogate pair is never split at the stop, whatever the limit leaves room for.
  const { read: readEmoji } = await setup(t, '😀'.repeat(20_000));
  for (let limit = 1_000; limit < 1_004; limit++) {
    const result = await readEmoji({ offsetChars: 0, limitChars: 100_000 }, limit);
    assert.ok(stored(result) <= limit, `${stored(result)} > ${limit}`);
    const page = result.structured as CharPage;
    assert.equal(page.nextOffsetChars! % 2, 0, `at ${limit}`);
    assert.equal(page.content.length % 2, 0, `at ${limit}`);
  }
});

test('a character page moved on by a whole character keeps a surrogate pair whole, and one holding all it was asked for names no stop', async t => {
  // A limit too small for the page's own fields still moves the page on, by a
  // whole character: an emoji's two code units.
  const { read } = await setup(t, '😀abc');
  assert.deepEqual((await read({ offsetChars: 0, limitChars: 100 }, 50)).structured, {
    path: 'work/text.txt', totalChars: 5, offsetChars: 0, nextOffsetChars: 2,
    note: 'Stopped at character 2 to stay within the 50-character result limit; read the rest of what you asked for with offsetChars=2 and limitChars=3.',
    content: '😀',
  });
  // Where that step reaches what the page was asked for, the page holds all of it.
  const { read: readOne } = await setup(t, 'a');
  assert.deepEqual((await readOne({ offsetChars: 0, limitChars: 1 }, 50)).structured, {
    path: 'work/text.txt', totalChars: 1, offsetChars: 0, nextOffsetChars: null, content: 'a',
  });
  const { read: readSix } = await setup(t, 'abcdef');
  assert.deepEqual((await readSix({ offsetChars: 0, limitChars: 1 }, 50)).structured, {
    path: 'work/text.txt', totalChars: 6, offsetChars: 0, nextOffsetChars: 1, content: 'a',
  });
});

test('character mode can be selected by either parameter and reports EOF', async t => {
  const { read } = await setup(t, 'a'.repeat(3000));
  assert.deepEqual((await read({ offsetChars: 0 })).structured, {
    path: 'work/text.txt', totalChars: 3000, offsetChars: 0, nextOffsetChars: 2000, content: 'a'.repeat(2000),
  });
  assert.equal(((await read({ limitChars: 3 })).structured as { content: string }).content, 'aaa');
  assert.deepEqual((await read({ offsetChars: 2999, limitChars: 10 })).structured, {
    path: 'work/text.txt', totalChars: 3000, offsetChars: 2999, nextOffsetChars: null, content: 'a',
  });
  for (const offsetChars of [3000, 4000, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual((await read({ offsetChars })).structured, {
      path: 'work/text.txt', totalChars: 3000, offsetChars: 3000, nextOffsetChars: null, content: '',
    });
  }
});

test('character pages preserve Unicode and raw newlines, even with limitChars 1', async t => {
  const body = '😀a\r\n𐐷e\u0301終';
  const { read } = await setup(t, body);
  let offsetChars = 0;
  let recovered = '';
  do {
    const result = await read({ offsetChars, limitChars: 1 });
    assert.equal(result.success, true);
    const page = result.structured as { content: string; nextOffsetChars: number | null };
    assert.ok(page.content.length >= 1 && page.content.length <= 2);
    assert.equal(Buffer.from(page.content).toString(), page.content, 'UTF-8 transport cannot replace half a pair');
    recovered += page.content;
    if (page.nextOffsetChars === null) break;
    assert.ok(page.nextOffsetChars > offsetChars);
    offsetChars = page.nextOffsetChars;
  } while (true);
  assert.equal(recovered, body);
  const invalid = await read({ offsetChars: 1 });
  assert.equal(invalid.success, false);
  assert.match(invalid.error!, /surrogate pair/);
});

test('empty text returns an empty final character page', async t => {
  const { read } = await setup(t, '');
  assert.deepEqual((await read({ offsetChars: 0 })).structured, {
    path: 'work/text.txt', totalChars: 0, offsetChars: 0, nextOffsetChars: null, content: '',
  });
});

test('character paging rejects invalid numbers and ambiguous line/character inputs', async t => {
  const { read } = await setup(t, 'hello');
  for (const input of [
    { offsetChars: -1 }, { offsetChars: 0.5 }, { offsetChars: NaN }, { offsetChars: Infinity },
    { offsetChars: Number.MAX_SAFE_INTEGER + 1 }, { offsetChars: '0' }, { offsetChars: null },
    { limitChars: 0 }, { limitChars: -1 }, { limitChars: 0.5 }, { limitChars: NaN },
    { limitChars: Infinity }, { limitChars: Number.MAX_SAFE_INTEGER + 1 },
    { limitChars: '2' }, { limitChars: null },
    { offset: 1, offsetChars: 0 }, { limit: 2, limitChars: 1 },
    { offset: 1, limitChars: 1 }, { limit: 2, offsetChars: 0 },
  ]) {
    const result = await read(input);
    assert.equal(result.success, false, JSON.stringify(input));
    assert.equal(result.isError, true);
  }
});

test('character reads use the same mount containment and missing-file checks', async t => {
  const { read } = await setup(t, 'hello');
  for (const path of ['work/../escape', 'unknown/file', 'work/missing']) {
    const result = await read({ path, offsetChars: 0 });
    assert.equal(result.success, false, path);
    assert.equal(result.isError, true);
  }
});
