/**
 * Direct filesystem backend for workspace mounts (`backend: 'direct'`).
 *
 * Every tool call on a direct mount reads or writes the mounted directory
 * itself. No Chronicle tree state is kept for the mount, so there is nothing
 * to materialize, nothing to sync, and no second copy of a file that can
 * drift from the one on disk. What a shell appended a second ago is what
 * `read` returns; what `write` returned success for is what `cat` shows.
 *
 * The price is history: edits on a direct mount are not branch-scoped, an
 * undo does not rewind them, and a branch switch does not re-materialize
 * them. Choose per mount in the recipe.
 *
 * Containment is the same as the chronicle backend's disk reads: lexical
 * containment at parse time, symlinks refused unless `followSymlinks`, and
 * the real path of every touched parent checked against the mount root.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import type { MountState } from './types.js';
import { DEFAULT_MAX_FILE_SIZE, hashContent, isBinary, shouldIgnore } from './sync.js';

/** Files visited by one recursive listing/search before it reports `truncated`. */
export const DIRECT_WALK_CAP = 5000;

export type DirectErrorCode =
  | 'not_found' | 'directory' | 'symlink' | 'escape' | 'mount_unavailable'
  | 'too_large' | 'binary' | 'changed' | 'read_only' | 'io';

export class DirectFsError extends Error {
  constructor(readonly code: DirectErrorCode, message: string, readonly errno?: string) {
    super(message);
    this.name = 'DirectFsError';
  }
}

/** What the module's containment-checked opener hands back. */
export interface OpenedFile {
  handle: Awaited<ReturnType<typeof open>>;
  fileStat: Stats;
  realFilePath: string;
}

/** The module's `openContainedFile`, bound to a mount. */
export type ContainedOpener = (relativePath: string, mountPrefixedPath: string) => Promise<OpenedFile>;

function errnoOf(err: unknown): string | undefined {
  return typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(r);
}

function toLogical(base: string, abs: string): string {
  return relative(base, abs).split(sep).join('/');
}

// ============================================================================
// Read
// ============================================================================

