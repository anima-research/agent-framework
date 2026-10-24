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
 * outside the mount or in a nested mount's directory, or unlinking a
 * same-named file there. Nor is there an
 * unlink bound to an inode: an unlink checks the entry's identity again just
 * before it, and a file replaced at its path after that check is the one
 * unlinked. Content writes stay bound to the descriptor verified before
 * modification: inside the mount, with no other hard links (a link another
 * process makes to it after that check shares the write). The hash, which
 * reads the whole file, comes after a check of where the file is, which is
 * made again with the others after it, and the root is checked again beside
 * the parent, since the parent is found by path beneath the root's. A last
 * look at the file (its descriptor's stat before a write, its entry's lstat
 * before an unlink) refuses one written
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
  leadsInto,
  nameOf,
  coversLanding,
  namesNestedPlace,
  nestedAtReal,
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
const MODE_CHANGED = 'disk\'s mode changed since it was checked; a sync takes it in';
/**
 * A write's narrowing the kernel refused (another user's file, an ACL): the
 * write goes no further, and the next push meets the same refusal. Names the
 * mode the file has, the one the chmod aimed at, and the workspace's, once
 * where the two are the same.
 */
const notNarrowed = (from: number, target: number, workspace: number): string =>
  `the kernel refused to narrow its mode ${narrowingOf(from, target, workspace)}, as it does for a file another user owns, ` +
  'and new bytes aren\'t written wider than their mode: a retry is refused the same way until the file\'s owner or an administrator narrows it';
/** "from 0640 to 0600, within the workspace's 0604", or "from 0644 to the workspace's 0600". */
const narrowingOf = (from: number, target: number, workspace: number): string => `from ${octalMode(from)} ${narrowedTo(target, workspace)}`;
/** "to 0600, within the workspace's 0604", or "to the workspace's 0600" where the two are the same. */
export const narrowedTo = (target: number, workspace: number): string =>
  target === workspace
    ? `to the workspace's ${octalMode(workspace)}`
    : `to ${octalMode(target)}, within the workspace's ${octalMode(workspace)}`;
const octalMode = (mode: number): string => '0' + (mode & 0o777).toString(8).padStart(3, '0');

/** Whether the kernel refused a chmod as not this process's to make (another user's file, an ACL). */
function chmodRefused(err: unknown): boolean {
  const code = errno(err);
  return code === 'EPERM' || code === 'EACCES';
}
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
 * caller, after all of a push's effects: syncDirectories). With `mode`, the
 * file takes those permission bits; without it, a file written in place
 * keeps its own, and one the write creates takes `createMode`, the store's,
 * or 0o644 under the umask without one. A new file is created at that mode
 * and given it exactly before its bytes, whether or not a chmod was owed
 * when the write was planned; a file written in place loses the bits
 * `mode` removes before its bytes and gains the ones it adds after them, so
 * no bytes ever sit at a mode wider than both their old and new ones. With
 * `from`, the mode is given only to a file in place that still has the
 * permission bits `from`: one whose permission bits changed since it was
 * checked keeps them, as a changed byte would be kept, and the widening
 * after the bytes is made only over the mode the write left them at, so a
 * mode set while they went in is kept too, up to the check just before that
 * chmod. Without it, as a forced push writes, the mode is given whatever the
 * file has, before the bytes and again after them where a mode set while
 * they went in differs, a file the forced push creates included; a file an
 * unforced push creates keeps a mode set while its bytes go in. Setuid and
 * setgid are another matter, whatever `from` says: a file that has either
 * when the write checks it loses both before the bytes, and keeps its
 * permission bits and its sticky bit; the chmod after the bytes keeps the
 * special bits the file has then (withSpecialBits).
 *
 * Where the kernel refuses a chmod (EPERM or EACCES: another user's file,
 * an ACL), the write acts on the refusal. A refused drop of setuid and
 * setgid carries on under the kernel's own rule for a write, which leaves
 * setuid for a writer with CAP_FSETID and setgid where the group can't
 * execute. A refused narrowing refuses the write before its bytes, unless
 * the mode is forced over one disk changed or one nothing records
 * (`overDisk`): then the bytes go in at the mode the file has, as an
 * unforced write's would, and `modeKept` says so. A refused widening, after
 * the bytes or to a created file's exact mode, leaves the file at the mode
 * it has, and `widenRefused` says so.
 * Returns the permission bits the file has after the write, and whether a
 * chmod was refused and the file kept its mode.
 */
