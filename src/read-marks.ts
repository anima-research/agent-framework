/**
 * Read marks (#291): how far an agent had read, or been shown, or answered,
 * when something happened, and whether a stored row falls within it.
 *
 * Every such question used to compare a row's own store sequence with the
 * chronicle head taken at the moment (`{ branch, sequence }`). While the
 * window an agent reads is the record itself (context-manager's legacy
 * mode) that is exact: a compile reads every row stored so far. Once the
 * agent's window follows its presentation index (`presentRows`), a row is
 * stored first and presented later, so a row stored before the head was
 * taken can still be out of the window then, and the head says nothing of
 * what the agent read. The window's own coordinate is the index ordinal: a
 * row is in the window as of a mark when its ordinal is below the index
 * length taken with the mark (`indexLength()` is exclusive: the ordinal the
 * next row will take).
 *
 * A mark keeps both: the head, as before, and the index length when the
 * manager was in presented mode. A mark taken in legacy mode stands for a
 * window that was the record up to its head. Read against a manager still
 * in legacy mode, it covers by sequence. Read once the branch's window is
 * written down (presented mode), it covers the rows the window has held,
 * where they stand now, since its head or before: the rows a branch cut at
 * the head would keep in its window (ContextManager.branchSequenceOf at or
 * below the head). That sequence is a row's own for a row the write-down put
 * in the window, and the write that presented it for any other, so it only
 * grows along the window: the rows a cut at the head keeps are the window's
 * first ones, and the mark reads as one taken in presented mode whose length
 * is the ordinal of the first row past them (windowLengthAt). For a mark taken
 * before the write-down, which lists the record in record order, those are
 * the rows the write-down put in the window at or below the head that are
 * still where it put them. A row stored after the head isn't covered, and
 * neither is a row taken out of the window since, or one presented again,
 * at a new ordinal past the write-down, which a compare by sequence would
 * cover: a reader walking the window back from its newest row (the turn's
 * inputs, turnInputs) would stop at that older row and leave the rows the
 * agent hadn't read before it out. Nothing is converted in place: every
 * reader reads a mark through coverTest, which makes the same reading for
 * each.
 *
 * The mark is opaque: its fields are keyed by symbols this module keeps, so
 * a `mark.sequence` read, a hand-built `{ branch, sequence }`, or a compare
 * of an ordinal with a sequence doesn't compile. Every compare goes through
 * `covers` (or `coverTest` for many rows) and `markAtOrAfter`. The keys are
 * symbols rather than `#private` fields so two marks taken at the same
 * place are deep-equal.
 */
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';

declare const ordinalBrand: unique symbol;
/** A row's index ordinal in one agent's window on one branch (ContextManager.ordinalOf). Never a store sequence. */
export type WindowOrdinal = number & { readonly [ordinalBrand]: true };

declare const lengthBrand: unique symbol;
/** An index length (ContextManager.indexLength): exclusive, the ordinal the next presented row will take. */
export type WindowLength = number & { readonly [lengthBrand]: true };

declare const headBrand: unique symbol;
/** The store's head sequence (currentSequence) when a mark was taken. */
export type StoreHead = number & { readonly [headBrand]: true };

const HEAD: unique symbol = Symbol('read-mark head');
const LENGTH: unique symbol = Symbol('read-mark length');

/**
 * Where an agent had read to on one branch: the store's head then, and the
 * window's index length when the agent's manager was in presented mode (null
 * in legacy mode). Read only through this module (coverTest): a mark taken in
 * legacy mode covers by sequence while its window is the record, and, once
 * the window is written down, as a mark taken in presented mode that covers
 * the rows the window held by its head where they still stand.
 */
export interface ReadMark {
  readonly branch: string;
  readonly [HEAD]: StoreHead;
  readonly [LENGTH]: WindowLength | null;
}

/**
 * Whether a mark covers a row: `'covered'` and `'not-covered'` are answers;
 * `'doubt'` is a mark that can't say (none, one on another branch, or one
 * taken in presented mode read against a manager that no longer presents),
 * which each reader maps to the choice it makes when it doesn't know.
 */
export type Cover = 'covered' | 'not-covered' | 'doubt';

/** What a mark is taken from and read against: a context manager, or a double of one. */
export type MarkCm = Partial<Pick<ContextManager,
  'currentBranch' | 'getStore' | 'getAllMessages' | 'getMessageCount' | 'windowMode' | 'indexLength' | 'ordinalOf'
  | 'getPresentedMessages' | 'branchSequenceOf'>>;

/** A row as a cover reads it. */
export type MarkedRow = Pick<StoredMessage, 'id' | 'sequence'>;

function mark(branch: string, head: number, length: number | null): ReadMark {
  return Object.freeze({ branch, [HEAD]: head as StoreHead, [LENGTH]: length as WindowLength | null });
}

