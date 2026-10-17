/**
 * The three-way rule over disk (D), the workspace store (S) and physical
 * evidence (P), with branch-local intent (tombstones, store origin, sticky
 * conflicts). Under it a scan or read never discards a pending store edit,
 * and a branch switch is never mistaken for a disk edit:
 *
 *  - D = S: agreement; P := D.
 *  - P known: D = P keeps the store side (a draft, a workspace deletion, or a
 *    file this branch doesn't have); S = P adopts disk (ingest, or remove S,
 *    or — for a binary/oversize disk version — drop S so the path reads
 *    disk-only); all three differing is a conflict.
 *  - P unknown: a tombstone, then store origin, then legacy entries decide;
 *    otherwise a new disk file is ingested or listed disk-only.
 *  - P pending (an intent whose effect may or may not have landed) resolves
 *    first; P interrupted is a sticky conflict until it's resolved explicitly
 *    or disk and the store agree. Another branch's pending adoption is left
 *    for its own branch to resolve, even where this branch agrees with disk.
 *
 * Only a push completes a push. A pending disk intent is the module's own
 * write or unlink, and its completion releases the protection a draft has
 * (P := what was written), so it is recorded only by a push whose barriers
 * succeeded. An observation that finds the intended outcome on disk decides
 * the path's state from it but records nothing for it — no completion, no
 * agreement, no branch-intent change — and the path stays owed until a push
 * redoes it. Otherwise a crash that loses an unbarriered write would leave
 * P saying the draft reached disk, and the rule would adopt the older disk
 * version over it. (An explicit path sync still chooses disk, replacing
 * whatever the path's evidence was; that adopts disk, it doesn't certify the
 * push.)
 *
 * Each pass observes disk first (the only async step), then reads S, P and
 * intent and applies every decision in one synchronous step, in the agreed
 * order: intents (durable) → tree commits and intent records → completions
 * (after `store.sync()`). The caller serializes passes per mount. A drop (S
 * removed for a disk copy the workspace can't hold) is the one tree adoption
 * without an intent: it forgets P first, which is conservative, since a crash
 * before the removal leaves P unknown with S present, a conflict, and never
 * a wrong adoption.
 */

import type { JsStore } from '@animalabs/chronicle';
import {
  type Agreed,
  type Candidate,
  type DiskAgreement,
  type Fingerprint,
  type Interrupted,
  type Pending,
  type Physical,
  type RootIdentity,
  candidateOf,
  sameCandidate,
  sameRootIdentity,
} from './disk-agreement.js';
import type { BranchIntent, BranchIntents, ConflictKind, ConflictRecord, DiskCounterpart } from './branch-intent.js';
import {
  type MountView,
  ROOT_REPLACED,
  type Walk,
  fingerprintVouches,
  locateRoot,
  looksBinary,
  observePath,
  provenAbsent,
  readHead,
  readPath,
  sniffImageMime,
  walkScope,
} from './observe.js';
import { EffectFailed, type Expect, chainOf, syncDirectories, unlinkContained, writeContained } from './effects.js';

export type EntryState =
  | 'synced'
  | 'workspace-draft'
  | 'workspace-deleted'
  | 'not-in-branch'
  | 'disk-only'
  | 'conflict'
  | 'disk-missing-provenance-unknown'
  /** Tracked, but disk wasn't observed this pass (unreadable, ignored, unwalked). */
  | 'unverified';

export interface ConflictReport {
  kind: ConflictKind;
  /** Where the disk side is kept: in the store, by reference to the disk file, or absent. */
  diskCopy: 'stored' | 'referenced' | 'absent';
  /** The disk file no longer matches what was recorded with the conflict. */
  diskChangedSinceRecorded: boolean;
}

export interface PathReport {
  path: string;
  state: EntryState;
  /** Store size for entries in the store; disk size otherwise. */
  size?: number;
  mimeType?: string;
  conflict?: ConflictReport;
  note?: string;
  /**
   * For a conflict, what this pass found on disk at the path: grep's account
   * of a conflict's disk side needs it. Listings don't show it.
   */
  diskNow?: 'file' | 'absent';
}

export type TreeOp = 'created' | 'modified' | 'deleted';

export interface PassResult {
  /** Tree changes adopted from disk. */
  ops: Array<{ path: string; op: TreeOp }>;
  /** What a path sync gave up of the workspace's own; `op` is what it did to the
   *  workspace copy, absent when it changed none (a deletion or conflict given
   *  up for a disk copy the workspace can't hold). */
  discarded: Array<{ path: string; was: EntryState; op?: TreeOp }>;
  /** Conflicts recorded by this pass, with the disk change behind each. */
  newConflicts: Array<{ path: string; op: TreeOp }>;
  /** Every path the pass decided, by path. */
  reports: Map<string, PathReport>;
  /** Regions the pass couldn't observe that matter to its scope. */
  incomplete: Array<{ path: string; reason: string }>;
  /**
   * What the walk passed over by design and reported nowhere else, counted by
   * reason: entries the mount's ignore list covers, when nothing beneath them
   * is tracked (a tracked one is reported under `incomplete`). An ignored
   * directory counts once, everything in it included. Only listings the walk
   * kept count: a directory changed during the walk, or one past the file
   * cap, is reported under `incomplete` instead.
   */
  passedOver: Map<string, number>;
  /** For a directory scope: the subdirectories disk shows directly beneath it. */
  dirs: string[];
  /**
   * The branch the pass decided on, absent when it decided nothing. A caller
   * that reads the tree or branch intent to go with the reports checks it is
   * still the selected branch, synchronously, before it reads.
   */
  branchId?: string;
}

export interface MountRuntime {
  name: string;
  view: MountView;
  /** Canonical mount root, for symlink containment. */
  rootReal: string;
  /**
   * The device of the mount root's filesystem when that filesystem maintains
   * ctime, else null. A fingerprint vouches, and is recorded, only for a file
   * on that device: a file on another filesystem mounted beneath the root
   * (which wasn't checked) is rehashed at every observation.
   */
  ctimeTrustedDev: string | null;
  treeStateId: string;
  intents: BranchIntents;
  readOnly: boolean;
  /** The most entries one walk of the mount takes, files and the other entries that aren't directories (`MountConfig.walkCap`). */
  walkCap: number;
  /**
   * Whether the mount runs a catch-up scan (`watch: 'always'`, at start and
   * when its watcher reattaches), which takes turns with its whole-mount
   * syncs.
   */
  catchUpScan: boolean;
}

export type Scope =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'dir'; dir: string; recursive: boolean };

export interface PassOptions {
  /** Rehash every file instead of trusting fingerprints (an explicit sync). */
  rehash?: boolean;
  /** Paths whose disk state is adopted explicitly (a path sync). */
  adopt?: (path: string) => boolean;
  /** Walk cap for directory scopes; the mount's `walkCap` when absent. */
  cap?: number;
  /**
   * A recursive directory pass of a sync or a catch-up scan: its walk resumes
   * after the last entry the previous one of this scope took, and records
   * where it stopped, so repeated passes cover a scope larger than the cap.
   * A listing's pass, and an agent-action scan's, start at their scope's
   * start and record no place.
   */
  resume?: boolean;
  /**
   * The scope was named by a path sync: ignore patterns that cover it don't
   * apply beneath it (see walkScope). A listing's scope keeps them.
   */
  named?: boolean;
  /**
   * The branch the caller asked on (a path sync). If another is selected when
   * the pass gathers, it decides nothing: an adoption asked for on one branch
   * would give up another branch's drafts.
   */
  branchId?: string;
}

