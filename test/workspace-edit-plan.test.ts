// The edit planner: where each edit's old text occurs in a file's text as
// read, what stops an edit applying, and the file's new bytes once every edit
// applies, with every byte the edits don't name kept as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  type EditSpec,
  type FilePlan,
  type MatchProblem,
  HINT_MAX_CHARS,
  COUNT_MAX,
  countBudget,
  decodeForEdit,
  hintBudget,
  lineNumbersAt,
  planFile,
} from '../src/modules/workspace/edit-plan.js';
import { countingCalls } from './helpers/count-calls.js';

const spec = (index: number, oldText: string, newText: string, expected: number | 'all' = 1): EditSpec =>
  ({ index, oldText, newText, expected });

/** The plan for `text` (as UTF-8 bytes), or a failure naming its problems. */
function plan(text: string | Buffer, specs: EditSpec[]): FilePlan {
  const bytes = typeof text === 'string' ? Buffer.from(text) : text;
  const planned = planFile(decodeForEdit(bytes)!, bytes, specs);
  if (!('plan' in planned)) assert.fail(`refused: ${JSON.stringify(planned)}`);
  return planned.plan;
}

function problems(text: string, specs: EditSpec[], hints = hintBudget()): MatchProblem[] {
  const bytes = Buffer.from(text);
  const planned = planFile(decodeForEdit(bytes)!, bytes, specs, hints);
  if (!('problems' in planned)) assert.fail('plan' in planned ? 'applied' : `refused as too large: ${JSON.stringify(planned)}`);
  return planned.problems;
}

test('every edit is matched in the text as read, in any order, never in another edit\'s result', () => {
  const text = 'alpha beta\ngamma\n';
  // Edit 1's new text holds edit 2's old text, which still matches only where the file had it.
  const forward = plan(text, [spec(0, 'alpha', 'gamma gamma'), spec(1, 'gamma\n', 'delta\n')]);
  const backward = plan(text, [spec(1, 'gamma\n', 'delta\n'), spec(0, 'alpha', 'gamma gamma')]);
  assert.equal(forward.bytes.toString(), 'gamma gamma beta\ndelta\n');
  assert.deepEqual(backward.bytes, forward.bytes);
  assert.deepEqual(forward.edits.map(({ first: { edit, line, lines } }) => ({ edit, line, lines })), [
    { edit: 0, line: 1, lines: 1 },
    { edit: 1, line: 2, lines: 1 },
  ]);
});

test("each edit's replacements are counted, and only its first and the lines of the rest a receipt names are kept", () => {
  // Edit 0 replaces on lines 1, 1, 2, 4 and 5 of the file; edit 1 on line 3, once; edit 2 on
  // 25 lines; edit 3 three times on one line; edit 4 twice, each time two lines it joins.
  const text = `a a\na\nb\na\na\n${'c\n'.repeat(25)}d d d\np\nq\np\nq\n`;
  const planned = plan(text, [spec(0, 'a', 'x\ny', 'all'), spec(1, 'b', 'z'), spec(2, 'c', 'w', 'all'), spec(3, 'd', 'e', 'all'), spec(4, 'p\nq', 'r', 'all')]);
  assert.equal(planned.replacements, 36);
  assert.deepEqual(planned.edits.map(({ first, count, otherLines, otherLineCount }) => [first.edit, first.line, count, otherLines, otherLineCount]), [
    // Each replacement of edit 0 adds a line, so its later ones fall on later lines of the new text.
    [0, 1, 5, [2, 4, 7, 9], 4],
    [1, 6, 1, [], 0],
    [2, 11, 25, Array.from({ length: 20 }, (_, i) => 12 + i), 24],
    // A line counted once, however many replacements fall on it.
    [3, 36, 3, [36], 1],
    // The line ends an old text replaces aren't counted.
    [4, 37, 2, [38], 1],
  ]);
  assert.equal(planned.updated, `x\ny x\ny\nx\ny\nz\nx\ny\nx\ny\n${'w\n'.repeat(25)}e e e\nr\nr\n`);
});

test('a replaceAll of millions of occurrences fits a small heap', () => {
  // While the planner held an object per occurrence, an edit replacing
  // 5,000,000 needed a heap of more than 512 MiB and about 1.4 GiB of memory.
  // Joining the new text's pieces only at the end, it needs a heap of more
  // than 96 MiB for these 3,000,000, on Node 20 and 24 alike, and as it is,
  // one of about 50 MiB. A heap of 80 MiB stops the child if either comes back.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--max-old-space-size=80', '--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    const bytes = Buffer.from('a'.repeat(3_000_000) + '\\n');
    const planned = planFile(decodeForEdit(bytes), bytes, [{ index: 0, oldText: 'a', newText: 'b', expected: 'all' }]);
    const { replacements, bytes: out, edits } = planned.plan;
    console.log(JSON.stringify({ replacements, size: out.length, last: out.subarray(-2).toString(), others: edits[0].otherLines.length }));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { replacements: 3_000_000, size: 3_000_001, last: 'b\n', others: 1 });
});

