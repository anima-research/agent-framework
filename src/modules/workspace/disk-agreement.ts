/**
 * Physical disk-agreement evidence (P): for each mount and path, what disk held
 * when it last agreed with the workspace store, or what the module last wrote
 * there or adopted from it.
 *
 * P describes disk, and disk does not rewind with a branch switch, so P lives
 * in global chronicle records (RecordJournal) rather than branch state: after
 * an undo selects an older tree, P still says what disk holds, and a
 * difference reads as a store-side change, never as a disk edit. Branch-local
 * intent — tombstones, store origin, conflicts — lives in BranchIntents and
 * rewinds with the tree.
 *
 * Every transition is write-ahead (see Reconciler): an `intent` entry
 * (`pending`, with the prior value and the expected one) is durable before the
 * disk effect or tree adoption it announces, and the completion `set` is
 * appended only after that effect is durable. A pending path resolves at its
 * next observation; one whose disk copy matches neither candidate becomes
 * `interrupted`, a sticky state resolved only explicitly.
 */

import type { JsStore } from '@animalabs/chronicle';
import { RecordJournal } from '../../record-journal.js';

/** Everything `stat` says about a file that can vouch for unchanged bytes. */
export interface Fingerprint {
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
  dev: string;
  /** When the bytes were hashed (ms). Timestamps within 2 s of it can't vouch. */
  hashedAt: number;
}

export type Agreed =
  | { kind: 'absent' }
  | { kind: 'content'; hash: string; size: number; fp?: Fingerprint };

export type Candidate = { kind: 'absent' } | { kind: 'content'; hash: string };

export interface Pending {
  kind: 'pending';
  /** What the module is about to do: change disk, or adopt disk into the tree. */
  effect: 'disk' | 'adopt';
  /** P before the intent (null: unknown). */
  prior: Agreed | null;
  expect: Candidate;
  /** Branch the intent was recorded on (an adoption's meaning is branch-relative). */
  branchId: string;
}

export interface Interrupted {
  kind: 'interrupted';
  /** The values disk could have held after the interrupted effect. */
  candidates: Candidate[];
}

export type Physical = Agreed | Pending | Interrupted;

type JournalEntry =
  | { t: 'mount'; mount: string; root: string }
  | { t: 'set'; mount: string; path: string; value: Physical }
  | { t: 'forget'; mount: string; path: string };

interface Snapshot {
  mounts: Record<string, { root: string; paths: Record<string, Physical> }>;
}

export const DISK_AGREEMENT_RECORD_TYPE = 'workspace/disk-agreement';

/** Checkpoint once the tail outgrows this many entries, or the live paths, whichever is larger. */
const MIN_CHECKPOINT_TAIL = 1000;

export function candidateOf(value: Agreed): Candidate {
  return value.kind === 'absent' ? { kind: 'absent' } : { kind: 'content', hash: value.hash };
}

export function sameCandidate(a: Candidate, b: Candidate): boolean {
  return a.kind === b.kind && (a.kind === 'absent' || a.hash === (b as { hash: string }).hash);
}

export class DiskAgreement {
  private readonly store: JsStore;
  private readonly journal: RecordJournal<JournalEntry, Snapshot>;
  private readonly mounts = new Map<string, { root: string; paths: Map<string, Physical> }>();
  private configured: Array<{ name: string; root: string }> = [];
  /**
   * An append (or a rebuild) not yet made durable. Cleared only by a
   * barrier that succeeds, so a failed barrier stays owed: a later pass with
   * nothing new to record still settles it before deciding anything.
   */
  private unsynced = false;

  constructor(store: JsStore) {
    this.store = store;
    this.journal = new RecordJournal<JournalEntry, Snapshot>(store, { type: DISK_AGREEMENT_RECORD_TYPE });
  }

  /**
   * Rebuild P from the journal for the configured mounts. A mount whose
   * recorded root differs from its configured one starts empty: evidence
   * about another directory says nothing about this one.
   */
  open(mounts: Array<{ name: string; root: string }>): void {
    this.configured = mounts;
    this.rebuild();
  }

  /** Re-read the journal when an earlier write left it unreconciled. */
  ensureReconciled(): void {
    if (this.journal.needsReconcile) {
      this.rebuild();
      this.unsynced = true; // what was read back may not all be durable
    }
  }

