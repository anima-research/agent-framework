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
 * unreadable directory, an ignored subtree, the walk cap, a symlink the walk
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

/**
 * Opened with every read or write of a workspace path, where the platform has
 * it: for a regular file it changes nothing, and a FIFO or other special file
 * swapped in at the path neither blocks the open nor passes the regular-file
 * check that follows.
 */
export const NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

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
  const found = await checkRoot(view, rootReal);
  return 'dir' in found ? { identity: found.dir.identity() } : found;
}

/** The mount root as locateRoot finds it, checked, so a caller can ask later whether it's still there. */
export async function checkRoot(view: MountView, rootReal: string): Promise<{ dir: CheckedDir } | { reason: string }> {
  const found = await locateDir(view, rootReal, '');
  if (found.kind === 'checked') return { dir: found.dir };
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
 * from the root through checked directories: some directory lacks the next
 * component; or a component is a non-directory, still the same one, beneath
 * which nothing can exist. Either proves it only while every directory the
 * walk went through, the root included, is still the one its path names
 * afterwards: a root or parent replaced during the walk would otherwise lend
 * its replacement's absence to the original's path. Symlinked directories
 * inside the mount are followed as parents; any other symlink proves
 * nothing. Returns the directory whose entries prove it, or why absence
 * couldn't be shown.
 */
export async function confirmAbsent(view: MountView, rootReal: string, rel: string, target: 'entry' | 'beneath' = 'entry'): Promise<{ by: string } | string> {
  const root = await locateDir(view, rootReal, '');
  if (root.kind !== 'checked') return ROOT_UNAVAILABLE;
  let cur: CheckedDir = root.dir;
  /** Every directory the walk went through, the root first. */
  const walked: CheckedDir[] = [cur];
  const proven = async (): Promise<{ by: string } | string> => {
    for (const dir of walked) if (!(await dir.stillHere())) return CHANGED;
    return { by: cur.rel };
  };
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
      // Absent from a directory that, like each above it, is still the one its path names.
      return proven();
    }
    if (info.isDirectory()) {
      if (last) return CHANGED; // present after all
      cur = new CheckedDir(childRel, cur.at(name), lexicalOf(view, childRel), info.dev, info.ino);
      walked.push(cur);
      continue;
    }
    if (info.isSymbolicLink()) {
      if (last && target === 'entry') return CHANGED; // present: the link itself
      const located = await locateDir(view, rootReal, childRel);
      if (located.kind !== 'checked') return BENEATH_SYMLINK;
      if (last) return CHANGED; // a directory there after all
      cur = located.dir;
      walked.push(cur);
      continue;
    }
    if (last && target === 'entry') return CHANGED; // present after all
    // A non-directory: nothing can exist beneath it, while it is still this
    // same one, in the directory still at its path.
    const again = await lstat(cur.at(name), { bigint: true }).catch(() => null);
    if (again === null || again.isDirectory() || again.isSymbolicLink() || again.dev !== info.dev || again.ino !== info.ino) return CHANGED;
    return proven();
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

/** Whether a statfs f_type is one of those filesystems. */
export function fsTypeTrustsCtime(type: number | bigint): boolean {
  return CTIME_TRUSTED_FS_TYPES.has(Number(type) >>> 0);
}

export async function filesystemTrustsCtime(root: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    return fsTypeTrustsCtime((await statfs(root)).type);
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
    if (!target.isFile()) {
      return { kind: 'unobserved', reason: target.isDirectory() ? 'a symlink to a directory, not walked' : 'not a regular file' };
    }
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
    // O_NONBLOCK: a FIFO swapped in since any lstat opens at once instead of
    // waiting for a writer, and the regular-file check below refuses it.
    handle = await open(lexical, fsConstants.O_RDONLY | NONBLOCK | (noFollow ? fsConstants.O_NOFOLLOW : 0));
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
    if (!view.followSymlinks) {
      // Where no symlink is followed, the path itself must be the file the
      // descriptor holds: without O_NOFOLLOW, a link swapped in after the
      // lstat above is followed by the open.
      const entry = await lstat(lexical, { bigint: true }).catch(() => null);
      if (entry?.isSymbolicLink()) return { kind: 'unobserved', reason: NOT_FOLLOWED };
      if (entry === null || !entry.isFile() || entry.dev !== info.dev || entry.ino !== info.ino) {
        return { kind: 'unobserved', reason: 'the file changed while it was read' };
      }
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
 * Read an open file from its start, at most `limit` bytes, and whether it
 * goes on past them. Where the file ends is what the reads find: `sizeHint`,
 * the size its fstat gave, only sizes the first buffer. Once a buffer is
 * full, one byte read past it tells whether the file goes on. At the limit,
 * that byte says it does, and isn't kept. Short of it, the file has grown
 * since its fstat: the byte is kept, and the read goes on in a larger buffer,
 * up to the limit. A file that has shrunk ends where the reads find its end.
 * A fractional `limit` allows the whole bytes in it.
 */
export async function readPrefix(handle: FileHandle, limit: number, sizeHint: number): Promise<{ bytes: Buffer; more: boolean }> {
  const cap = Math.floor(limit);
  const next = Buffer.alloc(1);
  let bytes = Buffer.alloc(Math.min(cap, sizeHint));
  let length = 0;
  for (;;) {
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) return { bytes: bytes.subarray(0, length), more: false };
      length += bytesRead;
    }
    if ((await handle.read(next, 0, 1, length)).bytesRead === 0) return { bytes, more: false };
    if (length === cap) return { bytes, more: true };
    // Longer than its fstat said: read on, up to the limit.
    const grown = Buffer.alloc(Math.min(cap, Math.max(2 * length, length + 64 * 1024)));
    bytes.copy(grown, 0, 0, length);
    grown[length++] = next[0];
    bytes = grown;
  }
}

/**
 * Read and hash a mount-relative file through one located descriptor. The
 * whole file is returned when it is at most `limit` bytes, both at its fstat
 * and as read; any other file, including one that grew past `limit` since its
 * fstat, is hashed in chunks and only its head is kept.
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
    // A file within the limit at its fstat is read no further than the limit,
    // so one that has grown past it since is hashed below, from its start,
    // never loaded whole. One over the limit at its fstat is hashed below
    // without that read.
    const within = size <= limit ? await readPrefix(handle, limit, size) : null;
    if (within && !within.more) {
      const { bytes } = within;
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
  /** Regular files the walk took: the pass observes each one. */
  files: Set<string>;
  /**
   * Regular files a listing showed that the walk didn't take, past its cap
   * or outside the stretch a resumed walk covered: present, and not
   * observed by this pass.
   */
  seen: Set<string>;
  /**
   * The names in `others` that aren't ignored and that the walk took, as it
   * takes files, against its cap: the pass observes these by path. The rest
   * are present, and not observed by this pass.
   */
  othersTaken: Set<string>;
  /** Directories seen. */
  dirs: Set<string>;
  /** Names seen that are neither (symlinks, sockets…), or ignored: present, unproven. */
  others: Map<string, string>;
  /**
   * Directories whose listing the walk read whole, and that were still the
   * directory at their path once it had: every name in one is in `files`,
   * `seen`, `dirs` or `others`, so a name in none of them is absent.
   */
  complete: Set<string>;
  /** Directories that don't exist (everything beneath them is absent). */
  missing: Set<string>;
  /**
   * Where the walk didn't reach, and why. `error` and `cap` regions may hide
   * files the listing would show. An `ignored` region is passed over by
   * design: one that hides a tracked entry is reported as incomplete, and
   * one that hides nothing is counted as passed over. A `symlink` region is
   * never walked; the pass reports the link itself by path.
   */
  incomplete: Array<{ path: string; reason: string; kind: 'error' | 'cap' | 'ignored' | 'symlink' }>;
  /**
   * When the walk cap stopped the walk, the last entry it took. A walk that
   * resumes after it takes the entries after it first, in the walk's order
   * (`compareInWalk`), then wraps to the start of its scope.
   */
  stoppedAfter?: string;
}

