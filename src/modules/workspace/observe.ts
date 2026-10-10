/**
 * How the workspace observes disk for reconciliation, under the mount's
 * boundary.
 *
 * Observation honors the boundary the way openContainedFile does: the lexical
 * path is lstat'd first, a symlink is refused unless the mount follows
 * symlinks, and a followed one must resolve inside the canonical mount root.
 * Anything that isn't a regular file inside the mount is `unobserved` — it
 * proves nothing either way, and reconciliation leaves the path alone.
 *
 * Reads go through one descriptor that is fstat'd, located inside the mount
 * and then read, so what is read and the fingerprint recorded with its hash
 * describe the same file, inside the mount. A hard link is a name inside the
 * mount like any other, and reading through it shows what that path holds;
 * only a write in place reaches a file's other names, so effects.ts refuses
 * that instead.
 *
 * Directories are checked (CheckedDir): located inside the mount, with their
 * identity, and what they showed — a listing, an absence — is accepted only
 * if each is still the directory its logical path names afterwards. A walk records which
 * directories it listed completely, and only those prove a file absent: an
 * unreadable directory, an ignored subtree, the file cap, a symlink the walk
 * doesn't descend, or a directory that changed while it was listed leave
 * everything beneath them unproven. Outside a walk, absence is proven the
 * same way: by a directory inside the mount, still at its path, that lacks
 * the entry (confirmAbsent). A missing parent alone proves nothing, since a
 * dangling symlink or a swapped directory looks just like one.
 *
 * Each check is made where the operation happens, against what is there at
 * that moment, so the boundary holds against what is in the mount, including
 * what appears while an operation runs. Node has no openat or fdopendir, so
 * a directory is checked by its canonical path and identity, not held open:
 * a parent replaced concurrently in the window between a check and its use
 * (or replaced and restored around it) can still redirect a listing or
 * lookup there. File contents are bound regardless: a file is read only
 * through a descriptor bound to its path first.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { sameRootIdentity, type Fingerprint, type RootIdentity } from './disk-agreement.js';

export interface MountView {
  /** Mount root as configured. */
  root: string;
  /**
   * The root directory disk last agreed under, once the mount has evidence.
   * A root that resolves to any other directory is unavailable.
   */
  rootIdentity?: RootIdentity;
  followSymlinks: boolean;
  /** Text above this size is not ingested. */
  maxFileSize: number;
  ignore: string[];
}

export type StatFingerprint = Omit<Fingerprint, 'hashedAt'>;

export type Observation =
  | { kind: 'absent' }
  | { kind: 'file'; size: number; mtimeMs: number; fp: StatFingerprint }
  | { kind: 'unobserved'; reason: string };

export interface ReadResult {
  kind: 'read';
  size: number;
  mtimeMs: number;
  fp: Fingerprint;
  hash: string;
  /** The whole file, when it is at most the requested limit. */
  bytes: Buffer | null;
  /** First bytes, for binary detection and MIME sniffing. */
  head: Buffer;
}

/** The first bytes of a file and its size: nothing else was read or hashed. */
export interface HeadResult {
  kind: 'head';
  size: number;
  mtimeMs: number;
  head: Buffer;
}

/** Bytes hashed per read when streaming a file larger than the read limit. */
const HASH_CHUNK = 1 << 20;
/** Bytes kept for binary detection and MIME sniffing. */
export const HEAD_BYTES = 8192;
/** Timestamps this close to the hashing time can't vouch for the bytes. */
export const RACY_WINDOW_MS = 2000;

export const OUTSIDE_PARENT = 'a parent directory resolves outside the mount';
export const NOT_FOLLOWED = 'a symlink, which this mount does not follow';
export const ROOT_UNAVAILABLE = 'the mount root is unavailable';
export const ROOT_REPLACED =
  'the mount root is not the directory disk last agreed with (an unmounted drive, or a replaced directory): ' +
  'reconnect it; if it was replaced on purpose, sync the mount with acceptRoot to take it as it is now';
const CHANGED = 'it changed while it was observed';
const CHANGED_WALK = 'the directory changed while the walk ran';
const BENEATH_SYMLINK = 'beneath a symlink that does not lead to a directory inside the mount';

