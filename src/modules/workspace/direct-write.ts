/**
 * A direct mount's writes (MountConfig.backend): disk is the only copy, so a
 * write lands there whole when its call answers, or doesn't happen and leaves
 * disk as it was. Ported from anima-research/hands-mcp's staged write
 * (src/shared.ts), behind the mount's boundary as the workspace's other
 * effects hold it (effects.ts):
 *
 * - The file's directory is located inside the mount (checkDir), and where
 *   the file lands is judged as a push's write judges it (refusedLanding):
 *   inside the mount, in no nested mount's directory, and covered by the
 *   mount's include. A link at the file is refused on a mount that doesn't
 *   follow links; on one that does, the write goes to the file it leads to
 *   when the call stages it, judged the same way, and the link stays.
 * - The new bytes are staged beside the file, in `.workspace-staged-<id>`,
 *   at the file's mode, special bits included as far as the kernel lets this
 *   process set them (a setgid bit only for a member of the file's group),
 *   and renamed over it, so a reader beside the agent never sees half a file
 *   and a process killed mid-write leaves the old file whole. A file this
 *   process may not write is refused, as a push's write, which opens it for
 *   writing, is refused: the rename needs only the directory's permission.
 *   A process that dies between staging and its rename leaves the staged
 *   file, under that name, which `ls` and `git status` show; so does a
 *   refused write whose removal of its staged file fails or can't tell the
 *   file is its own, or whose directory another writer moved after the
 *   staging, since the removal goes by path (discard) and the path then
 *   leads elsewhere. Nothing sweeps it, and the answer doesn't name it.
 *   The removal checks the staged name holds that file and unlinks it with
 *   no turn of the event loop between, so only a file another writer puts
 *   there in that instant can be removed in its place, or one put there
 *   that a stat can't tell from it: on the freed inode number, with the
 *   same size, mode and owner, in the same tick of a coarse clock.
 * - The rename gives a hard-linked path a file of its own, and the other
 *   links keep the old text: `otherLinks` counts them for the answer.
 * - Just before the rename, an edit's file is checked unchanged since its
 *   read, by its bytes, read again, and its identity (checkUnchanged),
 *   synchronously, so the check and the renames after it run with no turn
 *   of the event loop between. Only a change landing in that instant isn't
 *   seen, which for edit_many runs from the check through its last rename:
 *   no rename can be made conditional.
 * - No sync. The store-backed kind syncs its pushes for its agreement
 *   record (reconcile.ts), and a direct mount keeps none, so a power loss
 *   or a kernel crash can lose a direct write after its answer said it
 *   landed, as it can a hands-mcp write. A process dying can't: the rename is
 *   whole by then.
 *
 * Node has no openat or renameat, so the stage and the rename go through the
 * checked directory's path: a directory replaced by another writer on disk
 * between the directory's check and the staging, or after its last check
 * (placedStill), can redirect them, as effects.ts says of a create. For
 * edit_many that last check is each file's, before the other files' checks.
 */

import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, lstatSync, openSync, readSync, renameSync, unlinkSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { refusedLanding } from './effects.js';
import { ROOT_UNCHECKED, ROOT_UNREADABLE, errnoWayOn, errnoWords, onlyTheHost, systemWords } from './answers.js';
import {
  type CheckedDir,
  type MountView,
  NONBLOCK,
  LEAVES_MOUNT,
  NOT_A_DIRECTORY,
  NOT_FOLLOWED,
  OUTSIDE_PARENT,
  ROOT_UNAVAILABLE,
  checkDir,
  checkRoot,
  errno,
  nameOf,
  parentOf,
} from './observe.js';

const DIRECTORY_THERE = 'A file can\'t be written over a directory; give another path.';
const NOT_REGULAR_THERE = onlyTheHost('put a regular file there');

/** An open that follows no link at the path, where the platform has one. */
const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/** The name a staged file starts with, beside the file it replaces. */
export const STAGED_PREFIX = '.workspace-staged-';

/**
 * Why a direct write didn't happen when its mount's root was replaced under
 * it: a direct mount keeps no root to sync to (MountConfig.backend), so its
 * next call works beneath whatever is there then.
 */
