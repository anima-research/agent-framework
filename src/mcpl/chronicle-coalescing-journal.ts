import { createHash, randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { CoalescingJournal, CoalescingRecord, LegacyCoalescingImport } from './coalescing-journal.js';
import type { PushEventResult } from './types.js';

export const COALESCING_JOURNAL_ID = 'mcpl/coalescing-journal';
const LEGACY_PENDING = 'mcpl/coalescing-pending';
const LEGACY_RECEIPTS = 'mcpl/coalescing-receipts';
const LEGACY_AUDIT = 'mcpl/coalescing-audit';

/** One append-only Chronicle state owns coalescing. No pending snapshot or receipt
 * table is written. Chronicle's own append-log snapshots are storage checkpoints,
 * not a second coalescing authority. Reads replay immutable operations by position. */
export class ChronicleCoalescingJournal implements CoalescingJournal {
  constructor(private readonly store: JsStore, private readonly branch = store.currentBranch().name) {
    const states = new Set(store.listStates().map(s => s.id));
    if (!states.has(COALESCING_JOURNAL_ID)) store.registerState({ id: COALESCING_JOURNAL_ID, strategy: 'append_log' });
    if (this.length() === 0) this.importLegacy(states);
  }
  private assertBranch(): void {
    if (this.store.currentBranch().name !== this.branch) throw new Error('Coalescing journal belongs to a different branch');
  }
  length(): number {
    this.assertBranch();
    return this.store.getStateLen(COALESCING_JOURNAL_ID) ?? 0;
  }
  read(index: number): CoalescingRecord {
    this.assertBranch();
    const record = this.store.getStateItemJson(COALESCING_JOURNAL_ID, index);
    if (!record || record.version !== 1 || !record.operation) throw new Error(`Invalid coalescing journal entry ${index}`);
    return record as CoalescingRecord;
  }
  append(record: CoalescingRecord): void {
    this.assertBranch();
    this.store.appendToStateJson(COALESCING_JOURNAL_ID, record);
    this.store.sync(); // acknowledge/effect only after the operation is durable
  }

  private importLegacy(states: Set<string>): void {
    const snapshot = states.has(LEGACY_PENDING) ? this.store.getStateJson(LEGACY_PENDING) : null;
    const receipts = new Map<string, PushEventResult>();
    if (states.has(LEGACY_RECEIPTS)) {
      for (const entry of this.store.treeList(LEGACY_RECEIPTS)) {
        const bytes = this.store.getBlob(entry.blobHash);
        if (!bytes) throw new Error('Missing legacy coalescing receipt blob');
        receipts.set(entry.path, JSON.parse(bytes.toString()));
      }
    }
    if (snapshot?.receipt) {
      receipts.set(createHash('sha256').update(snapshot.receipt[0]).digest('hex'), snapshot.receipt[1]);
    }
    const hadAudit = states.has(LEGACY_AUDIT) && (this.store.getStateLen(LEGACY_AUDIT) ?? 0) > 0;
    if (!snapshot?.pending?.length && !snapshot?.history?.length && !receipts.size && !hadAudit) return;
    if (snapshot && snapshot.version !== 1 && snapshot.version !== 2) throw new Error('Unsupported legacy coalescing state');
    const initial: LegacyCoalescingImport = {
      pending: snapshot?.pending ?? [], history: snapshot?.history ?? [],
      receipts: [...receipts].map(([key, result]) => ({ key, result })),
    };
    this.append({ version: 1, id: randomUUID(), at: Date.now(), operation: { kind: 'legacy-import', initial } });
    // The old stores remain untouched for inspection. Once the import is appended,
    // neither their continued presence nor their contents affect replay.
  }
}
