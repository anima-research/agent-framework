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
 * lookup there. File contents are bound more tightly: a file is read only
 * through a descriptor whose identity matches the file its path named, as a
 * check before the open found it (hashAt) or as the path's realpath after
 * the open finds it (openContainedFile), though a link put back after that
 * realpath, leading to the opened file itself, still passes the check
 * (sameLevels).
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { sameRootIdentity, type Fingerprint, type RootIdentity } from './disk-agreement.js';

export interface MountView {
  /**
   * The directory its readers read beneath: the mount's root as configured,
   * or, for a direct mount, the root its view resolved (diskView), so a
   * walk opens what it judges beneath one root.
   */
  root: string;
  /** The mount's name, which a tool puts before a path in the mount. */
  name: string;
  /**
   * The root directory disk last agreed under, once the mount has evidence.
   * A root that resolves to any other directory is unavailable.
   */
  rootIdentity?: RootIdentity;
  followSymlinks: boolean;
  /** Text above this size is not ingested. */
  maxFileSize: number;
  ignore: string[];
  /** The mount's `include`: files and links it doesn't cover are outside the mount. Absent, everything is inside. */
  include?: readonly string[];
  /**
   * Other mounts' directories nested inside this one, mount-relative, each
   * with how disk compares names at each of its levels (NestedDir). Every
   * pass passes over them, named or not, as another mount's directory.
   */
  others: readonly NestedDir[];
  /**
   * The same mounts, each by its directory, its name, its own include and,
   * where it has one, its real root (NestedMount), for a refusal that names
   * the mount a path leads into: through a symlink this mount doesn't follow
   * (linkWords), or through one it follows, or a root configured through one
   * (nestedAtReal). Without it, no path is refused for where its links lead,
   * and a link's refusal names no mount.
   */
  nested?: readonly NestedMount[];
}

/**
 * Whether the directory holding each level of a path folds case, one per
 * level, as the module's start read it (ownCaseFolding): from its own entries
 * within a mount's root, and from the path's own name there above every root.
 * Null where that told nothing, as for a directory that is empty, holds no
 * name with a letter a-z or A-Z, or isn't made yet, or above every root a
 * name with no such letter or not there yet. The comparison counts
 * null as folding, as it does a level no start has read, so it errs toward
 * the nested mount, and a text naming that mount says where it erred
 * (nestedGuess).
 */
export type Folding = readonly (boolean | null)[];

/**
 * A directory another mount holds inside this one, mount-relative and
 * `/`-separated, with whether the directory holding each of its segments
 * folds case (`folds`, Folding): this mount's root for the first, and for
 * each after it, the directory the segments before it name. A path lies in
 * the directory where it begins with its segments as disk compares names
 * (beneathNested). `guessed` where start placed it there only by the
 * comparison's guess above this mount's root, as for two mounts' roots
 * configured in spellings it can't tell apart: a path in it is then a guess,
 * however exactly the rest of the path matches (nestedGuess).
 */
export type NestedDir = { dir: string; folds: Folding; guessed?: true };

/**
 * A mount nested in another: its directory where it's placed there
 * (NestedDir), its name, its real root, which each of its placements
 * shares, with how disk compares names at each level of that from the
 * filesystem's root (`realFolds`, read as `folds` is), and its own include.
 * The real root is the root as realpath resolves it (the nearest existing
 * directory's, where the root isn't made yet) once the module's start has
 * read it, and the root as configured until then. There's none where it's
 * this mount's own or holds it: the mount is nested by its configured path
 * alone, since through its real root it would claim this mount's every path.
 */
export type NestedMount = NestedDir & { name: string; real?: string; realFolds?: Folding; include?: readonly string[] };

export type StatFingerprint = Omit<Fingerprint, 'hashedAt'>;

/**
 * Opened with every open of a workspace path that may already be there, a
 * read, a write in place or a directory's sync, where the platform has it:
 * for a regular file or a directory it changes nothing, and a FIFO or other
 * special file swapped in at the path neither blocks the open nor passes the
 * check of its kind that follows. A create needs none: O_CREAT | O_EXCL fails
 * at once on anything already at the path.
 */
export const NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

export type Observation =
  | { kind: 'absent' }
  /** `mode`: the file's permission bits (`st_mode & 0o777`). */
  | { kind: 'file'; size: number; mtimeMs: number; mode: number; fp: StatFingerprint }
  | { kind: 'unobserved'; reason: string };

