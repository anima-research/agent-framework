import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLines } from '../src/line-reader.js';

const noLineTooLong = () => assert.fail('no line here is past the bound');

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function linesOf(chunks: Array<string | Buffer>): Promise<{ lines: string[]; linesAtEnd: number | undefined }> {
  const input = new PassThrough();
  const lines: string[] = [];
  let linesAtEnd: number | undefined;
  const done = new Promise<void>((resolve) => readLines(input, { line: (line) => lines.push(line), end: () => { linesAtEnd = lines.length; resolve(); }, tooLong: noLineTooLong }));
  for (const chunk of chunks) {
    input.write(chunk);
    await tick();
  }
  input.end();
  await done;
  return { lines, linesAtEnd };
}

test('U+2028 and U+2029 inside a line stay in it', async () => {
  const line = '{"jsonrpc":"2.0","method":"x","params":{"text":"one\u2028two\u2029three"}}';
  assert.deepEqual((await linesOf([line + '\n'])).lines, [line]);
});

test('lines end at LF, CRLF and a bare CR, and an empty line arrives as one', async () => {
  assert.deepEqual((await linesOf(['a\nb\r\nc\rd\n\ne\n'])).lines, ['a', 'b', 'c', 'd', '', 'e']);
});

test('a CRLF split across two reads is one line end', async () => {
  assert.deepEqual((await linesOf(['a\r', '\nb\n'])).lines, ['a', 'b']);
});

test('a CR and its LF more than 100 ms apart are still one line end', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  readLines(input, { line: (line) => lines.push(line), tooLong: noLineTooLong });
  input.write('a\r');
  await new Promise((resolve) => setTimeout(resolve, 150));
  input.end('\nb\n');
  await tick();
  assert.deepEqual(lines, ['a', 'b']);
});

test('a bare CR at the end of a read ends its line at once, and the next read starts the next', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  readLines(input, { line: (line) => lines.push(line), tooLong: noLineTooLong });
  input.write('a\r');
  await tick();
  assert.deepEqual(lines, ['a']);
  input.write('b\n');
  await tick();
  assert.deepEqual(lines, ['a', 'b']);
});

test("a character whose bytes are split across two reads arrives whole", async () => {
  const bytes = Buffer.from('{"t":"x\u2028y é"}\n', 'utf8');
  const insideSeparator = bytes.indexOf(0xe2) + 1;
  const lines = (await linesOf([bytes.subarray(0, insideSeparator), bytes.subarray(insideSeparator)])).lines;
  assert.deepEqual(lines, ['{"t":"x\u2028y é"}']);
});

test('a last line with no line end arrives when the stream ends, before the end is reported', async () => {
  assert.deepEqual(await linesOf(['a\nlast']), { lines: ['a', 'last'], linesAtEnd: 2 });
});

test('a stream that ends right after a bare CR gives that line once, then the end', async () => {
  assert.deepEqual(await linesOf(['a\r']), { lines: ['a'], linesAtEnd: 1 });
});

test('an empty stream gives no line, then the end', async () => {
  assert.deepEqual(await linesOf([]), { lines: [], linesAtEnd: 0 });
});

test('after stop, no further line arrives', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  const stop = readLines(input, { line: (line) => lines.push(line), tooLong: noLineTooLong });
  input.write('a\n');
  await tick();
  stop();
  input.write('b\n');
  input.end();
  await tick();
  assert.deepEqual(lines, ['a']);
});

test('a stop from inside a line handler delivers none of the lines left in that read, nor the end', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  let ended = false;
  const stop: () => void = readLines(input, {
    line: (line) => {
      lines.push(line);
      if (line === 'a') stop();
    },
    end: () => { ended = true; },
    tooLong: noLineTooLong,
  });
  input.end('a\nb\nlast');
  await tick();
  await tick();
  assert.deepEqual({ lines, ended }, { lines: ['a'], ended: false });
});

function boundedReader(maxChars?: number) {
  const input = new PassThrough();
  const lines: string[] = [];
  const tooLong: number[] = [];
  let linesAtEnd: number | undefined;
  readLines(input, { line: (line) => lines.push(line), end: () => { linesAtEnd = lines.length; }, tooLong: (bound) => tooLong.push(bound) }, maxChars);
  const seen = () => ({ lines, tooLong, linesAtEnd });
  const write = async (chunk: string | Buffer) => { input.write(chunk); await tick(); };
  const end = async () => { input.end(); await tick(); await tick(); };
  return { write, end, seen };
}

test('a line as long as the bound arrives whole, its line end not counted', async () => {
  const reader = boundedReader(4);
  await reader.write('abcd\nwxyz\r\nmnop\r');
  await reader.end();
  assert.deepEqual(reader.seen(), { lines: ['abcd', 'wxyz', 'mnop'], tooLong: [], linesAtEnd: 3 });
});

test('a last line as long as the bound, with no line end, arrives when the stream ends, before the end is reported', async () => {
  const reader = boundedReader(4);
  await reader.write('abcd');
  await reader.end();
  assert.deepEqual(reader.seen(), { lines: ['abcd'], tooLong: [], linesAtEnd: 1 });
});

test('the bound counts UTF-16 code units: two characters outside the BMP fill a bound of four, and one more unit is refused', async () => {
  const fits = boundedReader(4);
  await fits.write('\u{1F600}\u{1F600}\n');
  await fits.end();
  assert.deepEqual(fits.seen(), { lines: ['\u{1F600}\u{1F600}'], tooLong: [], linesAtEnd: 1 });

  const over = boundedReader(4);
  await over.write('\u{1F600}\u{1F600}a\n');
  assert.deepEqual(over.seen(), { lines: [], tooLong: [4], linesAtEnd: undefined });
});

test('a line one past the bound is refused once: none of it arrives, nor any later line, nor the end', async () => {
  const reader = boundedReader(4);
  await reader.write('ab\nabcde\nok\n');
  await reader.end();
  assert.deepEqual(reader.seen(), { lines: ['ab'], tooLong: [4], linesAtEnd: undefined });
});

test('a line is refused as soon as a read takes it past the bound, before any line end arrives', async () => {
  const reader = boundedReader(4);
  await reader.write('abc');
  assert.deepEqual(reader.seen(), { lines: [], tooLong: [], linesAtEnd: undefined });
  await reader.write('de');
  assert.deepEqual(reader.seen(), { lines: [], tooLong: [4], linesAtEnd: undefined });
  await reader.write('\nok\n');
  assert.deepEqual(reader.seen(), { lines: [], tooLong: [4], linesAtEnd: undefined });
});

test('the bound counts a line across reads, and a line that reaches it across reads arrives whole', async () => {
  const fits = boundedReader(4);
  for (const chunk of ['a', 'bc', 'd', '\n']) await fits.write(chunk);
  await fits.end();
  assert.deepEqual(fits.seen(), { lines: ['abcd'], tooLong: [], linesAtEnd: 1 });

  const over = boundedReader(4);
  for (const chunk of ['a', 'bc', 'd', 'e']) await over.write(chunk);
  assert.deepEqual(over.seen(), { lines: [], tooLong: [4], linesAtEnd: undefined });
});

test("a last line with no line end that the stream's end takes past the bound is refused, and the end isn't reported", async () => {
  const reader = boundedReader(4);
  await reader.write(Buffer.concat([Buffer.from('abcd'), Buffer.from('é', 'utf8').subarray(0, 1)]));
  assert.deepEqual(reader.seen(), { lines: [], tooLong: [], linesAtEnd: undefined });
  await reader.end();
  assert.deepEqual(reader.seen(), { lines: [], tooLong: [4], linesAtEnd: undefined });
});
