/**
 * The workspace's disk effects — a materialize's writes and unlinks, and the
 * barriers that make them durable — under the mount boundary.
 *
 * Each effect is bound at its point of use, not at planning time: the parent
 * directory is held (located inside the mount, see observe.ts), the file is
 * reached through it, and before anything is changed the effect checks that
 * it acts on what was decided on — a regular file inside the mount, at this
 * path, still holding the bytes planning saw (unless `force`, which overrides
 * that freshness but never the boundary). Content is written only through a
 * descriptor whose own location was confirmed inside the mount first.
 *
 * What an effect reports matters to the caller's evidence: a failure that
 * never touched the path's entry leaves disk as planning saw it, so the
 * path's evidence can be put back as it was; once the entry was touched
 * (created, truncated, written or unlinked) the outcome is for the next
 * observation to resolve. Directories created for a write don't touch the
 * path's entry; they stay, empty, if the write is refused.
 *
 * Node has no openat, so a create, mkdir or unlink still resolves its path by
 * name after the parent was located: a swap of one of the parent's ancestors
 * in that window can redirect it. The content of a write can't be: it goes
 * through a descriptor located first.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  type MountView,
  NOT_FOLLOWED,
  OUTSIDE_PARENT,
  contained,
  errno,
  holdDir,
  nameOf,
  parentOf,
} from './observe.js';

/** What a write or unlink may find at its path when it acts. */
export type Expect =
  | { kind: 'absent' }
  /** The bytes planning decided on, by hash. */
  | { kind: 'content'; hash: string }
  /** Anything (force): freshness is overridden, the boundary is not. */
  | { kind: 'any' };

export class EffectFailed extends Error {
  /** Whether the path's entry was touched before the failure. */
  readonly touched: boolean;

  constructor(message: string, touched: boolean) {
    super(message);
    this.touched = touched;
  }
}