export interface ReadResult {
  kind: 'read';
  size: number;
  mtimeMs: number;
  /** The permission bits of the inode the bytes were read from. */
  mode: number;
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

/**
 * What linkOnTheWay found on a path's way beneath the mount's root: a
 * symlink (`link`, mount-relative), or a directory there the walk couldn't
 * ask (`unsure`, with the errno it got).
 */
export type LinkFound = { link: string } | { unsure: string; code: string };

const UNSURE_PREFIX = 'cannot tell whether "';

/**
 * On a mount that doesn't follow symlinks, what is on the way to a
 * mount-relative path: the first directory, from beneath the mount's root
 * down to the path itself (or, `through` 'parents', down to its parent), that
 * is a symlink, or one the walk couldn't ask. Null when there is none, or
 * when the mount follows symlinks. The path is
 * walked as the lookups that follow resolve it, with `.` and `..` taken out,
 * so a `..` after a name that isn't there hides nothing beyond it, and the
 * root, which is the configured path whatever it resolves to, is never on the
 * way, even where the path names it on its way back into the mount. Each
 * directory is asked only whether it is a link, by readlink, from the root
 * down. EINVAL means it isn't, and the walk goes on. Nothing there, a file in
 * the way, or a directory this user can't search (ENOENT, ENOTDIR, EACCES)
 * ends it with nothing found, since nothing beneath is reached through a link
 * and the caller's own lookup meets the same answer. Any other answer, EPERM
 * included, leaves it unsure of what's beneath, and the path is refused for
 * that.
 */
export async function linkOnTheWay(
  view: Pick<MountView, 'root' | 'followSymlinks'>,
  rel: string,
  through: 'path' | 'parents' = 'path',
): Promise<LinkFound | null> {
  if (view.followSymlinks) return null;
  const resolved = relative(resolve(view.root), resolve(view.root, rel));
  if (resolved === '' || resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) return null;
  const parts = resolved.split(sep);
  const last = through === 'path' ? parts.length : parts.length - 1;
  for (let i = 1; i <= last; i++) {
    const at = parts.slice(0, i).join('/');
    try {
      await readlink(join(view.root, at));
      return { link: at };
    } catch (err) {
      const code = errno(err);
      if (code === 'EINVAL') continue; // not a link: on to the next directory
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return null;
      return { unsure: at, code: code ?? String(err) };
    }
  }
  return null;
}

/**
 * On a mount that doesn't follow symlinks, what refuses the mount-relative
 * `rel`, which realpath resolved to `real` (or, `through` 'parents', whose
 * parent it resolved to `real`): the first symlink on its way, or a
 * directory there the walk couldn't ask. Null when the mount follows
 * symlinks, or there's none. Where `real` is the root's canonical path joined
 * with what was resolved (`rel`, or with `through` 'parents', its parent),
 * nothing beneath the root resolved through a link, and nothing more is
 * asked: that is every path through ordinary directories, at no cost
 * per path. Otherwise each directory is asked in turn (linkOnTheWay), since a
 * name spelled otherwise than disk spells it, on a file system that ignores
 * case or Unicode normalization, also resolves to another string, and isn't
 * a link.
 */
export async function linkRefusal(
  view: Pick<MountView, 'root' | 'followSymlinks'>,
  rootReal: string,
  rel: string,
  real: string,
  through: 'path' | 'parents' = 'path',
): Promise<LinkFound | null> {
  if (view.followSymlinks) return null;
  const resolvedAt = through === 'path' ? rel : parentOf(rel);
  if (resolvedAt === '' || real === join(rootReal, resolvedAt)) return null;
  return linkOnTheWay(view, rel, through);
}

/**
 * Where a symlink the walk found leads, for its refusal: to a path inside
 * the mount (mount-relative, as disk spells it, and whether it's a
 * directory), outside the mount, or nowhere it can be resolved to. One
 * realpath, one stat and the respelling, made only when refusing. realpath
 * keeps the spelling the link's target gives, which on a disk that folds
 * names need not be disk's, so the target is respelled before anything
 * judges or names it (diskSpelling).
 */
export type LinkLeads = { kind: 'inside'; target: string; directory: boolean } | { kind: 'outside' } | { kind: 'nowhere' };

export async function linkLeads(root: string, rootReal: string, link: string): Promise<LinkLeads> {
  const leads = await realpath(join(root, link)).catch(() => null);
  if (leads === null) return { kind: 'nowhere' };
  if (!contained(rootReal, leads)) return { kind: 'outside' };
  const directory = await stat(leads).then((info) => info.isDirectory(), () => false);
  return { kind: 'inside', target: await diskSpelling(rootReal, relative(rootReal, leads).split(sep).join('/')), directory };
}

/**
 * The nested mount whose directory holds `target` (mount-relative), as disk
 * compares names (beneathNested), as `innermost` picks one, a directory being
 * sure where start placed it surely and the path matches it surely; undefined
 * when none does.
 */
export function nestedHolder<N extends NestedDir & { name: string }>(target: string, nested: readonly N[]): N | undefined {
  const segments = target.split('/');
  return innermost(nested.filter((n) => beneathNested(segments, n)), (n) => n.dir.split('/').length, (n) => !n.guessed && surelyBeneath(segments, n.dir.split('/'), n.folds));
}

/**
 * Of the nested mounts holding a path, the innermost, as #460 picks one, and
 * among those at one depth, one the path surely lies in (`sure`), so a
 * directory it matches exactly names the mount, and decides by its include,
 * rather than a look-alike only the comparison's guess joins it to.
 */
function innermost<T>(holders: readonly T[], depth: (holder: T) => number, sure: (holder: T) => boolean): T | undefined {
  return [...holders].sort((a, b) => depth(b) - depth(a) || Number(sure(b)) - Number(sure(a)))[0];
}

/**
 * Whether a link's refusal names `holder`, the nested mount whose directory
 * holds the link's target. The target's path is one of that mount's own, so
 * its include decides: the refusal names a directory, or a file the include
 * covers. A refusal's code follows the same test (linkReadError's
 * `other_mount`), so the code says no more than the message.
 */
export function namesHolder(leads: { target: string; directory: boolean }, holder: NestedDir & { include?: readonly string[] }): boolean {
  return namesNestedPlace(restBeneath(leads.target, holder), holder.include, leads.directory);
}

/**
 * Whether a refusal names a place in a nested mount's directory, `rest`
 * beneath that mount's root, as a place of that mount's: a directory, or a
 * file its include covers. The place is one of that mount's own paths, so
 * its include decides, and a refusal's code follows the same test, so the
 * code says no more than the message. Anywhere else the place is no mount's:
 * the outer mount passes over the nested directory, and the nested mount's
 * include leaves it out. So a link the outer mount doesn't follow is refused
 * as one it doesn't follow (namesHolder), and a path that reaches the place
 * through one it follows is refused as one that leaves the mount, in the
 * words each such refusal already has (nestedAtReal's callers).
 */
export function namesNestedPlace(rest: string, include: readonly string[] | undefined, directory: boolean): boolean {
  return directory || insideMount(rest, include);
}

/**
 * Whether a path of a mount is one its passes decide and its listings may
 * name: inside its include, and, in a nested mount's directory, a place
 * that mount names (namesNestedPlace), its directory included. History the
 * mount took in before another was nested there, which that mount's
 * include leaves out, is no mount's, so no pass decides it, and no listing
 * names it or a directory only it implies.
 */
export function withinIncludes(view: Pick<MountView, 'include' | 'nested'>, path: string): boolean {
  if (!insideMount(path, view.include)) return false;
  const holder = nestedHolder(path, view.nested ?? []);
  if (holder === undefined) return true;
  const rest = restBeneath(path, holder);
  return rest === '' || namesNestedPlace(rest, holder.include, false);
}

/**
 * The path a mount's include judges for `given`, one of the mount's paths,
 * which landed at `real`, its canonical path, inside the mount and in no
 * nested mount's directory. Where realpath couldn't resolve it, as for a loop
 * or a directory this process can't search, `real` is the path as
 * path.resolve reads it, which this judges as named, so a caller refuses such
 * a path first, as landingRefusal does (realBeneath's `unresolved`). The
 * include is the operator's statement of which files' content the workspace
 * holds, and a link is a path, not a grant of content, so where a followed
 * path lands is judged as where it's named, as a nested mount's place is
 * (namesNestedPlace). A path that meets no link lands where it's named, and
 * is judged as named. realpath can spell such a path otherwise only as a disk
 * that folds names does, with disk's stored names on macOS and Windows where
 * a path keeps a workspace entry's spelling, so where the spellings differ
 * only so, the path is judged as named where it reaches the landing itself,
 * level by level (sameLevels). Otherwise the landing is judged, as disk
 * spells it, since realpath keeps the spelling a link's target gives, which
 * on a disk that folds names need not be disk's (diskSpelling).
 */
export async function judgedAt(rootReal: string, real: string, given: string): Promise<string> {
  const landed = relative(rootReal, real).split(sep).join('/');
  if (landed === given) return given;
  if (foldedLoosely(landed) === foldedLoosely(given) && await sameLevels(rootReal, given, landed)) return given;
  return diskSpelling(rootReal, landed);
}

/**
 * Whether `given` reaches `landed`, two spellings of a path beneath
 * `rootReal`, level by level: each directory on the way and the file itself
 * are, as `lstat` finds them, one and the same on both sides, so the path as
 * named passes through no link of its own that the landing doesn't. Beneath
 * the last level both sides have, where neither has the next, a file a write
 * would create there lands where it's named. A level only one side has, or
 * one this can't ask, is no such path. It asks each level once, in turn: on a
 * disk that folds names a level both spellings share is one entry, so a link
 * disk puts there after the realpath meets both alike, and a name removed
 * while this asks and put back after reads as a file a write would create.
 * Where a read follows, its check of the opened file catches a link to
 * another file, but not one back to the opened file itself; that race, like
 * one where the spellings match, isn't closed here.
 */
async function sameLevels(rootReal: string, given: string, landed: string): Promise<boolean> {
  const named = given.split('/');
  const landing = landed.split('/');
  const level = (segments: string[], i: number) => lstat(join(rootReal, ...segments.slice(0, i)), { bigint: true })
    .then((st) => st, (err: unknown) => (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR' ? null : undefined));
  for (let i = 1; i <= named.length; i++) {
    const [a, b] = await Promise.all([level(named, i), level(landing, i)]);
    if (a === undefined || b === undefined) return false;
    if (a === null && b === null) return true;
    if (a === null || b === null || !sameFile(a, b)) return false;
  }
  return true;
}

/**
 * Whether a mount's own include covers the file one of its paths, `given`,
 * lands on at `real` (judgedAt): a file it leaves out there is no file of
 * this mount's, and a path that reaches it through a link is refused as one
 * that leaves the mount, in the words each such refusal already has
 * (nestedAtReal's callers). A mount without an include covers every file.
 */
export async function coversLanding(view: Pick<MountView, 'include'>, rootReal: string, real: string, given: string): Promise<boolean> {
  return view.include === undefined || insideMount(await judgedAt(rootReal, real, given), view.include);
}

/**
 * Why a path is refused for what linkOnTheWay found, given where a link
 * leads (linkLeads). For a link, the link is the subject, with where it
 * leads: for a link inside the mount, its target, and for a link to a
 * directory there, the setting the mount's host can change (the link stands
 * among the path's directories, so following a link to a file can't make the
 * path beneath it exist); for one leading outside the mount, that it does;
 * for one that can't be resolved, nothing more. A target in a nested mount's
 * directory (`nested`) is that mount's: the refusal names the mount and the
 * path to use there in place of the link, with what the workspace can't tell
 * apart where the comparison guessed (nestedStep), and offers no setting,
 * since following the link would only reach into another mount's directory. For a
 * directory the walk couldn't ask, which one, and the answer it got. Paths
 * are spelled as the tools take them, from the mount's name. On a mount with
 * an include, an inside target is named only where a tool could name it: a
 * file the include covers, or a directory, which a listing names whatever
 * lies beneath it. Anywhere else the refusal says only that the link isn't
 * followed, so no tool names what lies outside the include. A link the
 * include doesn't cover is outside the mount itself, so its refusal tells
 * nothing of where it leads (shownLeads gives null for it).
 */
export function linkWords(name: string, found: LinkFound, leads: LinkLeads | null, nested: readonly NestedMount[] = [], include?: readonly string[]): string {
  const spell = (rel: string) => `"${rel === '' ? name : `${name}/${rel}`}"`;
  if (!('link' in found)) return `${UNSURE_PREFIX}${name}/${found.unsure}" is a symlink (${found.code})`;
  const link = `${spell(found.link)} is a symlink`;
  if (leads === null || leads.kind === 'nowhere') return `${link}, which this mount does not follow`;
  if (leads.kind === 'outside') return `${link} leading outside the mount, which this mount does not follow`;
  const holder = nestedHolder(leads.target, nested);
  if (holder) {
    if (!namesHolder(leads, holder)) return `${link}, which this mount does not follow`;
    const rest = restBeneath(leads.target, holder);
    const guess = nestedGuess(name, leads.target.split('/'), holder);
    return `${link} to ${spell(leads.target)}, which this mount does not follow; it ${guess === undefined ? 'lies' : 'may lie'} in mount ` +
      `"${holder.name}", nested in mount "${name}": ${nestedStep({ name: holder.name, use: rest ? `${holder.name}/${rest}` : holder.name, guess }, { after: ` in place of ${spell(found.link)}` })}`;
  }
  if (!leads.directory && !insideMount(leads.target, include)) return `${link}, which this mount does not follow`;
  // Following it serves only what the include covers where it leads (judgedAt).
  const setting = !leads.directory ? '' : include === undefined ? "; the mount's host can set followSymlinks: true"
    : "; the mount's host can set followSymlinks: true, for what the include covers where it leads";
  return `${link} to ${spell(leads.target)}, which this mount does not follow${setting}`;
}

/**
 * Where a link linkOnTheWay found leads, as its refusal may tell it
 * (linkLeads), or null where the refusal tells nothing of it: where the walk
 * found a directory it couldn't ask rather than a link, and where the mount's
 * include doesn't cover the link, which is then outside the mount, so its
 * refusal shows only that a link stands on the path. A refusal's code
 * follows the same answer (linkReadError), so the code says no more than the
 * message.
 */
export async function shownLeads(root: string, rootReal: string, found: LinkFound, include: readonly string[] | undefined): Promise<LinkLeads | null> {
  return 'link' in found && insideMount(found.link, include) ? linkLeads(root, rootReal, found.link) : null;
}

/** Why a path is refused for what linkOnTheWay found (linkWords, with where the link leads, as shownLeads tells it). */
export async function linkReason(view: Pick<MountView, 'root' | 'name' | 'nested' | 'include'>, rootReal: string, found: LinkFound): Promise<string> {
  return linkWords(view.name, found, await shownLeads(view.root, rootReal, found, view.include), view.nested, view.include);
}

/**
 * A canonical path's segments, as the nested checks compare them: split at
 * the separator, where a filesystem root's own separators add no empty
 * segment past the first, so `/` is [''], `/data` is ['', 'data'], and a
 * UNC share's root keeps one segment for each of its names.
 */
export function realSegments(path: string): string[] {
  return path.split(sep).filter((segment, i) => i === 0 || segment !== '');
}

/**
 * Where `path`, a canonical path, lies beneath `root`, another, as disk
 * compares names at each level of `root` (`rootFolds`, one per segment of
 * `root` as realSegments splits it, read from the filesystem's root): the
 * segments beneath it, `/`-separated, or undefined where it lies elsewhere,
 * or is `root` itself (sameRoot).
 */
export function beneathRoot(path: string, root: string, rootFolds: Folding): string | undefined {
  const segments = realSegments(path);
  const top = realSegments(root);
  return segments.length > top.length && beginsWith(segments, top, rootFolds) ? segments.slice(top.length).join('/') : undefined;
}

/** Whether `path`, a canonical path, is `root` as disk compares names at each of its levels (beneathRoot's `rootFolds`). */
export function sameRoot(path: string, root: string, rootFolds: Folding): boolean {
  const segments = realSegments(path);
  const top = realSegments(root);
  return segments.length === top.length && beginsWith(segments, top, rootFolds);
}

/**
 * Whether `path`, a canonical path that sameRoot or beneathRoot places at or
 * beneath `root`, surely lies there (surelyBeneath), rather than by the
 * comparison's guess.
 */
export function surelyAtRoot(path: string, root: string, rootFolds: Folding): boolean {
  return surelyBeneath(realSegments(path), realSegments(root), rootFolds);
}

/**
 * The nested mount whose real root holds `real`, a canonical path, as
 * `innermost` picks one, a root being sure where `real` lies surely beneath
 * it by its levels' folding, whatever start guessed about where it lies in
 * the outer mount, which a canonical path doesn't pass through; with how many
 * of `real`'s segments its root takes; undefined when none does. The real root is compared as disk compares names, level by
 * level from the filesystem's root (beginsWith), since realpath keeps a
 * spelling it's given where disk folds it on Linux, as from a link's target,
 * and a canonical path can then name the nested mount's root otherwise than
 * the root's own. A walk asks only this, to pass over a subdirectory that is
 * another mount's; each other check asks nestedAtReal.
 */
export function nestedRootAtReal(real: string, nested: readonly NestedMount[] = []): { mount: NestedMount; depth: number } | undefined {
  const segments = realSegments(real);
  const holders = nested.flatMap((n) => {
    if (n.real === undefined) return [];
    const root = realSegments(n.real);
    const folds = n.realFolds ?? [];
    return beginsWith(segments, root, folds) ? [{ mount: n, depth: root.length, sure: surelyBeneath(segments, root, folds) }] : [];
  });
  return innermost(holders, (h) => h.depth, (h) => h.sure);
}

/**
 * The nested mount whose real root holds `real`, a canonical path, the
 * innermost (nestedRootAtReal), with the path to use there, the path beneath
 * its root (`rest`) and its include; undefined when none does. A path the
 * lexical checks pass (inOtherMount, the tools' holderOf) reaches another
 * mount's directory this way through a symlink the mount follows, so each
 * check that resolves a path canonically asks this too, and names the mount
 * only where namesNestedPlace says the place is that mount's. The rest is
 * read as disk spells it (diskSpelling) beneath that mount's real root,
 * since realpath keeps the spelling a link's target gives there too: so
 * that mount's include judges, and the answer names, disk's file. It's read
 * only where a nested root holds the place. Where the place lies there only
 * by the comparison's guess (surelyBeneath), `guess` says what a text can
 * show of it (NestedGuess): given this mount's name and real root (`at`), and
 * a place beneath that root by its own segments, where it leads by this
 * mount's paths, with the two spellings where the guess lies beneath the
 * root, or the placement where the nested root reaches this mount's root
 * only by a guess; anywhere else null, since what it couldn't tell apart is
 * a host path, which no message shows.
 */
export async function nestedAtReal(real: string, nested: readonly NestedMount[] = [], at?: { name: string; rootReal: string }): Promise<{ name: string; use: string; rest: string; include?: readonly string[]; guess?: NestedGuess } | undefined> {
  const holder = nestedRootAtReal(real, nested);
  if (!holder) return undefined;
  const segments = realSegments(real);
  const given = segments.slice(holder.depth).join('/');
  const rest = given === '' ? '' : await diskSpelling(holder.mount.real!, given);
  const { name, include } = holder.mount;
  const root = realSegments(holder.mount.real!);
  const folds = holder.mount.realFolds ?? [];
  const found = { name, use: rest ? `${name}/${rest}` : name, rest, include };
  if (surelyBeneath(segments, root, folds)) return found;
  // Where the place lies beneath this mount's real root (`at`) by its own
  // segments, a text can show where it leads by this mount's paths. Where the
  // nested root reaches this mount's root only by a guess, the placement is
  // one; otherwise the guess lies beneath, and both spellings are this
  // mount's. Anywhere else they're host paths, which no message shows.
  if (at === undefined) return { ...found, guess: null };
  const top = realSegments(at.rootReal);
  if (segments.length <= top.length || root.length <= top.length || !top.every((t, i) => segments[i] === t)) return { ...found, guess: null };
  const within = segments.slice(top.length);
  const below = root.slice(top.length);
  const guess = guessFor(at.name, within, below, folds.slice(top.length));
  // Where it leads shows the guessed levels as the guess shows them.
  const leads = guess === undefined ? [at.name, ...within].join('/') : [guess.given, ...within.slice(below.length)].join('/');
  // A placement start only guessed at comes first, as in nestedGuess.
  if (!surelyBeneath(root.slice(0, top.length), top, folds)) return { ...found, guess: { ...placedGuess(at.name, within.slice(0, below.length), guess), leads } };
  return { ...found, guess: guess === undefined ? null : { ...guess, leads } };
}

/**
 * Why a mount-relative path that resolves into a nested mount's directory is
 * refused (nestedAtReal): what it leads into, or may lead into where the
 * comparison guessed, and the step to take (nestedStep). Spelled as the
 * tools take paths, from the mount's name.
 */
export function leadsInto(name: string, rel: string, holder: { name: string; use: string; guess?: NestedGuess }): string {
  const verb = holder.guess === undefined ? 'leads' : 'may lead';
  return `"${rel === '' ? name : `${name}/${rel}`}" ${verb} into mount "${holder.name}", nested in mount "${name}": ${nestedStep(holder, { after: ' in its place' })}`;
}

// ===========================================================================
// Disk's spelling of a path
// ===========================================================================

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/** A letter's other case: its upper case if it's in lower case, else its lower case. */
const otherCase = (c: string): string => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

/**
 * The name with each letter's case flipped, where its other case is one
 * letter whose own other case is the letter again, as this runtime's Unicode
 * tables have it: a pair a disk with an older folding table keeps apart, such
 * as Georgian `Ა` and `ა`, is flipped too. `ß`, whose upper case is `SS`, and
 * dotless `ı`, whose upper case `I` lowers to `i`, stay as they are.
 */
const flippedCase = (name: string): string =>
  [...name].map((c) => {
    const other = otherCase(c);
    return [...other].length === 1 && otherCase(other) === c ? other : c;
  }).join('');

/**
 * The name with each ASCII letter's case flipped, and nothing else: the
 * pairs every disk that folds case folds, whatever its folding table's age.
 * A newer pair, such as Georgian `Ა` and `ა`, can be one a disk that
 * folds case keeps apart.
 */
const flippedAscii = (name: string): string => name.replace(/[A-Za-z]/g, otherCase);

/**
 * The name with only its first ASCII letter's case flipped, a spelling
 * neither the name nor flippedAscii's, or null for a name with fewer than
 * two such letters, where there is no such spelling.
 */
const firstFlipped = (name: string): string | null => ((name.match(/[A-Za-z]/g)?.length ?? 0) < 2 ? null : name.replace(/[A-Za-z]/, otherCase));

/** Names compared as NFC in lower case. */
const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * Names compared more loosely, through upper case and back, which also folds
 * `ß` with `ss`, `ſ` with `s` and `ς` with `σ`, as a disk that folds fully
 * does. It also folds dotless `ı` with `i`, which a disk may keep apart;
 * the same-file check keeps that from naming another file.
 */
export const foldedLoosely = (name: string): string => name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();

/**
 * Names compared as fully as a disk that folds names may compare them: with
 * every default-ignorable code point dropped, such as a soft hyphen, a
 * zero-width joiner or a variation selector, then decomposed (NFD), through
 * lower, upper and lower case, and decomposed again, in the shape of
 * Unicode's canonical caseless match. Mapped on the decomposed name, case
 * joins names whose marks come in another order around a combining
 * ypogegrammeni (U+0345), whose upper case is a letter. Linux's casefold,
 * which ext4 and f2fs set per directory, drops those code points, on every
 * kernel but 6.12 to 6.12.4, where this joins more than the disk does, and
 * compares names decomposed in full case folding, and HFS+ passes over some
 * of them too.
 */
const foldedFully = (name: string): string =>
  name.replace(/\p{Default_Ignorable_Code_Point}/gu, '').normalize('NFD').toLowerCase().toUpperCase().toLowerCase().normalize('NFD');

/** What the workspace holds of a mount, as the spelling step reads it (diskSpelling). */
export interface WorkspaceEntries {
  /**
   * Whether the workspace holds an entry at exactly this path, or records an
   * intent there, such as a deletion disk hasn't been given yet.
   */
  has(path: string): boolean;
  /** The paths of the entries under `prefix`, a directory's path and `/`, or `''` for every entry. */
  under(prefix: string): string[];
  /**
   * The nested mount whose directory holds this path, by the nested-mount
   * checks' own reading of it, or undefined where the path is the mount's
   * own.
   */
  holder(path: string): string | undefined;
  /** Whether the mount's root folds case (foldsCase). */
  rootFoldsCase: boolean;
}

/**
 * Whether `dir` folds case, told without writing: by looking up flipped a
 * name it lists whose flipped spelling it doesn't list too (a name with no
 * letter to flip is its own flipped spelling, and two hard links that differ
 * only in case are one file on any disk). Where no name it lists tells, or
 * it can't be listed, the directory holding it is asked instead, where both
 * are on one device, each as a link to it leads: its own name looked up
 * flipped there, or, for a name with no letter to flip, that directory's own
 * folding. A directory on a device of its own is taken to tell case apart. A
 * directory not there yet folds as the one it would be made in. Where
 * nothing tells, it's taken to tell case apart.
 */
export async function foldsCase(dir: string): Promise<boolean> {
  const holder = dirname(dir);
  let listed: Set<string>;
  try {
    listed = new Set(await readdir(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && holder !== dir) return foldsCase(holder);
    listed = new Set();
  }
  const look = (path: string) => lstat(path, { bigint: true }).catch(() => null);
  const name = [...listed].find((n) => !listed.has(flippedCase(n)));
  if (name !== undefined) {
    const [named, flipped] = await Promise.all([look(join(dir, name)), look(join(dir, flippedCase(name)))]);
    return named != null && flipped != null && sameFile(named, flipped);
  }
  if (holder === dir) return false;
  // The directory and its holder are looked up through links, so a root
  // that is one, or is reached through one, is compared by the device it
  // lies on. Whether the holder folds is told by its own entries, the root's
  // name and the flipped name, each looked up without following a link
  // there: a link at the flipped name to the root is another file, and a
  // root that is a link is found as itself.
  const see = (path: string) => stat(path, { bigint: true }).catch(() => null);
  const own = basename(dir);
  const [self, held, entry, flipped] = await Promise.all([see(dir), see(holder), look(dir), look(join(holder, flippedCase(own)))]);
  if (self == null || held == null || self.dev !== held.dev) return false;
  if (flippedCase(own) === own) return foldsCase(holder);
  return entry != null && flipped != null && sameFile(entry, flipped);
}

/**
 * Whether `dir` folds case as its own entries tell, for the nested-mount
 * comparison, by its ASCII letters alone, which every disk that folds case
 * folds (flippedAscii). A name it lists is looked up flipped: the same file
 * there tells that it folds case, and nothing there that it tells case
 * apart. The first name it lists whose flipped spelling it doesn't list too
 * is told so. Where every such name is listed beside its flipped spelling,
 * each pair is told the same way until one tells case apart, since a
 * directory that folds case can list both spellings too, as while a name is
 * renamed in case as it's listed. Null where its own entries tell nothing:
 * it lists no name with an ASCII letter, as an empty directory doesn't, or
 * isn't there yet, or can't be listed, or a lookup fails for another reason
 * than that nothing is there, or the name is gone, or changed, by the time
 * it's looked up again. Unlike foldsCase, which then reads the directory
 * holding a mount's root, it reads nothing beside `dir`: the directory
 * holding it tells this one's folding only where a whole filesystem folds or
 * doesn't, and ext4's and tmpfs's casefold is set per directory, so an empty
 * folding directory can sit in one that tells case apart. Where the flipped
 * spelling finds another file than the name does, as a disk that tells case
 * apart can hold beside it, the name is looked up once more with only its
 * first ASCII letter's case flipped (firstFlipped). A file there tells
 * nothing, since a disk that folds case but numbers a file anew for each
 * spelling it's looked up by, as a FUSE filesystem may, finds the one file
 * under every spelling. Where that lookup finds nothing, it tells case apart
 * on a filesystem whose change times this module trusts
 * (filesystemTrustsCtime), and tells nothing elsewhere: there a name made
 * again between the lookups can keep its change time, so the name, gone for
 * a moment, could make a disk that folds case read as one that tells it
 * apart. A name with no such spelling tells nothing either. Given `name`, a
 * name `dir` holds, such as a path's own segment, that name alone is looked
 * up, in those spellings, and nothing is listed, so nothing else `dir` holds
 * is read: the flipped spelling finds the same directory where `dir` folds
 * case, and nothing, or another directory the third spelling doesn't find,
 * where it tells case apart, the latter only where change times are trusted;
 * a name with no ASCII letter, or one that isn't there, tells nothing.
 */
export async function ownCaseFolding(dir: string, name?: string): Promise<boolean | null> {
  // A lookup that finds nothing answers null; one that fails otherwise, undefined.
  const look = (path: string) => lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined));
  // The name is looked up on each side of its other spellings, and must be
  // the same file with the same change time at both, so a name removed,
  // replaced, made again under the freed inode number or renamed away and
  // back meanwhile, as an editor's save replaces a file, tells nothing
  // rather than either answer: on a disk that folds case, another spelling
  // looked up while the name was gone finds nothing too. So does a hard link
  // made meanwhile, which changes the file's change time; one in the other
  // case made before, in a directory that tells case apart, still reads as
  // folding. A name gone and back with the same inode number and change time
  // still passes, as a rename away and back within one tick of a coarse
  // clock can leave it; that race is outside the nested-mount guarantee
  // (MountConfig.include), and the third spelling's own answer is gated on
  // trusted change times below.
  const unchanged = (a: BigIntStats, b: BigIntStats) => sameFile(a, b) && a.ctimeNs === b.ctimeNs;
  const told = async (unpaired: string): Promise<boolean | null> => {
    const before = await look(join(dir, unpaired));
    const flipped = await look(join(dir, flippedAscii(unpaired)));
    const other = before && flipped && !sameFile(before, flipped) ? firstFlipped(unpaired) : null;
    const third = other === null ? null : await look(join(dir, other));
    const after = await look(join(dir, unpaired));
    if (!before || !after || !unchanged(before, after) || flipped === undefined) return null;
    if (flipped === null) return false;
    if (sameFile(after, flipped)) return true;
    // Reached only where the flipped spelling found another file, as twins
    // in case do: nothing at the third spelling tells case apart only where
    // the change time would have shown the name replaced meanwhile.
    return other !== null && third === null && (await filesystemTrustsCtime(dir)) ? false : null;
  };
  if (name !== undefined) return flippedAscii(name) === name ? null : told(name);
  let listed: Set<string>;
  try {
    listed = new Set(await readdir(dir));
  } catch {
    return null;
  }
  const unpaired = [...listed].find((n) => !listed.has(flippedAscii(n)));
  if (unpaired !== undefined) return told(unpaired);
  // Every name with an ASCII letter is listed beside its flipped spelling,
  // which a disk that folds case can list too, as while a name is renamed in
  // case as it's listed. Each pair is told as a name alone is, so two files at
  // the two spellings tell case apart only as told says, since a disk that
  // folds case but numbers a file anew for each spelling finds two there
  // too. A pair told as folding, as two hard links are, says nothing here and
  // is passed over; the first pair told as telling case apart decides. A
  // name with no ASCII letter is its own flipped spelling, so it's passed
  // over unread, as a directory of numbered entries would otherwise cost
  // lookups for each entry at every start.
  for (const paired of listed) {
    if (flippedAscii(paired) === paired) continue;
    if ((await told(paired)) === false) return false;
  }
  return null;
}

/**
 * A name in simple case folding, letter by letter: each letter as the lower
 * case of its upper case, so `Σ` and a word's last `ς` are both `σ`, `ſ` is
 * `s` and `µ` is `μ`. A letter whose upper case is more than one letter
 * takes its own lower case instead, as the Greek `ᾈ` takes `ᾀ` and `ß` stays
 * `ß`. A letter whose lower case is more than one letter too, as `İ`'s is,
 * stays as it is, and so does dotless `ı`, whose upper case `I` lowers to
 * `i`, which case folding keeps apart from it. Unicode normalization is left
 * alone, and so are letters only a fuller folding joins, such as `ß` with
 * `ss`: no listing shows two such names to be one file, and a disk that
 * folds case needn't join them.
 */
export const lowered = (name: string): string =>
  [...name].map((c) => {
    if (c === '\u0131') return c;
    const upper = c.toUpperCase();
    const lower = [...upper].length === 1 ? upper.toLowerCase() : c.toLowerCase();
    return [...lower].length === 1 ? lower : c;
  }).join('');

/**
 * The name `segment` takes among the workspace's entries directly under the
 * directory `prefix` (its path and `/`, or `''` for the mount's root): the
 * segment itself where an entry is there under it, else the first name, in
 * the order given, equal to it in simple case folding (lowered), else null.
 * A name is compared again only where another name came between its entries,
 * as `N.txt` comes between `N` and `N/x` in path order, so the step doesn't
 * fold a name once for every entry beneath it.
 */
function entryName(paths: readonly string[], prefix: string, segment: string): string | null {
  const want = lowered(segment);
  let found: string | null = null;
  let previous: string | null = null;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === previous) continue;
    previous = name;
    if (name === segment) return segment;
    if (found === null && lowered(name) === want) found = name;
  }
  return found;
}

