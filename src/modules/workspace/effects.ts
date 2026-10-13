/**
 * The workspace's disk effects — a materialize's writes and unlinks, and the
 * barriers that make them durable — under the mount boundary.
 *
 * Each effect is bound at its point of use, not at planning time: the parent
 * directory is checked (located inside the mount, see observe.ts), the file is
 * reached through it, and before anything is changed the effect checks that
 * it acts on what was decided on — a regular file inside the mount, at this
 * path, still holding the bytes planning saw (unless `force`, which overrides
 * that freshness but never the boundary). Content is written only through a
 * descriptor whose own location was confirmed inside the mount first, and
 * only into a file with no other hard links: a write in place changes the
 * file under every name it has, and the others may lie outside the mount (a
 * package store's, say), so such a file is refused. Unlinking one name
 * changes no other, so an unlink needs no such check.
 *
 * What an effect reports matters to the caller's evidence: a failure that
 * never touched the path's entry leaves disk as planning saw it, so the
 * path's evidence can be put back as it was; once the entry was touched
 * (created, truncated, written or unlinked) the outcome is for the next
 * observation to resolve. Directories created for a write don't touch the
 * path's entry; they stay, empty, if the write is refused.
 *
 * Node has no openat, so a create, mkdir or unlink still resolves its path by
 * name after the parent was checked: a parent replaced concurrently in that
 * window can redirect that one operation, leaving an empty file or directory
 * outside the mount or unlinking a same-named file there. Nor is there an
 * unlink bound to an inode: an unlink checks the entry's identity again just
 * before it, and a file replaced at its path after that check is the one
 * unlinked. Content writes stay bound to the descriptor verified before
 * modification: inside the mount, with no other hard links (a link another
 * process makes to it after that check shares the write). The hash, which
 * reads the whole file, comes before the checks of where the file is, and
 * the root is checked again beside the parent, since the parent is found by
 * path beneath the root's. A last look at the file (its descriptor's stat
 * before a write, its entry's lstat before an unlink) refuses one written
 * since it was first seen, so only an edit made in the moment between that
 * look and the effect is overwritten or removed.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  type CheckedDir,
  type MountView,
  NONBLOCK,
  NOT_FOLLOWED,
  OUTSIDE_PARENT,
  ROOT_REPLACED,
  contained,
  errno,
  checkDir,
  checkRoot,
  insideNested,
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

/** Errors with which an unlink refuses outright, leaving the entry as it was. */
const UNLINK_REFUSALS = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY']);

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
const HARD_LINKED = 'a file with other hard links, which writing it in place would change too — force does not override '
  + 'this; to write this path alone, give it a copy of its own first (copy it to a new name, then move that over it) '
  + 'and materialize again';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noFollowFlag(view: MountView): number {
  return !view.followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

/**
 * The parent of a path, checked for an effect; proven absent; or why neither;
 * with the root. The root comes first: still a directory, and still the one
 * disk last agreed under, as any observation of it checks. An effect under a
 * replaced root acts on nothing, whatever its caller checked before, and the
 * parent is found by path beneath the root's path, so whoever acts checks the
 * root again with the parent (`moved`): a root replaced after it was
 * checked would otherwise lend the effect its replacement's directory.
 */
async function parentFor(view: MountView, rootReal: string, rel: string, create: boolean) {
  const root = await checkRoot(view, rootReal);
  if ('reason' in root) throw new EffectFailed(root.reason, false);
  const checked = await checkDir(view, rootReal, parentOf(rel), { create });
  if (checked.kind === 'unobserved') throw new EffectFailed(checked.outside ? OUTSIDE_PARENT : checked.reason, false);
  return { ...checked, root: root.dir };
}

/**
 * Why the parent, or the root it was found beneath, is no longer the
 * directory its path names; null while each still is. The root is asked
 * first, so a replaced root reads the same wherever it's found.
 */
async function moved(root: CheckedDir, parent: CheckedDir): Promise<string | null> {
  if (!(await root.stillHere())) return ROOT_REPLACED;
  return (await parent.stillHere()) ? null : MOVED;
}

/** A file as a stat describes it: which file, and the size and stamps a write changes. */
type Stamped = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

/**
 * Whether the file at `target` is still the one `before` described: the same
 * file, with the same size and stamps, so nothing wrote it since. Read just
 * before an effect, after the slower checks, so an edit made while the file
 * was hashed is never overwritten or deleted unseen; what remains is the
 * moment between this and the effect, which Node can't close (see the header).
 */
function unchanged(before: Stamped, now: Stamped | null): boolean {
  return now !== null && now.dev === before.dev && now.ino === before.ino && now.size === before.size
    && now.mtimeNs === before.mtimeNs && now.ctimeNs === before.ctimeNs;
}

/** The hash of what `target` holds, read through a descriptor that must be the file `id` names. */
async function hashAt(target: string, id: { dev: bigint; ino: bigint }, flags: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | NONBLOCK | flags);
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
  const checked = await parentFor(view, rootReal, rel, true);
  if (checked.kind !== 'checked') throw new EffectFailed('a parent path is not a directory', false);
  const parent = checked.dir;
  const root = checked.root;
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
      // O_EXCL refuses any entry: a file, a directory or a link.
      if (errno(err) === 'EEXIST') throw new EffectFailed('something appeared at this path since it was checked', false);
      throw new EffectFailed(`cannot create the file (${errno(err) ?? message(err)})`, false);
    }
  };
  let handle: FileHandle;
  if (expect.kind === 'absent') {
    handle = await create();
  } else {
    try {
      // Opened without truncating: nothing changes until it is located.
      handle = await open(target, fsConstants.O_WRONLY | NONBLOCK | noFollow);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' && expect.kind === 'any') handle = await create();
      else if (code === 'ENOENT') throw new EffectFailed('the file was removed since it was checked', false);
      else if (code === 'ELOOP' && !view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
      else if (code === 'EISDIR') throw new EffectFailed('a directory', false);
      else if (code === 'ENXIO') throw new EffectFailed('not a regular file', false); // a FIFO with no reader
      else throw new EffectFailed(`cannot open the file (${code ?? message(err)})`, false);
    }
  }

  let stage = 'write the file';
  try {
    // Before any byte: a regular file, and — unless forced — still holding
    // what was decided on. The hash reads the whole file, so it comes first,
    // and the checks of where the file is follow it.
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new EffectFailed('not a regular file', touched);
    if (expect.kind === 'content' && (await hashAt(target, info, noFollow)) !== expect.hash) throw new EffectFailed(CHANGED, touched);
    // Then: canonically inside the mount, the one this path names (and not a
    // symlink, where the mount follows none and the open couldn't refuse
    // one), with no other names, in the directory still at its path beneath
    // the root still at its own.
    const real = await realpath(target).catch(() => null);
    if (real === null) throw new EffectFailed(CHANGED, touched);
    if (!contained(rootReal, real)) throw new EffectFailed(view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT, touched);
    const nested = insideNested(view, real);
    if (nested) throw new EffectFailed(nested, touched);
    const named = await stat(real, { bigint: true }).catch(() => null);
    if (named === null || named.dev !== info.dev || named.ino !== info.ino) throw new EffectFailed(CHANGED, touched);
    if (!view.followSymlinks) {
      const entry = await lstat(target, { bigint: true }).catch(() => null);
      if (entry?.isSymbolicLink()) throw new EffectFailed(NOT_FOLLOWED, touched);
      if (entry === null || !entry.isFile() || entry.dev !== info.dev || entry.ino !== info.ino) throw new EffectFailed(CHANGED, touched);
    }
    if (info.nlink > 1n) throw new EffectFailed(HARD_LINKED, touched);
    const gone = await moved(root, parent);
    if (gone !== null) throw new EffectFailed(gone, touched);
    // Nothing wrote it while those ran.
    if (!unchanged(info, await handle.stat({ bigint: true }).catch(() => null))) throw new EffectFailed(CHANGED, touched);

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
  const checked = await parentFor(view, rootReal, rel, false);
  if (checked.kind === 'absent') {
    // No directory, so no file: proven beneath a root still at its path.
    if (!(await checked.root.stillHere())) throw new EffectFailed(ROOT_REPLACED, false);
    return checked.by;
  }
  const parent = checked.dir;
  const root = checked.root;
  const target = parent.at(nameOf(rel));
  let info;
  try {
    info = await lstat(target, { bigint: true });
  } catch (err) {
    if (errno(err) === 'ENOENT') {
      const gone = await moved(root, parent);
      if (gone !== null) throw new EffectFailed(gone, false);
      return parent.rel;
    }
    throw new EffectFailed(`cannot stat (${errno(err) ?? message(err)})`, false);
  }
  // Confirming an unlink that already happened never removes a file that
  // appeared since.
  if (expect.kind === 'absent') {
    const kind = info.isDirectory() ? 'a directory' : info.isSymbolicLink() ? 'a symlink' : 'a file';
    throw new EffectFailed(`${kind} appeared at this path since it was checked`, false);
  }
  let file = info;
  if (info.isSymbolicLink()) {
    // The link itself is what is removed; a followed one must still lie inside.
    if (!view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
    const real = await realpath(target).catch(() => null);
    if (real === null || !contained(rootReal, real)) throw new EffectFailed('a symlink that leaves the mount', false);
    const nested = insideNested(view, real);
    if (nested) throw new EffectFailed(nested, false);
    const through = await stat(real, { bigint: true }).catch(() => null);
    if (through === null) throw new EffectFailed(CHANGED, false);
    file = through;
  } else if (info.isDirectory()) {
    throw new EffectFailed('a directory', false);
  }
  if (expect.kind === 'content' && (await hashAt(target, file, noFollowFlag(view))) !== expect.hash) throw new EffectFailed(CHANGED, false);
  const gone = await moved(root, parent);
  if (gone !== null) throw new EffectFailed(gone, false);
  // The entry checked is still the one at the path, unwritten since it was
  // hashed, as close to the unlink as Node allows (see the header): a file
  // replaced or edited while it was hashed isn't removed.
  const again = await lstat(target, { bigint: true }).catch(() => null);
  const named = again?.isSymbolicLink() ? await stat(target, { bigint: true }).catch(() => null) : again;
  if (!unchanged(file, named)) throw new EffectFailed(CHANGED, false);
  try {
    await unlink(target);
  } catch (err) {
    const code = errno(err);
    // An unlink is all or nothing: one refused outright changed nothing, so
    // the path's evidence can go back as it was. Anything else may have
    // landed (a network filesystem's EIO, say): the next observation resolves it.
    if (code !== 'ENOENT') throw new EffectFailed(`could not unlink the file: ${message(err)}`, !UNLINK_REFUSALS.has(code ?? ''));
  }
  return parent.rel;
}

/**
 * Sync each mount directory (mount-relative), deepest first, so the entries
 * a push created or removed in them are durable. Each is checked first and the
 * directory it holds is the one synced — never a replacement at its path.
 * Returns the ones that failed, with why. Where directories can't be synced
 * at all (Windows, or a filesystem answering EINVAL/ENOTSUP), there is
 * nothing to wait for.
 */
export async function syncDirectories(view: MountView, rootReal: string, rels: Iterable<string>): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  const depth = (rel: string): number => (rel === '' ? 0 : rel.split('/').length);
  const sorted = [...new Set(rels)].sort((a, b) => depth(b) - depth(a));
  // Each directory is found by path beneath the root's path: under a root
  // that isn't the one disk agreed under, or that is replaced while they're
  // synced, none of them is the mount's.
  const root = await checkRoot(view, rootReal);
  if ('reason' in root) {
    for (const rel of sorted) failed.set(rel, root.reason);
    return failed;
  }
  for (const rel of sorted) {
    const checked = await checkDir(view, rootReal, rel);
    if (checked.kind !== 'checked') {
      failed.set(rel, checked.kind === 'absent' ? 'the directory is gone' : checked.reason);
      continue;
    }
    try {
      await checked.dir.sync();
      if (!(await root.dir.stillHere())) failed.set(rel, ROOT_REPLACED);
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