const ABSENT: Candidate = { kind: 'absent' };
export const WALK_CAP = 5000;

/** What a pass learned about D for one path. */
type DiskFact =
  | { kind: 'absent' }
  | { kind: 'unobserved'; reason: string }
  | {
      kind: 'file';
      hash: string;
      size: number;
      mtimeMs: number;
      fp: Fingerprint | null;
      /** Text within limits, with its bytes: what disk→store sync may store. */
      ingestible: Buffer | null;
      mimeType?: string;
    }
  /**
   * A file nothing tracks, too large to ingest: listed from its size and head
   * alone. Its bytes were never hashed, so it can't be compared with anything
   * — it is never evidence of agreement, only of a disk-only file.
   */
  | { kind: 'unhashed'; size: number; mtimeMs: number; mimeType?: string };

function diskCandidate(d: DiskFact): Candidate | null {
  if (d.kind === 'absent') return ABSENT;
  if (d.kind === 'file') return { kind: 'content', hash: d.hash };
  return null;
}

function agreedFromDisk(d: DiskFact): Agreed {
  if (d.kind !== 'file') return { kind: 'absent' };
  return { kind: 'content', hash: d.hash, size: d.size, ...(d.fp ? { fp: d.fp } : {}) };
}

function inScope(path: string, scope: Scope): boolean {
  if (scope.kind === 'paths') return scope.paths.includes(path);
  const dir = scope.dir;
  if (dir === '') return scope.recursive || !path.includes('/');
  if (!path.startsWith(dir + '/')) return false;
  return scope.recursive || !path.slice(dir.length + 1).includes('/');
}

/**
 * Learn D for a path. Content is read only when a decision needs it; a
 * recorded fingerprint can vouch for unchanged bytes where the filesystem
 * maintains ctime.
 */
async function learnDisk(
  mount: MountRuntime,
  path: string,
  tracked: { p: Physical | undefined; hasStore: boolean; hasIntent: boolean },
  opts: PassOptions,
): Promise<DiskFact> {
  const seen = await observePath(mount.view, mount.rootReal, path);
  if (seen.kind !== 'file') return seen;
  const p = tracked.p;
  const trusted = (fp: { dev: string }) => mount.ctimeTrustedDev !== null && fp.dev === mount.ctimeTrustedDev;
  if (!opts.rehash && p?.kind === 'content' && fingerprintVouches(p.fp, seen.fp, trusted(seen.fp))) {
    return { kind: 'file', hash: p.hash, size: seen.size, mtimeMs: seen.mtimeMs, fp: p.fp ?? null, ingestible: null };
  }
  const nothingTracked = p === undefined && !tracked.hasStore && !tracked.hasIntent;
  if (nothingTracked && seen.size > mount.view.maxFileSize) {
    // A new oversize file only needs listing: its size, and its head for the
    // MIME type. Hashing it would read all of it, on every listing.
    const head = await readHead(mount.view, mount.rootReal, path);
    if (head.kind !== 'head') return head;
    return { kind: 'unhashed', size: head.size, mtimeMs: head.mtimeMs, mimeType: sniffImageMime(head.head) };
  }
  const read = await readPath(mount.view, mount.rootReal, path, mount.view.maxFileSize);
  if (read.kind !== 'read') return read;
  const ingestible = read.bytes !== null && !looksBinary(read.head) ? read.bytes : null;
  return {
    kind: 'file',
    hash: read.hash,
    size: read.size,
    mtimeMs: read.mtimeMs,
    // A fingerprint is recorded only where it can later vouch for the bytes.
    fp: trusted(read.fp) ? read.fp : null,
    ingestible,
    ...(ingestible ? {} : { mimeType: sniffImageMime(read.head) }),
  };
}

/** The rule's verdict for one path, before effects. */
interface Verdict {
  state: EntryState;
  /** Adopt disk into the tree: set S to D's bytes, or remove S. */
  adopt?: 'ingest' | 'remove' | 'drop';
  /** New P (undefined: unchanged; 'forget': unknown). */
  p?: Agreed | Interrupted | 'forget';
  /** New branch intent (undefined: unchanged). */
  intent?: BranchIntent;
  /** A conflict to record now. */
  conflict?: ConflictKind;
  op?: TreeOp;
  note?: string;
  /**
   * Disk shows what a pending push of ours intended, unconfirmed: the state
   * is decided from it, and nothing at all is recorded (see module doc).
   */
  unconfirmed?: true;
  /** A path sync's adoption gives up this workspace state (see decide). */
  discards?: EntryState;
  /**
   * The last confirmed evidence decide resolved for the path, which an
   * adoption's intent carries as its prior: a settled same-branch adoption's
   * outcome, where the recorded P is still that adoption's pending record.
   */
  prior?: Agreed;
}

/** States in which the rule keeps a change of the workspace's own over disk. */
const WORKSPACE_KEPT: ReadonlySet<EntryState> = new Set<EntryState>([
  'workspace-draft',
  'workspace-deleted',
  'conflict',
  'disk-missing-provenance-unknown',
]);

const UNCONFIRMED_NOTE = 'disk holds what a materialize that has not completed put here; materialize again to complete it';

function keepStoreSide(hasStore: boolean, bi: BranchIntent | null): EntryState {
  if (hasStore) return 'workspace-draft';
  return bi?.tombstone ? 'workspace-deleted' : 'not-in-branch';
}

/**
 * Settle an adoption intent on the branch it was recorded on, by the tree
 * alone: S at the adopted content means the commit landed and only its
 * completion was lost; anything else means it didn't, and the rule runs again
 * from the prior evidence (redoing the adoption if disk still holds it).
 *
 * Content is proof only while nothing else has written the path since, so
 * every workspace mutation settles a pending intent first (the module's
 * mutation boundary): a later write of the same content can't pass for the
 * old adoption.
 */
function settleAdoption(p: Pending, s: { hash: string; size: number } | null): Agreed | 'forget' {
  const sc: Candidate = s ? { kind: 'content', hash: s.hash } : ABSENT;
  if (sameCandidate(sc, p.expect)) {
    return p.expect.kind === 'absent' ? { kind: 'absent' } : { kind: 'content', hash: p.expect.hash, size: s!.size };
  }
  return p.prior ?? 'forget';
}

/**
 * The synchronous precondition of every workspace mutation: evidence owed a
 * barrier is made durable first, and an adoption left pending on the
 * selected branch is settled by the tree before the mutation changes it, and
 * durably, so the settlement can't be lost while the new write survives.
 * Afterwards the write can never pass for the adoption's outcome. Other
 * pending intents never consult the tree, so a write can't confuse them.
 * Holds whether or not an earlier observation could settle it.
 */
