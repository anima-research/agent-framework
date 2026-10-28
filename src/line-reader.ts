import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const LF = 0x0a;
const CR = 0x0d;

export function readLines(input: Readable, onLine: (line: string) => void, onEnd?: () => void): () => void {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let lineEndedAtCr = false;
  let stopped = false;

  const take = (text: string) => {
    let from = 0;
    if (lineEndedAtCr && text.length > 0) {
      lineEndedAtCr = false;
      if (text.charCodeAt(0) === LF) from = 1;
    }
    for (let i = from; i < text.length && !stopped; i++) {
      const code = text.charCodeAt(i);
      if (code !== LF && code !== CR) continue;
      const line = partial + text.slice(from, i);
      partial = '';
      if (code === CR) {
        if (i + 1 === text.length) lineEndedAtCr = true;
        else if (text.charCodeAt(i + 1) === LF) i++;
      }
      from = i + 1;
      onLine(line);
    }
    if (!stopped) partial += text.slice(from);
  };

  const onData = (chunk: Buffer | string) => take(decoder.write(chunk));
  const onStreamEnd = () => {
    take(decoder.end());
    if (!stopped && partial.length > 0) {
      const last = partial;
      partial = '';
      onLine(last);
    }
    if (stopped) return;
    stop();
    onEnd?.();
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