export function errno(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export function contained(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

/** The mount-relative parent of a path ('' for the root). */
export function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
}

/** The last component of a mount-relative path. */
export function nameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

function lexicalOf(view: MountView, rel: string): string {
  return rel === '' ? view.root : join(view.root, rel);
}

// ===========================================================================
// Checked directories
// ===========================================================================

export type DirCheck =
  | { kind: 'checked'; dir: CheckedDir }
  /**
   * No directory there, proven: nothing can exist beneath the path. `by` is
   * the directory whose entries prove it — the one that lacks it, or that
   * holds the non-directory in its place.
   */
  | { kind: 'absent'; by: string }
  /** Unproven either way; `outside` when it resolves outside the mount. */
  | { kind: 'unobserved'; reason: string; outside?: true };

/** Errors meaning a directory can't be synced on this filesystem, not that syncing it failed. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP']);

/**
 * A directory inside the mount, as it was checked: its canonical path and
 * its identity. Its entries are named through that path, and what it showed
 * is accepted only while it is still the directory its logical path names
 * (see the module doc for what that does and doesn't bind).
 */
export class CheckedDir {
  constructor(
    /** Mount-relative path ('' for the root). */
    readonly rel: string,
    /** Its canonical location when checked. */
    readonly real: string,
    private readonly lexical: string,
    private readonly dev: bigint,
    private readonly ino: bigint,
  ) {}

  /** Which directory it is. */
  identity(): RootIdentity {
    return { dev: String(this.dev), ino: String(this.ino) };
  }

  /** A path that reaches `name` in this directory. */
  at(name: string): string {
    return join(this.real, name);
  }

  /** Whether it is still the directory its logical path names: same location, same directory. */
  async stillHere(): Promise<boolean> {
    if ((await realpath(this.lexical).catch(() => null)) !== this.real) return false;
    const info = await lstat(this.real, { bigint: true }).catch(() => null);
    return info !== null && info.isDirectory() && info.dev === this.dev && info.ino === this.ino;
  }

  /**
   * Make its entries durable: this very directory, never one that replaced
   * it at its path. Throws if it can't; a filesystem that can't sync
   * directories (or Windows, where a directory can't be opened for it) is
   * not a failure.
   */
  async sync(): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(this.real, 'r');
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isDirectory() || info.dev !== this.dev || info.ino !== this.ino) throw new Error(CHANGED);
      try {
        await handle.sync();
      } catch (err) {
        if (!DIRECTORY_SYNC_UNSUPPORTED.has(errno(err) ?? '')) throw err;
      }
    } finally {
      await handle.close();
    }
  }
}

/** Check the directory at a canonical location, if one is there. */
async function checkedAt(view: MountView, rel: string, real: string): Promise<CheckedDir | null> {
  const info = await lstat(real, { bigint: true }).catch(() => null);
  if (!info?.isDirectory()) return null;
  return new CheckedDir(rel, real, lexicalOf(view, rel), info.dev, info.ino);
}

/**
 * Where a mount directory is now: checked; missing — nothing there, or not a
 * directory, either way for confirmAbsent to prove; or not inside the mount.
 */
async function locateDir(view: MountView, rootReal: string, rel: string): Promise<DirCheck | { kind: 'missing' }> {
  const lexical = lexicalOf(view, rel);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return rel === '' ? { kind: 'unobserved', reason: ROOT_UNAVAILABLE } : { kind: 'missing' };
    return { kind: 'unobserved', reason: `cannot resolve the directory (${code ?? String(err)})` };
  }
  if (rel === '') {
    // The root is whatever the configured path names, and it must still be
    // the root the pass was given.
    if (real !== rootReal) return { kind: 'unobserved', reason: ROOT_UNAVAILABLE };
  } else if (!contained(rootReal, real)) {
    return { kind: 'unobserved', reason: OUTSIDE_PARENT, outside: true };
  }
  const checked = await checkedAt(view, rel, real);
  if (checked) {
    // A root that isn't the directory disk last agreed under proves nothing
    // about the files that agreed: an empty mountpoint where a drive was
    // would otherwise read as every file deleted.
    if (rel === '' && view.rootIdentity && !sameRootIdentity(checked.identity(), view.rootIdentity)) {
      return { kind: 'unobserved', reason: ROOT_REPLACED };
    }
    return { kind: 'checked', dir: checked };
  }
  return rel === '' ? { kind: 'unobserved', reason: ROOT_UNAVAILABLE } : { kind: 'missing' };
}