/**
 * A mark of where `cm` stands now: its branch, the store's head (the
 * chronicle head, not the slot's last row: a compile reads everything stored
 * on the branch, rows merged in from another slot included; a double without
 * a store gives its last row's sequence), and its index length when it is in
 * presented mode. Null for a double that can't say, or when reading throws.
 */
export function readMarkOf(cm: MarkCm): ReadMark | null {
  try {
    const head = storeHeadOf(cm);
    if (head === null) return null;
    const presented = typeof cm.windowMode === 'function' && cm.windowMode() === 'presented'
      && typeof cm.indexLength === 'function';
    return mark(cm.currentBranch!().name, head, presented ? cm.indexLength!() : null);
  } catch {
    return null;
  }
}

/**
 * The store's head as `cm` reads it now, the head a mark readMarkOf takes
 * keeps: the chronicle head, not the slot's last message, since a compile
 * reads everything stored on the branch so far, rows merged in from another
 * slot included. A record sequence, on the branch `cm` is on: for a reader
 * that compares stored rows' sequences with it on that branch (Agent's
 * branchHead), not a cover of the window. Null for a context double that
 * can't say.
 */
export function storeHeadOf(cm: MarkCm): number | null {
  try {
    if (typeof cm.currentBranch !== 'function' || typeof cm.getAllMessages !== 'function') return null;
    const store = typeof cm.getStore === 'function' ? cm.getStore() as { currentSequence?: () => number } : undefined;
    let head = typeof store?.currentSequence === 'function' ? store.currentSequence() : undefined;
    if (head === undefined) {
      const count = typeof cm.getMessageCount === 'function' ? cm.getMessageCount() : cm.getAllMessages().length;
      head = count > 0 ? cm.getAllMessages().at(-1)?.sequence ?? 0 : 0;
    }
    return head;
  } catch {
    return null;
  }
}

/**
 * A mark of where `cm` stands now, as readMarkOf takes one, that covers its
 * window only below `length` (an index length of that window, at most its
 * own): for a redo on the window (AgentFramework.redo), which puts back,
 * at new ordinals and in their order, rows a mark covered before they were
 * undone and rows it didn't, so the mark it gives again covers the first
 * and not the rest. Null where readMarkOf gives null, and in legacy mode,
 * where a mark has no length.
 */
export function readMarkThrough(cm: MarkCm, length: number): ReadMark | null {
  const now = readMarkOf(cm);
  if (!now || now[LENGTH] === null) return null;
  return mark(now.branch, now[HEAD], Math.min(length, now[LENGTH]));
}

/**
 * Whether a mark was taken in presented mode: it keeps the window's index
 * length, and covers rows by their ordinals there, so a row taken out of the
 * window and presented again, at a new ordinal past its length, leaves it.
 * A mark taken in legacy mode keeps none: it covers by sequence while its
 * window is the record, and, once the window is written down, by ordinal
 * too, below the first row the window didn't hold by its head (coverTest),
 * so a row presented again after it leaves it in the same way.
 */
export function coversByOrdinal(mark: ReadMark | null): boolean {
  return !!mark && mark[LENGTH] !== null;
}

/**
 * A test of many rows against one mark, read against `reader` (the manager
 * whose window the mark is of), which reads the reader's branch and mode
 * once. The rules:
 *
 * - no mark: doubt;
 * - a mark on another branch than the reader's: doubt, except that a mark
 *   taken in legacy mode, read `across` a branch point (`partAt`, the last
 *   sequence the two branches share), reads as one on the reader's branch
 *   (below) through the lower of its head and the branch point;
 * - a mark taken in legacy mode, read against a reader in legacy mode: a
 *   row at or below its head is covered;
 * - a mark taken in legacy mode, read against a reader in presented mode:
 *   a row the window has held where it stands since the head or before is
 *   covered (windowLengthAt: the window's rows below the ordinal of its first
 *   row a branch cut at the head wouldn't keep), and no other: not a row
 *   stored after the head, out of the window, or presented after the head,
 *   again or for the first time. A reader that can't say where its window
 *   held a row (a double without ordinalOf, getPresentedMessages,
 *   branchSequenceOf or indexLength) is read by sequence, as in legacy
 *   mode; a read of the window that throws is doubt for the rows at or
 *   below the head;
 * - a mark taken in presented mode, read against a reader no longer in it:
 *   doubt;
 * - else a row is covered when its ordinal is below the mark's length:
 *   strictly, since the length is the ordinal the next row would take. A row
 *   out of the window (never presented, or taken out) is not covered.
 */