export async function writeContained(
  view: MountView, rootReal: string, rel: string, bytes: Buffer, expect: Expect, mode?: number, from?: number, overDisk?: boolean,
  createMode?: number,
): Promise<{ perm: number; widenRefused: boolean; modeKept: boolean }> {
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
    // Where the file would land is judged before anything is made there: a
    // nested mount's place, or one the mount's own include leaves out
    // beneath a link it follows, gets no file of this mount's.
    const refused = await refusedLanding(view, rootReal, rel, target);
    if (refused !== null) throw new EffectFailed(refused, false);
    try {
      // Exclusive: never follows a symlink, never takes over a file that
      // appeared since planning saw none. At the mode it's given, which the
      // umask can only narrow, so the file is never wider than that mode,
      // even stopped before the chmod that makes the mode exact.
      const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode ?? createMode ?? 0o644);
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
    const created = touched;
    await checkOpened(view, rootReal, rel, root, parent, target, handle, expect, noFollow, touched);
    touched = true;
    // The mode the bytes are written at, and the one the file ends with.
    let before: number | undefined;
    let after: number | undefined;
    let left: number | undefined;
    const seen = (await handle.stat({ bigint: true })).mode;
    const current = Number(seen & 0o777n);
    // A file the write creates gets the store's mode exactly, whether or not
    // a chmod was owed when the write was planned: a forced write can find
    // the file removed since.
    const exact = mode ?? (created ? createMode : undefined);
    if (exact !== undefined) {
      if (created) {
        before = exact;
        // Forced (the effect expects any copy), it gives a file it creates its
        // mode after the bytes too, as it gives one in place; an unforced
        // creation keeps a mode set while its bytes go in, as every unforced
        // write does.
        if (expect.kind === 'any') after = exact;
      } else if (from === undefined || current === from) {
        before = current & exact;
        after = exact;
      }
      if (before === current) before = undefined;
      left = before ?? current;
      // A forced write gives its mode after the bytes too, wherever the file's
      // differs then (below); an unforced one owes nothing more here.
      if (after === left && from !== undefined) after = undefined;
    }
    // A file that has setuid or setgid when the write checks it loses both
    // before the bytes, whether or not the write narrows the mode, and keeps
    // the permission bits it has then: no new bytes go in under a privileged
    // bit. Where the kernel refuses that chmod (another user's file, an ACL),
    // the write carries on under the kernel's own rule for a write, which
    // clears setuid, and setgid where the group can execute, for a writer
    // without CAP_FSETID. A narrowing it refuses stops the write first: new
    // bytes aren't written wider than their mode. Forced over a mode disk
    // changed or one nothing records (overDisk), the bytes go in at the mode
    // the file has instead, as they would have without force.
    const drop = before === undefined && !created && (seen & SETUID_SETGID) !== 0n;
    // A widening the kernel refuses leaves the bytes at the mode the file
    // has: the write stands, and its caller says why the mode wasn't given.
    // A created file's chmod to its exact mode widens the one the umask left.
    let widenRefused = false;
    let modeKept = false;
    if (before !== undefined || drop) {
      stage = 'set the file\'s mode';
      try {
        await handle.chmod(await withSpecialBits(handle, before ?? current, STICKY));
      } catch (err) {
        if (!chmodRefused(err)) throw err;
        if (created) widenRefused = true;
        else if (!drop && overDisk) {
          // Forced over a mode disk changed: the bytes go in at the mode
          // the file has, as they would have without force.
          modeKept = true;
          after = undefined;
        } else if (!drop) throw new EffectFailed(notNarrowed(current, before!, mode!), false);
      }
    }
    stage = 'write the file';
    await handle.truncate(0);
    await handle.writeFile(bytes);
    // A mode set while the bytes went in is kept, unless the write is forced:
    // one set in the instant between this check and the chmod isn't, since
    // there's no compare-and-chmod to make the two one step.
    if (after !== undefined) {
      const now = Number((await handle.stat({ bigint: true })).mode & 0o777n);
      // Forced, wherever the file's mode isn't the one it gives; unforced,
      // only over the mode the write left the bytes at.
      if (from === undefined ? now !== after : now === left) {
        stage = 'set the file\'s mode';
        try {
          await handle.chmod(await withSpecialBits(handle, after));
        } catch (err) {
          if (!chmodRefused(err)) throw err;
          widenRefused = true;
        }
      }
    }
    stage = 'make the write durable (file fsync)';
    await handle.sync();
    return { perm: Number((await handle.stat({ bigint: true })).mode & 0o777n), widenRefused, modeKept };
  } catch (err) {
    if (err instanceof EffectFailed) throw err;
    throw new EffectFailed(`could not ${stage}: ${message(err)}`, touched);
  } finally {
    await handle.close();
  }
}