test('a file the edits would take past maxBytes is refused before its new text is built, from the least its bytes can be', () => {
  const bytes = Buffer.from('aaaa\n');
  const file = decodeForEdit(bytes)!;
  // Five characters, four of them each made three: at least 13 bytes.
  assert.deepEqual(planFile(file, bytes, [spec(0, 'a', 'bbb', 'all')], hintBudget(), 12), { tooLarge: 13 });
  const fits = planFile(file, bytes, [spec(0, 'a', 'bbb', 'all')], hintBudget(), 13);
  assert.ok('plan' in fits && fits.plan.bytes.length === 13);
  // A BOM's three bytes count.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  assert.deepEqual(planFile(decodeForEdit(bom)!, bom, [spec(0, 'a', 'bbb', 'all')], hintBudget(), 15), { tooLarge: 16 });
  // The least counts UTF-8 bytes, so a text that widens only in UTF-8 is
  // refused too.
  assert.deepEqual(planFile(file, bytes, [spec(0, 'a', 'é', 'all')], hintBudget(), 8), { tooLarge: 9 });
  // A new text's line feed that a CRLF file writes as CRLF adds a byte the
  // least leaves out, so such a text is planned, and its bytes are for the
  // caller to check.
  const crlf = Buffer.from('a\r\nb\r\n');
  const longer = planFile(decodeForEdit(crlf)!, crlf, [spec(0, 'a', 'x\ny')], hintBudget(), 8);
  assert.ok('plan' in longer && longer.plan.bytes.length === 9);
});

test('a replaceAll that widens its file past maxBytes only in UTF-8 is refused in a small heap', () => {
  // 5,242,880 a's, each made U+0800, three bytes: built, the new text ran an
  // 80 MiB heap out of memory before its bytes were refused.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--max-old-space-size=80', '--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    const bytes = Buffer.from('a'.repeat(5_242_880));
    console.log(JSON.stringify(planFile(decodeForEdit(bytes), bytes, [{ index: 0, oldText: 'a', newText: '\\u0800', expected: 'all' }], undefined, 5 * 1024 * 1024)));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || `stopped by ${child.signal}`);
  assert.deepEqual(JSON.parse(child.stdout), { tooLarge: 15_728_640 });
});

test("a miss's closest region holds what its old text's first line and the file's lines need, not their every bigram, in a small heap", () => {
  // A random old text of 3,240,000 code units against a small file, and a
  // random line of 1,960,000 against a short old text: holding each one's
  // bigrams ran a 128 MiB heap, and an 80 MiB one, out of memory.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    let a = 7;
    const random = (n, lo, hi) => {
      const units = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        units[i] = lo + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (hi - lo));
      }
      return new TextDecoder('utf-16le').decode(units);
    };
    const small = Buffer.from('hello\\nworld\\n');
    const probe = planFile(decodeForEdit(small), small, [{ index: 0, oldText: random(3_240_000, 0x20, 0xd7ff), newText: 'x', expected: 1 }]);
    const line = Buffer.from(random(1_960_000, 0x80, 0x800));
    const long = planFile(decodeForEdit(line), line, [{ index: 0, oldText: 'not in it', newText: 'x', expected: 1 }]);
    console.log(JSON.stringify([probe.problems[0].kind, long.problems[0].kind]));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || `stopped by ${child.signal}`);
  assert.deepEqual(JSON.parse(child.stdout), ['miss', 'miss']);
});

test("a call counts occurrences past what its edits need only within its budget, and past it a count is a floor", () => {
  // Three edits each asking for one of 5,000,000: the first counts them all,
  // within the budget, and the budget then stops the others, whose counts are
  // floors above the 21 a refusal shows.
  const bytes = Buffer.from('a'.repeat(5_000_000));
  const counts = countBudget();
  const problems = planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'a', 'b'), spec(1, 'a', 'c'), spec(2, 'a', 'd')], hintBudget(), Infinity, counts);
  assert.ok('problems' in problems);
  const shape = (p: (typeof problems.problems)[number]) => (p.kind === 'count' ? [p.found, p.atLeast, p.spent] as const : undefined);
  const [first, ...rest] = problems.problems.map(shape);
  assert.deepEqual(first, [5_000_000, false, false]);
  assert.equal(rest.length, 2, 'the other two edits have count problems too');
  for (const r of rest) assert.ok(r && r[1] && r[2] && r[0] > 21 && r[0] < 5_000_000, JSON.stringify(r));
  // Two hundred such edits share the one budget: together they count no
  // more than it allows, with a small allowance an edit, not 200 times the
  // text.
  const many = planFile(decodeForEdit(bytes)!, bytes, Array.from({ length: 200 }, (_, k) => spec(k, 'a', 'b')));
  assert.ok('problems' in many);
  const shapes = many.problems.map(shape);
  assert.equal(shapes.length, 200);
  assert.ok(shapes.slice(1).every((r) => r && r[1] && r[2] && r[0] > 21), JSON.stringify(shapes.slice(0, 3)));
  const total = shapes.reduce((sum, r) => sum + (r?.[0] ?? 0), 0);
  assert.ok(total <= COUNT_MAX + 200 * 1_000, `${total} counted`);
});

test("a crowded edit whose count the budget stopped short of its ask, or at it, is named by that count where the crowded check names none", () => {
  // Asking 1,500, 1,500 and 900 of a text 2,000 long, the edits are crowded.
  // At a budget of 2,000, the first two count all 1,000 of theirs and are
  // count problems; the third runs the budget out. What's left, 900, fits the
  // text, so no crowded problem names it, and its count does, as a floor.
  const bytes = Buffer.from('ab'.repeat(1_000));
  const counted = (asked: number) => {
    const planned = planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'a', 'x', 1_500), spec(1, 'b', 'y', 1_500), spec(2, 'ab', 'z', asked)], hintBudget(), Infinity, countBudget(2_000));
    assert.ok('problems' in planned);
    return planned.problems.map((p) => p.kind === 'count' && [p.edit, p.found, p.atLeast, p.spent]);
  };
  const [first, second, third] = counted(900);
  assert.deepEqual([first, second], [[0, 1_000, false, false], [1, 1_000, false, false]]);
  assert.ok(third && third[0] === 2 && third[2] === true && third[3] === true && (third[1] as number) > 21 && (third[1] as number) <= 900, JSON.stringify(third));
  // A count the budget stopped at just what the edit asks for is a floor too.
  const floor = third[1] as number;
  assert.deepEqual(counted(floor), [[0, 1_000, false, false], [1, 1_000, false, false], [2, floor, true, true]]);
});

