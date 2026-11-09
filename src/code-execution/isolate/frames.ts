/**
 * Length-prefixed frames between a script's parent and its child: four bytes
 * of big-endian length, then that many bytes of body. The parent writes to the
 * child's stdin and reads the child's fd 3.
 *
 * A body's first byte says what it holds:
 * - `JSON_KIND`: a message as UTF-8 JSON. Every frame from a child is one.
 * - `RESULT_KIND`: a call's result for the guest, from the parent: whether it
 *   resolves or rejects, the call's id, and the result's JSON as UTF-8 bytes,
 *   which the child hands the engine as they are, with no second parse and no
 *   string copy (the path the memory budget was measured on).
 *
 * The decoder is the only way bytes from a child become values in the parent,
 * so it bounds what a child can make the parent hold: a frame longer than its
 * limit, of a kind it doesn't take, not JSON, or holding more values than its
 * limit (counted before it's parsed), is a protocol error, and the parent ends
 * the script as crashed rather than reading on.
 */

/** The largest frame from a child: a call's arguments or a batch of output. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 4;
export const JSON_KIND = 0;
export const RESULT_KIND = 1;
/** A result body's own header: its kind, `ok`, and the call's id. */
const RESULT_HEADER_BYTES = 1 + 1 + 4;

/** A frame that breaks the protocol: too long, of a kind not taken, not UTF-8, not JSON, holding too many values, or cut off when its stream ended. */
export class FrameError extends Error {
  /** For a frame too long to encode: how long its body came to. */
  readonly bytes: number | undefined;

  constructor(message: string, bytes?: number) {
    super(message);
    this.name = 'FrameError';
    this.bytes = bytes;
  }
}

/**
 * The values in a JSON text, counted outside its strings: the top value, and
 * each value inside an object or array. Counting stops once past `stopAfter`.
 */
export function countJsonValues(text: string, stopAfter = Infinity): number {
  let values = 1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      // An object or array holds a first value unless it closes at once.
      let j = i + 1;
      while (j < text.length && (text.charCodeAt(j) === 0x20 || text.charCodeAt(j) === 0x0a || text.charCodeAt(j) === 0x0d || text.charCodeAt(j) === 0x09)) j++;
      const next = text.charCodeAt(j);
      if (next !== 0x7d && next !== 0x5d && ++values > stopAfter) return values;
    } else if (c === 0x2c) {
      if (++values > stopAfter) return values;
    }
  }
  return values;
}

/** A call's result as the child decodes it: the JSON's bytes, untouched. */
export interface ResultFrame {
  t: 'result';
  id: number;
  ok: boolean;
  json: Uint8Array;
}

function frame(body: Buffer, maxFrameBytes: number): Buffer {
  if (body.length > maxFrameBytes) {
    throw new FrameError(`a frame of ${body.length} bytes is longer than the ${maxFrameBytes} the protocol allows`, body.length);
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, HEADER_BYTES);
  return out;
}

/** One message as a JSON frame. One longer than `maxFrameBytes` throws a FrameError, and nothing is written. */
export function encodeFrame(message: unknown, maxFrameBytes: number = MAX_FRAME_BYTES): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) throw new FrameError('a frame must hold a JSON value');
  const body = Buffer.allocUnsafe(1 + Buffer.byteLength(json, 'utf8'));
  body[0] = JSON_KIND;
  body.write(json, 1, 'utf8');
  return frame(body, maxFrameBytes);
}

/**
 * A call's result as a result frame: the JSON's bytes follow a header of `ok`
 * and the id. Written straight into the frame, so a result's bytes are held
 * once, which the host's memory figure counts.
 */
export function encodeResultFrame(id: number, ok: boolean, json: string, maxFrameBytes: number): Buffer {
  const bodyLength = RESULT_HEADER_BYTES + Buffer.byteLength(json, 'utf8');
  if (bodyLength > maxFrameBytes) {
    throw new FrameError(`a frame of ${bodyLength} bytes is longer than the ${maxFrameBytes} the protocol allows`, bodyLength);
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + bodyLength);
  out.writeUInt32BE(bodyLength, 0);
  out[HEADER_BYTES] = RESULT_KIND;
  out[HEADER_BYTES + 1] = ok ? 1 : 0;
  out.writeUInt32BE(id >>> 0, HEADER_BYTES + 2);
  out.write(json, HEADER_BYTES + RESULT_HEADER_BYTES, 'utf8');
  return out;
}

