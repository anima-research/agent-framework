/**
 * Read marks (src/read-marks.ts, #291) as a test reads them: a mark is
 * opaque, so a test that needs where one was taken reads the store head
 * from its description (describeReadMark), and one that asks of a row a
 * legacy-mode mark covers builds the row from its sequence, as a cover
 * reads it.
 */
import { describeReadMark, readMarkForTest, type MarkedRow, type ReadMark } from '../../src/read-marks.js';

/** The store head `mark` was taken at (`main@412` or `main@412#57` gives 412). */
export function headOf(mark: ReadMark | null): number {
  const head = /@(-?\d+)/.exec(describeReadMark(mark))?.[1];
  if (head === undefined) throw new Error(`no head in ${describeReadMark(mark)}`);
  return Number(head);
}

/** A row stored at `sequence`, as a mark taken in legacy mode covers it: by its own sequence. */
export function rowAt(sequence: number, id = `row@${sequence}`): MarkedRow {
  return { id, sequence };
}

/** A mark taken in legacy mode on `mark`'s branch, `by` past its head (`-1`: just before it). */
export function legacyMarkFrom(mark: ReadMark, by: number): ReadMark {
  return readMarkForTest(mark.branch, headOf(mark) + by, null);
}