test("an edit's count in a call of its own is exact, in a text longer than the call's limit", () => {
  // As in a file stored before its mount's limit was lowered: the budget is
  // raised to the text's length, which no count passes.
  const bytes = Buffer.from('a'.repeat(1_500));
  const planned = planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'a', 'b')], hintBudget(), Infinity, countBudget(1_000));
  assert.ok('problems' in planned);
  assert.deepEqual(planned.problems.map((p) => p.kind === 'count' && [p.found, p.atLeast, p.spent]), [[1_500, false, false]]);
});

test("crowded edits among which one replaces every occurrence ask for as many as it finds, however little of the budget is left", () => {
  const bytes = Buffer.from(`${'x'.repeat(100)}\n`);
  assert.deepEqual(planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'x', 'a', 'all'), spec(1, 'x', 'b', 100), spec(2, 'x', 'c', 100)]),
    { problems: [{ kind: 'crowded', edits: [0, 1, 2], asked: 300, length: 101 }] });
  // The first edit spends all but 21 of a budget of 1,001; the second stops
  // at 42, short of its ask; the third, replacing every occurrence, counts
  // all 1,000 regardless.
  const long = Buffer.from(`${'x'.repeat(1_000)}\n`);
  const planned = planFile(decodeForEdit(long)!, long, [spec(0, 'x', 'a', 990), spec(1, 'x', 'b', 990), spec(2, 'x', 'c', 'all')], hintBudget(), Infinity, countBudget(1_000));
  assert.ok('problems' in planned);
  assert.deepEqual(planned.problems.map((p) => (p.kind === 'count' ? [p.kind, p.edit, p.found] : p)), [['count', 0, 1_000], { kind: 'crowded', edits: [1, 2], asked: 1_990, length: 1_001 }]);
});

test("a reading in which an edit changes nothing counts toward a refusal for one edit, and not for one that replaces every occurrence", () => {
  // Line 1's own text ends in a CR; line 2's "x", with its CRLF end's CR, is
  // "x\r" read that way, where the edit changes nothing.
  const bytes = Buffer.from('x\r\r\nx\r\n');
  assert.deepEqual(planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'x\r', 'x')]), { problems: [{
    kind: 'readings', edit: 0, bom: false, cr: true,
    readings: [{ leaves: 'nothing', same: false, found: 1, atLeast: false, lines: [1] }, { leaves: 'cr', same: true, found: 1, atLeast: false, lines: [2] }],
  }] });
  const all = planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'x\r', 'x', 'all')]);
  assert.ok('plan' in all, JSON.stringify(all));
  assert.equal(all.plan.bytes.toString(), 'x\r\nx\r\n');
});

test("one count budget raised for a text longer than it is raised once for each length, however many such texts it plans", () => {
  // Raised to 1,500 by the first text, whose one edit counts it all, the
  // budget isn't raised again for the second text of that length.
  const counts = countBudget(1_000);
  const bytes = Buffer.from('a'.repeat(1_500));
  const counted = (newText: string) => {
    const planned = planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'a', newText)], hintBudget(), Infinity, counts);
    assert.ok('problems' in planned);
    return planned.problems.map((p) => p.kind === 'count' && [p.found, p.atLeast, p.spent]);
  };
  assert.deepEqual(counted('b'), [[1_500, false, false]]);
  // Not raised again for the second text of that length: its count is a floor.
  const [second] = counted('c');
  assert.ok(second && second[1] === true && second[2] === true && (second[0] as number) > 21 && (second[0] as number) < 1_500, JSON.stringify(second));
});

test("crowded edits whose counts stopped short, where the crowded check names none, are each named, by a loop, and their problems made only then", () => {
  // The first edit asks for more than there are and counts them all; the
  // second runs the budget out; the next 199,999, each asking 21, stop at 21
  // and between them ask for no more than the text holds. Each is named.
  const text = `${'a'.repeat(4_199)}\n`.repeat(1_000);
  const bytes = Buffer.from(text);
  const specs = [spec(0, 'a', 'x', 10_000_000), ...Array.from({ length: 200_000 }, (_, k) => spec(k + 1, 'a', 'y', 21))];
  const planned = planFile(decodeForEdit(bytes)!, bytes, specs);
  assert.ok('problems' in planned);
  assert.equal(planned.problems.length, 200_001);
  assert.ok(planned.problems.every((p) => p.kind === 'count'));
  // Where the crowded check names them, their problems aren't made. A count
  // problem finds its matches' lines by searching the text for line feeds, so
  // over one line of 2,000,000, made for each of 200,000 edits that a crowded
  // refusal names, those would be a search or more each. The first three
  // edits count past the 3,000 they ask for before the budget runs out, so
  // their problems are made, and their searches show that the count sees a
  // problem being made.
  const line = Buffer.from('a'.repeat(2_000_000));
  const lineFile = decodeForEdit(line)!;
  const crowdedSpecs = Array.from({ length: 200_000 }, (_, k) => spec(k, 'a', 'y', 3_000));
  const { result: crowded, calls } = lineFeedSearches(() => planFile(lineFile, line, crowdedSpecs));
  assert.ok('problems' in crowded);
  // One crowded problem names every edit that has no count problem, the two
  // together name all 200,000 once, and only the few edits the budget let
  // count past their ask have count problems.
  const countEdits = crowded.problems.flatMap((p) => (p.kind === 'count' ? [p.edit] : []));
  const crowdedEdits = crowded.problems.flatMap((p) => (p.kind === 'crowded' ? p.edits : []));
  assert.equal(crowded.problems.filter((p) => p.kind === 'crowded').length, 1);
  assert.ok(countEdits.length >= 1 && countEdits.length < 100, `${countEdits.length} count problems`);
  assert.deepEqual([...countEdits, ...crowdedEdits].sort((a, b) => a - b), Array.from({ length: 200_000 }, (_, k) => k));
  assert.ok(calls >= 1 && calls < 1_000, `${calls} searches for a line feed`);
});