/**
 * Why an effect may not act on the file at `real`, where the mount-relative
 * `rel` lands, or null where it may: outside the mount; in a nested mount's
 * directory, which names that mount only where it covers the place
 * (namesNestedPlace); or a file the mount's own include leaves out where it
 * lands (coversLanding). Reached through a link this mount doesn't follow,
 * the link is what's refused. The opened file's check (checkOpened) asks
 * it, and so does a create, before anything is made.
 */
export async function refusedLanding(view: MountView, rootReal: string, rel: string, real: string): Promise<string | null> {
  const leaves = view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT;
  if (!contained(rootReal, real)) return leaves;
  const holder = await nestedAtReal(real, view.nested, { name: view.name, rootReal });
  if (holder) return namesNestedPlace(holder.rest, holder.include, false) ? leadsInto(view.name, rel, holder) : view.followSymlinks ? leaves : NOT_FOLLOWED;
  if (!(await coversLanding(view, rootReal, real, rel))) return view.followSymlinks ? leaves : NOT_FOLLOWED;
  return null;
}

/**
 * Before an effect on an opened file: a regular file, and — unless forced —
 * still holding what was decided on. The hash reads the whole file, so
 * where the file lies (canonically inside the mount, in no nested mount's
 * directory, nestedAtReal, and covered by the mount's include where it
 * lands, coversLanding) is asked before it, so no file outside the mount or
 * in a nested mount's directory is read for it, and again
 * after it, with the checks that hold when the effect runs: the one this
 * path names (and not a symlink, where the mount follows none and the open
 * couldn't refuse one), with no other names, in the directory still at its
 * path beneath the root still at its own; and nothing wrote it while those
 * ran.
 */
async function checkOpened(
  view: MountView,
  rootReal: string,
  rel: string,
  root: CheckedDir,
  parent: CheckedDir,
  target: string,
  handle: FileHandle,
  expect: Expect,
  noFollow: number,
  touched: boolean,
): Promise<void> {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile()) throw new EffectFailed('not a regular file', touched);
  const located = async (): Promise<string> => {
    const real = await realpath(target).catch(() => null);
    if (real === null) throw new EffectFailed(CHANGED, touched);
    const refused = await refusedLanding(view, rootReal, rel, real);
    if (refused !== null) throw new EffectFailed(refused, touched);
    return real;
  };
  if (expect.kind === 'content') {
    await located();
    if ((await hashAt(target, info, noFollow)) !== expect.hash) throw new EffectFailed(CHANGED, touched);
  }
  const real = await located();
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
  if (!unchanged(info, await handle.stat({ bigint: true }).catch(() => null))) throw new EffectFailed(CHANGED, touched);
}

/** The sticky bit, the one special bit the chmod before a write's bytes keeps. */
const STICKY = 0o1000n;
/** The setuid and setgid bits, which the chmod before a write's bytes drops. */
const SETUID_SETGID = 0o6000n;

/**
 * `perm` with those of the opened file's setuid, setgid and sticky bits that
 * `keep` names, as the file has them now. The store never records them, so
 * a chmod adds none. The chmod before a write's bytes, made whenever the
 * write narrows the mode or the file has setuid or setgid when the write
 * checks it, keeps only the sticky bit, stricter than the kernel's rule for a
 * write, so where it's made no new bytes go in under a setuid or setgid bit
 * the write saw; where the kernel refuses it, the kernel's rule applies
 * (writeContained). A widening chmod after the bytes, and a chmod of the
 * mode alone, keep all three as the file has them then.
 */
async function withSpecialBits(handle: FileHandle, perm: number, keep: bigint = 0o7000n): Promise<number> {
  return Number((await handle.stat({ bigint: true })).mode & keep) | perm;
}

/**
 * Give a mount-relative file the permission bits `mode`, through a located
 * descriptor, after the checks a write in place makes, and make the change
 * durable. The bytes are left as they are. With `from`, a file whose
 * permission bits are no longer those, the ones it had when it was checked,
 * is refused: its mode changed since, and is kept, as a changed byte would
 * be. A chmod the kernel refuses (EPERM or EACCES: another user's file, an
 * ACL) changes nothing, and the result says so (`refused`), with whether it
 * would have removed bits the file has (`narrowing`), for the caller to
 * record and report.
 */