export interface DirectReadResult {
  content: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Read a text file from disk through the containment-checked opener.
 * Oversize and binary files are refused with a reason the agent can act on
 * (`read_image` for images, a shell tool for the rest).
 */
export async function directReadText(
  mount: MountState,
  relativePath: string,
  mountPrefixedPath: string,
  openContained: ContainedOpener,
): Promise<DirectReadResult> {
  if (!relativePath) throw new DirectFsError('directory', `Path is a directory: ${mountPrefixedPath}`);
  const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const { handle, fileStat } = await openContained(relativePath, mountPrefixedPath);
  try {
    if (fileStat.size > maxSize) {
      throw new DirectFsError('too_large', `File exceeds max file size (${fileStat.size} > ${maxSize} bytes): ${mountPrefixedPath}. Read it with a shell tool.`);
    }
    const bytes = await handle.readFile();
    if (isBinary(bytes)) {
      throw new DirectFsError('binary', `Binary file: ${mountPrefixedPath}. Use read_image for images, or a shell tool.`);
    }
    return { content: bytes.toString('utf-8'), size: bytes.length, mtimeMs: fileStat.mtimeMs, ino: fileStat.ino };
  } finally {
    await handle.close();
  }
}

// ============================================================================
// Write targets
// ============================================================================

interface WriteTarget {
  /** Real, contained absolute path of the file (parent resolved through realpath). */
  absolutePath: string;
  /** lstat of the existing entry, or null when nothing is there yet. */
  existing: Stats | null;
}

/**
 * Resolve where a write/delete lands and prove it is inside the mount.
 *
 * Symlinked targets are refused unless the mount follows symlinks; the
 * deepest existing ancestor must realpath inside the real mount root before
 * any missing directories are created, so a symlinked parent cannot redirect
 * a write out of the mount.
 */
async function resolveWriteTarget(
  mount: MountState,
  relativePath: string,
  mountPrefixedPath: string,
  opts: { createParents: boolean },
): Promise<WriteTarget> {
  if (mount.config.mode === 'read-only') {
    throw new DirectFsError('read_only', `Mount "${mount.config.name}" is read-only`);
  }
  if (!relativePath) throw new DirectFsError('directory', `Path is a directory: ${mountPrefixedPath}`);
  const follow = mount.config.followSymlinks === true;

  let realRoot: string;
  try {
    realRoot = await realpath(mount.config.path);
  } catch (err) {
    throw new DirectFsError('mount_unavailable', `Mount unavailable: ${mount.config.name}`, errnoOf(err));
  }

  const lexical = resolve(mount.config.path, relativePath);
  let existing: Stats | null = null;
  try {
    existing = await lstat(lexical);
  } catch (err) {
    const code = errnoOf(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new DirectFsError('io', `Unable to access ${mountPrefixedPath}: ${code ?? String(err)}`, code);
    }
  }
  if (existing?.isDirectory()) throw new DirectFsError('directory', `Path is a directory: ${mountPrefixedPath}`);
  if (existing?.isSymbolicLink() && !follow) throw new DirectFsError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`);

  // Deepest existing ancestor must be inside the real root.
  const parentLexical = dirname(lexical);
  let probe = parentLexical;
  let realProbe: string | null = null;
  while (realProbe === null) {
    try {
      realProbe = await realpath(probe);
    } catch (err) {
      const code = errnoOf(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new DirectFsError('io', `Unable to resolve parent of ${mountPrefixedPath}: ${code ?? String(err)}`, code);
      }
      const up = dirname(probe);
      if (up === probe) throw new DirectFsError('mount_unavailable', `Mount unavailable: ${mount.config.name}`);
      probe = up;
    }
  }
  if (!isContained(realRoot, realProbe)) {
    throw new DirectFsError('escape', `Symlink escape detected: ${mountPrefixedPath}`);
  }

  if (probe !== parentLexical) {
    if (!opts.createParents) throw new DirectFsError('not_found', `File not found: ${mountPrefixedPath}`);
    await mkdir(parentLexical, { recursive: true });
  }
  let realParent: string;
  try {
    realParent = await realpath(parentLexical);
  } catch (err) {
    throw new DirectFsError('io', `Unable to resolve parent of ${mountPrefixedPath}`, errnoOf(err));
  }
  if (!isContained(realRoot, realParent)) {
    throw new DirectFsError('escape', `Symlink escape detected: ${mountPrefixedPath}`);
  }

  let absolutePath = join(realParent, basename(lexical));
  if (existing?.isSymbolicLink() && follow) {
    try {
      absolutePath = await realpath(lexical);
    } catch (err) {
      throw new DirectFsError('not_found', `Dangling symlink: ${mountPrefixedPath}`, errnoOf(err));
    }
    if (!isContained(realRoot, absolutePath)) {
      throw new DirectFsError('escape', `Symlink escape detected: ${mountPrefixedPath}`);
    }
    existing = await stat(absolutePath);
    if (existing.isDirectory()) throw new DirectFsError('directory', `Path is a directory: ${mountPrefixedPath}`);
  }
  return { absolutePath, existing };
}

/**
 * Replace a file's contents atomically: write a sibling temp file, fsync it,
 * rename over the target. A crash mid-write leaves either the old file or
 * the new one, never a torn one.
 */
async function atomicReplace(absolutePath: string, content: Buffer): Promise<void> {
  const tmp = join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, absolutePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw new DirectFsError('io', `Write failed: ${err instanceof Error ? err.message : String(err)}`, errnoOf(err));
  }
}

export interface DirectWriteResult {
  size: number;
  hash: string;
  appended: boolean;
}

/**
 * Write (or append) text to a file on disk. Overwrites are atomic; appends
 * go through a single O_APPEND write so interleaving with other appenders
 * (a shell `>>`) never tears an entry.
 */
export async function directWrite(
  mount: MountState,
  relativePath: string,
  mountPrefixedPath: string,
  content: Buffer,
  opts: { append?: boolean } = {},
): Promise<DirectWriteResult> {
  const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  if (content.length > maxSize) {
    throw new DirectFsError('too_large', `Content exceeds max file size (${maxSize} bytes)`);
  }
  const { absolutePath, existing } = await resolveWriteTarget(mount, relativePath, mountPrefixedPath, { createParents: true });

  if (opts.append && existing) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(absolutePath, fsConstants.O_WRONLY | fsConstants.O_APPEND, 0o644);
      await handle.writeFile(content);
      await handle.sync();
      const after = await handle.stat();
      return { size: after.size, hash: hashContent(content), appended: true };
    } catch (err) {
      throw new DirectFsError('io', `Append failed: ${err instanceof Error ? err.message : String(err)}`, errnoOf(err));
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  await atomicReplace(absolutePath, content);
  return { size: content.length, hash: hashContent(content), appended: false };
}

export interface DirectEditResult {
  size: number;
  replacements: number;
}

/**
 * Find-and-replace in a file on disk. Uniqueness rules match the chronicle
 * backend. The file's identity and mtime are re-checked right before the
 * atomic replace; if another writer touched it in between, the edit is
 * refused rather than silently dropping their change.
 */
export async function directEdit(
  mount: MountState,
  relativePath: string,
  mountPrefixedPath: string,
  openContained: ContainedOpener,
  edit: { oldString: string; newString: string; replaceAll?: boolean },
): Promise<DirectEditResult> {
  if (mount.config.mode === 'read-only') {
    throw new DirectFsError('read_only', `Mount "${mount.config.name}" is read-only`);
  }
  const before = await directReadText(mount, relativePath, mountPrefixedPath, openContained);
  const count = before.content.split(edit.oldString).length - 1;
  if (count === 0) throw new DirectFsError('not_found', `String not found in ${mountPrefixedPath}`);
  if (!edit.replaceAll && count > 1) {
    throw new DirectFsError('io', `String found ${count} times in ${mountPrefixedPath}. Use replaceAll: true or provide more context.`);
  }
  const next = edit.replaceAll
    ? before.content.replaceAll(edit.oldString, edit.newString)
    : before.content.replace(edit.oldString, edit.newString);
  const buffer = Buffer.from(next, 'utf-8');
  const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  if (buffer.length > maxSize) throw new DirectFsError('too_large', `Edited content exceeds max file size (${maxSize} bytes)`);

  const { absolutePath, existing } = await resolveWriteTarget(mount, relativePath, mountPrefixedPath, { createParents: false });
  if (!existing || existing.ino !== before.ino || existing.mtimeMs !== before.mtimeMs || existing.size !== before.size) {
    throw new DirectFsError('changed', `File changed during edit: ${mountPrefixedPath}. Re-read it and retry.`);
  }
  await atomicReplace(absolutePath, buffer);
  return { size: buffer.length, replacements: edit.replaceAll ? count : 1 };
}

/** Unlink a file on disk. Directories and (unless followed) symlinks are refused. */
export async function directDelete(
  mount: MountState,
  relativePath: string,
  mountPrefixedPath: string,
): Promise<void> {
  const { absolutePath, existing } = await resolveWriteTarget(mount, relativePath, mountPrefixedPath, { createParents: false });
  if (!existing) throw new DirectFsError('not_found', `File not found: ${mountPrefixedPath}`);
  try {
    await unlink(absolutePath);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') throw new DirectFsError('not_found', `File not found: ${mountPrefixedPath}`, code);
    throw new DirectFsError('io', `Delete failed: ${err instanceof Error ? err.message : String(err)}`, code);
  }
}

// ============================================================================
// Listing and search
// ============================================================================

export interface DirectEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
}

export interface DirectWalk {
  /** Files found, logical '/'-separated paths relative to the mount root. */
  files: Array<{ path: string; size: number }>;
  /** True when the walk stopped at the cap; files beyond it were not visited. */
  truncated: boolean;
  /** Directories the walk could not read. */
  unreadable: string[];
}

async function realDirOrNull(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}

/**
 * Walk a directory inside the mount. Ignore patterns are honored, symlinks
 * are skipped unless the mount follows them (and then loops and escapes are
 * cut), and the walk stops at `cap` files — reported, never silent.
 */
export async function directWalk(
  mount: MountState,
  scopeRelative: string,
  opts: { recursive: boolean; cap?: number },
): Promise<DirectWalk> {
  const cap = opts.cap ?? DIRECT_WALK_CAP;
  const follow = mount.config.followSymlinks === true;
  const ignore = mount.config.ignore ?? [];
  const root = mount.config.path;
  const realRoot = await realDirOrNull(root);
  if (realRoot === null) throw new DirectFsError('mount_unavailable', `Mount unavailable: ${mount.config.name}`);
  const start = resolve(root, scopeRelative);
  const walk: DirectWalk = { files: [], truncated: false, unreadable: [] };
  const visited = new Set<string>();

  const visit = async (dir: string): Promise<void> => {
    if (walk.truncated) return;
    const realDir = await realDirOrNull(dir);
    if (realDir === null || !isContained(realRoot, realDir)) {
      if (dir !== start) return;
      throw new DirectFsError('escape', `Path resolves outside the mount: ${scopeRelative}`);
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === start) {
        const code = errnoOf(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new DirectFsError('not_found', `Directory not found: ${scopeRelative || '/'}`, code);
        throw new DirectFsError('io', `Cannot list ${scopeRelative || '/'}: ${code ?? String(err)}`, code);
      }
      walk.unreadable.push(toLogical(root, dir));
      return;
    }
    for (const entry of entries) {
      if (walk.truncated) return;
      const full = join(dir, entry.name);
      const rel = toLogical(root, full);
      if (shouldIgnore(rel, entry.name, ignore)) continue;

      let isFile = entry.isFile();
      let isDir = entry.isDirectory();
      let size: number | undefined;
      if (entry.isSymbolicLink()) {
        if (!follow) continue;
        try {
          const target = await stat(full);
          const realTarget = await realpath(full);
          if (!isContained(realRoot, realTarget)) continue;
          isFile = target.isFile();
          isDir = target.isDirectory();
          size = target.size;
        } catch {
          continue;
        }
      }
      if (isFile) {
        if (walk.files.length >= cap) { walk.truncated = true; return; }
        if (size === undefined) {
          try { size = (await stat(full)).size; } catch { continue; }
        }
        walk.files.push({ path: rel, size });
      } else if (isDir && opts.recursive) {
        await visit(full);
      }
    }
  };

  await visit(start);
  return walk;
}

/** Immediate children of a directory, typed, sizes for files. */
export async function directListDir(mount: MountState, scopeRelative: string): Promise<DirectEntry[]> {
  const root = mount.config.path;
  const realRoot = await realDirOrNull(root);
  if (realRoot === null) throw new DirectFsError('mount_unavailable', `Mount unavailable: ${mount.config.name}`);
  const dir = resolve(root, scopeRelative);
  const realDir = await realDirOrNull(dir);
  if (realDir === null) throw new DirectFsError('not_found', `Directory not found: ${scopeRelative || '/'}`);
  if (!isContained(realRoot, realDir)) throw new DirectFsError('escape', `Path resolves outside the mount: ${scopeRelative}`);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOTDIR') throw new DirectFsError('not_found', `Not a directory: ${scopeRelative}`, code);
    throw new DirectFsError('io', `Cannot list ${scopeRelative || '/'}: ${code ?? String(err)}`, code);
  }
  const ignore = mount.config.ignore ?? [];
  const out: DirectEntry[] = [];
  for (const entry of entries) {
    const rel = toLogical(root, join(dir, entry.name));
    if (shouldIgnore(rel, entry.name, ignore)) continue;
    if (entry.isSymbolicLink()) { out.push({ name: entry.name, type: 'symlink' }); continue; }
    if (entry.isDirectory()) { out.push({ name: entry.name, type: 'directory' }); continue; }
    if (entry.isFile()) {
      let size: number | undefined;
      try { size = (await stat(join(dir, entry.name))).size; } catch { /* vanished */ }
      out.push({ name: entry.name, type: 'file', ...(size !== undefined ? { size } : {}) });
      continue;
    }
    out.push({ name: entry.name, type: 'other' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface DirectGrepMatch { line: number; text: string; context?: string[] }
export interface DirectGrepResult {
  results: Array<{ file: string; matches: DirectGrepMatch[] }>;
  truncated: boolean;
  skipped: { binary: number; tooLarge: number; unreadable: number };
}

/**
 * Regex search over text files under a scope (or a single file). Binary and
 * oversize files are counted in `skipped`, not silently dropped.
 */
export async function directGrep(
  mount: MountState,
  scopeRelative: string,
  openContained: ContainedOpener,
  opts: { regex: RegExp; fileGlob: RegExp | null; contextBefore: number; contextAfter: number; cap?: number },
): Promise<DirectGrepResult> {
  const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const result: DirectGrepResult = { results: [], truncated: false, skipped: { binary: 0, tooLarge: 0, unreadable: 0 } };

  let files: Array<{ path: string; size: number }>;
  let single = false;
  if (scopeRelative) {
    try {
      const info = await lstat(resolve(mount.config.path, scopeRelative));
      single = info.isFile() || (info.isSymbolicLink() && mount.config.followSymlinks === true);
    } catch { /* treat as directory below; walk reports not_found */ }
  }
  if (single) {
    files = [{ path: scopeRelative, size: 0 }];
  } else {
    const walk = await directWalk(mount, scopeRelative, { recursive: true, cap: opts.cap });
    files = walk.files;
    result.truncated = walk.truncated;
    result.skipped.unreadable += walk.unreadable.length;
  }

  for (const file of files) {
    if (opts.fileGlob && !opts.fileGlob.test(file.path)) continue;
    let content: string;
    try {
      content = (await directReadText(mount, file.path, `${mount.config.name}/${file.path}`, openContained)).content;
    } catch (err) {
      if (err instanceof DirectFsError && err.code === 'binary') result.skipped.binary++;
      else if (err instanceof DirectFsError && err.code === 'too_large') result.skipped.tooLarge++;
      else result.skipped.unreadable++;
      continue;
    }
    if (content.length > maxSize) { result.skipped.tooLarge++; continue; }
    const lines = content.split('\n');
    const matches: DirectGrepMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!opts.regex.test(lines[i])) continue;
      const m: DirectGrepMatch = { line: i + 1, text: lines[i] };
      if (opts.contextBefore > 0 || opts.contextAfter > 0) {
        m.context = lines.slice(Math.max(0, i - opts.contextBefore), Math.min(lines.length, i + opts.contextAfter + 1));
      }
      matches.push(m);
    }
    if (matches.length > 0) result.results.push({ file: `${mount.config.name}/${file.path}`, matches });
  }
  return result;
}
