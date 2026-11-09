import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const LF = 0x0a;
const CR = 0x0d;

export const MAX_LINE_CHARS = 100 * 1024 * 1024;

export interface LineHandlers {
  line: (line: string) => void;
  end?: () => void;
  tooLong: (maxChars: number) => void;
}

export function readLines(input: Readable, on: LineHandlers, maxChars = MAX_LINE_CHARS): () => void {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let lineEndedAtCr = false;
  let stopped = false;

  const refuse = () => {
    stop();
    partial = '';
    on.tooLong(maxChars);
  };

  const take = (text: string) => {
    let from = 0;
    if (lineEndedAtCr && text.length > 0) {
      lineEndedAtCr = false;
      if (text.charCodeAt(0) === LF) from = 1;
    }
    for (let i = from; i < text.length && !stopped; i++) {
      const code = text.charCodeAt(i);
      if (code !== LF && code !== CR) continue;
      if (partial.length + (i - from) > maxChars) return refuse();
      const line = partial + text.slice(from, i);
      partial = '';
      if (code === CR) {
        if (i + 1 === text.length) lineEndedAtCr = true;
        else if (text.charCodeAt(i + 1) === LF) i++;
      }
      from = i + 1;
      on.line(line);
    }
    if (stopped) return;
    if (partial.length + (text.length - from) > maxChars) return refuse();
    partial += text.slice(from);
  };

  const onData = (chunk: Buffer | string) => take(decoder.write(chunk));
  const onStreamEnd = () => {
    take(decoder.end());
    if (!stopped && partial.length > 0) {
      const last = partial;
      partial = '';
      on.line(last);
    }
    if (stopped) return;
    stop();
    on.end?.();
  };
  const stop = () => {
    stopped = true;
    input.off('data', onData);
    input.off('end', onStreamEnd);
  };
  input.on('data', onData);
  input.on('end', onStreamEnd);
  return stop;
}

export function escapeLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
