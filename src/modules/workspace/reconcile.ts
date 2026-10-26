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
import { storedBytes, type StoredBytes } from './sync.js';
import {
  IGNORED,
  type MountView,
  OTHER_MOUNT,
  ROOT_REPLACED,
  type Walk,
  fingerprintVouches,
  ignoreBeneath,
  inOtherMount,
  locateRoot,
  looksBinary,
  observePath,
  passedOverAt,
  passedOverBetween,
  provenAbsent,
  readHead,
  readPath,
  sniffImageMime,
  walkScope,
  withinIncludes,
} from './observe.js';
import { EffectFailed, type Expect, chainOf, chmodContained, narrowedTo, syncDirectories, unlinkContained, writeContained } from './effects.js';

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
  /**
   * Tree changes adopted from disk. `modeOnly`: disk's mode was taken in on
   * the same bytes, which makes no event.
   */
  ops: Array<{ path: string; op: TreeOp; modeOnly?: true }>;
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
   * reason: another mount's directory nested in this one, entries the mount's
   * ignore list covers, and entries with an editor's swap or backup file
   * name, when nothing beneath them is tracked (a tracked one is reported
   * under `incomplete`). Such a directory counts
   * once, everything in it included. Only listings the walk
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
  /**
   * Whether a file's mode is observed, taken in and applied: the module's,
   * from the platform. Windows reports only 0o666 or 0o444, so there a store
   * written on a POSIX host would lose its executable bits at the first look:
   * modes go unobserved, as before they were recorded, and the store and the
   * evidence keep their own for the next POSIX host.
   */
  modesObserved: boolean;
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
   * The scope was named, by a path sync or by a file tool's pass on the path
   * it acts on: what the mount passes over by design that covers the scope,
   * at it or above it, doesn't apply there (see walkScope). A listing's scope
   * keeps it.
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
      /**
       * Permission bits (`st_mode & 0o777`); none where modes go unobserved,
       * as on Windows, which keeps no POSIX modes (MountRuntime's
       * `modesObserved`): nothing there is taken in or applied.
       */
      mode?: number;
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
  return { kind: 'content', hash: d.hash, size: d.size, ...(d.mode !== undefined ? { mode: d.mode } : {}), ...(d.fp ? { fp: d.fp } : {}) };
}

/** The file-type bits git records with a regular file's mode. */
const REGULAR_FILE = 0o100000;

/** A tree entry's mode for permission bits: with the regular-file type bits, as git records one. */
export function treeMode(perm: number): number {
  return REGULAR_FILE | (perm & 0o777);
}

/**
 * The mode a tree entry takes for disk's permission bits, or, where disk's
 * aren't observed, the entry's own. With neither, the placeholder an entry
 * without a recorded mode has (see entryMode).
 */
function treeModeOf(perm: number | undefined, s: StoreSide | null): { mode: number } {
  if (perm !== undefined) return { mode: treeMode(perm) };
  if (s?.mode !== undefined) return { mode: treeMode(s.mode) };
  return { mode: 0o644 };
}

/**
 * The permission bits a tree entry records, or undefined when it records
 * none. An entry without the file-type bits was written before modes were
 * recorded, which wrote 0o644 whatever disk had: a placeholder, not a mode.
 */
export function entryMode(mode: number): number | undefined {
  return (mode & 0o170000) === REGULAR_FILE ? mode & 0o777 : undefined;
}

/** The store's side of a path: its entry's bytes, and its mode when recorded. */
type StoreSide = { hash: string; size: number; mode?: number };

/** The store's side of a tree entry. */
export function storeSide(entry: { blobHash: string; size: number; mode: number } | null): StoreSide | null {
  if (!entry) return null;
  const mode = entryMode(entry.mode);
  return { hash: entry.blobHash, size: entry.size, ...(mode !== undefined ? { mode } : {}) };
}

/**
 * Where disk and the store hold the same bytes, what their modes ask for.
 * A mode the store doesn't record agrees with any, and takes disk's
 * (`fill`). The store's mode goes to disk (`push`) only where the evidence
 * shows disk still has the mode they last agreed on; otherwise disk's mode
 * is taken in as a change (`adopt`): disk changed it, or nothing says which
 * side did, and an unknown never moves disk.
 */
function modeAction(disk: number, store: number | undefined, agreed: number | undefined): 'fill' | 'adopt' | 'push' | undefined {
  if (store === undefined) return 'fill';
  if (store === disk) return undefined;
  return agreed !== undefined && agreed === disk ? 'push' : 'adopt';
}

