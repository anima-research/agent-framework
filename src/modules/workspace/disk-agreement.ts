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
 * P is evidence about one directory, so each mount also records the identity
 * (device and inode) of the root that evidence was gathered under. A root
 * that isn't that directory any more (an unmounted drive whose mountpoint is
 * now empty, a replaced directory) is an unavailable mount, never a disk on
 * which every file was deleted; only an explicit acceptance takes it, and
 * that starts its evidence afresh.
 *
 * Every transition is write-ahead (see reconcile.ts): an `intent` entry
 * (`pending`, with the prior value and the expected one) is durable before the
 * disk effect or tree adoption it announces, and the completion `set` is
 * appended only after that effect is durable. One tree adoption has no
 * intent: a drop, which removes the store's copy of a disk version the
 * workspace can't hold, forgets P first, so a crash before the removal leaves
 * P unknown, never a wrong adoption. A pending adoption resolves at its next
 * observation, by the tree. A pending disk effect resolves there only when
 * disk shows it didn't happen (the prior) or can't tell (`interrupted`, a
 * sticky conflict resolved explicitly, or by disk and the store coming to
 * agree); one that shows on disk is completed only by a push whose barriers
 * succeed, since its completion releases a draft's protection.
 */

import { resolve } from 'node:path';
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

/** Which directory a mount root is: its device and inode, as decimal strings. */
export interface RootIdentity {
  dev: string;
  ino: string;
}

/** Whether two configured roots name the same path, whatever their spelling
 *  (a trailing slash, a relative form). A symlinked alias is another path. */