/** How much a result frame's body holds beyond its JSON. */
export const RESULT_FRAME_OVERHEAD = RESULT_HEADER_BYTES;

/**
 * Bytes in, whole frames' values out. Holds at most one frame's bytes plus its
 * header: a header naming more than `maxFrameBytes` throws before any of that
 * frame's body is kept, and once a header names its body's length, the body
 * is one buffer of that length, which each chunk is copied into. So however
 * the bytes arrive, one at a time included, the decoder keeps no chunk of
 * them. Takes result frames only if asked to: a parent's decoder takes JSON
 * alone.
 */
export class FrameDecoder {
  private readonly header = Buffer.alloc(HEADER_BYTES);
  private headerFilled = 0;
  private body: Buffer | null = null;
  private bodyFilled = 0;
  private broken: FrameError | null = null;

  constructor(
    private readonly maxFrameBytes: number = MAX_FRAME_BYTES,
    private readonly takesResults = false,
    /** The most values a JSON frame may hold, counted before it's parsed. */
    private readonly maxValues = Infinity,
  ) {}

  /** The values of every frame `chunk` completes, in order. Throws the same FrameError from then on, once one frame was bad. */
  push(chunk: Buffer): unknown[] {
    if (this.broken) throw this.broken;
    const values: unknown[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.body === null) {
        const n = Math.min(HEADER_BYTES - this.headerFilled, chunk.length - at);
        chunk.copy(this.header, this.headerFilled, at, at + n);
        this.headerFilled += n;
        at += n;
        if (this.headerFilled < HEADER_BYTES) break;
        const length = this.header.readUInt32BE(0);
        if (length > this.maxFrameBytes) {
          return this.fail(`a frame announced ${length} bytes, more than the ${this.maxFrameBytes} the protocol allows`);
        }
        if (length === 0) return this.fail('a frame was empty');
        this.body = Buffer.allocUnsafe(length);
        this.bodyFilled = 0;
      }
      const n = Math.min(this.body.length - this.bodyFilled, chunk.length - at);
      chunk.copy(this.body, this.bodyFilled, at, at + n);
      this.bodyFilled += n;
      at += n;
      if (this.bodyFilled < this.body.length) break;
      const body = this.body;
      this.body = null;
      this.headerFilled = 0;
      values.push(this.decode(body));
    }
    return values;
  }

  /** At the stream's end: throws if a frame was begun and not finished. */
  end(): void {
    if (this.broken) throw this.broken;
    if (this.headerFilled > 0 || this.body !== null) {
      this.fail(`the stream ended inside a frame, with ${this.body === null ? this.headerFilled : this.bodyFilled} of its bytes read`);
    }
  }

  private decode(body: Buffer): unknown {
    if (body[0] === RESULT_KIND && this.takesResults) {
      if (body.length < RESULT_HEADER_BYTES) return this.fail('a result frame was shorter than its header');
      const result: ResultFrame = { t: 'result', id: body.readUInt32BE(2), ok: body[1] === 1, json: body.subarray(RESULT_HEADER_BYTES) };
      return result;
    }
    if (body[0] !== JSON_KIND) return this.fail(`a frame was of kind ${body[0]}, which this side doesn't take`);
    let text: string;
    try {
      // A byte-order mark is kept, so it fails JSON.parse as the text it is.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.subarray(1));
    } catch {
      return this.fail('a frame was not UTF-8');
    }
    if (countJsonValues(text, this.maxValues) > this.maxValues) return this.fail(`a frame held more than ${this.maxValues} values`);
    try {
      return JSON.parse(text);
    } catch {
      return this.fail('a frame was not JSON');
    }
  }

  private fail(message: string): never {
    this.broken = new FrameError(message);
    this.body = null;
    throw this.broken;
  }
}
