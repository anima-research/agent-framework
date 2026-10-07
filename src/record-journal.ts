/**
 * An append-only journal of typed Chronicle records that does not follow
 * branch switches.
 *
 * Chronicle's branch state — snapshot, tree and log states — rewinds with a
 * historical rollback (createBranchAt + switchBranch). Typed records do not:
 * `getRecordIdsByType` enumerates them from every branch, in global order, and
 * they survive `deleteBranch`, reopen and a hard kill. A journal is for state
 * that must not rewind with the conversation but should live and die with its
 * store: what a workspace's disk last agreed with, what reached a recipient,
 * what became of a suppressed draft.
 *
 * Durability. A record append reaches the OS before `append` returns, so it
 * survives a killed process, while branch-state commits are buffered until
 * `store.sync()`: a record appended after a state commit can outlive that
 * commit. Two barriers, each named where it's needed and neither implied by
 * the `{id, sequence}` an append returns:
 *  - `afterCommittedState: true` syncs BEFORE appending — for an entry that
 *    asserts state committed just before it, so the entry can never survive
 *    without that state;
 *  - `durable: true` syncs AFTER appending — for an entry that must be on
 *    stable storage before the caller acts on it (an attempt before its
 *    outbound request, an intent before its disk effect).
 *
 * Checkpoints bound the replay at open: `checkpoint(snapshot)` records the
 * caller's reduced state together with the last entry it covers, and `load()`
 * returns the latest checkpoint's snapshot plus only the entries appended
 * after it. A journal that never checkpoints replays everything. What entries
 * mean, how they reduce, and when to checkpoint stay with the caller.
 *
 * One writer per record type: a checkpoint covers every entry up to the last
 * one THIS journal loaded or appended, so entries another instance appended
 * to the same type in between would be covered without being reduced.
 */

import type { JsStore } from '@animalabs/chronicle';

/** Where an appended record landed. Not a durability receipt — see the barriers. */
export interface JournalRecordRef {
  /** Chronicle record id: global, increasing in append order. */
  id: string;
  /** The record's sequence on the branch current when it was appended. */
  sequence: number;
}

export interface JournalEntry<Entry> extends JournalRecordRef {
  entry: Entry;
}

export interface JournalLoad<Entry, Snapshot> {
  /** The latest checkpoint's snapshot, or null when none was written. */
  snapshot: Snapshot | null;
  /** Every entry appended after that checkpoint, in append order. */
  entries: Array<JournalEntry<Entry>>;
}

export interface AppendOptions {
  /** `store.sync()` before appending: the entry asserts state committed just before it. */
  afterCommittedState?: boolean;
  /** `store.sync()` after appending: the entry must be on stable storage before the caller acts. */
  durable?: boolean;
}

interface CheckpointPayload<Snapshot> {
  /** Id of the last entry the snapshot covers ("0" when it covers none). */
  through: string;
  snapshot: Snapshot;
}

/** Record ids are decimal strings from one store-wide counter. */
function idValue(id: string): bigint {
  if (!/^\d+$/.test(id)) throw new Error(`RecordJournal: unexpected chronicle record id "${id}"`);
  return BigInt(id);
}

function decode<T>(store: JsStore, id: string): { value: T; sequence: number } {
  const record = store.getRecord(id);
  if (!record) throw new Error(`RecordJournal: record ${id} is listed but cannot be read`);
  return { value: JSON.parse(Buffer.from(record.payload).toString('utf-8')) as T, sequence: record.sequence };
}

export class RecordJournal<Entry, Snapshot = never> {
  private readonly store: JsStore;
  /** Record type of the entries. */
  readonly type: string;
  /** Record type of the checkpoints. */
  readonly checkpointType: string;
  /** Highest entry id this journal has loaded or appended (0 when none). */
  private lastEntryId = 0n;
  private sinceCheckpoint = 0;

  constructor(store: JsStore, opts: { type: string; checkpointType?: string }) {
    if (!opts.type) throw new Error('RecordJournal: a record type is required');
    this.store = store;
    this.type = opts.type;
    this.checkpointType = opts.checkpointType ?? `${opts.type}/checkpoint`;
    if (this.checkpointType === this.type) {
      throw new Error('RecordJournal: entries and checkpoints need distinct record types');
    }
  }

  /** Entries appended since the last checkpoint (or since load, when there was none). */
  get entriesSinceCheckpoint(): number {
    return this.sinceCheckpoint;
  }

  /**
   * The latest checkpoint and every entry after it, whichever branch each was
   * appended on. Also positions the journal, so later checkpoints cover what
   * was loaded.
   */
  load(): JournalLoad<Entry, Snapshot> {
    let snapshot: Snapshot | null = null;
    let through = 0n;
    let latestCheckpoint: bigint | null = null;
    let latestCheckpointId: string | null = null;
    for (const id of this.store.getRecordIdsByType(this.checkpointType)) {
      const value = idValue(id);
      if (latestCheckpoint === null || value > latestCheckpoint) {
        latestCheckpoint = value;
        latestCheckpointId = id;
      }
    }
    if (latestCheckpointId !== null) {
      const payload = decode<CheckpointPayload<Snapshot>>(this.store, latestCheckpointId).value;
      snapshot = payload.snapshot;
      through = idValue(payload.through);
    }

    const tail = this.store.getRecordIdsByType(this.type)
      .map((id) => ({ id, value: idValue(id) }))
      .filter(({ value }) => value > through)
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const entries = tail.map(({ id }) => {
      const { value, sequence } = decode<Entry>(this.store, id);
      return { id, sequence, entry: value };
    });

    this.lastEntryId = tail.length > 0 ? tail[tail.length - 1]!.value : through;
    this.sinceCheckpoint = entries.length;
    return { snapshot, entries };
  }

  /** Append one entry. The returned ref says where it landed, not that it's durable. */
  append(entry: Entry, opts: AppendOptions = {}): JournalRecordRef {
    if (opts.afterCommittedState) this.store.sync();
    const record = this.store.appendJson(this.type, entry);
    if (opts.durable) this.store.sync();
    const value = idValue(record.id);
    if (value > this.lastEntryId) this.lastEntryId = value;
    this.sinceCheckpoint++;
    return { id: record.id, sequence: record.sequence };
  }

  /**
   * Record the caller's reduced state as covering every entry this journal has
   * loaded or appended. Like an entry, it's durable only with `durable`.
   */
  checkpoint(snapshot: Snapshot, opts: { durable?: boolean } = {}): JournalRecordRef {
    const payload: CheckpointPayload<Snapshot> = { through: this.lastEntryId.toString(), snapshot };
    const record = this.store.appendJson(this.checkpointType, payload);
    if (opts.durable) this.store.sync();
    this.sinceCheckpoint = 0;
    return { id: record.id, sequence: record.sequence };
  }
}
