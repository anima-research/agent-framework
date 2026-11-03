/**
 * WorkspaceModule — mountable filesystem abstraction backed by Chronicle tree state.
 *
 * Provides a unified workspace with mount-based filesystem access,
 * auto-sync between real filesystem and Chronicle, and manual materialization.
 */

import { NOTICE_TAG } from '../../notice-tags.js';
import { nameToTypeBack } from '../../supplied-text.js';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { open, readdir, readlink, stat, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, relative, sep } from 'node:path';
import type { JsStore, JsTreeEntry } from '@animalabs/chronicle';
import type { Module, ModuleContext, ProcessState, EventResponse } from '../../types/module.js';
import type { ProcessEvent, ToolDefinition, ToolCall, ToolResult } from '../../types/events.js';
import type {
  AgentActionScan,
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  ReadImageInput,
  WriteInput,
  EditInput,
  EditManyInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
  WorkspaceCreatedEvent,
  WorkspaceModifiedEvent,
  WorkspaceDeletedEvent,
  WorkspaceFsOp,
} from './types.js';
import { WORKSPACE_FS_EVENT_TYPES, opToEventType } from './types.js';
import { MountWatcher, type FsChange } from './watcher.js';
import { hashContent, storedBytes, DEFAULT_MAX_FILE_SIZE, type StoredBytes } from './sync.js';
import { DiskAgreement, EvidenceUnavailable, callGate, rootUnreadable, sameRootIdentity, type RootIdentity } from './disk-agreement.js';
import { type BranchIntent, BranchIntents } from './branch-intent.js';
import { CHANGED, type Cause, DIRECTORY, IGNORED, NONBLOCK, OTHER_MOUNT, OUTSIDE_INCLUDE, ROOT_ON_ANOTHER_DEVICE, ROOT_REPLACED, ROOT_UNAVAILABLE, beneathRoot, checkDir, checkRoot, confirmAbsent, coversLanding, directoryAt, diskSpelling, filesystemTrustsCtime, foldsCase, inOtherMount, insideMount, leadsInto, linkOnTheWay, linkRefusal, linkWords, locateRoot, looksBinary, namesHolder, nestedAtReal, nestedGuess, nestedHolder, nestedStep, observePath, parsedSpelling, passedOverAt, pathSegments, patternRefusal, readBytes, readPrefix, realSegments, restBeneath, rootAbsence, sameRoot, shownLeads, sniffImageMime, surelyAtRoot, walkScope, withinIncludes, type CheckedDir, type LinkFound, type MountView, type NestedGuess, type NestedMount, type WorkspaceEntries } from './observe.js';
import { TOOL_BATCH_HOOK_TIMEOUT_MS, ensureStateRegistered } from '../../module-registry.js';
import { DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS } from '../../tool-result-history.js';
import { type EditSpec, type FilePlan, countBudget, decodeForEdit, hintBudget, planFile } from './edit-plan.js';
import { type EditProblem, type EditTool, cutLine, editList, editReceipt, fitted, refusalText } from './edit-text.js';
import { type FileText, fileText } from './text.js';
import { DEFAULT_READ_LINE_LIMIT, characterPage, linePage } from './read-page.js';
import { type DiskState, type GrepAnswer, grepText, textAnswer } from './result-text.js';
import {
  type MountRuntime,
  type PassOptions,
  type PassResult,
  type PathReport,
  type PushOptions,
  type PushResult,
  type Scope,
  type TreeOp,
  NOT_PUSHED_IN_OTHER_MOUNT,
  WALK_CAP,
  entryMode,
  explained,
  passRoot,
  pushPaths,
  reconcilePass,
  settleAdoptionBeforeMutation,
  wayOn,
} from './reconcile.js';
import { EffectFailed, unlinkContained } from './effects.js';
import { AWAITS_REOPEN, MOUNT_IT, ROOT_RECHECK, Refusal, UNFOLLOWED_STEP, changesFiles, didNothing, errnoCode, errnoWayOn, errnoWords, hostFix, onlyTheHost, systemWords, unexpectedAnswer } from './answers.js';
import { unknownToolMessage } from '../unknown-tool.js';
import { closestNames } from '../../closest-names.js';
import { RecordJournal } from '../../record-journal.js';
import {
  type FileIdentity,
  type Staged,
  FileChanged,
  ROOT_MOVED,
  WriteRefused,
  checkUnchanged,
  directWriteTestSeam,
  discard,
  identityOf,
  placedStill,
  renameInto,
  sameIdentity,
  stageContained,
} from './direct-write.js';

/** Default for how long the after-batch scan may hold the agent's next inference. */
const AGENT_ACTION_SCAN_DEADLINE_MS = 20_000;
/**
 * How long a mount's catch-up pass waits for its watcher to become ready
 * before it starts anyway (ensureRunning). In a probe on Linux at a load near
 * 40, chokidar's first scan of 10,000 entries took 1.3 s, about a twentieth of
 * this. A scan slower than the bound has the pass started beside it, and the
 * watcher's ready runs the pass again once the scan ends.
 */
const CATCH_UP_BOUND_MS = 30_000;
/** Why a call is refused once the module has stopped. */
const NOT_RUNNING = 'The workspace has stopped: it takes no more work until it starts again';
/** writeBinary's refusal when the store's branch is no longer the one its file is for. */
const BRANCH_LEFT = 'the workspace had left the branch this file is for';
/** The workspace's own deadline must end before the framework's hook bound. */
const AGENT_ACTION_SCAN_DEADLINE_MAX_MS = TOOL_BATCH_HOOK_TIMEOUT_MS - 1_000;
/** A direct mount's ignore list when its config names none (MountConfig.ignore). */
const DIRECT_MOUNT_IGNORE: readonly string[] = ['node_modules', 'dist', '.git', 'build', 'coverage', 'target', '__pycache__', '.venv'];
const PATTERN_FORMS = 'The list reads these of gitignore\'s forms: a name, matched at any depth, with "*" and "?" within it; '
  + 'a trailing "/" to match only directories; a leading or inner "/" for a path from the mount\'s root; '
  + 'a leading "**/" before one name; and a trailing "/**" for what lies beneath a directory.';
/**
 * How many files a direct mount's grep reads, and its listings look at, at
 * once. Over a layout of seven checkouts, 5,929 files, a direct grep reading
 * 16 at a time on Node's default threadpool had a median time below the
 * store-backed grep's over the same files at every load tried, and one
 * reading them in turn took 2 to 2.4 times as long.
 */
const DIRECT_READS_AT_ONCE = 16;
/** Why sync passes over a direct mount, as its result's `skipped` says. */
const DIRECT_SYNC_SKIPPED = "a direct mount: its tools read disk as it is, so there's nothing to take in";
/** Why materialize passes over a writable direct mount, as its result's `skipped` says. */
const DIRECT_MATERIALIZE_SKIPPED = "a direct mount: its writes are on disk as they're made, so there's nothing to write";

const NOTHING_RECORDED_YET = 'nothing is recorded of this root yet, so any directory at its path is taken as it';
const NOTHING_RECORDED = `${NOTHING_RECORDED_YET}; the first sync that takes in a file, or materialize that writes one, records it`;
const NOTHING_RECORDED_READ_ONLY = `${NOTHING_RECORDED_YET}; the first sync that takes in a file records it`;

const BORN_UNRECORDED = 'no birth time is recorded of this root yet, so a directory made again in its place with the same inode can\'t be told from it; the next sync or ls of this mount records it';

interface RootAsShown { dev: string; ino: string; born?: string }

function asShown(identity: RootIdentity | null): RootAsShown | null {
  if (identity?.born === undefined) return identity;
  const ns = BigInt(identity.born);
  const second = new Date(Number(ns / 1_000_000_000n) * 1000).toISOString().replace(/\.000Z$/, '');
  return { ...identity, born: `${second}.${String(ns % 1_000_000_000n).padStart(9, '0')}Z` };
}

export type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  ReadImageInput,
  WriteInput,
  EditInput,
  EditManyInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
} from './types.js';

type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

class WorkspaceImageReadError extends Refusal {
  constructor(readonly reason: string, wayOn: string | null) {
    super(wayOn === null ? sentence(reason) : `${reason}. ${wayOn}`);
    this.name = 'WorkspaceImageReadError';
  }
}

const IMAGE_STAYS = "Calling again won't change that; only a whole image in its place would.";

function truncatedImage(mountPrefixedPath: string): WorkspaceImageReadError {
  return new WorkspaceImageReadError(`${JSON.stringify(mountPrefixedPath)} is too short to be an image: it ends inside an image format's signature`, IMAGE_STAYS);
}

function emptyImage(mountPrefixedPath: string): WorkspaceImageReadError {
  return new WorkspaceImageReadError(`${JSON.stringify(mountPrefixedPath)} is empty, so there's no image in it`, IMAGE_STAYS);
}

/**
 * Why a workspace-owned filesystem read was refused. Distinguishes the cases a
 * peer needs to react to differently: a path that never resolved inside the
 * mount (`unknown_mount`, `traversal`), a mount whose root is gone, isn't a
 * directory, or isn't the directory the workspace was using
 * (`mount_unavailable`: with errno ENOENT or ENOTDIR when no directory is
 * there at all, with none for another directory), an ordinary missing file
 * or one that isn't a regular file, such as a FIFO (`not_found`), a directory
 * (`directory`), a file that is itself a symlink, refused by the mount's
 * `followSymlinks` policy (`symlink`), a symlink among the path's directories
 * on a mount that doesn't follow symlinks, leading to a directory or a file
 * inside the mount, or nowhere (`parent_symlink`), whose message names the
 * link and, where it leads somewhere, its target, a symlink whose canonical
 * target lands outside the canonical mount root, or one among the path's
 * directories leading out of it (`escape`), a file swapped underneath the read
 * (`changed`), a path the mount's `include` doesn't cover (`outside_include`),
 * and a path in another mount's directory nested in the one named
 * (`other_mount`), whose message names the mount that holds it, or may hold
 * it, and the path to use there. A symlink leading into such a directory is
 * `other_mount` only where its refusal names that mount: a directory, or a
 * file that mount's include covers, and so does the include of each other
 * nested mount whose directory may hold it, out to the first that surely
 * does. Anywhere else, on a mount that doesn't follow
 * symlinks, it gets the code of a link where it stands, `symlink` at the
 * path itself and `parent_symlink` on its way, and on one that does,
 * `escape`, as a path that leaves the mount. On a mount with an include, a
 * link's message names its target only where a tool could name it: a
 * directory, or a file the include covers. A link the include doesn't cover
 * is outside the mount, and its message tells nothing of where it leads, so
 * on a path's way its code is `parent_symlink` wherever it leads; named
 * itself, it's refused as outside the include (`outside_include`), as any
 * path the include doesn't cover is.
 * A `mount_unavailable` for a root whose realpath or stat fails otherwise
 * carries that errno, such as EACCES.
 */
export type WorkspaceReadErrorCode =
  | 'unknown_mount'
  | 'traversal'
  | 'outside_include'
  | 'other_mount'
  | 'mount_unavailable'
  | 'not_found'
  | 'directory'
  | 'symlink'
  | 'parent_symlink'
  | 'escape'
  | 'changed';

/** Where in the open sequence a `WorkspaceReadError` originated (diagnostics). */
export type WorkspaceReadStage =
  | 'parse'
  /** The mount root's check: a directory, the one the workspace was using. */
  | 'root'
  | 'readlink'
  | 'lstat'
  | 'realpath_root'
  | 'open'
  | 'fstat'
  | 'post_lstat'
  | 'realpath'
  | 'stat'
  | 'read';

/** A path the mount's `include` doesn't cover: outside the mount. */
class OutsideIncludeError extends Refusal {
  constructor(shownPath: string, mount: MountConfig) {
    super(`"${shownPath}" is outside the mount's include: mount "${mount.name}" holds only ${(mount.include ?? []).join(', ')}. `
      + 'The host\'s operator sets the include in the mount\'s configuration, so calling again with this path changes nothing.');
  }
}

/**
 * A file operation's path lies in another mount's directory nested in the
 * mount it names. The message names the mount that holds it and the path to
 * use there.
 */
class NestedMountError extends Refusal {
  constructor(path: string, mount: string, holder: { name: string; use: string; guess?: NestedGuess }, how: 'lies in' | 'leads into' = 'lies in') {
    const verb = holder.guess === undefined ? how : how === 'lies in' ? 'may lie in' : 'may lead into';
    super(`"${path}" ${verb} mount "${holder.name}", nested in mount "${mount}", which neither reads nor writes it: ${nestedStep(holder, { named: how === 'lies in' })}.`);
  }
}

class PathRefusal extends Refusal {
  constructor(readonly code: 'unknown_mount' | 'traversal', message: string) {
    super(message);
  }
}

/**
 * Thrown by `WorkspaceModule.readFileFromDisk()`. Messages carry the
 * mount-prefixed path only — never absolute filesystem paths — so they can be
 * surfaced to the agent or logged without leaking host layout.
 */
export class WorkspaceReadError extends Error {
  constructor(
    readonly code: WorkspaceReadErrorCode,
    message: string,
    readonly stage: WorkspaceReadStage,
    /** Underlying errno code (e.g. 'ENOENT', 'ELOOP') when a syscall failed. */
    readonly errno?: string,
  ) {
    super(message);
    this.name = 'WorkspaceReadError';
  }
}

class NotRegularFile extends WorkspaceReadError {
  constructor(path: string, stage: WorkspaceReadStage) {
    super('not_found', `Not a regular file: ${path}`, stage);
  }
}

class LinkOnTheWay extends WorkspaceReadError {
  constructor(code: WorkspaceReadErrorCode, message: string, readonly reason: string, errno?: string) {
    super(code, message, 'readlink', errno);
  }
}

class RootUnavailable extends WorkspaceReadError {
  constructor(readonly mount: string, readonly reason: string | null, stage: WorkspaceReadStage, errno?: string, readonly refusal?: Refusal) {
    super('mount_unavailable', reason === null ? `Mount unavailable: ${mount}` : `Mount unavailable: ${mount}: ${reason}`, stage, errno);
  }
}

/** Successful `readFileFromDisk()` result. */
export interface WorkspaceDiskReadResult {
  /**
   * File bytes: the whole file, or its first `maxBytes` when `truncated`.
   * Without `maxBytes` the file is read with `readFile`, with no limit. In
   * Node, that reads up to the size its own fstat finds, or to the file's end
   * if that size is 0.
   */
  bytes: Buffer;
  /**
   * The file's size, agreeing with `bytes` and `truncated`: `bytes.length`,
   * unless `truncated`. Then it's the file's size by an fstat after the read,
   * or `maxBytes + 1` if that's less, since the read found at least that many
   * bytes.
   */
  size: number;
  /** True when `maxBytes` was set and the read found the file going on past it; `bytes` is a prefix. */
  truncated: boolean;
  /** mtime of the file actually read, from its fstat at the open (for change-detection caches). */
  mtimeMs: number;
  /** Canonical (realpath) location of the file read — inside the canonical mount root by construction. */
  realPath: string;
  /** Mount the path resolved into. */
  mount: string;
}

export interface ReadFileFromDiskOptions {
  /**
   * Keep at most this many bytes (a bounded prefix read): the read loads them
   * and one byte past them, which isn't kept and tells whether the file goes
   * on, and never the rest of the file. It bounds the read itself, so it
   * holds for a file that grows while it's read.
   */
  maxBytes?: number;
}

/**
 * Why a pass decided nothing, or null where it decided its paths. A pass gives
 * up deciding, and reports no path, when the selected branch kept changing
 * while it gathered, or when a sync's branch was no longer selected; it then
 * carries no branchId, and says why in `undecided`.
 */
function undecidedOf(pass: PassResult): string | null {
  return pass.branchId === undefined ? (pass.undecided ?? 'the pass decided nothing') : null;
}

function errnoOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}


/** read_image's refusal of a file over the mount's size limit, wherever it's found to be. */
function imageTooLarge(maxSize: number, mountPrefixedPath: string, size: string): WorkspaceImageReadError {
  return new WorkspaceImageReadError(pastSizeLimit(`${JSON.stringify(mountPrefixedPath)} is ${size} bytes`, maxSize, "read_image doesn't show it", null), null);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const GIF_TRAILER = 0x3b;
const GIF_EXTENSION = 0x21;
const GIF_IMAGE_DESCRIPTOR = 0x2c;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_TEM = 0x01;

function startsWithBytes(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function matchesPartialPrefix(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length > 0 && prefix.subarray(0, buffer.length).equals(buffer);
}

/**
 * A disk reader's refusal for what linkOnTheWay found on a path's way: the
 * link's reason, as the observations give it, after the path; or, for a
 * directory the walk couldn't ask, a failure to read, coded `not_found` with
 * the readlink's errno, as every failed lookup is. A link's code follows
 * where its refusal says it leads (shownLeads), so a caller choosing advice
 * by code gets advice that fits, and the code says no more than the message:
 * `escape` for a link leading outside the mount, the code a path resolving
 * outside it gets too; `other_mount` for one into a nested mount's directory
 * where the message names that mount (namesHolder), the code that mount's own
 * paths get; and for any other, a link the mount's include doesn't cover
 * among them, the code of a link the mount doesn't follow where it stands:
 * `symlink` at the path itself, as any other link there gets, and
 * `parent_symlink` among its directories, judged on the parsed path
 * (`relativePath`), whatever spelling the caller gave. Where the link leads is
 * read beneath `rootReal`, the root the check that found it resolved, so the
 * link and its target are judged beneath one root, by that root's nesting
 * (`nested`).
 */
async function linkReadError(
  mount: { config: { name: string; path: string; include?: readonly string[] } },
  found: LinkFound,
  mountPrefixedPath: string,
  relativePath: string,
  nested: readonly NestedMount[],
  rootReal: string,
): Promise<WorkspaceReadError> {
  if (!('link' in found)) {
    const reason = linkWords(mount.config.name, found, null);
    return new LinkOnTheWay('not_found', `Unable to read file: ${mountPrefixedPath}: ${reason}`, reason, found.code);
  }
  const leads = await shownLeads(rootReal, rootReal, found, mount.config.include);
  const reason = linkWords(mount.config.name, found, leads, nested, mount.config.include);
  const holder = leads?.kind === 'inside' ? nestedHolder(leads.target, nested) : undefined;
  const code = leads?.kind === 'outside' ? 'escape'
    : leads?.kind === 'inside' && holder && namesHolder(leads, nested) ? 'other_mount'
    : relativePath === found.link ? 'symlink' : 'parent_symlink';
  return new LinkOnTheWay(code, `${mountPrefixedPath}: ${reason}`, reason);
}

/**
 * `to` beneath `from`, mount-relative and `/`-separated, whatever the
 * platform's separator; undefined where it isn't beneath it. Outside,
 * `relative` gives a path that climbs with a `..` segment, or an absolute one
 * across Windows drives. A name that only begins with two dots, such as
 * `..cache`, is inside.
 */
function nestedDir(from: string, to: string): string | undefined {
  const rel = relative(from, to);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** Each directory above `path`, innermost first, to the filesystem's root. */
function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
}

/**
 * Where a mount is nested in an outer mount, as a start places it: at its
 * directory as configured beneath the outer mount's configured path
 * (`outerPath`), beneath each directory above its configured path that is
 * the outer root on disk (`above`, each with where it lies on disk), and
 * where its real root (`real`) lies beneath the outer root (`outerReal`).
 * Its real root is claimed where it doesn't hold the outer root, which it
 * would otherwise claim whole. Undefined where it's nested nowhere.
 */
function placementOf(
  outerPath: string,
  outerReal: string,
  innerPath: string,
  real: string,
  above: ReadonlyArray<{ dir: string; real: string }>,
): { configured: string | undefined; fromRoots: NestedMountEntry['fromRoots']; claims: boolean } | undefined {
  const configured = nestedDir(outerPath, innerPath);
  const dirs = new Map<string, boolean>();
  const place = (dir: string | undefined, sure: boolean) => { if (dir !== undefined) dirs.set(dir, (dirs.get(dir) ?? false) || sure); };
  place(configured, true);
  for (const a of above) {
    if (sameRoot(a.real, outerReal)) place(nestedDir(a.dir, innerPath), surelyAtRoot(a.real, outerReal));
  }
  const below = beneathRoot(real, outerReal);
  place(below, below !== undefined && surelyAtRoot(real, outerReal));
  if (dirs.size === 0) return undefined;
  const fromRoots: NestedMountEntry['fromRoots'] = [...dirs].map(([dir, sure]) => ({ dir, ...(sure ? {} : { guessed: true as const }) }));
  const claims = !sameRoot(outerReal, real) && beneathRoot(outerReal, real) === undefined;
  return { configured, fromRoots, claims };
}

/** A mount nested in another, as the outer mount's otherMounts holds it. */
interface NestedMountEntry {
  name: string;
  /**
   * Its real root, as realBeneath places it once a start has read it, and
   * its root as resolved until then. None where it's the outer mount's own
   * or holds it (NestedMount).
   */
  real?: string;
  /** Its directory as configured and as the real roots place it. */
  fromRoots: Array<{ dir: string; guessed?: true }>;
}

/**
 * A path as parsePath reads it: its mount, and its mount-relative and
 * mount-prefixed paths as the parse spells them; with the root the parse
 * judged it beneath, a direct mount's as the parse resolved it and any
 * other's as configured, and, where a direct mount's root lies elsewhere
 * than the last start placed it, the mounts nested in it there
 * (movedNesting), null otherwise.
 */
interface ParsedPath {
  mount: MountState;
  relativePath: string;
  path: string;
  root: string;
  moved: NestedMount[] | null;
}

/** How many links realBeneath follows to a place not made yet before it stops, as the kernel's limit does. */
const LINKS_FOLLOWED = 40;

/**
 * An absolute path, a mount root's or one beneath it, as realpath resolves
 * it, with the links on its way and in it taken out, read without holding
 * the process. Where nothing is there yet, a link leads where its target
 * would be, and anything else lies beneath its nearest existing directory's
 * real path, with the rest as given, a `..` after a name that isn't there
 * taken lexically. A link's target is read from the link's directory as it
 * is on disk, so a `..` is taken from where the links before it lead, as the
 * kernel takes it. Where realpath fails for any other reason, such as a
 * loop or a lack of permission, the whole path as path.resolve reads it, and
 * `unresolved`, where given, takes the first such code.
 */
async function realBeneath(given: string, links = 0, unresolved?: { code?: string }): Promise<string> {
  // A trailing separator, as a link to a directory is often written, names
  // the same place, but readlink would then follow the link it names.
  const { root } = parse(given);
  let absolute = given;
  while (absolute.length > root.length && (absolute.endsWith('/') || absolute.endsWith(sep))) absolute = absolute.slice(0, -1);
  try {
    return await realpath(absolute);
  } catch (err) {
    const code = errnoOf(err);
    const parent = dirname(absolute);
    if ((code !== 'ENOENT' && code !== 'ENOTDIR') || links > LINKS_FOLLOWED || parent === absolute) {
      if (unresolved) unresolved.code ??= links > LINKS_FOLLOWED ? 'ELOOP' : code ?? 'EIO';
      return resolve(absolute);
    }
    const place = await realBeneath(parent, links, unresolved);
    const target = await readlink(absolute).catch(() => null);
    if (target !== null) return realBeneath(isAbsolute(target) ? target : `${place}${sep}${target}`, links + 1, unresolved);
    return join(place, basename(absolute));
  }
}

/**
 * A configured value as a refusal shows it: a number or a bigint as
 * JavaScript writes it (JSON would say null for NaN, and throws for a
 * bigint), anything else as JSON, or as String gives it where JSON can't,
 * as for a list holding a bigint.
 */
function shownValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(normalizedRoot);
}

function invalidImage(format: string, mountPrefixedPath: string): never {
  throw new WorkspaceImageReadError(`${JSON.stringify(mountPrefixedPath)} starts as a ${format} image, but its data doesn't hold together as one`, IMAGE_STAYS);
}

function requireBufferRange(bytes: Buffer, start: number, length: number, format: string, mountPrefixedPath: string): void {
  if (start < 0 || length < 0 || start + length > bytes.length) {
    invalidImage(format, mountPrefixedPath);
  }
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16);
}

function parseGifSubBlocks(bytes: Buffer, offset: number, mountPrefixedPath: string): number {
  while (true) {
    requireBufferRange(bytes, offset, 1, 'GIF', mountPrefixedPath);
    const blockLength = bytes[offset]!;
    offset += 1;
    if (blockLength === 0) return offset;
    requireBufferRange(bytes, offset, blockLength, 'GIF', mountPrefixedPath);
    offset += blockLength;
  }
}

function validatePng(bytes: Buffer, mountPrefixedPath: string): void {
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  let sawNonEmptyIdat = false;

  while (!sawIend) {
    requireBufferRange(bytes, offset, 12, 'PNG', mountPrefixedPath);
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkLength;
    const nextOffset = chunkEnd + 4;
    requireBufferRange(bytes, chunkDataOffset, chunkLength + 4, 'PNG', mountPrefixedPath);

    if (offset === PNG_SIGNATURE.length) {
      if (chunkType !== 'IHDR' || chunkLength !== 13) {
        invalidImage('PNG', mountPrefixedPath);
      }
      const width = bytes.readUInt32BE(chunkDataOffset);
      const height = bytes.readUInt32BE(chunkDataOffset + 4);
      if (width === 0 || height === 0) {
        invalidImage('PNG', mountPrefixedPath);
      }
    }

    if (chunkType === 'IDAT' && chunkLength > 0) {
      sawNonEmptyIdat = true;
    }

    if (chunkType === 'IEND') {
      if (chunkLength !== 0 || nextOffset !== bytes.length || !sawNonEmptyIdat) {
        invalidImage('PNG', mountPrefixedPath);
      }
      sawIend = true;
    }

    offset = nextOffset;
  }
}

function validateGif(bytes: Buffer, mountPrefixedPath: string): void {
  requireBufferRange(bytes, 0, 13, 'GIF', mountPrefixedPath);
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) {
    invalidImage('GIF', mountPrefixedPath);
  }

  let offset = 13;
  const packed = bytes[10]!;
  if ((packed & 0x80) !== 0) {
    const globalColorTableBytes = 3 * (1 << ((packed & 0x07) + 1));
    requireBufferRange(bytes, offset, globalColorTableBytes, 'GIF', mountPrefixedPath);
    offset += globalColorTableBytes;
  }

  let sawImage = false;
  while (offset < bytes.length) {
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === GIF_TRAILER) {
      if (!sawImage || offset !== bytes.length) {
        invalidImage('GIF', mountPrefixedPath);
      }
      return;
    }

    if (marker === GIF_EXTENSION) {
      requireBufferRange(bytes, offset, 1, 'GIF', mountPrefixedPath);
      offset += 1; // extension label
      offset = parseGifSubBlocks(bytes, offset, mountPrefixedPath);
      continue;
    }

    if (marker !== GIF_IMAGE_DESCRIPTOR) {
      invalidImage('GIF', mountPrefixedPath);
    }

    sawImage = true;
    requireBufferRange(bytes, offset, 9, 'GIF', mountPrefixedPath);
    const imageWidth = bytes.readUInt16LE(offset + 4);
    const imageHeight = bytes.readUInt16LE(offset + 6);
    if (imageWidth === 0 || imageHeight === 0) {
      invalidImage('GIF', mountPrefixedPath);
    }
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if ((imagePacked & 0x80) !== 0) {
      const localColorTableBytes = 3 * (1 << ((imagePacked & 0x07) + 1));
      requireBufferRange(bytes, offset, localColorTableBytes, 'GIF', mountPrefixedPath);
      offset += localColorTableBytes;
    }

    requireBufferRange(bytes, offset, 1, 'GIF', mountPrefixedPath);
    const lzwMinimumCodeSize = bytes[offset]!;
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) {
      invalidImage('GIF', mountPrefixedPath);
    }
    offset += 1;
    offset = parseGifSubBlocks(bytes, offset, mountPrefixedPath);
  }

  invalidImage('GIF', mountPrefixedPath);
}

function scanJpegEntropyData(bytes: Buffer, offset: number, mountPrefixedPath: string): number {
  // Scan data can contain 0xFF byte-stuffing and restart markers.
  while (offset < bytes.length) {
    const value = bytes[offset]!;
    offset += 1;
    if (value !== 0xff) continue;

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) invalidImage('JPEG', mountPrefixedPath);

    const marker = bytes[offset]!;
    if (marker === 0x00) {
      offset += 1;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 1;
      continue;
    }
    return offset - 1;
  }

  invalidImage('JPEG', mountPrefixedPath);
}

function validateJpeg(bytes: Buffer, mountPrefixedPath: string): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) {
    invalidImage('JPEG', mountPrefixedPath);
  }

  let offset = 2;
  let sawSof = false;
  let sawSos = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      invalidImage('JPEG', mountPrefixedPath);
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) invalidImage('JPEG', mountPrefixedPath);

    const marker = bytes[offset]!;
    offset += 1;

    if (marker === JPEG_EOI) {
      if (!sawSof || !sawSos) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      // Bytes after EOI are tolerated: hardware encoders (e.g. Raspberry Pi
      // camera stills) pad each frame to a 4-byte boundary with NULs after
      // the EOI marker, and every mainstream decoder stops at EOI. The image
      // proper (SOI..EOI) has been fully validated by this point.
      return;
    }
    if (marker === JPEG_TEM || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    requireBufferRange(bytes, offset, 2, 'JPEG', mountPrefixedPath);
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) {
      invalidImage('JPEG', mountPrefixedPath);
    }
    offset += 2;
    const payloadOffset = offset;
    const payloadLength = segmentLength - 2;
    requireBufferRange(bytes, payloadOffset, payloadLength, 'JPEG', mountPrefixedPath);

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (payloadLength < 6) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      const height = bytes.readUInt16BE(payloadOffset + 1);
      const width = bytes.readUInt16BE(payloadOffset + 3);
      const componentCount = bytes[payloadOffset + 5]!;
      if (componentCount === 0 || payloadLength < 6 + (componentCount * 3)) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      if (width === 0 || height === 0) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      sawSof = true;
    }

    if (marker === JPEG_SOS) {
      if (!sawSof) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      if (payloadLength < 6) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      const componentCount = bytes[payloadOffset]!;
      if (componentCount === 0 || payloadLength < 1 + (componentCount * 2) + 3) {
        invalidImage('JPEG', mountPrefixedPath);
      }
      sawSos = true;
      offset = scanJpegEntropyData(bytes, payloadOffset + payloadLength, mountPrefixedPath);
      continue;
    }

    offset = payloadOffset + payloadLength;
  }

  invalidImage('JPEG', mountPrefixedPath);
}

function validateWebpVp8Chunk(bytes: Buffer, chunkDataOffset: number, chunkLength: number, mountPrefixedPath: string): void {
  if (chunkLength <= 10) invalidImage('WebP', mountPrefixedPath);
  if (bytes[chunkDataOffset + 3] !== 0x9d || bytes[chunkDataOffset + 4] !== 0x01 || bytes[chunkDataOffset + 5] !== 0x2a) {
    invalidImage('WebP', mountPrefixedPath);
  }
  const width = bytes.readUInt16LE(chunkDataOffset + 6) & 0x3fff;
  const height = bytes.readUInt16LE(chunkDataOffset + 8) & 0x3fff;
  if (width === 0 || height === 0) {
    invalidImage('WebP', mountPrefixedPath);
  }
}

function validateWebpVp8lChunk(bytes: Buffer, chunkDataOffset: number, chunkLength: number, mountPrefixedPath: string): void {
  if (chunkLength <= 5 || bytes[chunkDataOffset] !== 0x2f) {
    invalidImage('WebP', mountPrefixedPath);
  }
  const packed = bytes.readUInt32LE(chunkDataOffset + 1);
  const width = (packed & 0x3fff) + 1;
  const height = ((packed >> 14) & 0x3fff) + 1;
  if (width === 0 || height === 0) {
    invalidImage('WebP', mountPrefixedPath);
  }
}

function validateWebpVp8xChunk(bytes: Buffer, chunkDataOffset: number, chunkLength: number, mountPrefixedPath: string): void {
  if (chunkLength !== 10) invalidImage('WebP', mountPrefixedPath);
  const width = 1 + readUInt24LE(bytes, chunkDataOffset + 4);
  const height = 1 + readUInt24LE(bytes, chunkDataOffset + 7);
  if (width === 0 || height === 0) {
    invalidImage('WebP', mountPrefixedPath);
  }
}

function validateWebpAnmfChunk(bytes: Buffer, chunkDataOffset: number, chunkLength: number, mountPrefixedPath: string): void {
  if (chunkLength <= 16) invalidImage('WebP', mountPrefixedPath);

  const frameWidth = 1 + readUInt24LE(bytes, chunkDataOffset + 6);
  const frameHeight = 1 + readUInt24LE(bytes, chunkDataOffset + 9);
  if (frameWidth === 0 || frameHeight === 0) {
    invalidImage('WebP', mountPrefixedPath);
  }

  const chunkDataEnd = chunkDataOffset + chunkLength;
  let nestedOffset = chunkDataOffset + 16;
  let sawFramePayload = false;

  while (nestedOffset < chunkDataEnd) {
    requireBufferRange(bytes, nestedOffset, 8, 'WebP', mountPrefixedPath);
    const nestedChunkType = bytes.toString('ascii', nestedOffset, nestedOffset + 4);
    const nestedChunkLength = bytes.readUInt32LE(nestedOffset + 4);
    const nestedChunkDataOffset = nestedOffset + 8;
    const nestedChunkEnd = nestedChunkDataOffset + nestedChunkLength;
    const nestedPaddedChunkEnd = nestedChunkEnd + (nestedChunkLength % 2);
    requireBufferRange(bytes, nestedChunkDataOffset, nestedChunkLength, 'WebP', mountPrefixedPath);
    if (nestedPaddedChunkEnd > chunkDataEnd) {
      invalidImage('WebP', mountPrefixedPath);
    }

    if (nestedChunkType === 'VP8 ') {
      validateWebpVp8Chunk(bytes, nestedChunkDataOffset, nestedChunkLength, mountPrefixedPath);
      sawFramePayload = true;
    } else if (nestedChunkType === 'VP8L') {
      validateWebpVp8lChunk(bytes, nestedChunkDataOffset, nestedChunkLength, mountPrefixedPath);
      sawFramePayload = true;
    }

    nestedOffset = nestedPaddedChunkEnd;
  }

  if (!sawFramePayload || nestedOffset !== chunkDataEnd) {
    invalidImage('WebP', mountPrefixedPath);
  }
}

function validateWebp(bytes: Buffer, mountPrefixedPath: string): void {
  requireBufferRange(bytes, 0, 12, 'WebP', mountPrefixedPath);

  const declaredLength = bytes.readUInt32LE(4);
  if (declaredLength + 8 !== bytes.length) {
    invalidImage('WebP', mountPrefixedPath);
  }
  if (!bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) {
    invalidImage('WebP', mountPrefixedPath);
  }

  let offset = 12;
  let sawVp8x = false;
  let sawImagePayload = false;

  while (offset < bytes.length) {
    requireBufferRange(bytes, offset, 8, 'WebP', mountPrefixedPath);
    const chunkType = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    const chunkDataEnd = chunkDataOffset + chunkLength;
    const paddedChunkEnd = chunkDataEnd + (chunkLength % 2);
    requireBufferRange(bytes, chunkDataOffset, chunkLength, 'WebP', mountPrefixedPath);
    if (paddedChunkEnd > bytes.length) {
      invalidImage('WebP', mountPrefixedPath);
    }

    if (chunkType === 'VP8 ') {
      validateWebpVp8Chunk(bytes, chunkDataOffset, chunkLength, mountPrefixedPath);
      sawImagePayload = true;
    } else if (chunkType === 'VP8L') {
      validateWebpVp8lChunk(bytes, chunkDataOffset, chunkLength, mountPrefixedPath);
      sawImagePayload = true;
    } else if (chunkType === 'VP8X') {
      if (sawVp8x || offset !== 12) {
        invalidImage('WebP', mountPrefixedPath);
      }
      validateWebpVp8xChunk(bytes, chunkDataOffset, chunkLength, mountPrefixedPath);
      sawVp8x = true;
    } else if (chunkType === 'ANMF') {
      if (!sawVp8x) {
        invalidImage('WebP', mountPrefixedPath);
      }
      validateWebpAnmfChunk(bytes, chunkDataOffset, chunkLength, mountPrefixedPath);
      sawImagePayload = true;
    }

    offset = paddedChunkEnd;
  }

  if (!sawImagePayload) {
    invalidImage('WebP', mountPrefixedPath);
  }
}

function detectImageMimeType(bytes: Buffer, mountPrefixedPath: string): SupportedImageMimeType {
  if (startsWithBytes(bytes, PNG_SIGNATURE)) {
    validatePng(bytes, mountPrefixedPath);
    return 'image/png';
  }
  if (matchesPartialPrefix(bytes, PNG_SIGNATURE)) {
    throw truncatedImage(mountPrefixedPath);
  }

  if (startsWithBytes(bytes, JPEG_SIGNATURE)) {
    validateJpeg(bytes, mountPrefixedPath);
    return 'image/jpeg';
  }
  if (matchesPartialPrefix(bytes, JPEG_SIGNATURE)) {
    throw truncatedImage(mountPrefixedPath);
  }

  if (startsWithBytes(bytes, GIF87A_SIGNATURE) || startsWithBytes(bytes, GIF89A_SIGNATURE)) {
    validateGif(bytes, mountPrefixedPath);
    return 'image/gif';
  }
  if (matchesPartialPrefix(bytes, GIF87A_SIGNATURE) || matchesPartialPrefix(bytes, GIF89A_SIGNATURE)) {
    throw truncatedImage(mountPrefixedPath);
  }

  if (bytes.length >= 12 && startsWithBytes(bytes, RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) {
    validateWebp(bytes, mountPrefixedPath);
    return 'image/webp';
  }
  if (
    (bytes.length < RIFF_SIGNATURE.length && matchesPartialPrefix(bytes, RIFF_SIGNATURE))
    || (bytes.length >= RIFF_SIGNATURE.length && startsWithBytes(bytes, RIFF_SIGNATURE) && bytes.length < 12)
  ) {
    throw truncatedImage(mountPrefixedPath);
  }

  throw new WorkspaceImageReadError(`${JSON.stringify(mountPrefixedPath)} isn't a PNG, JPEG, GIF or WebP image, the formats read_image shows`, "read shows it, if it's text.");
}

export class WorkspaceModule implements Module {
  readonly name = 'workspace';

  private ctx: ModuleContext | null = null;
  private store: JsStore | null = null;
  /** Set once stop has drained and saved, cleared by start (running()). */
  private stopped = false;
  /** Stops begun, so a start that read disk meanwhile can tell that one came. */
  private stopsBegun = 0;
  private config: WorkspaceConfig;
  private mounts = new Map<string, MountState>();
  private watchers = new Map<string, MountWatcher>();
  /** What disk last agreed with (global records); created with the store. */
  private agreement: DiskAgreement | null = null;
  /** Branch-local intent per mount. */
  private intents = new Map<string, BranchIntents>();
  /** Each mount's turn: the tail of its serialized passes and writes. */
  private mountTurns = new Map<string, Promise<void>>();
  /** Whether an over-bound agentActionScanDeadlineMs has been warned about. */
  private warnedScanDeadline = false;
  /** Whether a mount root's filesystem maintains ctime, by canonical root. */
  /** Per canonical root: the device of its filesystem when that maintains ctime, else null. */
  private ctimeTrust = new Map<string, string | null>();
  /**
   * Each mount's directories that are other mounts nested inside it, with
   * each mount's name and real root: as configured, and as the real roots
   * place it, where that differs (`fromRoots`). Each is mount-relative and
   * `/`-separated. The constructor nests by configured path, with each root
   * as resolved standing for its real one, and each start reads it all again
   * with the roots placed where disk has them (readNesting).
   */
  private otherMounts = new Map<string, NestedMountEntry[]>();
  /** Whether each mount's root folds case (foldsCase), where disk has it, as the last start read it. */
  private rootFoldsCase = new Map<string, boolean>();
  /** Where the last start placed each mount's root (readNesting's `reals`). */
  private placedRoots = new Map<string, string>();
  /** Each directory above each mount's configured path, with where the last start found it on disk (readNesting's `above`). */
  private placedAbove = new Map<string, Array<{ dir: string; real: string }>>();
  /**
   * Whether a file's mode is observed, taken in and applied (MountRuntime's
   * `modesObserved`): not on Windows, which reports no POSIX modes. A test
   * sets it false to run that case anywhere.
   */
  private modesObserved = process.platform !== 'win32';
  /** Persisted state decoded in start(), held until mounts exist to apply it
   *  to — in the Host ordering start() runs before initStore() creates the
   *  mounts, so restoration must be second-callback-safe like watcher
   *  startup already is (issue #72). Cleared after application. */
  private savedState: WorkspaceModuleState | null = null;
  /**
   * The mounts configured direct that run as 'chronicle' this session, with
   * the changes the store held there that disk lacked (chooseKinds), for
   * ensureRunning to say once both halves of the lifecycle have run.
   */
  private notDirect = new Map<string, Array<{ path: string; what: string }>>();

  /**
   * Each agent's latest direct write on each mount it wrote direct, P, with
   * the notice of its departure from it, N (DirectHead), by mount, then by
   * agent. Saved at stop() in a global record (headsJournal), not the
   * module's branch state: they describe disk, which doesn't rewind with a
   * branch, so a restart on another branch, such as one an offline rollback
   * made, still finds them.
   */
  private directHeads = new Map<string, Map<string, DirectHead>>();

  /** Where directHeads is saved and loaded (DIRECT_HEADS_RECORD_TYPE), once initStore() has read it. */
  private headsJournal: RecordJournal<never, DirectHeadsSnapshot> | null = null;

  /** The record initStore() read, as saved text, so a stop that would save the same adds none; null where there's one to replace. */
  private loadedHeads: string | null = null;

  /** Saved entries this session doesn't take up (another root, a mount not configured direct, or none), kept for the next save. */
  private carriedHeads: DirectHeadsEntry[] = [];

  /** Whether an agent's history holds a message, as the framework hands it over (useHistory). */
  private historyLookup: ((agentName: string, messageId: string) => boolean) | null = null;

  constructor(config: WorkspaceConfig) {
    for (const mount of config.mounts) {
      const cap: unknown = mount.walkCap;
      if (cap !== undefined && !(Number.isSafeInteger(cap) && (cap as number) > 0)) {
        throw new Error(
          `[workspace] Mount "${mount.name}": walkCap must be a positive integer no larger than ${Number.MAX_SAFE_INTEGER}, not ${shownValue(cap)}`,
        );
      }
      const backend: unknown = mount.backend;
      if (backend !== undefined && backend !== 'chronicle' && backend !== 'direct') {
        throw new Error(`[workspace] Mount "${mount.name}": backend must be 'chronicle' or 'direct', not ${shownValue(backend)}`);
      }
      const refused = backend === 'direct' ? directRefusals(mount) : [];
      if (refused.length > 0) {
        throw new Error(`[workspace] Mount "${mount.name}" is direct, which reads disk as it is with no store, watcher or push: ${refused.join('; ')}`);
      }
      for (const list of ['ignore', 'include'] as const) {
        const patterns: unknown = mount[list];
        if (patterns === undefined) continue;
        if (!Array.isArray(patterns) || (list === 'include' && patterns.length === 0)) {
          throw new Error(`[workspace] Mount "${mount.name}": ${list} must be a ${list === 'include' ? 'non-empty ' : ''}list of patterns, not ${shownValue(patterns)}`);
        }
        for (let i = 0; i < patterns.length; i++) {
          const pattern: unknown = patterns[i];
          const why = patternRefusal(pattern, list);
          if (why !== undefined) {
            throw new Error(`[workspace] Mount "${mount.name}": ${list} pattern ${shownValue(pattern)} isn't read: ${why}. ${PATTERN_FORMS}`);
          }
        }
      }
    }
    // Detect overlapping mount paths: a mount nested inside another is that
    // mount's directory, which the outer mount passes over in every pass,
    // named or not, and in its watcher (OTHER_MOUNT). It's kept apart from
    // the outer mount's ignore list, which a sync that names a path sets
    // aside for what it names (#276), so no sync of the outer mount takes in
    // the inner one's files. Here by configured path, before any path is
    // parsed; each start places the roots where disk has them too
    // (readNesting).
    for (const outer of config.mounts) {
      for (const inner of config.mounts) {
        if (outer === inner) continue;
        const outerPath = resolve(outer.path);
        const innerPath = resolve(inner.path);
        const dir = nestedDir(outerPath, innerPath);
        if (dir === undefined) continue;
        const configured = [{ dir }];
        this.otherMounts.set(outer.name, [...(this.otherMounts.get(outer.name) ?? []), { name: inner.name, real: innerPath, fromRoots: configured }]);
        console.warn(
          `[workspace] Mount "${outer.name}" contains mount "${inner.name}" ` +
          `at ${dir}/ — passing over it as another mount's directory`,
        );
      }
    }
    this.config = config;
  }

  /**
   * Inject the Chronicle store. Must be called after framework creation.
   *
   * Host ordering is: `AgentFramework.create()` calls `module.start(ctx)`
   * before the framework is fully returned, and the host (e.g. conhost) wires
   * the store via `initStore(store)` afterwards. Neither half has everything
   * it needs on its own, so watcher setup runs in whichever callback fires
   * second. `ensureRunning()` gates on `ctx && mounts-populated`.
   */
  initStore(store: JsStore): void {
    // Every mount's states are registered before the module takes the store
    // or any mount, so a registration that fails leaves the module as it was
    // before the call, knowing no mount, and a later initStore starts clean.
    const mounts = new Map<string, MountState>();
    const intents = new Map<string, BranchIntents>();
    // A direct mount's files never go into the store, so its states aren't
    // made. One that ran as 'chronicle' before has them, and they're read
    // below for what the store holds there that disk lacks.
    const made = this.config.mounts.some((m) => m.backend === 'direct') ? new Set(store.listStates().map((s) => s.id)) : null;

    // Register tree states for each mount: the workspace tree, and the
    // branch-local intent that qualifies it.
    for (const mount of this.config.mounts) {
      const treeStateId = `workspace/${mount.name}/tree`;
      const intentTreeStateId = `workspace/${mount.name}/intent`;
      const direct = mount.backend === 'direct';
      // A mount configured direct that ran as 'chronicle' runs direct only
      // once chooseKinds finds nothing held there.
      const ranStoreBacked = direct && made!.has(treeStateId) && made!.has(intentTreeStateId);
      if (!direct) {
        for (const id of [treeStateId, intentTreeStateId]) {
          ensureStateRegistered(store, {
            id,
            strategy: 'tree',
            deltaSnapshotEvery: this.config.deltaSnapshotEvery ?? 50,
            fullSnapshotEvery: this.config.fullSnapshotEvery ?? 10,
          });
        }
      }

      mounts.set(mount.name, {
        config: mount,
        direct: direct && !ranStoreBacked,
        treeStateId,
        intentTreeStateId,
        lastMaterializedSeq: 0,
        suppressedPaths: new Set(),
        initialSyncDone: false,
        lastMaterializedBranchId: null,
        watcherReadyAt: null,
        watcherError: null,
      });
      if (!direct || ranStoreBacked) {
        intents.set(mount.name, new BranchIntents(store, intentTreeStateId));
      }
    }

    this.store = store;
    for (const [name, state] of mounts) this.mounts.set(name, state);
    for (const [name, intent] of intents) this.intents.set(name, intent);

    // What disk last agreed with, per mount and path: global records, so a
    // branch switch never rewinds it. A mount configured direct has its
    // evidence read only where a 'chronicle' run left its states, for what
    // the store holds there that disk lacks (chooseKinds); one that never ran
    // so has none to read, and none is begun for it.
    this.agreement = new DiskAgreement(store, { modesObserved: () => this.modesObserved });
    this.agreement.open(this.config.mounts.filter((m) => intents.has(m.name)).map((m) => ({ name: m.name, root: resolve(m.path) })));

    this.chooseKinds();
    this.loadDirectHeads(store);
    this.applySavedState();
    this.ensureRunning();
  }

  /**
   * The positions stop() last saved (directHeads), before any call can
   * write: each saved entry is a mount's positions at one root, and a mount
   * this session configures direct gets the entry at its own root. Every
   * other entry, a mount configured at another root, not direct, or not at
   * all, is kept for the next save (carriedHeads), since its writes are
   * still on disk beneath that root; a mount removed for good, and each
   * root a mount has moved from, leave that small entry behind. A record
   * the store can't read is logged, and this session starts with none and
   * saves none, so the record stands for a session that can read it. One
   * read but not of the shape saved is logged too, and this session starts
   * with none and its stop replaces it, so a damaged record doesn't keep
   * every later session from saving. Either way, a move away from the
   * writes before it goes untold, as after a crash.
   */
  private loadDirectHeads(store: JsStore): void {
    const journal = new RecordJournal<never, DirectHeadsSnapshot>(store, { type: DIRECT_HEADS_RECORD_TYPE });
    const restored = new Map<string, Map<string, DirectHead>>();
    const carried: DirectHeadsEntry[] = [];
    let loaded: unknown;
    try {
      loaded = journal.load().snapshot;
    } catch (err) {
      console.error('[workspace] could not read the saved direct-write positions:', err);
      return;
    }
    let snapshot: DirectHeadsSnapshot;
    let text: string | null;
    try {
      snapshot = checkedHeads(loaded === null || loaded === undefined ? [] : loaded);
      text = canonicalHeads(snapshot);
    } catch (err) {
      console.error("[workspace] the saved direct-write positions aren't of the shape saved, so this session starts with none and its stop replaces them:", err);
      snapshot = [];
      text = null;
    }
    for (const saved of snapshot) {
      // Only a direct mount's writes are the agent's on disk, and a
      // store-backed one's disk follows its store.
      const mount = this.mounts.get(saved.mount);
      if (!mount || mount.config.backend !== 'direct' || saved.root !== resolve(mount.config.path)) {
        carried.push(saved);
        continue;
      }
      restored.set(saved.mount, new Map(Object.entries(saved.agents).map(([agent, head]) =>
        [agent, { branchId: head.branchId, after: head.after, notice: head.notice ?? null }])));
    }
    this.headsJournal = journal;
    this.loadedHeads = text;
    this.carriedHeads = carried;
    for (const [name, heads] of restored) this.directHeads.set(name, heads);
  }

  /**
   * Whether each mount configured direct runs direct: not while the store
   * holds changes there that disk lacks, on the branch selected then, so
   * they stay in view (MountConfig.backend); it runs as 'chronicle' instead,
   * and ensureRunning says so. Decided when initStore gives the store, and
   * again at each start, which knows how the mounts nest, so a start that
   * finds none held starts the mount direct. A path held more than one way
   * is named for the last way set here.
   */
  private chooseKinds(): void {
    // Every mount is decided before any is set, so a read of the store that
    // throws leaves the decisions as they were.
    const decided = new Map<string, Array<{ path: string; what: string }>>();
    for (const [name, state] of this.mounts) {
      if (state.config.backend !== 'direct') continue;
      // One with no states from a 'chronicle' run holds nothing.
      if (!this.intents.has(name)) {
        decided.set(name, []);
        continue;
      }
      const held = this.heldChanges(state);
      const what = new Map<string, string>();
      for (const path of held.owed) what.set(path, 'changed in the workspace');
      for (const path of held.unreadable) what.set(path, UNREADABLE_INTENT);
      for (const path of held.deletions) what.set(path, 'deleted in the workspace');
      for (const path of held.conflicts) what.set(path, 'in conflict');
      decided.set(name, [...what].sort(([a], [b]) => a.localeCompare(b)).map(([path, label]) => ({ path, what: label })));
    }
    this.notDirect = new Map();
    for (const [name, held] of decided) {
      this.mounts.get(name)!.direct = held.length === 0;
      if (held.length > 0) this.notDirect.set(name, held);
    }
  }

  // ==========================================================================
  // Reconciliation plumbing
  // ==========================================================================

  /**
   * Run `fn` with the mount to itself: observation, decision and effect never
   * interleave with another pass or a tool write on the same mount (a disk
   * observation taken before an autoMaterialize write and applied after it
   * would ingest old bytes over the new entry). Not re-entrant: code holding
   * a mount's turn calls the unlocked helpers.
   */
  private withMount<T>(mount: MountState, fn: () => Promise<T>): Promise<T> {
    const name = mount.config.name;
    const previous = this.mountTurns.get(name) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.mountTurns.set(name, run.then(() => undefined, () => undefined));
    return run;
  }

  private agreementOrThrow(): DiskAgreement {
    if (!this.agreement) throw new Error('Workspace store not initialized');
    return this.agreement;
  }

  /**
   * A mount as observation reads it, with the root identity the workspace
   * recorded for it, if any: what a pass reads beneath (runtime), with
   * rootIdentity's, and what a disk read checks its root against (readRoot),
   * with rootIdentityForRead's. A direct mount's has none (diskView).
   */
  private viewOf(mount: MountState, rootIdentity: MountView['rootIdentity']): MountView {
    return {
      root: resolve(mount.config.path),
      name: mount.config.name,
      rootIdentity,
      followSymlinks: mount.config.followSymlinks === true,
      maxFileSize: mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      ignore: this.ignoreOf(mount),
      ...(mount.config.include ? { include: mount.config.include } : {}),
      others: this.othersOf(mount.config.name),
      nested: this.nestedOf(mount.config.name),
    };
  }

  /**
   * A mount's ignore list: its config's, or, for a mount configured direct
   * that names none, the direct kind's default (MountConfig.ignore), whichever
   * kind it runs as this session, as its watch mode goes by its config
   * (watchOf).
   */
  private ignoreOf(mount: MountState): string[] {
    return mount.config.ignore ?? (mount.config.backend === 'direct' ? [...DIRECT_MOUNT_IGNORE] : []);
  }

  /**
   * A direct mount as its tools read it: its view, with no root identity,
   * since it promises what's at its root now and keeps no evidence to check
   * that against (MountConfig.backend), and its root as realpath resolves it,
   * or as given where that fails, as a pass's runtime takes it. The view
   * reads beneath that root, so a walk, a listing and grep's reads judge
   * and open their files beneath one root, however its configured path is
   * repointed meanwhile. A read of one file goes through openContainedFile
   * instead, which refuses it once its root is no longer the directory it
   * checked.
   */
  private async diskView(mount: MountState): Promise<{ view: MountView; rootReal: string; moved: NestedMount[] | null }> {
    const root = resolve(mount.config.path);
    const rootReal = await realpath(root).catch(() => root);
    const view = { ...this.viewOf(mount, undefined), root: rootReal };
    const moved = await this.movedNesting(mount, rootReal);
    return { view: moved === null ? view : { ...view, nested: moved, others: moved.map((n) => n.dir) }, rootReal, moved };
  }

  /** The view reconciliation needs of a mount, refreshed per pass. */
  private async runtime(mount: MountState): Promise<MountRuntime> {
    const root = resolve(mount.config.path);
    const rootReal = await realpath(root).catch(() => root);
    let trustedDev = this.ctimeTrust.get(rootReal);
    if (trustedDev === undefined) {
      const dev = (await stat(rootReal, { bigint: true }).catch(() => null))?.dev;
      trustedDev = dev !== undefined && (await filesystemTrustsCtime(rootReal)) ? dev.toString() : null;
      this.ctimeTrust.set(rootReal, trustedDev);
    }
    return {
      name: mount.config.name,
      view: this.viewOf(mount, this.agreementOrThrow().rootIdentity(mount.config.name)),
      rootReal,
      ctimeTrustedDev: trustedDev,
      treeStateId: mount.treeStateId,
      intents: this.intents.get(mount.config.name)!,
      readOnly: mount.config.mode === 'read-only',
      walkCap: mount.config.walkCap ?? WALK_CAP,
      catchUpScan: watchOf(mount.config) === 'always',
      modesObserved: this.modesObserved,
    };
  }

  /**
   * Where a search's walk starts: `base`, its path as parsePath spells it,
   * then each segment of `beneath` while disk lists it, in the directory
   * reached so far, as a directory with exactly that spelling. The walk names
   * what it finds from its start's spelling, and a case-insensitive disk
   * would let it go on under a spelling disk doesn't list, taking files in
   * under that spelling beside their own. So the start stops before a segment
   * spelled any other way, not there, or not a directory, and before a link,
   * which a walk of the whole mount doesn't go through either. It lists only
   * directories it has checked lie inside the mount, and, on a 'chronicle'
   * mount, none it passes over by design, which the walk then answers for.
   * A direct mount walks a path its tools name whatever its ignore list or
   * an editor's file name covers there (MountConfig.ignore), so there it
   * lists such directories too, and only another mount's it doesn't.
   */
  private async walkStart(mount: MountState, base: string, beneath: string): Promise<string> {
    if (beneath === '') return base;
    const { view, rootReal } = mount.direct ? await this.diskView(mount) : await this.runtime(mount);
    let start = base;
    for (const segment of beneath.split('/')) {
      if (start !== '' && (mount.direct ? inOtherMount(start, view.others) : passedOverAt(start, view.ignore, view.others, true) !== undefined)) break;
      const here = await checkDir(view, rootReal, start);
      if (here.kind !== 'checked') break;
      const entry = (await readdir(here.dir.real, { withFileTypes: true }).catch(() => [])).find((e) => e.name === segment);
      if (entry === undefined || !entry.isDirectory()) break;
      start = start ? `${start}/${segment}` : segment;
    }
    return start;
  }

  /** One disk→store pass; the caller holds the mount's turn. Emits its events. */
  private async passUnlocked(mount: MountState, scope: Scope, opts: PassOptions = {}): Promise<PassResult> {
    const result = await reconcilePass(this.getStore(), this.agreementOrThrow(), await this.runtime(mount), scope, opts);
    if (result.rootListed !== undefined) mount.lastPassRoot = { at: new Date().toISOString(), listed: result.rootListed };
    if (scope.kind === 'dir' && scope.dir === '' && scope.recursive) mount.initialSyncDone = true;
    // What a pass says is another mount's directory names that mount and
    // the path to use there, as the file operations' refusal does: a copy's
    // note, and the region of a scope that lies there. The pass's counts
    // keep the bare reason.
    const name = mount.config.name;
    for (const report of result.reports.values()) {
      if (report.note === OTHER_MOUNT) report.note = this.otherMountNote(name, report.path, 'list');
    }
    for (const region of result.incomplete) {
      if (region.reason === OTHER_MOUNT) region.reason = this.otherMountNote(name, region.path, 'list');
    }
    this.emitFsEvents(mount.config.name, result.ops, result.newConflicts);
    return result;
  }

  /** One store→disk push; the caller holds the mount's turn. */
  private async pushUnlocked(mount: MountState, paths: string[], opts: PushOptions = {}): Promise<PushResult> {
    const watcher = this.watchers.get(mount.config.name);
    // A path outside the mount's include never reaches disk, even when the
    // workspace's history holds it from before the include. It's skipped,
    // and a materialize counts it, with the reason.
    const inside: string[] = [];
    const outside: string[] = [];
    for (const p of paths) {
      // A key no spelling names, such as an earlier version's `a//b.txt`,
      // isn't the mount's either, and isn't the include's to report.
      if (!parsedSpelling(p)) continue;
      (insideMount(p, mount.config.include) ? inside : outside).push(p);
    }
    const pushed = await pushPaths(this.getStore(), this.agreementOrThrow(), await this.runtime(mount), inside, {
      ...opts,
      beforeEffect: (p) => watcher?.suppress(p),
    });
    for (const path of outside) pushed.skipped.push({ path, reason: OUTSIDE_INCLUDE });
    return pushed;
  }

  async start(ctx: ModuleContext): Promise<void> {
    // Which mounts are nested where, with the roots placed where disk has
    // them, and whether each mount's root folds case, read where disk has
    // it, before this start sets anything, so a restart takes no call
    // and walks or watches nothing before they're known. A stop begun
    // meanwhile stands, and this start then sets nothing.
    const stops = this.stopsBegun;
    const { nesting, reals, above } = await this.readNesting();
    const rootFoldsCase = new Map<string, boolean>();
    for (const mount of this.config.mounts) rootFoldsCase.set(mount.name, await foldsCase(reals.get(mount.name)!));
    if (this.stopsBegun !== stops) return;
    this.otherMounts = nesting;
    this.rootFoldsCase = rootFoldsCase;
    this.placedRoots = reals;
    this.placedAbove = above;

    this.ctx = ctx;
    this.stopped = false;

    // Decode persisted state if restarting; application waits until mounts
    // exist (see applySavedState) — in the Host ordering they don't yet.
    if (ctx.isRestart) {
      this.savedState = ctx.getState<WorkspaceModuleState>() ?? null;
    }

    this.applySavedState();
    this.ensureRunning();
  }

  /**
   * Apply persisted per-mount state once both halves of the lifecycle have
   * happened. Like watcher startup, either callback may fire second, so both
   * start() and initStore() call this; it runs to effect exactly once — the
   * saved payload is cleared after application so stale persisted values can
   * never overwrite newer runtime state (e.g. a materialization that already
   * happened this session).
   */
  private applySavedState(): void {
    if (!this.savedState || this.mounts.size === 0) return;

    for (const [name, meta] of Object.entries(this.savedState.mounts)) {
      const mount = this.mounts.get(name);
      // A mount materialized this session already (a call between initStore
      // and start) has a pin and watermark newer than anything saved.
      if (mount && mount.lastMaterializedBranchId === null && mount.lastMaterializedSeq === 0) {
        mount.lastMaterializedSeq = meta.lastMaterializedSeq;
        mount.lastMaterializedBranchId = meta.lastMaterializedBranchId ?? null;
        // A store that ran #169's stop-time baselines (#109) saved them here
        // too. They aren't carried over as evidence: #169 recorded no root,
        // so nothing binds them to the directory they describe, and an empty
        // mountpoint at the next start would read as every file deleted.
        // Such a store gains its evidence from its first pass instead: a
        // file disk agrees with is recorded, and anything else is a conflict
        // or unknown provenance, never an adoption.
        // watcherReadyAt intentionally not restored — each session must
        // observe its own watcher attach, otherwise a stale timestamp
        // would hide a new-session attach failure.
      }
    }
    this.savedState = null;

    // Absorb out-of-band branch switches (e.g. an offline repair that left
    // the store on a child branch): if the pinned branch is a strict ancestor
    // of the current branch and disk state is fully contained in the current
    // branch's history, re-pin. Without this, every materialize refuses
    // forever after a repair, even though nothing on disk can be clobbered.
    this.healBranchPins();
  }

  /**
   * True when everything last materialized to disk for a mount is part of the
   * CURRENT branch's history — i.e. the current branch is a linear
   * continuation of the pinned branch as of the pinned sequence.
   *
   * Walks the current branch's parent chain. Safe iff the pinned branch is on
   * the chain AND every fork point along the way is at or after `pinnedSeq`
   * (a fork before `pinnedSeq` means disk holds records the current branch
   * never had — genuine divergence). A missing/GC'd intermediate branch or a
   * child without fork metadata is treated as unsafe: ancestry can't be
   * proven, so the guard stays closed and `force` is the escape hatch.
   */
  private isLinearContinuation(
    store: JsStore,
    pinnedBranchId: string,
    pinnedSeq: number,
  ): boolean {
    const current = store.currentBranch();
    if (current.id === pinnedBranchId) return true;
    const byId = new Map(store.listBranches().map((b) => [b.id, b]));
    const visited = new Set<string>();
    let cursor = byId.get(current.id);
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.id === pinnedBranchId) return true;
      if (cursor.parentId === undefined || cursor.branchPoint === undefined) return false;
      if (cursor.branchPoint < pinnedSeq) return false;
      cursor = byId.get(cursor.parentId);
    }
    return false;
  }

  /**
   * Why materializing this mount is blocked on the current branch, or null if
   * it isn't. Single source of truth for the materialize guard AND the
   * `canMaterialize` status field, so status can never report `true` for a
   * mount that materialize would refuse (the pre-fix defect: status computed
   * per-mount id-equality while the guard checked ALL mounts).
   */
  private mountMaterializeBlockReason(store: JsStore, mount: MountState): string | null {
    if (this.config.materializeOnlyActiveBranch === false) return null;
    if (!mount.lastMaterializedBranchId) return null;
    const current = store.currentBranch();
    if (mount.lastMaterializedBranchId === current.id) return null;
    if (this.isLinearContinuation(store, mount.lastMaterializedBranchId, mount.lastMaterializedSeq)) {
      return null;
    }
    const pinned = store.listBranches().find((b) => b.id === mount.lastMaterializedBranchId);
    const pinnedName = pinned ? `"${pinned.name}"` : `id ${mount.lastMaterializedBranchId} (branch no longer exists)`;
    return (
      `current branch "${current.name}" has diverged from the branch last materialized to disk ` +
      `(${pinnedName} at seq ${mount.lastMaterializedSeq}) — disk may hold state the current branch ` +
      `never had. ls with path ${JSON.stringify(mount.config.name)} and recursive: true shows how each file of the current branch stands against disk; ` +
      'if the current branch is what disk should hold, pass force: true to overwrite disk from it.'
    );
  }

  /**
   * Re-pin mounts whose last-materialized branch is a proven ancestor of the
   * current branch. Runs after persisted state is applied on restart, so an
   * out-of-band branch switch (offline repair/treatment branches) heals at
   * boot instead of wedging materialize until manual surgery.
   */
  private healBranchPins(): void {
    const store = this.store;
    if (!store) return;
    const current = store.currentBranch();
    for (const mount of this.mounts.values()) {
      if (
        mount.lastMaterializedBranchId &&
        mount.lastMaterializedBranchId !== current.id &&
        this.isLinearContinuation(store, mount.lastMaterializedBranchId, mount.lastMaterializedSeq)
      ) {
        console.warn(
          `[workspace] Mount "${mount.config.name}": branch pin ${mount.lastMaterializedBranchId} → ` +
          `${current.id} ("${current.name}") — current branch linearly continues the last ` +
          `materialized branch (out-of-band switch, e.g. repair); disk state is preserved history.`,
        );
        mount.lastMaterializedBranchId = current.id;
      }
    }
  }

  /**
   * Start chokidar watchers and emit workspace:mounted events.
   * Idempotent: safe to call from both start() and initStore(), fires once
   * per mount regardless of which runs second. Once both have run, it
   * decides again which mounts configured direct run direct, now that the
   * mounts' nesting is known, and says which don't, once for this start.
   */
  private ensureRunning(): void {
    if (!this.ctx || this.mounts.size === 0) return;
    this.chooseKinds();
    if (this.notDirect.size > 0) this.sayNotDirect();

    for (const [name, mount] of this.mounts) {
      if (this.watchers.has(name)) continue;

      if (watchOf(mount.config) === 'always') {
        // Chokidar is started with ignoreInitial:true, so changes made while
        // the session was down would be invisible. A catch-up pass takes them
        // in under the three-way rule: only real differences produce tree
        // changes and events. It takes its turn with the mount's bare syncs,
        // so on a mount over its walkCap it covers the walkCap entries after
        // where the last turn stopped, and a change elsewhere waits for the
        // rotation to reach it, or for a sync of its path.
        //
        // The pass runs at each of the watcher's readies, its first and each
        // re-attach's, when chokidar has called fs.watch on every entry, so a
        // change made after the pass has looked at a file reaches the watcher.
        // Started beside chokidar's scan, the pass could finish with a file
        // before chokidar watched it, and a change between the two reached
        // neither. A watcher that isn't ready within CATCH_UP_BOUND_MS (from
        // its start or its re-attach) has the pass started at the bound, and
        // its ready, if it comes, runs the pass again. Within the mount's
        // walkCap, that pass covers what the early one missed. Over it, the
        // pass continues the rotation, and what the early one missed waits for
        // the rotation to come back, as any change outside a pass's window
        // does. An error doesn't start the pass: chokidar goes on scanning
        // after one, and the bound covers a watcher that never becomes ready.
        // On macOS, a new entry written after ready but before libuv's
        // FSEventStream exists isn't reported until a later change in its
        // directory, which this doesn't change.
        let watcher: MountWatcher | undefined;
        let bound: ReturnType<typeof setTimeout> | null = null;
        const catchUp = () => {
          if (bound) clearTimeout(bound);
          bound = null;
          // A watcher the module has since stopped or replaced starts no pass.
          if (this.watchers.get(name) !== watcher) return;
          void this.initialScan(name);
        };
        const awaitReady = () => {
          if (bound) clearTimeout(bound);
          bound = setTimeout(catchUp, CATCH_UP_BOUND_MS);
          bound.unref?.();
        };
        watcher = new MountWatcher(
          mount.config,
          (changes) => {
            this.handleFsChanges(name, changes);
          },
          {
            onReady: () => {
              mount.watcherReadyAt = Date.now();
              mount.watcherError = null;
              catchUp();
            },
            onError: (err) => {
              mount.watcherError = err.message;
              this.ctx?.pushEvent({
                type: 'workspace:watcher-error',
                mount: name,
                path: mount.config.path,
                error: err.message,
              } as ProcessEvent);
            },
            onReattach: () => {
              mount.watcherError = null;
              awaitReady();
              this.ctx?.pushEvent({
                type: 'workspace:watcher-reattached',
                mount: name,
                path: mount.config.path,
              } as ProcessEvent);
            },
          },
          this.othersOf(name),
        );
        awaitReady();
        watcher.start();
        this.watchers.set(name, watcher);
      }

      this.ctx.pushEvent({
        type: 'workspace:mounted',
        mount: name,
        path: mount.config.path,
      } as ProcessEvent);
    }
  }

  /**
   * Say, for whoever runs the host, which mounts configured direct run as
   * 'chronicle' this session (chooseKinds), what the workspace holds there
   * that keeps them so, and the two ways to start one direct: on stderr,
   * and as one ops alert for them all (the framework's failures log, its
   * `ops:alert` trace and, where one is set, its webhook, which posts one
   * alert of a kind per cooldown and keeps only the start and end of a long
   * one). So the words of fixed length, what's happening and the ways out,
   * come first, and the mounts and what they hold after them.
   */
  private sayNotDirect(): void {
    const mounts = [...this.notDirect];
    const one = mounts.length === 1;
    // An intent the workspace can't read may hold a change or may not, so
    // it's counted as what it is.
    const counted = (paths: Array<{ what: string }>) => {
      const u = paths.filter((h) => h.what === UNREADABLE_INTENT).length;
      const c = paths.length - u;
      return [
        c > 0 ? `${c} change${c === 1 ? '' : 's'} that disk lacks` : '',
        u > 0 ? `${u} intent${u === 1 ? '' : 's'} it can't read` : '',
      ].filter((part) => part !== '').join(' and ');
    };
    const each = mounts.map(([name, paths]) => `"${name}" (${counted(paths)})`);
    const which = one
      ? `Mount "${mounts[0]![0]}" holds ${counted(mounts[0]![1])}`
      : `Mounts ${each.slice(0, -1).join(', ')} and ${each[each.length - 1]} hold`;
    const held = mounts.flatMap(([name, paths]) => paths.map((h) => `"${name}/${h.path}" (${h.what})`));
    // Materialize settles an intent the workspace can't read only where the
    // workspace holds a copy there, and says nothing of one it doesn't, so
    // the ways out say what does wherever one is held, past the ten paths
    // named too.
    const intents = mounts.some(([, paths]) => paths.some((h) => h.what === UNREADABLE_INTENT))
      ? "Sync the path of an intent it can't read. "
      : '';
    const message = (one
      ? "A mount configured direct runs as 'chronicle' this session. To start it direct, settle each held change, then start it again: "
      : "Mounts configured direct run as 'chronicle' this session. To start a mount direct, settle each change held at it, then start it again: ") +
      "sync its path to take disk's copy, or materialize it by name, a read-only one configured read-write first, " +
      `and follow the answer. Meanwhile it takes no writes. ${intents}${which}: ${held.slice(0, 10).join(', ')}` +
      `${held.length > 10 ? `, and ${held.length - 10} more` : ''}.`;
    console.warn(`[workspace] ${message}`);
    this.ctx?.notifyOps?.('workspace-mount-not-direct', 'framework', message, { held: Object.fromEntries(mounts.map(([name, paths]) => [name, paths.length])) });
  }

  private async initialScan(mountName: string): Promise<void> {
    const store = this.store;
    const mount = this.mounts.get(mountName);
    if (!store || !mount) return;

    try {
      // A full pass under the three-way rule: deletions on disk are confirmed
      // where nothing newer is pending, and nothing unvisited is touched.
      await this.withMount(mount, () => this.passUnlocked(mount, { kind: 'dir', dir: '', recursive: true }, { resume: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx?.pushEvent({
        type: 'workspace:initial-scan-failed',
        mount: mountName,
        error: msg,
      } as ProcessEvent);
    }
  }

  async stop(): Promise<void> {
    this.stopsBegun++;
    // No new watcher-driven passes, then let every pass and write finish
    // before the store goes away — including any queued behind the ones in
    // flight (a tool call, a scan continuing past its deadline): drained
    // until no new tail appears. The watchers leave this.watchers before they
    // stop, so a watcher's ready or catch-up bound starts no pass meanwhile.
    const stopping = [...this.watchers.values()];
    this.watchers.clear();
    for (const watcher of stopping) {
      await watcher.stop();
    }
    // A call under way can await disk (parsePath) before it takes its turn,
    // so the calls are waited for as well as the turns.
    for (;;) {
      const tails = [...this.mountTurns.values()];
      await Promise.allSettled([...this.callsUnderWay, ...tails]);
      const now = [...this.mountTurns.values()];
      if (this.callsUnderWay.size === 0 && now.length === tails.length && now.every((tail, i) => tail === tails[i])) break;
    }
    // Nothing is queued now, and nothing more is taken: what follows saves
    // the pins and watermarks as the last work left them.
    this.stopped = true;

    // Persist state, once initStore() has run and the state start() was
    // handed has been applied (savedState is cleared then). Before that this
    // session has made no pass or write, so it has nothing to save, and the
    // stored state stays as it was: saving would put empty or default mounts
    // over the saved pins. A create() that fails after starting this module
    // stops it before the host can call initStore() (#389), and an
    // initStore() that throws after taking the store leaves the state
    // unapplied.
    if (this.ctx && this.store && this.savedState === null) {
      const activeBranchId = this.store.currentBranch().id;
      const state: WorkspaceModuleState = { mounts: {}, activeBranchId };
      for (const [name, mount] of this.mounts) {
        state.mounts[name] = {
          lastMaterializedSeq: mount.lastMaterializedSeq,
          lastMaterializedBranchId: mount.lastMaterializedBranchId ?? undefined,
          watcherReadyAt: mount.watcherReadyAt,
          watcherError: mount.watcherError,
        };
      }
      this.ctx.setState(state);
    }
    this.saveDirectHeads();
    this.ctx = null;
  }

  /**
   * Save directHeads as one global record, the latest of which the next
   * start loads (loadDirectHeads): each mount's positions with the root
   * they were made under, and the entries this session didn't take up
   * (carriedHeads), unchanged. Only when that differs from what the
   * start loaded, so a session that changed nothing, or a store no direct
   * write reached, adds no record, and always where the record read wasn't
   * of the shape saved, which this replaces. Nothing where the store couldn't
   * read the record, so it stands. A save that fails is logged, and the next
   * start finds the positions of the last save that landed, as after a
   * crash.
   */
  private saveDirectHeads(): void {
    if (!this.headsJournal) return;
    const snapshot: DirectHeadsSnapshot = [
      ...this.carriedHeads,
      ...[...this.directHeads].filter(([, heads]) => heads.size > 0).map(([name, heads]) => ({
        mount: name,
        root: resolve(this.mounts.get(name)!.config.path),
        agents: Object.fromEntries([...heads].map(([agent, { branchId, after, notice }]) => [agent, { branchId, after, ...(notice !== null ? { notice } : {}) }])),
      })),
    ];
    const text = canonicalHeads(snapshot);
    if (text === this.loadedHeads) return;
    try {
      this.headsJournal.checkpoint(snapshot);
      this.loadedHeads = text;
    } catch (err) {
      console.error('[workspace] could not save the direct-write positions:', err);
    }
  }

  /** Mount names + modes, each mount's include where it sets one, and
   *  `backend: 'direct'` for one configured direct, whether it runs direct
   *  this session or, while the store holds work there disk lacks, as
   *  'chronicle': either way it's a directory agents write directly when it
   *  runs direct, whose files an undo leaves. For the
   *  framework's tool-result spills, saved payloads and fetched references,
   *  which need a mount for files of their own: the first writable one
   *  without an include that isn't direct (firstWritableMountName), without
   *  reaching into private state. */
  getMounts(): Array<{ name: string; mode: 'read-write' | 'read-only'; include?: readonly string[]; backend?: 'direct' }> {
    return [...this.mounts.values()].map((m) => ({
      name: m.config.name,
      // Read-only where this session takes no writes there (writeRefusal).
      mode: writeRefusal(m) === null ? 'read-write' : 'read-only',
      ...(m.config.include ? { include: [...m.config.include] } : {}),
      ...(m.config.backend === 'direct' ? { backend: 'direct' as const } : {}),
    }));
  }

  // ==========================================================================
  // Tool Definitions
  // ==========================================================================

  /**
   * Whether any of this host's mounts runs direct. The tools' descriptions
   * and grep's notes mention direct mounts only on such a host, so both ask
   * this one question.
   */
  private anyRunsDirect(): boolean {
    return [...this.mounts.values()].some((m) => m.direct);
  }

  getTools(): ToolDefinition[] {
    // Where a mount runs direct, four descriptions say what that changes.
    // A host with none keeps them as they were, and its residents' caches.
    const direct = this.anyRunsDirect();
    const lsDirect = direct
      ? ' A direct mount (ls without a path says which, with its ignore list) lists disk\'s files as they are now: each with '
        + 'its size and no state, or a note where the mount doesn\'t take it. A path its ignore list covers is listed when you name it.'
      : '';
    const grepDirect = direct
      ? ' On a direct mount, grep searches disk\'s files as they are now (version disk), and lists as skipped, with why, '
        + 'those it doesn\'t: binary, over the size limit, or not read, such as a link the mount doesn\'t follow.'
      : '';
    const globDirect = direct ? ' On a direct mount, a match carries its size, or a note where the mount doesn\'t take it, and no state.' : '';
    const syncDirect = direct ? ' A direct mount is listed under `skipped`: its tools read disk as it is, so there\'s nothing to take in.' : '';
    // Where a direct mount is writable, the four writing tools say what a
    // write is there: on disk when it answers, and left there by a head move.
    const writable = [...this.mounts.values()].some((m) => m.direct && m.config.mode !== 'read-only');
    const writeDirect = writable
      ? ' On a direct mount, the file is on disk, whole and with its mode kept, when the call answers, and an undo or other head move leaves it there.'
      : '';
    const editDirect = writable
      ? " On a direct mount, the edit applies to disk's text as it is now and is on disk when the call answers; a change another writer makes "
        + 'meanwhile is kept, with the edit applied again on top of it, and an undo or other head move leaves the edit on disk.'
      : '';
    const editManyDirect = writable
      ? " On a direct mount, every edit is checked against disk's text before any file is written, and then the files are written one by one: "
        + "if a write fails partway, the answer names which files were written and which weren't, and nothing puts the written ones back. "
        + 'An undo or other head move leaves them on disk.'
      : '';
    const deleteDirect = writable ? ' On a direct mount, the file is removed from disk at once, and an undo or other head move doesn\'t bring it back.' : '';
    const materializeDirect = writable ? ' A direct mount writes its files to disk as they\'re made, so materialize passes over it, under `skipped` where you name it.' : '';
    return [
      {
        name: 'read',
        description: 'Read a file from the workspace. Returns content with line numbers. '
          + 'Reads at most 2000 lines per call by default — use offset/limit to page through larger files. '
          + 'For long lines or spill files, use offsetChars/limitChars instead: returns raw text without '
          + 'line numbers, with nextOffsetChars (null at EOF). Keep limitChars when continuing. '
          + 'Character offsets count UTF-16 code units; do not mix character and line parameters.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed, e.g., "project/src/main.ts")' },
            offset: { type: 'integer', description: 'Starting line number (1-indexed)' },
            limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000)' },
            offsetChars: { type: 'integer', description: 'Character paging: zero-based UTF-16 offset (default 0); use nextOffsetChars to continue' },
            limitChars: { type: 'integer', description: 'Character paging: code units to return (default 2000), plus at most one to keep a surrogate pair intact. Use the limit suggested by a spill notice.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'read_image',
        description: 'Read an image file from the workspace and return native image content.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Image file path (mount-prefixed, e.g., "project/assets/logo.png")' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write',
        description: 'Create or overwrite a file in the workspace.' + writeDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit',
        description: 'Edit a file by replacing exact text. oldString must occur exactly once, or with replaceAll at least once, '
          + "and every occurrence is replaced; occurrences that overlap count, but can't each be replaced. "
          + 'A miss shows the closest region it finds, numbered, and a count that differs shows the lines that matched. '
          + 'CRLF line ends are matched with LF text and kept, as is a BOM. As second chances, straight and curly quotes match as equal, '
          + "and an oldString carrying the file's BOM at its start or a line's CR at its end, as a character page shows them, matches without them, "
          + 'its newString read the same way. '
          + "Only the replaced text changes, and the new text's line ends take those of the text it replaces. "
          + 'A change disk made to the file is taken in first, and the answer says so. '
          + 'The answer shows the changed region, numbered, a long line from shortly before the change on it, as its length allows. '
          + 'For several edits at once, in one file or across files, applied all or none, use edit_many.' + editDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
            oldString: { type: 'string', description: 'Exact text to replace, including whitespace and indentation' },
            newString: { type: 'string', description: 'Replacement text' },
            replaceAll: { type: 'boolean', description: 'Replace every occurrence (default: false)' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
      {
        name: 'edit_many',
        description: 'Apply several exact edits at once, in one file or across files of one mount, all or none: no edit is stored unless every edit applies. '
          + "Each edit's oldString must occur in its file exactly `occurrences` times (1 when left out), and every one is replaced; "
          + "occurrences that overlap count, but can't each be replaced. "
          + "Each edit is matched in its file as this call reads it, never in another edit's result, so the list's order doesn't matter, "
          + "and two edits' matches may touch but not overlap. Matching is edit's. "
          + "A refusal names the problems it finds, each by its edit's number in the list (from 1). "
          + 'All or none holds in the workspace: on a mount that writes to disk, disk can still refuse a file, '
          + "and the answer then says every edit is stored and names each file disk refused, with its push's reason. "
          + "The answer shows each edit's first changed region, numbered, a long line from shortly before each change on it, as its length allows."
          + editManyDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            edits: {
              type: 'array',
              description: "The edits, each matched in its file as this call reads it, never in another edit's result",
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path (mount-prefixed); every edit names a file of the same mount' },
                  oldString: { type: 'string', description: 'Exact text to replace, as the file holds it before this call' },
                  newString: { type: 'string', description: 'Replacement text' },
                  occurrences: {
                    type: 'integer',
                    description: 'How many times oldString occurs in the file (default: 1); every one is replaced, and any other count is refused',
                  },
                },
                required: ['path', 'oldString', 'newString'],
              },
            },
          },
          required: ['edits'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a file from the workspace. On a mount without autoMaterialize the disk copy stays, '
          + 'listed as workspace-deleted (no scan brings it back), until materialize with applyDeletions removes it '
          + 'or a sync of the path restores it.' + deleteDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'ls',
        description: 'List a directory, checked against disk first. Each file has a state: synced; '
          + 'workspace-draft (the workspace has changes disk lacks); workspace-deleted (deleted in the workspace, '
          + 'still on disk); not-in-branch (on disk, absent from this branch\'s workspace); disk-only (binary or over '
          + 'the size limit, never stored — shown with size and image type); conflict, with its kind (disk and the '
          + 'workspace both changed; disk holds a different copy and nothing records which is newer; or a write was '
          + 'interrupted) — sync the path to take disk, or materialize that path with force to take the workspace, '
          + 'with applyDeletions too where the workspace deleted it; '
          + 'disk-missing-provenance-unknown; unverified (disk could not be checked). `incomplete` names regions '
          + 'the listing could not see.' + lsDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path (mount-prefixed, optional; without it, the mounts are listed, each with its include where it has one)' },
            recursive: { type: 'boolean', description: 'List recursively (default: false)' },
          },
        },
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern, checked against disk first; each match carries its state, as ls describes. '
          + 'The pattern is relative to path (or to each mount\'s root). In the mount its first segment names, it is read mount-prefixed instead, like the paths it returns, within path if one is given; in every other mount, as written.' + globDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Glob pattern, relative (e.g., "**/*.ts") or mount-prefixed (e.g., "project/src/**/*.ts")' },
            path: { type: 'string', description: 'Directory to search in (mount-prefixed, optional)' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep',
        description: 'Search stored file text with a regex pattern, checked against disk first. Each result says '
          + 'which version matched: the workspace\'s (with its state); the disk version kept with a conflict '
          + '(conflicting-disk); or, once disk has changed since the conflict was recorded, that recorded version '
          + '(recorded-disk). Disk versions it could not search are listed as skipped: disk-only files (binary or '
          + 'over the size limit), and a conflict\'s disk version that is binary, oversize, or newer than the one recorded.' + grepDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern' },
            path: { type: 'string', description: 'File or directory to search (mount-prefixed, optional)' },
            glob: { type: 'string', description: 'Glob pattern to filter files: one with a "/" is matched from the mount\'s root, whatever the path (e.g., "src/**/*.ts"), and in the mount its first segment names, read mount-prefixed (e.g., "project/src/**/*.ts"), in every other mount as written; one with no "/" also matches a file\'s name at any depth (e.g., "*.ts")' },
            contextBefore: { type: 'integer', description: 'Context lines before match' },
            contextAfter: { type: 'integer', description: 'Context lines after match' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'status',
        description: 'Show workspace status: mounted directories, pending changes, conflicts.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            mount: { type: 'string', description: 'Specific mount to check (optional)' },
          },
        },
      },
      {
        name: 'materialize',
        description: 'Write workspace files to the real filesystem. Use after writing/editing to push changes to disk. '
          + 'Never deletes disk files unless applyDeletions is given; lists workspace deletions it left on disk. '
          + 'On a mount with an include, what the include doesn\'t cover is never written, and one naming a '
          + 'directory counts what it left beneath it under `passedOver`, by mount and reason, without naming it.' + materializeDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to materialize (optional — defaults to what disk still owes: workspace edits, conflicts, workspace deletions, and files never checked against disk)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
            force: { type: 'boolean', description: 'Overwrite files whose disk copy changed since it last agreed with the workspace (another writer, or a conflict), and materialize even if the current branch has diverged from the branch last written to disk (default false). Without it, divergent files are skipped and listed. A file the workspace has not changed is left as disk has it unless you name its path.' },
            applyDeletions: { type: 'boolean', description: 'Also delete from disk the files deleted in the workspace whose disk copy is one the workspace holds (default false). With force, also those whose disk copy changed since.' },
          },
        },
      },
      {
        name: 'sync',
        description: 'Bring disk changes into the workspace. Without a path, every mount (or the given one) is '
          + 'rechecked and nothing pending in the workspace is discarded. A sync takes up to the mount\'s walk '
          + 'cap of entries, files, links and the like (5000 unless configured). Past it, what this one didn\'t reach is listed under '
          + '`incomplete`, and the walk takes turns: the next sync of the same mount or directory picks up where '
          + 'the last turn stopped, so repeated syncs cover it all. On a mount watched continuously, its own catch-up '
          + 'scan, at start and when its watcher reattaches, takes turns with its whole-mount syncs. With a '
          + 'path (file or directory), '
          + 'the workspace takes disk\'s state there explicitly: it restores a workspace-deleted file, resolves '
          + 'conflicts toward disk, replaces a workspace draft, and removes a workspace file disk does not have. '
          + 'Each workspace change it gives up is listed under `discarded`, with the state it had and, as `op`, '
          + 'what that did to the workspace copy (absent when it changed none: a deletion or conflict given up for '
          + 'a disk copy the workspace can\'t hold). '
          + 'A mount whose root is not the directory disk last agreed with (an unmounted drive, a replaced '
          + 'directory) is unavailable and listed under `incomplete`. Reconnect the drive; acceptRoot is for a '
          + 'directory replaced on purpose, or a drive back under a new device number, never for one still '
          + 'unplugged, whose empty mountpoint would become the root. What the scan passed over by design and '
          + 'reported nowhere else is counted under `passedOver`, by mount and reason: another mount\'s '
          + 'directory nested in this one, entries the mount\'s ignore list covers, and entries with an '
          + 'editor\'s swap or backup file name (`.name.swp` and `.name.swx` as the whole name, names ending '
          + 'in `~` or in `.subl…tmp`), each holding nothing the workspace tracks (such a directory counts '
          + 'once, with what lies beneath it); and files and links outside the mount\'s include, a link '
          + 'counted as "a symlink, not walked" instead where it leads to a directory on a mount that follows '
          + 'symlinks, and wherever it leads on one that doesn\'t. So a '
          + 'total of 0, with no conflicts and nothing under `passedOver`, `incomplete` or `skipped`, means the '
          + 'sync looked everywhere and nothing had changed. A path the mount ignores, or an editor\'s file, is '
          + 'synced when you name it, and listed under `ignored`: a sync without a path passes over it. A path '
          + 'in another mount\'s directory isn\'t synced even when you name it: use the mount that holds it. Naming '
          + 'an ignored directory sets aside the patterns that cover it or a directory above it; one that '
          + 'covers only something inside it still applies, and what it covers is passed over, as are editors\' '
          + 'files inside it.' + syncDirect,
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to take from disk (optional — defaults to a full recheck)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
            acceptRoot: {
              type: 'boolean',
              description: 'Take each mount\'s root as it is now when it is not the directory disk last agreed with: '
                + 'a directory replaced on purpose, or a drive that came back under a new device number (default false). '
                + 'What was recorded about the old one is set aside, so every file is compared afresh: a file disk '
                + 'and the workspace agree on agrees again, a differing one is a conflict, and a workspace file the '
                + 'root lacks stays in the workspace. Not with path. Leave it off while a drive is merely unplugged: '
                + 'its empty mountpoint would become the root.',
            },
          },
        },
      },
    ];
  }

  // ==========================================================================
  // Tool Dispatch
  // ==========================================================================

  private generatedTextFiles = new Map<string, {read: () => string; agentName: string}>();

  /** Compare the same normalized physical path for registration and tool access. */
  private generatedFileKey(path: string): string {
    const slash = path.indexOf('/');
    const mountName = slash < 0 ? path : path.slice(0, slash);
    const mount = this.config.mounts.find(m => m.name === mountName);
    if (!mount) throw new Error(`Unknown mount: "${mountName}"`);
    // Against the resolved root, as parsePathAsGiven's traversal guard judges it.
    const root = resolve(mount.path);
    const resolved = resolve(root, slash < 0 ? '' : path.slice(slash + 1));
    if (!isContainedPath(root, resolved)) throw new Error(`Path traversal detected: "${path}"`);
    return resolved;
  }

  private findGeneratedTextFile(path: string) {
    if (!this.generatedTextFiles.size) return undefined;
    try { return this.generatedTextFiles.get(this.generatedFileKey(path)); }
    catch {
      // Not an alias of a valid generated file. Let the selected tool return
      // its established validation error (including image-specific errors).
      return undefined;
    }
  }

  /** Generated files bypass stored blobs so every read reflects current definitions. */
  registerGeneratedTextFile(path: string, read: () => string, agentName: string): void {
    const [mount, ...parts] = path.split('/');
    if (!this.config.mounts.some(m => m.name === mount) || !parts.length
      || parts.some(p => !p || p === '.' || p === '..') || this.generatedTextFiles.has(this.generatedFileKey(path)))
      throw new Error(`Duplicate/invalid generated path: ${path}`);
    this.generatedTextFiles.set(this.generatedFileKey(path), {read, agentName});
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (!this.running()) return { success: false, isError: true, error: NOT_RUNNING };
    return this.underWay(this.runToolCall(call));
  }

  /**
   * Tool calls, and the public reads and writes that take a mount's turn,
   * under way. Each can await disk (parsePath) before it takes its turn, so
   * stop waits for these as well as for the turns.
   */
  private callsUnderWay = new Set<Promise<unknown>>();

  /** `work`, recorded as under way until it settles (callsUnderWay). */
  private underWay<T>(work: Promise<T>): Promise<T> {
    this.callsUnderWay.add(work);
    const done = (): void => { this.callsUnderWay.delete(work); };
    work.then(done, done);
    return work;
  }

  private runToolCall(call: ToolCall): Promise<ToolResult> {
    const gate = { passed: false };
    return callGate.run(gate, () => this.answerToolCall(call, gate));
  }

  private async answerToolCall(call: ToolCall, gate: { passed: boolean }): Promise<ToolResult> {
    const reopenAtStart = this.agreement?.awaitsReopen === true;
    try {
      // Every handler reads its input as its schema describes it; a call
      // that sends something else is refused here, before anything is read.
      const schema = this.getTools().find((tool) => tool.name === call.name)?.inputSchema;
      const problem = schema ? inputProblem(schema, call.input, INPUT_MINIMUMS[call.name]) : null;
      if (problem !== null) {
        return { success: false, isError: true, error: `The ${call.name} call did nothing: ${problem}.` };
      }
      const input = call.input as Record<string, unknown>;
      // The most of this call's result that can reach its caller whole: past
      // it, a model's result spills into a file, and a script gets
      // ResultTooLarge in its place. A call made in process carries none and
      // takes the data itself, so its read pages by its line limit alone.
      const resultMaxChars = call.resultMaxChars;
      const generated = schema !== undefined && typeof input?.path === 'string' ? this.findGeneratedTextFile(input.path) : undefined;
      if (generated) {
        if (call.name === 'read' && call.callerAgentName === generated.agentName) {
          return await this.handleRead(input as unknown as ReadInput, resultMaxChars, generated.read());
        }
        return { success: false, isError: true, error: didNothing(call.name, this.generatedFileRefusal(input.path as string, generated, call.callerAgentName)) };
      }

      switch (call.name) {
        case 'read': return await this.handleRead(input as unknown as ReadInput, resultMaxChars);
        case 'read_image': return await this.handleReadImage(input as unknown as ReadImageInput);
        case 'write': return await this.handleWrite(input as unknown as WriteInput, call.callerAgentName);
        case 'edit': return await this.handleEdit(input as unknown as EditInput, call.resultMaxChars, call.callerAgentName);
        case 'edit_many': return await this.handleEditMany(input as unknown as EditManyInput, call.resultMaxChars, call.callerAgentName);
        case 'delete': return await this.handleDelete(input as unknown as DeleteInput, call.callerAgentName);
        case 'ls': return await this.handleLs(input as unknown as LsInput);
        case 'glob': return await this.handleGlob(input as unknown as GlobInput);
        case 'grep': return await this.handleGrep(input as unknown as GrepInput);
        case 'status': return await this.handleStatus(input as unknown as StatusInput);
        case 'materialize': return await this.handleMaterialize(input as unknown as MaterializeInput);
        case 'sync': return await this.handleSync(input as unknown as SyncInput);
        default:
          return { success: false, error: unknownToolMessage(this.name, call.name, this.getTools()), isError: true };
      }
    } catch (err) {
      return { success: false, error: this.failureAnswer(call, err, reopenAtStart, gate.passed), isError: true };
    }
  }

  private failureAnswer(call: ToolCall, err: unknown, reopenAtStart: boolean, passedGate: boolean): string {
    const input = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as { path?: unknown; mount?: unknown };
    const path = typeof input.path === 'string' ? input.path : undefined;
    const mountName = path !== undefined ? path.split('/')[0]! : typeof input.mount === 'string' ? input.mount : undefined;
    const subject = path !== undefined ? JSON.stringify(path) : typeof input.mount === 'string' ? `mount ${JSON.stringify(input.mount)}` : undefined;
    const reopened = !reopenAtStart && this.agreement?.awaitsReopen === true;
    if (err instanceof EvidenceUnavailable && passedGate && changesFiles(call.name)) {
      return `The ${call.name}${subject !== undefined ? ` of ${subject}` : ''} stopped partway: ${err.message} Whether it changed anything before it stopped isn't known until then.`;
    }
    if (err instanceof Refusal) return didNothing(call.name, err.message);
    if (err instanceof WorkspaceReadError) return didNothing(call.name, path !== undefined ? readRefusal(err, path) : sentence(err.message));
    const look = call.name !== 'materialize' && call.name !== 'sync' ? undefined
      : mountName !== undefined ? `ls with path ${JSON.stringify(mountName)} and recursive: true shows how each file there stands against disk now`
        : 'ls of each mount, with recursive: true, shows how each file stands against disk now';
    if (err instanceof NotStored || err instanceof AlreadyHeld) {
      console.error(`[workspace] ${call.name} failed before it changed anything:`, err.thrown);
      return unexpectedAnswer(call.name, subject, err.thrown, { stored: err instanceof NotStored ? 'not' : 'held', reopen: reopened });
    }
    console.error(`[workspace] ${call.name} failed:`, err);
    if (err instanceof CommitUnknownError) {
      return unexpectedAnswer(call.name, subject, err.setCause, {
        said: `the store failed as it set the change (${storeWords(err.setCause)}), and reading it back failed too (${storeWords(err.readCause)})`, reopen: reopened, look,
      });
    }
    return unexpectedAnswer(call.name, subject, err, { reopen: reopened, look });
  }


  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    // Wake agents on filesystem events when the originating mount opted in.
    // The EventGate still has final say — gate policies can further filter by
    // mount name, path glob, or op type without requiring a recipe change.
    if (!(WORKSPACE_FS_EVENT_TYPES as readonly string[]).includes(event.type)) {
      return {};
    }
    const mountName = (event as { mount?: string }).mount;
    if (!mountName) return {};
    const mount = this.mounts.get(mountName);
    if (!mount) return {};

    const flag = mount.config.wakeOnChange;
    if (!flag) return {};

    const op = event.type.slice('workspace:'.length) as WorkspaceFsOp;
    const opAllowed = flag === true || (Array.isArray(flag) && flag.includes(op));
    if (!opAllowed) return {};

    // Inject a context message so the model actually sees the event.
    // The wake signal alone (requestInference) only starts an inference; the
    // model needs textual evidence in its context to act on it. Symmetric with
    // how the framework converts mcpl:channel-incoming / mcpl:push-event into
    // user-role messages — we keep it module-side here so the gate stays a
    // pure activation layer (no representation responsibility) and so the
    // message format is colocated with the event source.
    //
    // Note: addMessages is applied unconditionally by the framework, but
    // requestInference still passes through the EventGate. A gate-suppressed
    // event will leave the message in context for the next inference to see —
    // which is exactly what you want for the "burst landed during streaming"
    // case.
    const paths = ((event as { paths?: string[] }).paths ?? []).filter(p => typeof p === 'string');
    const conflicts = (event as { conflicts?: string[] }).conflicts;
    if (paths.length === 0) return { requestInference: true };

    let text: string;
    if (paths.length === 1) {
      text = `[${NOTICE_TAG.workspaceEvent} · ${op} · ${nameToTypeBack(paths[0]!)}]`;
    } else {
      const list = paths.map(p => `- ${nameToTypeBack(p)}`).join('\n');
      text = `[${NOTICE_TAG.workspaceEvent} · ${op} · ${paths.length} files in ${mountName}/]\n${list}`;
    }
    if (conflicts && conflicts.length > 0) {
      text += `\n[${NOTICE_TAG.conflictsWithDisk}: ${conflicts.map(nameToTypeBack).join(', ')}; reading each shows how to settle it]`;
    }

    return {
      requestInference: true,
      addMessages: [
        {
          participant: 'user',
          content: [{ type: 'text', text }],
          metadata: {
            source: 'workspace',
            mount: mountName,
            op,
            paths,
            triggered: true,
            ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
          },
        },
      ],
    };
  }

  // ==========================================================================
  // Path Resolution
  // ==========================================================================

  /**
   * Resolve a mount-prefixed path (e.g. "tickets/2026-04-22-foo.md") to its
   * absolute filesystem path. Returns null if the mount is unknown or
   * doesn't hold the path: one that leaves the mount's directory, lies in
   * another mount's directory nested in it, or falls outside its include, or
   * one that can't name a file of it, with a separator right after the
   * mount's name or a lone UTF-16 surrogate.
   *
   * **Lexical containment only.** The guard reasons about `..` segments in the
   * path string; it knows nothing about what is on disk. A symlink inside the
   * mount that targets an outside file passes this check, and a caller that
   * then does `fs.readFile(path)` reads the outside content. Use the returned
   * path for resolution-only purposes (write targets, nonexistent paths,
   * display); for reading file content, use {@link readFileFromDisk}, which
   * enforces the mount's `followSymlinks` policy and canonical containment.
   * It judges other mounts' directories by where the last start placed them,
   * so for a direct mount whose root has moved since, it can differ from
   * `readFileFromDisk`, which takes the nesting where the root lies now
   * (movedNesting), about which paths lie in another mount's directory.
   *
   * @deprecated for direct filesystem reads — call `readFileFromDisk()`.
   */
  resolveAbsolutePath(mountPrefixedPath: string): string | null {
    try {
      // Synchronous, so the path as given. The nested-mount check takes it
      // in any spelling a disk that folds names may fold to the nested
      // mount's directory, erring toward that mount (holderOf). The include
      // judges it as given, so on a disk that
      // folds names a covered name whose file disk spells otherwise returns
      // that file's path, which the tools refuse, and a covered file named in
      // another case is null, which the tools read. A path the mount doesn't
      // hold, outside its include or in another mount's directory nested in
      // it, is null, as for a path that leaves the mount's directory.
      const { mount, relativePath } = this.refuseNotHeld({ ...this.parsePathAsGiven(mountPrefixedPath), path: mountPrefixedPath }, mountPrefixedPath);
      return resolve(mount.config.path, relativePath);
    } catch {
      return null;
    }
  }

  /**
   * Write binary content (e.g. an image pulled from the agent's context) to a
   * mount, through the same Chronicle-tree + auto-materialize path as the
   * `write` tool. Public API for the framework's synthesized `save_recent_image`
   * tool and other peer callers that hold bytes rather than text.
   *
   * `branch`, when given, ties the write to that branch: the store's current
   * branch is checked where the tree entry is set, nothing yielding between
   * the check and the entry, so the file's tree entry lands on that branch or
   * the write is refused, with `data: { branchLeft: true }`. A mount has one
   * directory on disk, so with autoMaterialize the file's copy there is
   * written like any other write's. The tool-result guard writes a
   * withheld original this way, for the branch its stub is on
   * (agent-framework #277).
   *
   * On a mount running direct, the bytes go to disk as a direct `write`'s
   * do, whole or not at all, and nothing goes into the store: `branch` is
   * checked before the write starts and again just before its rename, and
   * `agentName` names the agent whose write it is for the head-move notice
   * (a write naming none tells no agent).
   *
   * A success's `disk` says where the file stands on disk as the workspace
   * last saw it, as the write tool's answer does.
   *
   * A write whose tree entry is set but that then fails returns success
   * false with `data: { inChronicle: true }`: its copy on disk was refused,
   * the store failed after recording the entry, which skips the push where
   * the mount pushes, or something after the entry (recording its intent,
   * the event, the push) threw. The workspace's tools read the file from the
   * tree, so it is there for them, on the branch that was current when the
   * entry was set. A set that threw and couldn't be read back throws, saying
   * that whether the entry is set isn't known.
   */
  async writeBinary(
    mountPrefixedPath: string,
    data: Buffer,
    mimeType: string,
    options: { branch?: string; agentName?: string } = {},
  ): Promise<ToolResult> {
    if (!this.running()) return { success: false, isError: true, error: NOT_RUNNING };
    return this.underWay(this.writeBinaryUnderWay(mountPrefixedPath, data, mimeType, options));
  }

  private async writeBinaryUnderWay(
    mountPrefixedPath: string,
    data: Buffer,
    mimeType: string,
    options: { branch?: string; agentName?: string },
  ): Promise<ToolResult> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath, path: mountPrefixedPath } = await this.parseFilePath(mountPrefixedPath));
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
    if (relativePath === '') return { success: false, error: namesRoot(mountPrefixedPath, mount.config.name), isError: true };
    const refusal = writeRefusal(mount, this.writableNames());
    if (refusal) return { success: false, error: refusal, isError: true };
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (data.byteLength > maxSize) {
      return { success: false, error: tooLargeToWrite(mountPrefixedPath, data.byteLength, maxSize), isError: true };
    }
    const store = this.getStore();
    // A direct mount's bytes go to disk, whole, or nowhere (writeDirect),
    // as the caller's agent's write, where it names one. A branch it names
    // is checked just before the rename, since disk is no branch's.
    if (mount.direct) {
      // Checked first too, so a request already for a left branch makes no
      // directory and stages nothing.
      if (options.branch !== undefined && store.currentBranch().name !== options.branch) {
        return { success: false, error: BRANCH_LEFT, isError: true, data: { branchLeft: true } };
      }
      const written = await this.writeDirect(mount, relativePath, mountPrefixedPath, data, options.agentName, options.branch);
      if ('error' in written) return { success: false, isError: true, error: written.error, ...(written.branchLeft ? { data: { branchLeft: true } } : {}) };
      return { success: true, data: { path: mountPrefixedPath, size: data.byteLength, mimeType, disk: 'done', ...(written.note ? { note: written.note } : {}) } };
    }
    return this.withMount(mount, async () => {
      await this.settleBeforeMutation(mount, relativePath);
      // Checked inside the mount's turn, after anything the write waited on:
      // commitToolChange sets the tree entry before it first yields.
      if (options.branch !== undefined && store.currentBranch().name !== options.branch) {
        return { success: false, error: BRANCH_LEFT, isError: true, data: { branchLeft: true } };
      }
      const blobHash = store.storeBlob(data, mimeType);
      // An overwrite keeps the file's mode, as the write tool's does.
      const existing = store.treeGet(mount.treeStateId, relativePath);
      let committed = false;
      let failure: string | null;
      let modeKept: string | null = null;
      let disk: DiskState | null = null;
      try {
        const answer = await this.commitToolChange(mount, relativePath,
          { kind: 'set', blobHash, size: data.byteLength, ...(existing ? { mode: existing.mode } : {}) }, () => { committed = true; });
        modeKept = answer.modeKept;
        disk = answer.disk;
        failure = answer.refused === null ? null
          : `Wrote to Chronicle but failed to materialize "${mountPrefixedPath}" to disk: ${answer.refused}.`;
      } catch (error) {
        if (!committed) throw error;
        // As write words it: a store that failed after recording the file
        // skipped its push, so on a mount that pushes, disk lacks it.
        const reopen = this.agreement?.awaitsReopen === true;
        failure = error instanceof StoredThenFailed
          ? `Stored "${mountPrefixedPath}" in Chronicle, but the store failed after recording it: ${error.message}.`
            + (error.pushes ? ` Its push to disk didn't run, so disk lacks the change until a materialize of the path writes it${reopen ? ONCE_REOPENED : ''}.` : '')
          : `Stored "${mountPrefixedPath}" in Chronicle, but the rest of the write failed: ${error instanceof Error ? error.message : String(error)}.`;
        if (reopen) failure += ` ${AWAITS_REOPEN}`;
      }
      if (failure !== null) {
        // The file is in the Chronicle tree, where the workspace's tools read
        // it. `inChronicle` lets a caller that needs the file readable tell
        // this from a write that never happened (agent-framework #281).
        return { success: false, error: failure, isError: true, data: { inChronicle: true } };
      }
      return {
        success: true,
        data: { path: mountPrefixedPath, size: data.byteLength, mimeType, disk, ...(modeKept ? { modeKept } : {}) },
      };
    });
  }

  /**
   * Read a file's raw bytes from a mount: through the Chronicle tree, a path
   * the workspace doesn't hold observed first (ensureSynced); or, on a direct
   * mount, from disk as readBinaryFromDisk reads it, at most the mount's
   * `maxFileSize`. A path the workspace holds is read as the workspace holds
   * it, not settled as the `read` tool settles it: the tree takes in no
   * binary disk copy, so a pass over a held binary file that disk changed
   * would drop the workspace's copy. Public API for the framework's
   * synthesized `read_image` tool, where the workspace module doesn't serve
   * read_image itself, and other peer callers that need binary content.
   */
  async readBinary(
    mountPrefixedPath: string,
  ): Promise<{ data: Buffer } | { error: string }> {
    if (!this.running()) return { error: NOT_RUNNING };
    return this.underWay(this.readBinaryUnderWay(mountPrefixedPath));
  }

  private async readBinaryUnderWay(
    mountPrefixedPath: string,
  ): Promise<{ data: Buffer } | { error: string }> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath, path: mountPrefixedPath } = await this.parseFilePath(mountPrefixedPath));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    // A direct mount's bytes are disk's, as read takes them, at most its size limit.
    if (mount.direct) return this.bytesFromDisk(mount, relativePath, mountPrefixedPath, mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
    const store = this.getStore();
    return this.withMount(mount, async () => {
      const { report, undecided } = await this.ensureSynced(mount, relativePath);
      const entry = store.treeGet(mount.treeStateId, relativePath);
      if (!entry) {
        return { error: undecided !== null ? this.notCheckedYet(mountPrefixedPath, undecided) : this.notInWorkspace(mountPrefixedPath, report, mount, `File not found: ${mountPrefixedPath}`) };
      }
      const contents = await this.contentsOf(mount, relativePath, mountPrefixedPath, entry);
      if ('lost' in contents) return { error: nothingToRead(contents.lost) };
      return { data: contents.bytes };
    });
  }

  /**
   * Read a file's raw bytes straight from the mount's filesystem, bypassing
   * the Chronicle tree.
   *
   * For material that is *passing through* rather than being kept: an upload,
   * a render being shipped somewhere, a file handed to a service. The store
   * path (`readBinary`) is append-only, so reading through it means every
   * byte is retained forever and the mount's `maxFileSize` guard applies —
   * correct for the resident's memory, wrong for egress, where paying a
   * permanent cost to send something once is the wrong trade.
   *
   * Same mount boundary and traversal guard as every other path here: only
   * declared mounts, nothing above their root, and the file reached as
   * readFileFromDisk reaches it (openContainedFile), so the mount's
   * `followSymlinks` holds for the file and the directories on its way, and
   * what it reaches stays canonically inside the mount. Deliberately does NOT
   * sync, register, or hash anything — it reads and returns.
   *
   * `maxBytes` refuses a larger file as "File too large", having loaded at
   * most `maxBytes` bytes and one more: the reads decide where the file ends,
   * not the size fstat gave at the open, so the bound holds for a file that
   * grows while it's read.
   */
  async readBinaryFromDisk(
    mountPrefixedPath: string,
    opts: { maxBytes?: number } = {},
  ): Promise<{ data: Buffer; absolutePath: string } | { error: string }> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath, path: mountPrefixedPath } = await this.parseFilePath(mountPrefixedPath));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const read = await this.bytesFromDisk(mount, relativePath, mountPrefixedPath, opts.maxBytes);
    return 'error' in read ? read : { data: read.data, absolutePath: resolve(mount.config.path, relativePath) };
  }

  /** A file's bytes as readBinaryFromDisk reads them, once its path is parsed. */
  private async bytesFromDisk(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxBytes: number | undefined,
  ): Promise<{ data: Buffer } | { error: string }> {
    let tooLarge: string | undefined;
    try {
      const { handle, fileStat } = await this.openContainedFile(mount, relativePath, mountPrefixedPath, (fileStat) => {
        if (maxBytes !== undefined && fileStat.size > maxBytes) {
          tooLarge = `File too large: ${fileStat.size} > ${maxBytes} bytes`;
          throw new Error(tooLarge);
        }
      });
      try {
        if (maxBytes === undefined) return { data: await handle.readFile() };
        // No more than maxBytes is loaded: a file grown past it since the
        // fstat above is refused here, as one already over it was there. Its
        // size is an fstat's after the read, and at least one more than the
        // bytes kept, so the refusal's size is always past maxBytes.
        const { bytes, more } = await readPrefix(handle, maxBytes, fileStat.size);
        if (more) return { error: `File too large: ${Math.max((await handle.stat()).size, bytes.length + 1)} > ${maxBytes} bytes` };
        return { data: bytes };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (tooLarge !== undefined) return { error: tooLarge };
      // A directory, or a file that isn't regular (the reader's refusal of
      // one carries no errno), and a missing file keep this reader's words.
      if (error instanceof WorkspaceReadError && (error.code === 'directory' || (error.code === 'not_found' && error.errno === undefined))) {
        return { error: `Not a file: ${mountPrefixedPath}` };
      }
      if (error instanceof WorkspaceReadError && error.code === 'not_found' && (error.errno === 'ENOENT' || error.errno === 'ENOTDIR')) {
        return { error: `File not found on disk: ${mountPrefixedPath}` };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The directories of the mounts nested inside a mount, mount-relative. */
  private othersOf(mountName: string): string[] {
    return (this.otherMounts.get(mountName) ?? []).flatMap((o) => o.fromRoots.map((s) => s.dir));
  }

  /**
   * Which mounts are nested in which, read afresh at each start. A mount is
   * nested in another where its configured path lies beneath the other's
   * root, as configured or as it lies on disk, whatever links the path
   * reaches that root through, or where its real root lies beneath the
   * other's. Each root, and each directory above a configured path, is
   * placed by realBeneath, awaited, so a root on a share that stops
   * answering holds this start and not the process, and a root moved while
   * the module was stopped is placed where it is now. A mount whose real
   * root is the other's own, or holds it, is nested by its configured path
   * alone, with no real root, since through it it would claim the other's
   * every path.
   *
   * Each way it lies there is a spelling of its directory (`fromRoots`).
   * Each mount's real root comes back beside the nesting (`reals`), for what
   * start reads there, and each directory above each configured path with
   * where it lies on disk (`above`), for a direct mount whose root moves
   * (movedNesting).
   */
  private async readNesting(): Promise<{ nesting: Map<string, NestedMountEntry[]>; reals: Map<string, string>; above: Map<string, Array<{ dir: string; real: string }>> }> {
    const reals = new Map<string, string>();
    // Each directory above a mount's configured path, with where it lies on
    // disk, so a path that reaches another mount's root through a link, as
    // one under macOS's /var reaches /private/var, is still read beneath it.
    const above = new Map<string, Array<{ dir: string; real: string }>>();
    for (const mount of this.config.mounts) {
      const given = resolve(mount.path);
      reals.set(mount.name, await realBeneath(given));
      const dirs: Array<{ dir: string; real: string }> = [];
      for (const dir of ancestorsOf(given)) dirs.push({ dir, real: await realBeneath(dir) });
      above.set(mount.name, dirs);
    }
    const nesting = new Map<string, NestedMountEntry[]>();
    for (const outer of this.config.mounts) {
      const outerPath = resolve(outer.path);
      const outerReal = reals.get(outer.name)!;
      for (const inner of this.config.mounts) {
        if (outer === inner) continue;
        const real = reals.get(inner.name)!;
        const at = placementOf(outerPath, outerReal, resolve(inner.path), real, above.get(inner.name)!);
        if (at === undefined) continue;
        const { configured, fromRoots, claims } = at;
        nesting.set(outer.name, [...(nesting.get(outer.name) ?? []), { name: inner.name, ...(claims ? { real } : {}), fromRoots }]);
        const placed = fromRoots.filter((s) => s.dir !== configured);
        if (placed.length > 0) {
          const at = (sure: boolean) => placed.filter((s) => !s.guessed === sure).map((s) => `${s.dir}/`).join(' and ');
          const where = [at(true) && `where it lies on disk, at ${at(true)}`, at(false) && `where it may lie on disk, at ${at(false)}`].filter(Boolean).join(', and ');
          console.warn(`[workspace] Mount "${outer.name}" contains mount "${inner.name}" ${where} — passing over it as another mount's directory`);
        }
      }
    }
    return { nesting, reals, above };
  }

  /**
   * The mounts nested in `mountName`, by directory, name, real root where it
   * has one, and include (MountView's `nested`).
   */
  private nestedOf(mountName: string): NestedMount[] {
    return (this.otherMounts.get(mountName) ?? []).flatMap((o) =>
      o.fromRoots.map((s) => ({ dir: s.dir, ...(s.guessed ? { guessed: s.guessed } : {}), name: o.name, real: o.real, include: this.mounts.get(o.name)?.config.include })));
  }

  /**
   * The mounts nested in `mount` as a call of it that resolved its root to
   * `rootReal` sees them: movedNesting where that differs from where the
   * last start placed it, the start's placement (nestedOf) otherwise.
   */
  private async nestedFor(mount: MountState, rootReal: string): Promise<NestedMount[]> {
    return (await this.movedNesting(mount, rootReal)) ?? this.nestedOf(mount.config.name);
  }

  /**
   * The mounts nested in a direct mount whose root a check resolved to
   * `rootReal`, where that's elsewhere than the last start placed it, as when
   * a link it's configured through is repointed; null where the start's
   * placement holds, or where nothing is at `rootReal`: there the parse's
   * checks keep the start's placement, and a read says the root is gone. A
   * direct mount reads beneath whatever directory is at its root, so a check
   * judges which mount a path is by the root it resolved. A tool's parse
   * resolves it once, and its respelling and its checks of the path it's
   * given (parseFilePath's, refusesAsOutside, grep's) read disk beneath that
   * root and judge by the nesting there. A read and a walk each resolve it
   * for themselves, and judge the include and the nesting again beneath it.
   * So a root repointed during a call can change which answer or refusal a
   * path gets, but nothing a read or a walk serves is a file the include
   * leaves out, nothing a walk serves lies in another mount's directory as
   * its own nesting places it, and nothing a read serves lies in the
   * directory of a mount its own nesting claims by real root. Whoever writes
   * the disk can race a read in two ways, as a rename during a call can on
   * any mount. On a disk that folds names, a read judges the include by the
   * path as its parse spelled it, so a root repointed between the two can
   * have it serve a file the new root spells otherwise (sameLevels). And a
   * mount nested by its directories alone, since its real root holds this
   * one, is judged by the parse's nesting, so a root repointed between a
   * read's parse and its open can have it serve a path in that mount's
   * directory, and one repointed between a direct write's parse and its
   * staging can have the write land there. Each mount is placed as a start
   * places it (placementOf), from where its real root and the directories
   * above its configured path lie on
   * disk. For a mount configured at this mount's own path or beneath it,
   * that's where they lie now: beneath `rootReal` where they lie beneath this
   * mount's path, and the directories above this mount's path as resolving
   * that path finds them. For any other mount, it's where the last start
   * found them. Each carries its own include, as nestedOf gives it. It
   * resolves nothing but the directories on this mount's own configured path
   * and those beneath its root, so a share elsewhere that doesn't answer
   * holds only its own calls, unless such a directory is a link into it,
   * where that mount's files lie. What it leaves to the next start: a mount
   * configured elsewhere whose own root has moved since, as when a link on
   * its configured path is repointed, this mount's own reached through
   * another link among them, that mount's spellings through other links, and
   * the other mounts' own placements, so a direct root moved into another
   * mount's directory is that mount's too, as a nested mount's root moved
   * while running stays placed.
   */
  private async movedNesting(mount: MountState, rootReal: string): Promise<NestedMount[] | null> {
    // One start's placements, whatever a start in the meantime sets.
    const { placedRoots, placedAbove } = this;
    const placed = placedRoots.get(mount.config.name);
    if (!mount.direct || placed === undefined || placed === rootReal) return null;
    const there = await stat(rootReal).then(() => true, (err: unknown) => {
      const code = errnoOf(err);
      return code !== 'ENOENT' && code !== 'ENOTDIR';
    });
    if (!there) return null;
    const outerPath = resolve(mount.config.path);
    const nested: NestedMount[] = [];
    // The directories above this mount's own path, as they lie on disk now,
    // resolved as resolving the path itself does.
    let ownAbove: Array<{ dir: string; real: string }> | undefined;
    const aboveOwn = async () => ownAbove ??= await Promise.all(ancestorsOf(outerPath).map(async (dir) => ({ dir, real: await realBeneath(dir) })));
    for (const inner of this.config.mounts) {
      if (inner.name === mount.config.name) continue;
      const innerPath = resolve(inner.path);
      const configured = nestedDir(outerPath, innerPath);
      let real: string | undefined;
      let above: ReadonlyArray<{ dir: string; real: string }>;
      if (configured !== undefined || innerPath === outerPath) {
        // A mount configured on this mount's own path, or beneath it, lies
        // where that path now leads: its real root, and each directory above
        // it, resolved now, beneath this root where they lie beneath it.
        const segments = configured?.split('/') ?? [];
        real = await realBeneath(join(rootReal, ...segments));
        const beneath: Array<{ dir: string; real: string }> = [];
        for (let i = segments.length - 1; i >= 1; i--) {
          beneath.push({ dir: join(outerPath, ...segments.slice(0, i)), real: await realBeneath(join(rootReal, ...segments.slice(0, i))) });
        }
        // This mount's own path, which is the root, would add only the
        // configured directory, which placementOf adds anyway.
        above = [...beneath, ...await aboveOwn()];
      } else {
        // Any other mount lies where the last start found it and the
        // directories above its path. One leading here only since, as
        // through this mount's own link, waits for the next start.
        real = placedRoots.get(inner.name);
        if (real === undefined) continue;
        above = placedAbove.get(inner.name) ?? [];
      }
      const at = placementOf(outerPath, rootReal, innerPath, real, above);
      if (at === undefined) continue;
      const include = this.mounts.get(inner.name)?.config.include;
      for (const s of at.fromRoots) {
        nested.push({ dir: s.dir, ...(s.guessed ? { guessed: s.guessed } : {}), name: inner.name, ...(at.claims ? { real } : {}), include });
      }
    }
    return nested;
  }

  /**
   * The innermost mount nested in `mountName` whose directory holds a path
   * of that mount, judged lexically where the path lands (`.`, `..` and
   * repeated separators resolved, as for the traversal guard; a link of the
   * outer mount isn't followed), with the path to use there; undefined when
   * no nested mount's directory holds it.
   */
  private holderOf(mountName: string, relativePath: string, moved: NestedMount[] | null = null): { name: string; use: string; guess?: NestedGuess } | undefined {
    const mount = this.mounts.get(mountName);
    if (!mount) return undefined;
    const root = resolve(mount.config.path);
    const resolved = resolve(root, relativePath);
    if (!isContainedPath(root, resolved)) return undefined;
    const path = resolved === root ? '' : relative(root, resolved).split(sep).join('/');
    // A direct mount whose root a call found moved is judged by that call's
    // nesting (movedNesting), each directory beneath its configured path.
    const holder = nestedHolder(path, moved ?? this.nestedOf(mountName));
    if (!holder) return undefined;
    const rest = restBeneath(path, holder);
    const guess = nestedGuess(mountName, path.split('/'), holder);
    return { name: holder.name, use: rest ? `${holder.name}/${rest}` : holder.name, ...(guess === undefined ? {} : { guess }) };
  }

  /**
   * Why a mount leaves a path in a nested mount's directory, naming that
   * mount and the path to use: for a sync or a push, which of them leaves
   * it; for a listing, whose the path is.
   */
  private otherMountNote(mountName: string, relativePath: string, by: 'sync' | 'push' | 'list', moved: NestedMount[] | null = null): string {
    const holder = this.holderOf(mountName, relativePath, moved);
    const what = by === 'sync' ? ', which no sync of this mount takes in' : by === 'push' ? ', which no push of this mount writes' : '';
    return holder
      ? `it ${holder.guess === undefined ? 'lies' : 'may lie'} in mount "${holder.name}", nested in this one${what}: ${nestedStep(holder)}`
      : `it lies in another mount's directory${what}`;
  }

  /**
   * parsePath for the file operations (read, write, edit, delete, and the
   * module's binary and disk reads and writes), refused where the mount
   * doesn't hold the path. A path in another mount's directory nested in
   * this one is that mount's: this mount's passes don't observe it and its
   * pushes don't write it, so the refusal names the innermost mount that
   * holds it and the path to use there. A path the mount's include doesn't
   * cover is outside the mount, whatever disk or the workspace's history has
   * there. A directory is checked the same way, since a path can be a
   * directory on one side and a file on the other.
   */
  private async parseFilePath(path: string): Promise<{ mount: MountState; relativePath: string; path: string }> {
    const spelled = await this.parsePath(path);
    // Both checks judge by the nesting the parse found, and the second reads
    // disk beneath the root the parse resolved.
    const { mount, root, moved } = spelled;
    const parsed = this.refuseNotHeld(spelled, path, moved);
    // A path can also reach a nested mount's directory, or a file this
    // mount's own include leaves out, through a symlink on its way. No push
    // of this mount writes it there and no read reads it, so it's refused
    // here, before anything is stored, and the checks where disk is acted on
    // refuse it again.
    const refusal = await this.landingRefusal(mount, parsed.relativePath, parsed.path, moved ?? this.nestedOf(mount.config.name), root);
    if (refusal) throw refusal;
    return parsed;
  }

  /**
   * The refusal for a path of `mount` that reaches a nested mount's directory
   * through a symlink on its way (nestedAtReal), or a file this mount's own
   * include leaves out (coversLanding), or, on a mount that follows links
   * with an include, one realpath can't resolve, or null where it doesn't.
   * On a mount that doesn't follow the link, the refusal is the link's own
   * (linkWords), as the readers and pushes give it. On one that does, it
   * names the nested mount only where the place is that mount's
   * (namesNestedPlace); anywhere else the place is no mount's, so the path
   * leaves this one, in the disk readers' words, as it does where it lands
   * on a file this mount's include leaves out. A mount with nothing nested,
   * and without both an include and links followed, has nothing to find, so
   * it pays nothing. The caller gives the nesting and the root to judge by
   * (`nested`, `root`). A direct mount's file operation gives those its
   * parse found, so where the path lands, and any link on its way, is judged
   * beneath the root that parse resolved; any other caller gives the start's
   * nesting and the configured path.
   */
  private async landingRefusal(mount: MountState, relativePath: string, path: string, nested: readonly NestedMount[], root: string): Promise<Error | null> {
    const judged = mount.config.followSymlinks === true && mount.config.include !== undefined;
    if (nested.length === 0 && !judged) return null;
    const unresolved: { code?: string } = {};
    const real = await realBeneath(resolve(root, relativePath), 0, unresolved);
    // Where realpath can't resolve the path, as for a loop or a directory
    // this process can't search, where it lands can't be judged, and a
    // promise about content fails closed: the path is refused, by every file
    // operation, in the words a disk read gives a path it can't resolve,
    // whatever the place realpath stopped short of would say.
    if (judged && unresolved.code !== undefined) return new WorkspaceReadError('not_found', `Unable to resolve file: ${path}`, 'realpath', unresolved.code);
    let holder = await nestedAtReal(real, nested);
    if (holder?.guess === null) holder = await nestedAtReal(real, nested, { name: mount.config.name, rootReal: await realBeneath(resolve(mount.config.path)) });
    if (!holder) {
      if (!judged) return null;
      const rootReal = await realBeneath(root);
      if (!isContainedPath(rootReal, real) || await stat(real).then((info) => info.isDirectory(), () => false)) return null;
      return await coversLanding({ include: mount.config.include }, rootReal, real, relativePath) ? null : new WorkspaceReadError('escape', `Symlink escape detected: ${path}`, 'realpath');
    }
    if (mount.config.followSymlinks !== true) {
      const rootReal = await realBeneath(root);
      const found = await linkOnTheWay({ root: rootReal, followSymlinks: false }, relativePath);
      if (found !== null) return await linkReadError(mount, found, path, relativePath, nested, rootReal);
    }
    // On a mount with an include, the path to use there names each directory
    // on the place's way as that mount's, so a place beneath anything else
    // there, such as a file the include leaves out, isn't named; one beneath
    // a directory not there yet is.
    const onItsWay = !holder.judgedByInclude
      || await stat(dirname(real)).then((info) => info.isDirectory(), (err: unknown) => errnoOf(err) === 'ENOENT');
    const directory = holder.judgedByInclude && await stat(real).then((info) => info.isDirectory(), () => false);
    if (!onItsWay || !holder.names(directory)) return new WorkspaceReadError('escape', `Symlink escape detected: ${path}`, 'realpath');
    return new NestedMountError(path, mount.config.name, holder, 'leads into');
  }

  /**
   * A parsed path, refused where the mount doesn't hold it: in a nested
   * mount's directory first, naming the mount that holds it, then outside
   * the mount's include. Each is judged on the path as the caller parsed it:
   * as disk spells it for parseFilePath, as given for resolveAbsolutePath,
   * which is synchronous. The include's refusal shows the path as given
   * (`given`), since it answers the path the caller asked about.
   */
  private refuseNotHeld<P extends { mount: MountState; relativePath: string; path: string }>(parsed: P, given: string, moved: NestedMount[] | null = null): P {
    const holder = this.holderOf(parsed.mount.config.name, parsed.relativePath, moved);
    if (holder) throw new NestedMountError(parsed.path, parsed.mount.config.name, holder);
    if (!insideMount(parsed.relativePath, parsed.mount.config.include)) {
      throw new OutsideIncludeError(given, parsed.mount.config);
    }
    return parsed;
  }

  /**
   * Whether a mount-relative path names a file, as grep decides what a path
   * it's given names: for a path the include covers, a file in the
   * workspace's history, or anything but a directory on disk. Grep takes it
   * as a directory only when neither side has a file there, and filters what
   * it finds beneath it by the mount's include. A path the include doesn't
   * cover names no file of the mount's, whatever disk or history holds
   * there, so one refusesAsOutside lets through is a directory. A direct
   * mount has no history: what a run of it as 'chronicle' left in the store
   * isn't its own, so disk alone decides. Disk is read beneath `root`: a
   * direct mount's is the root its parse resolved, a store-backed mount's
   * its configured path.
   */
  private async namesFile(mount: MountState, relativePath: string, root: string): Promise<boolean> {
    return relativePath !== '' && insideMount(relativePath, mount.config.include) && (
      (!mount.direct && this.getStore().treeGet(mount.treeStateId, relativePath) !== null) ||
      await lstat(join(root, relativePath)).then((s) => !s.isDirectory(), () => false)
    );
  }

  /**
   * Whether sync, materialize, grep, glob or ls refuses a path it's given as
   * outside the mount's include. A path the include doesn't cover is a scope
   * exactly where a listing names a directory: where disk has a directory
   * reached from the mount's root through directories, with no link among
   * them, or the workspace's history holds an entry beneath it that's the
   * mount's own to list (withinIncludes). The one exception is a directory
   * the ignore list covers, which a listing passes over and which is still a
   * scope when it's named, since a sync that names it takes in what's there
   * (#276). Anything else is refused, a file at the path included, which no
   * scope tool takes up. The walk descends no link it meets. Where covered
   * history makes a name a scope and disk has since put a link there, a
   * mount that doesn't follow symlinks refuses the link, as it refuses any
   * link on a path's way, and on a mount that does, a pass of the scope
   * follows the link, and its answer shows whether the link leads out of the
   * mount. A
   * path in another mount's directory nested in this one is that mount's,
   * whatever this mount's include says, so it isn't refused here: each tool
   * names the mount that holds it, as the file operations do. A direct mount
   * has no history, as namesFile says, and is judged beneath the root its
   * parse resolved (`root`), by the nesting there (`moved`, movedNesting).
   */
  private async refusesAsOutside(mount: MountState, relativePath: string, moved: NestedMount[] | null, root: string): Promise<boolean> {
    if (this.holderOf(mount.config.name, relativePath, moved)) return false;
    if (insideMount(relativePath, mount.config.include)) return false;
    const own = { include: mount.config.include, nested: this.nestedOf(mount.config.name) };
    if (!mount.direct && this.getStore().treeList(mount.treeStateId, relativePath + '/')
      .some((entry) => withinIncludes(own, entry.path))) return false;
    // A directory, and each directory above it to the mount's root, as the
    // walk reaches it: through no link, since the walk descends none.
    const segments = relativePath.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const entry = await lstat(join(root, ...segments.slice(0, i))).catch(() => null);
      if (!entry?.isDirectory()) return true;
    }
    return false;
  }

  /**
   * Parse a mount-prefixed path into its mount and mount-relative path, as
   * disk spells it (diskSpelling). `path` is the mount-prefixed path in that
   * spelling where it differs from the one spelling, and otherwise the path
   * as the caller gave it. The path is read in its one spelling first
   * (parsePathAsGiven), so the respelling only ever sees a path with no
   * empty, `.` or `..` segment and no separator before its first. On a disk
   * that folds names, a path spelled otherwise reaches disk's file, so every
   * tool takes it by disk's name: one name per file, and the names its
   * answers give are disk's, except that a path that names a workspace entry
   * exactly, or does once its directories take disk's spelling, keeps the
   * entry's spelling, and what lies past a link on the way keeps the
   * caller's, since the step reads nothing past a link. A path the workspace
   * records an intent at, such as a deletion disk hasn't been given yet,
   * counts as an entry here, so the calls that settle it reach it. The
   * workspace's entries (entriesOf) stand in for disk where it has nothing
   * yet, so a draft has one name too. Neither applies to a path that disk's
   * spelling puts in a nested mount's directory. A direct mount holds no
   * entries, so its paths take disk's spelling alone. Past a nested mount's
   * directory the path stays as given, since what lies there is that mount's
   * to name. Every answer shows `path`, a name the include leaves out
   * included, since how disk spells a name the caller gave is no content of
   * that file, except the include's own refusal, which shows the path
   * exactly as given (refuseNotHeld), since it answers the path asked about.
   * A handler that must read something at the moment it's asked, as
   * handleSync reads the branch a path sync adopts on, reads it before
   * calling this, since this awaits disk. The entries are read when the step
   * needs them, some after those awaits, from the branch current then.
   */
  private async parsePath(path: string): Promise<ParsedPath> {
    const given = this.parsePathAsGiven(path);
    // A direct mount's root is resolved once here, so the respelling and the
    // checks of the path that follow read disk beneath one root and judge by
    // the nesting there (movedNesting).
    const configured = resolve(given.mount.config.path);
    const root = given.mount.direct ? await realpath(configured).catch(() => configured) : configured;
    const moved = given.mount.direct ? await this.movedNesting(given.mount, root) : null;
    const spelled = await diskSpelling(root, given.relativePath, given.mount.direct ? undefined : this.entriesOf(given.mount));
    // Past a nested mount's directory the path stays as given: what lies
    // there is that mount's, whose own include decides what a tool may name,
    // so this mount doesn't respell it.
    // The directory itself takes disk's spelling, as a listing names it.
    // The respelling keeps each segment's place, so the given path's rest
    // follows the directory's segments.
    const depth = this.nestedDepth(given.mount.config.name, spelled, moved);
    const relativePath = depth === undefined ? spelled
      : [...spelled.split('/').slice(0, depth), ...given.relativePath.split('/').slice(depth)].join('/');
    return {
      mount: given.mount,
      relativePath,
      path: relativePath === given.relativePath ? path : `${given.mount.config.name}/${relativePath}`,
      root,
      moved,
    };
  }

  /**
   * How many segments the innermost nested mount's directory that holds
   * `relativePath` has, or, for a direct mount whose root has moved, in the
   * nesting there (`moved`);
   * undefined when no nested mount's directory holds it.
   */
  private nestedDepth(mountName: string, relativePath: string, moved: NestedMount[] | null = null): number | undefined {
    return nestedHolder(relativePath, moved ?? this.nestedOf(mountName))?.dir.split('/').length;
  }

  /**
   * A mount's entries on the current branch, and the paths it records an
   * intent at there, as diskSpelling reads them when it does, whether its
   * root folds case as the last start read it (false before the first), and
   * which nested mount's directory holds a path, by holderOf, as the
   * nested-mount checks read it. diskSpelling keeps disk's spelling of a
   * path that lies in a nested mount's directory as disk spells it, so the
   * checks refuse at least what they would refuse without the entries.
   */
  private entriesOf(mount: MountState): WorkspaceEntries {
    const store = this.getStore();
    const intents = this.intents.get(mount.config.name)!;
    return {
      // An intent recorded at a path, such as a deletion disk hasn't been
      // given yet or a conflict, is the workspace's own name for the file
      // there, as an entry is, so the calls that settle it reach it.
      has: (path) => store.treeGet(mount.treeStateId, path) !== null || store.treeGet(intents.treeStateId, path) !== null,
      // Only an entry this mount's include covers spells a draft's path
      // (insideMount): not a key no spelling names, such as `c/` or `a//b.txt`
      // from an earlier version, nor one the include leaves out, which would
      // respell a covered draft into a name the include leaves out.
      under: (prefix) => store.treeList(mount.treeStateId, prefix).map((entry) => entry.path).filter((path) => insideMount(path, mount.config.include)),
      holder: (path) => this.holderOf(mount.config.name, path)?.name,
      rootFoldsCase: this.rootFoldsCase.get(mount.config.name) ?? false,
    };
  }

  /**
   * Parse a mount-prefixed path into its mount and the one mount-relative
   * path every later step reads, as given, before disk's spelling
   * (parsePath): `/` between segments (`\` read as `/` where it's the
   * platform's separator), with no empty or `.` segment and no trailing `/`,
   * and '' for the mount's root. So the traversal guard here and every later
   * step judge one spelling of the path, which parsePath then respells name
   * by name as disk lists them. A `..` segment takes back the segment before
   * it, before anything looks the path up, so a mount's include judges the
   * path every tool acts on, and one with nothing left to take back climbs
   * above the mount's root and is refused, whatever it reaches afterwards. A
   * separator straight after the mount's name would make the rest an
   * absolute path, so that is refused too, and every reader that takes a
   * path refuses it here, a disk reader included.
   */
  private parsePathAsGiven(path: string): { mount: MountState; relativePath: string } {
    // A file's name on disk is UTF-8, which can't hold a lone surrogate: the
    // store would keep one name and disk another.
    if (LONE_SURROGATE.test(path)) {
      throw new PathRefusal('traversal', `${JSON.stringify(path)} holds a lone UTF-16 surrogate, which UTF-8 can't store, so no file on disk can have that name. Give the name without it.`);
    }
    const slashIdx = path.indexOf('/');
    const mountName = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const given = slashIdx >= 0 ? path.slice(slashIdx + 1) : '';

    const mount = this.mounts.get(mountName);
    if (!mount) throw new PathRefusal('unknown_mount', this.noSuchMount(path, mountName));
    const segments = pathSegments(given);
    if (given.startsWith('/') || (sep === '\\' && given.startsWith('\\'))) {
      throw new PathRefusal('traversal', `${JSON.stringify(path)} has a separator right after mount "${mountName}", which makes it an absolute path: give it from the mount's root, as "${mountName}/<path>".`);
    }
    const kept: string[] = [];
    for (const segment of segments) {
      if (segment !== '..') kept.push(segment);
      else if (kept.pop() === undefined) {
        throw new PathRefusal('traversal', `${JSON.stringify(path)} climbs above the root of mount "${mountName}" with "..", and a path can't leave its mount. `
          + `Name a file from its own mount's name; ${this.mountList()}.`);
      }
    }
    const relativePath = kept.join('/');

    // Path traversal guard (CWE-22), on the path every later step reads: on
    // Windows a first segment such as `C:` names another drive. Containment
    // must compare with the PLATFORM separator (isContainedPath): resolve()
    // emits backslashes on Windows, so a '/'-suffixed root never prefix-matches
    // there and every in-mount path was rejected as traversal. Against the
    // resolved root, so a root configured with a trailing separator, or
    // relative, contains its own paths, the root included.
    const root = resolve(mount.config.path);
    const resolved = resolve(root, relativePath);
    if (!isContainedPath(root, resolved)) {
      throw new PathRefusal('traversal', `${JSON.stringify(path)} resolves outside mount "${mountName}", as a drive or root named in it does: give the path from the mount's root, as "${mountName}/<path>".`);
    }
    return { mount, relativePath };
  }

  private writableNames(): string[] {
    return [...this.mounts.values()].filter((m) => writeRefusal(m) === null).map((m) => m.config.name);
  }

  private mountList(): string {
    const names = [...this.mounts.keys()];
    return names.length === 0 ? 'this workspace has no mounts' : `the mounts are ${listed(names.map((name) => JSON.stringify(name)))}`;
  }

  private emptyPathField(mount: string | undefined, bare: string): string {
    const empty = '"path" is "", which names no file or directory.';
    if (mount === undefined) return `${empty} Leaving "path" out ${bare}.`;
    if (mount === '') return `${empty} "mount" is "" too; leaving both out ${bare}.`;
    if (this.mounts.has(mount)) return `${empty} Leaving "path" out covers mount ${JSON.stringify(mount)}.`;
    return `${empty} "mount" is ${JSON.stringify(mount)}, which is no mount's name; ${this.mountList()}. Leaving both out ${bare}.`;
  }

  private noSuchMountField(given: string, bare: string): string {
    const [close] = closestNames(given, [...this.mounts.keys()], 1);
    return `"mount" is ${JSON.stringify(given)}, which is no mount's name; ${this.mountList()}.`
      + (close !== undefined ? ` Did you mean ${JSON.stringify(close)}?` : '')
      + ` Leaving "mount" out ${bare}.`;
  }

  private noSuchMount(path: string, mountName: string): string {
    const names = [...this.mounts.keys()];
    const rest = path.slice(mountName.length);
    const unslashed = path.replace(/^[/\\]+/, '');
    if (unslashed !== path && names.some((name) => unslashed === name || unslashed.startsWith(`${name}/`))) {
      return `${JSON.stringify(path)} starts with "/", and a path starts with its mount's name: give ${JSON.stringify(unslashed)}.`;
    }
    if (mountName === '') return `${JSON.stringify(path)} doesn't start with a mount's name, and a path starts with its mount's name; ${this.mountList()}.`;
    const [close] = closestNames(mountName, names, 1);
    const said = rest === '' ? `${JSON.stringify(path)} is no mount's name; ${this.mountList()}.`
      : `${JSON.stringify(path)} starts with ${JSON.stringify(mountName)}, which is no mount's name, and a path starts with its mount's name; ${this.mountList()}.`;
    return said + (close !== undefined ? ` Did you mean ${JSON.stringify(close + rest)}?` : '');
  }

  /**
   * Whether the module takes work: stop hasn't finished. Work admitted while
   * stop drains still runs; once stop has saved the pins and watermarks,
   * nothing more changes them, so it takes nothing until it starts again. A
   * call before start is taken, as it always was (a generated file's read
   * needs no store at all): in the host's order, start runs first, and
   * initStore applies the saved pins.
   */
  private running(): boolean {
    return !this.stopped;
  }

  private getStore(): JsStore {
    if (!this.store) throw new Error('WorkspaceModule: store not initialized. Call initStore() first.');
    return this.store;
  }

  private validateImageBytes(
    bytes: Buffer,
    mountPrefixedPath: string,
    maxSize: number,
  ): { bytes: Buffer; mimeType: SupportedImageMimeType } {
    if (bytes.byteLength === 0) {
      throw emptyImage(mountPrefixedPath);
    }
    if (bytes.byteLength > maxSize) throw imageTooLarge(maxSize, mountPrefixedPath, bytes.byteLength.toLocaleString('en-US'));
    return {
      bytes,
      mimeType: detectImageMimeType(bytes, mountPrefixedPath),
    };
  }

  private async readImageFromTree(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxSize: number,
  ): Promise<{ bytes: Buffer; mimeType: SupportedImageMimeType } | { lost: LostContents } | null> {
    const entry = this.getStore().treeGet(mount.treeStateId, relativePath);
    if (!entry) return null;
    const contents = await this.contentsOf(mount, relativePath, mountPrefixedPath, entry);
    if ('lost' in contents) return contents;
    return this.validateImageBytes(contents.bytes, mountPrefixedPath, maxSize);
  }

  /**
   * The mount root a disk read reads beneath: resolved, then checked as
   * observation checks it (checkRoot), so the read and the evidence agree on
   * which directory the mount is. Once the workspace has recorded the root's
   * identity, a root that resolves to any other directory is refused, in
   * ROOT_REPLACED's words, or ROOT_ON_ANOTHER_DEVICE's where only its device
   * differs and birth times can't tell; with none recorded yet, it need only
   * be a directory there. A refusal where no directory is at the root's path
   * carries the errno that gives (rootAbsence: ENOENT when nothing is there
   * and ENOTDIR when something else is, which a caller can read as no file,
   * or the errno the root's stat failed with otherwise, such as EACCES). A
   * root whose realpath fails carries realpath's errno, and one that is
   * another directory carries none. The identity is rootIdentityForRead's,
   * which answers while the evidence awaits reopening; where even it can't
   * be read, as when the evidence was never read back whole, the read is
   * refused before its root is resolved, with an errno only where no
   * directory is at the root's path.
   * A direct mount's root is checked against no identity, and its read reads
   * no evidence: it promises what's at its root now (diskView).
   */
  private async readRoot(mount: MountState): Promise<{ real: string; dir: CheckedDir }> {
    const name = mount.config.name;
    const root = resolve(mount.config.path);
    let rootIdentity: MountView['rootIdentity'];
    if (!mount.direct) {
      try {
        rootIdentity = this.agreementOrThrow().rootIdentityForRead(name);
      } catch (err) {
        // The evidence can't be read back, so neither can the check be made.
        // Where no directory is at the root's path, its errno still says so.
        throw new RootUnavailable(name, err instanceof Error ? err.message : String(err), 'root', await rootAbsence(root), err instanceof Refusal ? err : undefined);
      }
    }
    let real: string;
    try {
      real = await realpath(root);
    } catch (err) {
      throw new RootUnavailable(name, null, 'realpath_root', errnoOf(err));
    }
    const checked = await checkRoot(this.viewOf(mount, rootIdentity), real);
    if ('dir' in checked) return { real, dir: checked.dir };
    // Another directory is no absence. For any other refusal, what is at the
    // root's path now decides: nothing, something that isn't a directory, or
    // a directory the path has come to name since it was resolved (no errno).
    const errno = checked.reason === ROOT_REPLACED ? undefined : await rootAbsence(root);
    throw new RootUnavailable(name, checked.reason, 'root', errno);
  }

  /**
   * The refusal for a root that stopped being the directory a read checked,
   * with the code and errno readRoot gives what is at its path now (its stage
   * and words are this check's): gone, or not a directory, with ENOENT or
   * ENOTDIR, so a caller reads a root gone mid-read as one gone before it; or
   * another directory, with none. A direct mount reads whatever directory is
   * at its root (MountConfig.backend), so for it, another directory there is
   * one the next read reads.
   */
  private async rootMoved(mount: MountState): Promise<WorkspaceReadError> {
    const errno = await rootAbsence(resolve(mount.config.path));
    const reason = errno !== undefined ? ROOT_UNAVAILABLE : mount.direct ? DIRECT_ROOT_REPLACED : ROOT_REPLACED;
    return new RootUnavailable(mount.config.name, reason, 'root', errno);
  }

  /**
   * Open a mount-relative file for reading with the mount boundary enforced on
   * the *filesystem*, not just the path string:
   *
   * 0. Check the root (readRoot) before anything beneath it: under a root
   *    that isn't the mount's directory, no path says anything about the
   *    mount's files, an absence included.
   * 1. On a mount that does not `followSymlinks`, refuse a path with a symlink
   *    among the directories on its way beneath the mount's root, wherever it
   *    leads (linkOnTheWay), before anything resolves it: as `escape` for a
   *    link leading outside the mount, as `other_mount` for one into a nested
   *    mount's directory where its refusal names that mount, and as
   *    `parent_symlink` for any other.
   * 2. `lstat` the lexical path — refuse directories; refuse a final-component
   *    symlink when the mount does not `followSymlinks`; refuse anything else
   *    that isn't a regular file, such as a FIFO, without opening it.
   * 3. Open with `O_NOFOLLOW` where the platform has it (POSIX) so the refusal
   *    holds against a symlink swapped in between lstat and open; where it
   *    doesn't (Windows), re-`lstat` after opening instead. `O_NONBLOCK`, so a
   *    FIFO swapped in meanwhile doesn't wait for a writer.
   * 4. `realpath` the opened path. On a mount that does not `followSymlinks`,
   *    refuse it again for a symlinked directory on its way, which catches one
   *    swapped in since step 1 (linkRefusal). Then require canonical
   *    containment in the root step 0 resolved — this is what catches an
   *    *intermediate* symlinked directory escaping the mount, and a followed
   *    symlink whose target lands outside, on every platform (junctions
   *    included).
   * 5. Confirm the descriptor and the canonical path are the same inode, and
   *    the root still the directory step 0 checked.
   *
   * Whatever steps 1 to 5 refuse, a missing file included, is said of the
   * mount's files only while the root is still that directory. If it isn't,
   * the read is refused with the code and errno step 0 gives what is at the
   * root's path then (rootMoved), as step 5's own check of the root does.
   *
   * `inspect` runs last, after the boundary's checks, so a caller's own check
   * of the file, such as a size limit, never answers for a file the boundary
   * refuses. The returned handle is the caller's to close.
   */
  private async openContainedFile(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    inspect?: (fileStat: Stats) => void,
  ): Promise<{ handle: Awaited<ReturnType<typeof open>>; fileStat: Stats; realFilePath: string }> {
    const root = await this.readRoot(mount);
    try {
      return await this.openBeneathRoot(mount, root, relativePath, mountPrefixedPath, inspect);
    } catch (err) {
      if (err instanceof WorkspaceReadError && err.code !== 'mount_unavailable' && !(await root.dir.stillHere())) {
        throw await this.rootMoved(mount);
      }
      throw err;
    }
  }

  /** Steps 1 to 5 of openContainedFile, beneath the root that step 0 checked. */
  private async openBeneathRoot(
    mount: MountState,
    { real: realMountRoot, dir: rootDir }: { real: string; dir: CheckedDir },
    relativePath: string,
    mountPrefixedPath: string,
    inspect?: (fileStat: Stats) => void,
  ): Promise<{ handle: Awaited<ReturnType<typeof open>>; fileStat: Stats; realFilePath: string }> {
    const lexicalPath = resolve(mount.config.path, relativePath);
    const follow = mount.config.followSymlinks === true;
    const useNoFollow = !follow && typeof fsConstants.O_NOFOLLOW === 'number';

    // Before anything resolves the path, so a link's own answer comes first: a
    // mount that doesn't follow symlinks goes through none among the
    // directories on the way, wherever it leads. Asked again of the path's
    // resolution after the open, below.
    // The checks below judge by the root step 0 checked, and read the links
    // on the path's way beneath it. The lstat and the open go through the
    // configured path, and step 5 refuses a read whose root is no longer the
    // directory step 0 checked, so what's served is judged beneath one root.
    const linkView = { root: realMountRoot, followSymlinks: follow };
    const nested = await this.nestedFor(mount, realMountRoot);
    const onTheWay = await linkOnTheWay(linkView, relativePath, 'parents');
    if (onTheWay !== null) throw await linkReadError(mount, onTheWay, mountPrefixedPath, relativePath, nested, realMountRoot);

    let fileInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      fileInfo = await lstat(lexicalPath);
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceReadError('not_found', `File not found: ${mountPrefixedPath}`, 'lstat', code);
      }
      throw new WorkspaceReadError('not_found', `Unable to read file: ${mountPrefixedPath}`, 'lstat', code);
    }
    if (fileInfo.isDirectory()) {
      throw new WorkspaceReadError('directory', `Path is a directory: ${mountPrefixedPath}`, 'lstat');
    }
    if (fileInfo.isSymbolicLink() && !follow) {
      throw new WorkspaceReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`, 'lstat');
    }
    if (!fileInfo.isFile() && !fileInfo.isSymbolicLink()) {
      // A FIFO, socket or device is never opened.
      throw new NotRegularFile(mountPrefixedPath, 'lstat');
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      // O_NONBLOCK: a FIFO swapped in since the lstat opens at once instead of
      // waiting for a writer, and the regular-file check below refuses it.
      handle = await open(lexicalPath, fsConstants.O_RDONLY | NONBLOCK | (useNoFollow ? fsConstants.O_NOFOLLOW : 0));
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceReadError('not_found', `File not found: ${mountPrefixedPath}`, 'open', code);
      }
      if (!follow && code === 'ELOOP') {
        throw new WorkspaceReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`, 'open', code);
      }
      throw new WorkspaceReadError('not_found', `Unable to read file: ${mountPrefixedPath}`, 'open', code);
    }

    try {
      let fileStat: Stats;
      try {
        fileStat = await handle.stat();
      } catch (err) {
        const code = errnoOf(err);
        throw new WorkspaceReadError(
          'not_found',
          code === 'ENOENT' ? `File not found: ${mountPrefixedPath}` : `Unable to read file: ${mountPrefixedPath}`,
          'fstat',
          code,
        );
      }
      if (fileStat.isDirectory()) {
        throw new WorkspaceReadError('directory', `Path is a directory: ${mountPrefixedPath}`, 'fstat');
      }
      if (!fileStat.isFile()) {
        throw new NotRegularFile(mountPrefixedPath, 'fstat');
      }

      if (!follow && !useNoFollow) {
        let postOpenInfo: Awaited<ReturnType<typeof lstat>>;
        try {
          postOpenInfo = await lstat(lexicalPath);
        } catch (err) {
          const code = errnoOf(err);
          if (code === 'ENOENT') {
            throw new WorkspaceReadError('changed', `File changed during read: ${mountPrefixedPath}`, 'post_lstat', code);
          }
          throw new WorkspaceReadError('not_found', `Unable to read file: ${mountPrefixedPath}`, 'post_lstat', code);
        }
        if (postOpenInfo.isSymbolicLink()) {
          throw new WorkspaceReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`, 'post_lstat');
        }
      }

      let realFilePath: string;
      try {
        realFilePath = await realpath(lexicalPath);
      } catch (err) {
        const code = errnoOf(err);
        if (code === 'ENOENT') {
          throw new WorkspaceReadError('changed', `File changed during read: ${mountPrefixedPath}`, 'realpath', code);
        }
        throw new WorkspaceReadError('not_found', `Unable to resolve file: ${mountPrefixedPath}`, 'realpath', code);
      }

      // A directory swapped for a link since the walk above is caught here, by
      // what the path resolved to after the open, and the check below holds
      // the opened file to that path. A link put back after this realpath,
      // leading to the opened file itself, passes both: a race this doesn't
      // close.
      const resolvedThrough = await linkRefusal(linkView, realMountRoot, relativePath, realFilePath);
      if (resolvedThrough !== null) throw await linkReadError(mount, resolvedThrough, mountPrefixedPath, relativePath, nested, realMountRoot);

      const inside = isContainedPath(realMountRoot, realFilePath);
      const holder = inside ? await nestedAtReal(realFilePath, nested, { name: mount.config.name, rootReal: realMountRoot }) : undefined;
      // A place in a nested mount's directory that its include leaves out is
      // no mount's, so the path leaves this one (namesNestedPlace), and so
      // does one reaching a file this mount's own include leaves out
      // (coversLanding).
      const own = holder === undefined && inside && !(await coversLanding({ include: mount.config.include }, realMountRoot, realFilePath, relativePath));
      if (!inside || own || (holder !== undefined && !holder.names(false))) {
        throw new WorkspaceReadError('escape', `Symlink escape detected: ${mountPrefixedPath}`, 'realpath');
      }
      if (holder) throw new WorkspaceReadError('other_mount', leadsInto(mount.config.name, relativePath, holder), 'realpath');

      let pathStat: Stats;
      try {
        pathStat = await stat(realFilePath);
      } catch (err) {
        const code = errnoOf(err);
        if (code === 'ENOENT') {
          throw new WorkspaceReadError('changed', `File changed during read: ${mountPrefixedPath}`, 'stat', code);
        }
        throw new WorkspaceReadError('not_found', `Unable to stat file: ${mountPrefixedPath}`, 'stat', code);
      }
      if (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
        throw new WorkspaceReadError('changed', `File changed during read: ${mountPrefixedPath}`, 'stat');
      }
      // Containment compares paths, so it can't see another directory put at
      // the root's own path since step 0 (a drive unmounted mid-read): the
      // root is asked again, as an effect asks it (effects.ts moved()). This
      // sees the root as it is now, so a root replaced and put back before it
      // isn't seen (observe.ts's header says why no check can be sure).
      if (!(await rootDir.stillHere())) throw await this.rootMoved(mount);

      // The caller's checks of the file, such as a size limit, come after the
      // boundary's, so they never answer for a file the boundary refuses.
      inspect?.(fileStat);
      return { handle, fileStat, realFilePath };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /**
   * Read a workspace file from disk with the mount boundary enforced on the
   * filesystem (see {@link openContainedFile}). Public API for peer modules
   * that read mounted files outside the Chronicle tree — the safe replacement
   * for `resolveAbsolutePath()` + `fs.readFile()`, whose lexical-only guard let
   * an in-mount symlink smuggle outside content into context (agent-framework
   * #129, found via connectome-host #101).
   *
   * - Honors the mount's `followSymlinks` policy (default: refuse).
   * - With symlinks allowed, the canonical target must stay beneath the
   *   canonical mount root; a sibling-prefix root (`/mount-other`) does not count.
   * - `maxBytes` performs a bounded prefix read: at most `maxBytes` bytes are
   *   kept, and one byte past them is read to tell whether the file goes on
   *   (`truncated`). The reads decide where the file ends, not the size fstat
   *   gave at the open, so the bound holds for a file that grows while it's
   *   read.
   * - Once the workspace has recorded the mount root's identity, with the
   *   first evidence it gathers there, a root that is another directory is
   *   an unavailable mount: a replaced directory, a link swapped in for it,
   *   or an unmounted drive's mountpoint. A direct mount's reads check no
   *   recorded identity: they read beneath whatever directory is at its
   *   root (MountConfig.backend). In any mount, recorded or not, a
   *   root that stops being the directory the read checked until the file
   *   has been opened and checked is unavailable too: with ENOENT or
   *   ENOTDIR where no directory is there, as before the read, and with no
   *   errno for another directory. The file's bytes are then read through
   *   the descriptor that was checked.
   *
   * Throws {@link WorkspaceReadError} with a `code` distinguishing unknown
   * mount, lexical traversal, a path the mount's include doesn't cover
   * (`outside_include`), a path in another mount's directory nested in the one named
   * (`other_mount`), unavailable mount, missing or non-regular file,
   * directory, policy-denied symlink, outside-mount target, and
   * file-changed-during-read. An error met while parsing the path that is
   * none of these refusals, such as the store's, is thrown as it is, and a
   * `maxBytes` that isn't a non-negative integer throws a `RangeError`.
   */
  async readFileFromDisk(
    mountPrefixedPath: string,
    options: ReadFileFromDiskOptions = {},
  ): Promise<WorkspaceDiskReadResult> {
    if (options.maxBytes !== undefined && !(Number.isInteger(options.maxBytes) && options.maxBytes >= 0)) {
      throw new RangeError('readFileFromDisk: maxBytes must be a non-negative integer');
    }
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath, path: mountPrefixedPath } = await this.parseFilePath(mountPrefixedPath));
    } catch (err) {
      // A link's refusal (parseFilePath) carries its own code.
      if (err instanceof WorkspaceReadError) throw err;
      const code: WorkspaceReadErrorCode | null = err instanceof OutsideIncludeError ? 'outside_include'
        : err instanceof NestedMountError ? 'other_mount'
        : err instanceof PathRefusal ? err.code : null;
      if (code === null) throw err;
      throw new WorkspaceReadError(code, (err as Error).message, 'parse');
    }
    if (!relativePath) {
      throw new WorkspaceReadError('directory', `Path is a directory: ${mountPrefixedPath}`, 'parse');
    }

    const { handle, fileStat, realFilePath } = await this.openContainedFile(mount, relativePath, mountPrefixedPath);
    try {
      const cap = options.maxBytes;
      let bytes: Buffer;
      let truncated = false;
      if (cap === undefined) {
        bytes = await handle.readFile();
      } else {
        ({ bytes, more: truncated } = await readPrefix(handle, cap, fileStat.size));
      }
      // What the read found, not what the fstat before it said, so `size`,
      // `bytes` and `truncated` agree even for a file that changed in between.
      const size = truncated ? Math.max((await handle.stat()).size, bytes.length + 1) : bytes.length;
      return { bytes, size, truncated, mtimeMs: fileStat.mtimeMs, realPath: realFilePath, mount: mount.config.name };
    } catch (err) {
      if (err instanceof WorkspaceReadError) throw err;
      throw new WorkspaceReadError('not_found', `Unable to read file: ${mountPrefixedPath}`, 'read', errnoOf(err));
    } finally {
      await handle.close();
    }
  }

  private async readImageFromFilesystem(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxSize: number,
  ): Promise<{ bytes: Buffer; mimeType: SupportedImageMimeType }> {
    const { handle, fileStat } = await this.openContainedFile(mount, relativePath, mountPrefixedPath, (fileStat) => {
      if (fileStat.size === 0) throw emptyImage(mountPrefixedPath);
      if (fileStat.size > maxSize) throw imageTooLarge(maxSize, mountPrefixedPath, fileStat.size.toLocaleString('en-US'));
    });
    try {
      // No more than maxSize is loaded: a file grown past it since the fstat
      // above is refused here, as one already over it was there.
      const { bytes, more } = await readPrefix(handle, maxSize, fileStat.size);
      if (more) throw imageTooLarge(maxSize, mountPrefixedPath, `at least ${(maxSize + 1).toLocaleString('en-US')}`);
      return this.validateImageBytes(bytes, mountPrefixedPath, maxSize);
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) throw err;
      throw new WorkspaceReadError('not_found', `Unable to read file: ${mountPrefixedPath}`, 'read', errnoOf(err));
    } finally {
      await handle.close();
    }
  }

  /**
   * Whether a tool's change on this mount goes to disk as it commits: the
   * push commitToolChange makes, and what an edit's answer says of it.
   */
  private pushesOnCommit(mount: MountState): boolean {
    return mount.config.autoMaterialize === true && mount.config.mode !== 'read-only';
  }

  /**
   * Commit a tool's write or delete to the workspace tree, with the branch
   * intent it implies: store origin for a path disk never agreed with; for a
   * deletion, a tombstone, written before the entry is removed, unless the
   * agreement's evidence for the path, P, holds no agreed disk copy (P
   * absent, or no P and store origin), when it clears the path's intent and
   * pushes nothing. It pushes the change to
   * disk when the mount opts in via
   * `autoMaterialize` — required for cross-agent pipelines, since another
   * agent's watcher on the same directory only sees real filesystem events.
   * The push follows materialize's rule: a disk copy that changed since it
   * last agreed is not overwritten or unlinked, and the refusal says why.
   *
   * Answers, so callers surface them in the tool result, the reason when the
   * change reached the workspace but not disk (`refused`): the
   * autoMaterialize contract is that disk is the source of truth for
   * downstream agents. And, apart from it, why a write whose bytes reached
   * disk left the file's mode as disk had it (`modeKept`), and, for a
   * deletion that cleared a conflict naming a disk file the workspace never
   * took in, that nothing was unlinked (`note`). And the answer's `disk` for
   * the path, unless it was refused. The caller holds the mount's turn and has
   * settled the path first (settleBeforeMutation, or a pass over the path, as
   * an edit makes).
   */
  private async commitToolChange(
    mount: MountState,
    relativePath: string,
    change: ToolChange,
    onCommitted?: () => void,
  ): Promise<{ refused: string | null; modeKept: string | null; note: string | null; disk: DiskState | null }> {
    const { refused, modeKept, notes, disk } = await this.commitToolChanges(mount, [{ path: relativePath, change }], onCommitted && (() => onCommitted()));
    return { refused: refused.get(relativePath) ?? null, modeKept: modeKept.get(relativePath) ?? null, note: notes.get(relativePath) ?? null, disk: disk.get(relativePath) ?? null };
  }

  /**
   * commitToolChange for several paths of one mount at once, as edit_many
   * commits its files: every path's precondition is enforced before any entry
   * is set, then a deletion's tombstone is written, then every entry is set
   * in one record of the store, which takes all of them or none, then each
   * other path's intent, by the rule commitToolChange's doc gives, which the
   * code below applies, with no await between, and one push takes the paths
   * to disk, but for a deletion that clears its path's intent. `onCommitted`
   * is told of each path once the entries are set, also when the store throws
   * after setting them, whose error then goes on in place of the push
   * (changesLanded).
   * Answers, by path, the reason for each that reached the workspace but not
   * disk (`refused`), and, apart from it, why one whose bytes reached disk
   * left the file's mode as disk had it (`modeKept`), that a deletion
   * clearing a conflict that named a disk file unlinked nothing (`notes`),
   * and the answer's `disk` for each path not refused, as commitToolChange
   * answers them for one path.
   */
  private async commitToolChanges(
    mount: MountState,
    changes: Array<{ path: string; change: ToolChange }>,
    onCommitted?: (path: string) => void,
  ): Promise<{ refused: Map<string, string>; modeKept: Map<string, string>; notes: Map<string, string>; disk: Map<string, DiskState> }> {
    const store = this.getStore();
    const agreement = this.agreementOrThrow();
    const intents = this.intents.get(mount.config.name)!;
    // The mutation's precondition, enforced here, synchronously with the
    // commit: whatever settleBeforeMutation's pass could or couldn't settle.
    // Every path's comes first, so nothing that can refuse follows a set.
    for (const { path } of changes) {
      settleAdoptionBeforeMutation(store, agreement, { name: mount.config.name, treeStateId: mount.treeStateId }, path);
    }
    const entry = (change: ToolChange & { kind: 'set' }) => ({ blobHash: change.blobHash, size: change.size, mode: change.mode ?? 0o644 });
    // The changes the tree doesn't hold yet, which the read-back below checks,
    // read before any intent is written, so no read comes between a
    // tombstone's write and the put-back's guard.
    const changing = changes.filter(({ path, change }) => !holds(store.treeGet(mount.treeStateId, path), change));
    // Each path's intent, by the rule commitToolChange's doc gives. A
    // deletion's tombstone is written before its entry is removed. Removed
    // without it, the entry would read as a file this branch doesn't have,
    // which no materialize deletes and no second delete can reach
    // (anima-research/agent-framework#553). Every other intent is written
    // after the tree change: what it gives up, the tombstone a write replaces
    // or the origin and conflict a deletion clears, guards the path until the
    // change lands.
    const notes = new Map<string, string>();
    const unpushed = new Set<string>();
    const intentChanges = changes.map(({ path, change }): { path: string; first: boolean; next: (cur: BranchIntent) => BranchIntent } => {
      const evidence = agreement.get(mount.config.name, path);
      const cur = intents.get(path) ?? {};
      if (change.kind === 'remove') {
        // A deletion whose evidence holds no agreed disk copy (disk last
        // agreed it had nothing here, or has never agreed with this entry,
        // which the workspace created) puts the store back at the
        // agreement. Nothing on disk is the workspace's to unlink, so it
        // pushes nothing, and it clears the path's whole intent: no
        // tombstone, so it needs no proof of absence, which a path disk
        // can't show, such as one beneath a symlink the mount doesn't
        // follow, would never give; and no conflict, which has nothing left
        // to be about once the workspace has given up its side. Whatever
        // disk holds there is a sync's to observe, a file the workspace
        // never saw included. Any other deletion keeps its tombstone, which
        // guards it: a copy disk agreed with, a push of ours that may have
        // landed (pending or interrupted), or an entry from before the
        // evidence.
        if (!(evidence?.kind === 'absent' || (evidence === undefined && cur.origin === 'store'))) {
          return {
            path,
            first: true,
            next: (current) => {
              const next = { ...current, tombstone: { hash: change.previousHash } };
              delete next.origin;
              return next;
            },
          };
        }
        unpushed.add(path);
        // A conflict it clears may name a file disk held there, which the
        // workspace never took in: the answer says that file wasn't
        // unlinked, where the deletion alone would read as having removed
        // it. The deletion doesn't look at disk, so a file nothing recorded
        // gets no note.
        if (cur.conflict?.disk) {
          notes.set(path, `nothing was unlinked: when last observed, disk held a file at ${mount.config.name}/${path} `
            + `that the workspace never took in (conflict: ${cur.conflict.kind}), and a sync observes whatever disk holds there`);
        }
        return { path, first: false, next: () => ({}) };
      }
      return {
        path,
        first: false,
        next: (current) => {
          const next = { ...current };
          delete next.tombstone;
          // Disk has never agreed with this path: a missing disk copy is a
          // draft not yet materialized, not a deletion.
          if (evidence === undefined) next.origin = 'store';
          return next;
        },
      };
    });
    // A tombstone written for a change that then doesn't land is put back:
    // the path's intent record as it was, a damaged one's bytes included, so
    // a refused deletion changes nothing. The put-back is best effort, since
    // the error that stopped the call is its answer. A tombstone it leaves
    // beside the entry guards nothing: decide gives no verdict from one while
    // the entry is there, status and materialize take it as no deletion, and
    // the path's next agreement clears it.
    const written: Array<{ path: string; record: JsTreeEntry | null }> = [];
    const putBack = () => {
      for (const { path, record } of written) {
        try {
          if (record) store.treeSet(intents.treeStateId, path, record);
          else if (store.treeGet(intents.treeStateId, path)) store.treeRemove(intents.treeStateId, path);
        } catch (error) {
          // Left beside the entry, where it guards nothing (above).
          console.warn(
            `[workspace] Mount "${mount.config.name}": a change to ${path} failed, and putting its branch intent back threw too `
            + `(${error instanceof Error ? error.message : String(error)}), so a tombstone may be left beside the entry. One there `
            + `deletes nothing, and the path's next agreement with disk clears it`,
          );
        }
      }
    };
    try {
      for (const { path, first, next } of intentChanges) {
        if (!first) continue;
        written.push({ path, record: store.treeGet(intents.treeStateId, path) });
        intents.update(path, next);
      }
    } catch (error) {
      putBack();
      throw error;
    }
    // A store can fail after its record lands: Chronicle 0.4 writes a state's
    // auto-snapshot after appending its update, and that failure reaches the
    // caller with the update recorded (anima-research/chronicle#39). So a set
    // that threw is read back, and where every path it changes holds what its
    // change leaves, the record is in: the paths' intents follow, as for any
    // set, and then the error goes on in place of the push. A change the tree
    // already holds can't show whether the record is in, so a call whose every
    // change the tree holds already goes on as the store's own failure.
    let landedThenThrew: { error: unknown } | null = null;
    try {
      if (changes.length === 1) {
        const [{ path, change }] = changes as [{ path: string; change: ToolChange }];
        if (change.kind === 'set') store.treeSet(mount.treeStateId, path, entry(change));
        else store.treeRemove(mount.treeStateId, path);
      } else {
        // One record for every path, so a store that fails partway sets none.
        store.treeBatch(mount.treeStateId, changes.map(({ path, change }) => (change.kind === 'set'
          ? { op: 'set', path, entry: entry(change) }
          : { op: 'remove', path })));
      }
    } catch (error) {
      // A read-back that fails can't tell whether the change landed, so its
      // error goes on and a tombstone stays: put back where the removal did
      // land, it would leave #553's state, and beside an entry it guards
      // nothing.
      if (changing.length === 0 || !changesLanded(store, mount.treeStateId, changing, error)) {
        putBack();
        throw changing.length === 0 ? new AlreadyHeld(error) : error;
      }
      landedThenThrew = { error };
    }
    // A later intent update or disk push can throw; the tree entries are
    // already set, on the branch current now. If the active branch changes
    // during the push, that branch's tree has the files and the new one may
    // not.
    for (const { path } of changes) onCommitted?.(path);
    for (const { path, first, next } of intentChanges) if (!first) intents.update(path, next);
    const pushing = changes.filter(({ path }) => !unpushed.has(path));
    if (landedThenThrew) throw new StoredThenFailed(landedThenThrew.error, this.pushesOnCommit(mount) && pushing.length > 0, notes);
    const refused = new Map<string, string>();
    const modeKept = new Map<string, string>();
    if (!this.pushesOnCommit(mount) || pushing.length === 0) {
      return { refused, modeKept, notes, disk: new Map(changes.map(({ path }): [string, DiskState] => [path, this.diskOf(mount, path)])) };
    }

    const pushed = await this.pushUnlocked(mount, pushing.map(({ path }) => path), {
      applyDeletions: pushing.some(({ change }) => change.kind === 'remove'),
      branchId: store.currentBranch().id,
    });
    for (const { path, change } of pushing) {
      const skipped = pushed.skipped.find((s) => s.path === path);
      if (!skipped) {
        const kept = pushed.modesKept.find((k) => k.path === path)?.reason;
        if (kept) modeKept.set(path, kept);
        continue;
      }
      refused.set(path, skipped.reason);
      this.ctx?.pushEvent({
        type: 'workspace:materialize-failed',
        mount: mount.config.name,
        path,
        op: change.kind === 'set' ? 'write' : 'delete',
        error: skipped.reason,
      } as ProcessEvent);
    }
    return { refused, modeKept, notes, disk: new Map(changes.filter(({ path }) => !refused.has(path)).map(({ path }): [string, DiskState] => [path, 'done'])) };
  }

  // ==========================================================================
  // Lazy Sync
  // ==========================================================================

  /**
   * Before a tool reads or changes a path's workspace entry, a pending intent
   * on that path is settled by a pass over it, so the tool works from what
   * disk now holds (an edit sees a disk change the settled adoption took in).
   * The pass may not settle it (a branch that keeps changing, an unreadable
   * disk copy); the precondition that matters is enforced again,
   * synchronously, where the change commits (commitToolChange). The pass
   * names the path, as a file tool names the one it acts on, so a path the
   * mount passes over by design is observed there, as a sync naming it would
   * observe it (#276). The caller holds the mount's turn.
   */
  private async settleBeforeMutation(mount: MountState, relativePath: string): Promise<void> {
    if (this.agreementOrThrow().get(mount.config.name, relativePath)?.kind !== 'pending') return;
    await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] }, { named: true });
  }

  /**
   * Before a deletion, and for readBinary: a path the workspace doesn't hold
   * is observed under the three-way rule, which ingests a new disk file but
   * never brings back a workspace deletion or a file absent from this branch.
   * A path it holds is left alone. For a deletion, as for a write, taking
   * disk's change in first would let the push remove that change unseen; for
   * readBinary, a pass would drop a held binary file that disk changed, since
   * the tree takes in no binary disk copy. The pass names the path, as a file
   * tool names the one it acts on: a path the mount passes over by design is
   * observed, as a sync naming it would observe it (#276), while a path in
   * another mount's directory is refused before this, and passed over by any
   * pass. Answers the pass's report on the path, and why the pass decided
   * nothing where it did (undecidedOf), which leaves disk unchecked. The
   * caller holds the mount's turn.
   */
  private async ensureSynced(mount: MountState, relativePath: string): Promise<{ report: PathReport | undefined; undecided: string | null }> {
    const store = this.getStore();
    if (store.treeGet(mount.treeStateId, relativePath)) return { report: undefined, undecided: null };
    const pass = await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] }, { named: true });
    return { report: pass.reports.get(relativePath), undecided: undecidedOf(pass) };
  }

  /**
   * Why the workspace holds no entry at a path, after a pass over it that
   * decided nothing: disk wasn't checked, so it may have a copy, and the same
   * call made again checks it.
   */
  private notCheckedYet(path: string, reason: string): string {
    return `${JSON.stringify(path)} isn't in the workspace, and disk couldn't be checked: ${reason}. Make the same call again, which checks disk first.`;
  }

  /** Why the workspace holds no entry at a path, when disk explains it. */
  private notInWorkspace(path: string, report: PathReport | undefined, mount: MountState, missing?: string): string {
    const shown = JSON.stringify(path);
    switch (report?.state) {
      case 'workspace-deleted':
        return `${shown} was deleted in the workspace; disk still has a copy. Sync this path to restore it.`;
      case 'not-in-branch':
        return `${shown} is not in this branch's workspace; disk has a copy. Sync this path to add it.`;
      case 'disk-only': {
        const shows = report.mimeType?.startsWith('image/') === true && report.size !== undefined && report.size <= (mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
        return `${shown} is on disk, but the workspace doesn't store it: it's binary, or over this mount's size limit. `
          + 'read, edit and delete act only on the files it stores, so calling again won\'t change that'
          + (shows ? '; read_image shows it, if its data holds together as an image.' : '.');
      }
      case 'conflict':
        return `${shown} is in conflict: the workspace deleted it and disk changed it since. ` +
          'Sync this path to take the disk version.';
      case 'unverified':
        return uncheckedFile(shown, report.note, report.noteCause ?? {});
      default:
        return missing ?? `there's no file at ${shown}. ls or glob lists the files that exist.`;
    }
  }

  /**
   * A file's bytes for read, and the notes that say which copy they are. On a
   * 'chronicle' mount it's the workspace's copy, after a pass over the path
   * takes disk's change to it in first. On a direct mount it's disk's file as
   * it is now (bytesOnDisk), with no notes, since nothing else is kept. An
   * error says why there are none to read.
   */
  private async bytesOf(mount: MountState, relativePath: string, path: string): Promise<{ bytes: Buffer; notes: string[] } | { error: string }> {
    if (mount.direct) {
      const read = await this.bytesOnDisk(mount, relativePath, path);
      return 'error' in read ? read : { bytes: read.bytes, notes: [] };
    }
    const store = this.getStore();
    return this.withMount(mount, async (): Promise<{ bytes: Buffer; notes: string[] } | { error: string }> => {
      // A read shows the path as disk holds it now: a change on disk to a
      // file the workspace holds is taken in first, by the rule a listing
      // uses, as an edit's is. Where the stored copy is a draft and disk
      // changed too, the read shows the draft and names the conflict. The
      // pass names the path, as a file tool names the one it acts on, so a
      // path the mount passes over by design is observed, as a sync naming
      // it would observe it (#276).
      const pass = await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] }, { named: true });
      // A pass that decided nothing (undecidedOf: the selected branch kept
      // changing) leaves no report. It's read as a copy disk couldn't be
      // checked, with its reason, so the answer says the check didn't finish.
      const undecided = undecidedOf(pass);
      const report = pass.reports.get(relativePath)
        ?? (undecided !== null ? { path: relativePath, state: 'unverified' as const, note: undecided } : undefined);
      // A check that decided nothing may well finish on the next read, as
      // grep's answer to the same says of grep.
      const again = undecided !== null ? ['Read again to check it.'] : [];
      // A mode taken in alone isn't a change to the text, so it leaves the
      // read nothing to say, as it leaves an edit nothing.
      const took = (op: TreeOp) => pass.ops.some((o) => o.path === relativePath && o.op === op && !o.modeOnly);
      const entry = store.treeGet(mount.treeStateId, relativePath);
      if (!entry) {
        // A pass also drops a copy disk made binary or too large, which
        // the disk-only answer describes; any other drop is disk's deletion.
        return {
          error: took('deleted') && report?.state !== 'disk-only' ? deletedOnDisk(path)
            : undecided !== null ? this.notCheckedYet(path, undecided)
              : this.notInWorkspace(path, report, mount),
        };
      }
      const contents = await this.contentsOf(mount, relativePath, path, entry);
      if ('lost' in contents) return { error: nothingToRead(contents.lost) };
      return { bytes: contents.bytes, notes: [...whichCopyRead(report, took('modified'), mount.config.mode === 'read-only'), ...again] };
    });
  }

  /**
   * A direct mount's file for read: its bytes on disk as they are now,
   * through the mount's boundary as readFileFromDisk reaches them
   * (openContainedFile), whose refusals are the answer. What a 'chronicle'
   * mount never stores, it doesn't show either: a file over the mount's
   * size limit, and a binary one, with a NUL in its first 8 KB, which
   * read_image reads where it's an image.
   */
  private async bytesOnDisk(mount: MountState, relativePath: string, path: string): Promise<{ bytes: Buffer } | { error: string }> {
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const over = (size: string) => pastSizeLimit(`${JSON.stringify(path)} is ${size} bytes`, maxSize, "read doesn't show it", null);
    let opened: Awaited<ReturnType<WorkspaceModule['openContainedFile']>>;
    try {
      opened = await this.openContainedFile(mount, relativePath, path, (fileStat) => {
        if (fileStat.size > maxSize) throw new Refusal(over(fileStat.size.toLocaleString('en-US')));
      });
    } catch (err) {
      if (err instanceof Refusal) return { error: err.message };
      if (err instanceof WorkspaceReadError) return { error: readRefusal(err, path) };
      throw err;
    }
    try {
      // No more than the limit is loaded, as for a file over it at its fstat.
      const { bytes, more } = await readPrefix(opened.handle, maxSize, opened.fileStat.size);
      if (more) return { error: over(`at least ${(maxSize + 1).toLocaleString('en-US')}`) };
      if (looksBinary(bytes)) {
        return { error: `${JSON.stringify(path)} is binary, so read doesn't show it as text. ${sniffImageMime(bytes) ? 'read_image shows it, if its data holds together as an image.' : 'No tool shows it as text, so calling again won\'t change that.'}` };
      }
      return { bytes };
    } catch (err) {
      return { error: unreadable(JSON.stringify(path), errnoOf(err)) };
    } finally {
      await opened.handle.close();
    }
  }

  private async contentsOf(
    mount: MountState,
    relativePath: string,
    path: string,
    version: { blobHash: string; size: number },
    what: 'saved' | 'conflict-disk' = 'saved',
    tell: 'now' | 'later' = 'now',
  ): Promise<{ bytes: Buffer } | { lost: LostContents }> {
    const store = this.getStore();
    const stored = storedBytes(store, version.blobHash);
    if ('bytes' in stored) return stored;
    const otherSize = new Error('other size');
    let found: { bytes: Buffer } | { disk: LostContents['disk'] };
    try {
      const opened = await this.openContainedFile(mount, relativePath, path, (fileStat) => {
        if (fileStat.size !== version.size) throw otherSize;
      });
      try {
        const read = await readPrefix(opened.handle, version.size, opened.fileStat.size);
        found = !read.more && hashContent(read.bytes) === version.blobHash ? { bytes: read.bytes } : { disk: 'other' };
      } finally {
        await opened.handle.close();
      }
    } catch (err) {
      found = { disk: err === otherSize ? 'other' : await this.diskLacks(mount, relativePath, path, err) };
    }
    const subject = contentsSubject(what, path);
    const data = { mount: mount.config.name, path, blobHash: version.blobHash, ...('unreadable' in stored ? { storeError: stored.unreadable } : {}) };
    if ('disk' in found) {
      const now = storedBytes(store, version.blobHash);
      if ('bytes' in now) return now;
      const lost: LostContents = { path, store: now, disk: found.disk, writable: writeRefusal(mount) === null, reopen: this.agreementOrThrow().awaitsReopen };
      if (tell === 'now') this.tellLost(mount.config.name, what, version.blobHash, lost);
      return { lost };
    }
    const { bytes } = found;
    if ('bytes' in storedBytes(store, version.blobHash)) return { bytes };
    let thrown: string | null = null;
    try {
      store.storeBlob(bytes, 'application/octet-stream');
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    // Chronicle's storeBlob takes any file already at the hash's path as
    // stored, so whether the bytes took is what a read of them gives now.
    const now = storedBytes(store, version.blobHash);
    if ('bytes' in now) {
      this.ctx?.notifyOps?.('workspace-contents-restored', 'workspace',
        `Blob ${version.blobHash}: ${subject} were ${inTheStore(stored)}, and were stored again from disk's copy, whose bytes have their hash.`, data);
    } else {
      const unstored = thrown ?? ('missing' in now ? 'the store has no file for them' : `the store can't read its file for them (${now.unreadable})`);
      this.ctx?.notifyOps?.('workspace-contents-unstored', 'workspace',
        `Blob ${version.blobHash}: ${subject} are ${inTheStore(now)}. Disk's copy has their hash, so reads are answered from it, but storing it again didn't take: ${unstored}. `
          + ('unreadable' in now
            ? "Each read does this again while that lasts. Chronicle keeps a blob file it can't read in place, so where the file is damaged, removing it lets the next read store them."
            : 'Each read does this again until the store takes them.'),
        { mount: mount.config.name, path, blobHash: version.blobHash, ...('unreadable' in now ? { storeError: now.unreadable } : {}), unstored });
    }
    return { bytes };
  }

  private tellLost(mountName: string, what: 'saved' | 'conflict-disk', blobHash: string, lost: LostContents): void {
    this.ctx?.notifyOps?.('workspace-contents-lost', 'workspace',
      `Blob ${blobHash}: ${contentsSubject(what, lost.path)} are ${inTheStore(lost.store)}, and no copy with their hash could be read from disk to restore them from: ${lostOnDisk(lost)}. `
        + "Putting back the store's blob file for that hash, from a copy of the store, brings them back.",
      { mount: mountName, path: lost.path, blobHash, ...('unreadable' in lost.store ? { storeError: lost.store.unreadable } : {}) });
  }

  private async diskLacks(mount: MountState, relativePath: string, path: string, err: unknown): Promise<LostContents['disk']> {
    const absent = err instanceof WorkspaceReadError && err.code !== 'mount_unavailable' && (err.errno === 'ENOENT' || err.errno === 'ENOTDIR');
    if (!absent) return { unreadable: containedRefusal(err, path) };
    const { view, rootReal } = await this.readView(mount);
    const proof = await confirmAbsent(view, rootReal, relativePath);
    if (!('reason' in proof)) return 'none';
    return { unreadable: proof.reason === CHANGED ? containedRefusal(err, path) : proof.reason };
  }

  private async restoreEach<T extends { relativePath: string; file: string; hash: string; size: number; what: 'saved' | 'conflict-disk' }>(
    mount: MountState,
    versions: readonly T[],
    each: (version: T, contents: { bytes: Buffer } | { lost: LostContents }) => void,
  ): Promise<void> {
    const byHash = new Map<string, T[]>();
    for (const version of versions) {
      const sharing = byHash.get(version.hash);
      if (sharing) sharing.push(version);
      else byHash.set(version.hash, [version]);
    }
    for (const [hash, sharing] of byHash) {
      let bytes: Buffer | null = null;
      const lost: Array<[T, LostContents]> = [];
      for (const version of sharing) {
        const contents = await this.contentsOf(mount, version.relativePath, version.file, { blobHash: hash, size: version.size }, version.what, 'later');
        if ('bytes' in contents) {
          bytes = contents.bytes;
          break;
        }
        lost.push([version, contents.lost]);
      }
      if (bytes === null) {
        for (const [version, found] of lost) {
          this.tellLost(mount.config.name, version.what, hash, found);
          each(version, { lost: found });
        }
      } else {
        for (const version of sharing) each(version, { bytes });
      }
    }
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  /**
   * A read's page, held to `maxChars`, the most of this call's result that
   * can reach its caller whole. A call that carries none, made in process,
   * takes the data itself: its page holds to its line limit alone, with every
   * line whole, as it did before pages had a budget.
   */
  private async handleRead(input: ReadInput, maxChars: number | undefined, generatedContent?: string): Promise<ToolResult> {
    const characterPaging = input.offsetChars !== undefined || input.limitChars !== undefined;
    // Each number is a whole number of at least its schema's minimum by now
    // (inputProblem).
    if (characterPaging && (input.offset !== undefined || input.limit !== undefined)) {
      return { success: false, isError: true, error: didNothing('read', 'it was given both "offset"/"limit", which page by lines, and "offsetChars"/"limitChars", which page by characters. Give one pair.') };
    }
    let file: FileText;
    let notes: string[] = [];
    if (generatedContent === undefined) {
      const { mount, relativePath, path } = await this.parseFilePath(input.path);
      if (relativePath === '') return { success: false, error: didNothing('read', namesRoot(input.path, mount.config.name)), isError: true };
      input = { ...input, path };
      const found = await this.bytesOf(mount, relativePath, path);
      if ('error' in found) return { success: false, error: didNothing('read', found.error), isError: true };
      file = fileText(found.bytes);
      notes = found.notes;
    } else {
      file = fileText(Buffer.from(generatedContent, 'utf-8'));
    }
    // An unlimited read of a large file would inject the whole thing into the
    // turn (a 2MB file ≈ 600k tokens → the request blows past the model
    // context and 400s), so an omitted limit falls back to a default, and a
    // page stops at the call's result limit where it has one.
    return characterPaging
      ? characterPage(input.path, file, input.offsetChars ?? 0, input.limitChars ?? 2000, maxChars, notes)
      : linePage(input.path, file, input.offset ?? 1, input.limit ?? DEFAULT_READ_LINE_LIMIT, maxChars, notes);
  }

  private async handleReadImage(input: ReadImageInput): Promise<ToolResult> {
    const given = input.path;
    const refused = (body: string): ToolResult => ({ success: false, isError: true, error: didNothing('read_image', body) });
    const { mount, relativePath, path } = await this.parseFilePath(given);
    if (!relativePath) return refused(namesRoot(given, mount.config.name));
    input = { ...input, path };

    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    let treeError: WorkspaceImageReadError | null = null;
    let lost: LostContents | null = null;

    // The workspace's copy first, where it holds one, then disk's. A direct
    // mount holds none, so its image is disk's.
    if (!mount.direct) {
      try {
        const image = await this.readImageFromTree(mount, relativePath, input.path, maxSize);
        if (image && 'lost' in image) lost = image.lost;
        else if (image) return imageResult(input.path, image);
      } catch (err) {
        if (err instanceof WorkspaceImageReadError) {
          treeError = err;
        } else {
          throw err;
        }
      }
    }

    try {
      const note = lost === null ? undefined
        : `The workspace's copy of ${input.path} is ${lostInStore(lost)}, so this is disk's copy${lost.disk === 'other' ? ', which holds other contents' : ''}.`;
      return imageResult(input.path, await this.readImageFromFilesystem(mount, relativePath, input.path, maxSize), note);
    } catch (err) {
      if (!(err instanceof WorkspaceImageReadError) && !(err instanceof WorkspaceReadError)) throw err;
      const noFile = err instanceof WorkspaceReadError && err.code === 'not_found';
      if (lost) {
        const why = err instanceof WorkspaceImageReadError ? err.reason : containedRefusal(err, input.path);
        return refused(noFile || lost.disk !== 'other' ? nothingToRead(lost)
          : `${lostText(lost, 'the')}, so it can't be restored, and disk's copy can't be shown (${why}). ${lostRemedy(lost)}`);
      }
      if (noFile && treeError) return refused(treeError.message);
      return refused(err instanceof WorkspaceImageReadError ? err.message : readRefusal(err, given));
    }
  }

  private async handleWrite(input: WriteInput, callerAgentName?: string): Promise<ToolResult> {
    if (LONE_SURROGATE.test(input.content)) {
      return { success: false, isError: true, error: 'The write did nothing: "content" holds a lone UTF-16 surrogate, which UTF-8 can\'t store. Give it without the surrogate, or with the other half of its pair.' };
    }
    const { mount, relativePath, path } = await this.parseFilePath(input.path).catch((error: unknown) => { throw notStored(error); });
    if (relativePath === '') return { success: false, error: didNothing('write', namesRoot(input.path, mount.config.name)), isError: true };
    input = { ...input, path };
    const refusal = writeRefusal(mount, this.writableNames());
    if (refusal) return { success: false, error: didNothing('write', refusal), isError: true };

    const store = this.getStore();
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const bytes = Buffer.byteLength(input.content);
    if (bytes > maxSize) {
      return { success: false, error: didNothing('write', tooLargeToWrite(input.path, bytes, maxSize)), isError: true };
    }

    const buffer = Buffer.from(input.content, 'utf-8');
    const receipt = { path: input.path, size: buffer.byteLength, hash: hashContent(input.content) };
    // A direct mount's bytes go to disk, whole, or nowhere (writeDirect).
    if (mount.direct) {
      const written = await this.writeDirect(mount, relativePath, input.path, buffer, callerAgentName);
      if ('error' in written) return { success: false, isError: true, error: written.error };
      return { success: true, data: { ...receipt, disk: 'done', ...(written.note ? { note: written.note } : {}) } };
    }
    let committed = false;
    let refused: string | null;
    let modeKept: string | null;
    let disk: DiskState | null;
    try {
      ({ refused, modeKept, disk } = await this.withMount(mount, async () => {
        await this.settleBeforeMutation(mount, relativePath);
        const blobHash = store.storeBlob(buffer, 'text/plain');
        // An overwrite keeps the file's mode, as an edit does.
        const existing = store.treeGet(mount.treeStateId, relativePath);
        return this.commitToolChange(mount, relativePath, { kind: 'set', blobHash, size: buffer.byteLength, ...(existing ? { mode: existing.mode } : {}) },
          () => { committed = true; });
      }));
    } catch (error) {
      if (!committed) throw notStored(error);
      return storedButUnfinished('write', input.path, error instanceof StoredThenFailed
        ? { storeFailed: error.message, pushes: error.pushes }
        : { threw: error instanceof Error ? error.message : String(error) }, null, this.agreement?.awaitsReopen === true);
    }
    if (refused !== null) return storedButUnfinished('write', input.path, { refused });

    return { success: true, data: { ...receipt, disk, ...(modeKept ? { modeKept } : {}) } };
  }

  private async handleEdit(input: EditInput, maxChars = DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS, callerAgentName?: string): Promise<ToolResult> {
    return this.applyEdits('edit', [{
      path: input.path,
      oldString: input.oldString,
      newString: input.newString,
      expected: input.replaceAll ? 'all' : 1,
    }], maxChars, callerAgentName);
  }

  private async handleEditMany(
    input: EditManyInput,
    maxChars = DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS,
    callerAgentName?: string,
  ): Promise<ToolResult> {
    if (input.edits.length === 0) {
      return { success: false, isError: true, error: 'The edit_many call did nothing: "edits" is empty. Give at least one edit.' };
    }
    return this.applyEdits('edit_many', input.edits.map((edit) => ({
      path: edit.path,
      oldString: edit.oldString,
      newString: edit.newString,
      expected: edit.occurrences ?? 1,
    })), maxChars, callerAgentName);
  }

  /**
   * A call's edits, all or none, applied to the stored copies of their files:
   * edit's one, or edit_many's in the files of one mount. Each edit is matched
   * in its file's text as this call reads it, never in another edit's result
   * (edit-plan.ts), and any problem refuses the call with none of its edits
   * stored: edit names its first problem, and edit_many every problem found.
   *
   * Each edit's own input is checked first, and each path's mount. A problem
   * there refuses edit at once, before any file's text is read, and edit_many
   * when its edits name more than one mount, which no one pass settles.
   * Otherwise edit_many goes on to settle and plan the rest, so its one
   * refusal names the problems it finds; the settling is what a read or a
   * listing of its files would take in from disk, and the refusal says what
   * it took in. A failure before the commit sets the entries stores none of
   * them, and edit_many's answer to it says so. A store that throws as it
   * sets them is read back (commitToolChanges), so the answer says they're
   * stored where its record landed, and that it can't tell where they
   * couldn't be read back.
   * Under the mount's turn, one pass settles every path with disk, by the
   * rule a listing uses, so the edits apply to what disk now holds. Each
   * file's stored contents are then read; where the store has lost some,
   * they're restored from disk's matching copy (contentsOf) and the pass runs
   * again, so the plan reads a pass taken after every await. From there
   * nothing awaits before the commit: every edit is planned and every entry
   * set (commitToolChanges) with no turn of the event loop between, so no
   * pass, branch change or other call moves the tree between a file's read
   * and its set. Disk then takes what it can of the stored change.
   *
   * The answer is held to `maxChars`, the length the call's result may have
   * (ToolCall.resultMaxChars), as edit-text.ts describes.
   */
  private async applyEdits(
    tool: EditTool,
    given: Array<{ path: string; oldString: string; newString: string; expected: number | 'all' }>,
    maxChars: number,
    callerAgentName?: string,
  ): Promise<ToolResult> {
    const refuse = (problems: EditProblem[], notes: string[] = []): ToolResult =>
      ({ success: false, isError: true, error: refusalText(tool, problems, notes, maxChars) });

    // Each edit's own input, before anything is read: an empty old text
    // matches between every character, and UTF-8 can't store a lone surrogate.
    const problems: EditProblem[] = [];
    const specs = new Map<number, EditSpec>();
    for (const [index, edit] of given.entries()) {
      const spec: EditSpec = {
        index,
        oldText: edit.oldString.replaceAll('\r\n', '\n'),
        newText: edit.newString.replaceAll('\r\n', '\n'),
        expected: edit.expected,
      };
      const found = problems.length;
      if (spec.oldText === '') {
        problems.push({ kind: 'input', edit: index, text: '"oldString" is empty, and an empty string matches between every character. Give the text to replace.' });
      } else if (spec.oldText === spec.newText) {
        // An edit's new text takes the line ends of the text it replaces, so
        // one whose only change is its line ends changes nothing.
        problems.push({
          kind: 'input',
          edit: index,
          text: edit.oldString !== edit.newString
            ? "oldString and newString are the same once their CRLF line ends are read as LF, so there's nothing to change: an edit keeps the file's line ends, and write replaces the whole file, line ends included."
            : "oldString and newString are the same, so there's nothing to change.",
        });
      }
      for (const field of ['oldString', 'newString'] as const) {
        if (LONE_SURROGATE.test(edit[field])) {
          problems.push({ kind: 'input', edit: index, text: `"${field}" holds a lone UTF-16 surrogate, which UTF-8 can't store. Give it without the surrogate, or with the other half of its pair.` });
        }
      }
      if (problems.length === found) specs.set(index, spec);
    }
    // edit names its first problem, so one in its input refuses it before
    // its path is looked up on disk.
    if (tool === 'edit' && problems.length) return refuse(problems);

    // Each path in its mount, as disk spells it, before any file's text is
    // read. Edits of one stored path are one file, planned once from one
    // text, whatever path named it, and named as disk spells it.
    const parsed = new Map<string, { mount: MountState; relativePath: string; path: string } | Extract<EditProblem, { kind: 'file' }>>();
    const targets = new Map<string, EditTarget>();
    const mounts = new Map<string, MountState>();
    for (const [index, { path }] of given.entries()) {
      if (!parsed.has(path)) parsed.set(path, await this.editablePath(tool, path, callerAgentName));
      const where = parsed.get(path)!;
      if ('kind' in where) {
        where.edits.push(index);
        continue;
      }
      mounts.set(where.mount.config.name, where.mount);
      const key = `${where.mount.config.name}/${where.relativePath}`;
      let target = targets.get(key);
      if (!target) targets.set(key, (target = { relativePath: where.relativePath, path: where.path, edits: [], specs: [] }));
      target.edits.push(index);
      const spec = specs.get(index);
      if (spec) target.specs.push(spec);
    }
    for (const where of parsed.values()) if ('kind' in where) problems.push(where);
    if (mounts.size > 1) {
      problems.push({ kind: 'mounts', edits: [...targets.values()].flatMap((target) => target.edits), mounts: [...mounts.keys()] });
    }
    const [mount] = mounts.values();
    if (tool === 'edit' && problems.length) return refuse(problems);
    if (!mount || mounts.size > 1) return refuse(problems);
    // A direct mount's edits apply to disk's text as it is now, and land on
    // disk or don't happen (applyDirectEdits).
    if (mount.direct) return this.applyDirectEdits(tool, mount, [...targets.values()], problems, given.length, maxChars, callerAgentName);

    const store = this.getStore();
    // Whether the commit set the call's entries, all of them at once.
    let committed = false;
    // What each file's settling took in, for a receipt.
    const applied = new Map<EditTarget, string | null>();
    // The conflict each file's settling found, on a mount that doesn't push:
    // the success answer names it, and so does the answer to a store that
    // failed after recording the edits, which stand as on a success.
    const conflicts = new Map<EditTarget, string>();
    try {
      return await this.withMount(mount, async (): Promise<ToolResult> => {
        // As every file tool's pass does, it names the paths it acts on, so a
        // file the mount passes over by design is observed (see PassOptions.named).
        let pass = await this.passUnlocked(mount, { kind: 'paths', paths: [...targets.values()].map((target) => target.relativePath) }, { named: true });
        let ops = pass.ops;
        const contents = new Map<string, Buffer>();
        const lost = new Map<string, { blobHash: string; lost: LostContents }>();
        const toRecover: Array<{ relativePath: string; file: string; hash: string; size: number; what: 'saved' }> = [];
        for (const target of targets.values()) {
          const entry = store.treeGet(mount.treeStateId, target.relativePath);
          if (!entry || contents.has(entry.blobHash)) continue;
          const stored = storedBytes(store, entry.blobHash);
          if ('bytes' in stored) contents.set(entry.blobHash, stored.bytes);
          else toRecover.push({ relativePath: target.relativePath, file: target.path, hash: entry.blobHash, size: entry.size, what: 'saved' });
        }
        if (toRecover.length > 0) {
          await this.restoreEach(mount, toRecover, (version, found) => {
            if ('bytes' in found) contents.set(version.hash, found.bytes);
            else lost.set(version.relativePath, { blobHash: version.hash, lost: found.lost });
          });
          pass = await this.passUnlocked(mount, { kind: 'paths', paths: [...targets.values()].map((target) => target.relativePath) }, { named: true });
          ops = [...ops, ...pass.ops];
        }
        // A pass that decided nothing checked no file's disk copy.
        const undecided = undecidedOf(pass);
        // Nothing below awaits until the commit's push.
        const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
        const hints = hintBudget();
        // As much as the largest file the call names holds, at least, so the
        // budget is the same whatever order its files are planned in.
        let largest = maxSize;
        for (const target of targets.values()) largest = Math.max(largest, store.treeGet(mount.treeStateId, target.relativePath)?.size ?? 0);
        const counts = countBudget(largest);
        const notes: string[] = [];
        const pushes = this.pushesOnCommit(mount);
        const plans: Array<{ target: EditTarget; plan: FilePlan; mode: number; backOnDisk: string | null; conflictNote: string | null }> = [];
        for (const target of targets.values()) {
          const report = pass.reports.get(target.relativePath);
          // A mode taken in alone isn't a change to the text: it brings nothing
          // new to read, as it makes no event (emitFsEvents), and the edits
          // then write at the mode disk has, so it leaves nothing to say.
          const took = (op: TreeOp) => ops.some((o) => o.path === target.relativePath && o.op === op && !o.modeOnly);
          // Which copy the edits used, when it isn't the one the workspace
          // last agreed on with disk: disk's newer text, or the workspace's
          // copy because disk's couldn't be read or disk has none. A file the
          // workspace didn't hold has no older copy, so taking it in needs no
          // word.
          const subject = tool === 'edit' ? 'the edit' : editList(target.edits);
          // A pass that decided nothing checked no copy on disk, held or not,
          // and took nothing in, so the edits would apply to text disk may
          // have moved past, on whichever branch is selected once it gave up.
          // They're refused, as a call made again can check.
          if (undecided !== null) {
            problems.push({
              kind: 'file',
              edits: target.edits,
              path: target.path,
              text: `${target.path} couldn't be checked against disk (${undecided}), so ${subject} changed nothing. Make the same call again, which checks disk first.`,
              whole: true,
            });
            continue;
          }
          const whichCopy = (verb: string): string | null => took('modified')
            ? `Disk's copy${tool === 'edit' ? '' : ` of ${target.path}`} had changed since the workspace last agreed with it, so it was taken in first, and ${subject} ${verb} that text.`
            : report?.state === 'unverified'
              ? `${tool === 'edit' ? 'The path' : target.path} couldn't be checked against disk (${report.note ?? 'not observed'}), so ${subject} ${verb} the workspace's copy.`
              : report?.state === 'disk-missing-provenance-unknown'
                ? `Disk has no copy of ${tool === 'edit' ? 'this file' : target.path}, and nothing records whether it was deleted there, so ${subject} ${verb} the workspace's copy.`
                : null;
          // A conflict the pass found is named when the edits are refused for
          // the text they found, on either kind of mount, and on a success
          // where the mount doesn't push, since such a mount keeps the conflict
          // until materialize or sync settles it. A pushing mount's push that
          // completed met none: unforced, it stops at a conflict, so the edits
          // made the two copies agree, which settles it, or there was none.
          // Edits stored that couldn't finish leave it to the push's reason,
          // which names the conflict, or to ls, which that answer points to
          // when the rest of the call failed; where the store failed after
          // recording them, the answer names it as the success does.
          // What a sync does follows what disk holds now, whatever kind the
          // conflict was recorded as: where disk has no copy, it takes the
          // deletion; where disk has one, it keeps disk's copy and gives up
          // the workspace's, though a copy the workspace can't hold, binary
          // or past maxFileSize, isn't taken in.
          const conflict = report?.state === 'conflict' ? report.conflict?.kind ?? 'both-changed' : null;
          const conflictNote = (where: string): string | null => conflict === null ? null
            : `${tool === 'edit' ? 'The path' : target.path} is in conflict with disk (${conflict}): ${subject} ${where} the workspace's copy. `
              + (report?.diskNow === 'absent'
                ? "Sync the path to take disk's deletion, which removes the workspace's copy, or materialize it with force to write the workspace's copy back to disk."
                : "Sync the path to keep disk's copy and give up the workspace's, or materialize it with force to write the workspace's over disk's.");
          applied.set(target, whichCopy('applied to'));
          // The edits make the path the workspace's own change, so a file disk
          // lacked goes back with this call's push, or with the next
          // materialize where the mount doesn't push. A push that didn't
          // complete answers with its reason instead.
          const backOnDisk = report?.state !== 'disk-missing-provenance-unknown' ? null
            : tool === 'edit'
              ? `${pushes ? 'Its push put the file back on disk' : 'A materialize of the path puts it back on disk'}; if it was deleted there on purpose, delete it here too.`
              : `${pushes ? `This call's push put ${target.path} back on disk` : `A materialize of ${target.path} puts it back on disk`}; if it was deleted there on purpose, delete it here too.`;
          const lookedIn = [whichCopy('looked in'), conflictNote('looked in')].filter((note): note is string => note !== null);

          const entry = store.treeGet(mount.treeStateId, target.relativePath);
          if (!entry) {
            // A pass also drops a copy disk made binary or too large, which
            // the disk-only answer describes; any other drop is disk's deletion.
            const text = took('deleted') && report?.state !== 'disk-only'
              ? deletedOnDisk(target.path)
              : this.notInWorkspace(target.path, report, mount);
            problems.push({ kind: 'file', edits: target.edits, path: target.path, text, whole: false });
            continue;
          }
          const known = contents.get(entry.blobHash);
          const stored = known !== undefined ? { bytes: known } : storedBytes(store, entry.blobHash);
          if (!('bytes' in stored)) {
            const found = lost.get(target.relativePath);
            problems.push({
              kind: 'file',
              edits: target.edits,
              path: target.path,
              text: found?.blobHash === entry.blobHash
                ? `${lostText(found.lost)}, so it can't be restored, and ${subject} changed nothing. ${lostRemedy(found.lost)}`
                : `The workspace's copy of ${target.path} changed while ${subject} restored lost contents from disk, and is ${lostInStore({ store: stored })} too, so ${subject} changed nothing. Make the same call again.`,
              whole: true,
            });
            continue;
          }
          notes.push(...lookedIn);
          const plan = planTargetEdits(tool, target, stored.bytes, hints, maxSize, counts, problems);
          if (plan === null) continue;
          plans.push({
            target,
            plan,
            mode: entry.mode,
            backOnDisk,
            conflictNote: pushes ? null : conflictNote(tool === 'edit' || target.edits.length === 1 ? 'is in' : 'are in'),
          });
          const conflicted = plans.at(-1)!.conflictNote;
          if (conflicted !== null) conflicts.set(target, conflicted);
        }
        if (problems.length) return refuse(problems, notes);

        const { refused, modeKept, disk } = await this.commitToolChanges(mount, plans.map(({ target, plan, mode }) => ({
          path: target.relativePath,
          change: { kind: 'set' as const, blobHash: store.storeBlob(plan.bytes, 'text/plain'), size: plan.bytes.length, mode },
        })), () => { committed = true; });
        if (refused.size > 0) return this.editsStoredButUnfinished(tool, [...targets.values()], applied, conflicts, { refused, modeKept }, maxChars);
        return editReceipt(tool, plans.map(({ target, plan, backOnDisk, conflictNote }) => ({
          path: target.path,
          plan,
          notes: [applied.get(target) ?? null, backOnDisk, conflictNote].filter((note): note is string => note !== null),
          modeKept: modeKept.get(target.relativePath) ?? null,
        })), given.length, maxChars, furthestFromDisk(plans.map(({ target }) => disk.get(target.relativePath)!)));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (committed) {
        return this.editsStoredButUnfinished(tool, [...targets.values()], applied, conflicts, error instanceof StoredThenFailed
          ? { storeFailed: message, pushes: error.pushes }
          : { threw: message }, maxChars, this.agreement?.awaitsReopen === true);
      }
      // A set that threw and couldn't be read back may have stored the edits,
      // and a second call could then apply them twice.
      if (error instanceof CommitUnknownError) {
        const [set, read] = [storeWords(error.setCause), storeWords(error.readCause)];
        return {
          success: false,
          isError: true,
          error: tool === 'edit_many'
            ? `The edit_many call can't tell whether it stored its edits: the store failed as it set them (${set}), and reading them back failed too (${read}). `
              + 'Read its files before sending it again: a second call can apply its edits twice.'
            : `Whether the edit of "${[...targets.values()][0]!.path}" is stored isn't known: the store failed as it set it (${set}), and reading it back failed too (${read}). `
              + 'Read the file before sending the edit again: a second edit can apply the change twice.',
        };
      }
      // The commit sets every entry in one record or none, and a set that
      // threw was read back, so nothing is stored; or every change was one
      // the tree already held (AlreadyHeld).
      throw notStored(error);
    }
  }

  /**
   * Where an edit's path is in its mount, or why the call can't edit it: a
   * path no mount holds, one outside its mount or holding a lone surrogate
   * (parsePath), one a nested mount holds or that leads into one through a
   * link (parseFilePath), a path that names its mount's root, a read-only
   * mount, or for edit_many a generated file. edit's
   * generated file is refused before it gets here, by the same rule
   * (handleToolCall checks a call's `path`, which edit_many's input lacks).
   */
  private async editablePath(
    tool: EditTool,
    path: string,
    callerAgentName: string | undefined,
  ): Promise<{ mount: MountState; relativePath: string; path: string } | Extract<EditProblem, { kind: 'file' }>> {
    const unusable = (text: string) => ({ kind: 'file' as const, edits: [], path, text, whole: false });
    try {
      // In the one spelling every file tool reads, as disk spells it, so two
      // spellings of a file are one entry and, in one call, one plan
      // (parsePathAsGiven); and a path in a mount nested inside this one is
      // that mount's, which every file tool refuses here (parseFilePath).
      const where = await this.parseFilePath(path);
      // One that names the mount's root, its bare name included, names no
      // file.
      if (where.relativePath === '') return unusable(namesRoot(path, where.mount.config.name));
      const refusal = writeRefusal(where.mount, this.writableNames());
      if (refusal) return unusable(refusal);
      const generated = tool === 'edit_many' ? this.findGeneratedTextFile(path) : undefined;
      if (generated) return unusable(this.generatedFileRefusal(path, generated, callerAgentName));
      return where;
    } catch (error) {
      if (error instanceof Refusal) return unusable(error.message);
      if (error instanceof WorkspaceReadError) return unusable(readRefusal(error, path));
      throw notStored(error);
    }
  }

  /**
   * Why a call can't change a generated file: another agent's is that agent's,
   * and the agent's own is read-only, since it shows the agent's tool
   * presentation, which set_tool_visibility and set_tool_description change.
   */
  private generatedFileRefusal(path: string, generated: { agentName: string }, callerAgentName: string | undefined): string {
    return callerAgentName !== generated.agentName
      ? `${JSON.stringify(path)} is generated from another agent's tool presentation, and only that agent reads it. Calling again won't change that.`
      : `${JSON.stringify(path)} is generated from your tool presentation, so it's read-only; set_tool_visibility and set_tool_description change what it shows.`;
  }

  /**
   * The answer to edits stored but not finished: the commit set every file's
   * entry, and then disk refused some of their pushes, or the store failed
   * after recording them, so their push didn't run, or the rest of the call
   * failed. It stays an error, since part of the call failed, and leads with
   * what is stored, which must not be sent again: a second call can apply
   * those edits twice. edit's is the answer write and delete give, one path's;
   * edit_many's lists the files disk refused, each with its push's reason,
   * notes each file disk took with its mode left as disk had it, as the
   * success answer's `modeKept` does, within `maxChars`, and never says to
   * send the call again. Where the store failed after recording the edits,
   * which stand as on a success, it names each conflict the success answer
   * would (`conflicts`, found only where the mount doesn't push).
   */
  private editsStoredButUnfinished(
    tool: EditTool,
    targets: EditTarget[],
    applied: Map<EditTarget, string | null>,
    conflicts: Map<EditTarget, string>,
    outcome: { refused: Map<string, string>; modeKept: Map<string, string> } | { threw: string } | { storeFailed: string; pushes: boolean },
    maxChars: number,
    reopen = false,
  ): ToolResult {
    const conflictOf = (target: EditTarget) => ('storeFailed' in outcome ? conflicts.get(target) ?? null : null);
    if (tool === 'edit') {
      const [target] = targets;
      const note = [applied.get(target!) ?? null, conflictOf(target!)].filter((text): text is string => text !== null).join(' ');
      return storedButUnfinished('edit', target!.path, 'refused' in outcome ? { refused: outcome.refused.get(target!.relativePath)! } : outcome, note || null, reopen);
    }
    const stored = "Every edit of this call is stored in the workspace, so don't send the call again: a second call can apply its edits twice.";
    // The head is never cut, so what stands for the whole call goes in it,
    // and the parts are the files disk refused, each with its push's reason.
    let head: string;
    const parts: string[] = [];
    if ('refused' in outcome) {
      const files = targets.length;
      const refused = outcome.refused.size;
      head = `${stored}\n\n${files === 1
        ? "Disk didn't take the call's one file. Its push didn't complete:"
        : `Disk took ${files - refused} of the call's ${files} files. ${refused === 1
          ? "This file's push didn't complete:"
          : "These files' pushes didn't complete, each with its reason:"}`}`;
      for (const target of targets) {
        const reason = outcome.refused.get(target.relativePath);
        if (reason !== undefined) parts.push(`${target.path}: ${reason}`);
      }
    } else if ('storeFailed' in outcome) {
      head = `${stored}\n\nThe store failed after recording them: ${cutLine(outcome.storeFailed)}.`
        + (outcome.pushes ? ` Their push to disk didn't run, so disk lacks them until a materialize of their files writes them${reopen ? ONCE_REOPENED : ''}.` : '')
        + (reopen ? ` ${AWAITS_REOPEN}` : '');
    } else {
      head = `${stored}\n\nThe rest of the call failed: ${cutLine(outcome.threw)}.${reopen ? ` ${AWAITS_REOPEN}` : " ls shows each path's state."}`;
    }
    const kept = 'modeKept' in outcome
      ? targets.flatMap((target) => {
        const reason = outcome.modeKept.get(target.relativePath);
        return reason === undefined ? [] : [`Disk took ${target.path}: ${reason}.`];
      })
      : [];
    const notes = [
      ...kept,
      ...targets.flatMap((target) => [applied.get(target) ?? null, conflictOf(target)]).filter((note): note is string => !!note),
    ];
    return { success: false, isError: true, error: fitted(head, parts, notes, maxChars, 'stored') };
  }

  // ==========================================================================
  // Direct writes
  // ==========================================================================

  /**
   * A direct mount's write of a whole file: its bytes staged beside it and
   * renamed over it (direct-write.ts), under the mount's turn, so the
   * module's own calls take turns. Answers a note when the file had other
   * hard links, which keep its old text, or why nothing was written. One
   * that lands is the caller's latest write on the mount (recordDirectWrite).
   * With `branch`, nothing is written once the store's branch is another,
   * checked with no turn of the event loop before the rename (writeBinary's).
   */
  private async writeDirect(
    mount: MountState,
    relativePath: string,
    path: string,
    bytes: Buffer,
    agentName: string | undefined,
    branch?: string,
  ): Promise<{ note: string | null } | { error: string; branchLeft?: true }> {
    return this.withMount(mount, async () => {
      const { view, rootReal } = await this.diskView(mount);
      let staged: Staged;
      try {
        staged = await stageContained(view, rootReal, relativePath, bytes, { makeDirectory: true });
      } catch (error) {
        return { error: directDidNothing('write', path, error) };
      }
      try {
        await directWriteTestSeam.afterStage?.([staged.path]);
        await placedStill(staged);
        // A write reads nothing first, so it replaces whatever is there.
        checkUnchanged(staged, null);
        if (branch !== undefined && this.getStore().currentBranch().name !== branch) {
          await discard(staged);
          return { error: BRANCH_LEFT, branchLeft: true };
        }
        renameInto(staged);
      } catch (error) {
        await discard(staged);
        return { error: directDidNothing('write', path, error) };
      }
      this.recordDirectWrite(mount, agentName);
      return { note: linksNote(path, staged, 'write') };
    });
  }

  /**
   * applyEdits on a direct mount, under the mount's turn, whose edits land
   * on disk or don't happen. Each attempt reads every file from disk as it
   * is now (directEditText), plans every edit against those bytes as on any
   * mount (planTargetEdits), stages every file beside itself, checks every
   * one unchanged since its read, and then renames each over its file in
   * turn (direct-write.ts). A file another writer changed between its read
   * and its check has the call read and planned again against its new
   * text, three attempts in all (DIRECT_EDIT_ATTEMPTS), so edits that no
   * longer apply to it, a file that changed at every attempt, or a file the
   * next read refuses as any read would (now past the size limit, say) are
   * refused, with nothing written. A rename that fails after others leaves
   * those written and the rest as they were, and the answer names each
   * file's outcome; nothing puts the written ones back.
   */
  private async applyDirectEdits(
    tool: EditTool,
    mount: MountState,
    targets: EditTarget[],
    early: EditProblem[],
    editCount: number,
    maxChars: number,
    agentName: string | undefined,
  ): Promise<ToolResult> {
    const changedMeanwhile = new Set<EditTarget>();
    return this.withMount(mount, async () => {
      for (let attempt = 1; ; attempt++) {
        const outcome = await this.attemptDirectEdits(tool, mount, targets, early, changedMeanwhile, editCount, maxChars, agentName);
        if (outcome !== 'changed') return outcome;
        if (attempt === DIRECT_EDIT_ATTEMPTS) {
          const changed = targets.filter((target) => changedMeanwhile.has(target)).map((target) => target.path);
          // Each attempt stops at the first file it finds changed, so these are
          // the files some attempt found changed, at most one per attempt.
          return {
            success: false,
            isError: true,
            error: tool === 'edit'
              ? `${changed[0]} kept changing on disk while this edit was being applied (${DIRECT_EDIT_ATTEMPTS} attempts), so nothing was written. Read it again before retrying.`
              : `Another writer kept changing this call's files on disk while it was being applied: each of its ${DIRECT_EDIT_ATTEMPTS} attempts `
                + `found one changed since its read (${listed(changed)}), so nothing was written. Read ${changed.length === 1 ? 'it' : 'them'} again before retrying.`,
          };
        }
      }
    });
  }

  /**
   * One attempt of applyDirectEdits: its answer, or 'changed' when another
   * writer changed a file since its read, with nothing written. `early` are
   * the problems found before any file was read, which a refusal names with
   * the rest. The caller holds the mount's turn.
   */
  private async attemptDirectEdits(
    tool: EditTool,
    mount: MountState,
    targets: EditTarget[],
    early: EditProblem[],
    changedMeanwhile: Set<EditTarget>,
    editCount: number,
    maxChars: number,
    agentName: string | undefined,
  ): Promise<ToolResult | 'changed'> {
    const problems = [...early];
    const read = new Map<EditTarget, { bytes: Buffer; identity: FileIdentity }>();
    for (const target of targets) {
      const got = await this.directEditText(mount, target.relativePath, target.path);
      if ('changed' in got) {
        changedMeanwhile.add(target);
        return 'changed';
      }
      if ('error' in got) problems.push({ kind: 'file', edits: target.edits, path: target.path, text: got.error, whole: false });
      else read.set(target, got);
    }
    // Two paths that reach one file, through a link this mount follows, or
    // as two hard links (a disk that folds case has its two spellings made
    // one path by the parse, short of a directory link on the way, past
    // which they're refused here as one file named twice): each
    // would be planned against the same text and renamed over the same file
    // or split from it, so one's edits would be lost or kept apart from the
    // other's. They're refused. One file read twice has one identity here
    // unless a writer changed it between the reads, and the check before the
    // renames then sees that and reads again.
    const byIdentity = new Map<string, EditTarget>();
    for (const [target, { identity }] of read) {
      const key = `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`;
      const other = byIdentity.get(key);
      if (!other) {
        byIdentity.set(key, target);
        continue;
      }
      problems.push({
        kind: 'file',
        edits: [...other.edits, ...target.edits].sort((a, b) => a - b),
        path: other.path,
        text: `${other.path} and ${target.path} are one file, reached through a link or as two hard links; name it one way, so its edits are matched in one text`,
        whole: true,
      });
    }
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const hints = hintBudget();
    // As much as the largest file the call names holds, at least, so the
    // budget is the same whatever order its files are planned in.
    let largest = maxSize;
    for (const { bytes } of read.values()) largest = Math.max(largest, bytes.length);
    const counts = countBudget(largest);
    const plans: Array<{ target: EditTarget; plan: FilePlan }> = [];
    for (const target of targets) {
      const got = read.get(target);
      if (!got) continue;
      const plan = planTargetEdits(tool, target, got.bytes, hints, maxSize, counts, problems);
      if (plan !== null) plans.push({ target, plan });
    }
    // A file read again for another writer's change says so, whichever way
    // its edits went.
    const reread = (target: EditTarget, verb: string): string | null => !changedMeanwhile.has(target) ? null
      : `Disk's copy${tool === 'edit' ? '' : ` of ${target.path}`} changed while this call was being applied, so it was read again, `
        + `and ${tool === 'edit' ? 'the edit' : editList(target.edits)} ${verb} its new text.`;
    const refuse = (found: EditProblem[]): ToolResult => ({
      success: false,
      isError: true,
      error: refusalText(tool, found, targets.map((target) => reread(target, 'looked in')).filter((note): note is string => note !== null), maxChars, 'wrote'),
    });
    if (problems.length) return refuse(problems);

    const { view, rootReal } = await this.diskView(mount);
    const staged: Array<{ target: EditTarget; staged: Staged }> = [];
    const discardAll = async (from = 0): Promise<void> => {
      for (const { staged: file } of staged.slice(from)) await discard(file);
    };
    // A refusal before any file is renamed says so where the call names several.
    const nothingWritten = (target: EditTarget, error: unknown): ToolResult => refuse([{
      kind: 'file',
      edits: target.edits,
      path: target.path,
      text: `${target.path}: ${directReason(error)}, so ${tool === 'edit' ? 'the edit' : editList(target.edits)} changed nothing.`
        + (tool === 'edit_many' && plans.length > 1 ? ' No file was written.' : '')
        + (directWayOn(error) !== null ? ` ${directWayOn(error)}` : ''),
      whole: true,
    }]);
    for (const { target, plan } of plans) {
      try {
        staged.push({ target, staged: await stageContained(view, rootReal, target.relativePath, plan.bytes) });
      } catch (error) {
        await discardAll();
        if (error instanceof FileChanged) {
          changedMeanwhile.add(target);
          return 'changed';
        }
        return nothingWritten(target, error);
      }
    }
    try {
      await directWriteTestSeam.afterStage?.(staged.map(({ staged: file }) => file.path));
    } catch (error) {
      await discardAll();
      throw error;
    }
    for (const { target, staged: file } of staged) {
      try {
        await placedStill(file);
      } catch (error) {
        await discardAll();
        return nothingWritten(target, error);
      }
    }
    // Every file is checked, then every file renamed, with no turn of the
    // event loop between: a change to any of them before its check is seen
    // before any is written, and one landing between its check and the last
    // rename isn't (checkUnchanged).
    for (const { target, staged: file } of staged) {
      try {
        checkUnchanged(file, read.get(target)!);
      } catch (error) {
        await discardAll();
        if (error instanceof FileChanged) {
          changedMeanwhile.add(target);
          return 'changed';
        }
        return nothingWritten(target, error);
      }
    }
    for (const [i, { target, staged: file }] of staged.entries()) {
      try {
        renameInto(file);
      } catch (error) {
        if (i === 0) {
          await discardAll();
          return nothingWritten(target, error);
        }
        // Read with no turn of the event loop since the last rename.
        this.recordDirectWrite(mount, agentName);
        await discardAll(i);
        return { success: false, isError: true, error: this.directEditsPartway(staged, i, error, maxChars) };
      }
    }
    this.recordDirectWrite(mount, agentName);
    return editReceipt(tool, staged.map(({ target, staged: file }) => ({
      path: target.path,
      plan: plans.find((p) => p.target === target)!.plan,
      notes: [reread(target, 'applied to'), linksNote(target.path, file, tool)].filter((note): note is string => note !== null),
      modeKept: null,
    })), editCount, maxChars, 'done');
  }

  /**
   * The answer to an edit_many call on a direct mount whose rename of its
   * `failed`th file failed after the ones before it were written: what was
   * written, the failure, and that nothing puts them back, then each file's
   * outcome, within `maxChars`, with the hard links a written one split
   * from, as a full answer names them (linksNote).
   */
  private directEditsPartway(staged: Array<{ target: EditTarget; staged: Staged }>, failed: number, error: unknown, maxChars: number): string {
    // The failed file is named among the outcomes, so the head stays as
    // long as its reason, whatever the paths' lengths.
    const can = error instanceof WriteRefused && error.errno !== undefined ? hostFix(error.errno) : undefined;
    const head = `The edit_many call wrote ${failed} of its ${staged.length} files before the next one's write failed: ${directReason(error)}.${can !== undefined ? ` Whoever runs this host can ${can}.` : ''} `
      + "Nothing puts the written files back, so finish or revert them: in each written file, each of its edits replaced its oldString with its newString. Each file's outcome:";
    const parts = staged.map(({ target }, i) => `${target.path}: ${i < failed ? 'written' : i === failed ? 'not written, as it was (its write failed)' : 'not written, as it was'}`);
    const notes = staged.slice(0, failed).map(({ target, staged: file }) => linksNote(target.path, file, 'edit_many')).filter((note): note is string => note !== null);
    return fitted(head, parts, notes, maxChars, 'written');
  }

  /**
   * A direct mount's file as an edit reads it: its bytes on disk as they are
   * now, through the mount's boundary as read reaches them
   * (openContainedFile), with the file's identity when the read began, which
   * the write checks it against just before its rename. A file changed while
   * it was read is `changed`, so the call reads it again. What the
   * workspace doesn't show as text, it doesn't edit either: a file over the
   * mount's size limit, and a binary one.
   */
  private async directEditText(
    mount: MountState,
    relativePath: string,
    path: string,
  ): Promise<{ bytes: Buffer; identity: FileIdentity } | { error: string } | { changed: true }> {
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const over = (size: string) => pastSizeLimit(`${JSON.stringify(path)} is ${size} bytes`, maxSize, "the workspace doesn't edit it", null);
    let opened: Awaited<ReturnType<WorkspaceModule['openContainedFile']>>;
    try {
      opened = await this.openContainedFile(mount, relativePath, path, (fileStat) => {
        if (fileStat.size > maxSize) throw new Refusal(over(fileStat.size.toLocaleString('en-US')));
      });
    } catch (err) {
      if (err instanceof WorkspaceReadError && err.code === 'changed') return { changed: true };
      if (err instanceof Refusal) return { error: err.message };
      if (err instanceof WorkspaceReadError) return { error: readRefusal(err, path) };
      throw err;
    }
    try {
      const before = identityOf(await opened.handle.stat({ bigint: true }));
      const { bytes, more } = await readPrefix(opened.handle, maxSize, opened.fileStat.size);
      if (more) return { error: over(`at least ${(maxSize + 1).toLocaleString('en-US')}`) };
      if (looksBinary(bytes)) {
        return { error: `${JSON.stringify(path)} is binary, so the workspace doesn't edit it as text. A write replaces the whole file, if that's what you mean to do.` };
      }
      if (!sameIdentity(before, identityOf(await opened.handle.stat({ bigint: true })))) return { changed: true };
      return { bytes, identity: before };
    } catch (err) {
      return { error: unreadable(JSON.stringify(path), errnoOf(err)) };
    } finally {
      await opened.handle.close();
    }
  }

  /**
   * A direct mount's deletion: the file the read tools reach, by their
   * refusals (openContainedFile), unlinked through the mount's boundary as
   * a push's deletion unlinks one (unlinkContained). A followed link is the
   * entry removed, as there. One that lands is the caller's latest write on
   * the mount (recordDirectWrite).
   */
  private async deleteDirect(mount: MountState, relativePath: string, path: string, agentName: string | undefined): Promise<ToolResult> {
    return this.withMount(mount, async (): Promise<ToolResult> => {
      // One root for the call, by its identity as the call starts: the
      // open's checks and the unlink's own refuse any other directory there,
      // in ROOT_MOVED's words, so a root replaced after this stat is refused
      // rather than taken, but in the instant between the unlink's last
      // check and the unlink, which Node can't close (effects.ts's header).
      // One that can't be read now is refused here.
      const disk = await this.diskView(mount);
      let rootStat: BigIntStats;
      try {
        rootStat = await stat(disk.rootReal, { bigint: true });
      } catch (err) {
        const code = errnoOf(err);
        const why = code === 'ENOENT' || code === 'ENOTDIR'
          ? `the mount root isn't on disk. ${onlyTheHost("put the mount's directory back at its path")}`
          : `the mount root can't be read: ${systemWords(code, err)}. ${errnoWayOn(code, ROOT_RECHECK, true)}`;
        return { success: false, isError: true, error: didNothing('delete', why, path) };
      }
      const view = { ...disk.view, rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) } };
      const { rootReal } = disk;
      try {
        const opened = await this.openContainedFile(mount, relativePath, path);
        await opened.handle.close();
      } catch (err) {
        // The open's own words for a replaced root speak of reading.
        if (err instanceof RootUnavailable && err.reason === DIRECT_ROOT_REPLACED) {
          return { success: false, isError: true, error: didNothing('delete', `${ROOT_MOVED}.`, path) };
        }
        if (err instanceof WorkspaceReadError) return { success: false, isError: true, error: didNothing('delete', readRefusal(err, path)) };
        throw err;
      }
      // The unlink is awaited, unlike a write's rename, so where the head
      // was just before it says whether the head moved while it ran.
      const since = this.positionNow();
      try {
        await unlinkContained(view, rootReal, relativePath, { kind: 'any' });
      } catch (error) {
        // A failure after the unlink reached the file's entry can't say
        // whether the file is gone, so it's taken as the agent's write too.
        if (error instanceof EffectFailed && error.touched) {
          this.recordDirectWrite(mount, agentName, since);
          return { success: false, isError: true, error: `The delete of ${JSON.stringify(path)} failed after it reached the file, so the file may be gone: ${directReason(error)}. ls shows whether it is.` };
        }
        return { success: false, isError: true, error: directDidNothing('delete', path, error) };
      }
      this.recordDirectWrite(mount, agentName, since);
      return { success: true, data: { path, deleted: true, disk: 'done' }, keepWhenWithheld: ['path', 'deleted', 'disk'] };
    });
  }

  /**
   * After a direct write lands: the agent's latest write on the mount, P,
   * moves to it, where the agent's history holds P or the notice of its
   * departure from P, N (historyHoldsWrites), and N clears. Otherwise P
   * stays where it is: the head moved away from it under the call's turn,
   * and the next start's notice covers what it left (headMoveNotice). P is
   * the branch and the store's head as it is now, read with no turn of the
   * event loop since the write, so no record that lands after the write is
   * taken for one before it. A deletion, whose unlink is awaited, passes
   * where the head was just before its unlink (`since`): where the branch
   * changed meanwhile, the head moved under the call, and P is set there,
   * so the next start judges the deletion by the branch its turn was on,
   * unless the history doesn't hold P already, whose notice is owed. A write no agent
   * made tells no one. The store's reads here come after the write landed,
   * so one that throws is logged and P stays, as for a history that can't
   * be read, and the write still answers that it landed.
   */
  private recordDirectWrite(mount: MountState, agentName: string | undefined, since?: DirectPosition | null): void {
    if (agentName === undefined) return;
    try {
      const store = this.getStore();
      let heads = this.directHeads.get(mount.config.name);
      if (!heads) this.directHeads.set(mount.config.name, (heads = new Map()));
      const head = heads.get(agentName);
      const branchId = store.currentBranch().id;
      if (since && since.branchId !== branchId) {
        if (!head || this.historyHoldsWrites(agentName, head) === true) heads.set(agentName, { ...since, notice: null });
        return;
      }
      if (head && this.historyHoldsWrites(agentName, head) !== true) return;
      heads.set(agentName, { branchId, after: store.currentSequence(), notice: null });
    } catch (err) {
      console.error('[workspace] could not record a direct write\'s position:', err);
    }
  }

  /** The store's branch and head now, or null where the store can't say. */
  private positionNow(): DirectPosition | null {
    try {
      const store = this.getStore();
      return { branchId: store.currentBranch().id, after: store.currentSequence() };
    } catch {
      return null;
    }
  }

  /**
   * Whether an agent's history holds its latest direct write on a mount
   * (holdsPosition), or the notice of its departure from it, judged by the
   * notice's own presence there, through the lookup the framework hands the
   * module (useHistory); null where that lookup threw, which is logged. A
   * history that can't be read decides nothing: a write takes it as not
   * held, so its position stays and the notice stays owed, and a start
   * gives no notice, which may not be true of a history it can't read, and
   * leaves the next start to decide (headMoveNotice).
   */
  private historyHoldsWrites(agentName: string, head: DirectHead): boolean | null {
    if (this.holdsPosition(head)) return true;
    if (head.notice === null) return false;
    try {
      return this.historyLookup?.(agentName, head.notice) === true;
    } catch (err) {
      console.error('[workspace] history lookup for the head-move notice failed:', err);
      return null;
    }
  }

  /**
   * Whether the store's current branch holds what came before a direct
   * write: it's the write's branch, or continues it with every fork point on
   * the way after `after`, the store's head when the write landed. A fork at
   * exactly `after` doesn't: an undo forks at its turn's sequenceBefore,
   * which is the head at the write when nothing was recorded in the turn
   * before it. A missing branch or one without fork metadata holds nothing,
   * as for the materialize guard (isLinearContinuation).
   */
  private holdsPosition({ branchId, after }: DirectHead): boolean {
    const store = this.getStore();
    const current = store.currentBranch();
    if (current.id === branchId) return true;
    const byId = new Map(store.listBranches().map((b) => [b.id, b]));
    const visited = new Set<string>();
    let cursor = byId.get(current.id);
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.id === branchId) return true;
      if (cursor.parentId === undefined || cursor.branchPoint === undefined || cursor.branchPoint <= after) return false;
      cursor = byId.get(cursor.parentId);
    }
    return false;
  }

  /**
   * The framework's check at every start of an agent's turn, opening,
   * continuing or resuming: the notice due for each mount the agent wrote
   * direct where its history holds neither its latest write there nor the
   * notice of its departure from it (historyHoldsWrites), with those
   * mounts' names; or null, as on a head that hasn't moved. The framework
   * stores the text in the agent's history before the turn's compile and
   * hands its message id back (headMoveNoticeStored).
   */
  headMoveNotice(agentName: string): { text: string; mounts: string[] } | null {
    if (!this.store) return null;
    const due: string[] = [];
    // Every mount where the agent wrote direct, whether it runs direct this
    // session or as 'chronicle': the writes are on disk either way.
    for (const name of this.mounts.keys()) {
      const head = this.directHeads.get(name)?.get(agentName);
      if (!head) continue;
      const held = this.historyHoldsWrites(agentName, head);
      // A history that can't be read decides nothing at this start.
      if (held === null) return null;
      if (!held) due.push(name);
    }
    return due.length ? { text: headMoveText(due), mounts: due } : null;
  }

  /** The id of the message headMoveNotice's text was stored as, N, for each mount it named. */
  headMoveNoticeStored(agentName: string, mounts: readonly string[], messageId: string): void {
    for (const name of mounts) {
      const head = this.directHeads.get(name)?.get(agentName);
      if (head) head.notice = messageId;
    }
  }

  /**
   * How the module asks whether an agent's history holds a message, as the
   * framework judges its own notices (`cm.getMessage(id) !== null`): handed
   * over once, when the module is added. Without it, no notice is held.
   */
  useHistory(lookup: (agentName: string, messageId: string) => boolean): void {
    this.historyLookup = lookup;
  }

  private async handleDelete(input: DeleteInput, callerAgentName?: string): Promise<ToolResult> {
    const { mount, relativePath, path } = await this.parseFilePath(input.path).catch((error: unknown) => { throw notStored(error); });
    if (relativePath === '') return { success: false, error: didNothing('delete', namesRoot(input.path, mount.config.name)), isError: true };
    input = { ...input, path };
    const refusal = writeRefusal(mount, this.writableNames());
    if (refusal) return { success: false, error: didNothing('delete', refusal), isError: true };
    if (mount.direct) return this.deleteDirect(mount, relativePath, input.path, callerAgentName);

    const store = this.getStore();
    let committed = false;
    try {
      return await this.withMount(mount, async (): Promise<ToolResult> => {
        const { report, undecided } = await this.ensureSynced(mount, relativePath);
        await this.settleBeforeMutation(mount, relativePath);
        const entry = store.treeGet(mount.treeStateId, relativePath);
        if (!entry) {
          const error = undecided !== null ? this.notCheckedYet(input.path, undecided) : this.notInWorkspace(input.path, report, mount);
          return { success: false, error: didNothing('delete', error), isError: true };
        }

        const { refused, note, disk } = await this.commitToolChange(mount, relativePath, { kind: 'remove', previousHash: entry.blobHash },
          () => { committed = true; });
        if (refused !== null) return storedButUnfinished('delete', input.path, { refused });

        // Its whole receipt is what it changed: kept in the stub if the guard
        // withholds the result (agent-framework #277).
        return {
          success: true,
          data: { path: input.path, deleted: true, disk, ...(note ? { note } : {}) },
          keepWhenWithheld: ['path', 'deleted', 'disk', 'note'],
        };
      });
    } catch (error) {
      if (!committed) throw notStored(error);
      if (error instanceof StoredThenFailed) {
        // Its note, as the success answer's: a deletion that cleared a
        // conflict naming a disk file unlinked nothing.
        const note = error.notes.get(relativePath);
        return storedButUnfinished('delete', input.path, { storeFailed: error.message, pushes: error.pushes },
          note === undefined ? null : `${note.charAt(0).toUpperCase()}${note.slice(1)}.`, this.agreement?.awaitsReopen === true);
      }
      return storedButUnfinished('delete', input.path, { threw: error instanceof Error ? error.message : String(error) }, null, this.agreement?.awaitsReopen === true);
    }
  }

  private async handleLs(input: LsInput): Promise<ToolResult> {
    if (!input.path) {
      // List all mounts, with the kind a mount configured direct runs as
      // this session and the ignore list it walks by, whose default no
      // config shows, and each with its include where it has one, so the
      // files a mount holds show before a path outside them is refused.
      const mounts = [...this.mounts.entries()].map(([name, m]) => ({
        name,
        path: m.config.path,
        // A mount configured direct says its mode where its config names
        // none, so a writable one shows as writable.
        mode: m.config.backend === 'direct' ? m.config.mode ?? 'read-write' : m.config.mode,
        ...(m.config.backend === 'direct' ? { backend: m.direct ? 'direct' : 'chronicle', ignore: this.ignoreOf(m) } : {}),
        ...(m.config.include ? { include: [...m.config.include] } : {}),
      }));
      return { success: true, data: { mounts } };
    }

    const { mount, relativePath, path, moved, root } = await this.parsePath(input.path);
    // A path outside the mount's include that's no scope (refusesAsOutside)
    // is refused, as glob refuses it, and shown as given.
    if (await this.refusesAsOutside(mount, relativePath, moved, root)) {
      return { success: false, error: didNothing('ls', new OutsideIncludeError(input.path, mount.config).message), isError: true };
    }
    input = { ...input, path };
    const recursive = input.recursive === true;

    // Every listing checks the paths it shows against disk first, under the
    // three-way rule, whatever the mount's watch mode; a direct mount's
    // shows disk's.
    const listing = await this.listingOf(mount, relativePath, recursive);
    const incomplete = listing.incomplete.length > 0 ? { incomplete: listing.incomplete } : {};
    const empty = relativePath !== '' && listing.files.length === 0 && listing.dirs.length === 0 && listing.incomplete.length === 0;
    const note = empty ? await this.emptyScopeNote(mount, relativePath, path) : null;
    const noted = note !== null ? { note } : {};
    if (recursive) {
      return {
        success: true,
        data: {
          path: input.path,
          entries: listing.files,
          count: listing.files.length,
          ...incomplete,
          ...noted,
        },
      };
    }

    // Non-recursive: the scope's files, and the directories beneath it.
    const prefix = relativePath ? relativePath + '/' : '';
    const children: Array<Record<string, unknown>> = [
      ...listing.dirs.map((d) => d.slice(prefix.length)).sort().map((name) => ({ name, type: 'directory' })),
      ...listing.files.map(({ path: file, ...view }) => ({ name: file.slice(prefix.length), type: 'file', ...view })),
    ];
    return {
      success: true,
      data: {
        path: input.path,
        entries: children,
        count: children.length,
        ...incomplete,
        ...noted,
      },
    };
  }

  private async emptyScopeNote(mount: MountState, relativePath: string, path: string): Promise<string | null> {
    const shown = JSON.stringify(path);
    const isFile = `${shown} is a file, not a directory, so there's nothing in it to list.`;
    const { view, rootReal } = await this.diskView(mount);
    const seen = await observePath(view, rootReal, relativePath);
    if (seen.kind === 'file') return isFile;
    if (seen.kind !== 'absent') return null;
    if (!mount.direct && this.getStore().treeGet(mount.treeStateId, relativePath) !== null) return isFile;
    return this.holdsAnythingAt(mount, relativePath) ? null : `${shown} isn't a directory in the workspace or on disk, so there's nothing to list.`;
  }

  private async absentOnDisk(mount: MountState, relativePath: string): Promise<boolean> {
    const { view, rootReal } = await this.diskView(mount);
    return (await observePath(view, rootReal, relativePath)).kind === 'absent';
  }

  private holdsAnythingAt(mount: MountState, relativePath: string): boolean {
    if (mount.direct) return false;
    const store = this.getStore();
    const trees = [mount.treeStateId, this.intents.get(mount.config.name)?.treeStateId].filter((tree): tree is string => tree !== undefined);
    return trees.some((tree) => store.treeGet(tree, relativePath) !== null || store.treeList(tree, `${relativePath}/`).length > 0);
  }

  /**
   * What a listing shows of a directory scope, from where the mount keeps
   * what it reads: the store-backed kind's pass (listingFromStore), or, on a
   * direct mount, disk (listingFromDisk). `keep` chooses the files shown.
   */
  private listingOf(mount: MountState, dir: string, recursive: boolean, keep?: (path: string) => boolean): Promise<Listing> {
    return mount.direct ? this.listingFromDisk(mount, dir, recursive, keep) : this.listingFromStore(mount, dir, recursive, keep);
  }

  /**
   * A 'chronicle' mount's listing: a pass over the scope under the three-way
   * rule, each path it decided with its state, and the directories beneath
   * the scope that disk or the workspace has.
   */
  private listingFromStore(mount: MountState, dir: string, recursive: boolean, keep?: (path: string) => boolean): Promise<Listing> {
    const store = this.getStore();
    return this.withMount(mount, async (): Promise<Listing> => {
      const pass = await this.passUnlocked(mount, { kind: 'dir', dir, recursive });
      const files = [...pass.reports.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .filter((report) => keep === undefined || keep(report.path))
        .map((report) => ({ path: report.path, ...stateView(report) }));
      if (recursive) return { files, dirs: [], incomplete: pass.incomplete };
      // Read with the pass's reports, on the branch it decided on, before
      // anything else takes the mount's turn.
      const dirs = new Set(pass.dirs);
      const prefix = dir ? dir + '/' : '';
      // History implies a directory only where it's the mount's own to name
      // (withinIncludes): not history in a nested mount's directory that
      // that mount's include leaves out.
      const own = { include: mount.config.include, nested: this.nestedOf(mount.config.name) };
      for (const entry of store.treeList(mount.treeStateId, prefix || undefined)) {
        if (!withinIncludes(own, entry.path)) continue;
        const slash = entry.path.indexOf('/', prefix.length);
        if (slash >= 0) dirs.add(entry.path.slice(0, slash));
      }
      return { files, dirs: [...dirs], incomplete: pass.incomplete };
    });
  }

  /**
   * A direct mount's listing: its walk of the scope (diskWalk), with each
   * entry it took as disk has it now, observed as a pass observes it: a
   * file's size, or why the mount doesn't take it (a link it doesn't follow,
   * one that leaves the mount, what isn't a regular file). A file gone since
   * the walk listed it is no longer there to show.
   */
  private async listingFromDisk(mount: MountState, dir: string, recursive: boolean, keep?: (path: string) => boolean): Promise<Listing> {
    const { view, rootReal, taken, dirs, incomplete } = await this.diskWalk(mount, dir, recursive);
    const files: Listing['files'] = [];
    await inOrder(taken.filter((path) => keep === undefined || keep(path)), DIRECT_READS_AT_ONCE, (path) => observePath(view, rootReal, path), (seen, path) => {
      if (seen.kind === 'file') files.push({ path, size: seen.size });
      else if (seen.kind === 'unobserved') files.push({ path, note: seen.reason });
    });
    return { files, dirs, incomplete };
  }

  /**
   * A direct mount's walk of a scope, from its view (diskView): the entries
   * it took that aren't directories (files, links and the like), in path
   * order; the directories directly beneath a scope it doesn't descend; and
   * the regions it couldn't see that a pass reports beside no tracked file:
   * what it couldn't list, what the cap left, and a scope in another mount's
   * directory, said as a listing says it. A path the walk names is walked
   * whatever the mount's ignore list or an editor's file name covers there
   * (MountConfig.ignore), as a path sync's walk is.
   */
  private async diskWalk(mount: MountState, dir: string, recursive: boolean): Promise<{
    view: MountView; rootReal: string; taken: string[]; dirs: string[]; incomplete: Array<{ path: string; reason: string }>;
  }> {
    const { view, rootReal, moved } = await this.diskView(mount);
    const walk = await walkScope(view, rootReal, dir, recursive, mount.config.walkCap ?? WALK_CAP, { named: true });
    const incomplete = walk.incomplete
      .filter((region) => region.kind === 'error' || region.kind === 'cap' || (region.kind === 'ignored' && region.path === dir && dir !== ''))
      .map((region) => ({
        path: region.path,
        reason: region.reason === OTHER_MOUNT ? this.otherMountNote(mount.config.name, region.path, 'list', moved)
          : explained(region.reason, region.errno !== undefined ? { errno: region.errno } : {}, 'list'),
      }));
    return {
      view,
      rootReal,
      taken: [...walk.files, ...walk.othersTaken].sort((a, b) => a.localeCompare(b)),
      // A walk that doesn't descend sees the scope's own subdirectories alone.
      dirs: recursive ? [] : [...walk.dirs],
      incomplete,
    };
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    const regex = globToRegex(input.pattern);
    const matches: Array<Record<string, unknown>> = [];
    const incomplete: Array<{ path: string; reason: string }> = [];

    // Search across mounts
    const mountsToSearch = input.path
      ? [await this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '', moved: null, root: resolve(m.config.path) }));
    // The path is a directory to search in. One outside the mount's include
    // that's no scope (refusesAsOutside) is refused, as grep refuses it,
    // rather than searched and reported as matching nothing.
    if (input.path) {
      const { mount, relativePath, moved, root } = mountsToSearch[0]!;
      if (await this.refusesAsOutside(mount, relativePath, moved, root)) {
        return { success: false, error: didNothing('glob', new OutsideIncludeError(input.path, mount.config).message), isError: true };
      }
    }

    // Every match lies beneath the pattern's literal directory, so the walk
    // starts there: past the walk's cap, a walk of the whole scope can stop
    // before it gets there. In the mount a pattern's first segment names, the
    // pattern is read mount-prefixed (prefixedGlob), from its rest's directory
    // within `path`. A `path` that directory can't overlap leaves no file the
    // pattern can match, so the glob is refused, as grep's is, saying how
    // the pattern is read, rather than answered with no matches; but a path
    // in another mount's directory is that mount's, and is said so, as grep
    // says it. Only a `path` can do either, and it names one mount, so
    // nothing has been searched yet.
    const patternDir = literalDirOf(input.pattern);
    for (const { mount, relativePath, moved, root } of mountsToSearch) {
      const prefixed = prefixedGlob(input.pattern, mount.config.name);
      let start: string;
      let matched: (path: string) => boolean;
      if (prefixed) {
        const dir = deeperOf(relativePath, prefixed.dir);
        if (dir === null) {
          if (this.holderOf(mount.config.name, relativePath, moved)) {
            incomplete.push({ path: `${mount.config.name}/${relativePath}`, reason: this.otherMountNote(mount.config.name, relativePath, 'list', moved) });
            continue;
          }
          return { success: false, error: await this.disjointRefusal('glob', input.path!, input.pattern, true, mount, relativePath, root), isError: true };
        }
        start = await this.walkStart(mount, relativePath, dir === relativePath ? '' : dir.slice(relativePath ? relativePath.length + 1 : 0));
        matched = (path: string) => prefixed.regex.test(path);
      } else {
        start = await this.walkStart(mount, relativePath, patternDir);
        matched = (path: string) => regex.test(relativePath ? path.slice(relativePath.length + 1) : path);
      }
      const listing = await this.listingOf(mount, start, true, matched);
      for (const { path, ...view } of listing.files) matches.push({ path: `${mount.config.name}/${path}`, ...view });
      for (const region of listing.incomplete) {
        incomplete.push({ path: `${mount.config.name}/${region.path}`, reason: region.reason });
      }
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        matches,
        count: matches.length,
        ...(incomplete.length > 0 ? { incomplete } : {}),
      },
    };
  }

  private async handleGrep(input: GrepInput): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (e) {
      // V8's message ends with the parser's reason, after the pattern: "Invalid
      // regular expression: /foo(/: Unterminated group".
      const message = e instanceof Error ? e.message : String(e);
      const why = /: ([^:/]+)$/.exec(message)?.[1] ?? message;
      return {
        success: false,
        isError: true,
        error: didNothing('grep', `"pattern" ${JSON.stringify(input.pattern)} isn't a valid regular expression (${why}). `
          + 'To match a character such as "(", "[" or "*" as itself, put "\\" before it.'),
      };
    }

    const fileGlob = input.glob ? globToRegex(input.glob) : null;
    // The filter matches mount-relative paths, from the mount's root whatever
    // the `path`, so every file it lets through lies beneath its literal
    // directory, and the walk starts at the deeper of that and `path`. In the
    // mount a filter's first segment names, its mount-prefixed reading takes
    // the filter's place (below). One with no "/" also matches a file's name,
    // wherever the file lies, as ripgrep's --glob does: "*.ts" lets every .ts
    // file through, where tested against the path alone it let through only
    // those at the mount's root. The path is still tried, so a "**" in such a
    // filter spans directories as it did, and nothing it let through before
    // is lost. A filter read mount-prefixed always holds a "/" after the
    // mount's name, so it never takes the name test.
    const filterDir = input.glob ? literalDirOf(input.glob) : '';
    const byName = fileGlob !== null && !input.glob!.includes('/');
    const contextBefore = input.contextBefore ?? 0;
    const contextAfter = input.contextAfter ?? 0;

    const mountsToSearch = input.path
      ? [await this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '', moved: null, root: resolve(m.config.path) }));
    // A path outside the mount's include that's no scope is refused, as read
    // refuses it, rather than searched and reported as holding no match.
    if (input.path) {
      const { mount, relativePath, moved, root } = mountsToSearch[0]!;
      if (await this.refusesAsOutside(mount, relativePath, moved, root)) {
        return { success: false, error: didNothing('grep', new OutsideIncludeError(input.path, mount.config).message), isError: true };
      }
    }

    type GrepMatch = { line: number; text: string; context?: string[] };
    type Searched = { lineEndings?: 'CRLF' | 'mixed'; matches: GrepMatch[] };
    const results: Array<{ file: string; state?: string; version: GrepText['version'] } & Searched> = [];
    const skipped: GrepSkip[] = [];
    const incomplete: Array<{ path: string; reason: string }> = [];

    // Lines as read shows them (fileText): a CRLF end's CR is left out, for
    // matching as well as display, unless the line's own text ends in a CR, so
    // `foo$` finds a CRLF file's line, as it does under ripgrep's --crlf, and
    // the line copies into an edit as read's do. ripgrep's --crlf still prints
    // the line with its CR.
    //
    // Whether a file has CRLF ends or a BOM is a fact about the file, not a
    // line, so each searched file that has either is kept here by its path,
    // for the note on a pattern that names a CR or U+FEFF to name it. A
    // conflict's disk version is kept, for each, only where the workspace's
    // copy of its path doesn't have it, and is named as that version, since
    // read doesn't show it.
    const crlfFiles = new Map<string, { ends: 'CRLF' | 'mixed'; version: GrepText['version'] }>();
    const bomFiles = new Map<string, GrepText['version']>();
    const search = (text: GrepText): Searched & { bom: boolean } => {
      const { lines, crlfEnds, lfEnds, bom } = fileText(text.bytes);
      const lineEndings = crlfEnds > 0 ? (lfEnds > 0 ? 'mixed' : 'CRLF') : undefined;
      const found: GrepMatch[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const match: GrepMatch = { line: i + 1, text: lines[i] };
          if (contextBefore > 0 || contextAfter > 0) {
            const start = Math.max(0, i - contextBefore);
            const end = Math.min(lines.length, i + contextAfter + 1);
            match.context = lines.slice(start, end);
          }
          found.push(match);
        }
      }
      return { ...(lineEndings !== undefined ? { lineEndings } : {}), matches: found, bom };
    };

    for (const { mount, relativePath, moved, root } of mountsToSearch) {
      // A path named in another mount's directory, as holderOf resolves it,
      // is that mount's: grep searches nothing of this mount's there, and
      // says whose it is. A direct mount's is judged by the nesting its parse
      // found where its root lies now (movedNesting).
      if (this.holderOf(mount.config.name, relativePath, moved)) {
        incomplete.push({ path: `${mount.config.name}/${relativePath}`, reason: this.otherMountNote(mount.config.name, relativePath, 'list', moved) });
        continue;
      }
      // In the mount a filter's first segment names, the filter is read
      // mount-prefixed (prefixedGlob), from its rest's directory. A `path` and
      // a filter whose directories, in the reading this mount takes, don't
      // overlap leave no file the filter can let through, so the grep is
      // refused, saying how the filter is read, rather than answered with no
      // matches: written relative to the `path`, as glob's pattern is, it
      // names nothing there. Only a `path` can do this, and it names one
      // mount, so nothing has been searched yet.
      const prefixed = input.glob ? prefixedGlob(input.glob, mount.config.name) : null;
      const deeper = deeperOf(relativePath, prefixed ? prefixed.dir : filterDir);
      if (deeper === null) {
        return { success: false, error: await this.disjointRefusal('grep', input.path!, input.glob!, prefixed !== null, mount, relativePath, root), isError: true };
      }
      const start = await this.walkStart(mount, relativePath, deeper === relativePath ? '' : deeper.slice(relativePath ? relativePath.length + 1 : 0));
      const searched = (text: GrepText): (() => void) => {
        const { bom, ...hits } = search(text);
        const { file, state, version } = text;
        return () => {
          if (hits.lineEndings !== undefined && !crlfFiles.has(file)) crlfFiles.set(file, { ends: hits.lineEndings, version });
          if (bom && !bomFiles.has(file)) bomFiles.set(file, version);
          if (hits.matches.length > 0) results.push({ file, ...(state !== undefined ? { state } : {}), version, ...hits });
        };
      };
      const kept = prefixed
        ? (path: string): boolean => prefixed.regex.test(path)
        : (path: string): boolean => fileGlob === null || fileGlob.test(path)
          || (byName && fileGlob.test(path.slice(path.lastIndexOf('/') + 1)));
      const found = mount.direct
        ? await this.textsFromDisk(mount, relativePath, root, start, kept, (text) => searched(text)())
        : await this.textsFromStore(mount, relativePath, start, kept, searched);
      skipped.push(...found.skipped);
      incomplete.push(...found.incomplete);
    }

    const answer: GrepAnswer = {
      pattern: input.pattern,
      results,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      // A pattern written for a CR can't find a CRLF end's, nor one written
      // for U+FEFF a BOM, which lines as read shows them leave out, so the
      // answer says why it didn't, and names the files that have them.
      ...leftOutNote(input.pattern, crlfFiles, bomFiles, this.anyRunsDirect()),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(incomplete.length > 0 ? { incomplete } : {}),
    };
    return textAnswer(grepText(answer, contextBefore), { ...answer });
  }

  /**
   * Why a grep or a glob whose `path` (`given`, in the mount at
   * `relativePath`) and filter or pattern can't overlap did nothing. grep's
   * filter is matched from the mount's root, and in the mount its first
   * segment names, either tool's is read mount-prefixed (`prefixed`), from
   * that mount's root; either way no file at or beneath the path can pass
   * it. Where the path isn't a file, it names the one that reaches beneath
   * it, the one meant if it was written relative to the path, mount-prefixed
   * as the tools write paths: the path's own `{`, `}`, `*` and `?` stand as
   * `?`, which matches each of them, and since the search stays beneath the
   * path, a `?` that would match a sibling's name too takes nothing in from
   * outside it. One with an empty, `.` or `..` segment gets no suggestion,
   * since no path holds such a segment. Segments are read as written, so one
   * a brace group splits around isn't told apart.
   */
  private async disjointRefusal(tool: 'grep' | 'glob', given: string, filter: string, prefixed: boolean, mount: MountState, relativePath: string, root: string): Promise<string> {
    const name = mount.config.name;
    const rest = prefixed ? filter.slice(filter.indexOf('/') + 1) : filter;
    const read = `The ${tool} did nothing: its ${tool === 'grep' ? 'glob' : 'pattern'} ${JSON.stringify(filter)} `
      + (prefixed ? `is read mount-prefixed, from the root of mount ${JSON.stringify(name)}` : 'is matched against paths from the mount\'s root');
    if (await this.namesFile(mount, relativePath, root)) return `${read}, so ${JSON.stringify(given)} doesn't match it.`;
    const within = `${read}, so no file within ${JSON.stringify(given)} matches it.`;
    if (rest.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return within;
    const reaching = `${name}/${relativePath.replace(/[{}*?]/g, '?')}/${rest}`;
    return `${within} To ${tool === 'grep' ? 'filter' : 'match'} beneath it, write ${JSON.stringify(reaching)}.`;
  }

  /**
   * The texts a 'chronicle' mount's grep searches beneath `start`, or in the
   * single file `relativePath` names, those `keep` lets through, each handed
   * to `search`, whose answers are recorded in path order: a pass over the
   * scope, then each path's workspace copy, labelled with its state, and a
   * conflict's disk side.
   * What it doesn't search is in `skipped`, and what it couldn't see in
   * `incomplete`, each mount-prefixed.
   */
  private async textsFromStore(
    mount: MountState,
    relativePath: string,
    start: string,
    keep: (path: string) => boolean,
    search: (text: GrepText) => () => void,
  ): Promise<{ skipped: GrepSkip[]; incomplete: Array<{ path: string; reason: string }> }> {
    const store = this.getStore();
    const skipped: GrepSkip[] = [];
    const incomplete: Array<{ path: string; reason: string }> = [];
    await this.withMount(mount, async () => {
      // A `path` naming a single file greps just that file; otherwise it is a
      // directory prefix. (A file path once produced the prefix "notes.md/"
      // and silently matched nothing.)
      const fileScope = await this.namesFile(mount, relativePath, resolve(mount.config.path));
      // What follows reads the tree and branch intent to go with the pass's
      // reports, synchronously. They must be the branch the pass decided
      // on: one selected in between would label its content with the other
      // branch's states. So a pass whose branch is no longer selected runs
      // again, and a branch that keeps changing leaves the scope unsearched.
      //
      // A copy held at a path that now leads into a nested mount's directory
      // through a link is that mount's file too, and one that now lands on a
      // file this mount's include leaves out is no file of this mount's:
      // read refuses either (parseFilePath), so grep searches none of it and
      // says why. The pass
      // can't check such a path's disk, so only an unverified one can be
      // one. Asking awaits disk, so it's done before the branch is
      // compared, and a branch selected meanwhile runs the pass again.
      let pass: PassResult | null = null;
      let refused = new Map<string, string>();
      for (let attempt = 0; attempt < 3 && pass === null; attempt++) {
        const next = await this.passUnlocked(mount, fileScope
          ? { kind: 'paths', paths: [relativePath] }
          : { kind: 'dir', dir: start, recursive: true });
        const asked = new Map<string, string>();
        for (const report of next.reports.values()) {
          if (report.state !== 'unverified') continue;
          const refusal = await this.landingRefusal(mount, report.path, `${mount.config.name}/${report.path}`, this.nestedOf(mount.config.name), resolve(mount.config.path));
          if (refusal) asked.set(report.path, refusal.message);
        }
        if (next.branchId === undefined || next.branchId === store.currentBranch().id) {
          pass = next;
          refused = asked;
        }
      }
      if (pass === null) {
        incomplete.push({
          path: `${mount.config.name}/${relativePath}`,
          reason: 'the selected branch kept changing while grep ran; nothing here was searched — grep again',
        });
        return;
      }
      for (const region of pass.incomplete) {
        incomplete.push({ path: `${mount.config.name}/${region.path}`, reason: region.reason });
      }

      const intents = this.intents.get(mount.config.name)!;
      type Lost = Omit<GrepText, 'bytes'> & { relativePath: string; hash: string; size: number; what: 'saved' | 'conflict-disk' };
      const found: Array<{ searched: () => void } | { skip: GrepSkip } | { lost: Lost }> = [];
      for (const report of [...pass.reports.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!keep(report.path)) continue;
        const file = `${mount.config.name}/${report.path}`;
        if (report.state === 'disk-only') {
          found.push({ skip: {
            file,
            reason: 'disk-only: binary or over the size limit, never stored',
            ...(report.size !== undefined ? { size: report.size } : {}),
            ...(report.mimeType ? { mimeType: report.mimeType } : {}),
          } });
          continue;
        }
        // A path in another mount's directory is that mount's: grep gives
        // none of this mount's copy of it, as read refuses it. Beneath a
        // scope it's passed over by design, like the directory.
        if (inOtherMount(report.path, this.othersOf(mount.config.name))) continue;
        const refusal = refused.get(report.path);
        if (refusal !== undefined) {
          found.push({ skip: { file, reason: refusal } });
          continue;
        }
        // The workspace's version, labelled with the path's state.
        const entry = store.treeGet(mount.treeStateId, report.path);
        if (entry) {
          const stored = storedBytes(store, entry.blobHash);
          found.push('bytes' in stored
            ? { searched: search({ file, state: report.state, version: 'workspace', bytes: stored.bytes }) }
            : { lost: { file, state: report.state, version: 'workspace', relativePath: report.path, hash: entry.blobHash, size: entry.size, what: 'saved' } });
        }
        if (report.state !== 'conflict') continue;
        // A conflict's disk side. The version recorded with the conflict is
        // disk's only while disk still holds it; once disk has changed
        // since, it is labelled as recorded, and a file disk holds now
        // (never stored) is listed as not searched. A binary or oversize
        // disk version was never stored either.
        const disk = intents.get(report.path)?.conflict?.disk;
        const changed = report.conflict?.diskChangedSinceRecorded === true;
        if (disk?.stored) {
          const version = changed ? 'recorded-disk' : 'conflicting-disk';
          const stored = storedBytes(store, disk.stored);
          found.push('bytes' in stored
            ? { searched: search({ file, state: report.state, version, bytes: stored.bytes }) }
            : { lost: { file, state: report.state, version, relativePath: report.path, hash: disk.stored, size: disk.size, what: 'conflict-disk' } });
        }
        if (changed) {
          if (report.diskNow === 'file') {
            found.push({ skip: { file, reason: 'conflict: disk changed since the conflict was recorded; grep searches stored text, so the file disk holds now was not searched' } });
          }
        } else if (disk && !disk.stored) {
          found.push({ skip: { file, reason: `conflict: the disk version is binary or over the size limit, so the workspace never stored it, and grep searches only what it stores; ${settleConflict('file', mount.config.mode === 'read-only').replace(/\.$/, '')}`, size: disk.size } });
        }
      }
      const answers = new Map<Lost, { searched: () => void } | { skip: GrepSkip }>();
      await this.restoreEach(mount, found.flatMap((item) => ('lost' in item ? [item.lost] : [])), (lost, contents) => {
        const { file, state, version, what } = lost;
        answers.set(lost, 'bytes' in contents
          ? { searched: search({ file, state, version, bytes: contents.bytes }) }
          : { skip: {
            file,
            reason: `${what === 'saved' ? "the workspace's copy" : 'conflict: the disk version recorded with the conflict'} is ${lostInStore(contents.lost)}, `
              + `and ${lostOnDisk(contents.lost)}, so it was not searched`,
          } });
      });
      for (const item of found) {
        const answer = 'lost' in item ? answers.get(item.lost)! : item;
        if ('searched' in answer) answer.searched();
        else skipped.push(answer.skip);
      }
    });
    return { skipped, incomplete };
  }

  /**
   * The texts a direct mount's grep searches beneath `start`, or in the
   * single file `relativePath` names, as namesFile judges it beneath `root`,
   * the root grep's parse resolved, those `keep` lets through, each handed
   * to `each` in path order: each file its walk took (diskWalk), read from
   * disk as it is now, DIRECT_READS_AT_ONCE at a time. A file over the size
   * limit, a binary one and one the mount doesn't take are in `skipped`,
   * each with why, as a 'chronicle' mount's grep lists what it never stored;
   * one gone since the walk listed it isn't there to search.
   */
  private async textsFromDisk(
    mount: MountState,
    relativePath: string,
    root: string,
    start: string,
    keep: (path: string) => boolean,
    each: (text: GrepText) => void,
  ): Promise<{ skipped: GrepSkip[]; incomplete: Array<{ path: string; reason: string }> }> {
    const name = mount.config.name;
    const fileScope = await this.namesFile(mount, relativePath, root);
    const { view, rootReal, taken, incomplete } = fileScope
      ? { ...(await this.diskView(mount)), taken: [relativePath], incomplete: [] }
      : await this.diskWalk(mount, start, true);
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const skipped: GrepSkip[] = [];
    await inOrder(taken.filter(keep), DIRECT_READS_AT_ONCE, (path) => readBytes(view, rootReal, path, maxSize), (read, path) => {
      const file = `${name}/${path}`;
      if (read.kind === 'absent') return;
      if (read.kind === 'unobserved') {
        skipped.push({ file, reason: read.reason });
        return;
      }
      const mimeType = sniffImageMime(read.head);
      const what = { size: read.size, ...(mimeType ? { mimeType } : {}) };
      if (read.bytes === null) skipped.push({ file, reason: `over the size limit (${maxSize} bytes)`, ...what });
      else if (looksBinary(read.head)) skipped.push({ file, reason: 'binary: a NUL in its first 8 KB', ...what });
      else each({ file, version: 'disk', bytes: read.bytes });
    });
    return { skipped, incomplete: incomplete.map((region) => ({ path: `${name}/${region.path}`, reason: region.reason })) };
  }

  private async handleStatus(input: StatusInput): Promise<ToolResult> {
    const store = this.getStore();
    const status: Record<string, unknown> = {};
    if (input.mount !== undefined && !this.mounts.has(input.mount)) {
      return { success: false, error: didNothing('status', this.noSuchMountField(input.mount, 'covers every mount')), isError: true };
    }
    const asked = input.mount === undefined ? [] : [...this.mounts].filter(([name, mount]) => !mount.direct && name === input.mount);
    const roots = new Map(await Promise.all(asked.map(async ([name, mount]) => [name, await this.rootState(mount)] as const)));

    for (const [name, mount] of this.mounts) {
      if (input.mount !== undefined && name !== input.mount) continue;
      if (mount.direct) {
        // A direct mount keeps nothing to count: its kind, and the ignore
        // list its walks go by, whose default no config shows.
        status[name] = { path: mount.config.path, mode: mount.config.mode ?? 'read-write', backend: 'direct', ignore: this.ignoreOf(mount) };
        continue;
      }
      // What the workspace's history holds outside the mount's include isn't the mount's,
      // and nor is what it holds in a nested mount's directory that mount's include leaves
      // out (withinIncludes), which no listing names either.
      const listable = { include: mount.config.include, nested: this.nestedOf(name) };
      const entries = store.treeList(mount.treeStateId).filter((e) => withinIncludes(listable, e.path));
      const currentSeq = store.currentSequence();
      const { conflicts: conflictPaths, deletions: deletionPaths, owed } = this.heldChanges(mount);
      const pending = new Set([...conflictPaths, ...deletionPaths, ...owed]);

      const currentBranch = store.currentBranch();
      const root = input.mount !== undefined ? roots.get(name)!
        : mount.lastPassRoot?.listed ? { unavailable: mount.lastPassRoot.listed, lastPassAt: mount.lastPassRoot.at } : undefined;
      status[name] = {
        path: mount.config.path,
        mode: mount.config.backend === 'direct' ? mount.config.mode ?? 'read-write' : mount.config.mode,
        // A mount configured direct runs as 'chronicle' this session
        // (chooseKinds), by the direct kind's ignore list where its config
        // names none.
        ...(mount.config.backend === 'direct' ? { backend: 'chronicle', ignore: this.ignoreOf(mount) } : {}),
        watch: watchOf(mount.config),
        fileCount: entries.length,
        lastMaterializedSeq: mount.lastMaterializedSeq,
        currentSeq,
        pendingChanges: pending.size,
        conflicts: conflictPaths.length,
        pendingWorkspaceDeletions: deletionPaths.length,
        initialSyncDone: mount.initialSyncDone,
        currentBranch: currentBranch.name,
        lastMaterializedBranch: mount.lastMaterializedBranchId,
        canMaterialize: this.mountMaterializeBlockReason(store, mount) === null && root?.unavailable === undefined,
        ...(mount.lastAgentActionScan ? { lastAgentActionScan: mount.lastAgentActionScan } : {}),
        ...(root !== undefined ? { root } : {}),
      };
    }

    return { success: true, data: status };
  }

  private async readView(mount: MountState): Promise<{ view: MountView; rootReal: string }> {
    const root = resolve(mount.config.path);
    const rootReal = await realpath(root).catch(() => root);
    return { view: this.viewOf(mount, this.agreementOrThrow().rootIdentityForRead(mount.config.name)), rootReal };
  }

  private async rootState(mount: MountState): Promise<{ recorded?: RootAsShown | null; now: RootAsShown | null; unavailable?: string; note?: string }> {
    const read = await this.readView(mount).catch((err: unknown) => {
      if (err instanceof EvidenceUnavailable) return err;
      throw err;
    });
    if (read instanceof EvidenceUnavailable) {
      const root = resolve(mount.config.path);
      const there = await locateRoot(this.viewOf(mount, undefined), await realpath(root).catch(() => root));
      return { now: asShown('identity' in there ? there.identity : null), unavailable: rootUnreadable(read) };
    }
    const { view, rootReal } = read;
    const recorded = view.rootIdentity ?? null;
    const found = await passRoot({ view, rootReal });
    if ('unavailable' in found) {
      const there = await locateRoot({ ...view, rootIdentity: undefined }, rootReal);
      return { recorded: asShown(recorded), now: asShown('identity' in there ? there.identity : null), unavailable: found.listed };
    }
    const note = this.agreementOrThrow().awaitsReopen ? undefined
      : recorded === null ? mount.config.mode === 'read-only' ? NOTHING_RECORDED_READ_ONLY : NOTHING_RECORDED
        : recorded.born === undefined && found.identity.born !== undefined && found.bornFixed ? BORN_UNRECORDED : undefined;
    return { recorded: asShown(recorded), now: asShown(found.identity), ...(note !== undefined ? { note } : {}) };
  }

  /**
   * What the store holds of a mount that disk lacks, on the selected branch,
   * among the mount's own paths. Status counts the first three as pending:
   * recorded conflicts; workspace deletions, pending until a push confirms
   * them on disk (left there without applyDeletions, or unlinked but
   * unconfirmed); and what disk owes by the evidence (entriesByEvidence's
   * `owed`: every entry it doesn't show on disk, a refused or failed push's
   * included). An entry from before the evidence isn't among them until a
   * listing or a materialize checks it: unchecked isn't unpushed. A
   * tombstone beside an entry that's still there, left by a deletion or a
   * write that stopped partway (commitToolChanges), is no deletion: it holds
   * no change disk lacks, and its entry is judged by the evidence as any
   * other is. The fourth, intents that can't be read, may hold a deletion
   * or a conflict, so a mount configured direct counts them too (initStore).
   * Each lies where the mount's include covers, as status counts them: what
   * the workspace's history holds outside it is no change of the mount's,
   * and no push writes it to disk (pushUnlocked).
   */
  private heldChanges(mount: MountState): { conflicts: string[]; deletions: string[]; owed: string[]; unreadable: string[] } {
    const store = this.getStore();
    const own = this.ownPaths(mount);
    // What the workspace's history holds outside the mount's include isn't the mount's.
    const intents = this.intents.get(mount.config.name)!.list().filter(([p]) => insideMount(p, mount.config.include) && own(p));
    return {
      conflicts: intents.filter(([, bi]) => bi.conflict).map(([p]) => p),
      deletions: intents.filter(([p, bi]) => bi.tombstone && !store.treeGet(mount.treeStateId, p)).map(([p]) => p),
      owed: this.entriesByEvidence(mount).owed,
      unreadable: intents.filter(([, bi]) => bi.unreadable !== undefined).map(([p]) => p),
    };
  }

  /**
   * What a materialize of `mount` should consider: a named file, or every
   * tracked path beneath a named directory; otherwise what the evidence says
   * disk still owes, the entries never checked against disk, recorded
   * conflicts, and workspace deletions still on disk (applied with
   * `applyDeletions`, listed without it). The watermark plays no part: it is
   * lost at an unclean restart, and an entry the evidence shows on disk has
   * nothing to push. If disk changed since, a sync adopts that; a bare
   * materialize, forced or not, never reverts it (naming the path with force
   * does). `inPlace` says whether any tree entry was left out for that reason.
   */
  private materializeSelection(mount: MountState, explicitPath: string): { paths: string[]; inPlace: boolean } {
    const store = this.getStore();
    const own = this.ownPaths(mount);
    const intents = new Map(this.intents.get(mount.config.name)!.list(explicitPath).filter(([p]) => own(p)));
    const selected = new Set<string>();

    if (explicitPath !== '') {
      if (store.treeGet(mount.treeStateId, explicitPath) && own(explicitPath)) selected.add(explicitPath);
      for (const e of store.treeList(mount.treeStateId, explicitPath + '/')) if (own(e.path)) selected.add(e.path);
      for (const [p, bi] of intents) if (bi.tombstone || bi.conflict) selected.add(p);
      return { paths: [...selected], inPlace: false };
    }

    const { owed, unchecked, agreed } = this.entriesByEvidence(mount);
    for (const path of [...owed, ...unchecked]) selected.add(path);
    // A tombstone is a deletion only where its entry is gone: one beside an
    // entry that's still there, left by a change that stopped partway
    // (commitToolChanges), would select an agreed entry, and a forced push
    // would write it over a newer disk copy. A deletion or conflict held
    // outside the mount's include isn't the mount's, as status counts it:
    // not taken up, so not reported skipped.
    for (const [p, bi] of intents) {
      if ((bi.conflict || (bi.tombstone && !store.treeGet(mount.treeStateId, p))) && insideMount(p, mount.config.include)) selected.add(p);
    }
    return { paths: [...selected], inPlace: agreed > 0 };
  }

  /**
   * Whether a path of the mount is its own to push and to count as owed:
   * not in another mount's directory nested in it. Copies the mount's tree
   * holds there (stored before the nesting) stay in its history, and in its
   * listings and status's fileCount where that mount's include covers them
   * (withinIncludes). Its syncs pass over them, and
   * they're left out of what it pushes and of status's pending changes,
   * conflicts and workspace deletions.
   */
  private ownPaths(mount: MountState): (path: string) => boolean {
    const others = this.othersOf(mount.config.name);
    return (path) => !inOtherMount(path, others);
  }

  /**
   * The workspace entries by what the evidence says of disk. `owed`: P
   * differs from the entry (a draft, or a push still pending), the entry
   * records a mode other than the one P agreed (a mode owed to disk), or
   * there is no P and the entry came from the workspace (a draft disk never
   * had).
   * `unchecked`: no P and no workspace origin, an entry from before the
   * evidence; a push agrees it, writes it where disk lacks it, or refuses it
   * as a conflict. `agreed`: how many have P = S, so disk holds them. Status
   * counts the owed as pending; a materialize without a path takes up the
   * owed and the unchecked.
   */
  private entriesByEvidence(mount: MountState): { owed: string[]; unchecked: string[]; agreed: number } {
    const store = this.getStore();
    const owed: string[] = [];
    const unchecked: string[] = [];
    let agreed = 0;
    const own = this.ownPaths(mount);
    for (const e of store.treeList(mount.treeStateId)) {
      // Outside the mount's include, or in another mount's directory nested
      // in it: neither owed to disk nor counted as on it.
      if (!insideMount(e.path, mount.config.include) || !own(e.path)) continue;
      const kind = this.evidenceOf(mount, e);
      if (kind === 'owed') owed.push(e.path);
      else if (kind === 'unchecked') unchecked.push(e.path);
      else agreed++;
    }
    return { owed, unchecked, agreed };
  }

  private evidenceOf(mount: MountState, e: { path: string; blobHash: string; mode: number }): 'owed' | 'unchecked' | 'agreed' {
    const p = this.agreementOrThrow().get(mount.config.name, e.path);
    if (p === undefined) return this.intents.get(mount.config.name)!.get(e.path)?.origin === 'store' ? 'owed' : 'unchecked';
    if (p.kind !== 'content' || p.hash !== e.blobHash) return 'owed';
    // A mode the store records, other than the one disk last agreed with,
    // where modes are observed: elsewhere no push applies one.
    if (this.modesObserved && p.mode !== undefined && (entryMode(e.mode) ?? p.mode) !== p.mode) return 'owed';
    return 'agreed';
  }

  private diskOf(mount: MountState, relativePath: string): DiskState {
    const intent = this.intents.get(mount.config.name)!.get(relativePath);
    if (intent?.conflict) return 'in conflict with disk';
    const entry = this.getStore().treeGet(mount.treeStateId, relativePath);
    if (!entry) return intent?.tombstone ? 'waits for materialize with applyDeletions' : 'done';
    return this.evidenceOf(mount, { ...entry, path: relativePath }) === 'agreed' ? 'done' : 'waits for materialize';
  }

  private async handleMaterialize(input: MaterializeInput): Promise<ToolResult> {
    const store = this.getStore();

    const allWritten: Array<{ mount: string; path: string }> = [];
    const allDeleted: Array<{ mount: string; path: string }> = [];
    const pendingDeletions: Array<{ mount: string; path: string }> = [];
    const modesKept: Array<{ mount: string; path: string; reason: string }> = [];

    let explicit: { mount: MountState; relativePath: string } | null = null;
    if (input.path !== undefined) {
      if (input.path === '') {
        return { success: false, error: didNothing('materialize', this.emptyPathField(input.mount, "covers every mount that takes writes and doesn't already write them straight to disk")), isError: true };
      }
      const parsed = await this.parsePath(input.path);
      explicit = parsed;
      // A path outside the mount's include that's no scope (refusesAsOutside)
      // is refused; beneath a directory, the push leaves out what the include
      // doesn't cover.
      if (await this.refusesAsOutside(parsed.mount, parsed.relativePath, parsed.moved, parsed.root)) {
        return { success: false, error: didNothing('materialize', new OutsideIncludeError(input.path, explicit.mount.config).message), isError: true };
      }
    }

    let mountsToMaterialize: Array<{ name: string; mount: MountState }>;
    if (explicit) {
      mountsToMaterialize = [{ name: explicit.mount.config.name, mount: explicit.mount }];
    } else if (input.mount !== undefined) {
      const m = this.mounts.get(input.mount);
      if (!m) {
        return { success: false, error: didNothing('materialize', this.noSuchMountField(input.mount, "covers every mount that takes writes and doesn't already write them straight to disk")), isError: true };
      }
      mountsToMaterialize = [{ name: input.mount, mount: m }];
    } else {
      // Not a mount running direct, whose writes are on disk already.
      mountsToMaterialize = [...this.mounts.entries()]
        .filter(([, m]) => m.config.mode === 'read-write' && !m.direct)
        .map(([name, mount]) => ({ name, mount }));
    }

    // Branch guard, scoped to the mounts actually being materialized: a
    // linear continuation (current branch descends from the pinned branch at
    // or after the pinned seq) passes; genuine divergence refuses unless
    // force. One mount's stale pin must never block another mount. It is
    // judged inside the mount's turn, on the same branch the selection is
    // made on: a materialize queued behind a pass would otherwise select on
    // whatever branch is current when its turn comes, unguarded. The push
    // then writes nothing if the branch changes after that.
    const blocked: Array<{ mount: string; reason: string }> = [];
    // What the push left because the mount's include doesn't cover it is
    // counted, as a sync's passedOver counts it, and not named: no tool names
    // a file outside the include.
    const passedOver: Array<{ mount: string; reason: string; count: number }> = [];
    const guarded: string[] = [];
    let proceeded = 0;

    for (const { name, mount } of mountsToMaterialize) {
      // Only a writable direct mount the caller named gets here: it keeps no
      // tree to push. A read-only one is named as any read-only mount is.
      if (mount.direct && mount.config.mode !== 'read-only') {
        blocked.push({ mount: name, reason: DIRECT_MATERIALIZE_SKIPPED });
        continue;
      }
      if (mount.config.mode === 'read-only') {
        // Only a mount the caller named gets here read-only (a bare
        // materialize takes the read-write ones): say why nothing was written.
        blocked.push({ mount: name, reason: 'a read-only mount: materialize writes nothing to it' });
        continue;
      }
      // A path named in another mount's directory, as holderOf resolves it,
      // is that mount's: nothing of this mount's is pushed there, and the
      // caller is told whose it is.
      if (explicit && this.holderOf(name, explicit.relativePath)) {
        blocked.push({ mount: name, reason: `${explicit.relativePath}: ${this.otherMountNote(name, explicit.relativePath, 'push')}` });
        continue;
      }
      const turn = await this.withMount(mount, async (): Promise<{ blocked: string } | { pushed: PushResult; inPlace: boolean }> => {
        const branchId = store.currentBranch().id;
        const reason = this.mountMaterializeBlockReason(store, mount);
        // Force passes a divergence. The selection follows the evidence, which
        // is per path and kept across branches, so nothing needs resetting:
        // the push re-pins to this branch.
        if (reason && !input.force) return { blocked: reason };
        const { paths, inPlace } = this.materializeSelection(mount, explicit?.relativePath ?? '');
        return {
          inPlace,
          pushed: await this.pushUnlocked(mount, paths, {
            force: input.force, named: explicit !== null, applyDeletions: input.applyDeletions, branchId,
          }),
        };
      });
      if ('blocked' in turn) {
        blocked.push({ mount: name, reason: turn.blocked });
        guarded.push(name);
        continue;
      }
      proceeded++;
      const pushed = turn.pushed;

      for (const p of pushed.written) allWritten.push({ mount: name, path: p });
      for (const p of pushed.deleted) allDeleted.push({ mount: name, path: p });
      for (const p of pushed.pendingDeletions) pendingDeletions.push({ mount: name, path: p });
      // Refusals ride the same skipped list as branch blocks: divergence must
      // be visible, not resolved silently either way.
      let outside = 0;
      for (const s of pushed.skipped) {
        if (s.reason === OUTSIDE_INCLUDE) { outside++; continue; }
        const reason = s.reason === NOT_PUSHED_IN_OTHER_MOUNT ? this.otherMountNote(name, s.path, 'push') : s.reason;
        blocked.push({ mount: name, reason: `${s.path}: ${reason}` });
      }
      if (outside > 0) passedOver.push({ mount: name, reason: OUTSIDE_INCLUDE, count: outside });
      // Written paths whose mode stayed as disk had it: no refusal, so not
      // among what was skipped.
      for (const k of pushed.modesKept) modesKept.push({ mount: name, ...k });

      // What disk still owes is kept by its evidence, so the watermark and
      // the pin only feed the branch guard. Both are the push's own: what it
      // planned from is what disk now reflects, whatever branch was selected
      // while it wrote. A push that planned nothing (the selected branch
      // changed after its paths were chosen) left disk as it was, so it
      // leaves both as they were too.
      if (pushed.branchId === undefined || pushed.sequence === undefined) continue;
      mount.lastMaterializedSeq = pushed.sequence;
      // Track which branch we materialized on. Re-pin on a clean empty
      // materialize too (previously-pinned mount, nothing pending): disk
      // already reflects the current branch's tree, and leaving the old pin
      // would keep force required forever after a cross-branch materialize
      // that happened to write nothing. A first materialize pins once files
      // of this branch are in place, whether it found them on disk or the
      // evidence shows them there: disk holds this branch's tree.
      if (pushed.written.length > 0 || pushed.unchanged.length > 0 || turn.inPlace || mount.lastMaterializedBranchId !== null) {
        mount.lastMaterializedBranchId = pushed.branchId;
      }
    }

    if (proceeded === 0 && guarded.length > 0 && guarded.length === mountsToMaterialize.length) {
      return {
        success: false,
        error: didNothing('materialize', blocked.map((b) => `mount ${JSON.stringify(b.mount)}: ${b.reason}`).join('; ')),
        isError: true,
      };
    }

    const held = explicit;
    const heldNothing = held !== null && held.relativePath !== '' && !held.mount.direct
      && allWritten.length === 0 && allDeleted.length === 0 && pendingDeletions.length === 0 && blocked.length === 0 && passedOver.length === 0
      && !this.holdsAnythingAt(held.mount, held.relativePath);
    return {
      success: true,
      data: {
        materialized: allWritten,
        count: allWritten.length,
        ...(heldNothing ? { note: `The workspace holds nothing at ${JSON.stringify(`${held.mount.config.name}/${held.relativePath}`)}, so there was nothing to write there.` } : {}),
        ...(allDeleted.length > 0 ? { deleted: allDeleted } : {}),
        ...(pendingDeletions.length > 0
          ? {
            workspaceDeletionsLeftOnDisk: pendingDeletions,
            note: 'Files deleted in the workspace were left on disk; materialize with applyDeletions to remove them.',
          }
          : {}),
        ...(blocked.length > 0 ? { skipped: blocked } : {}),
        ...(passedOver.length > 0 ? { passedOver } : {}),
        ...(modesKept.length > 0 ? { modesKept } : {}),
      },
      // What disk lost, then what it was written: kept in the stub if the
      // guard withholds the result (agent-framework #277). What was left,
      // skipped or written at disk's mode, and why, is in the full result.
      keepWhenWithheld: ['deleted', 'materialized'],
    };
  }

  /**
   * Programmatically materialize a mount's files from Chronicle tree to filesystem.
   * Used after branch switches to refresh filesystem state.
   * Resets branch tracking to allow cross-branch materialization.
   */
  async materializeMount(mountName: string): Promise<string[]> {
    if (!this.running()) return [];
    const store = this.getStore();
    const mount = this.mounts.get(mountName);
    // A direct mount keeps no tree to push: disk is its only copy.
    if (!mount || mount.config.mode === 'read-only' || mount.direct) return [];

    // Reset tracking — we're deliberately materializing on the new branch
    mount.lastMaterializedBranchId = null;
    mount.lastMaterializedSeq = 0;

    // force: this path only runs after a deliberate undo/redo/branch switch
    // on the framework's own _config mount — restoring disk to the branch
    // state IS the operator intent, so the freshness guard yields. named:
    // the whole tree is that deliberate scope, entries without evidence too.
    const pushed = await this.withMount(mount, () => {
      const branchId = store.currentBranch().id;
      return this.pushUnlocked(mount, store.treeList(mount.treeStateId).map((e) => e.path), { force: true, named: true, branchId });
    });
    // A push that planned nothing leaves the reset tracking as it is.
    if (pushed.branchId !== undefined && pushed.sequence !== undefined) {
      mount.lastMaterializedSeq = pushed.sequence;
      if (pushed.written.length > 0 || pushed.unchanged.length > 0) {
        mount.lastMaterializedBranchId = pushed.branchId;
      }
    }
    return pushed.written;
  }

  private async handleSync(input: SyncInput): Promise<ToolResult> {
    const store = this.getStore();
    // A path sync adopts on the branch it was asked on, read before any await.
    const askedOn = store.currentBranch().id;
    const allResults: Array<{
      mount: string;
      synced: string[];
      conflicts: Array<{ path: string; kind: string; diskCopy: string }>;
      /** A path sync's workspace changes given up for disk's state, each with the state it had,
       *  and what that did to the workspace copy (absent when nothing). */
      discarded?: Array<{ path: string; was: string; op?: string }>;
    }> = [];
    const allSkipped: Array<{ mount: string; path: string; reason: string }> = [];
    const allIncomplete: Array<{ mount: string; path: string; reason: string }> = [];
    const allPassedOver: Array<{ mount: string; reason: string; count: number }> = [];
    const allIgnored: Array<{ mount: string; path: string; note: string }> = [];
    const rootsAccepted: string[] = [];
    if (input.acceptRoot && input.path) {
      const named = input.path.split('/')[0]!;
      return {
        success: false,
        isError: true,
        error: didNothing('sync', `acceptRoot takes a whole mount's root, so it isn't given with "path" (${JSON.stringify(input.path)}). `
          + `${this.mounts.has(named) ? `Give "mount" (${JSON.stringify(named)}) with acceptRoot to take that mount's root` : 'Give "mount", naming the mount whose root to take, with acceptRoot'}, or leave acceptRoot out to sync the path.`),
      };
    }

    // A path names its own mount; otherwise the given mount, or every mount.
    let targets: Array<{ name: string; mount: MountState; relativePath: string }>;
    if (input.path !== undefined) {
      if (input.path === '') return { success: false, error: didNothing('sync', this.emptyPathField(input.mount, 'covers every mount')), isError: true };
      const { mount, relativePath, moved, root } = await this.parsePath(input.path);
      // A path outside the mount's include that's no scope (refusesAsOutside)
      // is refused; beneath a directory, the walk passes over what the include
      // doesn't cover.
      if (await this.refusesAsOutside(mount, relativePath, moved, root)) {
        return { success: false, error: didNothing('sync', new OutsideIncludeError(input.path, mount.config).message), isError: true };
      }
      targets = [{ name: mount.config.name, mount, relativePath }];
    } else if (input.mount !== undefined) {
      const m = this.mounts.get(input.mount);
      if (!m) {
        return { success: false, error: didNothing('sync', this.noSuchMountField(input.mount, 'covers every mount')), isError: true };
      }
      targets = [{ name: input.mount, mount: m, relativePath: '' }];
    } else {
      targets = [...this.mounts.entries()].map(([name, mount]) => ({ name, mount, relativePath: '' }));
    }

    for (const { name, mount, relativePath } of targets) {
      // A direct mount's tools read disk as it is, so a sync has nothing to
      // take in there, and says it didn't look rather than that nothing changed.
      if (mount.direct) {
        allSkipped.push({ mount: name, path: relativePath, reason: DIRECT_SYNC_SKIPPED });
        continue;
      }
      let namedDirectory = false;
      const pass = await this.withMount(mount, async () => {
        if (input.acceptRoot && await this.acceptRootUnlocked(mount)) rootsAccepted.push(name);
        if (!relativePath) {
          // A full recheck: every file rehashed, nothing pending discarded.
          // Past the mount's walkCap, it resumes where the last one stopped.
          return this.passUnlocked(mount, { kind: 'dir', dir: '', recursive: true }, { rehash: true, resume: true });
        }
        // An explicit path: the workspace takes disk's state there.
        const prefix = relativePath + '/';
        const isDir =
          await lstat(join(mount.config.path, relativePath)).then((s) => s.isDirectory(), () => false) ||
          store.treeList(mount.treeStateId, prefix).length > 0 ||
          this.agreementOrThrow().paths(name, relativePath).some(([p]) => p.startsWith(prefix)) ||
          this.intents.get(name)!.list(relativePath).some(([p]) => p.startsWith(prefix));
        namedDirectory = (await directoryAt(join(mount.config.path, relativePath), mount.config.followSymlinks === true)) ?? isDir;
        // named: ignore patterns covering the path asked for don't apply
        // beneath it (a directory scope's walk; a path scope doesn't walk).
        const opts: PassOptions = { rehash: true, adopt: () => true, branchId: askedOn, named: true };
        if (!isDir) return this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] }, opts);
        const beneath = await this.passUnlocked(mount, { kind: 'dir', dir: relativePath, recursive: true }, { ...opts, resume: true });
        // Something at the path itself is no part of a directory scope: a file
        // disk has where the workspace holds a directory, or a workspace file
        // where disk has a directory. Its own pass takes disk's state there
        // too, after what lies beneath, so a file never sits over entries it
        // replaced.
        const onDisk = await lstat(join(mount.config.path, relativePath)).catch(() => null);
        const atPath = (onDisk !== null && !onDisk.isDirectory())
          || store.treeGet(mount.treeStateId, relativePath) !== null
          || this.agreementOrThrow().get(name, relativePath) !== undefined
          || this.intents.get(name)!.get(relativePath) !== null;
        if (!atPath) return beneath;
        const itself = await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] }, opts);
        const passedOver = new Map(beneath.passedOver);
        for (const [reason, count] of itself.passedOver) passedOver.set(reason, (passedOver.get(reason) ?? 0) + count);
        return {
          ops: [...beneath.ops, ...itself.ops],
          discarded: [...beneath.discarded, ...itself.discarded],
          newConflicts: [...beneath.newConflicts, ...itself.newConflicts],
          reports: new Map([...beneath.reports, ...itself.reports]),
          incomplete: [...beneath.incomplete, ...itself.incomplete],
          passedOver,
          dirs: beneath.dirs,
          branchId: itself.branchId ?? beneath.branchId,
        };
      });

      const conflicts = [...pass.reports.values()]
        .filter((r) => r.state === 'conflict')
        .map((r) => ({ path: r.path, kind: r.conflict?.kind ?? 'both-changed', diskCopy: r.conflict?.diskCopy ?? 'referenced' }));
      if (pass.ops.length > 0 || conflicts.length > 0 || pass.discarded.length > 0) {
        allResults.push({
          mount: name,
          synced: pass.ops.map((o) => o.path),
          conflicts,
          ...(pass.discarded.length > 0 ? { discarded: pass.discarded } : {}),
        });
      }
      // Say why a path wasn't taken in, so "nothing synced" and "your file was
      // refused" don't look identical from the outside.
      for (const r of pass.reports.values()) {
        if (r.state === 'unverified') {
          allSkipped.push({ mount: name, path: r.path, reason: `disk could not be checked: ${explained(r.note ?? 'not observed', r.noteCause ?? {}, 'sync')}` });
        } else if (r.state === 'disk-only') {
          allSkipped.push({ mount: name, path: r.path, reason: 'disk-only: binary or over the size limit, never stored' });
        }
      }
      for (const region of pass.incomplete) allIncomplete.push({ mount: name, ...region });
      for (const [reason, count] of pass.passedOver) allPassedOver.push({ mount: name, reason, count });
      // A path named explicitly is synced even where the mount's ignore list
      // or an editor's file name covers it, and the result says so: a sync
      // without a path passes over it, so nothing else keeps it current
      // (agent-framework #276). A path in another mount's directory isn't
      // synced at all, and the note says so.
      const passedOver = passedOverAt(relativePath, this.ignoreOf(mount), this.othersOf(name), namedDirectory);
      if (passedOver !== undefined) {
        allIgnored.push({
          mount: name,
          path: relativePath,
          note: passedOver === OTHER_MOUNT
            ? this.otherMountNote(name, relativePath, 'sync')
            : passedOver === IGNORED
              ? 'this mount\'s ignore list covers it, so a sync without a path won\'t maintain it'
              : 'it has an editor\'s swap or backup file name, or lies under one, so a sync without a path won\'t maintain it',
        });
      }
    }

    const named = input.path !== undefined && input.path !== '' ? targets[0]! : null;
    const nothingThere = named !== null && named.relativePath !== '' && !named.mount.direct
      && allResults.every((r) => r.synced.length === 0 && r.conflicts.length === 0 && (r.discarded?.length ?? 0) === 0)
      && allSkipped.length === 0 && allIncomplete.length === 0 && allIgnored.length === 0
      && !this.holdsAnythingAt(named.mount, named.relativePath)
      && await this.absentOnDisk(named.mount, named.relativePath);
    return {
      success: true,
      data: {
        results: allResults,
        ...(nothingThere ? { note: `Neither the workspace nor disk has anything at ${JSON.stringify(`${named.name}/${named.relativePath}`)}, so there was nothing to sync.` } : {}),
        totalSynced: allResults.reduce((sum, r) => sum + r.synced.length, 0),
        totalConflicts: allResults.reduce((sum, r) => sum + r.conflicts.length, 0),
        ...(allSkipped.length > 0 ? { skipped: allSkipped } : {}),
        ...(allIncomplete.length > 0 ? { incomplete: allIncomplete } : {}),
        ...(allPassedOver.length > 0 ? { passedOver: allPassedOver } : {}),
        ...(allIgnored.length > 0 ? { ignored: allIgnored } : {}),
        ...(rootsAccepted.length > 0 ? { rootsAccepted } : {}),
      },
      // What the workspace took from disk, gave up, or now holds as a
      // conflict, per mount, and any root it accepted: kept in the stub if
      // the guard withholds the result (agent-framework #277). What the scan
      // skipped or couldn't see is in the full result.
      // A root it accepted is short and telling: first, so a long results
      // list can't cut it away.
      keepWhenWithheld: ['rootsAccepted', 'results'],
    };
  }

  /**
   * Take the mount's root as it is now (acceptRoot), when it is a directory
   * other than the one disk last agreed under. Its evidence is set aside:
   * it described another directory. Returns whether a root was accepted.
   */
  private async acceptRootUnlocked(mount: MountState): Promise<boolean> {
    const runtime = await this.runtime(mount);
    const found = await locateRoot({ ...runtime.view, rootIdentity: undefined }, runtime.rootReal);
    if ('reason' in found) return false; // still missing: the pass says so
    const agreement = this.agreementOrThrow();
    const recorded = agreement.rootIdentity(mount.config.name);
    if (recorded && sameRootIdentity(recorded, found.identity, found.bornFixed)) return false;
    if (recorded) agreement.acceptRoot(mount.config.name, found.identity);
    else agreement.recordRootIdentity(mount.config.name, found.identity);
    agreement.barrier();
    return true;
  }

  // ==========================================================================
  // Internal: Filesystem Change Handling
  // ==========================================================================

  /**
   * Handle filesystem changes detected by watcher (watch: 'always' mode).
   *
   * The watcher's ops only choose which paths to look at: each path is
   * observed again and decided under the three-way rule, so an event that
   * arrives late or out of order can't delete or revert anything by itself.
   * A path outside the mount (insideMount), such as one its include doesn't
   * cover, is no pass's to decide (gather), so a batch of nothing else takes
   * no turn of the mount.
   */
  private async handleFsChanges(mountName: string, changes: FsChange[]): Promise<void> {
    const mount = this.mounts.get(mountName);
    if (!this.store || !this.running() || !mount) return;
    const paths = [...new Set(changes.map((c) => c.path))].filter((p) => insideMount(p, mount.config.include));
    if (paths.length === 0) return;
    await this.withMount(mount, () => this.passUnlocked(mount, { kind: 'paths', paths }));
  }

  /**
   * After an agent's completed tool batch, before anything continues its turn:
   * scan every `watch: 'on-agent-action'` mount, so what the batch's tools did
   * on disk (a shell command's files, a deletion) is in the workspace when the
   * agent next looks. On a mount over its walkCap, that holds for the first
   * walkCap entries in the walk's order, which every batch's scan takes; files
   * past them come in through syncs, the listings that reach them, and a read
   * of the path, which takes disk's change in first as a listing does. A scan
   * that outlasts the deadline stops holding the round: the miss is recorded on
   * the mount's status and pushed as a `workspace:agent-action-scan-incomplete`
   * event, and the scan continues, deciding on the branch selected when it
   * applies.
   */
  async onToolBatchComplete(_agentName?: string): Promise<void> {
    // Every agent's workspace is the store's current branch, so the agent
    // that ran the batch doesn't choose what is scanned.
    const mounts = [...this.mounts.values()].filter((m) => watchOf(m.config) === 'on-agent-action');
    if (mounts.length === 0 || !this.store || !this.running()) return;
    const deadlineMs = this.agentActionScanDeadlineMs();
    await Promise.all(mounts.map(async (mount) => {
      const runningLate = mount.agentActionScanLate !== undefined;
      const scan = this.agentActionScan(mount);
      if (runningLate) {
        // An earlier batch's scan outlasted its deadline and still runs: this
        // round isn't held as well. Its own scan is queued after that one,
        // and records its outcome when it finishes. It is late from the
        // start, so a batch that comes while it runs isn't held either.
        this.agentActionScanLateUntil(mount, scan);
        this.agentActionScanMissed(mount, 'an earlier scan is still running past its deadline; this batch is scanned after it');
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'late'>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline('late'), deadlineMs);
      });
      const outcome = await Promise.race([scan.settled.then(() => 'done' as const), deadline]);
      clearTimeout(timer);
      if (outcome === 'late') {
        this.agentActionScanLateUntil(mount, scan);
        this.agentActionScanMissed(mount, `deadline exceeded (${deadlineMs} ms); the scan continues`);
      }
    }));
  }

  /**
   * Mark a scan late, and the mount as running late until it settles. The
   * marker follows the newest late scan: a mount's scans run one after
   * another, so the newest is the last to settle, and a batch that comes
   * while any late scan of the chain still runs isn't held.
   */
  private agentActionScanLateUntil(mount: MountState, scan: AgentActionScan): void {
    scan.late = true;
    const settled = scan.settled;
    mount.agentActionScanLate = settled;
    void settled.then(() => { if (mount.agentActionScanLate === settled) mount.agentActionScanLate = undefined; });
  }

  /** A batch's scan missed its deadline, or failed: said on status and as an event. */
  private agentActionScanMissed(mount: MountState, reason: string): void {
    mount.lastAgentActionScan = { at: Date.now(), complete: false, withinDeadline: false, reason };
    this.ctx?.pushEvent({ type: 'workspace:agent-action-scan-incomplete', mount: mount.config.name, reason } as ProcessEvent);
  }

  /**
   * The mount's after-batch scan: one may run and one wait behind it. A batch
   * that comes while one waits shares it, since it starts after the batch's
   * tools ran. Each scan records its own outcome when it settles: on status
   * while it is the mount's newest scan (a scan queued behind it describes a
   * later batch), and as an event for regions it couldn't observe (the file
   * cap, an unreadable or changing region, a branch that kept changing) or a
   * failure, whichever scan it is.
   */
  private agentActionScan(mount: MountState): AgentActionScan {
    if (mount.agentActionScanWaiting) return mount.agentActionScanWaiting;
    const scan: AgentActionScan = { late: false, settled: Promise.resolve() };
    const pass = this.withMount(mount, () => {
      if (mount.agentActionScanWaiting === scan) mount.agentActionScanWaiting = undefined;
      // From the mount's root, keeping no place, as a listing keeps none:
      // on a mount over its walkCap, every batch's scan takes the first
      // walkCap entries in the walk's order, and the place that syncs and
      // catch-up scans resume from stays theirs.
      return this.passUnlocked(mount, { kind: 'dir', dir: '', recursive: true });
    });
    scan.settled = pass.then(
      (result) => {
        if (result.incomplete.length > 0) {
          this.ctx?.pushEvent({
            type: 'workspace:agent-action-scan-incomplete',
            mount: mount.config.name,
            reason: 'the scan finished, but some regions could not be observed',
            incomplete: result.incomplete,
          } as ProcessEvent);
        }
        if (mount.agentActionScanLatest !== scan) return;
        const incomplete = result.incomplete.length > 0 ? { incomplete: result.incomplete } : {};
        mount.lastAgentActionScan = scan.late
          ? { at: Date.now(), complete: true, withinDeadline: false, reason: 'finished after the deadline', ...incomplete }
          : { at: Date.now(), complete: true, withinDeadline: true, ...incomplete };
      },
      (err: unknown) => {
        const reason = `scan failed: ${err instanceof Error ? err.message : String(err)}`;
        if (mount.agentActionScanLatest === scan) this.agentActionScanMissed(mount, reason);
        else this.ctx?.pushEvent({ type: 'workspace:agent-action-scan-incomplete', mount: mount.config.name, reason } as ProcessEvent);
      },
    );
    mount.agentActionScanWaiting = scan;
    mount.agentActionScanLatest = scan;
    return scan;
  }

  /** The scan deadline, kept below the framework's hook bound (warned once). */
  private agentActionScanDeadlineMs(): number {
    const configured = this.config.agentActionScanDeadlineMs ?? AGENT_ACTION_SCAN_DEADLINE_MS;
    if (configured <= AGENT_ACTION_SCAN_DEADLINE_MAX_MS) return configured;
    if (!this.warnedScanDeadline) {
      this.warnedScanDeadline = true;
      console.warn(
        `[workspace] agentActionScanDeadlineMs ${configured} leaves less than 1 s before the framework's ` +
          `${TOOL_BATCH_HOOK_TIMEOUT_MS} ms bound on a tool-batch hook; using ${AGENT_ACTION_SCAN_DEADLINE_MAX_MS} ms`,
      );
    }
    return AGENT_ACTION_SCAN_DEADLINE_MAX_MS;
  }

  /**
   * Push one ProcessEvent per op for a pass's tree changes and new conflicts,
   * apart from an op that changes only a file's mode, which brings nothing
   * new to read and makes none. A conflict rides the event for the disk
   * change behind it (modified, or deleted for a disk deletion of a file with
   * newer workspace changes).
   */
  private emitFsEvents(
    mountName: string,
    ops: Array<{ path: string; op: TreeOp; modeOnly?: true }>,
    newConflicts: Array<{ path: string; op: TreeOp }> = [],
  ): void {
    if (!this.ctx || (ops.length === 0 && newConflicts.length === 0)) return;

    const byOp = new Map<WorkspaceFsOp, { paths: string[]; conflicts: string[] }>();
    const add = (op: TreeOp, path: string, conflict: boolean): void => {
      const group = byOp.get(op) ?? { paths: [], conflicts: [] };
      const full = `${mountName}/${path}`;
      if (!group.paths.includes(full)) group.paths.push(full);
      if (conflict) group.conflicts.push(full);
      byOp.set(op, group);
    };
    // A path whose mode alone changed, on bytes already held, makes no
    // event: it brings nothing new to read, and a `chmod -R` over a tree
    // would otherwise reach every policy that matches its paths.
    for (const { path, op, modeOnly } of ops) if (!modeOnly) add(op, path, false);
    for (const { path, op } of newConflicts) add(op, path, true);

    for (const [op, { paths, conflicts }] of byOp) {
      const event = {
        type: opToEventType(op),
        paths,
        mount: mountName,
        ...(conflicts.length > 0 ? { conflicts } : {}),
      } as WorkspaceCreatedEvent | WorkspaceModifiedEvent | WorkspaceDeletedEvent;
      this.ctx.pushEvent(event as ProcessEvent);
    }
  }

}

/**
 * A text grep searches (textsFromStore, textsFromDisk): its mount-prefixed
 * file, which copy it is, on a 'chronicle' mount the path's state, and its
 * bytes, whose lines grep matches as read shows them (fileText).
 */
interface GrepText {
  file: string;
  state?: string;
  version: 'workspace' | 'conflicting-disk' | 'recorded-disk' | 'disk';
  bytes: Buffer;
}

/** A file, or a copy of one, grep doesn't search, with why. */
type GrepSkip = { file: string; reason: string; size?: number; mimeType?: string };

/** What a listing shows of a directory scope (listingOf). */
interface Listing {
  /** Each file it shows, by mount-relative path, in order, with what a listing says of it beyond its name. */
  files: Array<{ path: string } & Record<string, unknown>>;
  /** For a listing that doesn't descend, the directories directly beneath the scope, mount-relative; none for one that does. */
  dirs: string[];
  /** The regions it couldn't see, mount-relative, each with why. */
  incomplete: Array<{ path: string; reason: string }>;
}

/**
 * Run `work` on each item, at most `width` at once, and hand each result to
 * `each` in the items' order, as soon as it and those before it are done.
 * A result handed on is let go, so what's held at once is at most `width`
 * results, as a direct grep's file contents are. A `work` that rejects
 * rejects this when its turn comes; any started after it finish unheard.
 * Exported for its tests.
 */
export async function inOrder<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>, each: (result: R, item: T) => void): Promise<void> {
  const waiting: Array<Promise<R>> = [];
  let started = 0;
  for (let i = 0; i < items.length; i++) {
    while (started < items.length && started < i + width) {
      const running = work(items[started]!);
      // Handled from the start, so a rejection that comes before its turn
      // isn't an unhandled one; awaiting it below still throws it.
      running.catch(() => {});
      waiting.push(running);
      started++;
    }
    each(await waiting.shift()!, items[i]!);
  }
}

/** read_image's answer for an image, wherever it was read from. */
function imageResult(path: string, image: { bytes: Buffer; mimeType: SupportedImageMimeType }, note?: string): ToolResult {
  return {
    success: true,
    data: [
      {
        type: 'text',
        text: `Path: ${path}\nMIME: ${image.mimeType}\nBytes: ${image.bytes.byteLength}${note === undefined ? '' : `\n${note}`}`,
      },
      {
        type: 'image',
        data: image.bytes.toString('base64'),
        mimeType: image.mimeType,
      },
    ],
  };
}

/** What a listing shows of a path beyond its name. */
function stateView(report: PathReport): Record<string, unknown> {
  return {
    state: report.state,
    ...(report.size !== undefined ? { size: report.size } : {}),
    ...(report.mimeType ? { mimeType: report.mimeType } : {}),
    ...(report.conflict ? { conflict: report.conflict } : {}),
    ...(report.note ? { note: report.note } : {}),
  };
}

// ==========================================================================
// Utilities
// ==========================================================================

/** A lone UTF-16 surrogate, which UTF-8 can't store: in `u` mode, a pair is one code point. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Why a direct mount's read stopped when it found another directory put at its root as it opened the file. */
const DIRECT_ROOT_REPLACED = 'the mount root was replaced as the file was opened: reading it again reads the directory there now';

/**
 * How the alert that a mount configured direct runs as 'chronicle' names an
 * intent the workspace can't read. A sync of its path settles it, with
 * disk's copy, or with none where disk has none, and where disk's file
 * can't be read it skips the path and says why. Materialize settles one
 * only where the workspace holds a copy there: a plain one skips it and says
 * to sync, a forced one writes the copy, and where the workspace holds none
 * it neither selects nor names it.
 */
const UNREADABLE_INTENT = "its workspace intent can't be read; a sync of the path settles it or says why not";

/**
 * A mount's watch mode as it runs. A mount configured direct watches
 * nothing, whichever kind it runs as this session: its config takes no
 * other mode (directRefusals), and leaving it out means 'never' there.
 */
function watchOf(config: MountConfig): 'always' | 'on-agent-action' | 'never' {
  return config.watch ?? (config.backend === 'direct' ? 'never' : 'always');
}

/**
 * Why a write, edit, deletion or peer module's writeBinary to this mount is
 * refused, or null where it may go ahead: a read-only mount, and a mount
 * configured direct that runs as 'chronicle' this session (chooseKinds),
 * since the store holds changes there that disk lacks. A write there would
 * stay in the store, beside an agent told the mount is its checkout, and
 * add to what keeps it off direct; refused, what's held only shrinks, and
 * the next start once none is held runs it direct.
 */
function writeRefusal(mount: MountState, writable: readonly string[] = []): string | null {
  const name = mount.config.name;
  if (mount.config.mode === 'read-only') {
    return `mount "${name}" is read-only. ${onlyTheHost('make it read-write')}`
      + (writable.length > 0 ? ` The mounts that take writes are ${listed(writable.map((other) => JSON.stringify(other)))}.` : '');
  }
  if (mount.config.backend === 'direct' && !mount.direct) {
    return `mount "${name}" is configured direct, and runs as 'chronicle' this session because its start found the store holding changes there that disk lacks, `
      + `so it takes no writes this session, and calling again is refused the same way. To run it direct again, settle what's held `
      + `(sync each held path to take disk's copy, or materialize mount "${name}" by name to write the store's copies to disk), and the host's next start runs it direct.`;
  }
  return null;
}

/**
 * What a direct mount's config sets that would never act there, each with
 * the way out (MountConfig.backend): a direct mount has no watcher to tune,
 * no change event to wake on and no push to make. Either mode is its own.
 */
function directRefusals(mount: MountConfig): string[] {
  const refused: string[] = [];
  if (mount.watch !== undefined && mount.watch !== 'never') refused.push(`watch ${shownValue(mount.watch)} would watch nothing (leave it out, or set 'never')`);
  for (const key of ['watchDebounceMs', 'watchRootPollMs'] as const) {
    if (mount[key] !== undefined) refused.push(`${key} would tune no watcher (leave it out)`);
  }
  const wake = mount.wakeOnChange;
  if (wake === true || (Array.isArray(wake) && wake.length > 0)) refused.push('wakeOnChange would never wake (leave it out)');
  if (mount.autoMaterialize === true) refused.push('autoMaterialize would never push (leave it out)');
  return refused;
}

/**
 * An agent's latest direct write on a mount, P: the store's branch, and its
 * head when the write landed (`after`); and the id of the message that last
 * told the agent its history no longer holds P, N, or null.
 */
interface DirectHead {
  branchId: string;
  after: number;
  notice: string | null;
}

/** A store position: a branch and its head. */
type DirectPosition = Pick<DirectHead, 'branchId' | 'after'>;

/** The global record type directHeads is saved as: a checkpoint at a clean stop that changed it. */
const DIRECT_HEADS_RECORD_TYPE = 'workspace/direct-heads';

/** One mount's positions at one root (resolved, as DiskAgreement keeps a root), by agent, with N only where it's set. */
interface DirectHeadsEntry {
  mount: string;
  root: string;
  agents: Record<string, { branchId: string; after: number; notice?: string }>;
}

/** directHeads as saved: an entry per mount and root its agents wrote direct under. */
type DirectHeadsSnapshot = DirectHeadsEntry[];

/**
 * A saved record as saveDirectHeads writes it, or a throw naming what isn't:
 * a list of entries, each a mount's name, root and agents, and each agent's
 * branch, head and, where set, notice. Checked whole, carried entries
 * included, so a record of another shape is refused at load rather than
 * carried into the next save.
 */
function checkedHeads(value: unknown): DirectHeadsSnapshot {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!Array.isArray(value)) throw new Error("the record isn't of the shape saved");
  for (const saved of value as unknown[]) {
    if (!isObject(saved) || typeof saved.mount !== 'string' || typeof saved.root !== 'string' || !isObject(saved.agents)) {
      throw new Error(`an entry isn't of the shape saved: ${JSON.stringify(saved)?.slice(0, 200)}`);
    }
    for (const [agent, head] of Object.entries(saved.agents)) {
      if (!isObject(head) || typeof head.branchId !== 'string' || typeof head.after !== 'number'
        || (head.notice !== undefined && typeof head.notice !== 'string')) {
        throw new Error(`agent ${JSON.stringify(agent)}'s position on mount ${JSON.stringify(saved.mount)} isn't of the shape saved`);
      }
    }
  }
  return value as DirectHeadsSnapshot;
}

/** A saved record's content, whatever order its mounts and agents were written in, to tell whether a save would change it. */
function canonicalHeads(snapshot: DirectHeadsSnapshot): string {
  return JSON.stringify(snapshot.map(({ mount, root, agents }) => [mount, root, Object.keys(agents).sort().map((agent) => {
    const { branchId, after, notice } = agents[agent]!;
    return [agent, branchId, after, notice ?? null];
  })]).sort((a, b) => {
    const [x, y] = [JSON.stringify(a.slice(0, 2)), JSON.stringify(b.slice(0, 2))];
    return x < y ? -1 : x > y ? 1 : 0;
  }));
}

/**
 * How many times a direct edit reads and plans a file another writer keeps
 * changing: enough to land on top of a writer that changes it now and then,
 * such as a formatter or a build, and bounded for one that never stops.
 */
const DIRECT_EDIT_ATTEMPTS = 3;

/** Why a direct write, edit or deletion did nothing, for its answer: a refusal's words, or any other failure's message. */
function directReason(error: unknown): string {
  if (error instanceof FileChanged) return 'it changed on disk while this call was being applied';
  // A deletion's root check (unlinkContained) has a store-backed mount's
  // words, whose remedy, a sync with acceptRoot, a direct mount has no use for.
  if (error instanceof Error && error.message === ROOT_REPLACED) return ROOT_MOVED;
  return error instanceof Error ? error.message : String(error);
}

function directWayOn(error: unknown): string | null {
  if (error instanceof FileChanged) return 'Calling again reads it afresh.';
  if (error instanceof WriteRefused) return error.wayOn;
  if (error instanceof EffectFailed) {
    if (error.detail.errno !== undefined) return errnoWayOn(error.detail.errno);
    if (error.detail.again === true) return 'Calling again checks it afresh.';
  }
  return null;
}

function directDidNothing(tool: string, path: string, error: unknown): string {
  const on = directWayOn(error);
  return didNothing(tool, `${directReason(error)}.${on !== null ? ` ${on}` : ''}`, path);
}

/** "a", "a and b", or "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The note for a direct write that gave a hard-linked path a file of its
 * own: the other links keep the old text. Null for a file with none.
 */
function linksNote(path: string, staged: Staged, tool: 'write' | EditTool): string | null {
  const n = staged.otherLinks;
  if (n <= 0) return null;
  return `${path} had ${n === 1 ? 'another hard link' : `${n} other hard links`}, which ${n === 1 ? 'keeps' : 'keep'} its old text: `
    + `the ${tool === 'write' ? 'write' : tool === 'edit' ? 'edit' : 'call'} gave this path a file of its own.`;
}

/**
 * A refusal of openContainedFile's as a direct tool gives it: its message,
 * and for one that names only the path, its errno too, as a direct read's
 * answer gives it (bytesOnDisk).
 */
function containedRefusal(err: unknown, path: string): string {
  const bare = err instanceof WorkspaceReadError && err.errno !== undefined && err.message === `Unable to read file: ${path}`;
  return bare ? `${err.message} (${errnoWords(err.errno)})` : err instanceof Error ? err.message : String(err);
}

function deletedOnDisk(path: string): string {
  return `there's no file at ${JSON.stringify(path)} any more: disk's copy was deleted since the workspace last agreed with it, and the workspace took that in first. ls or glob lists the files that exist.`;
}

function uncheckedFile(shown: string, note: string | undefined, cause: Cause): string {
  if (note === DIRECTORY) return `${shown} is a directory, not a file; ls ${shown} lists what's in it.`;
  const on = note === ROOT_REPLACED || note === ROOT_ON_ANOTHER_DEVICE || cause.ownStep === true ? null
    : (note === undefined ? null : wayOn(note, cause, 'read')) ?? 'calling again checks disk again; if the same reason comes back, whoever runs this host can fix it on disk';
  return `${shown} isn't in the workspace, and disk couldn't be checked: ${sentence(note ?? 'not observed')}${on !== null ? ` ${on[0]!.toUpperCase()}${sentence(on.slice(1))}` : ''}`;
}

function namesRoot(path: string, mount: string): string {
  return `${JSON.stringify(path)} names the root of mount "${mount}", which isn't a file; ls "${mount}" lists the files in it.`;
}

function tooLargeToWrite(path: string, bytes: number, maxSize: number): string {
  return pastSizeLimit(`${JSON.stringify(path)} would be ${bytes.toLocaleString('en-US')} bytes`, maxSize, "the workspace couldn't keep it", 'Content within the limit is written.');
}

function pastSizeLimit(what: string, maxSize: number, outcome: string, within: string | null): string {
  return `${what}, past the ${maxSize.toLocaleString('en-US')}-byte limit this mount sets on a file, so ${outcome}.${within !== null ? ` ${within}` : ''} `
    + "The limit is the mount's maxFileSize setting, which only whoever runs the host can change.";
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function unreadable(shown: string, errno: string | undefined): string {
  return `${shown} can't be read from disk: ${errnoWords(errno)}. ${errnoWayOn(errno)}`;
}

function readRefusal(err: WorkspaceReadError, path: string): string {
  const shown = JSON.stringify(path);
  if (err instanceof RootUnavailable) {
    if (err.refusal) return err.refusal.message;
    const mount = JSON.stringify(err.mount);
    if (err.reason === ROOT_UNAVAILABLE || err.reason === null) {
      if (err.errno === 'ENOENT' || err.errno === 'ENOTDIR') {
        return `the directory of mount ${mount} isn't on disk, so nothing in it can be read. ${onlyTheHost("put the mount's directory back at its path")}`;
      }
      if (err.errno !== undefined) {
        return `the directory of mount ${mount} can't be read: ${errnoWords(err.errno)}. `
          + errnoWayOn(err.errno, ROOT_RECHECK, true);
      }
      return `the directory of mount ${mount} can't be checked at its path, so nothing in it can be read. ${ROOT_RECHECK}`;
    }
    return `${shown} can't be read: ${sentence(err.reason)}`;
  }
  if (err instanceof LinkOnTheWay) return `${shown} can't be reached: ${sentence(err.reason)}`;
  switch (err.code) {
    case 'directory':
      return `${shown} is a directory, not a file; ls ${shown} lists what's in it.`;
    case 'symlink':
      return `${shown} is a symlink, and its mount doesn't follow symlinks, so the workspace's tools don't go through it. `
        + `Calling again won't change that; ${UNFOLLOWED_STEP}.`;
    case 'escape':
      return `${shown} leads through a symlink to a place outside its mount, so the workspace's tools don't reach it. `
        + `Calling again won't change that; ${MOUNT_IT}.`;
    case 'changed':
      return `${shown} changed on disk while it was being read. Calling again reads it afresh.`;
    case 'not_found':
      if (err.errno === 'ENOENT' || err.errno === 'ENOTDIR') return `there's no file at ${shown}. ls or glob lists the files that exist.`;
      if (err instanceof NotRegularFile) {
        return `${shown} isn't a regular file (it's a pipe, a socket or a device), so the workspace doesn't read it. ${onlyTheHost('put a regular file there')}`;
      }
      if (err.stage === 'realpath') return `where ${shown} leads on disk can't be resolved: ${errnoWords(err.errno)}. ${errnoWayOn(err.errno)}`;
      return unreadable(shown, err.errno);
    default:
      return sentence(err.message);
  }
}

type LostContents = {
  path: string;
  store: Exclude<StoredBytes, { bytes: Buffer }>;
  disk: 'other' | 'none' | { unreadable: string };
  writable: boolean;
  reopen: boolean;
};

function contentsSubject(what: 'saved' | 'conflict-disk', path: string): string {
  return what === 'saved' ? `the saved contents of ${path}` : `the version of ${path} that its conflict recorded as disk's`;
}

function inTheStore(stored: Exclude<StoredBytes, { bytes: Buffer }>): string {
  return 'missing' in stored ? "missing from the workspace's store" : `unreadable in the workspace's store (${stored.unreadable})`;
}

function lostInStore(lost: Pick<LostContents, 'store'>): string {
  return 'missing' in lost.store ? 'missing from the store' : `unreadable in the store (${lost.store.unreadable})`;
}

function lostOnDisk(lost: LostContents): string {
  return lost.disk === 'other' ? "disk's copy holds other contents"
    : lost.disk === 'none' ? 'disk has no copy'
      : `disk's copy can't be read (${lost.disk.unreadable})`;
}

function lostText(lost: LostContents, the: 'The' | 'the' = 'The'): string {
  return `${the} workspace's copy of ${lost.path} is ${lostInStore(lost)}, and ${lostOnDisk(lost)}`;
}

function nothingToRead(lost: LostContents): string {
  return `${lostText(lost, 'the')}, so it can't be restored or read. ${lostRemedy(lost)}`;
}

function lostRemedy(lost: LostContents): string {
  const after = remedyOfLost(lost);
  if (!lost.reopen) return after;
  return "Nothing you do clears this until the workspace's store is reopened, and calling again won't change that; whoever runs this host can reopen it with a restart. "
    + `After that, ${after.charAt(0).toLowerCase()}${after.slice(1)}`;
}

function remedyOfLost(lost: LostContents): string {
  const rewrite = lost.writable && 'missing' in lost.store;
  if (lost.disk === 'other') return `Sync the path to keep disk's copy and give up the workspace's${rewrite ? ', or write the file again' : ''}.`;
  if (lost.writable) return rewrite ? 'Write the file again, or delete it.' : 'Delete the file to clear it.';
  return lost.disk === 'none'
    ? "Sync the path to take disk's deletion, which removes the workspace's copy."
    : "Once disk's copy can be read, read the file again, which reads it from disk's copy if that copy has the same contents, or sync the path to keep disk's copy and give up the workspace's.";
}

/**
 * The notice that writes an agent made direct remain on disk from
 * turns the agent's history no longer holds. `git status` stands beside
 * `git diff` because a departed turn's new file is untracked, which `git
 * diff` doesn't show; and the warning says "unstaged", since `git checkout
 * -- <file>` puts back a file's staged text, so a staged change survives it.
 */
function headMoveText(mounts: readonly string[]): string {
  const one = mounts.length === 1;
  return `[${NOTICE_TAG.workspace}] Writes to ${listed(mounts.map((name) => `\`${name}\``))} from turns the history no longer holds are still on disk. `
    + `If ${one ? "it's a git checkout" : "they're git checkouts"}, \`git status\` and \`git diff\` show them; `
    + 'a `git checkout` of a file drops every unstaged change in it, including the ones the history still holds.';
}

/** A change commitToolChanges makes to one path's tree entry. */
type ToolChange = { kind: 'set'; blobHash: string; size: number; mode?: number } | { kind: 'remove'; previousHash: string };

/** A file an edit or edit_many call edits: one stored path, and every edit naming it. */
interface EditTarget {
  /** Its path in its mount, as disk spells it: the store's key for it. */
  relativePath: string;
  /** Its mount-prefixed path as disk spells it, which its answer uses. */
  path: string;
  /** Every edit naming it, by index, and the specs of those fit to be matched. */
  edits: number[];
  specs: EditSpec[];
}

/**
 * One file's edits planned against its bytes, as both kinds of mount plan
 * them: its text decoded, every edit matched in it (edit-plan.ts), and the
 * result held to the mount's size limit. Each problem found goes into
 * `problems`, and then, as for a file named only by edits whose own input
 * was refused, there's no plan (null).
 */
function planTargetEdits(
  tool: EditTool,
  target: EditTarget,
  bytes: Buffer,
  hints: ReturnType<typeof hintBudget>,
  maxSize: number,
  counts: ReturnType<typeof countBudget>,
  problems: EditProblem[],
): FilePlan | null {
  // Decoding would turn each invalid sequence into U+FFFD, and writing
  // the text back would change bytes the edits never named.
  const file = decodeForEdit(bytes);
  if (!file) {
    problems.push({
      kind: 'file',
      edits: target.edits,
      path: target.path,
      text: `${target.path} isn't valid UTF-8, so editing it would change bytes outside the text it replaces. `
        + 'Read shows each invalid byte sequence as U+FFFD, and a write replaces the whole file as UTF-8, so writing back what read shows puts U+FFFD in their place.',
      whole: false,
    });
    return null;
  }
  if (!target.specs.length) return null;
  const planned = planFile(file, bytes, target.specs, hints, maxSize, counts);
  if ('problems' in planned) {
    // One at a time: a call of many edits can have more problems
    // than a spread passes as arguments.
    for (const problem of planned.problems) problems.push({ ...problem, path: target.path });
    return null;
  }
  // The planner refuses a file its counts take past the limit before
  // building it, from the least its bytes can be; one it built past
  // the limit, as its CRs or multi-byte characters can take it, is
  // refused here.
  if ('tooLarge' in planned || planned.plan.bytes.length > maxSize) {
    const size = 'tooLarge' in planned ? `at least ${planned.tooLarge.toLocaleString('en-US')}` : planned.plan.bytes.length.toLocaleString('en-US');
    problems.push({
      kind: 'file',
      edits: target.edits,
      path: target.path,
      text: pastSizeLimit(`${target.path} would be ${size} bytes with ${tool === 'edit' ? 'this edit' : editList(target.edits)}`, maxSize,
        "the workspace couldn't keep it", 'An edit that leaves the file within the limit applies.'),
      whole: false,
    });
    return null;
  }
  return planned.plan;
}

/**
 * Whether a tree entry is what a change leaves: for a set, an entry with its
 * blob, size and mode; for a removal, none.
 */
function holds(entry: ReturnType<JsStore['treeGet']>, change: ToolChange): boolean {
  return change.kind === 'set'
    ? entry !== null && entry.blobHash === change.blobHash && entry.size === change.size && entry.mode === (change.mode ?? 0o644)
    : entry === null;
}

/**
 * Whether a store's set that threw recorded the changes anyway: every path
 * holds what its change leaves. The changes given are those the tree didn't
 * hold before the set, and one record takes all of them or none, so their
 * holding shows the record is in. Reading them back can fail too, and then
 * whether they're stored isn't known (CommitUnknownError).
 */
function changesLanded(
  store: JsStore,
  treeStateId: string,
  changes: Array<{ path: string; change: ToolChange }>,
  setError: unknown,
): boolean {
  try {
    return changes.every(({ path, change }) => holds(store.treeGet(treeStateId, path), change));
  } catch (readError) {
    throw new CommitUnknownError(setError, readError);
  }
}

/**
 * A store's set threw, and reading its entries back threw too, so whether the
 * change is stored isn't known. Its message says so after both errors.
 */
class CommitUnknownError extends Error {
  constructor(readonly setCause: unknown, readonly readCause: unknown) {
    const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
    super(`${text(setCause)}; reading its entries back failed too (${text(readCause)}), so whether the change is stored isn't known`);
    this.name = 'CommitUnknownError';
  }
}

function storeWords(error: unknown): string {
  const code = errnoCode(error);
  return code !== undefined ? errnoWords(code) : cutLine(error instanceof Error ? error.message : String(error));
}

class NotStored extends Error {
  constructor(readonly thrown: unknown) {
    super('stopped before the change was stored');
  }
}

class AlreadyHeld extends Error {
  constructor(readonly thrown: unknown) {
    super(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

function notStored(error: unknown): unknown {
  return error instanceof Refusal || error instanceof WorkspaceReadError || error instanceof CommitUnknownError || error instanceof AlreadyHeld || error instanceof NotStored
    ? error : new NotStored(error);
}


/**
 * A store's set that threw after recording the change (changesLanded): the
 * entries are set and their intents follow, and the store's error goes on in
 * place of the push. `pushes` says whether the mount would have pushed the
 * change to disk, and `notes` are commitToolChanges' own, by path.
 */
class StoredThenFailed extends Error {
  constructor(storeError: unknown, readonly pushes: boolean, readonly notes: Map<string, string>) {
    super(storeError instanceof Error ? storeError.message : String(storeError));
    this.name = 'StoredThenFailed';
  }
}

const ONCE_REOPENED = ', once the store is reopened';

const DISK_ORDER: DiskState[] = ['in conflict with disk', 'waits for materialize with applyDeletions', 'waits for materialize', 'done'];

function furthestFromDisk(values: DiskState[]): DiskState {
  return DISK_ORDER.find((state) => values.includes(state)) ?? 'done';
}

/**
 * The answer to a write, edit or delete that the workspace stored but
 * couldn't finish: its push to disk didn't complete, or what follows the tree
 * entry threw. It stays an error, since part of the call failed, but it leads
 * with what the caller must know before acting on it: the change is stored,
 * and sending it again could apply it twice. The push's reason says what disk
 * holds and the way out, as materialize takes it. The text carries all of it,
 * since an error's data reaches neither the model nor a code_execution
 * script. A note comes last: an edit's on which copy it applied to, or a
 * deletion's that it unlinked nothing.
 */
function storedButUnfinished(
  tool: 'write' | 'edit' | 'delete',
  path: string,
  outcome: { refused: string } | { threw: string } | { storeFailed: string; pushes: boolean },
  note: string | null = null,
  reopen = false,
): ToolResult {
  const change = tool === 'delete' ? 'deletion' : tool;
  const stored = `The ${change} of "${path}" is stored in the workspace, so don't send it again`
    + (tool === 'edit' ? ': a second edit can apply the change twice.' : '.');
  const rest = 'refused' in outcome
    ? ` Its push to disk didn't complete: ${outcome.refused}.`
    : 'storeFailed' in outcome
      ? ` The store failed after recording it: ${outcome.storeFailed}.` + (!outcome.pushes ? ''
        : tool === 'delete'
          ? ` Its push to disk didn't run, so disk keeps the file until a materialize of the path with applyDeletions deletes it${reopen ? ONCE_REOPENED : ''}.`
          : ` Its push to disk didn't run, so disk lacks the change until a materialize of the path writes it${reopen ? ONCE_REOPENED : ''}.`)
      : ` The rest of the call failed: ${outcome.threw}.${reopen ? '' : " ls shows the path's state."}`;
  return { success: false, isError: true, error: stored + rest + (reopen ? ` ${AWAITS_REOPEN}` : '') + (note !== null ? ` ${note}` : '') };
}

/**
 * What a read says about the copy it shows, when that isn't simply the one the
 * workspace last agreed on with disk: disk's newer text, taken in first; the
 * workspace's copy, because disk's couldn't be checked or disk has none that
 * anything accounts for; or a draft in conflict with disk's change. A file
 * the workspace didn't hold has no older copy, so taking it in needs no word.
 * A conflict's note names the ways to settle it that work on the path's mount.
 */
function whichCopyRead(report: PathReport | undefined, tookChange: boolean, readOnly: boolean): string[] {
  if (tookChange) {
    return ['Disk\'s copy had changed since the workspace last agreed with it, so it was taken in first, and this read shows that text.'];
  }
  if (report?.state === 'unverified') {
    return [`The path couldn't be checked against disk (${report.note ?? 'not observed'}), so this read shows the workspace's copy.`];
  }
  if (report?.state === 'disk-missing-provenance-unknown') {
    return ['Disk has no copy of this file, and nothing records whether it was deleted there, so this read shows the workspace\'s copy.'];
  }
  if (report?.state === 'conflict') {
    const kind = report.conflict?.kind ?? 'both-changed';
    // A sync takes disk's state as it is now, which a recorded conflict's kind
    // doesn't follow: where disk has no copy, the sync takes its deletion, and
    // the workspace's copy goes with it. Where disk has one, the sync keeps it
    // and gives up the workspace's, taking disk's in only where the workspace
    // can hold it (not binary or too large). A read-only mount can hold a
    // copy disk doesn't, such as one a branch switch selected, but a
    // materialize, forced or not, writes nothing to it.
    const settle = settleConflict(report.diskNow, readOnly);
    return [`The path is in conflict with disk (${kind}): this read shows the workspace's copy. ${settle[0]!.toUpperCase()}${settle.slice(1)}`];
  }
  return [];
}

function settleConflict(diskNow: PathReport['diskNow'], readOnly: boolean): string {
  const sync = diskNow === 'absent'
    ? 'sync the path to take disk\'s deletion, which removes the workspace\'s copy'
    : 'sync the path to keep disk\'s copy and give up the workspace\'s';
  const force = readOnly
    ? '. The mount is read-only, so nothing writes the workspace\'s copy to disk.'
    : diskNow === 'absent'
      ? ', or materialize it with force to write the workspace\'s copy back to disk.'
      : ', or materialize it with force to write the workspace\'s over disk\'s.';
  return `${sync}${force}`;
}

/**
 * The least each tool's whole-number fields may be, beside their schemas,
 * whose type (membrane's ToolParameter) has no `minimum`.
 */
const INPUT_MINIMUMS: Record<string, Record<string, number>> = {
  read: { offset: 1, limit: 1, offsetChars: 0, limitChars: 1 },
  grep: { contextBefore: 0, contextAfter: 0 },
  edit_many: { occurrences: 1 },
};

/**
 * Why a tool call's input doesn't fit its tool's schema, or null when it does:
 * an object, each required field present, and each field its schema calls a
 * string, a boolean or an integer of that type, an integer at least its
 * minimum. A field it calls an array of objects is an array, and each of its
 * items is checked the same way against the items' schema, with the same
 * minimums (edit_many's edits). The workspace's schemas use no other types.
 * Without it, an edit missing `newString` wrote the word "undefined", and an
 * offset of 1.5 numbered lines 1.5, 2.5 and on. A field the schema doesn't
 * describe is left to its handler.
 */
function inputProblem(
  schema: { properties?: Record<string, unknown>; required?: string[] },
  input: unknown,
  minimums: Record<string, number> = {},
): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'its input must be an object of the fields its schema lists';
  }
  const fields = input as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (fields[name] === undefined) return `"${name}" is required`;
  }
  for (const [name, value] of Object.entries(fields)) {
    const property = schema.properties?.[name] as { type?: string; items?: { type?: string } } | undefined;
    const type = property?.type;
    if (value === undefined || type === undefined) continue;
    const minimum = minimums[name];
    const fits = type === 'string' ? typeof value === 'string'
      : type === 'boolean' ? typeof value === 'boolean'
      : type === 'integer'
        ? Number.isSafeInteger(value) && (minimum === undefined || (value as number) >= minimum)
      : type === 'array' ? Array.isArray(value)
        : true;
    if (fits && type === 'array' && property?.items?.type === 'object') {
      for (const [i, item] of (value as unknown[]).entries()) {
        const problem = item !== null && typeof item === 'object' && !Array.isArray(item)
          ? inputProblem(property.items as Parameters<typeof inputProblem>[0], item, minimums)
          : 'it must be an object of the fields its schema lists';
        if (problem !== null) return `"${name}" item ${i + 1}: ${problem}`;
      }
    }
    if (!fits) {
      const wanted = type === 'string' ? 'a string'
        : type === 'boolean' ? 'true or false'
        : type === 'array' ? 'an array'
        : minimum === undefined ? 'a whole number' : `a whole number of at least ${minimum}`;
      const got = value === null ? 'null'
        : typeof value === 'number' ? String(value)
        : Array.isArray(value) ? 'an array'
        : typeof value === 'object' ? 'an object'
        : `a ${typeof value}`;
      return `"${name}" must be ${wanted}, not ${got}`;
    }
  }
  return null;
}

/** How many files a grep note names before it gives the count of the rest. */
const NOTE_FILES_MAX = 20;

/**
 * The files a grep note names, in the order grep searched them, as its
 * results are: at most NOTE_FILES_MAX of them, then how many more and how to
 * see them. Each is named by its mount-prefixed path, with what `detail` says
 * of it.
 */
function namedFiles<T>(files: Map<string, T>, detail: (value: T) => string): string {
  const names = [...files.keys()];
  const shown = names.slice(0, NOTE_FILES_MAX).map((name) => `${name}${detail(files.get(name)!)}`);
  const rest = names.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `, and ${rest} more; narrow with path or glob` : ''}`;
}

/** What a note says of a conflict's disk version, which read doesn't show. */
const ofVersion = (version: GrepText['version']): string =>
  version === 'conflicting-disk' || version === 'recorded-disk' ? ` in its ${version} version` : '';

/**
 * grep's note for a pattern that names a character its lines leave out, where
 * a file it searched has one: it says how many files searched have it and
 * names them, so a search for a CR or a BOM still finds the files that have
 * them. The CR note gives each file's ends, CRLF or mixed, and either note
 * names a conflict's disk version as that version. The note says a
 * character read shows it in the workspace's copy, since grep also searches a
 * conflict's disk version, which read doesn't show. A direct mount keeps no
 * workspace copy, and its read shows disk's file, so on a host with one
 * (`direct`) the note names that too, as the tools' descriptions mention
 * direct mounts only on such a host.
 */
function leftOutNote(
  pattern: string,
  crlfFiles: Map<string, { ends: 'CRLF' | 'mixed'; version: GrepText['version'] }>,
  bomFiles: Map<string, GrepText['version']>,
  direct: boolean,
): { note?: string } {
  if (crlfFiles.size === 0 && bomFiles.size === 0) return {};
  const named = namedLeftOut(pattern);
  const onDisk = direct ? ', or in disk\'s file on a direct mount' : '';
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? `file searched ${one}` : `files searched ${many}`}`;
  const notes = [
    named.cr && crlfFiles.size > 0
      ? `The pattern names a CR, and ${count(crlfFiles.size, 'has', 'have')} CRLF line ends: `
        + `${namedFiles(crlfFiles, ({ ends, version }) => ` (${ends}${ofVersion(version)})`)}. Lines are matched as read shows them, `
        + `which leaves out a CRLF end's CR unless the line's own text ends in a CR. read with offsetChars shows every CR in the workspace's copy${onDisk}.`
      : null,
    named.bom && bomFiles.size > 0
      ? `The pattern names U+FEFF, and ${count(bomFiles.size, 'starts', 'start')} with a BOM: `
        + `${namedFiles(bomFiles, (version) => (ofVersion(version) ? ` (${ofVersion(version).slice(1)})` : ''))}. Lines are matched as read shows them, `
        + `and a BOM isn't part of the first line. read with offsetChars shows any BOM ${direct ? `in the workspace's copy${onDisk}` : 'the workspace\'s copy has'}.`
      : null,
  ].filter((n) => n !== null);
  return notes.length ? { note: notes.join(' ') } : {};
}

/**
 * Which of the characters grep's lines leave out a pattern names: a CR, as a
 * literal one or as `\r`, `\x0d`, `\u000d`, `\cM`, `\015` or a backslash
 * before a literal CR; and U+FEFF, as a literal one, `\uFEFF` or a backslash
 * before a literal one. An escape counts only where its backslash isn't itself
 * escaped. A pattern compiled without flags can match a CR other ways too,
 * such as `\15` in a pattern of fewer than 15 groups or a class range that
 * spans U+000D, and those go unnoticed.
 */
function namedLeftOut(pattern: string): { cr: boolean; bom: boolean } {
  const named = { cr: false, bom: false };
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\r') named.cr = true;
    else if (pattern[i] === '\uFEFF') named.bom = true;
    else if (pattern[i] === '\\') {
      const next = pattern.slice(i + 1, i + 6);
      if (/^(?:r|\r|x0[dD]|u000[dD]|c[mM]|015)/.test(next)) named.cr = true;
      else if (/^(?:u[fF][eE][fF][fF]|\uFEFF)/.test(next)) named.bom = true;
      i++;
    }
  }
  return named;
}

/**
 * A glob's reading in the mount its first segment names, in place of the
 * pattern as written there. Every path the tools take and return is
 * mount-prefixed, so `notes/diary/*.md` is the natural way to write a
 * pattern, and tested as written against a mount-relative path it could
 * never match — a glob answered "no matches" for files that were there.
 * `regex` matches the rest of the pattern against the mount-relative path,
 * and `dir` is the rest's literal directory (literalDirOf), from the mount's
 * root. A pattern that names another mount, or none, has no such reading
 * (null), and is read as written, relative to the search root. So in a mount
 * holding a directory named like itself, `work/z/*.ts` names the mount's own
 * `z`, and `work/work/z/*.ts`, as the tools show it, names the directory's.
 * The rest's brace groups are the pattern's, so a pattern globToRegex took
 * doesn't throw here.
 */
function prefixedGlob(pattern: string, mountName: string): { regex: RegExp; dir: string } | null {
  const slash = pattern.indexOf('/');
  if (slash <= 0 || pattern.slice(0, slash) !== mountName) return null;
  const rest = pattern.slice(slash + 1);
  return { regex: globToRegex(rest), dir: literalDirOf(rest) };
}

/**
 * Convert a glob pattern to a RegExp. Throws, naming the pattern, for a brace
 * group it can't read: a "{" that never closes, a group inside another, or a
 * group with no ",".
 */
function globToRegex(pattern: string): RegExp {
  // Split pattern into segments, handling {a,b,c} alternation
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '{') {
      // A brace form this can't read is refused. A `{` that never closes, read
      // as a literal, would almost always answer with no matches, and with it
      // refused, each pass of this loop moves past at least one character. A
      // group closes at the `}` that brings the braces open since its `{` back
      // to none, so a `{` that never closes is named as that, even with a
      // closed group after it. A group inside another would be split at the
      // inner `}`, so `{a,{b,c}}` would match `a}` but not `a`, and a group
      // with no `,` would lose its braces, so `{name}` would match `name` and
      // never a file named `{name}`, and `{1..3}` would match only `1..3`.
      let depth = 0;
      let closeIdx = -1;
      for (let j = i; j < pattern.length && closeIdx < 0; j++) {
        if (pattern[j] === '{') depth++;
        else if (pattern[j] === '}' && --depth === 0) closeIdx = j;
      }
      if (closeIdx < 0) throw new Refusal(braceRefusal(pattern, 'has a "{" with no closing "}"'));
      const group = pattern.slice(i + 1, closeIdx);
      if (group.includes('{')) {
        throw new Refusal(braceRefusal(pattern, 'has a "{" group inside another; put all its alternatives in one group'));
      }
      if (!group.includes(',')) {
        throw new Refusal(braceRefusal(pattern, 'has a "{" group with no ","; a group needs two or more alternatives, separated by ","'));
      }
      // A `/` right after the group goes into each alternative, as `{a,b}/x`
      // and `{a/,b/}x` name the same paths, so an alternative's own `**`
      // meets it and reads as a `**/` does, as in the group's expansion:
      // `{src/**,lib}/*.ts` is `src/**/*.ts` or `lib/*.ts`.
      const slash = pattern[closeIdx + 1] === '/';
      const alternatives = group.split(',').map((alternative) => (slash ? alternative + '/' : alternative));
      regex += '(?:' + alternatives.map(globPartToRegex).join('|') + ')';
      i = closeIdx + (slash ? 2 : 1);
      continue;
    }
    // Accumulate non-brace characters, convert as a chunk
    let chunk = '';
    while (i < pattern.length && pattern[i] !== '{') {
      chunk += pattern[i];
      i++;
    }
    if (chunk) {
      regex += globPartToRegex(chunk);
    }
  }
  return new RegExp(`^${regex}$`);
}

/**
 * The directory a glob pattern names before its first wildcard, beneath
 * which every path it matches lies: its leading segments that hold none of
 * globToRegex's wildcards (`*`, `?`, `{`), short of the last segment, which
 * names the files. '' when the pattern starts with a wildcard or has a
 * single segment. A segment that's empty, `.` or `..`, which no path
 * matched holds, is one no directory listing holds either, so walkStart
 * stops before it.
 */
function literalDirOf(pattern: string): string {
  const dir: string[] = [];
  for (const segment of pattern.split('/').slice(0, -1)) {
    if (/[*?{]/.test(segment)) break;
    dir.push(segment);
  }
  return dir.join('/');
}

/** The deeper of two mount-relative directories, '' being the root, or null when neither holds the other. */
function deeperOf(a: string, b: string): string | null {
  if (a === '' || b === a || b.startsWith(a + '/')) return b;
  if (b === '' || a.startsWith(b + '/')) return a;
  return null;
}

/** A glob's refusal of a brace form it can't read, with the way to match a literal "{". */
function braceRefusal(pattern: string, problem: string): string {
  return `glob pattern ${JSON.stringify(pattern)} ${problem}. To match a "{" in a name, put "?" in its place.`;
}

// What each glob token becomes. A `**/` at the start of a path segment matches
// zero or more whole directories, so `src/**/*.ts` also matches `src/main.ts`;
// any other `**` matches any run of characters.
const GLOB_TOKENS: Record<string, string> = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };

// One part of a pattern, between brace groups or inside one. Whether a `**/`
// at its start starts a path segment depends on what comes before it in the
// path, which after a brace group is whichever alternative matched: so it
// reads as GLOB_TOKENS' `**/` where the path so far is empty or ends with a
// `/`, as in `{src/,lib/}**/`, and otherwise as any run of characters and
// then a directory, as in `draft{s,ing}**/`.
const PART_START_GLOBSTAR = '(?:(?<=^|/)(?:.*/)?|(?<!^|/).*/)';
function globPartToRegex(part: string): string {
  return part.replace(/(?<=^|\/)\*\*\/|\*\*|[*?]|[.+^$()|[\]\\]/g, (m, offset: number) =>
    m === '**/' && offset === 0 ? PART_START_GLOBSTAR : GLOB_TOKENS[m] ?? `\\${m}`);
}