/**
 * Whether `given`, a name at one level of a path, is `name`, a nested
 * mount's directory's name at that level, as a disk may compare them: in
 * either Unicode normalization form at every level, and in any case where
 * the directory holding them folds case (`folds`), as fully as a disk that
 * folds names may compare them (foldedFully). Where it can't tell, it errs
 * toward the nested mount. So on a disk that keeps the normalization forms
 * apart, a name in the other form of a nested directory's name is taken for
 * that mount's directory, and so, at a level that folds case, is any name
 * foldedFully joins with it that the disk keeps apart, such as `ss` beside a
 * nested `ß`, `ı` beside a nested `i`, or, on a disk that keeps ignorable
 * code points, `in\u00adner` beside a nested `inner`. Such a directory, or
 * file, is no mount's: this mount refuses it, naming the nested mount's
 * path, and the nested mount, whose directory it isn't, never sees it. That
 * fails closed, where comparing more strictly than the disk would let this
 * mount write into the nested mount's directory unseen.
 */
function sameLevel(given: string, name: string, folds: boolean): boolean {
  if (given === name) return true;
  return folds ? foldedFully(given) === foldedFully(name) : given.normalize('NFC') === name.normalize('NFC');
}

/**
 * Whether `segments` begin with `dir`'s, compared level by level from the
 * top (sameLevel), each level as `folds` says, and a level it doesn't say,
 * or says null for, as folding. Once the levels above one match, they name
 * one directory on disk, so the next is compared as that directory compares
 * names. Every nested-mount check makes this one comparison, by a
 * mount-relative path (beneathNested) or by a canonical one (nestedAtReal).
 */