/** The searches `run` makes for a line feed with indexOf; past 1,000, it throws. */
function lineFeedSearches<R>(run: () => R): { result: R; calls: number } {
  return countingCalls(String.prototype, 'indexOf', (args) => args[0] === '\n', 1_000, run);
}

test("a miss's closest region is the line most like the first 2,000 code units of the old text's first line, its bigrams each counted as often as that line has them", () => {
  // Line 2 is the old text's first 2,000 code units; line 3 its next 3,000.
  const words = (from: number, count: number) => Array.from({ length: count }, (_, k) => `w${from + k}`).join(' ');
  const head = words(0, 500).slice(0, 2_000);
  const tail = words(5_000, 700).slice(0, 3_000);
  const region = (text: string, oldText: string) => {
    const found = problems(text, [spec(0, oldText, 'z')]);
    assert.equal(found[0]?.kind, 'miss');
    const line = /Closest region \(line (\d+), /.exec((found[0] as { hint: string }).hint);
    return line ? Number(line[1]) : undefined;
  };
  assert.equal(region(`intro\n${head}\n${tail}\n`, `${head}${tail}q`), 2);
  // "abab..." has the old text's "ab" five times, which counts once: line 2,
  // "abcx", shares two of "abcd"'s three bigrams and is closer.
  assert.equal(region('ababababab\nabcx\n', 'abcd'), 2);
});

test("a miss's closest region, among lines that score alike, is the first of them", () => {
  // Each line shares "ab" with the old text, for a score of 0.50; the first
  // such line is the one the hint names.
  const text = 'abc\n'.repeat(1_000);
  const [miss] = problems(text, [spec(0, 'abd', 'z')]);
  assert.ok(miss?.kind === 'miss' && miss.hint.startsWith('Closest region (line 1, similarity 0.50)'), JSON.stringify(miss));
});

test("a miss's closest region clears only the bigram slots each line used, in fewer than ten iterator steps a line", () => {
  // After each line, closestRegion clears only the slots that line used
  // (touched). Never cleared, touched grows by a slot a line, and the search
  // over 100,000 lines took 5.3 s of CPU rather than 33 ms, on Linux with
  // Node 24.22.1. The clearing is a for...of over touched, so the child
  // counts the steps of the array iterator over the search of 1,000 lines:
  // two a line, one for the line's slot and one to end the loop. Every array
  // loop in a process goes through the patched next while it's in place, and
  // V8 may keep a slower path after it's restored, so the count runs in a
  // child. Past ten steps a line, it throws.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const helperUrl = new URL('./helpers/count-calls.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    const { countingCalls } = await import(${JSON.stringify(helperUrl)});
    const bytes = Buffer.from('abc\\n'.repeat(1_000));
    const file = decodeForEdit(bytes);
    const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]());
    const { result, calls } = countingCalls(arrayIterator, 'next', () => true, 10_000,
      () => planFile(file, bytes, [{ index: 0, oldText: 'abd', newText: 'z', expected: 1 }]));
    console.log(JSON.stringify({ steps: calls, hint: result.problems[0].hint }));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || `stopped by ${child.signal}`);
  const { steps, hint } = JSON.parse(child.stdout) as { steps: number; hint: string };
  assert.ok(hint.startsWith('Closest region (line 1, similarity 0.50)'), hint);
  assert.ok(steps >= 1_000 && steps < 10_000, `${steps} steps of the array iterator`);
});

test("in a file with no CRLF line end, the size floor is exact for an old text with line feeds", () => {
  const bytes = Buffer.from('a\nb\n');
  assert.deepEqual(planFile(decodeForEdit(bytes)!, bytes, [spec(0, 'a\n', 'bbb\n')], hintBudget(), 5), { tooLarge: 6 });
});

test('a replaceAll that would grow its file past maxBytes is refused in a small heap', () => {
  // These 3,000,000 replacements of 200 characters would make a text of
  // 600,000,001; built, it ran a heap of 512 MiB out of memory. Refused from
  // its counts, it fits the 80 MiB the replaceAll of millions above needs.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--max-old-space-size=80', '--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    const bytes = Buffer.from('a'.repeat(3_000_000) + '\\n');
    console.log(JSON.stringify(planFile(decodeForEdit(bytes), bytes, [{ index: 0, oldText: 'a', newText: 'x'.repeat(200), expected: 'all' }], undefined, 5 * 1024 * 1024)));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || `stopped by ${child.signal}`);
  assert.deepEqual(JSON.parse(child.stdout), { tooLarge: 600_000_001 });
});