  /** Whether evidence recorded so far still awaits a barrier. */
  get needsBarrier(): boolean {
    return this.unsynced;
  }

  private rebuild(): void {
    const { snapshot, entries } = this.journal.load();
    const replayed = new Map<string, { root: string; paths: Map<string, Physical> }>();
    for (const [name, mount] of Object.entries(snapshot?.mounts ?? {})) {
      replayed.set(name, { root: mount.root, paths: new Map(Object.entries(mount.paths)) });
    }
    for (const { entry } of entries) {
      if (entry.t === 'mount') {
        const existing = replayed.get(entry.mount);
        if (!existing || existing.root !== entry.root) replayed.set(entry.mount, { root: entry.root, paths: new Map() });
        continue;
      }
      const mount = replayed.get(entry.mount);
      if (!mount) continue;
      if (entry.t === 'set') mount.paths.set(entry.path, entry.value);
      else mount.paths.delete(entry.path);
    }
    this.mounts.clear();
    for (const { name, root } of this.configured) {
      const found = replayed.get(name);
      if (found && found.root === root) {
        this.mounts.set(name, found);
      } else {
        this.mounts.set(name, { root, paths: new Map() });
        this.journal.append({ t: 'mount', mount: name, root });
        this.unsynced = true;
      }
    }
  }

  get(mount: string, path: string): Physical | undefined {
    this.ensureReconciled(); // an ambiguous append may have landed: read it back first
    return this.mounts.get(mount)?.paths.get(path);
  }

  /** Every path with evidence under a prefix ('' for the whole mount). */
  paths(mount: string, prefix = ''): Array<[string, Physical]> {
    this.ensureReconciled();
    const paths = this.mounts.get(mount)?.paths;
    if (!paths) return [];
    const out: Array<[string, Physical]> = [];
    for (const [path, value] of paths) {
      if (prefix === '' || path === prefix || path.startsWith(prefix + '/')) out.push([path, value]);
    }
    return out;
  }

  /**
   * Record an intent. `durable` makes it (and every append before it) stable
   * before the caller performs the effect; batches pass it on their last one.
   */
  intend(mount: string, path: string, intent: Omit<Pending, 'kind'>, opts: { durable?: boolean } = {}): void {
    this.write({ t: 'set', mount, path, value: { kind: 'pending', ...intent } }, { durable: opts.durable });
  }

  /**
   * Record agreed evidence. `afterCommittedState` when it asserts a tree
   * commit made just before (the commit is synced first).
   */
  set(mount: string, path: string, value: Agreed | Interrupted, opts: { afterCommittedState?: boolean } = {}): void {
    this.write({ t: 'set', mount, path, value }, { afterCommittedState: opts.afterCommittedState });
  }

  /** Forget a path: P becomes unknown, the most conservative evidence. */
  forget(mount: string, path: string): void {
    if (this.get(mount, path) === undefined) return;
    this.write({ t: 'forget', mount, path }, {});
  }

  private write(entry: JournalEntry, opts: { durable?: boolean; afterCommittedState?: boolean }): void {
    this.ensureReconciled();
    this.unsynced = true; // until proven durable: a failed append may still have landed
    this.journal.append(entry, opts);
    if (opts.durable) this.unsynced = false; // synced after this append, and so everything before it
    const mount = this.mounts.get((entry as { mount: string }).mount);
    if (!mount) return;
    if (entry.t === 'set') mount.paths.set(entry.path, entry.value);
    else if (entry.t === 'forget') mount.paths.delete(entry.path);
  }

  /** Checkpoint when the tail has outgrown the live evidence. */
  maybeCheckpoint(): void {
    let live = 0;
    for (const mount of this.mounts.values()) live += mount.paths.size;
    if (this.journal.entriesSinceCheckpoint < Math.max(MIN_CHECKPOINT_TAIL, live)) return;
    const snapshot: Snapshot = { mounts: {} };
    for (const [name, mount] of this.mounts) {
      snapshot.mounts[name] = { root: mount.root, paths: Object.fromEntries(mount.paths) };
    }
    this.journal.checkpoint(snapshot);
  }

  /** Make every append so far stable. Throws, and stays owed, if the sync fails. */
  barrier(): void {
    this.store.sync();
    this.unsynced = false;
  }
}