/**
 * The mount root as it is now: its identity if it is available (a directory,
 * the one the pass was given, and the one disk last agreed under), else why not.
 */
export async function locateRoot(view: MountView, rootReal: string): Promise<{ identity: RootIdentity } | { reason: string }> {
  const found = await locateDir(view, rootReal, '');
  if (found.kind === 'checked') return { identity: found.dir.identity() };
  return { reason: found.kind === 'unobserved' ? found.reason : ROOT_UNAVAILABLE };
}

/**
 * Check the directory at a mount-relative path. With `create`, missing
 * directories are made one at a time beneath the deepest one that exists;
 * the mount root itself is never created (a missing root is an unavailable
 * mount). Without it, a missing directory is `absent` only where that can be
 * proven (confirmAbsent).
 */
export async function checkDir(view: MountView, rootReal: string, rel: string, opts: { create?: boolean } = {}): Promise<DirCheck> {
  const found = await locateDir(view, rootReal, rel);
  if (found.kind !== 'missing') return found;
  if (opts.create) return createDir(view, rootReal, rel);
  const proof = await confirmAbsent(view, rootReal, rel, 'beneath');
  return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent', by: proof.by };
}

async function createDir(view: MountView, rootReal: string, rel: string): Promise<DirCheck> {
  const parts = rel.split('/');
  let base: CheckedDir | null = null;
  let depth = parts.length - 1;
  for (; depth >= 0; depth--) {
    const found = await locateDir(view, rootReal, parts.slice(0, depth).join('/'));
    if (found.kind === 'checked') {
      base = found.dir;
      break;
    }
    if (found.kind !== 'missing') return found;
  }
  if (base === null) return { kind: 'unobserved', reason: ROOT_UNAVAILABLE };
  for (let i = depth; i < parts.length; i++) {
    const childRel = parts.slice(0, i + 1).join('/');
    try {
      await mkdir(base.at(parts[i]!));
    } catch (err) {
      const code = errno(err);
      if (code !== 'EEXIST') return { kind: 'unobserved', reason: `cannot create the directory ${childRel} (${code ?? String(err)})` };
    }
    // Made, or there already (made meanwhile, or not a directory): it must
    // be a real directory now, never a symlink or file in its place.
    const checked = await checkedAt(view, childRel, base.at(parts[i]!));
    if (!checked) return { kind: 'unobserved', reason: 'a parent path is not a directory' };
    base = checked;
  }
  return { kind: 'checked', dir: base };
}

/**
 * Prove that nothing exists at a mount-relative path (`entry`), or that no
 * directory does, so nothing can exist beneath it (`beneath`). Walking down
 * from the root through checked directories: some directory, still the one its
 * path names afterwards, lacks the next component; or a component is a
 * non-directory, still the same one in a directory still at its path,
 * beneath which nothing can exist. Symlinked directories inside the mount
 * are followed as parents; any other symlink proves nothing. Returns the
 * directory whose entries prove it, or why absence couldn't be shown.
 */