function beginsWith(segments: readonly string[], dir: readonly string[], folds: Folding): boolean {
  return segments.length >= dir.length && dir.every((d, i) => sameLevel(segments[i]!, d, folds[i] ?? true));
}

/** Whether a mount-relative path's segments name a nested mount's directory or lie beneath it, as disk compares names (beginsWith). */
export function beneathNested(segments: readonly string[], nested: NestedDir): boolean {
  return beginsWith(segments, nested.dir.split('/'), nested.folds);
}

/**
 * What a mount-relative path that lies in a nested mount's directory
 * (beneathNested) names beneath it, '' for the directory itself: by its
 * segments, since a name the directory's matches as disk compares names can
 * be another length, as `SS` is beside `ß`.
 */
export function restBeneath(path: string, nested: NestedDir): string {
  return path.split('/').slice(nested.dir.split('/').length).join('/');
}

/** The name with its ASCII letters in lower case, and nothing else changed. */
const asciiLower = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Whether `segments`, which the comparison places beneath `dir` (beginsWith,
 * by `folds`), surely lie there: each of `dir`'s levels is matched exactly,
 * or differs only in its ASCII letters' case at a level whose own entries
 * told it folds. Any other match is where the comparison erred toward the
 * nested mount: another normalization form; a pair only foldedFully joins,
 * such as `ss` beside `ß`, or a name beside itself with a default-ignorable
 * code point inside, which a disk that folds case may keep apart; a case
 * difference past ASCII, which a disk with an older folding table may keep
 * apart; or a case difference at a level whose own entries told nothing.
 */
function surelyBeneath(segments: readonly string[], dir: readonly string[], folds: Folding): boolean {
  return segments.length >= dir.length && dir.every((d, i) => segments[i] === d || (folds[i] === true && asciiLower(segments[i]!) === asciiLower(d)));
}

/**
 * A name as a text shows it beside another it might be taken for, so the
 * two can be told apart: each character past ASCII as its code point, such
 * as `caf\u00e9` beside `cafe\u0301`, and a backslash doubled, so no name's
 * own text reads as one of those.
 */
function shownByCodePoints(name: string): string {
  return [...name].map((c) => {
    const code = c.codePointAt(0)!;
    if (c === '\\') return '\\\\';
    return code < 0x80 ? c : code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  }).join('');
}

/**
 * Where a path lies in a nested mount's directory only by the comparison's
 * guess (surelyBeneath), what a text naming that mount shows of it. Where it
 * guessed within the mount: the directory as the path names it (`given`) and as
 * the nested mount's directory is named (`dir`), each from the mount's name;
 * the directories holding the levels it guessed at only by a case difference
 * where their own entries told nothing at start, as start read them (`untold`),
 * which a start once the nested mount's directory is made would settle, since
 * each then holds that directory's own name; and whether
 * it guessed at any level by the names themselves (`byName`), which a rename
 * settles, whatever those levels read. Where start placed the nested mount
 * there only by a guess, comparing the real roots, the directory as the path
 * names it (`placed`), or, where the path guessed at it too, both spellings as
 * that guess shows them (`placed`, `dir`), since what start couldn't tell apart
 * are host paths. For a link, where it leads (`leads`). Null where a text can
 * show neither: where a link leads elsewhere, its place is a host path, which
 * no message shows.
 */
export type NestedGuess = { given: string; dir: string; untold: readonly string[]; byName: boolean; leads?: string } | { placed: string; dir?: string; leads?: string } | null;

/**
 * NestedGuess for `given`, a path's levels beneath mount `mount`'s root, that
 * the comparison places in a nested mount's directory `dir` by `folds`;
 * undefined where it surely lies there (surelyBeneath). At a level where the
 * two names differ and either holds a character past ASCII, both are shown
 * by their code points (shownByCodePoints).
 */