export const ROOT_MOVED = 'the mount root changed while this call was being applied: a new call works beneath whatever directory the mount\'s path leads to then';

/**
 * A file's identity as a write must find it unchanged: device, inode, size,
 * mode, owner, group, and modification and change times, to the nanosecond.
 * The mode, owner and group are fields of their own, since a chmod or chown
 * in the same tick of a coarse clock as the file's last change leaves its
 * change time as it was (checkUnchanged).
 */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export const identityOf = (info: BigIntStats): FileIdentity => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mode: info.mode,
  uid: info.uid,
  gid: info.gid,
  mtimeNs: info.mtimeNs,
  ctimeNs: info.ctimeNs,
});

export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Another writer replaced, changed or removed the file between its read and its rename; nothing was written. */
export class FileChanged extends Error {}

/** Why a direct write didn't happen, in words for its answer; disk is as it was. */
export class WriteRefused extends Error {
  constructor(message: string, readonly wayOn: string | null = null, readonly errno?: string) {
    super(message);
  }
}

const AFRESH = 'Calling again checks it afresh.';

const NAME_ITS_OWN = "Calling again won't change that; if you know the file it leads to, name that file by its own path.";

function refusedWayOn(reason: string, code?: string, hostsName = false): string | null {
  if (reason === ROOT_UNAVAILABLE) {
    return code === 'ENOENT' || code === 'ENOTDIR' ? onlyTheHost("put the mount's directory back at its path") : code !== undefined ? errnoWayOn(code, ROOT_UNREADABLE, true) : ROOT_UNCHECKED;
  }
  if (code !== undefined) return errnoWayOn(code, undefined, hostsName);
  if (reason === NOT_FOLLOWED) return NAME_ITS_OWN;
  if (reason === OUTSIDE_PARENT || reason === LEAVES_MOUNT) return "Calling again won't change that; the workspace writes only inside its mounts.";
  if (reason === NOT_A_DIRECTORY) return "Calling again won't change that while something other than a directory stands where the path needs one; another path, or removing what stands there, would.";
  return null;
}

/** A file's new bytes staged beside it, ready to be renamed over it (stageContained). */
export interface Staged {
  /** Where the rename lands: the file's entry in its checked directory, a followed link's file's included. */
  path: string;
  /** The staged file, beside it. */
  temp: string;
  /**
   * Which file the staged file is, so the rename moves, and a refusal
   * removes, that one and no other put at its name: its whole identity,
   * since a file made where it was unlinked can take its inode number.
   */
  tempIdentity: FileIdentity;
  /** The mount's root and the file's directory, as checked when it was staged. */
  root: CheckedDir;
  parent: CheckedDir;
  /**
   * The other hard links the replaced file had, counted just before the
   * rename and kept once it succeeds: the rename gives this path a file of
   * its own, and they keep the old text. 0 until then, and for a new file.
   */
  otherLinks: number;
}

/**
 * Test seams. `afterStage` is called once a call's files are staged, before
 * they're checked unchanged (another writer acting then); `beforeRename`
 * just before each rename, inside its refusal, so throwing stands for the
 * rename failing. Production sets neither.
 */
export const directWriteTestSeam: {
  afterStage?: (paths: string[]) => void | Promise<void>;
  beforeRename?: (path: string) => void;
} = {};

/** The mount-relative path of a real path inside the mount's root, `/`-separated. */
function relativeTo(rootReal: string, real: string): string {
  return relative(rootReal, real).split(sep).join('/');
}

/**
 * The checked directory a mount-relative file lies in, beneath a checked
 * root, or why not. With `makeDirectory`, missing directories are made, as
 * a push's write makes them; without it, a missing one refuses the write,
 * since an edit replaces a file that exists.
 */
async function directoryOf(view: MountView, rootReal: string, rel: string, makeDirectory: boolean): Promise<CheckedDir> {
  const checked = await checkDir(view, rootReal, parentOf(rel), { create: makeDirectory });
  if (checked.kind === 'checked') return checked.dir;
  if (checked.kind === 'absent') throw new FileChanged(rel);
  const reason = checked.outside ? OUTSIDE_PARENT : checked.reason;
  throw new WriteRefused(reason, refusedWayOn(reason, checked.errno));
}