function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
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
    return { kind: 'file', hash: p.hash, size: seen.size, mtimeMs: seen.mtimeMs, ...(mount.modesObserved ? { mode: seen.mode } : {}), fp: p.fp ?? null, ingestible: null };
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
    ...(mount.modesObserved ? { mode: read.mode } : {}),
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
  /**
   * With `unconfirmed`: disk's mode is one of the stopped push's own
   * (pushedMode), so the push that completes it gives the store's mode
   * there, as it would where disk has the mode they last agreed on.
   */
  ownMode?: true;
  /**
   * A path sync's adoption over a push of ours that stopped partway: the
   * mode the tree takes, which is the one the push meant the bytes on disk
   * to have, not the one it left them at. The evidence keeps disk's actual
   * mode, so a later push moves disk to the tree's.
   */
  diskMode?: number;
  /** A path sync's adoption gives up this workspace state (see decide). */
  discards?: EntryState;
  /**
   * Disk and the store hold the same bytes, and the store's mode is unknown
   * or differs (see modeAction): `fill` and `adopt` record disk's mode on
   * the store's entry, `adopt` as a change; `push` leaves it for a push.
   */
  mode?: 'fill' | 'adopt' | 'push';
  /**
   * The last confirmed evidence decide resolved for the path, which an
   * adoption's intent carries as its prior: a settled same-branch adoption's
   * outcome, where the recorded P is still that adoption's pending record.
   * Or the evidence a push's narrowing left when it stopped before its
   * bytes, which decide uses without recording it, so the intent stays: a
   * push plans from it and goes on as the stopped push, its intent carrying
   * that push's prior and modes (pushPaths), and a sync that adopts disk's
   * copy carries it as its adoption's prior. An adoption that doesn't land
   * returns to it, as every adoption returns to its prior: the store's
   * change is owed again, and the next push completes it at the store's
   * mode. The old bytes' own mode doesn't survive that, since the adoption's
   * intent replaced the push's.
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
function settleAdoption(p: Pending, s: StoreSide | null): Agreed | 'forget' {
  const sc: Candidate = s ? { kind: 'content', hash: s.hash } : ABSENT;
  if (sameCandidate(sc, p.expect)) {
    // Where modes are observed, the adoption took disk's mode with its bytes,
    // so the entry's mode is the one they agreed on, but for an adoption that
    // took the mode a stopped push of ours meant the old bytes to have: its
    // entry holds that mode while disk holds the push's narrowed one, which a
    // later sync then takes in. Where modes aren't observed, the entry's mode
    // is the store's own, and the evidence records none.
    return p.expect.kind === 'absent'
      ? { kind: 'absent' }
      : { kind: 'content', hash: p.expect.hash, size: s!.size, ...(s!.mode !== undefined ? { mode: s!.mode } : {}) };
  }
  return p.prior ?? 'forget';
}

/**
 * What's in the way, and the way out, when disk's shape keeps a push from a
 * path: no push writes a file over a directory or unlinks one, unlinks
 * anything but a regular file or a followed symlink to one, or writes below
 * a file or a symlink the walk won't take (`writeContained`,
 * `unlinkContained`), forced or not. Null for any other reason, which is
 * passed on as it is.
 */
function inTheWay(reason: string | undefined, deletion: boolean): string | null {
  // Observation's words for what a deletion never unlinks, which the unlink
  // refuses in the same words.
  if (deletion && (reason === 'not a regular file' || reason === 'a symlink to a directory, not walked')) {
    const what = reason === 'not a regular file'
      ? 'a pipe, socket or device at this path, or a symlink to one'
      : 'a symlink to a directory at this path';
    return `disk has ${what}, and no push unlinks it, forced or not — ask whoever runs this host if it should go`;
  }
  if (reason === 'a directory') {
    return deletion
      ? 'disk has a directory at this path, and no push unlinks one, forced or not — if it should go, move or remove it on disk'
      : 'disk has a directory at this path, and no push writes a file over one, forced or not — ' +
        'move or remove that directory on disk and materialize again, or write the file under another path';
  }
  // A deletion below a file finds nothing there to unlink, so only a write
  // meets this one.
  if (reason === 'a parent path is not a directory') {
    return 'disk has a file or a symlink where this path needs a directory, and no push writes below one, forced or not — ' +
      'move or remove it on disk and materialize again, or write the file under another path';
  }
  return null;
}

/**
 * The forced way out the refusal of a disk copy that couldn't be verified
 * names, if any. A forced push skips the verification, so it gets past the
 * note only where its effect can go on. A file the module can't read (EACCES)
 * is overwritten, or unlinked, where disk lets the workspace write it, or
 * unlink it, which a read's EACCES doesn't show: force is named on that
 * condition. No other note names force: a forced push stops at some (a
 * symlink the mount doesn't follow, what isn't a regular file, a parent it
 * can't use); another writer still at the file ("the file changed while it
 * was read") is answered by materializing again; and the rest aren't known
 * to pass.
 */
function forcedWay(note: string | undefined, deletion: boolean, forced: string): string {
  if (note === 'cannot open (EACCES)') return `, or, if disk lets the workspace ${deletion ? 'unlink' : 'write'} the file, ${forced}`;
  return '';
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
  const settled = settleAdoption(p, entry ? { hash: entry.blobHash, size: entry.size, ...(entryMode(entry.mode) !== undefined ? { mode: entryMode(entry.mode) } : {}) } : null);
  if (settled === 'forget') agreement.forget(mount.name, path);
  else agreement.set(mount.name, path, settled, { afterCommittedState: true });
  agreement.barrier();
}

/**
 * What a push of ours that stopped partway left on disk, read by its own
 * modes (Pending's `modes`): the new bytes at `from & to` or `to` were meant
 * to have `to`; the old bytes at `from & to`, narrower than `from`, still
 * have `from` as theirs. New bytes at `from` are a push's only where
 * `from & to` is `from`: a push that narrows does so before its bytes, so
 * otherwise they were given `from` since. Undefined where disk shows
 * anything else: no push of ours, or a mode set since it stopped.
 */
function pushedMode(p: Pending, dc: Candidate, d: DiskFact): number | undefined {
  const m = p.modes;
  if (p.effect !== 'disk' || m === undefined || d.kind !== 'file' || d.mode === undefined) return undefined;
  const narrowed = m.from & m.to;
  if (sameCandidate(dc, p.expect)) return d.mode === narrowed || d.mode === m.to ? m.to : undefined;
  const prior = p.prior ? candidateOf(p.prior) : null;
  return prior && sameCandidate(dc, prior) && narrowed !== m.from && d.mode === narrowed ? m.from : undefined;
}

/**
 * Resolve a pending intent against what was observed. Returns the evidence
 * the rule should use, and whether that resolution should be recorded.
 */