test("edits whose asks past what a refusal shows come to more than the text is long are named as crowded", () => {
  const text = `${'x'.repeat(100)}\n`;
  // Three edits that each find the 100 they ask for: 300 between them in a
  // text 101 UTF-16 code units long, its line ends read as LF, so some overlap.
  assert.deepEqual(problems(text, [spec(0, 'x', 'a', 100), spec(1, 'x', 'b', 100), spec(2, 'x', 'c', 100)]),
    [{ kind: 'crowded', edits: [0, 1, 2], asked: 300, length: 101 }]);
  // One that finds fewer than it asks for is named as it always is, and the
  // rest alone don't overflow the text, so nothing else is named.
  const [count] = problems(text, [spec(0, 'x', 'a', 100), spec(1, 'x', 'b', 150)]);
  assert.deepEqual(count, { ...count, kind: 'count', edit: 1, found: 100, expected: 150, overlapping: false });
  assert.equal(problems(text, [spec(0, 'x', 'a', 100), spec(1, 'x', 'b', 150)]).length, 1);
  // Where the rest still find more than the text is long, their overlap is
  // named beside the count.
  assert.deepEqual(problems(text, [spec(0, 'x', 'a', 100), spec(1, 'x', 'b', 100), spec(2, 'x', 'c', 150)]).map((problem) => problem.kind), ['count', 'crowded']);
  // Asks that fit past what a refusal shows are matched as before: a count
  // that differs is named, and two edits of one text clash.
  assert.deepEqual(problems(text, [spec(0, 'x', 'a', 100), spec(1, 'x', 'b', 21)]).map((problem) => problem.kind), ['count']);
  assert.deepEqual(problems('x x x\n', [spec(0, 'x', 'a', 3), spec(1, 'x', 'b', 3)]), [{ kind: 'clash', edits: [0, 1], line: 1, same: true }]);
  // And asks past it that fit apply in full: these keep every start, not the 20 a refusal shows.
  assert.equal(plan(`${'x'.repeat(100)}${'y'.repeat(100)}\n`, [spec(0, 'x', 'a', 100), spec(1, 'y', 'b', 100)]).bytes.toString(), `${'a'.repeat(100)}${'b'.repeat(100)}\n`);
});