function sameRootPath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export function sameRootIdentity(a: RootIdentity, b: RootIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

type JournalEntry =
  | { t: 'mount'; mount: string; root: string }
  /** The root's identity; with `reset`, an accepted new root, whose evidence starts empty. */
  | { t: 'root'; mount: string; identity: RootIdentity; reset?: true }
  | { t: 'set'; mount: string; path: string; value: Physical }
  | { t: 'forget'; mount: string; path: string }
  /**
   * Where a capped walk of `scope` stopped (the last entry it took), or null
   * once a walk covered the scope. It carries no `path` field: agent-framework
   * 0.22 replays an entry it doesn't know as a `forget` of `entry.path`, and
   * so leaves the evidence alone when there is none.
   */
  | { t: 'walk'; mount: string; scope: string; after: string | null };

interface MountEvidence {
  root: string;
  identity?: RootIdentity;
  paths: Map<string, Physical>;
  /** By scope ('' for the mount root): where the next walk of it resumes. */
  walks: Map<string, string>;
}

interface Snapshot {
  mounts: Record<string, {
    root: string;
    identity?: RootIdentity;
    paths: Record<string, Physical>;
    walks?: Record<string, string>;
  }>;
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
  private readonly mounts = new Map<string, MountEvidence>();
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

  /**
   * Re-read the journal when an earlier write left it unreconciled, and throw
   * once an append failed inside the store. P may then lack what that append
   * recorded (the store may hold it where this process can't read it back),
   * and a decision from stale P can record what reopening contradicts, such
   * as a conflict that stays after the right evidence is back. So until the
   * store is reopened, no evidence is read, written or checkpointed, and
   * every pass and tool call that needs it fails.
   */
  ensureReconciled(): void {
    if (this.journal.needsReopen) {
      throw new Error(
        'Disk-agreement evidence is unavailable until the store is reopened, as at the next start: ' +
        'an append to its journal failed inside the store, and the evidence may lack what it recorded',
      );
    }
    if (this.journal.needsReconcile) this.rebuild();
  }

  /** Whether evidence recorded so far still awaits a barrier. */
  get needsBarrier(): boolean {
    return this.unsynced;
  }

  /**
   * Replay the journal into memory. Records that read back are not proven
   * durable — a previous owner may have appended them and died before any
   * barrier — so evidence rebuilt here owes one, whether at open or after an
   * ambiguous append.
   */
  private rebuild(): void {
    this.unsynced = true;
    const { snapshot, entries } = this.journal.load();
    const replayed = new Map<string, MountEvidence>();
    for (const [name, mount] of Object.entries(snapshot?.mounts ?? {})) {
      replayed.set(name, {
        root: mount.root,
        ...(mount.identity ? { identity: mount.identity } : {}),
        paths: new Map(Object.entries(mount.paths)),
        walks: new Map(Object.entries(mount.walks ?? {})),
      });
    }
    for (const { entry } of entries) {
      if (entry.t === 'mount') {
        const existing = replayed.get(entry.mount);
        if (!existing || !sameRootPath(existing.root, entry.root)) {
          replayed.set(entry.mount, { root: entry.root, paths: new Map(), walks: new Map() });
        }
        continue;
      }
      const mount = replayed.get(entry.mount);
      if (mount) apply(mount, entry);
    }
    this.mounts.clear();
    for (const { name, root } of this.configured) {
      const found = replayed.get(name);
      if (found && sameRootPath(found.root, root)) {
        this.mounts.set(name, found);
      } else {
        this.mounts.set(name, { root, paths: new Map(), walks: new Map() });
        this.journal.append({ t: 'mount', mount: name, root });
      }
    }
  }

  /** The identity of the root this mount's evidence was gathered under, once any was. */
  rootIdentity(mount: string): RootIdentity | undefined {
    this.ensureReconciled();
    return this.mounts.get(mount)?.identity;
  }

  /**
   * Record the root's identity just before the first evidence a mount gains:
   * the caller saw it as the root while gathering that evidence. A no-op once
   * one is recorded; changing it is acceptRoot's alone.
   */
  recordRootIdentity(mount: string, identity: RootIdentity): void {
    if (this.rootIdentity(mount) !== undefined) return;
    this.write({ t: 'root', mount, identity }, {});
  }

  /**
   * Take the root as it is now, at the operator's word: record its identity
   * and forget every path's evidence, which described another directory.
   */
  acceptRoot(mount: string, identity: RootIdentity): void {
    this.write({ t: 'root', mount, identity, reset: true }, {});
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
   * Where the next walk of `scope` ('' for the mount root) resumes: the last
   * entry a walk of it took before its cap stopped it, if one did.
   */
  walkResumesAfter(mount: string, scope: string): string | undefined {
    this.ensureReconciled();
    return this.mounts.get(mount)?.walks.get(scope);
  }

  /**
   * Record where a walk of `scope` stopped (`after`), or that one covered it
   * (null). Kept with the evidence so a restart resumes there too. A place
   * that's lost costs coverage, never a decision: an append that didn't land
   * loses one, and a checkpoint written by a version that doesn't keep them
   * (0.22) loses them all, and each scope's walks start at its top again.
   */
  recordWalk(mount: string, scope: string, after: string | null): void {
    if ((this.walkResumesAfter(mount, scope) ?? null) === after) return;
    this.write({ t: 'walk', mount, scope, after }, {});
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

  /**
   * Put back exactly the evidence a path had before an intent whose effect
   * never touched it — whatever kind it was (agreed, pending, interrupted, or
   * unknown) — so the intent leaves no trace in what P says.
   */
  restore(mount: string, path: string, value: Physical | undefined): void {
    if (value === undefined) this.forget(mount, path);
    else this.write({ t: 'set', mount, path, value }, {});
  }

  private write(entry: JournalEntry, opts: { durable?: boolean; afterCommittedState?: boolean }): void {
    this.ensureReconciled();
    this.unsynced = true; // until proven durable: a failed append may still have landed
    this.journal.append(entry, opts);
    if (opts.durable) this.unsynced = false; // synced after this append, and so everything before it
    const mount = this.mounts.get((entry as { mount: string }).mount);
    if (mount) apply(mount, entry);
  }

  /** Checkpoint when the tail has outgrown the live evidence. */
  maybeCheckpoint(): void {
    // Like every entry point: an ambiguous write is read back first.
    this.ensureReconciled();
    let live = 0;
    for (const mount of this.mounts.values()) live += mount.paths.size;
    if (this.journal.entriesSinceCheckpoint < Math.max(MIN_CHECKPOINT_TAIL, live)) return;
    const snapshot: Snapshot = { mounts: {} };
    for (const [name, mount] of this.mounts) {
      snapshot.mounts[name] = {
        root: mount.root,
        ...(mount.identity ? { identity: mount.identity } : {}),
        paths: Object.fromEntries(mount.paths),
        ...(mount.walks.size > 0 ? { walks: Object.fromEntries(mount.walks) } : {}),
      };
    }
    this.journal.checkpoint(snapshot);
  }

  /** Make every append so far stable. Throws, and stays owed, if the sync fails. */
  barrier(): void {
    this.store.sync();
    this.unsynced = false;
  }
}

/** Apply one entry to a mount's evidence; one of a kind this version doesn't know changes nothing. */
function apply(mount: MountEvidence, entry: JournalEntry): void {
  if (entry.t === 'root') applyRoot(mount, entry);
  else if (entry.t === 'set') mount.paths.set(entry.path, entry.value);
  else if (entry.t === 'forget') mount.paths.delete(entry.path);
  else if (entry.t === 'walk') {
    if (entry.after === null) mount.walks.delete(entry.scope);
    else mount.walks.set(entry.scope, entry.after);
  }
}

function applyRoot(mount: MountEvidence, entry: Extract<JournalEntry, { t: 'root' }>): void {
  mount.identity = entry.identity;
  if (entry.reset) {
    // Evidence about another directory, and where its walks stopped, say
    // nothing about this one.
    mount.paths.clear();
    mount.walks.clear();
  }
}