export function settleAdoptionBeforeMutation(
  store: JsStore,
  agreement: DiskAgreement,
  mount: { name: string; treeStateId: string },
  path: string,
): void {
  // Evidence still owed a barrier (from a failed one, or read back at open)
  // is made durable before any new tree mutation is permitted at all.
  if (agreement.needsBarrier) agreement.barrier();
  const p = agreement.get(mount.name, path);
  if (p?.kind !== 'pending' || p.effect !== 'adopt' || p.branchId !== store.currentBranch().id) return;
  const entry = store.treeGet(mount.treeStateId, path);
  const settled = settleAdoption(p, entry ? { hash: entry.blobHash, size: entry.size } : null);
  if (settled === 'forget') agreement.forget(mount.name, path);
  else agreement.set(mount.name, path, settled, { afterCommittedState: true });
  agreement.barrier();
}

/**
 * Resolve a pending intent against what was observed. Returns the evidence
 * the rule should use, and whether that resolution should be recorded.
 */
function resolvePending(
  p: Pending,
  dc: Candidate,
  s: { hash: string; size: number } | null,
  d: DiskFact,
  branchId: string,
): { p: Physical | undefined; record?: Agreed | Interrupted | 'forget'; uncaptured?: true; unconfirmed?: true } {
  const prior = p.prior;
  const priorCandidate = prior ? candidateOf(prior) : null;
  if (p.effect === 'disk') {
    if (sameCandidate(dc, p.expect)) {
      // Our own effect shows on disk, but nothing proves it durable: decided
      // on, never recorded. Only a push whose barriers succeed completes it.
      const shown = p.expect.kind === 'absent' ? ({ kind: 'absent' } as Agreed) : agreedFromDisk(d);
      return { p: shown, unconfirmed: true };
    }
    if (priorCandidate && sameCandidate(dc, priorCandidate)) return { p: prior!, record: prior! };
    // A write whose prior was unknown left no file: it never created one (a
    // partial write leaves a file behind), so P is as unknown as before.
    if (!prior && dc.kind === 'absent' && p.expect.kind === 'content') return { p: undefined, record: 'forget' };
    const interrupted: Interrupted = { kind: 'interrupted', candidates: [...(priorCandidate ? [priorCandidate] : []), p.expect] };
    return { p: interrupted, record: interrupted };
  }
  // An adoption: its meaning depends on the branch it was recorded on.
  if (p.branchId === branchId) {
    const landed = sameCandidate(s ? { kind: 'content', hash: s.hash } : ABSENT, p.expect);
    // Landed, with disk at the adopted content too: its fingerprint joins the evidence.
    if (landed && p.expect.kind === 'content' && sameCandidate(dc, p.expect)) {
      const agreed = agreedFromDisk(d);
      return { p: agreed, record: agreed };
    }
    const settled = settleAdoption(p, s);
    return settled === 'forget' ? { p: undefined, record: 'forget' } : { p: settled, record: settled };
  }
  // Another branch, whose S says nothing of whether the adoption happened
  // over there. Disk still holding the prior is D = P: the store has that
  // content. Disk holding the adopted content, or anything newer, may hold
  // the only copy of it, so this branch lists it as a conflict and nothing
  // pushes over it; P stays pending for the intent's own branch to resolve.
  if (priorCandidate && sameCandidate(dc, priorCandidate)) return { p };
  return { p, uncaptured: true };
}

/**
 * An explicit path sync: the store takes disk's state, whatever the evidence
 * — a pending push's included. That chooses disk; it doesn't certify the push.
 */
function adoptDisk(d: Extract<DiskFact, { kind: 'absent' | 'file' }>, s: { hash: string; size: number } | null): Verdict {
  if (d.kind === 'absent') {
    return { state: 'synced', ...(s ? { adopt: 'remove' as const, op: 'deleted' as const } : {}), p: { kind: 'absent' }, intent: {} };
  }
  // Disk agreeing with the store is disk's state already, whatever the file
  // is: a binary or oversize file the workspace holds stays held.
  if (s && s.hash === d.hash) return { state: 'synced', p: agreedFromDisk(d), intent: {} };
  if (d.ingestible) return { state: 'synced', adopt: 'ingest', op: s ? 'modified' : 'created', p: agreedFromDisk(d), intent: {} };
  return { state: 'disk-only', ...(s ? { adopt: 'drop' as const, op: 'deleted' as const } : {}), p: 'forget', intent: {} };
}

