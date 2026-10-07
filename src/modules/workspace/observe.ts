/**
 * How the workspace observes disk for reconciliation.
 *
 * Observation honors the mount's boundary the way openContainedFile does: the
 * lexical path is lstat'd first, a symlink is refused unless the mount follows
 * symlinks, and a followed one must resolve inside the canonical mount root.
 * Anything that isn't a regular file inside the mount is `unobserved` — it
 * proves nothing either way, and reconciliation leaves the path alone.
 *
 * Reads go through one descriptor that is fstat'd and then read, so the
 * fingerprint recorded with a hash describes the bytes that were hashed.
 *
 * A walk records which directories it listed completely. Only those prove a
 * file absent: an unreadable directory, an ignored subtree, the file cap or a
 * symlink the mount doesn't follow leave everything beneath them unproven.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, statfs } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Fingerprint } from './disk-agreement.js';

export interface MountView {
  /** Mount root as configured. */
  root: string;
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

/** Bytes hashed per read when streaming a file larger than the read limit. */
const HASH_CHUNK = 1 << 20;
/** Timestamps this close to the hashing time can't vouch for the bytes. */
export const RACY_WINDOW_MS = 2000;

function errno(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function contained(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

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

/** Observe a mount-relative path without reading it. */
export async function observePath(view: MountView, rootReal: string, relativePath: string): Promise<Observation> {
  const lexical = join(view.root, relativePath);
  let info;
  try {
    info = await lstat(lexical, { bigint: true });
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unobserved', reason: `cannot stat (${code ?? String(err)})` };
  }
  if (info.isSymbolicLink()) {
    if (!view.followSymlinks) return { kind: 'unobserved', reason: 'a symlink, which this mount does not follow' };
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
 * Read and hash a mount-relative file through one descriptor. The whole file
 * is returned when it is at most `limit` bytes; larger files are hashed in
 * chunks and only their head is kept.
 */
export async function readPath(
  view: MountView,
  rootReal: string,
  relativePath: string,
  limit: number,
): Promise<ReadResult | Exclude<Observation, { kind: 'file' }>> {
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
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    if (code === 'ELOOP' && !view.followSymlinks) return { kind: 'unobserved', reason: 'a symlink, which this mount does not follow' };
    if (code === 'EISDIR') return { kind: 'unobserved', reason: 'a directory' };
    return { kind: 'unobserved', reason: `cannot open (${code ?? String(err)})` };
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return { kind: 'unobserved', reason: info.isDirectory() ? 'a directory' : 'not a regular file' };
    if (view.followSymlinks) {
      const real = await realpath(lexical).catch(() => null);
      if (real === null || !contained(rootReal, real)) return { kind: 'unobserved', reason: 'a symlink that leaves the mount' };
    }
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
        head: bytes.subarray(0, 8192),
      };
    }
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(HASH_CHUNK);
    let head: Buffer | null = null;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK, offset);
      if (bytesRead === 0) break;
      if (head === null) head = Buffer.from(chunk.subarray(0, Math.min(bytesRead, 8192)));
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
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unobserved', reason: `cannot read (${code ?? String(err)})` };
  } finally {
    await handle.close();
  }
}

/** Null bytes in the first 8 KB: the store holds text only from disk. */
export function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8192).includes(0);
}

/** Image MIME type from magic bytes, for listing disk-only files. */
export function sniffImageMime(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

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
 * List a directory scope ('' for the mount root), descending when recursive,
 * up to `cap` files in total.
 */
export async function walkScope(view: MountView, scope: string, recursive: boolean, cap: number): Promise<Walk> {
  const walk: Walk = { files: new Set(), dirs: new Set(), others: new Map(), complete: new Set(), missing: new Set(), incomplete: [] };
  let capped = false;

  const visit = async (dir: string): Promise<void> => {
    if (capped) {
      walk.incomplete.push({ path: dir, reason: `not visited: the file cap (${cap}) was reached`, kind: 'cap' });
      return;
    }
    let entries;
    try {
      entries = await readdir(join(view.root, dir), { withFileTypes: true });
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        walk.missing.add(dir);
        return;
      }
      walk.incomplete.push({ path: dir, reason: `cannot list (${code ?? String(err)})`, kind: 'error' });
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (isIgnored(rel, entry.name, view.ignore)) {
        walk.others.set(rel, 'ignored by the mount');
        walk.incomplete.push({ path: rel, reason: 'ignored by the mount', kind: 'ignored' });
        continue;
      }
      if (entry.isDirectory()) {
        walk.dirs.add(rel);
        if (recursive) subdirs.push(rel);
      } else if (entry.isFile()) {
        if (walk.files.size >= cap) {
          capped = true;
          walk.incomplete.push({ path: dir, reason: `the file cap (${cap}) was reached`, kind: 'cap' });
          return;
        }
        walk.files.add(rel);
      } else {
        const symlink = entry.isSymbolicLink();
        walk.others.set(rel, symlink ? 'a symlink' : 'not a regular file');
        if (symlink) walk.incomplete.push({ path: rel, reason: 'a symlink, not walked', kind: 'symlink' });
      }
    }
    walk.complete.add(dir);
    for (const sub of subdirs) await visit(sub);
  };

  await visit(scope);
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