function guessFor(mount: string, given: readonly string[], dir: readonly string[], folds: Folding): Extract<NestedGuess, { given: string }> | undefined {
  if (surelyBeneath(given, dir, folds)) return undefined;
  const levels = given.slice(0, dir.length);
  const plain = (a: string, b: string) => a === b || !/[^\x00-\x7f]/.test(a + b);
  const shown = (name: string, other: string) => (plain(name, other) ? name : shownByCodePoints(name));
  const guessed = dir.map((d, i) => levels[i] !== d && !(folds[i] === true && asciiLower(levels[i]!) === asciiLower(d)));
  const byCase = dir.map((d, i) => guessed[i] && folds[i] !== false && asciiLower(levels[i]!) === asciiLower(d));
  const shownDir = dir.map((d, i) => shown(d, levels[i]!));
  return {
    given: [mount, ...levels.map((g, i) => shown(g, dir[i]!))].join('/'),
    dir: [mount, ...shownDir].join('/'),
    untold: dir.flatMap((_d, i) => (byCase[i] ? [[mount, ...shownDir.slice(0, i)].join('/')] : [])),
    byName: guessed.some((g, i) => g && !byCase[i]),
  };
}

/**
 * For `segments`, a path of mount `mount` that lies in `nested`'s directory
 * (beneathNested), what a text shows where it lies there only by the
 * comparison's guess (NestedGuess); undefined where it surely lies there.
 */
export function nestedGuess(mount: string, segments: readonly string[], nested: NestedDir): NestedGuess | undefined {
  const dir = nested.dir.split('/');
  const guess = guessFor(mount, segments, dir, nested.folds);
  // A placement start only guessed at comes first: if it's wrong, nothing
  // the path guessed beneath it matters.
  return nested.guessed ? placedGuess(mount, segments.slice(0, dir.length), guess) : guess;
}

/**
 * A placement start only guessed at (NestedDir.guessed), as a text names it:
 * the directory as the path spells it (`levels`), or, where the path guessed
 * at it too, both spellings as that guess shows them (guessFor).
 */
function placedGuess(mount: string, levels: readonly string[], guess: ReturnType<typeof guessFor>): Extract<NestedGuess, { placed: string }> {
  return guess === undefined ? { placed: [mount, ...levels].join('/') } : { placed: guess.given, dir: guess.dir };
}