/** The rule (see module doc). Pure. */
function decide(
  d: DiskFact,
  s: { hash: string; size: number } | null,
  pIn: Physical | undefined,
  bi: BranchIntent | null,
  branchId: string,
  adopt: boolean,
): Verdict {
  // A branch intent that can't be read may have held a tombstone or a
  // conflict: nothing is decided over it, until a path sync replaces it.
  if (bi?.unreadable !== undefined && !adopt) return { state: 'unverified', note: `its branch intent can't be read: ${bi.unreadable}` };
  if (d.kind === 'unobserved') {
    // Disk proves nothing, but an adoption on this branch settles by the tree.
    if (pIn?.kind === 'pending' && pIn.effect === 'adopt' && pIn.branchId === branchId && !adopt) {
      return { state: 'unverified', note: d.reason, p: settleAdoption(pIn, s) };
    }
    return { state: 'unverified', note: d.reason };
  }
  if (d.kind === 'unhashed') {
    // Observed this way only when nothing tracks the path, which is then a
    // disk-only file whatever else holds. Were anything to track it, its
    // unhashed bytes could prove nothing about it.
    if (pIn === undefined && s === null && bi === null) return { state: 'disk-only' };
    return { state: 'unverified', note: 'not hashed' };
  }
  const dc = diskCandidate(d)!;
  const sc: Candidate = s ? { kind: 'content', hash: s.hash } : ABSENT;

  if (adopt) {
    // What a path sync gives up is exactly what a sync without a path would
    // have kept of the workspace's own (a draft, a deletion, a conflict's
    // workspace side), and the verdict says which.
    const taken = adoptDisk(d, s);
    // A give-up is an adoption, or the intent it clears: a deletion or a
    // conflict given up for a disk copy the workspace can't hold changes no
    // tree entry, and is listed all the same.
    if (taken.adopt || (bi && taken.intent !== undefined)) {
      const kept = decide(d, s, pIn, bi, branchId, false);
      if (WORKSPACE_KEPT.has(kept.state)) taken.discards = kept.state;
      if (taken.adopt && kept.prior) taken.prior = kept.prior;
    }
    return taken;
  }

  // A pending intent resolves first; its resolution is recorded unless the
  // verdict below records newer evidence.
  let p = pIn;
  let resolution: Agreed | Interrupted | 'forget' | undefined;
  let uncaptured = false;
  if (p?.kind === 'pending') {
    const resolved = resolvePending(p, dc, s, d, branchId);
    if (resolved.unconfirmed) {
      // Disk shows our pending push's outcome (P as it intended): the state
      // follows from that, and nothing is recorded — no completion, no
      // agreement, no branch-intent change — until a push confirms it.
      const state: EntryState = sameCandidate(dc, sc) ? 'synced' : bi?.conflict ? 'conflict' : keepStoreSide(s !== null, bi);
      return { state, note: UNCONFIRMED_NOTE, unconfirmed: true };
    }
    p = resolved.p;
    resolution = resolved.record;
    uncaptured = resolved.uncaptured === true;
  }
  const verdict = (v: Verdict): Verdict => (resolution && v.p === undefined ? { ...v, p: resolution } : v);

  // Agreement settles everything, a recorded conflict included.
  if (sameCandidate(dc, sc)) {
    const settles = bi?.tombstone || bi?.conflict || bi?.origin ? { intent: {} } : {};
    // Another branch's pending adoption is still pending here (resolvePending
    // leaves it): that branch resolves it, by its own tree. Recording this
    // branch's agreement over it would lose the adoption there.
    if (p?.kind === 'pending') return verdict({ state: 'synced', ...settles });
    if (dc.kind === 'absent') {
      return verdict({ state: 'synced', ...(p && p.kind !== 'absent' ? { p: { kind: 'absent' } as Agreed } : {}), ...settles });
    }
    const agreed = agreedFromDisk(d) as Extract<Agreed, { kind: 'content' }>;
    const recorded = p?.kind === 'content' ? p : null;
    // Re-record only when P says something else, or a fresh fingerprint can
    // replace one that no longer vouches. A fresh one exists only where it's
    // trusted, so both are judged as trusted here.
    const stale = !recorded || recorded.hash !== agreed.hash || recorded.size !== agreed.size ||
      (agreed.fp !== undefined && fingerprintVouches(agreed.fp, agreed.fp, true) &&
        !fingerprintVouches(recorded.fp, agreed.fp, true));
    return verdict({ state: 'synced', ...(stale ? { p: agreed } : {}), ...settles });
  }

  // A recorded conflict stays until it is resolved explicitly or disk and store converge.
  if (bi?.conflict) return verdict({ state: 'conflict' });

  if (p?.kind === 'interrupted' || uncaptured) return verdict({ state: 'conflict', conflict: 'interrupted' });

  if (p?.kind === 'pending') {
    // Unresolved from another branch, with disk still holding its prior.
    return verdict({ state: keepStoreSide(s !== null, bi) });
  }

  if (p !== undefined) {
    const pc = candidateOf(p);
    if (sameCandidate(dc, pc)) return verdict({ state: keepStoreSide(s !== null, bi) });
    if (sameCandidate(sc, pc)) {
      // Only disk changed since it last agreed: adopt it. P is global, so
      // S = P means the workspace holds what disk last agreed with, whichever
      // branch that agreement came from, and a branch's intent doesn't
      // outrank it. A known P of absent means disk did lose the file, which
      // settles a tombstone here: a file disk shows now is a new one, and
      // adopting it gives up nothing of the workspace's own. A tombstone
      // guards a deletion only while P is unknown (below).
      const settles = bi ? { intent: {} } : {};
      // The adoption's intent carries this resolved evidence as its prior.
      const prior = p.kind === 'absent' || p.kind === 'content' ? { prior: p } : {};
      if (d.kind === 'absent') return { state: 'synced', adopt: 'remove', op: 'deleted', p: { kind: 'absent' }, ...prior, ...settles };
      if (d.ingestible) {
        return { state: 'synced', adopt: 'ingest', op: s ? 'modified' : 'created', p: agreedFromDisk(d), ...prior, ...settles };
      }
      return { state: 'disk-only', ...(s ? { adopt: 'drop' as const, op: 'deleted' as const } : {}), p: 'forget', ...settles };
    }
    const kind: ConflictKind = d.kind === 'absent'
      ? 'deleted-on-disk'
      : !s && bi?.tombstone ? 'changed-after-workspace-delete' : 'both-changed';
    return verdict({ state: 'conflict', conflict: kind });
  }

  // No evidence: intent and provenance decide.
  if (!s && bi?.tombstone) {
    if (d.kind === 'file' && d.hash === bi.tombstone.hash) return { state: 'workspace-deleted' };
    return { state: 'conflict', conflict: 'changed-after-workspace-delete' };
  }
  if (s) {
    if (d.kind === 'absent') return { state: bi?.origin === 'store' ? 'workspace-draft' : 'disk-missing-provenance-unknown' };
    return { state: 'conflict', conflict: bi?.origin === 'store' ? 'store-origin-collision' : 'unknown-provenance' };
  }
  // A new disk file.
  if (d.kind === 'file' && d.ingestible) return { state: 'synced', adopt: 'ingest', op: 'created', p: agreedFromDisk(d) };
  return { state: 'disk-only' };
}

function counterpartOf(store: JsStore, d: DiskFact): DiskCounterpart | null {
  if (d.kind !== 'file') return null;
  const stored = d.ingestible ? store.storeBlob(d.ingestible, 'text/plain') : undefined;
  return { hash: d.hash, size: d.size, mtimeMs: d.mtimeMs, ...(stored ? { stored } : {}) };
}

function conflictReport(record: ConflictRecord, d: DiskFact): ConflictReport {
  const current = diskCandidate(d);
  const recorded: Candidate = record.disk ? { kind: 'content', hash: record.disk.hash } : ABSENT;
  return {
    kind: record.kind,
    diskCopy: record.disk === null ? 'absent' : record.disk.stored ? 'stored' : 'referenced',
    diskChangedSinceRecorded: current !== null && !sameCandidate(current, recorded),
  };
}

/** A pass's view of its scope: candidates enumerated on one branch, and what disk showed for each. */
interface Gathered {
  branchId: string;
  /** The root the facts were gathered under, when it was available. */
  rootIdentity: RootIdentity | null;
  walk: Walk | null;
  facts: Map<string, DiskFact>;
  dirs: string[];
  incomplete: Array<{ path: string; reason: string }>;
}

/** How often a pass gathers again when the branch changes under it. */
const GATHER_ATTEMPTS = 3;

