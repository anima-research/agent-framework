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
 * manager was in presented mode. A mark taken in legacy mode covers by
 * sequence, whatever the manager's mode is when it is read, since the window
 * it stood for was the record up to its head; so a mark taken before a
 * write-down still reads right after it, and nothing has to be converted.
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
 * in legacy mode). Read only through this module.
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
  'currentBranch' | 'getStore' | 'getAllMessages' | 'getMessageCount' | 'windowMode' | 'indexLength' | 'ordinalOf'>>;

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
    if (typeof cm.currentBranch !== 'function' || typeof cm.getAllMessages !== 'function') return null;
    const store = typeof cm.getStore === 'function' ? cm.getStore() as { currentSequence?: () => number } : undefined;
    let head = typeof store?.currentSequence === 'function' ? store.currentSequence() : undefined;
    if (head === undefined) {
      const count = typeof cm.getMessageCount === 'function' ? cm.getMessageCount() : cm.getAllMessages().length;
      head = count > 0 ? cm.getAllMessages().at(-1)?.sequence ?? 0 : 0;
    }
    const presented = typeof cm.windowMode === 'function' && cm.windowMode() === 'presented'
      && typeof cm.indexLength === 'function';
    return mark(cm.currentBranch().name, head, presented ? cm.indexLength!() : null);
  } catch {
    return null;
  }
}

/**
 * A test of many rows against one mark, read against `reader` (the manager
 * whose window the mark is of), which reads the reader's branch and mode
 * once. The rules:
 *
 * - no mark: doubt;
 * - a mark on another branch than the reader's: doubt, except that a mark
 *   taken in legacy mode, read `across` a branch point (`partAt`, the last
 *   sequence the two branches share), covers a row at or below both its head
 *   and the branch point, and no other;
 * - a mark taken in legacy mode: a row at or below its head is covered,
 *   whatever the reader's mode is now;
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
    const through = Math.min(head, across.partAt);
    return (row) => (row.sequence <= through ? 'covered' : 'not-covered');
  }
  if (length === null) return (row) => (row.sequence <= head ? 'covered' : 'not-covered');
  if (!presented || typeof reader.ordinalOf !== 'function') return () => 'doubt';
  const ordinalOf = reader.ordinalOf.bind(reader);
  return (row) => {
    const ordinal = ordinalOf(row.id);
    return ordinal !== undefined && ordinal < length ? 'covered' : 'not-covered';
  };
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