export async function confirmAbsent(view: MountView, rootReal: string, rel: string, target: 'entry' | 'beneath' = 'entry'): Promise<{ by: string } | string> {
  const root = await locateDir(view, rootReal, '');
  if (root.kind !== 'checked') return ROOT_UNAVAILABLE;
  let cur: CheckedDir = root.dir;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const last = i === parts.length - 1;
    const childRel = parts.slice(0, i + 1).join('/');
    let info;
    try {
      info = await lstat(cur.at(name), { bigint: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOTDIR') return CHANGED;
      if (code !== 'ENOENT') return `cannot stat (${code ?? String(err)})`;
      // Absent from the directory that is still the one its path names.
      return (await cur.stillHere()) ? { by: cur.rel } : CHANGED;
    }
    if (info.isDirectory()) {
      if (last) return CHANGED; // present after all
      cur = new CheckedDir(childRel, cur.at(name), lexicalOf(view, childRel), info.dev, info.ino);
      continue;
    }
    if (info.isSymbolicLink()) {
      if (last && target === 'entry') return CHANGED; // present: the link itself
      const located = await locateDir(view, rootReal, childRel);
      if (located.kind !== 'checked') return BENEATH_SYMLINK;
      if (last) return CHANGED; // a directory there after all
      cur = located.dir;
      continue;
    }
    if (last && target === 'entry') return CHANGED; // present after all
    // A non-directory: nothing can exist beneath it, while it is still this
    // same one, in the directory still at its path.
    const again = await lstat(cur.at(name), { bigint: true }).catch(() => null);
    if (again === null || again.isDirectory() || again.isSymbolicLink() || again.dev !== info.dev || again.ino !== info.ino) return CHANGED;
    return (await cur.stillHere()) ? { by: cur.rel } : CHANGED;
  }
  return CHANGED;
}

async function absence(view: MountView, rootReal: string, rel: string): Promise<Exclude<Observation, { kind: 'file' }>> {
  const proof = await confirmAbsent(view, rootReal, rel);
  return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent' };
}

// ===========================================================================
// Fingerprints
// ===========================================================================

function statFingerprint(st: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint }): StatFingerprint {
  return {
    size: Number(st.size),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
    ino: st.ino.toString(),
    dev: st.dev.toString(),
  };
}

/** Same file, same bytes, as far as stat can tell. */
export function sameFingerprint(a: StatFingerprint, b: StatFingerprint): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev;
}

/**
 * Whether a recorded fingerprint vouches that the current file still holds
 * the bytes hashed with it: the filesystem maintains ctime (so no user-space
 * tool can restore the old stamps after a write), every field matches, and
 * the file's timestamps were already more than the racy window old when it
 * was hashed (a write in the same timestamp tick can't hide behind them).
 * Device and inode are part of it, so a stat that reached another file — a
 * path whose parent was swapped, say — can never vouch for P's bytes.
 */
export function fingerprintVouches(recorded: Fingerprint | undefined, current: StatFingerprint, trusted: boolean): boolean {
  if (!trusted || !recorded || !sameFingerprint(recorded, current)) return false;
  const newest = Math.max(Number(BigInt(current.mtimeNs) / 1_000_000n), Number(BigInt(current.ctimeNs) / 1_000_000n));
  return recorded.hashedAt - newest > RACY_WINDOW_MS;
}

/**
 * Linux filesystems known to maintain ctime on every content write (statfs
 * f_type). Elsewhere a fingerprint can't vouch, and every observation rehashes.
 */
const CTIME_TRUSTED_FS_TYPES = new Set<number>([
  0xef53, // ext2/ext3/ext4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x01021994, // tmpfs
  0xf2f52010, // f2fs
  0x2fc12fc1, // zfs
  0x794c7630, // overlayfs
]);

export async function filesystemTrustsCtime(root: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const info = await statfs(root);
    return CTIME_TRUSTED_FS_TYPES.has(Number(info.type) >>> 0);
  } catch {
    return false;
  }
}

// ===========================================================================
// Paths and files
// ===========================================================================

/**
 * Where a path's parent directory canonically lies: inside the mount, gone
 * (absence is then proven separately), or somewhere a no-follow open would
 * still reach through — O_NOFOLLOW guards only the final component.
 */
async function parentPlacement(rootReal: string, lexical: string): Promise<'inside' | 'gone' | { reason: string }> {
  try {
    const parent = await realpath(dirname(lexical));
    return contained(rootReal, parent) ? 'inside' : { reason: OUTSIDE_PARENT };
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    return { reason: `cannot resolve the parent directory (${code ?? String(err)})` };
  }
}

/**
 * Observe a mount-relative path without reading it. A `file` here is only a
 * stat — anything decided on its bytes is read through a located descriptor,
 * or vouched for by a fingerprint of the very inode P was recorded from — so
 * only `absent` needs proof beyond the path lookup, and gets it.
 */