async function gather(store: JsStore, agreement: DiskAgreement, mount: MountRuntime, scope: Scope, opts: PassOptions): Promise<Gathered> {
  // A missing mount root is an unavailable mount (an unmounted drive, a root
  // being replaced), not proof that every file in it was deleted, and so is a
  // root that isn't the directory disk last agreed under: the empty
  // directory a watcher makes where a drive's mountpoint was. The root is
  // the operator's choice and may itself be a symlink to a directory, so it
  // is followed, as `rootReal` is: `followSymlinks` governs links within it.
  const root = await locateRoot(mount.view, mount.rootReal);
  const rootUnavailable = 'reason' in root ? root.reason : null;

  // The branch is labelled where the tracked candidates are read, with no
  // await between: the decision is checked against this label.
  const branchId = store.currentBranch().id;
  const gathered: Gathered = {
    branchId,
    rootIdentity: 'identity' in root ? root.identity : null,
    walk: null,
    facts: new Map(),
    dirs: [],
    incomplete: [],
  };
  if (rootUnavailable !== null) {
    // Said whether or not anything is tracked: an unavailable mount must not
    // read as a verified empty directory.
    gathered.incomplete.push({ path: scope.kind === 'dir' ? scope.dir : '', reason: rootUnavailable });
  }

  // Which paths to decide: what disk shows, and what the store, P and intent
  // track. The tracked ones are read synchronously, on this branch.
  const candidates = new Set<string>();
  let walk: Walk | null = null;
  if (scope.kind === 'paths') {
    for (const p of scope.paths) candidates.add(p);
  } else {
    const prefix = scope.dir ? scope.dir + '/' : undefined;
    for (const e of store.treeList(mount.treeStateId, prefix)) if (inScope(e.path, scope)) candidates.add(e.path);
    for (const [p] of agreement.paths(mount.name, scope.dir)) if (inScope(p, scope)) candidates.add(p);
    for (const [p] of mount.intents.list(scope.dir)) if (inScope(p, scope)) candidates.add(p);
    if (rootUnavailable === null) {
      const resumeAfter = opts.resume ? agreement.walkResumesAfter(mount.name, scope.dir) : undefined;
      walk = await walkScope(mount.view, mount.rootReal, scope.dir, scope.recursive, opts.cap ?? mount.walkCap, {
        named: opts.named,
        ...(resumeAfter !== undefined ? { resumeAfter } : {}),
      });
      for (const f of walk.files) if (inScope(f, scope)) candidates.add(f);
      // The other entries it took (a link, a socket…). Ignored names, and the
      // entries the cap left, are listed only when something tracks them
      // (above).
      for (const p of walk.othersTaken) if (inScope(p, scope)) candidates.add(p);
      for (const d of walk.dirs) if (inScope(d, { kind: 'dir', dir: scope.dir, recursive: false })) gathered.dirs.push(d);
    }
  }
  gathered.walk = walk;

  // Observe. Tracked facts are read again, synchronously, when deciding.
  for (const path of candidates) {
    if (rootUnavailable !== null) {
      gathered.facts.set(path, { kind: 'unobserved', reason: rootUnavailable });
      continue;
    }
    if (walk && provenAbsent(walk, path)) {
      gathered.facts.set(path, { kind: 'absent' });
      continue;
    }
    if (walk?.others.get(path) === 'ignored by the mount') {
      gathered.facts.set(path, { kind: 'unobserved', reason: 'ignored by the mount' });
      continue;
    }
    if (walk && !walk.files.has(path) && !walk.othersTaken.has(path)) {
      // Not taken by the walk, or beneath a region it didn't reach: unproven
      // either way. The nearest region holding it says why.
      let region: Walk['incomplete'][number] | undefined;
      for (const r of walk.incomplete) {
        if (r.path !== '' && path !== r.path && !path.startsWith(r.path + '/')) continue;
        // A link's own region is about what lies beneath it, not the link.
        if (r.kind === 'symlink' && r.path === path) continue;
        if (region === undefined || r.path.length > region.path.length) region = r;
      }
      gathered.facts.set(path, { kind: 'unobserved', reason: region ? region.reason : 'not reached by the walk' });
      continue;
    }
    const p = agreement.get(mount.name, path);
    const hasStore = store.treeGet(mount.treeStateId, path) !== null;
    const hasIntent = mount.intents.get(path) !== null;
    gathered.facts.set(path, await learnDisk(mount, path, { p, hasStore, hasIntent }, opts));
  }

  // Everything above was observed by path beneath the root's path. A root
  // replaced meanwhile lends its replacement's files, and their absence, to
  // the original's paths, so if the root isn't the one the pass began under
  // now, nothing observed counts and nothing is decided from it.
  if (gathered.rootIdentity !== null) {
    const after = await locateRoot(mount.view, mount.rootReal);
    if (!('identity' in after) || !sameRootIdentity(after.identity, gathered.rootIdentity)) {
      const reason = 'reason' in after ? after.reason : ROOT_REPLACED;
      for (const path of gathered.facts.keys()) gathered.facts.set(path, { kind: 'unobserved', reason });
      gathered.rootIdentity = null;
      gathered.walk = null;
      gathered.dirs = [];
      gathered.incomplete.push({ path: scope.kind === 'dir' ? scope.dir : '', reason });
    }
  }
  return gathered;
}

/**
 * One disk→store pass over a scope: the watcher's paths, a lazy read, a
 * listing's directory, a full scan, or a path sync (opts.adopt).
 */