function resolvePending(
  p: Pending,
  dc: Candidate,
  s: StoreSide | null,
  d: DiskFact,
  branchId: string,
): { p: Physical | undefined; record?: Agreed | Interrupted | 'forget'; uncaptured?: true; unconfirmed?: true; ownMode?: true } {
  const prior = p.prior;
  const priorCandidate = prior ? candidateOf(prior) : null;
  if (p.effect === 'disk') {
    if (sameCandidate(dc, p.expect)) {
      // Our own effect shows on disk, but nothing proves it durable: decided
      // on, never recorded. Only a push whose barriers succeed completes it.
      // Where disk's mode is one of the push's own, the push that completes
      // it gives the store's mode there.
      const shown = p.expect.kind === 'absent' ? ({ kind: 'absent' } as Agreed) : agreedFromDisk(d);
      return { p: shown, unconfirmed: true, ...(pushedMode(p, dc, d) !== undefined ? { ownMode: true as const } : {}) };
    }
    if (priorCandidate && sameCandidate(dc, priorCandidate)) {
      // The push narrowed the mode and stopped before its bytes: disk's mode
      // is the push's, so the rule decides from it, and the next push writes
      // the bytes at it and then widens to the store's. The old bytes are
      // never given the store's mode. Nothing is recorded: the intent, with
      // the modes that map disk's narrowed one back to the old bytes' own,
      // stays, carried by a push that goes on with it (pushPaths), until a
      // push completes it or a sync adopts disk's copy.
      if (prior!.kind === 'content' && d.kind === 'file' && pushedMode(p, dc, d) !== undefined) {
        return { p: { ...prior!, mode: d.mode } };
      }
      return { p: prior!, record: prior! };
    }
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
function adoptDisk(d: Extract<DiskFact, { kind: 'absent' | 'file' }>, s: StoreSide | null): Verdict {
  if (d.kind === 'absent') {
    return { state: 'synced', ...(s ? { adopt: 'remove' as const, op: 'deleted' as const } : {}), p: { kind: 'absent' }, intent: {} };
  }
  // Disk agreeing with the store is disk's state already, whatever the file
  // is: a binary or oversize file the workspace holds stays held. Its mode
  // is disk's too.
  if (s && s.hash === d.hash) {
    const mode = d.mode === undefined ? undefined : s.mode === undefined ? 'fill' as const : s.mode !== d.mode ? 'adopt' as const : undefined;
    return { state: 'synced', p: agreedFromDisk(d), intent: {}, ...(mode ? { mode } : {}), ...(mode === 'adopt' ? { op: 'modified' as const } : {}) };
  }
  if (d.ingestible) return { state: 'synced', adopt: 'ingest', op: s ? 'modified' : 'created', p: agreedFromDisk(d), intent: {} };
  return { state: 'disk-only', ...(s ? { adopt: 'drop' as const, op: 'deleted' as const } : {}), p: 'forget', intent: {} };
}

/** The rule (see module doc). Pure. */
function decide(
  d: DiskFact,
  s: StoreSide | null,
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
    // workspace side), and the verdict says which. Where a push of ours
    // stopped partway, disk's mode is the push's: the store takes the one
    // the push meant those bytes to have, and the evidence keeps disk's, so
    // a later push moves disk there.
    const meant = pIn?.kind === 'pending' ? pushedMode(pIn, dc, d) : undefined;
    const taken = adoptDisk(meant === undefined ? d : { ...d, mode: meant } as typeof d, s);
    if (meant !== undefined) {
      if (taken.p !== undefined && taken.p !== 'forget' && taken.p.kind === 'content') taken.p = agreedFromDisk(d);
      if (taken.adopt === 'ingest' || taken.mode !== undefined) taken.diskMode = meant;
    }
    // A give-up is an adoption, or the intent it clears: a deletion or a
    // conflict given up for a disk copy the workspace can't hold changes no
    // tree entry, and is listed all the same.
    if (taken.adopt || taken.mode === 'adopt' || (bi && taken.intent !== undefined)) {
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
  // Evidence a resolution decides from without recording it: a stopped
  // push's narrowing, whose intent stays (resolvePending).
  let unrecorded: Agreed | undefined;
  let uncaptured = false;
  if (p?.kind === 'pending') {
    const resolved = resolvePending(p, dc, s, d, branchId);
    if (resolved.unconfirmed) {
      // Disk shows our pending push's outcome (P as it intended): the state
      // follows from that, and nothing is recorded — no completion, no
      // agreement, no branch-intent change — until a push confirms it.
      const state: EntryState = sameCandidate(dc, sc) ? 'synced' : bi?.conflict ? 'conflict' : keepStoreSide(s !== null, bi);
      return {
        state, note: UNCONFIRMED_NOTE, unconfirmed: true,
        ...(resolved.ownMode ? { ownMode: true as const } : {}),
      };
    }
    p = resolved.p;
    resolution = resolved.record;
    if (resolution === undefined && p !== undefined && (p.kind === 'content' || p.kind === 'absent')) unrecorded = p;
    uncaptured = resolved.uncaptured === true;
  }
  const verdict = (v: Verdict): Verdict => (resolution && v.p === undefined ? { ...v, p: resolution }
    : unrecorded && v.p === undefined && v.prior === undefined ? { ...v, prior: unrecorded } : v);

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
    // trusted, so both are judged as trusted here. Evidence a resolution left
    // unrecorded, a stopped push's narrowing, is stale too: the agreement
    // replaces that push's intent, and the mode rule gives the store's mode.
    const stale = unrecorded !== undefined || !recorded || recorded.hash !== agreed.hash || recorded.size !== agreed.size || recorded.mode !== agreed.mode ||
      (agreed.fp !== undefined && fingerprintVouches(agreed.fp, agreed.fp, true) &&
        !fingerprintVouches(recorded.fp, agreed.fp, true));
    const mode = agreed.mode === undefined ? undefined : modeAction(agreed.mode, s!.mode, recorded?.mode);
    if (mode === 'push') {
      return verdict({
        state: 'workspace-draft',
        mode,
        note: `the workspace's mode (${octal(s!.mode!)}) differs from disk's (${octal(agreed.mode!)}): materialize to apply it`,
        ...(stale ? { p: agreed } : {}),
        ...settles,
      });
    }
    return verdict({ state: 'synced', ...(mode ? { mode } : {}), ...(mode === 'adopt' ? { op: 'modified' as const } : {}), ...(stale ? { p: agreed } : {}), ...settles });
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
  // track. The tracked ones are read synchronously, on this branch. A path
  // the mount's include doesn't cover is outside the mount, so no pass
  // decides it: the workspace's history may hold it from before the include,
  // and it stays there as it is. So is one in a nested mount's directory
  // that mount's include leaves out, such as history taken in before the
  // mount was nested there: it's no mount's (namesNestedPlace).
  const candidates = new Set<string>();
  const inside = (p: string): boolean => withinIncludes(mount.view, p);
  let walk: Walk | null = null;
  if (scope.kind === 'paths') {
    for (const p of scope.paths) if (inside(p)) candidates.add(p);
  } else {
    const prefix = scope.dir ? scope.dir + '/' : undefined;
    for (const e of store.treeList(mount.treeStateId, prefix)) if (inScope(e.path, scope) && inside(e.path)) candidates.add(e.path);
    for (const [p] of agreement.paths(mount.name, scope.dir)) if (inScope(p, scope) && inside(p)) candidates.add(p);
    for (const [p] of mount.intents.list(scope.dir)) if (inScope(p, scope) && inside(p)) candidates.add(p);
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
    // What the mount passes over by design stays unobserved by a pass that
    // names no path, however it reaches it, so no listing's absence proves a
    // copy there gone. In another mount's directory, no pass of this mount
    // observes anything, named or not.
    // Beneath a directory a by-design rule covers, a pass that isn't named
    // observes nothing. A path a rule covers by its own name is observed as a
    // walk observes it: passed over where the walk lists it, and absent where
    // the walk lists its directory without it; a pass that reaches it by its
    // path alone, as a listing, glob or grep naming it does, passes over it.
    // A pass that names its scope, as a sync naming a path and a file tool's
    // pass on the path it acts on do, sets aside only what covers the scope,
    // at it or above it, as its walk does (#276): a directory passed over by
    // design beneath a named directory stays passed over, and so does what
    // lies beneath it.
    let byDesign: string | undefined;
    if (inOtherMount(path, mount.view.others)) {
      byDesign = OTHER_MOUNT;
    } else if (!opts.named) {
      const slash = path.lastIndexOf('/');
      const above = slash < 0 ? undefined : passedOverAt(path.slice(0, slash), mount.view.ignore, mount.view.others);
      const own = above === undefined && !walk ? passedOverAt(path, mount.view.ignore, mount.view.others) : undefined;
      byDesign = above ?? own;
    } else if (scope.kind === 'dir') {
      byDesign = passedOverBetween(scope.dir, path, ignoreBeneath(scope.dir, mount.view.ignore), mount.view.others);
    }
    if (byDesign !== undefined) {
      gathered.facts.set(path, { kind: 'unobserved', reason: byDesign });
      continue;
    }
    if (walk && provenAbsent(walk, path)) {
      gathered.facts.set(path, { kind: 'absent' });
      continue;
    }
    if (walk?.others.get(path) === IGNORED) {
      gathered.facts.set(path, { kind: 'unobserved', reason: IGNORED });
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
  type Planned = { path: string; verdict: Verdict; d: DiskFact; s: StoreSide | null; p: Physical | undefined; bi: BranchIntent | null };
  const planned: Planned[] = [];
  for (const [path, d] of facts) {
    const s = storeSide(store.treeGet(mount.treeStateId, path));
    const p = agreement.get(mount.name, path);
    const bi = mount.intents.get(path);
    const verdict = decide(d, s, p, bi, branchId, opts.adopt?.(path) === true);
    planned.push({ path, verdict, d, s, p, bi });
  }

  // The evidence about to be recorded describes the root it was gathered
  // under, which is recorded first, so no crash can leave evidence without
  // its root. Once a root is recorded, every pass that found it offers it,
  // evidence or none: the same root on a new device, or with its first
  // birth time, is recorded again (recordRootIdentity writes nothing
  // otherwise), and a quiet mount's passes are where an old record learns
  // its birth time.
  if (gathered.rootIdentity && (agreement.rootIdentity(mount.name) !== undefined || planned.some((x) => x.verdict.adopt !== undefined || x.verdict.p !== undefined))) {
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
      store.treeSet(mount.treeStateId, x.path, { blobHash, size: x.d.ingestible.byteLength, ...treeModeOf(v.diskMode ?? x.d.mode, x.s) });
      committed = true;
    } else if ((v.adopt === 'remove' || v.adopt === 'drop') && x.s) {
      store.treeRemove(mount.treeStateId, x.path);
      committed = true;
    } else if ((v.mode === 'fill' || v.mode === 'adopt') && x.d.kind === 'file' && x.s) {
      // The same bytes, with disk's mode. A fill records a mode where the
      // entry had none, which is no change: an undo or a branch whose entry
      // still has none agrees with any mode, so neither reads it as one.
      store.treeSet(mount.treeStateId, x.path, { blobHash: x.s.hash, size: x.s.size, ...treeModeOf(v.diskMode ?? x.d.mode, x.s) });
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
    const changed = v.adopt !== undefined || v.mode === 'adopt';
    if (v.op && changed) result.ops.push({ path: x.path, op: v.op, ...(v.adopt === undefined ? { modeOnly: true as const } : {}) });
    if (v.discards) result.discarded.push({ path: x.path, was: v.discards, ...(v.op && changed ? { op: v.op } : {}) });
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
      // A scope passed over whole is the answer to the pass that asked for
      // it, so it's always named. Another mount's directory met beneath the
      // scope is passed over by design even where this mount's tree holds
      // copies there: no tool of this mount syncs, pushes or clears them
      // (listings show those that mount's include covers, naming their
      // holder), so naming the directory as unreached would never clear.
      const wholeScope = scope.kind === 'dir' && scope.dir !== '' && region.path === scope.dir;
      const unreached = hides && region.reason !== OTHER_MOUNT;
      if (region.kind === 'error' || region.kind === 'cap' || unreached || wholeScope) result.incomplete.push({ path: region.path, reason: region.reason });
      // A name passed over by design that hides nothing tracked is reported nowhere else:
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
   * `named` too: a bare push can't tell it from a newer copy. Forced or not,
   * nothing but a regular file, or a followed symlink to one, is written over
   * or unlinked (effects.ts).
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
  /**
   * Written paths whose mode stayed as disk had it, each with why: their
   * bytes reached disk, and the workspace's mode didn't.
   */
  modesKept: Array<{ path: string; reason: string }>;
  /** Workspace deletions left on disk because applyDeletions wasn't given. */
  pendingDeletions: string[];
  /** The branch and sequence the push planned on: what disk now reflects.
   *  Absent when it planned nothing (a read-only mount, or the selected
   *  branch changed after its paths were chosen): disk then still reflects
   *  whatever it did before. */
  branchId?: string;
  sequence?: number;
}

/** Why a push skips a path in another mount's directory nested in its own. */
export const NOT_PUSHED_IN_OTHER_MOUNT = "it lies in another mount's directory, which no push of this mount writes";

/**
 * Make disk hold the store's version of each path, under the same rule:
 * drafts are written, agreement is left alone, conflicts and unverifiable
 * disk copies are refused unless `force`, and a workspace deletion reaches
 * disk only with `applyDeletions` (with `force` too when disk changed since).
 * Forced or not, nothing but a regular file, or a followed symlink to one, is
 * written over or unlinked (effects.ts).
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
  const result: PushResult = { written: [], unchanged: [], deleted: [], skipped: [], modesKept: [], pendingDeletions: [] };
  if (mount.readOnly) return result;
  // A root that isn't available takes no writes, forced or not: restoring the
  // store's files into an empty mountpoint would fill the disk the drive was
  // unmounted from. The push plans nothing, so it reports no branch.
  const root = await locateRoot(mount.view, mount.rootReal);
  if ('reason' in root) {
    for (const path of paths) result.skipped.push({ path, reason: root.reason });
    return result;
  }
  // Another mount's directory nested in this one is that mount's: no push
  // of this mount writes or deletes a path in it, forced or not. (On a mount
  // that follows links, a link of this mount's that leads there is read as
  // this mount's own path; on one that doesn't, the link is refused.)
  if (mount.view.others.length > 0) {
    const own: string[] = [];
    for (const path of paths) {
      if (inOtherMount(path, mount.view.others)) result.skipped.push({ path, reason: NOT_PUSHED_IN_OTHER_MOUNT });
      else own.push(path);
    }
    paths = own;
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
  } & (
    | {
        kind: 'write';
        blob: Buffer;
        hash: string;
        /** Permission bits the write gives the file, if any. */
        apply?: number;
        /** The mode disk had when it was checked, which `apply` replaces only if disk still has it. */
        from?: number;
        /** The store's mode, and the evidence's before the push. */
        storeMode?: number;
        priorMode?: number;
        /** The mode disk had when it was checked, forced or not: where the push's modes start. */
        seenMode?: number;
        /** `apply` is forced over a mode disk changed since it last agreed, or one nothing records. */
        overDisk?: true;
        /**
         * For a push that re-plans over our own narrowing push stopped before
         * its bytes, the modes its intent carries: from the old bytes' own
         * mode, the stopped push's `from`, to the store's mode now, or where
         * the store records none, the mode the stopped push narrowed to.
         */
        ownModes?: { from: number; to: number };
      }
    | { kind: 'unlink' }
    /**
     * The store's mode, applied to bytes disk and the store share; `from`,
     * when given, the mode disk must still have. `overDisk`: a forced chmod
     * over a mode disk changed since it last agreed, or one nothing records
     * which side changed, rather than a push of the store's own change.
     */
    | { kind: 'chmod'; mode: number; hash: string; size: number; from?: number; overDisk?: true }
  );
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
    const s = storeSide(store.treeGet(mount.treeStateId, path));
    const p = agreement.get(mount.name, path);
    const bi = mount.intents.get(path);
    const v = decide(d, s, p, bi, branchId, false);
    // The ways out a refusal names, as materialize takes them: a deletion
    // reaches disk only with applyDeletions.
    const again = s ? 'materialize again' : 'materialize again with applyDeletions';
    // Where disk has deleted a file the workspace holds, a sync takes the
    // deletion, which removes the workspace's copy, and a forced push writes
    // the workspace's copy back: there is no disk copy to adopt or overwrite.
    const gone = s !== null && d.kind === 'absent';
    const forced = !s ? 'materialize it with force and applyDeletions to delete it'
      : gone ? "materialize it with force to write the workspace's copy back" : 'materialize it with force to overwrite it';
    const takeDisk = gone ? "sync this path to take disk's deletion, which removes the workspace's copy" : 'sync this path to adopt the disk version';
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
            `${takeDisk}, or ${forced}`,
        });
        continue;
      }
      const priorP = p && (p.kind === 'absent' || p.kind === 'content') ? p : null;
      const stored = storedBytes(store, s.hash);
      const forcedMode = mount.modesObserved && s.mode !== undefined && s.mode !== (d.kind === 'file' ? d.mode : undefined) ? s.mode : undefined;
      const agreedMode = priorP?.kind === 'content' ? priorP.mode : undefined;
      if ('bytes' in stored) {
        plans.push({
          path, kind: 'write', blob: stored.bytes, hash: s.hash, prior: priorP, before: agreement.get(mount.name, path), expect,
          ...(forcedMode !== undefined ? { apply: forcedMode } : {}),
          ...(forcedMode !== undefined && d.kind === 'file' && agreedMode !== d.mode ? { overDisk: true as const } : {}),
          ...(s.mode !== undefined ? { storeMode: s.mode } : {}),
          // Refused over disk's mode, the completion records what an unforced
          // write would: the mode disk last agreed with.
          ...(agreedMode !== undefined ? { priorMode: agreedMode } : {}),
          ...(d.kind === 'file' && d.mode !== undefined ? { seenMode: d.mode } : {}),
        });
      } else result.skipped.push({ path, reason: unstoredCopy(stored) });
      continue;
    }
    if (v.mode === 'adopt' && s && d.kind === 'file') {
      // Disk's mode changed since it last agreed, on the bytes the store
      // holds, and the store's didn't. A sync takes it in. Recording disk's
      // mode here would read as the store's change, which the next push
      // would revert; forced, disk takes the store's mode, as forced bytes do.
      if (!opts.force) {
        // modeAction adopts where disk changed the mode since they agreed, and
        // where nothing records a mode they agreed on.
        const agreedMode = p?.kind === 'content' ? p.mode : undefined;
        result.skipped.push({
          path,
          reason: (agreedMode === undefined
            ? `disk's mode (${octal(d.mode!)}) differs from the workspace's (${octal(s.mode!)}), and nothing records which side changed it`
            : `disk's mode (${octal(d.mode!)}) changed since it last agreed with the workspace's (${octal(s.mode!)})`) +
            ' — sync this path to take disk\'s mode in, or materialize this path with force to apply the workspace\'s',
        });
        continue;
      }
      plans.push({ path, kind: 'chmod', mode: s.mode!, hash: s.hash, size: s.size, prior: null, before: p, expect, overDisk: true });
      continue;
    }
    // Whatever the verdict learned about disk (an agreement, a resolved
    // intent) is recorded before anything is pushed over it, and the root it
    // was learned under before that, as a pass does.
    if (v.p !== undefined) agreement.recordRootIdentity(mount.name, root.identity);
    if (v.p === 'forget') agreement.forget(mount.name, path);
    else if (v.p !== undefined) agreement.set(mount.name, path, v.p, { afterCommittedState: true });
    if (v.p !== undefined) recorded = true;
    // The prior a new intent carries is the last confirmed evidence: for a
    // path whose earlier push is unconfirmed, that push's own prior, never
    // the bytes it wrote.
    const known = v.unconfirmed ? (p as Pending).prior ?? undefined : v.p === 'forget' ? undefined : v.p !== undefined ? v.p : v.prior ?? p;
    const prior = known && (known.kind === 'absent' || known.kind === 'content') ? known : null;
    // A push that re-plans over our own narrowing push, stopped before its
    // bytes, plans from disk's narrowed mode (the verdict's prior, which
    // resolvePending leaves unrecorded), as above, and goes on as that push:
    // its intent carries the stopped push's prior, the old bytes at their own
    // mode, never the mode it narrowed them to, and modes from that mode, so a
    // stop of this push too reads disk's narrowed mode as the push's own.
    // Past the adoptions handled above, a verdict carries a prior with P still
    // pending only from that narrowing, whose push recorded its modes.
    const stopped = v.prior !== undefined && p?.kind === 'pending' ? p : undefined;
    if (v.mode === 'push' && s && d.kind === 'file') {
      // Forced, disk takes the store's mode whatever it holds now, as it takes its bytes.
      plans.push({ path, kind: 'chmod', mode: s.mode!, ...(opts.force ? {} : { from: d.mode }), hash: s.hash, size: s.size, prior, before: agreement.get(mount.name, path), expect });
      continue;
    }
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
        // An intent that can't be read is the one note fixing doesn't
        // answer: nothing is decided over it until a sync of the path
        // replaces it (decide()), and a sync replaces it only where it sees
        // disk's copy, so a copy it can't see is named first. For the rest,
        // fixing what the note names holds, and forcedWay says where force
        // does too. Where disk has deleted the file, that sync takes the
        // deletion.
        const sync = gone
          ? "sync this path to take disk's deletion, which removes the workspace's copy and replaces the intent"
          : 'sync this path to adopt the disk version, which replaces the intent';
        result.skipped.push({
          path,
          reason: bi?.unreadable !== undefined
            ? d.kind === 'absent' || d.kind === 'file'
              ? `${v.note} — ${sync}`
              : `${v.note}, and disk's copy can't be verified (${d.kind === 'unobserved' ? d.reason : 'not hashed'}) — once it can be, ${sync}`
            : inTheWay(v.note, !s) ??
              `cannot verify disk copy (${v.note ?? 'not observed'}) — fix it and ${again}${forcedWay(v.note, !s, forced)}`,
        });
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
        // Whatever was recorded, a disk with no copy now is answered for what
        // it holds; a path with no evidence still needs its push named.
        reason: gone
          ? `disk has no copy of this file (conflict: ${kind}) — ${takeDisk}, or ` +
            `materialize ${noEvidence ? 'this path' : 'it'} with force to write the workspace's copy back`
          : noEvidence
          ? `disk holds a different copy, and nothing records which is newer (conflict: ${kind}) — ` +
            `sync this path to adopt the disk version, or materialize this path with force ${s ? 'to overwrite it' : 'and applyDeletions to delete it'}`
          : kind === 'interrupted'
            ? 'disk holds bytes that match neither what was being written there nor what disk last agreed with ' +
              '(conflict: interrupted), as a write that failed or was cut off partway leaves — check the file, then ' +
              `${forced}, or sync this path to adopt the disk copy as it is`
            : `stale copy: disk changed since it last agreed with the workspace (conflict: ${kind}) — ` +
              `sync this path to adopt the disk version, or ${forced}`,
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
        // A deletion no push makes, forced or not (inTheWay), is refused for
        // that, as an unforced push refuses it, rather than left for
        // applyDeletions, which couldn't make it either.
        const lasting = inTheWay(v.note, true);
        if (lasting !== null) result.skipped.push({ path, reason: lasting });
        else result.pendingDeletions.push(path);
        continue;
      }
      if (d.kind === 'absent') continue;
      plans.push({ path, kind: 'unlink', prior, before: agreement.get(mount.name, path), expect });
      continue;
    }
    const stored = storedBytes(store, s.hash);
    if (!('bytes' in stored)) {
      result.skipped.push({ path, reason: unstoredCopy(stored) });
      continue;
    }
    const blob = stored.bytes;
    // The store's mode goes to disk with its bytes where the file is new,
    // the push is forced, or disk still has the mode they last agreed on. A
    // push that completes our own unconfirmed one, whose bytes landed, is a
    // push like any other: it gives the store's mode where disk shows one of
    // the stopped push's own (pushedMode) or the one they last agreed on, and
    // keeps any other, set since it stopped (Ada-1017, room-203 #131062,
    // #131518). A mode disk changed since stays, and so does the evidence
    // that it did, up to the moment of the write.
    const dm = d.kind === 'file' ? d.mode : undefined;
    const priorMode = prior?.kind === 'content' ? prior.mode : undefined;
    const own = v.unconfirmed === true && v.ownMode === true;
    const apply = mount.modesObserved && s.mode !== undefined && s.mode !== dm &&
      (dm === undefined || opts.force === true || own || priorMode === dm) ? s.mode : undefined;
    plans.push({
      path, kind: 'write', blob, hash: s.hash, prior: stopped ? stopped.prior : prior, before: agreement.get(mount.name, path), expect,
      // With no mode in the store's entry, its `to` is the mode the push
      // leaves, the one the stopped push narrowed to: it claims none it lacks.
      ...(stopped ? { ownModes: { from: stopped.modes!.from, to: s.mode ?? (stopped.modes!.from & stopped.modes!.to) } } : {}),
      ...(apply !== undefined ? { apply } : {}),
      ...(apply !== undefined && dm !== undefined && opts.force !== true ? { from: dm } : {}),
      // Forced over a mode disk changed: without force, the bytes would keep it.
      ...(apply !== undefined && dm !== undefined && priorMode !== dm && !own ? { overDisk: true as const } : {}),
      ...(s.mode !== undefined ? { storeMode: s.mode } : {}),
      ...(priorMode !== undefined ? { priorMode } : {}),
      ...(dm !== undefined ? { seenMode: dm } : {}),
    });
  }

  // 1. Durable intents before any disk effect, the root they write under first.
  // A chmod announces none: it leaves the bytes as they are. Stopped before
  // its completion, it leaves disk at the store's mode or still at the one
  // the evidence agreed, and the next observation decides from that: synced
  // and recorded, or pushed again. Nothing is lost either way. A forced
  // chmod has no guard: stopped before it, disk keeps whatever mode it found,
  // which the next observation reads as disk's, and forced again, it applies
  // the store's.
  if (plans.length > 0) agreement.recordRootIdentity(mount.name, root.identity);
  const announced = plans.filter((step) => step.kind !== 'chmod');
  announced.forEach((step, i) => {
    agreement.intend(mount.name, step.path, {
      effect: 'disk',
      prior: step.prior,
      expect: step.kind === 'write' ? { kind: 'content', hash: step.hash } : ABSENT,
      branchId,
      // A write whose plan gives a mode (`apply`) records the modes it may
      // leave, so a stop is read by them: the mode it saw, or for a file it
      // creates the one it creates it at, and the one it gives. A file a
      // forced push creates at its entry's mode with no mode planned records
      // none. One that goes on as our own stopped narrowing records that
      // push's, from the old bytes' own mode, whether or not it gives a mode
      // itself.
      ...(step.kind === 'write' && step.ownModes !== undefined ? { modes: step.ownModes }
        : step.kind === 'write' && step.apply !== undefined
          ? { modes: { from: step.seenMode ?? step.apply, to: step.apply } } : {}),
    }, { durable: i === announced.length - 1 });
  });

  // 2. Effects, each bound at its point of use.
  const effected: Array<{ step: Plan; dirs: string[]; mode?: number; widenRefused?: boolean; modeKept?: boolean }> = [];
  for (const step of plans) {
    opts.beforeEffect?.(step.path);
    try {
      if (step.kind === 'write') {
        const { perm, widenRefused, modeKept } = await writeContained(
          mount.view, mount.rootReal, step.path, step.blob, step.expect, step.apply, step.from, step.overDisk === true,
          // Where modes go unobserved, nothing is applied, a created file's included.
          mount.modesObserved ? step.storeMode : undefined,
        );
        effected.push({ step, dirs: chainOf(step.path), mode: perm, widenRefused, modeKept });
      } else if (step.kind === 'chmod') {
        // An inode change, made durable by the file's own fsync.
        const { refused, narrowing } = await chmodContained(mount.view, mount.rootReal, step.path, step.mode, step.expect, step.from);
        // A chmod announces no intent, so a refused one leaves the evidence
        // as planning read it, unless it says otherwise below.
        if (refused && narrowing && !step.overDisk) {
          // A narrowing of the store's own change that the kernel refused
          // stays owed, as a write's does: taking disk's wider mode in would
          // let a later write put new bytes out at it.
          result.skipped.push({
            path: step.path,
            reason: `not given the workspace's mode (${octal(step.mode)}): the kernel refused to narrow it, as it does for a file another user owns, ` +
              'so it stays owed: a retry is refused the same way until the file\'s owner or an administrator narrows it',
          });
          continue;
        }
        if (refused && step.overDisk) {
          // Forced over a mode disk changed, or one nothing records: the
          // path is as it was before the push, so a sync takes disk's mode
          // in, as it would have without force.
          result.skipped.push({
            path: step.path,
            reason: `not given the workspace's mode (${octal(step.mode)}): the kernel refused the chmod, so disk keeps its mode, and a sync takes it in`,
          });
          continue;
        }
        if (refused) {
          // A widening of the store's own change that the kernel refused:
          // disk keeps its mode, and the evidence records none, so a sync
          // takes disk's in by the rule for an unknown rather than owing a
          // mode this process can never give.
          agreement.set(mount.name, step.path, { kind: 'content', hash: step.hash, size: step.size });
          recorded = true;
          result.skipped.push({
            path: step.path,
            reason: `not given the workspace's mode (${octal(step.mode)}): the kernel refused the chmod, and a sync takes disk's mode in`,
          });
          continue;
        }
        effected.push({ step, dirs: [] });
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
        const why = inTheWay(failure.message, step.kind === 'unlink') ?? failure.message;
        result.skipped.push({ path: step.path, reason: `not ${step.kind === 'unlink' ? 'unlinked' : step.kind === 'chmod' ? 'given the workspace\'s mode' : 'written'}: ${why}` });
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
  for (const { step, dirs, mode: written, widenRefused, modeKept } of effected) {
    const mode = mount.modesObserved ? written : undefined;
    const failed = dirs.find((dir) => unsynced.has(dir));
    if (failed !== undefined) {
      result.skipped.push({
        path: step.path,
        reason: `could not make the ${step.kind === 'write' ? 'write' : 'unlink'} durable (directory fsync of ${failed === '' ? 'the mount root' : failed}): ` +
          `${unsynced.get(failed)}; the outcome is checked at the next observation`,
      });
      continue;
    }
    // The mode the evidence records: the one the push gave the file, if the
    // file has it; disk's own, where the store records none or the same; and
    // otherwise the one disk last agreed with, so a mode disk changed since
    // reads as disk's. (Where modes go unobserved, the evidence's writer
    // records none.)
    // A widening of the workspace's own change that the kernel refused
    // records none: a sync takes disk's mode in, rather than owing one this
    // process can never give. Forced over a mode disk changed, or one nothing
    // records (overDisk), any refused chmod ends where an unforced write
    // would: the evidence records the mode disk last agreed with, if any, and
    // a sync takes disk's mode in.
    const agreedMode = step.kind === 'chmod'
      ? step.mode
      : step.kind === 'write'
        ? widenRefused && !step.overDisk
          ? undefined
          : step.apply !== undefined && step.apply === mode
            ? mode
            : step.storeMode === undefined || step.storeMode === mode ? mode : step.priorMode
        : undefined;
    const value: Agreed = step.kind === 'unlink'
      ? { kind: 'absent' }
      : { kind: 'content', hash: step.hash, size: step.kind === 'write' ? step.blob.byteLength : step.size, ...(agreedMode !== undefined ? { mode: agreedMode } : {}) };
    agreement.set(mount.name, step.path, value);
    recorded = true;
    // Bytes written where the kernel refused the mode, or where disk's mode
    // changed since it last agreed, keep disk's mode, and the push says so
    // beside what it wrote: the bytes reached disk, so it's no refusal.
    if (step.kind === 'write' && widenRefused && mode !== undefined) {
      result.modesKept.push({
        path: step.path,
        reason: `written, its mode left at ${octal(mode)}: the kernel refused the chmod, ` +
          `so the workspace's (${octal(step.apply ?? step.storeMode ?? mode)}) isn't given, and a sync takes disk's mode in`,
      });
    } else if (step.kind === 'write' && modeKept && mode !== undefined) {
      // Forced over a mode disk changed, and refused: the bytes are written
      // at it, the evidence records it as an unforced write's would.
      result.modesKept.push({
        path: step.path,
        reason: `written, its mode left at ${octal(mode)}: the kernel refused to narrow it ` +
          `${narrowedTo(mode & (step.apply ?? mode), step.apply ?? mode)}, so disk keeps its mode, and a sync takes it in`,
      });
    } else if (step.kind === 'write' && mode !== undefined && step.storeMode !== undefined && mode !== step.storeMode) {
      result.modesKept.push({
        path: step.path,
        reason: (step.priorMode === undefined
          ? `written, keeping disk's mode (${octal(mode)}), which differs from the workspace's (${octal(step.storeMode)}), and nothing records which side changed it`
          : `written, keeping disk's mode (${octal(mode)}), which changed since it last agreed with the workspace's (${octal(step.storeMode)})`) +
          ' — sync this path to take disk\'s mode in, or materialize this path with force to apply the workspace\'s',
      });
    }
    const planned = store.currentBranch().id === branchId;
    if (step.kind === 'chmod') {
      result.written.push(step.path);
    } else if (step.kind === 'write') {
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

function unstoredCopy(stored: Exclude<StoredBytes, { bytes: Buffer }>): string {
  return 'missing' in stored ? 'the workspace copy is missing from the store' : `the workspace copy is unreadable in the store (${stored.unreadable})`;
}