export function coverTest(mark: ReadMark | null, reader: MarkCm, across?: { partAt: number }): (row: MarkedRow) => Cover {
  if (!mark) return () => 'doubt';
  let branch: string | undefined;
  let presented = false;
  try {
    branch = typeof reader.currentBranch === 'function' ? reader.currentBranch().name : undefined;
    presented = typeof reader.windowMode === 'function' && reader.windowMode() === 'presented';
  } catch {
    return () => 'doubt';
  }
  const head = mark[HEAD];
  const length = mark[LENGTH];
  if (branch !== mark.branch) {
    if (!across || length !== null) return () => 'doubt';
    return legacyCover(reader, presented, Math.min(head, across.partAt));
  }
  if (length === null) return legacyCover(reader, presented, head);
  if (!presented || typeof reader.ordinalOf !== 'function') return () => 'doubt';
  return byOrdinal(reader.ordinalOf.bind(reader), length);
}

function byOrdinal(ordinalOf: (id: MarkedRow['id']) => number | undefined, length: number): (row: MarkedRow) => Cover {
  return (row) => {
    const ordinal = ordinalOf(row.id);
    return ordinal !== undefined && ordinal < length ? 'covered' : 'not-covered';
  };
}

/**
 * How a mark taken in legacy mode covers through `through` (its head, or the
 * lower of its head and a branch point): by sequence against a reader in
 * legacy mode, or one that can't say where its window held a row; against
 * one in presented mode, by ordinal below windowLengthAt(reader, through),
 * read once, at the first row that needs it. A row stored after `through`
 * entered the window after it, wherever it stands, so it is not covered
 * without that read.
 */
function legacyCover(reader: MarkCm, presented: boolean, through: number): (row: MarkedRow) => Cover {
  const bySequence = (row: MarkedRow): Cover => (row.sequence <= through ? 'covered' : 'not-covered');
  if (!presented || typeof reader.ordinalOf !== 'function' || typeof reader.getPresentedMessages !== 'function'
    || typeof reader.branchSequenceOf !== 'function' || typeof reader.indexLength !== 'function') {
    return bySequence;
  }
  let cover: ((row: MarkedRow) => Cover) | undefined;
  return (row) => {
    if (row.sequence > through) return 'not-covered';
    if (!cover) {
      const length = windowLengthAt(reader, through);
      cover = length === null ? () => 'doubt' : byOrdinal(reader.ordinalOf!.bind(reader), length);
    }
    return cover(row);
  };
}

/**
 * The index length a mark taken in presented mode would hold to cover the
 * rows `reader`'s window (in presented mode) has held, where they stand
 * now, since sequence `through` or before: the ordinal of the window's first
 * row that a branch cut at `through` wouldn't keep in its window, or the
 * index length when such a cut keeps them all. A cut keeps a row when its
 * branchSequenceOf (the sequence a cut has to reach for its window to hold
 * the row) is at or below `through`: a row's own sequence (its body's last
 * shard's) for a row the write-down put in the window, which lists the
 * record in record order, and the write that presented it for any other,
 * which comes after the write-down and after every write that presented a
 * row before it. So that sequence only grows along the window, and the
 * first row past `through` is found by a binary search over it: a few reads
 * per mark, whatever the window's length. Null when a read throws.
 */
function windowLengthAt(reader: MarkCm, through: number): number | null {
  try {
    const window = reader.getPresentedMessages!();
    let low = 0;
    let high = window.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (reader.branchSequenceOf!(window[middle]!.id) <= through) low = middle + 1;
      else high = middle;
    }
    if (low === window.length) return reader.indexLength!();
    return reader.ordinalOf!(window[low]!.id) ?? null;
  } catch {
    return null;
  }
}

/** Whether `mark` covers `row` in `reader`'s window (see coverTest for the rules). */
export function covers(mark: ReadMark | null, reader: MarkCm, row: MarkedRow, across?: { partAt: number }): Cover {
  return coverTest(mark, reader, across)(row);
}

/**
 * Whether mark `a` was taken at or after mark `b`: on one branch, by the
 * store's head, which only grows there; `'other-branch'` when they are on two.
 */
export function markAtOrAfter(a: ReadMark, b: ReadMark): boolean | 'other-branch' {
  if (a.branch !== b.branch) return 'other-branch';
  return a[HEAD] >= b[HEAD];
}

/** A mark for a log line or a test's message: `main@412` in legacy mode, `main@412#57` with its index length. */
export function describeReadMark(mark: ReadMark | null): string {
  if (!mark) return 'no mark';
  return `${mark.branch}@${mark[HEAD]}${mark[LENGTH] === null ? '' : `#${mark[LENGTH]}`}`;
}

/**
 * A mark built from its parts, for a test that needs one taken at a given
 * place. Production code takes marks with readMarkOf.
 *
 * @internal
 */
export function readMarkForTest(branch: string, head: number, length: number | null): ReadMark {
  return mark(branch, head, length);
}