export async function observePath(view: MountView, rootReal: string, relativePath: string): Promise<Observation> {
  const lexical = join(view.root, relativePath);
  const placement = await parentPlacement(rootReal, lexical);
  if (placement === 'gone') return absence(view, rootReal, relativePath);
  if (placement !== 'inside') return { kind: 'unobserved', reason: placement.reason };
  let info;
  try {
    info = await lstat(lexical, { bigint: true });
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot stat (${code ?? String(err)})` };
  }
  if (info.isSymbolicLink()) {
    if (!view.followSymlinks) return { kind: 'unobserved', reason: NOT_FOLLOWED };
    let target;
    try {
      target = await stat(lexical, { bigint: true });
    } catch (err) {
      return { kind: 'unobserved', reason: `a symlink whose target cannot be read (${errno(err) ?? String(err)})` };
    }
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (err) {
      return { kind: 'unobserved', reason: `a symlink that cannot be resolved (${errno(err) ?? String(err)})` };
    }
    if (!contained(rootReal, real)) return { kind: 'unobserved', reason: 'a symlink that leaves the mount' };
    if (!target.isFile()) return { kind: 'unobserved', reason: 'not a regular file' };
    info = target;
  } else if (info.isDirectory()) {
    return { kind: 'unobserved', reason: 'a directory' };
  } else if (!info.isFile()) {
    return { kind: 'unobserved', reason: 'not a regular file' };
  }
  return { kind: 'file', size: Number(info.size), mtimeMs: Number(info.mtimeMs), fp: statFingerprint(info) };
}

/**
 * Open a mount-relative file for reading, located: a regular file that
 * canonically lies inside the mount — whatever the symlink policy, since a
 * symlinked parent escapes O_NOFOLLOW — and is the file the canonical path
 * names now. The handle is the caller's to close.
 */
async function openContained(
  view: MountView,
  rootReal: string,
  relativePath: string,
): Promise<{ handle: FileHandle; info: BigIntStats } | Exclude<Observation, { kind: 'file' }>> {
  const lexical = join(view.root, relativePath);
  const noFollow = !view.followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number';
  if (!view.followSymlinks && !noFollow) {
    // No O_NOFOLLOW (Windows): refuse a symlink by lstat before opening.
    const seen = await observePath(view, rootReal, relativePath);
    if (seen.kind !== 'file') return seen;
  }
  let handle;
  try {
    handle = await open(lexical, fsConstants.O_RDONLY | (noFollow ? fsConstants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return absence(view, rootReal, relativePath);
    if (code === 'ELOOP' && !view.followSymlinks) return { kind: 'unobserved', reason: NOT_FOLLOWED };
    if (code === 'EISDIR') return { kind: 'unobserved', reason: 'a directory' };
    return { kind: 'unobserved', reason: `cannot open (${code ?? String(err)})` };
  }
  let keep = false;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return { kind: 'unobserved', reason: info.isDirectory() ? 'a directory' : 'not a regular file' };
    const real = await realpath(lexical).catch(() => null);
    if (real === null) return { kind: 'unobserved', reason: 'the file changed while it was read' };
    if (!contained(rootReal, real)) {
      return { kind: 'unobserved', reason: view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT };
    }
    const named = await stat(real, { bigint: true }).catch(() => null);
    if (named === null || named.dev !== info.dev || named.ino !== info.ino) {
      return { kind: 'unobserved', reason: 'the file changed while it was read' };
    }
    keep = true;
    return { handle, info };
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot read (${code ?? String(err)})` };
  } finally {
    if (!keep) await handle.close();
  }
}

/**
 * Read and hash a mount-relative file through one located descriptor. The
 * whole file is returned when it is at most `limit` bytes; larger files are
 * hashed in chunks and only their head is kept.
 */
export async function readPath(
  view: MountView,
  rootReal: string,
  relativePath: string,
  limit: number,
): Promise<ReadResult | Exclude<Observation, { kind: 'file' }>> {
  const opened = await openContained(view, rootReal, relativePath);
  if (!('handle' in opened)) return opened;
  const { handle, info } = opened;
  try {
    const hashedAt = Date.now();
    const size = Number(info.size);
    const fp: Fingerprint = { ...statFingerprint(info), hashedAt };
    if (size <= limit) {
      const bytes = await handle.readFile();
      return {
        kind: 'read',
        size: bytes.byteLength,
        mtimeMs: Number(info.mtimeMs),
        fp: { ...fp, size: bytes.byteLength },
        hash: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        head: bytes.subarray(0, HEAD_BYTES),
      };
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(HASH_CHUNK);
    let head: Buffer | null = null;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK, offset);
      if (bytesRead === 0) break;
      if (head === null) head = Buffer.from(chunk.subarray(0, Math.min(bytesRead, HEAD_BYTES)));
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return {
      kind: 'read',
      size: offset,
      mtimeMs: Number(info.mtimeMs),
      fp: { ...fp, size: offset },
      hash: hash.digest('hex'),
      bytes: null,
      head: head ?? Buffer.alloc(0),
    };
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT') return absence(view, rootReal, relativePath);
    return { kind: 'unobserved', reason: `cannot read (${code ?? String(err)})` };
  } finally {
    await handle.close();
  }
}