/** `paths` as a text names them: each in quotes, and the last two joined by "and". */
function quotedList(paths: readonly string[]): string {
  const quoted = paths.map((p) => `"${p}"`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/**
 * The step a text naming nested mount `holder.name` gives: the path to use
 * there (`use`, with `after` following it), and, where the path lies there
 * only by the comparison's guess (`guess`), what the workspace can't tell
 * apart, and a step for each thing the caller may have meant, since the path
 * to use there may name another file, or nothing. A path the caller named
 * (`named`) may also be a new file of this mount's, which a path outside the
 * directory gives a place; a file already there can only be reached once
 * whoever runs the workspace renames one of the two, or, where the guess rests
 * on levels that told nothing at start, starts it again once the nested
 * mount's directory is made: each such level's directory lacked that
 * directory's own name, which tells whether the level is read from a listing
 * or by that name alone (levelFolds).
 */
export function nestedStep(holder: { name: string; use: string; guess?: NestedGuess }, opts: { after?: string; named?: boolean } = {}): string {
  const { guess } = holder;
  const after = opts.after ?? '';
  if (guess === undefined) return `use "${holder.use}"${after}`;
  if (guess === null) {
    return `this workspace can't tell whether where it leads is that mount's directory. ` +
      `If you meant that mount's directory, use "${holder.use}"${after}; if not, ask whoever runs this workspace`;
  }
  const leads = guess.leads === undefined ? '' : `it leads to "${guess.leads}", and `;
  if ('placed' in guess) {
    const check = 'ask whoever runs this workspace to check where the two mounts are configured';
    const outside = guess.dir === undefined ? `"${guess.placed}"` : `"${guess.placed}" and "${guess.dir}"`;
    return `${leads}this workspace can't tell whether "${guess.placed}" is mount "${holder.name}"'s directory, since the two mounts' roots are configured in ` +
      `spellings it can't tell apart. If you meant that mount's directory, use "${holder.use}"${after}. ` +
      (opts.named ? `If you meant one of this mount's own, for a new file use a path outside ${outside}, and for one already there ${check}` : `If not, ${check}`);
  }
  // A guess that rests on the names at any level is settled by a rename, since
  // the comparison then no longer matches there, whatever the levels that
  // told nothing read; only one that rests on case alone needs a restart.
  const untold = guess.byName ? [] : guess.untold;
  const one = untold.length === 1;
  const since = untold.length === 0 ? '' : `, since nothing in ${quotedList(untold)} showed at start how ${one ? 'it compares' : 'they compare'} names`;
  const remedy = untold.length === 0 ? 'rename one of the two'
    : `start it again once mount "${holder.name}"'s directory is made`;
  const own = opts.named
    ? `If you meant one of this mount's own, for a new file use a path outside "${guess.given}" and "${guess.dir}", and for one already there ask whoever runs this workspace to ${remedy}`
    : `If not, ask whoever runs this workspace to ${remedy}`;
  return `${leads}this workspace can't tell "${guess.given}" from "${guess.dir}", ` +
    `mount "${holder.name}"'s directory${since}. If you meant that mount's directory, use "${holder.use}"${after}. ${own}`;
}

/**
 * The name `dir` lists for `segment`: `segment` itself, unless disk folds it
 * there and lists it otherwise. `dir` is listed only where a variant of
 * `segment`, its case flipped or its other Unicode normalization form, finds
 * the same file (device and inode) as `given`, the segment's own entry, as
 * on a disk that folds names. The last segment isn't looked up as given, so
 * for it any variant found leads to the listing: on a disk that tells
 * spellings apart, that's only where `dir` holds a variant as a name of its
 * own. The name as given wins if it's listed; otherwise the segment takes
 * the listed name that folds to it and is the same file, so the name
 * returned reaches the file the segment does, or is the segment as given.
 * Names are compared as NFC in lower case first, and only where none of
 * those is the file, more loosely (foldedLoosely). A directory that can't be
 * listed, or a name that can't be looked up, leaves the segment as given. A
 * segment with no variant at all, no letter to flip and one normalization
 * form, is looked up as given and keeps its spelling; for a last segment
 * with a letter that case maps, such as `ς`, the listing then says whether
 * disk lists it as given. `found` says whether the lookups found disk's
 * file: for a directory, its own lookup; for a last segment, whether a
 * variant was found, which on a disk that tells spellings apart may be
 * another file, or for one with no variant, whether disk has it as given, by
 * the listing where it was read. `caseFolds` says what looking the segment
 * up with its case flipped showed of `dir`: that it folds case, that it
 * tells case apart, or nothing (null), for a segment with no letter to flip.
 * For a segment not looked up as given (`given` null), `caseFolds` is set
 * from whatever file the flipped spelling finds, which tells nothing of
 * `dir`; diskSpelling reads it only for directories, which are looked up as
 * given.
 */
async function listedName(dir: string, segment: string, given: BigIntStats | null): Promise<{ name: string; found: boolean; caseFolds: boolean | null }> {
  const flipped = flippedCase(segment);
  const variants = new Set([flipped, segment.normalize('NFC'), segment.normalize('NFD')]);
  variants.delete(segment);
  // A segment with no variant to try, such as `2024` or `ς`, is looked up
  // as given, the only way to learn that disk has it. A last segment with a
  // letter that case maps, as `ς` does, can reach a file disk lists in
  // another spelling, such as `σ`, on a disk that folds more than case
  // pairs, so there the listing settles whether disk lists it as given.
  if (variants.size === 0) {
    const own = given ?? await lstat(join(dir, segment), { bigint: true }).catch(() => null);
    if (given !== null || own === null || (segment.toLowerCase() === segment && segment.toUpperCase() === segment)) {
      return { name: segment, found: own !== null, caseFolds: null };
    }
    const listed = await readdir(dir).catch(() => null);
    return { name: segment, found: listed?.includes(segment) ?? true, caseFolds: null };
  }
  let folds = false;
  let caseFolds: boolean | null = flipped === segment ? null : false;
  for (const variant of variants) {
    const other = await lstat(join(dir, variant), { bigint: true }).catch(() => null);
    if (other !== null && (given === null || sameFile(other, given))) {
      folds = true;
      if (variant === flipped) caseFolds = true;
      break;
    }
  }
  const as = (name: string) => ({ name, found: folds, caseFolds });
  if (!folds) return as(segment);
  const listed = await readdir(dir).catch(() => null);
  if (listed === null || listed.includes(segment)) return as(segment);
  const target = given ?? await lstat(join(dir, segment), { bigint: true }).catch(() => null);
  if (target === null) return as(segment);
  for (const fold of [folded, foldedLoosely]) {
    for (const name of listed) {
      if (fold(name) !== fold(segment)) continue;
      const info = await lstat(join(dir, name), { bigint: true }).catch(() => null);
      if (info !== null && sameFile(info, target)) return as(name);
    }
  }
  return as(segment);
}

/**
 * `relativePath` as disk spells it. On a disk that folds names, as macOS's
 * does by default (case and Unicode normalization), `SRC/a.ts` reaches
 * `src/a.ts`, and whatever names what it finds from the spelling it was
 * given takes the file in a second time, under a name disk doesn't list. So
 * each segment, from the mount's root down, takes the name its directory
 * lists for it (listedName). The walk goes on beneath a segment only if it's
 * a directory, a symlink not included, so nothing past a link is read. It
 * passes over an empty or `.` segment, which names the directory reached,
 * and goes back up at `..`, to the directory it came from. At the mount's
 * root a `..` stops it, keeping the rest as given: a path can climb above
 * the root and come back in, as `../proj/x` does for a root named `proj`, and
 * walking that would list the directory above the root. An absolute path
 * keeps its spelling too: it names a place from the filesystem's root, not
 * the mount's, so walking it from the mount's root would respell it against
 * other directories, and the path returned could lead outside the mount.
 *
 * Given the workspace's `entries`, an entry not yet on disk spells its path
 * as its file will. A path the workspace holds an entry at exactly keeps its
 * spelling whole, and so does a last segment where the workspace holds an
 * entry at exactly that path once its directories have taken disk's
 * spelling, so an entry that disk lists in another spelling, or in a
 * directory disk lists in another, stays reachable by its own path. `has`
 * counts a path the workspace records an intent at, such as a deletion disk
 * hasn't been given yet, so that's reached by its own path too. And where
 * the directory reached folds case, each segment disk has nothing for takes
 * the name of an entry it equals in simple case folding (entryName), as the
 * disk will once that entry is written: a second draft spelled in another
 * case is the first one. None of this applies where disk's spelling puts the
 * path in a nested mount's directory, by the nested-mount checks' own
 * reading (`holder`): there the path keeps disk's spelling, so they refuse
 * at least what they refuse without the entries. The root's folding is read
 * at start (`rootFoldsCase`), and a directory beneath it is taken to fold as
 * the directory holding it did when its name was looked up with its case
 * flipped, or, for a name with no letter to flip, as the nearest directory
 * above that told, so the step reads nothing more of disk for this.
 */
export async function diskSpelling(root: string, relativePath: string, entries?: WorkspaceEntries): Promise<string> {
  if (relativePath === '' || isAbsolute(relativePath)) return relativePath;
  // A path that names an entry exactly keeps its spelling, read before the
  // walk awaits disk, so the entries' walk needn't run for it.
  const exact = entries?.has(relativePath) ?? false;
  // The path as disk spells it, and as the workspace's entries spell it.
  const segments = relativePath.split('/');
  const spelled = [...segments];
  // The directories walked into, the mount's root first; their names below
  // the root, as returned; and whether each folds case: the root's as read at
  // start, and beneath it, whether looking its name up with its case flipped
  // found it in the directory holding it (null for a name with no letter to
  // flip).
  const dirs = [root];
  const names: string[] = [];
  const folding: (boolean | null)[] = [entries?.rootFoldsCase ?? null];
  // From segment `from` on, disk has nothing: each segment takes an entry's
  // name, where the directory reached folds case, passing over an empty or
  // `.` segment, and the rest keeps its spelling from the first segment no
  // entry has a name for, a `..` included.
  const fromEntries = (from: number): void => {
    // The nearest directory, from the one reached up, that told.
    let folds: boolean | null = null;
    for (let k = folding.length - 1; folds === null && k >= 0; k--) folds = folding[k]!;
    if (!entries || exact || !folds) return;
    let prefix = names.length === 0 ? '' : `${names.join('/')}/`;
    const paths = entries.under(prefix);
    for (let j = from; j < spelled.length; j++) {
      const segment = spelled[j]!;
      if (segment === '' || segment === '.') continue;
      const name = entryName(paths, prefix, segment);
      if (name === null) return;
      spelled[j] = name;
      prefix = `${prefix}${name}/`;
    }
  };
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (dirs.length === 1) break;
      dirs.pop();
      names.pop();
      folding.pop();
      continue;
    }
    const dir = dirs[dirs.length - 1]!;
    if (i === segments.length - 1) {
      const { name, found } = await listedName(dir, segment, null);
      segments[i] = name;
      if (!exact && !entries?.has([...names, segment].join('/'))) {
        spelled[i] = name;
        if (!found) fromEntries(i);
      }
      break;
    }
    const given = await lstat(join(dir, segment), { bigint: true }).catch(() => null);
    if (given === null) {
      fromEntries(i);
      break;
    }
    const { name, caseFolds } = await listedName(dir, segment, given);
    segments[i] = name;
    spelled[i] = name;
    if (!given.isDirectory()) break;
    dirs.push(join(dir, name));
    names.push(name);
    folding.push(caseFolds);
  }
  const asDisk = segments.join('/');
  if (!entries || entries.holder(asDisk) !== undefined) return asDisk;
  return exact ? relativePath : spelled.join('/');
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
    // NONBLOCK: a FIFO put at its path since it was checked opens at once,
    // and is refused below as not this directory, instead of holding the
    // open, and with it the mount's turn, until something opens it for
    // writing.
    const handle = await open(this.real, fsConstants.O_RDONLY | NONBLOCK);
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
    // A link on the way that can't be resolved, such as a loop, is still a
    // link this mount doesn't follow.
    const found = rel === '' ? null : await linkOnTheWay(view, rel);
    if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
    return { kind: 'unobserved', reason: `cannot resolve the directory (${code ?? String(err)})` };
  }
  // A mount that doesn't follow symlinks goes through none on the way to a
  // directory, inside the mount or out of it.
  const found = await linkRefusal(view, rootReal, rel, real);
  if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
  if (rel === '') {
    // The root is whatever the configured path names, and it must still be
    // the root the pass was given.
    if (real !== rootReal) return { kind: 'unobserved', reason: ROOT_UNAVAILABLE };
  } else if (!contained(rootReal, real)) {
    return { kind: 'unobserved', reason: OUTSIDE_PARENT, outside: true };
  } else {
    // Through a link this mount follows, a directory can be a nested
    // mount's, which the mount neither reads nor writes. A place there that
    // mount's include leaves out is no mount's, and holds nothing beneath it,
    // as at any file (namesNestedPlace).
    const holder = await nestedAtReal(real, view.nested, { name: view.name, rootReal });
    if (holder) {
      const directory = holder.include !== undefined && await stat(real).then((info) => info.isDirectory(), () => false);
      return namesNestedPlace(holder.rest, holder.include, directory) ? { kind: 'unobserved', reason: leadsInto(view.name, rel, holder) } : { kind: 'missing' };
    }
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
    // Nothing is made in a nested mount's directory, its root included where
    // it isn't made yet, by a path that reaches it through a link.
    const holder = await nestedAtReal(base.at(parts[i]!), view.nested, { name: view.name, rootReal });
    if (holder) return { kind: 'unobserved', reason: leadsInto(view.name, childRel, holder) };
    try {
      await mkdir(base.at(parts[i]!));
    } catch (err) {
      const code = errno(err);
      if (code !== 'EEXIST') return { kind: 'unobserved', reason: `cannot create the directory ${childRel} (${code ?? String(err)})` };
    }
    // Made, or there already (made meanwhile, or not a directory): it must
    // be a real directory now, never a symlink or file in its place.
    const checked = await checkedAt(view, childRel, base.at(parts[i]!));
    if (!checked) {
      // A symlink in the way, such as one that leads nowhere, on a mount that
      // doesn't follow symlinks, is named as one.
      const there = view.followSymlinks ? null : await lstat(base.at(parts[i]!)).catch(() => null);
      if (there?.isSymbolicLink()) return { kind: 'unobserved', reason: await linkReason(view, rootReal, { link: childRel }) };
      return { kind: 'unobserved', reason: 'a parent path is not a directory' };
    }
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
 * its replacement's absence to the original's path. On a mount that follows
 * symlinks, symlinked directories inside the mount are followed as parents;
 * on one that doesn't, a symlinked directory on the way proves nothing, and
 * the reason says so (linkReason). Any other symlink proves nothing.
 * Returns the directory whose entries prove it, or why absence couldn't be
 * shown.
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
      // A mount that doesn't follow symlinks goes through none on the way.
      if (!view.followSymlinks) return linkReason(view, rootReal, { link: childRel });
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
 * Where a path's parent directory canonically lies: inside the mount, with
 * that real path, gone (absence is then proven separately), or somewhere a
 * no-follow open would still reach through — O_NOFOLLOW guards only the
 * final component — which on a mount that doesn't follow symlinks is any
 * symlink on the way.
 */
async function parentPlacement(view: MountView, rootReal: string, relativePath: string): Promise<{ inside: string } | 'gone' | { reason: string }> {
  try {
    const parent = await realpath(dirname(join(view.root, relativePath)));
    const found = await linkRefusal(view, rootReal, relativePath, parent, 'parents');
    if (found !== null) return { reason: await linkReason(view, rootReal, found) };
    if (!contained(rootReal, parent)) return { reason: OUTSIDE_PARENT };
    const holder = await nestedAtReal(parent, view.nested, { name: view.name, rootReal });
    if (!holder) return { inside: parent };
    // A place there that the nested mount's include leaves out is no mount's,
    // and holds nothing beneath it, as beneath any file (namesNestedPlace).
    const directory = holder.include !== undefined && await stat(parent).then((info) => info.isDirectory(), () => false);
    return namesNestedPlace(holder.rest, holder.include, directory) ? { reason: leadsInto(view.name, parentOf(relativePath), holder) } : 'gone';
  } catch (err) {
    const code = errno(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    // A link on the way that can't be resolved, such as a loop, is still a
    // link this mount doesn't follow.
    const found = await linkOnTheWay(view, relativePath, 'parents');
    if (found !== null) return { reason: await linkReason(view, rootReal, found) };
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
  const placement = await parentPlacement(view, rootReal, relativePath);
  if (placement === 'gone') return absence(view, rootReal, relativePath);
  if ('reason' in placement) return { kind: 'unobserved', reason: placement.reason };
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
    const holder = await nestedAtReal(real, view.nested, { name: view.name, rootReal });
    // A place a nested mount's include leaves out is no mount's, so the link
    // leaves this one (namesNestedPlace).
    if (holder) {
      return { kind: 'unobserved', reason: namesNestedPlace(holder.rest, holder.include, target.isDirectory()) ? leadsInto(view.name, relativePath, holder) : 'a symlink that leaves the mount' };
    }
    if (!target.isFile()) {
      return { kind: 'unobserved', reason: target.isDirectory() ? 'a symlink to a directory, not walked' : 'not a regular file' };
    }
    // A file this mount's own include leaves out where the link lands is no
    // file of this mount's (coversLanding). It's judged here, and not only
    // where the file is opened, since a pass takes a copy whose fingerprint
    // the stat vouches for without opening it.
    if (!(await coversLanding(view, rootReal, real, relativePath))) return { kind: 'unobserved', reason: 'a symlink that leaves the mount' };
    info = target;
  } else if (info.isDirectory()) {
    return { kind: 'unobserved', reason: 'a directory' };
  } else if (!info.isFile()) {
    return { kind: 'unobserved', reason: 'not a regular file' };
  } else if (!(await coversLanding(view, rootReal, join(placement.inside, basename(lexical)), relativePath))) {
    // So is one reached through a link among its directories.
    return { kind: 'unobserved', reason: 'a symlink that leaves the mount' };
  }
  return { kind: 'file', size: Number(info.size), mtimeMs: Number(info.mtimeMs), mode: Number(info.mode & 0o777n), fp: statFingerprint(info) };
}

/**
 * Open a mount-relative file for reading, located: a regular file that
 * canonically lies inside the mount, whatever the symlink policy, since
 * O_NOFOLLOW guards only the final component; on a mount that doesn't follow
 * symlinks, reached through no symlinked directory either (linkRefusal); and
 * the file the canonical path names now. The handle is the caller's to close.
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
    if (code === 'ELOOP' && !view.followSymlinks) {
      // The link at the path, or a looping one on its way.
      const found = await linkOnTheWay(view, relativePath, 'parents');
      return { kind: 'unobserved', reason: found === null ? NOT_FOLLOWED : await linkReason(view, rootReal, found) };
    }
    if (code === 'EISDIR') return { kind: 'unobserved', reason: 'a directory' };
    return { kind: 'unobserved', reason: `cannot open (${code ?? String(err)})` };
  }
  let keep = false;
  try {
    const info = await handle.stat({ bigint: true });
    const real = await realpath(lexical).catch(() => null);
    if (real === null) return { kind: 'unobserved', reason: 'the file changed while it was read' };
    // O_NOFOLLOW guards only the final component: a mount that doesn't
    // follow symlinks goes through none among the directories on the way
    // either. Asked of what the path resolved to after the open, which the
    // check below holds to the descriptor's file, and before what the
    // descriptor holds, so a link gets its own answer whatever it leads to.
    const found = await linkRefusal(view, rootReal, relativePath, real);
    if (found !== null) return { kind: 'unobserved', reason: await linkReason(view, rootReal, found) };
    if (!info.isFile()) return { kind: 'unobserved', reason: info.isDirectory() ? 'a directory' : 'not a regular file' };
    const leaves = view.followSymlinks ? 'a symlink that leaves the mount' : OUTSIDE_PARENT;
    if (!contained(rootReal, real)) return { kind: 'unobserved', reason: leaves };
    const holder = await nestedAtReal(real, view.nested, { name: view.name, rootReal });
    // A place a nested mount's include leaves out is no mount's. Reached
    // through a link this mount doesn't follow, the link is what's refused.
    if (holder) return { kind: 'unobserved', reason: namesNestedPlace(holder.rest, holder.include, false) ? leadsInto(view.name, relativePath, holder) : view.followSymlinks ? leaves : NOT_FOLLOWED };
    // So is a file this mount's own include leaves out (coversLanding).
    if (!(await coversLanding(view, rootReal, real, relativePath))) return { kind: 'unobserved', reason: view.followSymlinks ? leaves : NOT_FOLLOWED };
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
        mode: Number(info.mode & 0o777n),
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
      mode: Number(info.mode & 0o777n),
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

/** A file's bytes as readBytes read them, none hashed. */
export interface BytesResult {
  kind: 'bytes';
  /**
   * Its size in bytes: as read, for a file within the limit; as its fstat
   * says, for one over it, and at least one past the limit where the reads
   * found it grown past it.
   */
  size: number;
  /** The whole file, when it is at most the limit both at its fstat and as read; null otherwise. */
  bytes: Buffer | null;
  /** Its first bytes (at most HEAD_BYTES), for binary detection and MIME sniffing. */
  head: Buffer;
}

/**
 * A mount-relative file's bytes, through the same located descriptor as
 * readPath, for a direct mount's tools, which keep nothing: at most `limit`
 * of them, and none hashed. A file over `limit` at its fstat has only its
 * head read, and one that grew past it since is read no further than it.
 * What the open refuses gets the reason a listing gives it, such as a link
 * to a directory, except a regular file it couldn't open, which keeps the
 * open's.
 */
export async function readBytes(
  view: MountView,
  rootReal: string,
  relativePath: string,
  limit: number,
): Promise<BytesResult | Exclude<Observation, { kind: 'file' }>> {
  const opened = await openContained(view, rootReal, relativePath);
  if (!('handle' in opened)) {
    // A walk takes a link to a directory as an entry, where the mount follows
    // links, and the open may refuse it as a directory or, where it can't
    // be opened, by its errno: either way it's named as a listing names it
    // (observePath).
    if (opened.kind === 'unobserved') {
      const seen = await observePath(view, rootReal, relativePath);
      return seen.kind === 'file' ? opened : seen;
    }
    return opened;
  }
  const { handle, info } = opened;
  try {
    const size = Number(info.size);
    if (size > limit) {
      const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return { kind: 'bytes', size, bytes: null, head: head.subarray(0, bytesRead) };
    }
    const { bytes, more } = await readPrefix(handle, limit, size);
    if (more) return { kind: 'bytes', size: Math.max(Number((await handle.stat({ bigint: true })).size), bytes.length + 1), bytes: null, head: bytes.subarray(0, HEAD_BYTES) };
    return { kind: 'bytes', size: bytes.byteLength, bytes, head: bytes.subarray(0, HEAD_BYTES) };
  } catch (err) {
    return { kind: 'unobserved', reason: `cannot read (${errno(err) ?? String(err)})` };
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
   * The names in `others` that it doesn't pass over by design and that the walk took, as it
   * takes files, against its cap: the pass observes these by path. The rest
   * are present, and not observed by this pass.
   */
  othersTaken: Set<string>;
  /** Directories seen. */
  dirs: Set<string>;
  /**
   * Names seen that are neither (symlinks, sockets…), or that the walk passes
   * over by design (another mount's directory, the ignore list, an editor's
   * file name): present, unproven.
   */
  others: Map<string, string>;
  /**
   * The entries in `others` that the mount's include doesn't cover and that
   * are neither directories nor links (a regular file, a FIFO, a socket or a
   * device): present, unproven, and holding nothing beneath them. Only provenAbsent
   * reads it, for a directory listed whole. A path beneath a name passed
   * over by design is never decided (reconcile), so those need no such
   * record.
   */
  otherFiles: Set<string>;
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
   * design: one that hides a tracked entry, or is the pass's whole scope, is
   * reported as incomplete, and any other is counted as passed over. A
   * `symlink` region is never walked; the pass reports the link itself by
   * path.
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

/** Why a walk passes over a file or link the mount's `include` doesn't cover, and a push leaves one alone. */
export const OUTSIDE_INCLUDE = "outside the mount's include";

/**
 * The segments of a path after its mount's name, as the workspace reads them
 * everywhere: split at `/`, and at `\` too where that's the platform's
 * separator, with no empty or `.` segment. A `..` segment stays, for the
 * parse to take back the segment before it or refuse as a climb.
 */
export function pathSegments(path: string, platformSep: string = sep): string[] {
  return (platformSep === '\\' ? path.replaceAll('\\', '/') : path).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * Whether a mount-relative path is spelled as the workspace's parsing spells
 * one: segments between single `/`, none empty, `.` or `..`, with no `\`
 * where that's the separator, or '' for the root. A walk and the watcher name
 * paths this way. An earlier version stored a path as it was written, so the
 * store can hold a key such as `a//b.txt` or `c/`, which no spelling names.
 */
export function parsedSpelling(relativePath: string, platformSep: string = sep): boolean {
  if (relativePath === '') return true;
  const segments = pathSegments(relativePath, platformSep);
  return !segments.includes('..') && segments.join('/') === relativePath;
}

/**
 * Whether a mount-relative path is inside its mount: spelled as parsing spells
 * one (parsedSpelling), and covered by the mount's `include` when it has one.
 * The mount's root, '', is inside. A store key no spelling names is outside,
 * as an entry the include doesn't cover is: nothing lists, counts, syncs or
 * writes it, and history keeps it as it was.
 */
export function insideMount(relativePath: string, include: readonly string[] | undefined): boolean {
  if (!parsedSpelling(relativePath)) return false;
  if (include === undefined || relativePath === '') return true;
  return coveredByInclude(relativePath, include);
}

/**
 * Whether the include's matcher can read `pattern`: a name or an `*.ext` glob,
 * which covers a file by its own name, or a `dir/**` glob, with no empty, `.`
 * or `..` segment, since those name no entry a path reaches. Where `\` is the
 * platform's separator, as on Windows, a pattern holding one can't name a
 * file either, since every path is read with `\` as a separator
 * (pathSegments). A pattern the matcher can't read would match nothing, and
 * take every file out of the mount unsaid, so the module refuses it.
 */
export function includePatternReadable(pattern: unknown, platformSep: string = sep): boolean {
  const segment = (s: string): boolean => s.length > 0 && s !== '.' && s !== '..' && !(platformSep === '\\' && s.includes('\\'));
  const name = (s: string): boolean => segment(s) && !s.includes('/') &&
    (!s.includes('*') || (s.startsWith('*.') && s.length > 2 && !s.slice(1).includes('*')));
  return typeof pattern === 'string' &&
    (pattern.endsWith('/**') ? pattern.length > 3 && pattern.slice(0, -3).split('/').every((s) => segment(s) && !s.includes('*')) : name(pattern));
}

/**
 * Whether a mount's include covers a mount-relative path. Its patterns take
 * `ignore`'s forms, read for files: a name or `*.ext` pattern covers a path by
 * its own last segment, at any depth, and `dir/**` covers what lies beneath
 * `dir`, and not a file named `dir`. Unlike `ignore`, a pattern that matches
 * a directory's name covers nothing beneath it: each file is covered by its
 * own name, so `gate.json` covers `x/gate.json` and not `x/gate.json/run.sh`,
 * and a subtree is named with `dir/**`. A directory is no file, so it needs
 * no covering: where one is a scope, refusesAsOutside (index.ts) decides.
 */
function coveredByInclude(relativePath: string, include: readonly string[]): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  for (const pattern of include) {
    if (pattern.endsWith('/**')) {
      if (relativePath.startsWith(pattern.slice(0, -2))) return true;
    } else if (pattern === name || (pattern.startsWith('*.') && name.endsWith(pattern.slice(1)))) {
      return true;
    }
  }
  return false;
}

/**
 * The ignore patterns a walk that names `scope` reads beneath it: a pattern
 * covering the scope itself, or a directory above it, doesn't apply beneath
 * it (#276); one covering only something inside it does.
 */
export function ignoreBeneath(scope: string, patterns: string[]): string[] {
  return patterns.filter((pattern) => !coveredByIgnore(scope, [pattern]));
}

/**
 * Names editors give the files they keep beside the one being edited: vim's
 * swap files (`.name.swp`, and `.name.swx` while it checks it can make one),
 * backups ending in `~`, and Sublime Text's save-in-progress files, ending
 * in `.subl…tmp`. A walk passes over an entry with such a name as it passes
 * over what the ignore list covers, a directory with what lies beneath it,
 * and the watcher ignores it; a sync that names one takes it in. They are
 * the families chokidar's `atomic` option hid from the watcher, but that
 * tested them against the whole path, unanchored, so it also hid
 * `report.v2.swp`, and under a directory with a dot in its name, a plain
 * `notes.swp`. Here each is matched against an entry's name, to its end,
 * and vim's from its start.
 */
const EDITOR_FILE = /^\..+\.sw[px]$|~$|\.subl.*\.tmp$/;

/** The walk's reason for an entry the mount's ignore list covers. */
export const IGNORED = 'ignored by the mount';
/** The walk's reason for an entry `EDITOR_FILE` names. */
const EDITOR_FILE_REASON = "an editor's swap or backup file";

/**
 * The walk's reason for a link it doesn't enter. On a mount with an include,
 * a link the include's names don't cover is passed over with it, by design,
 * since the walk takes no name the include leaves out as a file: on a mount
 * that follows links, one that leads to a directory, and on one that
 * doesn't, every one.
 */
const LINK_NOT_WALKED = 'a symlink, not walked';

/** Whether a reason the walk gave an entry is one it passes over by design. */
export function passedOverByDesign(why: string | undefined): boolean {
  return why === IGNORED || why === EDITOR_FILE_REASON || why === OTHER_MOUNT || why === OUTSIDE_INCLUDE || why === LINK_NOT_WALKED;
}

/** Why a pass passes over a directory that another mount nested in this one holds, and what lies beneath it. */
export const OTHER_MOUNT = "another mount's directory";

/**
 * Whether a mount-relative path is another mount's directory, or lies
 * beneath one, read as a join reads it: `.` and `..` segments within the
 * path and repeated or trailing separators resolved, links not followed. A
 * stored key such as `a//b/x`, which chronicle accepts, is read as `a/b/x`.
 * A leading `..` that climbs above the mount's root is left as written.
 * Each directory is compared as disk compares names (beneathNested), so a
 * key stored in another spelling, or a directory made in one since the
 * start, is that mount's too. Every nested-mount check (a pass's, a walk's,
 * a push's, grep's) asks this.
 */
export function inOtherMount(relativePath: string, others: readonly NestedDir[]): boolean {
  const segments = posix.normalize(relativePath).replace(/\/+$/, '').split('/');
  return others.some((dir) => beneathNested(segments, dir));
}

/**
 * Why a walk passes over an entry by design, by its mount-relative path and
 * its name: another mount's directory, the ignore list, or an editor's file
 * name. Undefined when none covers it.
 */
function passedOverBecause(relativePath: string, name: string, patterns: string[], others: readonly NestedDir[]): string | undefined {
  if (inOtherMount(relativePath, others)) return OTHER_MOUNT;
  if (isIgnored(relativePath, name, patterns)) return IGNORED;
  if (EDITOR_FILE.test(name)) return EDITOR_FILE_REASON;
  return undefined;
}

/**
 * Why a sync without a path, and the watcher, pass over a mount-relative
 * path: the path itself or a directory above it is passed over by design, as
 * the walk reads each entry by its path and name. A path in another mount's
 * directory is that mount's, whatever else covers a directory above it.
 * Undefined when nothing covers it.
 */
export function passedOverAt(relativePath: string, patterns: string[], others: readonly NestedDir[]): string | undefined {
  if (inOtherMount(relativePath, others)) return OTHER_MOUNT;
  const segments = relativePath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const why = passedOverBecause(segments.slice(0, i + 1).join('/'), segments[i]!, patterns, others);
    if (why !== undefined) return why;
  }
  return undefined;
}

/**
 * Why a walk of `scope` passes over a directory between it and a path beneath
 * it: the first directory strictly beneath the scope and above the path that
 * the mount passes over by design, by its path and name, with the patterns
 * the walk reads there. Undefined when none is.
 */
export function passedOverBetween(scope: string, relativePath: string, patterns: string[], others: readonly NestedDir[]): string | undefined {
  const segments = relativePath.split('/').filter(Boolean);
  const from = scope === '' ? 0 : scope.split('/').filter(Boolean).length;
  for (let i = from; i < segments.length - 1; i++) {
    const why = passedOverBecause(segments.slice(0, i + 1).join('/'), segments[i]!, patterns, others);
    if (why !== undefined) return why;
  }
  return undefined;
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
    files: new Set(), seen: new Set(), othersTaken: new Set(), dirs: new Set(), others: new Map(), otherFiles: new Set(), complete: new Set(), missing: new Set(),
    incomplete: [],
  };
  // A walk that isn't named passes over a scope the mount passes over by
  // design, at it or a directory above it, as its parent's listing would pass
  // over its entry: a name rule (a bare-name ignore entry, an editor's name)
  // doesn't match what lies beneath, as a path rule (`cache/**`) does. So a
  // listing, glob or grep there never starts tracking what the mount leaves
  // out, and a stored copy beneath it is unobserved, as beneath any region
  // passed over by design. Its region says how to take what's there in: a
  // sync that names it, whose scope is walked (#276), below.
  // Another mount's directory is passed over by every walk, named or not,
  // and no sync of this mount takes it in, so its region gives no advice.
  if (scope !== '' && inOtherMount(scope, view.others)) {
    walk.others.set(scope, OTHER_MOUNT);
    walk.incomplete.push({ path: scope, reason: OTHER_MOUNT, kind: 'ignored' });
    return walk;
  }
  if (!opts.named && scope !== '') {
    const why = passedOverAt(scope, view.ignore, view.others);
    if (why !== undefined) {
      walk.others.set(scope, why);
      walk.incomplete.push({ path: scope, reason: `${why}: a sync that names this path takes in what's there, editors' files aside`, kind: 'ignored' });
      return walk;
    }
  }
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
  // file is (agent-framework #276), apart from what a pattern covering only
  // something inside it covers, and editors' files, which are passed over
  // there as anywhere. A listing keeps the ignore: its pass would otherwise
  // start tracking what it lists.
  const ignore = opts.named ? ignoreBeneath(scope, view.ignore) : view.ignore;
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
    for (const path of walk.otherFiles) if (!walk.others.has(path)) walk.otherFiles.delete(path);
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
    // A scope named through a link is listed from where the link leads, so
    // a file in it is judged where it lies as well as by its path, as
    // coversLanding judges where a path lands (judgedAt, once for the
    // listing).
    const judgedDir = view.include === undefined ? rel : await judgedAt(rootReal, dir.real, rel);
    const leaves: Array<[string, boolean]> = [];
    const subdirs: string[] = [];
    const others: Array<[string, string]> = [];
    const otherFiles: string[] = [];
    const regions: Walk['incomplete'] = [];
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Another mount's directory is passed over by its real path too, so a
      // walk that reaches one through a link to a directory above it lists
      // none of that mount's names (nestedRootAtReal). So is any other entry
      // the comparison may take for one, such as a file named like it in the
      // other normalization form, which a read of it refuses. A link isn't
      // checked where it lies, since a read through it is judged where it
      // leads.
      const passedOver = passedOverBecause(childRel, entry.name, ignore, view.others)
        ?? (!entry.isSymbolicLink() && nestedRootAtReal(dir.at(entry.name), view.nested) !== undefined ? OTHER_MOUNT : undefined);
      if (passedOver !== undefined) {
        others.push([childRel, passedOver]);
        regions.push({ path: childRel, reason: passedOver, kind: 'ignored' });
        continue;
      }
      // A file or link the mount's include doesn't cover is outside the
      // mount, a named scope's too. A directory is walked, since a name or an
      // extension glob in include can match beneath it. Anything but a link
      // (a regular file, a FIFO, a socket or a device) is noted as a file,
      // since nothing can lie beneath it.
      if (!entry.isDirectory() && (!insideMount(childRel, view.include) || (judgedDir !== rel && !insideMount(judgedDir === '' ? entry.name : `${judgedDir}/${entry.name}`, view.include)))) {
        // The walk enters no link. A link gets the reason a mount without an
        // include gives it, a symlink the walk doesn't enter, where that's
        // what matters about it. On a mount that follows links, that's a link
        // that leads to a directory: a name or an extension glob can cover
        // what lies beneath it, as beneath a directory, and what's read
        // through it is judged by its path and where it lands, so its own
        // name doesn't put what lies there outside. On one that doesn't, it's
        // every link, since nothing reads through one there, and such a mount
        // resolves none to say where it leads. The link's name is no covered
        // file's, so the walk passes it over as it does one, rather than
        // taking it.
        if (entry.isSymbolicLink() && (!view.followSymlinks || await stat(dir.at(entry.name)).then((info) => info.isDirectory(), () => false))) {
          others.push([childRel, LINK_NOT_WALKED]);
          regions.push({ path: childRel, reason: LINK_NOT_WALKED, kind: 'ignored' });
          continue;
        }
        others.push([childRel, OUTSIDE_INCLUDE]);
        if (!entry.isSymbolicLink()) otherFiles.push(childRel);
        regions.push({ path: childRel, reason: OUTSIDE_INCLUDE, kind: 'ignored' });
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
        if (symlink) regions.push({ path: childRel, reason: LINK_NOT_WALKED, kind: 'symlink' });
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
    for (const p of otherFiles) walk.otherFiles.add(p);
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

  // Each nested root by which directory it is, read once, when the walk
  // first descends: a directory the walk reaches by a path that no
  // comparison of names places in the nested mount's directory, as through a
  // bind mount, or on a disk whose folding goes past the comparison's, is
  // still another mount's directory.
  let nestedRoots: Array<{ dev: string; ino: string }> | undefined;
  const isNestedRoot = async (dir: CheckedDir): Promise<boolean> => {
    if (!view.nested?.length) return false;
    nestedRoots ??= (await Promise.all([...new Set(view.nested.flatMap((n) => (n.real === undefined ? [] : [n.real])))].map(async (real) => {
      const at = await stat(real, { bigint: true }).catch(() => null);
      return at === null ? [] : [{ dev: String(at.dev), ino: String(at.ino) }];
    }))).flat();
    const { dev, ino } = dir.identity();
    return nestedRoots.some((r) => r.dev === dev && r.ino === ino);
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
        if (await isNestedRoot(child.dir)) {
          // Passed over as another mount's directory, as the listing passes
          // over one it knows by path.
          walk.dirs.delete(sub);
          if (!walk.others.has(sub)) {
            walk.others.set(sub, OTHER_MOUNT);
            walk.incomplete.push({ path: sub, reason: OTHER_MOUNT, kind: 'ignored' });
          }
          continue;
        }
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
  for (const [p, why] of walk.others) if (!passedOverByDesign(why) && !walk.othersTaken.has(p)) holdingUntaken.add(parentOf(p));
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
  // only names it passes over by design): telling them apart would take
  // another read. Such a
  // walk keeps its place and reports the directory as not visited, and the
  // next one lists it on its way to the wrap.
  if (left === 0 && lastTaken !== undefined && (holdingUntaken.size > 0 || unlisted > 0)) walk.stoppedAfter = lastTaken;
  return walk;
}

/**
 * Whether the walk proves nothing exists at `path`: some ancestor directory
 * is missing, a completely listed ancestor holds no entry that could lead
 * to it, or an ancestor is a file the mount's include doesn't cover (anything
 * but a directory or a link), which the walk passed over and which holds
 * nothing beneath it.
 * Ancestors outside the walked scope are passed through, so a walk of `a/b`
 * decides paths beneath `a/b` and nothing else.
 */
export function provenAbsent(walk: Walk, path: string): boolean {
  const parts = path.split('/');
  let dir = '';
  for (let i = 0; i < parts.length; i++) {
    if (walk.missing.has(dir)) return true;
    const child = dir ? `${dir}/${parts[i]}` : parts[i]!;
    if (walk.complete.has(dir)) {
      if (i < parts.length - 1 && walk.otherFiles.has(child)) return true; // a file: nothing beneath it exists
      if (walk.others.has(child) || walk.seen.has(child)) return false; // present, but unproven
      if (i === parts.length - 1) return !walk.files.has(child) && !walk.dirs.has(child);
      if (!walk.dirs.has(child)) return true; // no directory there: nothing beneath can exist
    }
    dir = child;
  }
  return false;
}
