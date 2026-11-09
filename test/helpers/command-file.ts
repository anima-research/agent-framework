/**
 * A fixture's command file, written in two parts, as a poll that reads the
 * file whole can find one write half done. The fixture acts on the line only
 * once its newline is there (test/fixtures/command-lines.mjs).
 */
import { appendFileSync } from 'node:fs';

/** Appends `line` and its newline in two writes, `pauseMs` apart, cut
 *  halfway through its UTF-8 bytes, as a write read half done is cut, so a
 *  character can be split between them. Give a pause of a few of the
 *  fixture's poll intervals: a poll that runs in it reads the first part
 *  alone. Nothing checks that one ran, since a host that doesn't run the
 *  fixture then would fail the test for the wrong reason; command-lines'
 *  own test checks the rule without timing. */
export async function appendInTwoParts(path: string, line: string, pauseMs: number): Promise<void> {
  const bytes = Buffer.from(`${line}\n`, 'utf8');
  const cut = Math.floor((bytes.length - 1) / 2);
  appendFileSync(path, bytes.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  appendFileSync(path, bytes.subarray(cut));
}