/** Names compare by UTF-16 code unit, the same on every platform and filesystem. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Where file `a` falls against file `b` in the walk's order: in each
 * directory, its files by name, then its subdirectories by name, each with
 * everything beneath it. A resumed walk relies on visiting files in the
 * order it compares positions by, so the walk sorts each listing itself
 * rather than take `readdir`'s order, which is the platform's (Node returns
 * UTF-8 byte order on Linux, which differs from this one for some names).
 */
function compareInWalk(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; ; i++) {
    const lastX = i === x.length - 1;
    const lastY = i === y.length - 1;
    if (x[i] !== y[i]) {
      if (lastX && lastY) return compareNames(x[i]!, y[i]!);
      if (lastX) return -1; // a directory's files come before its subdirectories
      if (lastY) return 1;
      return compareNames(x[i]!, y[i]!);
    }
    if (lastX && lastY) return 0;
    if (lastX) return -1;
    if (lastY) return 1;
  }
}

/**
 * Where the subtree of directory `dir` falls against file `at` in the walk's
 * order: wholly before it, holding it (an ancestor of it), or wholly after it.
 */
function subtreeAgainst(dir: string, at: string): 'before' | 'holds' | 'after' {
  if (dir === '') return 'holds';
  const d = dir.split('/');
  const p = at.split('/');
  for (let i = 0; i < d.length; i++) {
    // `at` is a file in the directory above d[i], whose files come first.
    if (i === p.length - 1) return 'after';
    if (d[i] !== p[i]) return compareNames(d[i]!, p[i]!) < 0 ? 'before' : 'after';
  }
  return 'holds';
}