export async function reconcilePass(
  store: JsStore,
  agreement: DiskAgreement,
  mount: MountRuntime,
  scope: Scope,
  opts: PassOptions = {},
): Promise<PassResult> {
  agreement.ensureReconciled();
  // Evidence a failed barrier left unsynced is settled before anything is
  // decided from it; if the barrier fails again, so does the pass.
  if (agreement.needsBarrier) agreement.barrier();
  const result: PassResult = { ops: [], discarded: [], newConflicts: [], reports: new Map(), incomplete: [], passedOver: new Map(), dirs: [] };

  // Enumerate on one branch and observe disk (async). The decision below must
  // describe the same branch the candidates came from: a branch switch during
  // observation would otherwise yield a "complete" listing that omits the new
  // branch's drafts. So a changed branch gathers again; a branch that keeps
  // changing leaves the pass explicitly incomplete, deciding nothing.
  let gathered: Gathered | null = null;
  for (let attempt = 0; attempt < GATHER_ATTEMPTS; attempt++) {
    const next = await gather(store, agreement, mount, scope, opts);
    if (store.currentBranch().id === next.branchId) {
      gathered = next;
      break;
    }
  }
  if (gathered === null) {
    result.incomplete.push({ path: scope.kind === 'dir' ? scope.dir : '', reason: 'the selected branch kept changing while the scan ran' });
    return result;
  }
  if (opts.branchId !== undefined && gathered.branchId !== opts.branchId) {
    result.incomplete.push({
      path: scope.kind === 'dir' ? scope.dir : scope.paths.join(', '),
      reason: 'the selected branch changed before this sync ran; nothing was taken from disk — sync again on this branch to take it',
    });
    return result;
  }
  const { walk, facts } = gathered;
  result.dirs.push(...gathered.dirs);
  result.incomplete.push(...gathered.incomplete);

  // Decide and apply — synchronously, so nothing interleaves.
  const branchId = store.currentBranch().id;
  result.branchId = branchId;
  type Planned = { path: string; verdict: Verdict; d: DiskFact; s: { hash: string; size: number } | null; p: Physical | undefined; bi: BranchIntent | null };
  const planned: Planned[] = [];
  for (const [path, d] of facts) {
    const entry = store.treeGet(mount.treeStateId, path);
    const s = entry ? { hash: entry.blobHash, size: entry.size } : null;
    const p = agreement.get(mount.name, path);
    const bi = mount.intents.get(path);
    const verdict = decide(d, s, p, bi, branchId, opts.adopt?.(path) === true);
    planned.push({ path, verdict, d, s, p, bi });
  }

  // The evidence about to be recorded describes the root it was gathered
  // under, which is recorded first (once per mount), so no crash can leave
  // evidence without its root.
  if (gathered.rootIdentity && planned.some((x) => x.verdict.adopt !== undefined || x.verdict.p !== undefined)) {
    agreement.recordRootIdentity(mount.name, gathered.rootIdentity);
  }

  // 1. Intents for adoptions, durable before any tree commit.
  const adoptions = planned.filter((x) => x.verdict.adopt === 'ingest' || x.verdict.adopt === 'remove');
  adoptions.forEach((x, i) => {
    const prior = x.verdict.prior ?? (x.p && (x.p.kind === 'absent' || x.p.kind === 'content') ? x.p : null);
    agreement.intend(mount.name, x.path, {
      effect: 'adopt',
      prior,
      expect: x.verdict.adopt === 'remove' ? ABSENT : { kind: 'content', hash: (x.d as { hash: string }).hash },
      branchId,
    }, { durable: i === adoptions.length - 1 });
  });

  // 2. Forgetting P for a dropped entry is conservative, so it goes first.
  for (const x of planned) if (x.verdict.adopt === 'drop') agreement.forget(mount.name, x.path);

  // 3. Tree commits and branch intent.
  let committed = false;
  for (const x of planned) {
    const v = x.verdict;
    if (v.adopt === 'ingest' && x.d.kind === 'file' && x.d.ingestible) {
      const blobHash = store.storeBlob(x.d.ingestible, 'text/plain');
      store.treeSet(mount.treeStateId, x.path, { blobHash, size: x.d.ingestible.byteLength, mode: 0o644 });
      committed = true;
    } else if ((v.adopt === 'remove' || v.adopt === 'drop') && x.s) {
      store.treeRemove(mount.treeStateId, x.path);
      committed = true;
    }
    if (v.conflict) {
      const record: ConflictRecord = { kind: v.conflict, at: Date.now(), disk: counterpartOf(store, x.d) };
      mount.intents.update(x.path, (cur) => ({ ...cur, conflict: record }));
      result.newConflicts.push({ path: x.path, op: x.d.kind === 'absent' ? 'deleted' : 'modified' });
      committed = true;
    } else if (v.intent !== undefined) {
      mount.intents.put(x.path, v.intent);
      committed = true;
    }
    if (v.op && v.adopt) result.ops.push({ path: x.path, op: v.op });
    if (v.discards) result.discarded.push({ path: x.path, was: v.discards, ...(v.op && v.adopt ? { op: v.op } : {}) });
  }

  // 4. Completions and agreements, after the commits they assert are synced —
  // this pass's, and any earlier tool write's an agreement rests on.
  let first = true;
  let recorded = false;
  for (const x of planned) {
    const next = x.verdict.p;
    if (x.verdict.adopt === 'drop') recorded = true; // its forget, in step 2
    if (next === undefined) continue;
    recorded = true;
    if (next === 'forget') {
      agreement.forget(mount.name, x.path); // no-op when step 2 already did
      continue;
    }
    agreement.set(mount.name, x.path, next, { afterCommittedState: first });
    first = false;
  }
  // Where the walk stopped, once what it observed is decided: the next pass
  // of this scope resumes after it, or starts afresh once this one covered
  // the scope. A walk that couldn't list its scope's own directory covered
  // none of it, and leaves the place as it was. Unlike evidence, a place
  // binds no root: it only says where the next walk starts, and that walk
  // takes its turn after it in whatever directory is the root by then.
  let resumeAfter: string | null | undefined;
  if (opts.resume && walk && scope.kind === 'dir' && scope.recursive && walk.complete.has(scope.dir)) {
    resumeAfter = walk.stoppedAfter ?? null;
    agreement.recordWalk(mount.name, scope.dir, resumeAfter);
  }

  // 5. Durable before returning. An agreement advance (D = S) has no pending
  // intent to recover from, so losing its append would leave an older P that
  // another branch would misread as a disk edit.
  if (recorded || committed || agreement.needsBarrier) agreement.barrier();
  agreement.maybeCheckpoint();

  // Reports.
  for (const x of planned) {
    const after = mount.intents.get(x.path);
    const entry = store.treeGet(mount.treeStateId, x.path);
    const report: PathReport = { path: x.path, state: x.verdict.state };
    if (entry) report.size = entry.size;
    else if (x.d.kind === 'file' || x.d.kind === 'unhashed') report.size = x.d.size;
    if (x.verdict.state === 'disk-only' && (x.d.kind === 'file' || x.d.kind === 'unhashed') && x.d.mimeType) report.mimeType = x.d.mimeType;
    if (x.verdict.state === 'conflict' && after?.conflict) {
      report.conflict = conflictReport(after.conflict, x.d);
      if (x.d.kind === 'file' || x.d.kind === 'absent') report.diskNow = x.d.kind;
    }
    if (x.verdict.note) report.note = x.verdict.note;
    if (!(x.verdict.state === 'synced' && !entry)) result.reports.set(x.path, report);
  }
  if (walk) {
    const tracked = [...result.reports.values()].filter((r) => r.state === 'unverified').map((r) => r.path);
    if (typeof resumeAfter === 'string' && scope.kind === 'dir') {
      // A watched mount's catch-up scan takes turns with its whole-mount
      // syncs; nothing else moves a place.
      const next = scope.dir !== ''
        ? 'the next sync of this directory'
        : mount.catchUpScan
          ? 'the next sync of the mount, or its catch-up scan if that comes first,'
          : 'the next sync of the mount';
      result.incomplete.push({
        path: scope.dir,
        reason: `the walk cap (${opts.cap ?? mount.walkCap}) was reached: ${next} resumes after ${mount.name}/${resumeAfter}`,
      });
    }
    for (const region of walk.incomplete) {
      // A link's own region hides only what lies beneath it: the link itself
      // is reported by path, with its own reason.
      const hides = tracked.some((p) => (region.kind !== 'symlink' && p === region.path) || p.startsWith(region.path + '/'));
      if (region.kind === 'error' || region.kind === 'cap' || hides) result.incomplete.push({ path: region.path, reason: region.reason });
      // An ignored name that hides nothing tracked is reported nowhere else:
      // counted, so a sync that says 0 also says what it didn't look at
      // (agent-framework #276). A symlink region isn't counted: a link the
      // walk took is a candidate the pass reports by path, taken through the
      // link when it's a file on a mount that follows symlinks, and
      // otherwise listed under `skipped`; a tracked link the cap left is
      // unverified for the cap.
      else if (region.kind === 'ignored') result.passedOver.set(region.reason, (result.passedOver.get(region.reason) ?? 0) + 1);
    }
  }
  return result;
}

// ===========================================================================
// Store → disk
// ===========================================================================

