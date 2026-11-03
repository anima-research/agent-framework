/**
 * A script's output, bounded once, in the parent: every return, whether a
 * yield, a wait or the ending's, gives what the script wrote since the
 * previous one, its first and last characters within the bound and a count of
 * what was dropped between. A long stretch keeps its start, since that's
 * often where its trouble began, such as the first error before a cascade.
 *
 * The child can't know when the parent returns, since its frames reach it only
 * while its guest is idle, so the bound sits in the parent: the child holds
 * one bounded batch of what the guest writes and flushes it, and the parent
 * keeps the head and tail of each return's stretch, starting both afresh at
 * each return. Memory is bounded by construction on both sides; the price is
 * that a printing loop's whole output crosses the pipe, in batches.
 */

export interface OutputBounds {
  /** Characters kept from the start of each return's stretch. */
  headChars: number;
  /** Characters kept from its end. */
  tailChars: number;
}

export const DEFAULT_OUTPUT_BOUNDS: OutputBounds = { headChars: 8_000, tailChars: 8_000 };

/** The most one output frame carries, so a single large write is sent in pieces. */
export const MAX_BATCH_CHARS = 64 * 1024;

/** Where to cut `text` near `at` without parting a surrogate pair: one earlier if `at` falls inside one. */
function safeCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return Math.max(0, Math.min(at, text.length));
  const before = text.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at;
}

/** The child's side: what the guest wrote since the last flush, at most a batch of it at a time. */
export class OutputBatch {
  private pending: string[] = [];
  private size = 0;

  /** Characters waiting to be flushed. */
  get unflushed(): number {
    return this.size;
  }

  /** True once the batch is full, so the caller flushes now. */
  write(text: string): boolean {
    if (text.length === 0) return this.size >= MAX_BATCH_CHARS;
    this.pending.push(text);
    this.size += text.length;
    return this.size >= MAX_BATCH_CHARS;
  }

  /** The waiting text in pieces of at most a batch each, emptying it; empty when nothing waits. */
  flush(): string[] {
    if (this.size === 0) return [];
    let text = this.pending.join('');
    this.pending = [];
    this.size = 0;
    const pieces: string[] = [];
    while (text.length > MAX_BATCH_CHARS) {
      const cut = safeCut(text, MAX_BATCH_CHARS);
      pieces.push(text.slice(0, cut));
      text = text.slice(cut);
    }
    if (text.length > 0) pieces.push(text);
    return pieces;
  }
}

/** A return's stretch of output: its head and tail, and the count dropped between them. */
export interface OutputWindow {
  head: string;
  tail: string;
  dropped: number;
}

/** The line naming what was dropped, at its longest, as renderOutput puts it between the head and the tail. */
const DROPPED_LINE_CHARS = `\n[… ${Number.MAX_SAFE_INTEGER} characters of output dropped here …]\n`.length;

/**
 * The stretch as the model sees it: the head, a line naming what was dropped
 * if anything was, and the tail. Past `max`, its start and its end are cut
 * alike to fit it, each taking the room the other doesn't need, and the count
 * takes in what they gave up, so a return held to its agent's inline cap
 * still shows both ends. A `max` that leaves no room for that line gets the
 * line alone, which passes it.
 */
export function renderOutput(w: OutputWindow, max = Infinity): string {
  const whole = w.dropped === 0 ? w.head + w.tail : `${w.head}\n[… ${w.dropped} characters of output dropped here …]\n${w.tail}`;
  if (whole.length <= max) return whole;
  const room = Math.max(0, Math.floor(max) - DROPPED_LINE_CHARS);
  // With nothing dropped yet, the head and the tail are one stretch, whose end
  // lies in the head while the tail is short or empty: it's cut as one.
  const [first, last] = w.dropped === 0 ? [whole, whole] : [w.head, w.tail];
  const lastKeep = Math.min(last.length, Math.max(Math.floor(room / 2), room - first.length));
  const head = first.slice(0, safeCut(first, Math.min(first.length, room - lastKeep)));
  // Kept from the end, never starting on a pair's second half.
  let from = last.length - lastKeep;
  const at = last.charCodeAt(from);
  if (from > 0 && at >= 0xdc00 && at <= 0xdfff) from += 1;
  const tail = last.slice(from);
  const dropped = w.dropped === 0 ? whole.length - head.length - tail.length : w.dropped + (first.length - head.length) + from;
  return `${head}\n[… ${dropped} characters of output dropped here …]\n${tail}`;
}

/** The parent's side: the head and tail of what arrived since the last return, and the count dropped between. */
export class WindowOutput {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly bounds: OutputBounds) {}

  /** Add text the child flushed. */
  apply(text: string): void {
    let rest = text;
    if (this.tail.length === 0 && this.dropped === 0) {
      const room = this.bounds.headChars - this.head.length;
      if (room > 0) {
        const cut = safeCut(rest, room);
        this.head += rest.slice(0, cut);
        rest = rest.slice(cut);
        if (rest.length === 0) return;
      }
    }
    this.tail += rest;
    const over = this.tail.length - this.bounds.tailChars;
    if (over > 0) {
      // Drop from the front, never splitting a pair: the cut moves later by one if it would.
      let cut = over;
      const at = this.tail.charCodeAt(cut - 1);
      if (at >= 0xd800 && at <= 0xdbff) cut += 1;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  /** Characters dropped from the stretch so far. */
  get droppedChars(): number {
    return this.dropped;
  }

  /** The stretch as it stands. */
  window(): OutputWindow {
    return { head: this.head, tail: this.tail, dropped: this.dropped };
  }

  /** The stretch as the model sees it, whole (renderOutput). */
  render(): string {
    return renderOutput(this.window());
  }

  /** The stretch, and a fresh one from here. */
  take(): OutputWindow {
    const window = this.window();
    this.head = '';
    this.tail = '';
    this.dropped = 0;
    return window;
  }
}
