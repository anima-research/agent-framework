import type { CoalescingJournal, CoalescingRecord } from '../../src/mcpl/coalescing-journal.js';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryCoalescingJournal implements CoalescingJournal {
  readonly records: CoalescingRecord[];
  beforeAppend?: (record: CoalescingRecord) => void;
  afterAppend?: (record: CoalescingRecord) => void;
  constructor(records: CoalescingRecord[] = []) { this.records = copy(records); }
  length(): number { return this.records.length; }
  read(index: number): CoalescingRecord { return copy(this.records[index]); }
  append(record: CoalescingRecord): void {
    this.beforeAppend?.(record);
    this.records.push(copy(record));
    this.afterAppend?.(record);
  }
}
export function journalRecords(journal: CoalescingJournal): CoalescingRecord[] {
  return Array.from({length: journal.length()}, (_, index) => journal.read(index));
}