export async function chmodContained(
  view: MountView, rootReal: string, rel: string, mode: number, expect: Expect, from?: number,
): Promise<{ refused: boolean; narrowing: boolean }> {
  const checked = await parentFor(view, rootReal, rel, false);
  if (checked.kind !== 'checked') throw new EffectFailed('the file was removed since it was checked', false);
  const parent = checked.dir;
  const root = checked.root;
  const target = parent.at(nameOf(rel));
  const noFollow = noFollowFlag(view);
  if (!view.followSymlinks && !noFollow) {
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new EffectFailed(NOT_FOLLOWED, false);
  }
  let handle: FileHandle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | NONBLOCK | noFollow);
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT') throw new EffectFailed('the file was removed since it was checked', false);
    if (code === 'ELOOP' && !view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
    throw new EffectFailed(`cannot open the file (${code ?? message(err)})`, false);
  }
  let touched = false;
  let stage = 'set the file\'s mode';
  try {
    await checkOpened(view, rootReal, rel, root, parent, target, handle, expect, noFollow, false);
    const current = Number((await handle.stat({ bigint: true })).mode & 0o777n);
    if (from !== undefined && current !== from) throw new EffectFailed(MODE_CHANGED, false);
    const narrowing = (current & ~mode & 0o777) !== 0;
    touched = true;
    try {
      await handle.chmod(await withSpecialBits(handle, mode));
    } catch (err) {
      if (chmodRefused(err)) return { refused: true, narrowing };
      throw err;
    }
    stage = 'make the mode durable (file fsync)';
    await handle.sync();
    return { refused: false, narrowing };
  } catch (err) {
    if (err instanceof EffectFailed) throw err;
    throw new EffectFailed(`could not ${stage}: ${message(err)}`, touched);
  } finally {
    await handle.close();
  }
}

/**
 * Unlink a mount-relative file, or confirm it gone (`absent` expected: a
 * file found there is never removed). What it removes is a regular file, or
 * a followed symlink to a regular file inside the mount (the link itself).
 * Anything else there is refused, forced or not: a directory; a pipe, socket
 * or device; a symlink the mount doesn't follow; and a followed one that
 * doesn't lead to a regular file inside the mount. Returns the mount
 * directory whose entries make the absence durable, for the caller's
 * barrier: the file's parent, or — when the parent itself is gone — the
 * directory proven to lack it, since that removal may not be durable either.
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
    const kind = info.isDirectory() ? 'a directory' : info.isSymbolicLink() ? 'a symlink' : info.isFile() ? 'a file' : 'a pipe, socket or device';
    throw new EffectFailed(`${kind} appeared at this path since it was checked`, false);
  }
  let file = info;
  if (info.isSymbolicLink()) {
    // The link itself is what is removed; a followed one must still lie inside.
    if (!view.followSymlinks) throw new EffectFailed(NOT_FOLLOWED, false);
    const real = await realpath(target).catch(() => null);
    if (real === null || !contained(rootReal, real)) throw new EffectFailed('a symlink that leaves the mount', false);
    // One leading into a nested mount's directory is that mount's: the link
    // and the file it leads to are left as they are. Where that mount's
    // include leaves the place out, it's no mount's, and the link leaves this
    // one (namesNestedPlace).
    const holder = await nestedAtReal(real, view.nested, { name: view.name, rootReal });
    if (holder) {
      const directory = holder.include !== undefined && await stat(real).then((s) => s.isDirectory(), () => false);
      throw new EffectFailed(namesNestedPlace(holder.rest, holder.include, directory) ? leadsInto(view.name, rel, holder) : 'a symlink that leaves the mount', false);
    }
    const through = await stat(real, { bigint: true }).catch(() => null);
    if (through === null) throw new EffectFailed(CHANGED, false);
    // A followed link stands for the file it leads to, so it's removed only
    // for a regular one, as the file the workspace deleted. This refusal,
    // and the one below for what isn't a regular file at the path, use
    // observation's words for the path, so the push answers a forced unlink
    // and an unforced one alike (reconcile.ts inTheWay).
    if (!through.isFile()) throw new EffectFailed(through.isDirectory() ? 'a symlink to a directory, not walked' : 'not a regular file', false);
    // One leading to a file this mount's own include leaves out leaves the
    // mount too, and that file isn't read for a hash (coversLanding).
    if (!(await coversLanding(view, rootReal, real, rel))) throw new EffectFailed('a symlink that leaves the mount', false);
    file = through;
  } else if (info.isDirectory()) {
    throw new EffectFailed('a directory', false);
  } else if (!info.isFile()) {
    throw new EffectFailed('not a regular file', false);
  } else {
    // A regular file reached through a link among its directories lands
    // where the mount may not act: in a nested mount's directory, or on a
    // file the mount's own include leaves out. It's judged as the create and
    // the opened file's check judge it, before anything reads it for a hash
    // (refusedLanding).
    const refused = await refusedLanding(view, rootReal, rel, target);
    if (refused !== null) throw new EffectFailed(refused, false);
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