export interface PushOptions {
  /**
   * Overwrite (or unlink) a disk copy in conflict, or one that can't be
   * verified. A disk copy nothing has evidence about is overwritten only when
   * `named` too: a bare push can't tell it from a newer copy.
   */
  force?: boolean;
  /**
   * The caller named these paths (a path given to materialize), rather than
   * the evidence selecting them. Only such a push writes a path nothing has
   * evidence about: over a differing disk copy with `force`, or where disk
   * has no copy at all.
   */
  named?: boolean;
  /** Unlink workspace-deleted files whose disk copy is one the store holds. */
  applyDeletions?: boolean;
  /** Called before each disk write/unlink, so the caller can suppress the watcher echo. */
  beforeEffect?: (path: string) => void;
  /**
   * The branch the caller chose `paths` on. If another is selected by the
   * time the push decides, it writes nothing: a selection made on one branch
   * pushed with another branch's content would be neither branch's materialize.
   */
  branchId?: string;
}

export interface PushResult {
  written: string[];
  unchanged: string[];
  deleted: string[];
  /** Refused paths, each with its reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Workspace deletions left on disk because applyDeletions wasn't given. */
  pendingDeletions: string[];
  /** The branch and sequence the push planned on: what disk now reflects.
   *  Absent when it planned nothing (a read-only mount, or the selected
   *  branch changed after its paths were chosen): disk then still reflects
   *  whatever it did before. */
  branchId?: string;
  sequence?: number;
}

/**
 * Make disk hold the store's version of each path, under the same rule:
 * drafts are written, agreement is left alone, conflicts and unverifiable
 * disk copies are refused unless `force`, and a workspace deletion reaches
 * disk only with `applyDeletions` (with `force` too when disk changed since).
 * A path nothing has evidence about is written only when `named`.
 * A path whose earlier push shows on disk unconfirmed is pushed again, so its
 * completion rests on barriers that succeeded.
 *
 * Every write or unlink is announced by a durable intent first, and checked
 * at the point of effect (effects.ts): the boundary always, and — unless
 * `force` — that disk still holds what was decided on. Then every directory
 * whose entries the push created or removed is synced, from each written
 * file's parent up to the mount root and each unlinked file's parent, once
 * per push and after all of its effects, and only then are completions
 * recorded. An effect that failed without touching its path puts the path's
 * evidence back exactly as it was before the intent; one that touched it, or
 * whose barrier failed, leaves the intent pending.
 */