/**
 * Stage `bytes` beside the mount-relative file `rel`, to be renamed over it:
 * the first half of a direct write. The file keeps its mode, special bits
 * included, as far as the kernel lets this process set them; a new file
 * takes `0666` less the umask, as a shell's would. Its owner and group are
 * this process's and the ones its directory gives a new file, and an ACL or
 * extended attribute on the file isn't carried over, as with any write that
 * renames over a file. Anything there that isn't a regular file is refused,
 * and a refusal removes the staged file it made, except where the header
 * says one is left. The staged file is written and moded through its own
 * handle, never through its name again.
 */
export async function stageContained(
  view: MountView,
  rootReal: string,
  rel: string,
  bytes: Buffer,
  { makeDirectory = false }: { makeDirectory?: boolean } = {},
): Promise<Staged> {
  const root = await checkRoot(view, rootReal);
  if ('reason' in root) throw new WriteRefused(root.reason, refusedWayOn(root.reason, root.errno, true), root.errno);
  let parent = await directoryOf(view, rootReal, rel, makeDirectory);
  let path = parent.at(nameOf(rel));
  let info = await lstat(path, { bigint: true }).catch((err: unknown) => {
    if (errno(err) === 'ENOENT') return null;
    throw new WriteRefused(`cannot stat the file (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
  });
  if (info?.isSymbolicLink()) {
    if (!view.followSymlinks) throw new WriteRefused(NOT_FOLLOWED, NAME_ITS_OWN);
    // A followed link stands for the file it leads to, as a read takes it:
    // the write goes there, judged where it lands, and the link stays.
    const real = await realpath(path).catch((err: unknown) => {
      throw errno(err) === 'ENOENT'
        ? new WriteRefused("a symlink whose target doesn't exist", onlyTheHost('remove the link or make it lead to a file'))
        : new WriteRefused(`cannot resolve the symlink (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
    });
    const leaves = await refusedLanding(view, rootReal, rel, real);
    if (leaves !== null) throw new WriteRefused(leaves, refusedWayOn(leaves));
    const realRel = relativeTo(rootReal, real);
    parent = await directoryOf(view, rootReal, realRel, false);
    path = parent.at(nameOf(realRel));
    info = await lstat(path, { bigint: true }).catch((err: unknown) => {
      // Gone since realpath found it: another writer's change.
      if (errno(err) === 'ENOENT') throw new FileChanged(rel);
      throw new WriteRefused(`cannot stat the file the symlink leads to (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
    });
    if (info.isSymbolicLink()) throw new FileChanged(rel);
  } else {
    // A file, or none yet, reached through a link among its directories
    // lands where the mount may not act: in a nested mount's directory, or
    // on a file its own include leaves out (refusedLanding).
    const leaves = await refusedLanding(view, rootReal, rel, path);
    if (leaves !== null) throw new WriteRefused(leaves, refusedWayOn(leaves));
  }
  if (info?.isDirectory()) throw new WriteRefused('a directory', DIRECTORY_THERE);
  if (info && !info.isFile()) throw new WriteRefused('not a regular file', NOT_REGULAR_THERE);
  // A fixed-length name, so a file whose own name is near the 255-byte limit can still be replaced.
  const temp = parent.at(`${STAGED_PREFIX}${randomUUID()}`);
  let made = false;
  try {
    // A new file is made at 0666 and the kernel takes the umask off as it
    // makes it. A file being replaced gives the staged file its own mode,
    // which only a chmod can set past the umask, and only after the bytes
    // are written, since a write clears a set-user or set-group bit; until
    // then the staged file is the owner's alone, so no other user can read
    // a private file's new text while it's staged.
    const handle = await open(temp, 'wx', info ? 0o600 : 0o666);
    made = true;
    let staged: Staged;
    try {
      await handle.writeFile(bytes);
      if (info) await handle.chmod(Number(info.mode & 0o7777n));
      const own = await handle.stat({ bigint: true });
      staged = { path, temp, tempIdentity: identityOf(own), root: root.dir, parent, otherLinks: 0 };
    } catch (err) {
      // Removed while its handle is still open, so its device and inode
      // name it and no other file: one made at its name since can't have
      // taken its inode number. One that can't be told is left.
      const mine = await handle.stat({ bigint: true }).catch(() => null);
      if (mine) removeIf(temp, (there) => there.dev === mine.dev && there.ino === mine.ino);
      await handle.close().catch(() => undefined);
      throw err;
    }
    try {
      await handle.close();
    } catch (err) {
      // Closed, or not, with its bytes in doubt: removed by its whole identity, as a refusal's.
      await discard(staged);
      throw err;
    }
    return staged;
  } catch (err) {
    // A staged file that couldn't be made names the directory: a push's
    // write in place needs only the file, and this one needs both.
    throw new WriteRefused(made
      ? `cannot write the staged file beside it (${systemWords(errno(err), err)})`
      : `cannot make the staged file in its directory (${systemWords(errno(err), err)}): a direct write needs to write the file's directory as well as the file`, errnoWayOn(errno(err)), errno(err));
  }
}

/**
 * Throw unless the root and the file's directory are still the ones the
 * staging checked, with a push's words for the directory (effects.ts
 * moved()).
 */
export async function placedStill(staged: Staged): Promise<void> {
  if (!(await staged.root.stillHere())) throw new WriteRefused(ROOT_MOVED);
  if (!(await staged.parent.stillHere())) throw new WriteRefused('the directory changed since it was checked', AFRESH);
}

/**
 * Throw unless the file is still what its read found: FileChanged when it
 * changed or is gone, nothing written. `expected` is null for a write, which
 * read nothing and replaces whatever is there. Either way a link swapped in
 * at the file the rename replaces (on a mount that follows links, the file
 * the link at the agent's path led to when the call staged it) is refused
 * rather than replaced, and so is a file this process may not write. It reads the entry the
 * rename replaces, and then the file's bytes, synchronously, as renameInto
 * runs, so a check and the renames after it run with no turn of the event
 * loop between.
 *
 * The identity, taken once the bytes are read, catches a file replaced or
 * re-moded under the call, which equal bytes wouldn't show. The bytes are
 * compared with the ones the edit read: a kernel that stamps files from a
 * coarse clock, as Linux before 6.13 does, leaves a file's identity as it
 * was after a second write of the same size within one tick of its last
 * change (on Debian's Linux 6.12.113 with ext4, 1,632 to 1,752 of 2,000
 * such rewrites kept every stamp, in three runs), and the bytes show that
 * change on every clock. The bytes are read through an open that follows
 * no link and doesn't wait on a pipe put at the path since its lstat, and
 * at most one byte past what the edit read, so the check never blocks and
 * reads no more than that.
 */
export function checkUnchanged(staged: Staged, expected: { identity: FileIdentity; bytes: Buffer } | null): void {
  let now: BigIntStats;
  try {
    now = lstatSync(staged.path, { bigint: true });
  } catch (err) {
    if (errno(err) !== 'ENOENT') throw new WriteRefused(`cannot check that it hadn't changed (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
    if (expected !== null) throw new FileChanged(staged.path);
    return;
  }
  if (now.isSymbolicLink()) throw new WriteRefused('it became a symlink while this call was being applied', AFRESH);
  if (now.isDirectory()) throw new WriteRefused('a directory', DIRECTORY_THERE);
  if (!now.isFile()) throw new WriteRefused('not a regular file', NOT_REGULAR_THERE);
  // As a push's write, which opens the file for writing, would be refused:
  // the rename needs only the directory's permission, and would replace a
  // file its owner made read-only.
  try {
    accessSync(staged.path, fsConstants.W_OK);
  } catch (err) {
    const code = errno(err);
    // Removed since the lstat: a write makes the file anew; an edit's read is gone.
    if (code === 'ENOENT') {
      if (expected === null) return;
      throw new FileChanged(staged.path);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new WriteRefused(`a file the host's process may not write (${errnoWords(code)}): its mode or owner keeps that process out, and calling again is refused until the file's owner, or whoever runs the host, changes that`);
    }
    throw new WriteRefused(`cannot check that the host's process may write it (${systemWords(code, err)})`, errnoWayOn(code), code);
  }
  if (expected === null) return;
  let bytes: Buffer;
  let after: BigIntStats;
  try {
    // No link followed, and no wait on a pipe, if either was put at the path since the lstat.
    const fd = openSync(staged.path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      // One byte past what the edit read, enough to see the file differs:
      // a file another writer made larger, or a pipe a writer keeps
      // filling, put at the path since, costs no more than that.
      bytes = readBounded(fd, expected.bytes.length + 1);
    } finally {
      closeSync(fd);
    }
    // And the entry is still the file the edit read, after its bytes were read.
    after = lstatSync(staged.path, { bigint: true });
  } catch (err) {
    // ELOOP: a link put at the path since the lstat; EAGAIN: a pipe, with a
    // writer and nothing in it yet. Either is another writer's change.
    if (errno(err) === 'ENOENT' || errno(err) === 'ELOOP' || errno(err) === 'EAGAIN') throw new FileChanged(staged.path);
    throw new WriteRefused(`cannot check that it hadn't changed (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
  }
  if (!sameIdentity(identityOf(after), expected.identity) || !bytes.equals(expected.bytes)) throw new FileChanged(staged.path);
}

/** Up to `limit` bytes from the start of `fd`, fewer at its end. */
function readBounded(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    // From where the last read ended (a pipe has no positions to read at).
    const got = readSync(fd, buffer, filled, limit - filled, null);
    if (got === 0) break;
    filled += got;
  }
  return buffer.subarray(0, filled);
}

/**
 * Rename the staged file over the file, synchronously (checkUnchanged says
 * why), counting the other hard links it splits the path from just before.
 * A failed rename leaves the file as it was; the caller removes the staged
 * file (discard).
 */
export function renameInto(staged: Staged): void {
  let otherLinks: number;
  try {
    directWriteTestSeam.beforeRename?.(staged.path);
    // The staged file is still the one this call wrote, not another put at its name.
    const temp = lstatSync(staged.temp, { bigint: true });
    if (!temp.isFile() || !sameIdentity(identityOf(temp), staged.tempIdentity)) {
      throw new WriteRefused('another writer replaced the staged copy of the new text before it could be renamed over the file, which is as it was', 'Calling again writes it afresh.');
    }
    otherLinks = otherLinksAt(staged.path);
    renameSync(staged.temp, staged.path);
  } catch (err) {
    if (err instanceof WriteRefused) throw err;
    throw new WriteRefused(`cannot rename the staged file over it (${systemWords(errno(err), err)})`, errnoWayOn(errno(err)), errno(err));
  }
  // Set once the rename has happened, so a count never stands for a split that didn't.
  staged.otherLinks = otherLinks;
}

/** The other hard links of what the entry at `path` holds: 0 for none there, and when lstat fails, since the count only informs the answer. */
function otherLinksAt(path: string): number {
  try {
    return lstatSync(path).nlink - 1;
  } catch {
    return 0;
  }
}

/**
 * Remove a staged file that won't be renamed, best effort: only the file
 * this call staged, by its whole identity, since whatever another writer
 * put at its name since is theirs, as renameInto leaves it too. Checked and
 * removed synchronously, as the rename is (checkUnchanged says why).
 */
export async function discard(staged: Staged): Promise<void> {
  removeIf(staged.temp, (there) => there.isFile() && sameIdentity(identityOf(there), staged.tempIdentity));
}

/** Unlink what's at `path` if `ours` says it's the file meant; best effort, with no turn of the event loop between the check and the unlink. */
function removeIf(path: string, ours: (there: BigIntStats) => boolean): void {
  try {
    if (ours(lstatSync(path, { bigint: true }))) unlinkSync(path);
  } catch {
    // Gone already, or not ours to know: left, as the header says.
  }
}