const CHANGED = 'disk changed since it was checked';
const MOVED = 'the directory changed since it was checked';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noFollowFlag(view: MountView): number {
  return !view.followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

/** The parent of a path, held for an effect; proven absent; or why neither. */
async function parentFor(view: MountView, rootReal: string, rel: string, create: boolean) {
  const held = await holdDir(view, rootReal, parentOf(rel), { create });
  if (held.kind === 'unobserved') throw new EffectFailed(held.outside ? OUTSIDE_PARENT : held.reason, false);
  return held;
}

/** The hash of what `target` holds, read through a descriptor that must be the file `id` names. */
async function hashAt(target: string, id: { dev: bigint; ino: bigint }, flags: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | flags);
  } catch (err) {
    throw new EffectFailed(`cannot verify the disk copy (${errno(err) ?? message(err)})`, false);
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (info.dev !== id.dev || info.ino !== id.ino) throw new EffectFailed(CHANGED, false);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1 << 20);
    for (let offset = 0; ;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Write `bytes` at a mount-relative path, creating missing parent
 * directories, and make the file durable (its directories are synced by the
 * caller, after all of a push's effects: syncDirectories).
 */
export async function writeContained(view: MountView, rootReal: string, rel: string, bytes: Buffer, expect: Expect): Promise<void> {
  const held = await parentFor(view, rootReal, rel, true);
  if (held.kind !== 'held') throw new EffectFailed('a parent path is not a directory', false);
  const parent = held.dir;
  const target = parent.at(nameOf(rel));
  const noFollow = noFollowFlag(view);
  if (!view.followSymlinks && !noFollow) {
    // No O_NOFOLLOW (Windows): refuse a symlink by lstat before opening.
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new EffectFailed(NOT_FOLLOWED, false);
  }

  let touched = false;
  const create = async (): Promise<FileHandle> => {
    try {
      // Exclusive: never follows a symlink, never takes over a file that
      // appeared since planning saw none.
      const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
      touched = true;
      return handle;
    } catch (err) {
      if (errno(err) === 'EEXIST') throw new EffectFailed('a file appeared at this path since it was checked', false);
      throw new EffectFailed(`cannot create the file (${errno(err) ?? message(err)})`, false);
    }
  };
  let handle: FileHandle;
  if (expect.kind === 'absent') {
    handle = await create();
  } else {
    try {
      // Opened without truncating: nothing changes until it is located.
      handle = await open(target, fsConstants.O_WRONLY | noFollow);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' && expect.kind === 'any') handle = await create();
      else if (code === 'ENOENT') throw new EffectFailed('the file was removed since it was checked', false);
      else if (code === 'ELOOP' && !view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
      else if (code === 'EISDIR') throw new EffectFailed('a directory', false);
      else throw new EffectFailed(`cannot open the file (${code ?? message(err)})`, false);
    }
  }

  let stage = 'write the file';
  try {
    // Before any byte: a regular file, canonically inside the mount, the one
    // this path names, in the directory still at its path, and — unless
    // forced — still holding what was decided on.
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new EffectFailed('not a regular file', touched);
    const real = await realpath(target).catch(() => null);
    if (real === null) throw new EffectFailed(CHANGED, touched);
    if (!contained(rootReal, real)) throw new EffectFailed(view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT, touched);
    const named = await stat(real, { bigint: true }).catch(() => null);
    if (named === null || named.dev !== info.dev || named.ino !== info.ino) throw new EffectFailed(CHANGED, touched);
    if (!(await parent.stillHere())) throw new EffectFailed(MOVED, touched);
    if (expect.kind === 'content' && (await hashAt(target, info, noFollow)) !== expect.hash) throw new EffectFailed(CHANGED, touched);

    touched = true;
    await handle.truncate(0);
    await handle.writeFile(bytes);
    stage = 'make the write durable (file fsync)';
    await handle.sync();
  } catch (err) {
    if (err instanceof EffectFailed) throw err;
    throw new EffectFailed(`could not ${stage}: ${message(err)}`, touched);
  } finally {
    await handle.close();
  }
}

/**
 * Unlink a mount-relative file, or confirm it gone (`absent` expected: a
 * file found there is never removed). Returns the mount directory whose
 * entries make the absence durable, for the caller's barrier: the file's
 * parent, or — when the parent itself is gone — the directory proven to lack
 * it, since that removal may not be durable either.
 */
export async function unlinkContained(view: MountView, rootReal: string, rel: string, expect: Expect): Promise<string> {
  const held = await parentFor(view, rootReal, rel, false);
  if (held.kind === 'absent') return held.by; // no directory, so no file
  const parent = held.dir;
  const target = parent.at(nameOf(rel));
  let info;
  try {
    info = await lstat(target, { bigint: true });
  } catch (err) {
    if (errno(err) === 'ENOENT') {
      if (!(await parent.stillHere())) throw new EffectFailed(MOVED, false);
      return parent.rel;
    }
    throw new EffectFailed(`cannot stat (${errno(err) ?? message(err)})`, false);
  }
  // Confirming an unlink that already happened never removes a file that
  // appeared since.
  if (expect.kind === 'absent') throw new EffectFailed('a file appeared at this path since it was checked', false);
  let id = { dev: info.dev, ino: info.ino };
  if (info.isSymbolicLink()) {
    // The link itself is what is removed; a followed one must still lie inside.
    if (!view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
    const real = await realpath(target).catch(() => null);
    if (real === null || !contained(rootReal, real)) throw new EffectFailed('a symlink that leaves the mount', false);
    const through = await stat(real, { bigint: true }).catch(() => null);
    if (through === null) throw new EffectFailed(CHANGED, false);
    id = { dev: through.dev, ino: through.ino };
  } else if (info.isDirectory()) {
    throw new EffectFailed('a directory', false);
  }
  if (expect.kind === 'content' && (await hashAt(target, id, noFollowFlag(view))) !== expect.hash) throw new EffectFailed(CHANGED, false);
  if (!(await parent.stillHere())) throw new EffectFailed(MOVED, false);
  try {
    await unlink(target);
  } catch (err) {
    if (errno(err) !== 'ENOENT') throw new EffectFailed(`could not unlink the file: ${message(err)}`, true);
  }
  return parent.rel;
}

/**
 * Sync each mount directory (mount-relative), deepest first, so the entries
 * a push created or removed in them are durable. Each is held first and the
 * directory it holds is the one synced — never a replacement at its path.
 * Returns the ones that failed, with why. Where directories can't be synced
 * at all (Windows, or a filesystem answering EINVAL/ENOTSUP), there is
 * nothing to wait for.
 */
export async function syncDirectories(view: MountView, rootReal: string, rels: Iterable<string>): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  const depth = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);
  for (const rel of [...new Set(rels)].sort((a, b) => depth(b) - depth(a))) {
    const held = await holdDir(view, rootReal, rel);
    if (held.kind !== 'held') {
      failed.set(rel, held.kind === 'absent' ? 'the directory is gone' : held.reason);
      continue;
    }
    try {
      await held.dir.sync();
    } catch (err) {
      failed.set(rel, message(err));
    }
  }
  return failed;
}

/** The directories whose entries make a written file reachable: its parent up to the mount root. */
export function chainOf(rel: string): string[] {
  const chain: string[] = [];
  for (let dir = parentOf(rel); ; dir = parentOf(dir)) {
    chain.push(dir);
    if (dir === '') return chain;
  }
}