export async function pushPaths(
  store: JsStore,
  agreement: DiskAgreement,
  mount: MountRuntime,
  paths: string[],
  opts: PushOptions = {},
): Promise<PushResult> {
  agreement.ensureReconciled();
  if (agreement.needsBarrier) agreement.barrier(); // as a pass does: nothing decided from unsynced evidence
  const result: PushResult = { written: [], unchanged: [], deleted: [], skipped: [], pendingDeletions: [] };
  if (mount.readOnly) return result;
  // A root that isn't available takes no writes, forced or not: restoring the
  // store's files into an empty mountpoint would fill the disk the drive was
  // unmounted from. The push plans nothing, so it reports no branch.
  const root = await locateRoot(mount.view, mount.rootReal);
  if ('reason' in root) {
    for (const path of paths) result.skipped.push({ path, reason: root.reason });
    return result;
  }

  type Plan = {
    path: string;
    /**
     * The path's evidence just before this push's intent, after what planning
     * itself recorded (an agreement, a resolved intent), put back if the
     * effect never touches the path.
     */
    before: Physical | undefined;
    prior: Agreed | null;
    /** What the effect may find at the path. */
    expect: Expect;
  } & ({ kind: 'write'; blob: Buffer; hash: string } | { kind: 'unlink' });
  const plans: Plan[] = [];

  // Observe disk.
  const facts = new Map<string, DiskFact>();
  for (const path of paths) {
    const p = agreement.get(mount.name, path);
    facts.set(path, await learnDisk(mount, path, { p, hasStore: true, hasIntent: true }, {}));
  }
  // Each path was observed by path beneath the root's path. Under a root
  // replaced meanwhile they describe the replacement, so, as a pass does,
  // nothing is decided or recorded from them.
  const after = await locateRoot(mount.view, mount.rootReal);
  if (!('identity' in after) || !sameRootIdentity(after.identity, root.identity)) {
    const reason = 'reason' in after ? after.reason : ROOT_REPLACED;
    for (const path of paths) result.skipped.push({ path, reason });
    return result;
  }

  // Decide synchronously what to push.
  const branchId = store.currentBranch().id;
  if (opts.branchId !== undefined && opts.branchId !== branchId) {
    for (const path of paths) {
      result.skipped.push({ path, reason: 'the selected branch changed after these paths were chosen; nothing was written — materialize again' });
    }
    return result;
  }
  result.branchId = branchId;
  result.sequence = store.currentSequence();
  let recorded = false;
  for (const [path, d] of facts) {
    const entry = store.treeGet(mount.treeStateId, path);
    const s = entry ? { hash: entry.blobHash, size: entry.size } : null;
    const p = agreement.get(mount.name, path);
    const bi = mount.intents.get(path);
    const v = decide(d, s, p, bi, branchId, false);
    // What the effect may find: what this observation saw, unless forced.
    const expect: Expect = opts.force || d.kind === 'unobserved' || d.kind === 'unhashed'
      ? { kind: 'any' }
      : d.kind === 'absent' ? { kind: 'absent' } : { kind: 'content', hash: d.hash };
    if (v.adopt) {
      // Disk changed since it last agreed and the workspace copy didn't. Pushing
      // would silently revert the disk change; its evidence stays as it is, so
      // a later sync adopts it.
      if (!s) continue; // nothing in the workspace to push
      if (!opts.force) {
        result.skipped.push({
          path,
          reason: 'stale copy: disk changed since it last agreed with the workspace, which did not — ' +
            'sync this path to adopt the disk version, or pass force to overwrite it',
        });
        continue;
      }
      const priorP = p && (p.kind === 'absent' || p.kind === 'content') ? p : null;
      const blob = store.getBlob(s.hash);
      if (blob) plans.push({ path, kind: 'write', blob, hash: s.hash, prior: priorP, before: agreement.get(mount.name, path), expect });
      else result.skipped.push({ path, reason: 'the workspace copy is missing from the store' });
      continue;
    }
    // Whatever the verdict learned about disk (an agreement, a resolved
    // intent) is recorded before anything is pushed over it, and the root it
    // was learned under before that (once per mount), as a pass does.
    if (v.p !== undefined) agreement.recordRootIdentity(mount.name, root.identity);
    if (v.p === 'forget') agreement.forget(mount.name, path);
    else if (v.p !== undefined) agreement.set(mount.name, path, v.p, { afterCommittedState: true });
    if (v.p !== undefined) recorded = true;
    // The prior a new intent carries is the last confirmed evidence: for a
    // path whose earlier push is unconfirmed, that push's own prior, never
    // the bytes it wrote.
    const known = v.unconfirmed ? (p as Pending).prior ?? undefined : v.p === 'forget' ? undefined : v.p !== undefined ? v.p : p;
    const prior = known && (known.kind === 'absent' || known.kind === 'content') ? known : null;
    if (v.state === 'synced' && !v.unconfirmed) {
      if (v.intent !== undefined) {
        mount.intents.put(path, v.intent);
        recorded = true;
      }
      if (s) result.unchanged.push(path);
      continue;
    }
    if (v.state === 'unverified') {
      if (!opts.force) {
        result.skipped.push({ path, reason: `cannot verify disk copy (${v.note ?? 'not observed'}) — fix it and materialize again, or pass force to overwrite it` });
        continue;
      }
    }
    // A file merely absent from this branch is left alone, an unconfirmed
    // push of another branch's bytes included: nothing replays or unlinks it.
    if (v.state === 'not-in-branch' || v.state === 'disk-only') continue;
    const kind = bi?.conflict?.kind ?? v.conflict ?? 'both-changed';
    // Without evidence there was no agreement for disk to change since, and
    // nothing tells a newer disk copy from an older one: only a push of the
    // named path overwrites it, forced.
    const noEvidence = kind === 'unknown-provenance' || kind === 'store-origin-collision';
    if (v.state === 'conflict' && (!opts.force || (noEvidence && !opts.named))) {
      if (v.conflict) {
        mount.intents.update(path, (cur) => ({ ...cur, conflict: { kind: v.conflict!, at: Date.now(), disk: counterpartOf(store, d) } }));
        recorded = true;
      }
      result.skipped.push({
        path,
        reason: noEvidence
          ? `disk holds a different copy, and nothing records which is newer (conflict: ${kind}) — ` +
            'sync this path to adopt the disk version, or materialize this path with force to overwrite it'
          : kind === 'interrupted'
            ? 'disk holds bytes that match neither what was being written there nor what disk last agreed with ' +
              '(conflict: interrupted), as a write that failed or was cut off partway leaves — check the file, then ' +
              'pass force to write the workspace copy over it, or sync this path to adopt the disk copy as it is'
            : `stale copy: disk changed since it last agreed with the workspace (conflict: ${kind}) — ` +
              'sync this path to adopt the disk version, or pass force to overwrite it',
      });
      continue;
    }
    // An entry from before the evidence that disk lacks: nothing records
    // whether disk deleted it or never had it, and most such entries came
    // from disk. Writing it back could undo a deliberate deletion, so only a
    // push of the named path writes it.
    if (v.state === 'disk-missing-provenance-unknown' && !opts.named) {
      result.skipped.push({
        path,
        reason: 'disk has no copy, and nothing records whether it was deleted there or never written — ' +
          'sync this path to drop it from the workspace, or materialize this path to write it',
      });
      continue;
    }
    if (!s) {
      // Only a deliberate workspace deletion ever unlinks; a file that is
      // merely absent from this branch is never deleted from disk.
      if (!bi?.tombstone) continue;
      if (v.unconfirmed && d.kind === 'absent') {
        // Our own unlink already reached disk, unconfirmed: confirm it — its
        // directory synced, nothing removed — applyDeletions or not. Only
        // ever a confirmation, force or not: a file that appears meanwhile
        // refuses it.
        plans.push({ path, kind: 'unlink', prior, before: agreement.get(mount.name, path), expect: { kind: 'absent' } });
        continue;
      }
      if (!opts.applyDeletions) {
        result.pendingDeletions.push(path);
        continue;
      }
      if (d.kind === 'absent') continue;
      plans.push({ path, kind: 'unlink', prior, before: agreement.get(mount.name, path), expect });
      continue;
    }
    const blob = store.getBlob(s.hash);
    if (!blob) {
      result.skipped.push({ path, reason: 'the workspace copy is missing from the store' });
      continue;
    }
    plans.push({ path, kind: 'write', blob, hash: s.hash, prior, before: agreement.get(mount.name, path), expect });
  }

  // 1. Durable intents before any disk effect, the root they write under first.
  if (plans.length > 0) agreement.recordRootIdentity(mount.name, root.identity);
  plans.forEach((step, i) => {
    agreement.intend(mount.name, step.path, {
      effect: 'disk',
      prior: step.prior,
      expect: step.kind === 'write' ? { kind: 'content', hash: step.hash } : ABSENT,
      branchId,
    }, { durable: i === plans.length - 1 });
  });

  // 2. Effects, each bound at its point of use.
  const effected: Array<{ step: Plan; dirs: string[] }> = [];
  for (const step of plans) {
    opts.beforeEffect?.(step.path);
    try {
      if (step.kind === 'write') {
        await writeContained(mount.view, mount.rootReal, step.path, step.blob, step.expect);
        effected.push({ step, dirs: chainOf(step.path) });
      } else {
        // Its directory is synced whether this unlink removed the entry or
        // found it gone: either way the completion claims a durable absence.
        effected.push({ step, dirs: [await unlinkContained(mount.view, mount.rootReal, step.path, step.expect)] });
      }
    } catch (err) {
      const failure = err instanceof EffectFailed ? err : new EffectFailed(err instanceof Error ? err.message : String(err), true);
      if (!failure.touched) {
        // Disk at this path is as planning saw it: its evidence goes back to
        // exactly what it was, whatever kind that was.
        agreement.restore(mount.name, step.path, step.before);
        recorded = true;
        result.skipped.push({ path: step.path, reason: `not ${step.kind === 'write' ? 'written' : 'unlinked'}: ${failure.message}` });
      } else {
        // No completion: the intent stays pending, and the next observation
        // resolves it from whatever disk then holds.
        result.skipped.push({ path: step.path, reason: `${failure.message}; the outcome is checked at the next observation` });
      }
    }
  }

  // 3. Barriers: every directory whose entries the push changed, synced
  // once, after all of its effects. A directory created by an earlier,
  // failed attempt is synced too: the whole chain, whoever made it.
  const unsynced = await syncDirectories(mount.view, mount.rootReal, effected.flatMap((x) => x.dirs));

  // 4. Completions. P is physical and global. Branch intent belongs to the
  // branch this push planned on: it is settled only while that branch is
  // still selected, and otherwise by convergence when the branch returns.
  for (const { step, dirs } of effected) {
    const failed = dirs.find((dir) => unsynced.has(dir));
    if (failed !== undefined) {
      result.skipped.push({
        path: step.path,
        reason: `could not make the ${step.kind === 'write' ? 'write' : 'unlink'} durable (directory fsync of ${failed === '' ? 'the mount root' : failed}): ` +
          `${unsynced.get(failed)}; the outcome is checked at the next observation`,
      });
      continue;
    }
    const value: Agreed = step.kind === 'write' ? { kind: 'content', hash: step.hash, size: step.blob.byteLength } : { kind: 'absent' };
    agreement.set(mount.name, step.path, value);
    recorded = true;
    const planned = store.currentBranch().id === branchId;
    if (step.kind === 'write') {
      if (planned) mount.intents.update(step.path, (cur) => { const next = { ...cur }; delete next.conflict; delete next.origin; return next; });
      result.written.push(step.path);
    } else {
      if (planned) mount.intents.put(step.path, null);
      result.deleted.push(step.path);
    }
  }
  // Durable before returning, like a pass: agreements recorded here have no
  // pending intent behind them, and completions shouldn't wait for one.
  if (recorded || agreement.needsBarrier) agreement.barrier();
  agreement.maybeCheckpoint();
  return result;
}