test('edits asking for millions of occurrences each are refused in a small heap', () => {
  // Twelve edits each asking for all 1,000,000 kept 12,000,000 starts before
  // their clashes were found. Asking for more than the text holds, they keep
  // what a refusal shows.
  const moduleUrl = new URL('../src/modules/workspace/edit-plan.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', `
    const { decodeForEdit, planFile } = await import(${JSON.stringify(moduleUrl)});
    const bytes = Buffer.from('a'.repeat(1_000_000));
    const specs = Array.from({ length: 12 }, (_, index) => ({ index, oldText: 'a', newText: 'b', expected: 1_000_000 }));
    console.log(JSON.stringify(planFile(decodeForEdit(bytes), bytes, specs)));
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || `stopped by ${child.signal}`);
  assert.deepEqual(JSON.parse(child.stdout), { problems: [{ kind: 'crowded', edits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], asked: 12_000_000, length: 1_000_000 }] });
});

test('an occurrence is a position: overlapping occurrences count, and they can\'t each be replaced', () => {
  const [once] = problems('aaa\n', [spec(0, 'aa', 'b')]);
  assert.equal(once!.kind, 'count');
  assert.deepEqual(once, { ...once, found: 2, atLeast: false, expected: 1, overlapping: true, lines: [1, 1] });
  const [all] = problems('aaa\n', [spec(0, 'aa', 'b', 'all')]);
  assert.deepEqual(all, { ...all, kind: 'count', found: 2, atLeast: false, expected: 'all', overlapping: true });
  // Apart, every one is replaced when asked for.
  assert.equal(plan('aa-aa\n', [spec(0, 'aa', 'b', 2)]).bytes.toString(), 'b-b\n');
  assert.equal(plan('aa-aa\n', [spec(0, 'aa', 'b', 'all')]).bytes.toString(), 'b-b\n');
});

test('occurrences that overlap stop the count once a refusal has more than it shows, however long the run', () => {
  // Compared in full at every position, this is 1,000 times 200,000 comparisons.
  const [run] = problems(`${' '.repeat(200_000)}\n`, [spec(0, ' '.repeat(1000), 'x', 'all')]);
  assert.equal(run!.kind, 'count');
  if (run!.kind !== 'count') return;
  assert.deepEqual([run.found, run.atLeast, run.overlapping, run.lines.length], [21, true, true, 20]);
  // Exactly as many as a refusal shows are counted exactly.
  const [twenty] = problems(`${' '.repeat(119)}\n`, [spec(0, ' '.repeat(100), 'x', 'all')]);
  assert.deepEqual(twenty, { ...twenty, found: 20, atLeast: false, overlapping: true });
  // Apart, every occurrence is counted, however many.
  const [apart] = problems('ab '.repeat(30), [spec(0, 'ab', 'x')]);
  assert.deepEqual(apart, { ...apart, found: 30, atLeast: false, overlapping: false });
});

test('line numbers are found in one pass over the text, past its last line end too', () => {
  // A text that counts what each search for a line end reads: searching again
  // from each index would read the million code units after the last line
  // end once for each of the 20,000 indices.
  const text = `${'x'.repeat(20_000)}${'y'.repeat(1_000_000)}`;
  let read = 0;
  const counted = {
    indexOf: (search: string, from = 0) => {
      const at = text.indexOf(search, from);
      read += (at === -1 ? text.length : at + 1) - from;
      return at;
    },
  };
  const indices = Array.from({ length: 20_000 }, (_, i) => i);
  assert.deepEqual(lineNumbersAt(counted as unknown as string, indices), indices.map(() => 1));
  assert.ok(read <= text.length, `read ${read} code units of a ${text.length}-unit text`);
});

test('a match that starts on a line end is on the line that line end ends', () => {
  const [count] = problems('one\ntwo\none\ntwo\n', [spec(0, '\ntwo', 'X')]);
  assert.ok(count!.kind === 'count');
  assert.deepEqual(count.lines, [1, 3]);
});

test("a long matched line's excerpt keeps each surrogate pair whole at its cuts", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // Emoji on both sides of the match, starting at either parity, so that
  // some cut falls between a pair's halves.
  for (const lead of ['', 'x']) {
    for (const gap of ['', 'y']) {
      const long = `${lead}${'😀'.repeat(600)}${gap}target${'😀'.repeat(600)}`;
      const [count] = problems(`target\n${long}\n`, [spec(0, 'target', 'z')]);
      assert.ok(count!.kind === 'count');
      assert.doesNotMatch(count.shown, lone, `lead ${JSON.stringify(lead)}, gap ${JSON.stringify(gap)}`);
      assert.match(count.shown.split('\n')[1]!, /^     2\t….*target.*…$/su);
    }
  }
});

test('a count that differs names each matched line once, and a long line as an excerpt around its match', () => {
  const long = `${'x'.repeat(500)} target ${'y'.repeat(500)}`;
  const [count] = problems(`target\nnone\ntarget target\n${long}\n`, [spec(0, 'target', 'z')]);
  assert.equal(count!.kind, 'count');
  if (count!.kind !== 'count') return;
  assert.equal(count.found, 4);
  assert.deepEqual(count.lines, [1, 3, 3, 4]);
  const shown = count.shown.split('\n');
  assert.deepEqual(shown.slice(0, 2), ['     1\ttarget', '     3\ttarget target']);
  assert.match(shown[2]!, /^     4\t…x+ target y+…$/);
  assert.ok(shown[2]!.length < 260, 'an excerpt, not the whole line');
});

test("two edits' matches may touch but not overlap, and the same text twice is named as such", () => {
  assert.equal(plan('abcd\n', [spec(0, 'ab', 'AB'), spec(1, 'cd', 'CD')]).bytes.toString(), 'ABCD\n');
  const [overlap] = problems('abcd\n', [spec(0, 'abc', 'X'), spec(1, 'bcd', 'Y')]);
  assert.deepEqual(overlap, { kind: 'clash', edits: [0, 1], line: 1, same: false });
  const [same] = problems('abcd\n', [spec(1, 'bc', 'Y'), spec(0, 'bc', 'X')]);
  assert.deepEqual(same, { kind: 'clash', edits: [0, 1], line: 1, same: true });
  // Matches at one start are taken in the edits' order, whatever order the list gave them in.
  assert.deepEqual(problems('abc\n', [spec(2, 'ab', 'X'), spec(1, 'ab', 'Y'), spec(0, 'abc', 'Z')]).map((clash) => clash.kind === 'clash' && clash.edits), [[0, 1], [0, 2]]);
});

test('a thousand edits of one stretch are named as at most a thousand clashes', () => {
  const specs = Array.from({ length: 1000 }, (_, i) => spec(i, 'shared', `s${i}`));
  assert.equal(problems('shared\n', specs).length, 999);
});

test('many edits matching one text cost their replacements, not their pairs at every place', () => {
  // Every pair of these 2,000 edits overlaps at each of 500 places. Walking
  // the pairs at every place, the planner took 34 s on this case, on Linux
  // with Node 24.22.0. Each later replacement the walk meets is looked up in
  // a Set, whether its edit is named, and where it isn't, whether its pair is.
  // Linking past each named edit's replacements, the walk meets each later
  // replacement about once, about a million lookups in all; walking the pairs
  // at every place, it would make about a billion. Past ten times the
  // 1,000,000 replacements, the count throws; at least half of them shows the
  // count reaches the walk.
  const bytes = Buffer.from('x '.repeat(500));
  const specs = Array.from({ length: 2000 }, (_, index) => spec(index, 'x', 'y', 'all'));
  const file = decodeForEdit(bytes)!;
  const { result: planned, calls } = countingCalls(Set.prototype, 'has', () => true, 10_000_000, () => planFile(file, bytes, specs));
  assert.ok('problems' in planned);
  assert.ok(calls >= 500_000, `${calls} lookups`);
  // Each edit after the first is named once, with the first, as the same text.
  assert.deepEqual(planned.problems.map((problem) => problem.kind === 'clash' && [problem.kind, problem.edits, problem.same]),
    Array.from({ length: 1999 }, (_, k) => ['clash', [0, k + 1], true]));
});

test('each clash names its own line', () => {
  const text = 'one two\nthree four\nfive six\n';
  const clashes = problems(text, [spec(0, 'three four', 'X'), spec(1, 'four', 'Y'), spec(2, 'one two', 'Z'), spec(3, 'two', 'W')]);
  assert.deepEqual(clashes.map((clash) => clash.kind === 'clash' && [clash.edits, clash.line]), [[[2, 3], 1], [[0, 1], 2]]);
});

test('a miss shows the closest region, numbered, and says how to match', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of the file`).join('\n');
  const [miss] = problems(text, [spec(0, '  line 12 of the fyle', 'x')]);
  assert.equal(miss!.kind, 'miss');
  if (miss!.kind !== 'miss') return;
  assert.match(miss.hint, /^Closest region \(line 12, similarity 0\.\d\d\):\n     9\tline 9 of the file\n/);
  assert.match(miss.hint, /    15\tline 15 of the file$/);
  assert.equal(miss.crlf, false);
  // A first line of one character, such as a closing brace, has nothing to score; the next line does.
  const [brace] = problems(text, [spec(0, '}\nline 12 of the fyle', 'x')]);
  assert.match((brace as { hint: string }).hint, /^Closest region \(line 12, similarity 0\.\d\d\):/);
});

