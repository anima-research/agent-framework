/**
 * A fixture's command file read as its poll reads it: a line counts once its
 * newline is written (test/fixtures/command-lines.mjs), and the test helper
 * that writes a line in two parts writes exactly that line.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writtenLines } from './fixtures/command-lines.mjs';
import { appendInTwoParts } from './helpers/command-file.js';

describe("a fixture's command lines", () => {
  const inDir = (body: (path: string) => void | Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), 'command-lines-'));
    try { await body(join(dir, 'commands.txt')); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('are none with no path, no file, or an empty one', inDir((path) => {
    assert.deepEqual(writtenLines(undefined), []);
    assert.deepEqual(writtenLines(path), []);
    writeFileSync(path, '');
    assert.deepEqual(writtenLines(path), []);
  }));

  it('leave out a line whose newline is not yet written, and count it once it is', inDir((path) => {
    writeFileSync(path, 'first');
    assert.deepEqual(writtenLines(path), []);
    appendFileSync(path, '\nsecond');
    assert.deepEqual(writtenLines(path), ['first']);
    appendFileSync(path, '\n');
    assert.deepEqual(writtenLines(path), ['first', 'second']);
  }));

  it('skip empty lines', inDir((path) => {
    writeFileSync(path, 'first\n\nsecond\n');
    assert.deepEqual(writtenLines(path), ['first', 'second']);
  }));

  it('come whole from a line written in two parts, though its cut splits a character', inDir(async (path) => {
    writeFileSync(path, '');
    // Seven bytes with its newline: the cut, after the third, falls inside the emoji's four.
    const line = 'x\u{1F600}y';
    const written = appendInTwoParts(path, line, 0);
    assert.deepEqual(writtenLines(path), [], 'the first part alone is no line');
    await written;
    assert.deepEqual(writtenLines(path), [line]);
  }));
});
