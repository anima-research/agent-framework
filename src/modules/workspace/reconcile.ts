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
 *    first; P interrupted is a sticky conflict.
 *
 * Each pass observes disk first (the only async step), then reads S, P and
 * intent and applies every decision in one synchronous step, in the agreed
 * order: intents (durable) → tree commits and intent records → completions
 * (after `store.sync()`). The caller serializes passes per mount.
 */

import { lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsStore } from '@animalabs/chronicle';
import {
  type Agreed,
  type Candidate,
  type DiskAgreement,
  type Fingerprint,
  type Interrupted,
  type Pending,
  type Physical,
  candidateOf,
  sameCandidate,
} from './disk-agreement.js';
import type { BranchIntent, BranchIntents, ConflictKind, ConflictRecord, DiskCounterpart } from './branch-intent.js';
import {
  type MountView,
  type Walk,
  effectStaysInMount,
  fingerprintVouches,
  looksBinary,
  observePath,
  provenAbsent,
  readPath,
  sniffImageMime,
  walkScope,
} from './observe.js';

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
}

export type TreeOp = 'created' | 'modified' | 'deleted';

export interface PassResult {
  /** Tree changes adopted from disk. */
  ops: Array<{ path: string; op: TreeOp }>;
  /** Conflicts recorded by this pass, with the disk change behind each. */
  newConflicts: Array<{ path: string; op: TreeOp }>;
  /** Every path the pass decided, by path. */
  reports: Map<string, PathReport>;
  /** Regions the pass couldn't observe that matter to its scope. */
  incomplete: Array<{ path: string; reason: string }>;
  /** For a directory scope: the subdirectories disk shows directly beneath it. */
  dirs: string[];
}

export interface MountRuntime {
  name: string;
  view: MountView;
  /** Canonical mount root, for symlink containment. */
  rootReal: string;
  trustsCtime: boolean;
  treeStateId: string;
  intents: BranchIntents;
  readOnly: boolean;
}

export type Scope =
  | { kind: 'paths'; paths: string[] }
  | { kind: 'dir'; dir: string; recursive: boolean };

export interface PassOptions {
  /** Rehash every file instead of trusting fingerprints (an explicit sync). */
  rehash?: boolean;
  /** Paths whose disk state is adopted explicitly (a path sync). */
  adopt?: (path: string) => boolean;
  /** Walk cap for directory scopes. */
  cap?: number;
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
    };

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
  if (!opts.rehash && p?.kind === 'content' && fingerprintVouches(p.fp, seen.fp, mount.trustsCtime)) {
    return { kind: 'file', hash: p.hash, size: seen.size, mtimeMs: seen.mtimeMs, fp: p.fp ?? null, ingestible: null };
  }
  const nothingTracked = p === undefined && !tracked.hasStore && !tracked.hasIntent;
  if (nothingTracked && seen.size > mount.view.maxFileSize) {
    // A new oversize file only needs listing: its head for the MIME type.
    const head = await readPath(mount.view, mount.rootReal, path, 0);
    if (head.kind !== 'read') return head;
    return { kind: 'file', hash: head.hash, size: head.size, mtimeMs: head.mtimeMs, fp: head.fp, ingestible: null, mimeType: sniffImageMime(head.head) };
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
    fp: mount.trustsCtime ? read.fp : null,
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
}