test("one call's misses search at most HINT_MAX_CHARS for closest regions, and a file over it gets none", () => {
  const half = `${'word '.repeat(HINT_MAX_CHARS / 10)}\n`.repeat(2).slice(0, HINT_MAX_CHARS / 2 + 1);
  const hints = hintBudget();
  const first = problems(half, [spec(0, 'absent', 'x')], hints);
  const second = problems(half, [spec(0, 'absent', 'x')], hints);
  assert.doesNotMatch((first[0] as { hint: string }).hint, /^\(No closest region/);
  assert.match((second[0] as { hint: string }).hint, /^\(No closest region: this call's other misses used its 2,097,152 UTF-16 code units of search/);
  const big = 'x'.repeat(HINT_MAX_CHARS + 1);
  assert.match((problems(big, [spec(0, 'absent', 'y')])[0] as { hint: string }).hint, /^\(No closest region for a file over 2,097,152 UTF-16 code units/);
});

test('an exact match is taken before straight and curly quotes are read as equal', () => {
  const planned = plan('it\'s here; it’s there\n', [spec(0, "it's", 'it is')]);
  assert.equal(planned.bytes.toString(), 'it is here; it’s there\n');
  assert.deepEqual(planned.quoteNormalized, []);
});

test('straight and curly quotes match as a second chance, and the plan names the edit', () => {
  const planned = plan('She said “hello” and it’s fine\n', [spec(0, 'said "hello" and it\'s', 'said "bye" and it is'), spec(1, 'fine', 'good')]);
  assert.equal(planned.bytes.toString(), 'She said "bye" and it is good\n');
  assert.deepEqual(planned.quoteNormalized, [0]);
});

test('CRLF text matches LF old text, and the new text takes the line ends of the text it replaces, a BOM kept', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bytes = Buffer.concat([bom, Buffer.from('one\r\ntwo\r\nthree\r\n')]);
  const planned = plan(bytes, [spec(0, 'one\ntwo', 'uno\ndos\ntres')]);
  assert.deepEqual(planned.bytes, Buffer.concat([bom, Buffer.from('uno\r\ndos\r\ntres\r\nthree\r\n')]));
  assert.deepEqual([planned.crlf, planned.mixed, planned.bom], [true, false, true]);
  assert.equal(planned.updated, 'uno\ndos\ntres\nthree\n', 'the receipt reads LF');
});

test('a mixed file keeps its mixture: each line end of a replaced span by position, any beyond them the last', () => {
  const bytes = Buffer.from('a\r\nb\nc\r\nd\n');
  assert.equal(plan(bytes, [spec(0, 'a\nb\nc', 'A\nB\nC\nD')]).bytes.toString(), 'A\r\nB\nC\nD\r\nd\n');
  const planned = plan(bytes, [spec(0, 'b', 'b1\nb2', 'all')]);
  assert.equal(planned.bytes.toString(), 'a\r\nb1\nb2\nc\r\nd\n', 'a span with no line end takes its own line\'s');
  assert.deepEqual([planned.crlf, planned.mixed], [true, true]);
});

test('each occurrence of a text that gains lines takes the line end of its own line', () => {
  assert.equal(plan('a\r\na\n', [spec(0, 'a', 'A\nB', 'all')]).bytes.toString(), 'A\r\nB\r\nA\nB\n');
});

test("a match at a CRLF's line end takes its CR along, and an unterminated last line takes the line end before it", () => {
  assert.equal(plan(Buffer.from('a\r\nb\r\n'), [spec(0, 'a\n', 'x\n')]).bytes.toString(), 'x\r\nb\r\n');
  assert.equal(plan(Buffer.from('a\r\nb'), [spec(0, 'b', 'b\nc')]).bytes.toString(), 'a\r\nb\r\nc');
  assert.equal(plan(Buffer.from('b'), [spec(0, 'b', 'b\nc')]).bytes.toString(), 'b\nc', 'a file with no CRLF takes the new text as given');
});

test("an old text carrying a line's CR at its end matches before a CRLF line end, and its new text's CR is read the same way", () => {
  const crlf = Buffer.from('alpha\r\nbeta\r\nalphabet\r\n');
  for (const newText of ['gamma\r', 'gamma']) {
    const planned = plan(crlf, [spec(0, 'alpha\r', newText)]);
    assert.equal(planned.bytes.toString(), 'gamma\r\nbeta\r\nalphabet\r\n', JSON.stringify(newText));
    assert.deepEqual(planned.readForm, [0]);
  }
  // Only before a CRLF line end: not inside a line, not before a bare LF.
  assert.equal(problems('alphabet\r\n', [spec(0, 'alpha\r', 'x')])[0]!.kind, 'miss');
  assert.equal(plan(Buffer.from('alpha\nalpha\r\n'), [spec(0, 'alpha\r', 'x')]).bytes.toString(), 'alpha\nx\r\n');
  assert.equal(problems('alpha\n', [spec(0, 'alpha\r', 'x')])[0]!.kind, 'miss', 'a file with no CRLF line end');
  // A lone CR the file holds is matched as given, first.
  const lone = plan(Buffer.from('alpha\rbeta\r\n'), [spec(0, 'alpha\r', 'x')]);
  assert.deepEqual([lone.bytes.toString(), lone.readForm], ['xbeta\r\n', []]);
  // The CR was all it changed, so there's nothing to change; one that doesn't match is a miss.
  assert.deepEqual(problems('alpha\r\nbeta\r\n', [spec(0, 'alpha\r', 'alpha')]), [{ kind: 'same', edit: 0 }]);
  assert.equal(problems('beta\r\n', [spec(0, 'alpha\r', 'alpha')])[0]!.kind, 'miss');
});

test('an old text read without its BOM or CR is found in one pass over a long run of the same', () => {
  // Only the text's start, or a place before a CRLF line end, takes such an
  // old text, so the places it passes over are most of the run. Searching
  // again from each with indexOf, the planner compared the old text in full
  // at every place: 3.3 s of CPU for the first of these and 5.3 s for the
  // second, on Linux with Node 24.22.0. In one pass, the read form is
  // searched for by its code units (charCodeAt), a few for each of the
  // text's, and never with indexOf; the old text as given is, once. Past a
  // few such searches, or ten code units read for each of the text's, the
  // counts throw.
  const run = 'a'.repeat(200_000);
  const needle = 'a'.repeat(50_000);
  for (const [text, oldText, newText, after] of [
    [`\uFEFF${run}`, `\uFEFF${needle}`, '\uFEFFb', `\uFEFFb${'a'.repeat(150_000)}`],
    [`${run}\r\n`, `${needle}\r`, 'b\r', `${'a'.repeat(150_000)}b\r\n`],
  ]) {
    const bytes = Buffer.from(text!);
    const file = decodeForEdit(bytes)!;
    let read = 0;
    const { result: planned, calls: searches } = countingCalls(String.prototype, 'indexOf', (args) => typeof args[0] === 'string' && args[0].length >= needle.length, 4, () => {
      const counted = countingCalls(String.prototype, 'charCodeAt', () => true, 10 * text!.length, () => planFile(file, bytes, [spec(0, oldText!, newText!)]));
      read = counted.calls;
      return counted.result;
    });
    assert.ok('plan' in planned, JSON.stringify(planned));
    assert.equal(planned.plan.bytes.toString(), after);
    assert.ok(searches <= 1, `${searches} searches for the old text with indexOf`);
    assert.ok(read >= text!.length, `${read} code units read`);
  }
});

test("each of 200 edits of an old text read more than one way counts its other reading only until a refusal has more than it shows", () => {
  // Lines alternate between "x" with a CR of its own and "x" alone, before
  // CRLF ends, so "x\r" reads as given on the one and without its CR on the
  // other, 400,000 times each. Each edit's other reading stops at 21, one
  // past the 20 a refusal shows.
  const bytes = Buffer.from('x\r\r\nx\r\n'.repeat(400_000));
  const planned = planFile(decodeForEdit(bytes)!, bytes, Array.from({ length: 200 }, (_, k) => spec(k, 'x\r', `${k}`)));
  assert.ok('problems' in planned);
  assert.deepEqual(planned.problems.map((p) => p.kind === 'readings' && p.readings.map((reading) => reading.leaves === 'cr' && [reading.found, reading.atLeast])),
    Array.from({ length: 200 }, () => [false, [21, true]]));
});

test("a read form's one pass finds a match inside one it passed over, and none that a mismatch ends", () => {
  // Each old text carries a line's CR, so it matches only before a CRLF line
  // end, and repeats part of itself.
  // "aa" at 0 isn't before the line end; the one at 1, inside it, is.
  assert.equal(plan('aaa\r\n', [spec(0, 'aa\r', 'b\r')]).bytes.toString(), 'ab\r\n');
  // Neither of these occurs before the line end: "bab" and "bba" do, which a
  // match that a mismatch didn't end would take for them.
  for (const [text, oldText] of [['aabab\r\n', 'aab\r'], ['abba\r\n', 'aba\r']]) {
    assert.deepEqual(problems(text!, [spec(0, oldText!, 'x\r')]).map((problem) => problem.kind), ['miss'], text);
  }
});

test('overlapping occurrences a read form finds stop the count once a refusal has more than it shows', () => {
  // "a\na" with a line's CR occurs before every line end but the first, each
  // occurrence overlapping the one before: 29 of them.
  const [run] = problems('a\r\n'.repeat(30), [spec(0, 'a\na\r', 'x\r', 'all')]);
  assert.equal(run!.kind, 'count');
  if (run!.kind !== 'count') return;
  assert.deepEqual([run.found, run.atLeast, run.overlapping, run.lines.length], [21, true, true, 20]);
});

test("an old text carrying the file's BOM at its start matches at the text's start, keeping one BOM", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const bytes = Buffer.concat([bom, Buffer.from('alpha\nbeta\n')]);
  for (const newText of ['\uFEFFgamma', 'gamma']) {
    const planned = plan(bytes, [spec(0, '\uFEFFalpha', newText)]);
    assert.deepEqual(planned.bytes, Buffer.concat([bom, Buffer.from('gamma\nbeta\n')]), JSON.stringify(newText));
    assert.deepEqual(planned.readForm, [0]);
  }
  // Only at the start, and only where the file has a BOM ('\uFEFF' encodes as one).
  assert.equal(problems('\uFEFFalpha\nbeta\n', [spec(0, '\uFEFFbeta', 'x')])[0]!.kind, 'miss', 'not at the start');
  assert.equal(problems('alpha\n', [spec(0, '\uFEFFalpha', 'x')])[0]!.kind, 'miss', 'a file with no BOM');
  // The BOM was all it changed, so there's nothing to change.
  assert.deepEqual(problems('\uFEFFalpha\n', [spec(0, '\uFEFFalpha', 'alpha')]), [{ kind: 'same', edit: 0 }]);
});

test("only the replaced text changes: a lone CR, and bytes the edits don't name, stay as they were", () => {
  const bytes = Buffer.from('keep\rthis\r\nchange me\r\n');
  assert.equal(plan(bytes, [spec(0, 'change', 'changed')]).bytes.toString(), 'keep\rthis\r\nchanged me\r\n');
});

test("a file that isn't valid UTF-8 isn't decoded, and the empty old text is found nowhere rather than looping", () => {
  assert.equal(decodeForEdit(Buffer.from([0x61, 0xe9, 0x62])), undefined);
  const [miss] = problems('abc\n', [spec(0, '', 'x')]);
  assert.equal(miss!.kind, 'miss');
});
