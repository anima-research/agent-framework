import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLines } from '../src/line-reader.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function linesOf(chunks: Array<string | Buffer>): Promise<{ lines: string[]; linesAtEnd: number | undefined }> {
  const input = new PassThrough();
  const lines: string[] = [];
  let linesAtEnd: number | undefined;
  const done = new Promise<void>((resolve) => readLines(input, (line) => lines.push(line), () => { linesAtEnd = lines.length; resolve(); }));
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
  readLines(input, (line) => lines.push(line));
  input.write('a\r');
  await new Promise((resolve) => setTimeout(resolve, 150));
  input.end('\nb\n');
  await tick();
  assert.deepEqual(lines, ['a', 'b']);
});

test('a bare CR at the end of a read ends its line at once, and the next read starts the next', async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  readLines(input, (line) => lines.push(line));
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
  const stop = readLines(input, (line) => lines.push(line));
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
  const stop: () => void = readLines(input, (line) => {
    lines.push(line);
    if (line === 'a') stop();
  }, () => { ended = true; });
  input.end('a\nb\nlast');
  await tick();
  await tick();
  assert.deepEqual({ lines, ended }, { lines: ['a'], ended: false });
});