/**
 * The first bytes of a mount-relative file and its size, through the same
 * located descriptor as readPath — for listing a file nothing tracks, which
 * needs a MIME type, not a hash.
 */
export async function readHead(
  view: MountView,
  rootReal: string,
  relativePath: string,
): Promise<HeadResult | Exclude<Observation, { kind: 'file' }>> {
  const opened = await openContained(view, rootReal, relativePath);
  if (!('handle' in opened)) return opened;
  const { handle, info } = opened;
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return { kind: 'head', size: Number(info.size), mtimeMs: Number(info.mtimeMs), head: head.subarray(0, bytesRead) };
  } catch (err) {
    return { kind: 'unobserved', reason: `cannot read (${errno(err) ?? String(err)})` };
  } finally {
    await handle.close();
  }
}

/** Null bytes in the first 8 KB: the store holds text only from disk. */
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, HEAD_BYTES).includes(0);
}

/** Image MIME type from magic bytes, for listing disk-only files. */
export function sniffImageMime(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

// ===========================================================================
// Walks
// ===========================================================================

export interface Walk {
  /** Regular files seen. */
  files: Set<string>;
  /** Directories seen. */
  dirs: Set<string>;
  /** Names seen that are neither (symlinks, sockets…), or ignored: present, unproven. */
  others: Map<string, string>;
  /** Directories listed completely. */
  complete: Set<string>;
  /** Directories that don't exist (everything beneath them is absent). */
  missing: Set<string>;
  /**
   * Where the walk didn't reach, and why. `error` and `cap` regions may hide
   * files the listing would show; `ignored` and `symlink` ones matter only
   * where tracked entries lie beneath them.
   */
  incomplete: Array<{ path: string; reason: string; kind: 'error' | 'cap' | 'ignored' | 'symlink' }>;
}

/** Simple ignore patterns, as the watcher and the old walk read them. */
export function isIgnored(relativePath: string, name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (relativePath === prefix || relativePath.startsWith(prefix + '/')) return true;
    }
    if (!pattern.includes('/') && relativePath === pattern) return true;
    if (pattern.startsWith('*.') && name.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * A subdirectory a checked directory's listing showed, checked in turn: still a
 * real directory beneath that same directory. One that became a symlink or a
 * file since is never followed, and proves nothing.
 */
async function checkChild(view: MountView, rootReal: string, parent: CheckedDir, rel: string): Promise<DirCheck> {
  const real = parent.at(nameOf(rel));
  let info;
  try {
    info = await lstat(real, { bigint: true });
  } catch (err) {
    if (errno(err) !== 'ENOENT') return { kind: 'unobserved', reason: `cannot stat (${errno(err) ?? String(err)})` };
    const proof = await confirmAbsent(view, rootReal, rel, 'beneath');
    return typeof proof === 'string' ? { kind: 'unobserved', reason: proof } : { kind: 'absent', by: proof.by };
  }
  if (!info.isDirectory()) return { kind: 'unobserved', reason: CHANGED_WALK };
  return { kind: 'checked', dir: new CheckedDir(rel, real, lexicalOf(view, rel), info.dev, info.ino) };
}

/**
 * List a directory scope ('' for the mount root), descending when recursive,
 * up to `cap` files in total. A scope that resolves outside the mount is not
 * listed at all; beneath it, the walk only descends real directories, never
 * symlinks. Each directory's listing counts only if, once listed, it is still
 * the directory at its path: a directory moved or replaced meanwhile is an
 * incomplete region, contributing no names and proving nothing absent.
 */
export async function walkScope(view: MountView, rootReal: string, scope: string, recursive: boolean, cap: number): Promise<Walk> {
  const walk: Walk = { files: new Set(), dirs: new Set(), others: new Map(), complete: new Set(), missing: new Set(), incomplete: [] };
  const top = await checkDir(view, rootReal, scope);
  if (top.kind === 'absent') {
    walk.missing.add(scope);
    return walk;
  }
  if (top.kind === 'unobserved') {
    walk.incomplete.push({ path: scope, reason: top.outside ? 'the directory resolves outside the mount' : top.reason, kind: 'error' });
    return walk;
  }
  let capped = false;

  const visit = async (dir: CheckedDir): Promise<void> => {
    const rel = dir.rel;
    if (capped) {
      walk.incomplete.push({ path: rel, reason: `not visited: the file cap (${cap}) was reached`, kind: 'cap' });
      return;
    }
    let entries;
    try {
      entries = await readdir(dir.real, { withFileTypes: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Gone since it was checked: absent beneath only if that can be shown.
        const proof = rel === '' ? ROOT_UNAVAILABLE : await confirmAbsent(view, rootReal, rel, 'beneath');
        if (typeof proof === 'string') walk.incomplete.push({ path: rel, reason: proof, kind: 'error' });
        else walk.missing.add(rel);
        return;
      }
      walk.incomplete.push({ path: rel, reason: `cannot list (${code ?? String(err)})`, kind: 'error' });
      return;
    }
    const files: string[] = [];
    const subdirs: string[] = [];
    const others: Array<[string, string]> = [];
    const regions: Walk['incomplete'] = [];
    let reachedCap = false;
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(childRel, entry.name, view.ignore)) {
        others.push([childRel, 'ignored by the mount']);
        regions.push({ path: childRel, reason: 'ignored by the mount', kind: 'ignored' });
        continue;
      }
      if (entry.isDirectory()) {
        subdirs.push(childRel);
      } else if (entry.isFile()) {
        if (walk.files.size + files.length >= cap) {
          capped = true;
          reachedCap = true;
          regions.push({ path: rel, reason: `the file cap (${cap}) was reached`, kind: 'cap' });
          break;
        }
        files.push(childRel);
      } else {
        const symlink = entry.isSymbolicLink();
        others.push([childRel, symlink ? 'a symlink' : 'not a regular file']);
        if (symlink) regions.push({ path: childRel, reason: 'a symlink, not walked', kind: 'symlink' });
      }
    }
    // A listing of a directory that was moved or replaced meanwhile says
    // nothing about this path: neither its names nor its absences count.
    if (!(await dir.stillHere())) {
      walk.incomplete.push({ path: rel, reason: CHANGED_WALK, kind: 'error' });
      return;
    }
    for (const f of files) walk.files.add(f);
    for (const d of subdirs) walk.dirs.add(d);
    for (const [p, why] of others) walk.others.set(p, why);
    walk.incomplete.push(...regions);
    if (reachedCap) return;
    walk.complete.add(rel);
    if (!recursive) return;
    for (const sub of subdirs) {
      const child = await checkChild(view, rootReal, dir, sub);
      if (child.kind === 'checked') await visit(child.dir);
      else if (child.kind === 'absent') walk.missing.add(sub);
      else walk.incomplete.push({ path: sub, reason: child.reason, kind: 'error' });
    }
  };

  await visit(top.dir);
  return walk;
}

/**
 * Whether the walk proves nothing exists at `path`: some ancestor directory
 * is missing, or a completely listed ancestor holds no entry that could lead
 * to it. Ancestors outside the walked scope are passed through, so a walk of
 * `a/b` decides paths beneath `a/b` and nothing else.
 */
export function provenAbsent(walk: Walk, path: string): boolean {
  const parts = path.split('/');
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    if (walk.missing.has(dir)) return true;
    const child = dir ? `${dir}/${parts[i]}` : parts[i]!;
    if (walk.complete.has(dir)) {
      if (walk.others.has(child)) return false; // present, but unproven
      if (i === parts.length - 1) return !walk.files.has(child) && !walk.dirs.has(child);
      if (!walk.dirs.has(child)) return true; // no directory there: nothing beneath can exist
    }
    dir = child;
  }
  return false;
}