/**
 * Whether a mount's ignore list covers a mount-relative path: the path itself
 * or any directory above it, as the walk's own test reads each entry by its
 * path and name.
 */
export function coveredByIgnore(relativePath: string, patterns: string[]): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (isIgnored(segments.slice(0, i + 1).join('/'), segments[i]!, patterns)) return true;
  }
  return false;
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
 * taking up to `cap` entries in the walk's order (`compareInWalk`): files,
 * and links or other entries that aren't directories. A scope
 * that resolves outside the mount is not listed at all; beneath it, the walk
 * only descends real directories, never symlinks. Each directory's listing
 * counts only if, once listed, it is still the directory at its path: a
 * directory moved or replaced meanwhile is an incomplete region, contributing
 * no names and proving nothing absent.
 *
 * Each listing is read whole and every name in it recorded, so the files the
 * cap leaves are known present (`seen`) and a name the listing lacks is
 * proven absent, whichever files were taken. Once the cap is reached, no
 * further directory is listed.
 *
 * With `resumeAfter` (an entry in the scope, from an earlier walk's
 * `stoppedAfter`), a recursive walk takes the entries after it first, then
 * wraps to the start of the scope, so repeated walks cover a scope larger
 * than the cap.
 */
export async function walkScope(
  view: MountView, rootReal: string, scope: string, recursive: boolean, cap: number,
  opts: { named?: boolean; resumeAfter?: string } = {},
): Promise<Walk> {
  const walk: Walk = {
    files: new Set(), seen: new Set(), othersTaken: new Set(), dirs: new Set(), others: new Map(), complete: new Set(), missing: new Set(),
    incomplete: [],
  };
  const top = await checkDir(view, rootReal, scope);
  if (top.kind === 'absent') {
    walk.missing.add(scope);
    return walk;
  }
  if (top.kind === 'unobserved') {
    walk.incomplete.push({ path: scope, reason: top.outside ? 'the directory resolves outside the mount' : top.reason, kind: 'error' });
    return walk;
  }
  // A scope a path sync names is walked even where the ignore list covers
  // it: a pattern covering the scope itself, or a directory above it, doesn't
  // apply beneath it. So a named directory's contents are synced, as a named
  // file is (agent-framework #276). A listing keeps the ignore: its pass
  // would otherwise start tracking what it lists.
  const ignore = opts.named ? view.ignore.filter((pattern) => !coveredByIgnore(scope, [pattern])) : view.ignore;
  // A position outside the scope, or for a walk that doesn't descend, is no
  // position in this walk's order.
  const after = recursive && opts.resumeAfter !== undefined && (scope === '' || opts.resumeAfter.startsWith(scope + '/'))
    ? opts.resumeAfter
    : undefined;

  /** A listing's entries that aren't directories or ignored, in the walk's order, each a regular file or not. */
  type Listing = { leaves: Array<[string, boolean]>; subdirs: string[]; dev: string; ino: string };
  /**
   * Each directory is listed once: a resumed walk visits the ones holding its
   * position on both sides of it, and the second visit reuses the listing
   * while the directory at its path is still the one it was read from.
   */
  const listings = new Map<string, Listing | null>();
  const visited = new Set<string>();
  /** Paths already reported as errors, so a second visit doesn't report them again. */
  const failed = new Set<string>();
  const fail = (path: string, reason: string): void => {
    if (failed.has(path)) return;
    failed.add(path);
    walk.incomplete.push({ path, reason, kind: 'error' });
  };
  let left = cap;
  let lastTaken: string | undefined;

  /**
   * Take back what the walk read at or beneath `rel`, a directory replaced
   * or gone since it was listed: it describes the directory that was there,
   * so no listing there proves anything absent, the entries and
   * subdirectories they left untaken aren't the cap's to report, and a
   * subdirectory proven missing there proves nothing about what's there
   * now. What was taken stays taken: the pass observes it by path.
   */
  const dropBeneath = (rel: string): void => {
    const beneath = (path: string): boolean => rel === '' || path.startsWith(rel + '/');
    for (const [path, listing] of listings) {
      if (path !== rel && !beneath(path)) continue;
      if (listing) {
        for (const [leaf, isFile] of listing.leaves) if (isFile) walk.seen.delete(leaf);
        for (const sub of listing.subdirs) walk.dirs.delete(sub);
      }
      walk.complete.delete(path);
      listings.set(path, null);
    }
    // The links, ignored names and other entries those listings showed, and
    // the regions they gave rise to, described the directory that was there.
    for (const [path] of walk.others) if (beneath(path) && !walk.othersTaken.has(path)) walk.others.delete(path);
    for (let i = walk.incomplete.length - 1; i >= 0; i--) {
      const region = walk.incomplete[i]!;
      if ((region.kind === 'symlink' || region.kind === 'ignored') && beneath(region.path)) walk.incomplete.splice(i, 1);
    }
    for (const path of walk.missing) if (beneath(path)) walk.missing.delete(path);
  };

  const list = async (dir: CheckedDir): Promise<Listing | null> => {
    const rel = dir.rel;
    const known = listings.get(rel);
    if (known === null) return null;
    if (known !== undefined) {
      // The scope's own directory comes back as the same CheckedDir, so its
      // identity is checked against the path again, as a subdirectory's is
      // by the fresh check that brought it here.
      const now = dir.identity();
      if (known.dev === now.dev && known.ino === now.ino && await dir.stillHere()) return known;
      dropBeneath(rel);
      fail(rel, CHANGED_WALK);
      return null;
    }
    listings.set(rel, null);
    // Reading a directory is a check of it too, and replaces an earlier proof
    // that it was missing: the scope's own directory, read afresh on the
    // wrap, has no check of its own.
    walk.missing.delete(rel);
    let entries;
    try {
      entries = await readdir(dir.real, { withFileTypes: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Gone since it was checked: absent beneath only if that can be shown.
        const proof = rel === '' ? ROOT_UNAVAILABLE : await confirmAbsent(view, rootReal, rel, 'beneath');
        if (typeof proof === 'string') fail(rel, proof);
        else {
          walk.missing.add(rel);
          // Nothing was listed, so a later check that finds it again, on the
          // wrap, lists it afresh.
          listings.delete(rel);
        }
        return null;
      }
      fail(rel, `cannot list (${code ?? String(err)})`);
      return null;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    const leaves: Array<[string, boolean]> = [];
    const subdirs: string[] = [];
    const others: Array<[string, string]> = [];
    const regions: Walk['incomplete'] = [];
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(childRel, entry.name, ignore)) {
        others.push([childRel, 'ignored by the mount']);
        regions.push({ path: childRel, reason: 'ignored by the mount', kind: 'ignored' });
        continue;
      }
      if (entry.isDirectory()) {
        subdirs.push(childRel);
      } else if (entry.isFile()) {
        leaves.push([childRel, true]);
      } else {
        const symlink = entry.isSymbolicLink();
        leaves.push([childRel, false]);
        others.push([childRel, symlink ? 'a symlink' : 'not a regular file']);
        if (symlink) regions.push({ path: childRel, reason: 'a symlink, not walked', kind: 'symlink' });
      }
    }
    // A listing of a directory that was moved or replaced meanwhile says
    // nothing about this path: neither its names nor its absences count.
    if (!(await dir.stillHere())) {
      fail(rel, CHANGED_WALK);
      return null;
    }
    for (const [p, isFile] of leaves) if (isFile) walk.seen.add(p);
    for (const d of subdirs) walk.dirs.add(d);
    for (const [p, why] of others) walk.others.set(p, why);
    walk.incomplete.push(...regions);
    walk.complete.add(rel);
    const listing = { leaves, subdirs, ...dir.identity() };
    listings.set(rel, listing);
    return listing;
  };

  type Stretch = 'all' | 'after' | 'upto';
  const fileIn = (stretch: Stretch, file: string): boolean =>
    stretch === 'all' || (compareInWalk(file, after!) > 0) === (stretch === 'after');
  const dirIn = (stretch: Stretch, dir: string): boolean => {
    if (stretch === 'all') return true;
    const at = subtreeAgainst(dir, after!);
    return at === 'holds' || at === (stretch === 'after' ? 'after' : 'before');
  };

  const visit = async (dir: CheckedDir, stretch: Stretch): Promise<void> => {
    visited.add(dir.rel);
    const listing = await list(dir);
    if (!listing) return;
    // A link or other entry that isn't a directory is taken as a file is,
    // against the cap: the pass observes each one it takes, and following a
    // link can read as much as a file.
    for (const [leaf, isFile] of listing.leaves) {
      if (left === 0) break;
      if (!fileIn(stretch, leaf)) continue;
      left--;
      if (isFile) {
        walk.seen.delete(leaf);
        walk.files.add(leaf);
      } else {
        walk.othersTaken.add(leaf);
      }
      lastTaken = leaf;
    }
    if (!recursive) return;
    for (const sub of listing.subdirs) {
      // Once the cap is reached, no further directory is listed.
      if (left === 0) break;
      if (!dirIn(stretch, sub)) continue;
      const child = await checkChild(view, rootReal, dir, sub);
      // This check replaces what an earlier one proved of `sub` itself, such
      // as missing on the after stretch and found again on the wrap. What was
      // proven beneath a directory that is still the same one stands, and
      // list() drops it from one that isn't.
      walk.missing.delete(sub);
      if (child.kind === 'checked') {
        await visit(child.dir, stretch);
        continue;
      }
      // On the wrap, a directory listed on the first stretch that isn't the
      // directory there now: what the walk read of it describes another.
      dropBeneath(sub);
      if (child.kind === 'absent') walk.missing.add(sub);
      else fail(sub, child.reason);
    }
  };

  if (after === undefined) {
    await visit(top.dir, 'all');
  } else {
    await visit(top.dir, 'after');
    if (left > 0) await visit(top.dir, 'upto');
  }

  // What the cap left: directories holding entries not taken, and
  // directories a listing showed that weren't listed. A walk that doesn't
  // descend leaves its subdirectories by design.
  const capped = `the walk cap (${cap}) was reached`;
  const holdingUntaken = new Set<string>();
  for (const f of walk.seen) holdingUntaken.add(parentOf(f));
  for (const [p, why] of walk.others) if (why !== 'ignored by the mount' && !walk.othersTaken.has(p)) holdingUntaken.add(parentOf(p));
  for (const d of holdingUntaken) {
    walk.incomplete.push({ path: d, reason: `${capped} before everything here was taken`, kind: 'cap' });
  }
  let unlisted = 0;
  if (recursive) {
    for (const d of walk.dirs) {
      if (visited.has(d) || walk.missing.has(d) || failed.has(d)) continue;
      unlisted++;
      walk.incomplete.push({ path: d, reason: `not visited: ${capped}`, kind: 'cap' });
    }
  }
  // The cap stopped the walk only if it left something: a walk whose last
  // file used up the cap covered its scope. A directory the walk didn't list
  // counts as left, even one that holds nothing it would take (empty, or
  // only ignored names): telling them apart would take another read. Such a
  // walk keeps its place and reports the directory as not visited, and the
  // next one lists it on its way to the wrap.
  if (left === 0 && lastTaken !== undefined && (holdingUntaken.size > 0 || unlisted > 0)) walk.stoppedAfter = lastTaken;
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
      if (walk.others.has(child) || walk.seen.has(child)) return false; // present, but unproven
      if (i === parts.length - 1) return !walk.files.has(child) && !walk.dirs.has(child);
      if (!walk.dirs.has(child)) return true; // no directory there: nothing beneath can exist
    }
    dir = child;
  }
  return false;
}