function keepStoreSide(hasStore: boolean, bi: BranchIntent | null): EntryState {
  if (hasStore) return 'workspace-draft';
  return bi?.tombstone ? 'workspace-deleted' : 'not-in-branch';
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
): { p: Physical | undefined; record?: Agreed | Interrupted | 'forget'; uncaptured?: true } {
  const sc: Candidate = s ? { kind: 'content', hash: s.hash } : ABSENT;
  const prior = p.prior;
  const priorCandidate = prior ? candidateOf(prior) : null;
  if (p.effect === 'disk') {
    if (sameCandidate(dc, p.expect)) {
      const agreed = p.expect.kind === 'absent' ? ({ kind: 'absent' } as Agreed) : agreedFromDisk(d);
      return { p: agreed, record: agreed };
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
    if (sameCandidate(sc, p.expect)) {
      // The tree commit landed; only the completion was lost.
      const agreed: Agreed = p.expect.kind === 'absent'
        ? { kind: 'absent' }
        : sameCandidate(dc, p.expect) ? agreedFromDisk(d) : { kind: 'content', hash: p.expect.hash, size: s!.size };
      return { p: agreed, record: agreed };
    }
    // The commit didn't land: the rule runs again from the prior evidence
    // (redoing the adoption when disk still holds what was being adopted).
    return prior ? { p: prior, record: prior } : { p: undefined, record: 'forget' };
  }
  // Another branch, whose S says nothing of whether the adoption happened
  // over there. Disk still holding the prior is D = P: the store has that
  // content. Disk holding the adopted content, or anything newer, may hold
  // the only copy of it, so this branch lists it as a conflict and nothing
  // pushes over it; P stays pending for the intent's own branch to resolve.
  if (priorCandidate && sameCandidate(dc, priorCandidate)) return { p };
  return { p, uncaptured: true };
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
  if (d.kind === 'unobserved') {
    return { state: 'unverified', note: d.reason };
  }
  const dc = diskCandidate(d)!;
  const sc: Candidate = s ? { kind: 'content', hash: s.hash } : ABSENT;

  if (adopt) {
    // An explicit path sync: the store takes disk's state, whatever the evidence.
    if (d.kind === 'absent') {
      return { state: 'synced', ...(s ? { adopt: 'remove' as const, op: 'deleted' as const } : {}), p: { kind: 'absent' }, intent: {} };
    }
    if (d.ingestible) {
      if (s && s.hash === d.hash) return { state: 'synced', p: agreedFromDisk(d), intent: {} };
      return { state: 'synced', adopt: 'ingest', op: s ? 'modified' : 'created', p: agreedFromDisk(d), intent: {} };
    }
    return { state: 'disk-only', ...(s ? { adopt: 'drop' as const, op: 'deleted' as const } : {}), p: 'forget', intent: {} };
  }

  // A pending intent resolves first; its resolution is recorded unless the
  // verdict below records newer evidence.
  let p = pIn;
  let resolution: Agreed | Interrupted | 'forget' | undefined;
  let uncaptured = false;
  if (p?.kind === 'pending') {
    const resolved = resolvePending(p, dc, s, d, branchId);
    p = resolved.p;
    resolution = resolved.record;
    uncaptured = resolved.uncaptured === true;
  }
  const verdict = (v: Verdict): Verdict => (resolution && v.p === undefined ? { ...v, p: resolution } : v);

  // Agreement settles everything, a recorded conflict included.
  if (sameCandidate(dc, sc)) {
    const settles = bi?.tombstone || bi?.conflict || bi?.origin ? { intent: {} } : {};
    if (dc.kind === 'absent') {
      return verdict({ state: 'synced', ...(p && p.kind !== 'absent' ? { p: { kind: 'absent' } as Agreed } : {}), ...settles });
    }
    const agreed = agreedFromDisk(d) as Extract<Agreed, { kind: 'content' }>;
    const recorded = p?.kind === 'content' ? p : null;
    // Re-record only when P says something else, or a fresh fingerprint can
    // replace one that no longer vouches.
    const stale = !recorded || recorded.hash !== agreed.hash || recorded.size !== agreed.size ||
      (agreed.fp !== undefined && agreed.fp !== recorded.fp);
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
      // Only disk changed since it last agreed: adopt it.
      const settles = bi ? { intent: {} } : {};
      if (d.kind === 'absent') return { state: 'synced', adopt: 'remove', op: 'deleted', p: { kind: 'absent' }, ...settles };
      if (d.ingestible) {
        return { state: 'synced', adopt: 'ingest', op: s ? 'modified' : 'created', p: agreedFromDisk(d), ...settles };
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
  const result: PassResult = { ops: [], newConflicts: [], reports: new Map(), incomplete: [], dirs: [] };

  // A missing mount root is an unavailable mount (an unmounted drive, a root
  // being replaced), not proof that every file in it was deleted.
  const rootAvailable = await lstat(mount.view.root).then((s) => s.isDirectory(), () => false);

  // Which paths to decide: what disk shows, and what the store, P and intent track.
  let walk: Walk | null = null;
  const candidates = new Set<string>();
  if (scope.kind === 'paths') {
    for (const p of scope.paths) candidates.add(p);
  } else {
    if (rootAvailable) {
      walk = await walkScope(mount.view, scope.dir, scope.recursive, opts.cap ?? WALK_CAP);
      for (const f of walk.files) if (inScope(f, scope)) candidates.add(f);
      // Ignored names are listed only when something tracks them (below).
      for (const [p, why] of walk.others) if (why !== 'ignored by the mount' && inScope(p, scope)) candidates.add(p);
      for (const d of walk.dirs) if (inScope(d, { kind: 'dir', dir: scope.dir, recursive: false })) result.dirs.push(d);
    }
    const prefix = scope.dir ? scope.dir + '/' : undefined;
    for (const e of store.treeList(mount.treeStateId, prefix)) if (inScope(e.path, scope)) candidates.add(e.path);
    for (const [p] of agreement.paths(mount.name, scope.dir)) if (inScope(p, scope)) candidates.add(p);
    for (const [p] of mount.intents.list(scope.dir)) if (inScope(p, scope)) candidates.add(p);
  }

  // Observe (async). Tracked facts are re-read synchronously when deciding.
  const facts = new Map<string, DiskFact>();
  for (const path of candidates) {
    if (!rootAvailable) {
      facts.set(path, { kind: 'unobserved', reason: 'the mount root is unavailable' });
      continue;
    }
    if (walk && provenAbsent(walk, path)) {
      facts.set(path, { kind: 'absent' });
      continue;
    }
    if (walk && !walk.files.has(path) && !walk.others.has(path)) {
      // Beneath a region the walk didn't reach: unproven either way.
      const region = walk.incomplete.find((r) => r.path === '' || path === r.path || path.startsWith(r.path + '/'));
      facts.set(path, { kind: 'unobserved', reason: region ? region.reason : 'not reached by the walk' });
      continue;
    }
    if (walk?.others.get(path) === 'ignored by the mount') {
      facts.set(path, { kind: 'unobserved', reason: 'ignored by the mount' });
      continue;
    }
    const p = agreement.get(mount.name, path);
    const hasStore = store.treeGet(mount.treeStateId, path) !== null;
    const hasIntent = mount.intents.get(path) !== null;
    facts.set(path, await learnDisk(mount, path, { p, hasStore, hasIntent }, opts));
  }

  // Decide and apply — synchronously, so nothing interleaves.
  const branchId = store.currentBranch().id;
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

  // 1. Intents for adoptions, durable before any tree commit.
  const adoptions = planned.filter((x) => x.verdict.adopt === 'ingest' || x.verdict.adopt === 'remove');
  adoptions.forEach((x, i) => {
    const prior = x.p && (x.p.kind === 'absent' || x.p.kind === 'content') ? x.p : null;
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
  }

  // 4. Completions and agreements, after the commits they assert are synced —
  // this pass's, and any earlier tool write's an agreement rests on.
  let first = true;
  for (const x of planned) {
    const next = x.verdict.p;
    if (next === undefined) continue;
    if (next === 'forget') {
      agreement.forget(mount.name, x.path); // no-op when step 2 already did
      continue;
    }
    agreement.set(mount.name, x.path, next, { afterCommittedState: first });
    first = false;
  }
  if (first && committed) store.sync();
  agreement.maybeCheckpoint();

  // Reports.
  for (const x of planned) {
    const after = mount.intents.get(x.path);
    const entry = store.treeGet(mount.treeStateId, x.path);
    const report: PathReport = { path: x.path, state: x.verdict.state };
    if (entry) report.size = entry.size;
    else if (x.d.kind === 'file') report.size = x.d.size;
    if (x.verdict.state === 'disk-only' && x.d.kind === 'file' && x.d.mimeType) report.mimeType = x.d.mimeType;
    if (x.verdict.state === 'conflict' && after?.conflict) report.conflict = conflictReport(after.conflict, x.d);
    if (x.verdict.note) report.note = x.verdict.note;
    if (!(x.verdict.state === 'synced' && !entry)) result.reports.set(x.path, report);
  }
  if (walk) {
    const tracked = [...result.reports.values()].filter((r) => r.state === 'unverified').map((r) => r.path);
    for (const region of walk.incomplete) {
      const hides = tracked.some((p) => p === region.path || p.startsWith(region.path + '/'));
      if (region.kind === 'error' || region.kind === 'cap' || hides) result.incomplete.push({ path: region.path, reason: region.reason });
    }
  }
  return result;
}

// ===========================================================================
// Store → disk
// ===========================================================================

export interface PushOptions {
  /** Overwrite (or unlink) a disk copy in conflict, or one that can't be verified. */
  force?: boolean;
  /** Unlink workspace-deleted files whose disk copy is one the store holds. */
  applyDeletions?: boolean;
  /** Called before each disk write/unlink, so the caller can suppress the watcher echo. */
  beforeEffect?: (path: string) => void;
}

export interface PushResult {
  written: string[];
  unchanged: string[];
  deleted: string[];
  /** Refused paths, each with its reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Workspace deletions left on disk because applyDeletions wasn't given. */
  pendingDeletions: string[];
}

async function fsyncPath(path: string, flags = 'r'): Promise<void> {
  let handle;
  try {
    handle = await open(path, flags);
    await handle.sync();
  } catch {
    // Directory fsync is not supported everywhere (Windows); the write stands.
  } finally {
    await handle?.close();
  }
}

/**
 * Make disk hold the store's version of each path, under the same rule:
 * drafts are written, agreement is left alone, conflicts and unverifiable
 * disk copies are refused unless `force`, and a workspace deletion reaches
 * disk only with `applyDeletions` (with `force` too when disk changed since).
 * Every write or unlink is announced by a durable intent first.
 */
export async function pushPaths(
  store: JsStore,
  agreement: DiskAgreement,
  mount: MountRuntime,
  paths: string[],
  opts: PushOptions = {},
): Promise<PushResult> {
  agreement.ensureReconciled();
  const result: PushResult = { written: [], unchanged: [], deleted: [], skipped: [], pendingDeletions: [] };
  if (mount.readOnly) return result;

  type Plan = { path: string; kind: 'write' | 'unlink'; blob: Buffer; hash: string; prior: Agreed | null } | { path: string; kind: 'unlink'; blob: null; hash: null; prior: Agreed | null };
  const plans: Plan[] = [];

  // Observe disk, and where a write or unlink would land.
  const facts = new Map<string, DiskFact>();
  const targets = new Map<string, true | string>();
  for (const path of paths) {
    const p = agreement.get(mount.name, path);
    facts.set(path, await learnDisk(mount, path, { p, hasStore: true, hasIntent: true }, {}));
    targets.set(path, await effectStaysInMount(mount.view, mount.rootReal, path));
  }
  // Not even force writes or unlinks outside the mount.
  const plan = (next: Plan): void => {
    const target = targets.get(next.path)!;
    if (target === true) plans.push(next);
    else result.skipped.push({ path: next.path, reason: `not ${next.kind === 'write' ? 'written' : 'unlinked'}: ${target}` });
  };

  // Decide synchronously what to push.
  const branchId = store.currentBranch().id;
  for (const [path, d] of facts) {
    const entry = store.treeGet(mount.treeStateId, path);
    const s = entry ? { hash: entry.blobHash, size: entry.size } : null;
    const p = agreement.get(mount.name, path);
    const bi = mount.intents.get(path);
    const v = decide(d, s, p, bi, branchId, false);
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
      if (blob) plan({ path, kind: 'write', blob, hash: s.hash, prior: priorP });
      continue;
    }
    // Whatever the verdict learned about disk (an agreement, a resolved
    // intent) is recorded before anything is pushed over it.
    if (v.p === 'forget') agreement.forget(mount.name, path);
    else if (v.p !== undefined) agreement.set(mount.name, path, v.p, { afterCommittedState: true });
    const known = v.p === 'forget' ? undefined : v.p !== undefined ? v.p : p;
    const prior = known && (known.kind === 'absent' || known.kind === 'content') ? known : null;
    if (v.state === 'synced') {
      if (v.intent !== undefined) mount.intents.put(path, v.intent);
      if (s) result.unchanged.push(path);
      continue;
    }
    if (v.state === 'unverified') {
      if (!opts.force) {
        result.skipped.push({ path, reason: `cannot verify disk copy (${v.note ?? 'not observed'}) — fix it and materialize again, or pass force to overwrite it` });
        continue;
      }
    }
    if (v.state === 'not-in-branch' || v.state === 'disk-only') continue;
    if (v.state === 'conflict' && !opts.force) {
      const kind = bi?.conflict?.kind ?? v.conflict ?? 'both-changed';
      if (v.conflict) {
        mount.intents.update(path, (cur) => ({ ...cur, conflict: { kind: v.conflict!, at: Date.now(), disk: counterpartOf(store, d) } }));
      }
      result.skipped.push({
        path,
        reason: `stale copy: disk changed since it last agreed with the workspace (conflict: ${kind}) — ` +
          'sync this path to adopt the disk version, or pass force to overwrite it',
      });
      continue;
    }
    if (!s) {
      // Only a deliberate workspace deletion ever unlinks; a file that is
      // merely absent from this branch is never deleted from disk.
      if (!bi?.tombstone) continue;
      if (!opts.applyDeletions) {
        result.pendingDeletions.push(path);
        continue;
      }
      if (d.kind === 'absent') continue;
      plan({ path, kind: 'unlink', blob: null, hash: null, prior });
      continue;
    }
    const blob = store.getBlob(s.hash);
    if (!blob) {
      result.skipped.push({ path, reason: 'the workspace copy is missing from the store' });
      continue;
    }
    plan({ path, kind: 'write', blob, hash: s.hash, prior });
  }

  // 1. Durable intents before any disk effect.
  plans.forEach((step, i) => {
    agreement.intend(mount.name, step.path, {
      effect: 'disk',
      prior: step.prior,
      expect: step.kind === 'write' ? { kind: 'content', hash: step.hash! } : ABSENT,
      branchId,
    }, { durable: i === plans.length - 1 });
  });

  // 2. Effects, each made durable before its completion.
  for (const step of plans) {
    const absolute = join(mount.view.root, step.path);
    opts.beforeEffect?.(step.path);
    try {
      if (step.kind === 'write') {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, step.blob!);
        await fsyncPath(absolute, 'r+');
        await fsyncPath(dirname(absolute));
      } else {
        await unlink(absolute).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
        await fsyncPath(dirname(absolute));
      }
    } catch (err) {
      // The intent stays pending; the next observation resolves it.
      result.skipped.push({ path: step.path, reason: `disk ${step.kind} failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    // 3. Completion, and the branch intent it settles.
    if (step.kind === 'write') {
      const seen = await readPath(mount.view, mount.rootReal, step.path, mount.view.maxFileSize);
      const value: Agreed = seen.kind === 'read' && seen.hash === step.hash
        ? { kind: 'content', hash: step.hash!, size: seen.size, fp: seen.fp }
        : { kind: 'content', hash: step.hash!, size: step.blob!.byteLength };
      agreement.set(mount.name, step.path, value);
      mount.intents.update(step.path, (cur) => { const next = { ...cur }; delete next.conflict; delete next.origin; return next; });
      result.written.push(step.path);
    } else {
      agreement.set(mount.name, step.path, { kind: 'absent' });
      mount.intents.put(step.path, null);
      result.deleted.push(step.path);
    }
  }
  agreement.maybeCheckpoint();
  return result;
}
