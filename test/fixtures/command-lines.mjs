// The lines a test has finished writing to a fixture's command file. A poll
// can read a write half done, so a line counts only once its newline is
// written, and the part after the last newline is read again at the next
// poll.
import { existsSync, readFileSync } from 'node:fs';

export function writtenLines(path) {
  if (!path || !existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
}
