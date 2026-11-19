import type { JsStore } from '@animalabs/chronicle';
import type { CoalescingChange, CoalescingSnapshot } from './push-coalescer.js';

export const COALESCING_TABLE_ID = 'mcpl/coalescing';
export const COALESCING_JOURNAL_ID = 'mcpl/coalescing-journal';
export const COALESCING_RECENT_ID = 'mcpl/coalescing-recent';

// chronicle has no setting that turns an append log's own snapshots off, so
// its cadence is set past any length the journal reaches between two writes
// of the table, which empty it.
export const COALESCING_JOURNAL_REGISTRATION = {
  id: COALESCING_JOURNAL_ID,
  strategy: 'append_log',
  deltaSnapshotEvery: Number.MAX_SAFE_INTEGER,
  fullSnapshotEvery: Number.MAX_SAFE_INTEGER,
};

export type StoredCoalescingTable = CoalescingSnapshot & { journal?: number };
export type CoalescingJournalItem = CoalescingChange & { seq: number };

export interface StoredCoalescing {
  table: StoredCoalescingTable | null;
  journal: unknown;
  recent: unknown;
}

export function isJournalItem(item: unknown): item is CoalescingJournalItem {
  if (typeof item !== 'object' || item === null) return false;
  const { subject, seq, record, receipt } = item as Record<string, unknown>;
  if (typeof subject !== 'string' || !Number.isSafeInteger(seq)) return false;
  if (record !== null && (typeof record !== 'object' || (record as { subject?: unknown }).subject !== subject)) return false;
  if (receipt === undefined) return true;
  return Array.isArray(receipt) && receipt.length === 2 && typeof receipt[0] === 'string'
    && typeof receipt[1] === 'object' && receipt[1] !== null && typeof (receipt[1] as { at?: unknown }).at === 'number';
}

export function journaledTable(table: StoredCoalescingTable | null, journal: readonly CoalescingJournalItem[]): CoalescingSnapshot | null {
  const after = typeof table?.journal === 'number' ? journal.filter((item) => item.seq > table.journal!) : [];
  if (!table || after.length === 0) return table;
  const subjects = new Map(table.subjects.map((record) => [record.subject, record]));
  const receipts = new Map(table.receipts);
  for (const change of after) {
    subjects.delete(change.subject);
    if (change.record) subjects.set(change.subject, change.record);
    if (change.receipt) receipts.set(change.receipt[0], change.receipt[1]);
  }
  return { version: 1, receipts: [...receipts], subjects: [...subjects.values()] };
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export class CoalescingStore {
  private seq = 0;
  private marked = false;
  private tableHeld = false;
  private journalHeld = false;
  private recentHeld = false;
  private tableBytes = 0;
  private journalBytes = 0;
  private owed = false;
  private stopped = false;

  constructor(
    private readonly store: Pick<JsStore, 'setStateJson' | 'appendToStateJson'>,
    stored: StoredCoalescing,
    private readonly compactionFailed: (error: unknown) => void,
  ) {
    this.load(stored);
  }

  private load({ table, journal, recent }: StoredCoalescing): void {
    const number = typeof table?.journal === 'number' ? table.journal : undefined;
    const items = number !== undefined && Array.isArray(journal) ? journal.filter(isJournalItem) : [];
    this.marked = number !== undefined;
    this.tableHeld = table !== null && table !== undefined;
    this.seq = items.reduce((most, item) => Math.max(most, item.seq), Math.max(this.seq, number ?? 0));
    this.journalHeld = journal !== null && journal !== undefined && !(Array.isArray(journal) && journal.length === 0);
    this.recentHeld = recent !== null && recent !== undefined && !(Array.isArray(recent) && recent.length === 0);
    this.tableBytes = number === undefined ? 0 : bytesOf(table);
    this.journalBytes = items.reduce((sum, item) => sum + (item.seq > number! ? bytesOf(item) : 0), 0);
  }

  branchMoved(destination: StoredCoalescing): void {
    this.load(destination);
    this.owed = true;
  }

  stopping(): void {
    this.stopped = true;
  }

  get current(): boolean {
    return (this.marked || !this.tableHeld) && !this.owed && !this.journalHeld && !this.recentHeld;
  }

  write(changes: readonly CoalescingChange[], table: () => CoalescingSnapshot): void {
    if (this.owed || !this.marked || this.stopped) {
      try {
        this.writeTable(table());
      } catch (error) {
        this.owed = true;
        throw error;
      }
      return;
    }
    try {
      for (const change of changes) {
        const item: CoalescingJournalItem = { ...change, seq: ++this.seq };
        this.journalHeld = true;
        this.store.appendToStateJson(COALESCING_JOURNAL_ID, item);
        this.journalBytes += bytesOf(item);
      }
    } catch (error) {
      this.owed = true;
      throw error;
    }
    if (this.journalBytes < this.tableBytes) return;
    try {
      this.writeTable(table());
    } catch (error) {
      this.compactionFailed(error);
    }
  }

  writeTable(snapshot: CoalescingSnapshot): void {
    if (!this.marked && this.journalHeld) this.emptyJournal();
    const table: StoredCoalescingTable = { ...snapshot, journal: this.seq };
    this.store.setStateJson(COALESCING_TABLE_ID, table);
    this.marked = true;
    this.owed = false;
    this.tableBytes = bytesOf(table);
    this.journalBytes = 0;
    if (this.journalHeld) this.emptyJournal();
    if (this.recentHeld) {
      this.store.setStateJson(COALESCING_RECENT_ID, []);
      this.recentHeld = false;
    }
  }

  private emptyJournal(): void {
    this.store.setStateJson(COALESCING_JOURNAL_ID, []);
    this.journalHeld = false;
  }
}
