/**
 * Types for the Workspace module
 */

// ============================================================================
// Mount Configuration
// ============================================================================

/**
 * Configuration for a single filesystem mount.
 */
export interface MountConfig {
  /** Mount name — becomes the path prefix (e.g., "project", "config") */
  name: string;
  /** Absolute filesystem path to mount */
  path: string;
  /** Access mode */
  mode: 'read-write' | 'read-only';
  /**
   * Where the mount's tools get what they read (default: 'chronicle').
   * - 'chronicle': the workspace keeps the mount's files in its store, where
   *   writes and edits land first, and takes in disk's changes under the
   *   three-way rule as `read`, listings, searches, syncs and scans reach
   *   them. Its tools read the store's copy.
   * - 'direct': for a checkout, such as a git one, whose history is its
   *   own. Every read, listing and search is disk's own copy as it is when
   *   it runs, and none of its files go into the store. No scan or watcher
   *   runs, so no call waits behind one, and `sync`, `materialize` and the
   *   watch settings have nothing to act on. Not with `watch` other than
   *   'never', `watchDebounceMs`, `watchRootPollMs`, a `wakeOnChange` that
   *   would wake (true, or a non-empty list) or `autoMaterialize: true`:
   *   each of those would never act, and the workspace refuses the mount.
   *   Writable, as any mount with no `mode` is, its `write`, `edit`,
   *   `edit_many` and `delete` land on disk when they answer, or don't
   *   happen: a file is staged beside itself in `.workspace-staged-<id>` and
   *   renamed over itself, keeping its mode, so no reader sees half of it;
   *   an edit is applied to disk's text as it is now, and again on top of a
   *   change another writer makes meanwhile; and `edit_many` checks every
   *   edit before writing its files one by one, naming each file's outcome
   *   if a write fails partway. A file with other hard links gets a file of
   *   its own at its path, and the others keep the old text; a file this
   *   process may not write is refused. Nothing is synced, so a power loss
   *   can lose a write its answer called landed. An undo or other move of
   *   the store's head leaves the files as they are, and at the agent's next
   *   start the framework tells it once that writes from turns its history
   *   no longer holds are still on disk. Where each agent's latest write
   *   lies is saved at a clean stop, in a record no branch switch rewinds,
   *   so a restart on another branch still tells it, and after a crash a
   *   move away from the writes since then isn't told. The framework's own
   *   files, its
   *   tool-result spills, saved payloads and fetched references, never go to
   *   a mount configured direct. Its `ignore`
   *   has a default (see there). Paths, links, its `include`, other mounts'
   *   directories, size limits and the walk cap hold as on a 'chronicle'
   *   mount. Its tools read and write beneath whatever directory is at its
   *   root when each call starts, with no check against the one a
   *   'chronicle' run of it last agreed with, so a root repointed through a
   *   link is read and written where it leads now. Where that root now lies
   *   elsewhere than the last start placed it, each call nests in it, as a
   *   start would now, every mount
   *   configured beneath its path, where that path leads beneath its root,
   *   and every other mount whose root, as that start placed it, lies
   *   beneath where its root lies now, or whose configured path lies
   *   beneath a directory that start found there. A mount configured
   *   elsewhere whose own root has moved since, and the other mounts' own
   *   placements, wait for the next start, so a direct root moved into
   *   another mount's directory is still that mount's too.
   *
   * A mount configured 'direct' runs as 'chronicle' from a start that finds
   * the store holding changes there that disk lacks, on the branch selected
   * then: a draft, a workspace deletion or a conflict, as `status` counts
   * them pending, or an intent the workspace can't read, which may hold one
   * of those. They stay in view, and the workspace says so on stderr and
   * through the framework's ops alerts, naming them and the ways to start it
   * direct. Until a start finds none held, it takes no writes, edits or
   * deletions, so what's held only shrinks: a `sync` of a held path takes
   * disk's copy, and a `materialize` naming the mount writes the store's.
   * It runs unwatched, and walks by the direct kind's default
   * ignore list where its config names none; `ls` without a path, and
   * `status`, give its `backend` as 'chronicle' and that list. A mount that
   * ran direct and runs as 'chronicle' again takes in what disk changed
   * meanwhile as its listings, searches and syncs reach it, as an unwatched
   * 'chronicle' mount does after any time away.
   */
  backend?: 'chronicle' | 'direct';
  /**
   * Watch mode for filesystem changes:
   * - 'always': chokidar watches continuously; each event re-observes its paths
   * - 'on-agent-action': after each completed agent tool batch, the mount is
   *   scanned, and the agent's next inference waits for that scan up to
   *   `agentActionScanDeadlineMs`; a scan that takes longer finishes while
   *   the round goes on. Each scan walks from the mount's start, so on a
   *   mount over its `walkCap` it covers the first `walkCap` entries every
   *   time, and files past them come in as `walkCap` describes
   * - 'never': no background reads; listings still observe the paths they
   *   show, and a read observes a path the store doesn't hold
   */
  watch?: 'always' | 'on-agent-action' | 'never';
  /** Debounce window in ms for watch: 'always' mode (default: 300) */
  watchDebounceMs?: number;
  /** Poll interval in ms for checking watched root identity changes (default: 2000) */
  watchRootPollMs?: number;
  /**
   * Patterns in these of gitignore's forms, each read as gitignore reads it:
   * - A name, matched at any depth: ".git", "node_modules". Within a name,
   *   "*" matches any run of characters and "?" any one: "*.pyc",
   *   "npm-debug.log*".
   * - A trailing "/" matches only a directory: "build/" covers every
   *   directory named build, with what lies beneath it, and no file of that
   *   name.
   * - A leading or inner "/" makes a path from the mount's root: "/dist"
   *   covers only the root's dist, and "a/b" only the root's a/b.
   * - "**" as the first segment, before one name, matches that name at any
   *   depth, as the name alone does.
   * - A trailing "/**" covers a directory from the root and what lies
   *   beneath it: "node_modules/**" covers only the root's node_modules, and
   *   no file of that name.
   * The module refuses, when it's built, a pattern of any other form, such as
   * a leading "!" or "#", a "[", a "\", a trailing space, "**" anywhere
   * else, or an empty, "." or ".." segment, naming the pattern and why. A
   * "?" stands for a "[" or "\" in a name.
   *
   * A sync without a path and the watcher pass over what the list covers,
   * and over entries with an editor's swap or backup file name whatever it
   * says, a directory with what lies beneath it: `.name.swp` and `.name.swx`
   * (the whole name), and names ending in `~` or in `.subl…tmp`, matched by
   * `^\..+\.sw[px]$`, `~$` and `\.subl.*\.tmp$`.
   *
   * A mount configured direct (`backend`) whose config names no list takes
   * `node_modules`, `dist`, `.git`, `build`, `coverage`, `target`,
   * `__pycache__` and `.venv`, each matching that name at any depth,
   * whichever kind it runs as. A direct mount's walks of the whole mount,
   * and of any path no pattern covers, pass over what the list covers. A
   * listing, glob or grep whose path, or whose pattern's directory, the
   * list covers is walked all the same, the patterns covering it set aside
   * and the rest applying beneath it, as a sync that names a path walks it
   * on a 'chronicle' mount.
   */
  ignore?: string[];
  /**
   * The files this mount holds, when it holds only some of what is under its
   * path: patterns in `ignore`'s forms, read for files. A pattern that matches
   * only directories, with a trailing `/` or `/**`, covers what lies beneath a
   * directory it matches: `fixtures/` every file beneath a directory named
   * fixtures, at any depth, and `docs/**` or `/docs/` every file beneath the
   * root's docs. Any other pattern covers a file by its own name, at any
   * depth, or by its path from the root (`/gate.json`, `src/*.ts`). Unlike
   * `ignore`, such a pattern covers nothing beneath a directory it matches,
   * since each file is covered by its own name or path: `["gate.json"]` holds
   * every file named `gate.json`, and no other file beneath a directory of
   * that name.
   *
   * It's the mount's boundary for content: no workspace path reads, stores,
   * serves or writes back a file it doesn't cover, and no tool lists,
   * matches or names one, beyond echoing a path it was given, which it may
   * spell as disk does. A walk passes over one and counts it under
   * `passedOver`, and passes over a link its names don't cover with the
   * reason a mount without an include gives a link it doesn't enter, "a
   * symlink, not walked", where the link leads to a directory, and wherever
   * it leads on a mount that doesn't follow links. No pass decides a change
   * the watcher reports there, and a materialize doesn't write it back even
   * when the workspace's history holds it. A materialize that names a
   * directory inside the mount counts each such entry beneath it under
   * `passedOver`,
   * with the reason and without its path, a deletion or conflict held there
   * included; one of the whole mount takes none of them up. The file
   * operations (read, write, edit, delete, and the module's binary and disk
   * reads and writes) refuse a path it doesn't cover as outside the mount's
   * include, a directory's included, and `resolveAbsolutePath` returns null
   * for one; the mount's root is inside. Whether a name is taken isn't
   * withheld: a refusal may show that something occupies a path the caller
   * named. On a mount that follows links, a path is judged where it lands as
   * well as where it's named, as disk spells it there: a covered path that
   * reaches a file the include doesn't cover, through a link at the path or
   * on its way, is refused as one that leaves the mount (the file operations
   * refuse it before anything is stored), and a listing from where a link
   * leads passes over such a file. A covered path whose landing realpath
   * can't resolve, as for a loop or a directory this process can't search,
   * is refused too, by every file operation, a delete included, since
   * where it lands can't be judged.
   *
   * A sync, materialize, grep, glob or ls that names a path the include
   * doesn't cover takes it as a directory, its scope, exactly where a listing
   * names one: where disk has a directory reached from the mount's root
   * through directories, with no link among them, or the workspace's history
   * holds an entry beneath it that the include covers, and that a nested
   * mount's include covers too where it lies in that mount's directory. A
   * directory `ignore` covers is a scope too when it's named, though a
   * listing passes over it. Each refuses any other path the include doesn't
   * cover. A covered path is a file to a sync, materialize or grep when disk
   * or history has a file there, and otherwise a directory; a glob takes its
   * path as a directory. Beneath a directory, each passes over what the
   * include doesn't cover, and a listing that isn't recursive names each
   * directory directly beneath its path that disk has, and each that a
   * covered entry in history implies, with only the files the include
   * covers. A mount running direct has no history (`backend`), so there
   * disk alone decides each of these. `ignore` still applies to what
   * `include` covers.
   *
   * On a disk that folds names, the parse reads a path in disk's spelling,
   * as the walk names what it lists, so a covered name whose file disk
   * spells otherwise is outside the mount, and the include's refusal shows
   * the path as given. A path that names one of the workspace's entries
   * exactly, or does once its directories take disk's spelling, keeps the
   * entry's spelling, as the parse gives it, and what lies past a link on
   * the way keeps the caller's spelling, since the parse reads nothing past
   * a link. Other answers name a path as the parse spells it, a name the
   * include leaves out included, since how disk spells a name the caller
   * gave is no content of that file. Where a
   * followed path lands is judged as disk spells it there, and a path that
   * meets no link where the parse names it.
   * `resolveAbsolutePath`, which is synchronous, judges the include on the
   * path as given and follows no link: on such a disk it returns the path to
   * a covered name's file that disk spells otherwise, and null for a covered
   * file named in another case.
   *
   * A path in a nested mount's directory is that mount's, whatever this
   * include covers: every tool gives the answer that names the mount holding
   * it and the path to use there. Through a link a mount follows, a place in
   * that directory is named only where it's a directory, or a file that
   * mount's own include covers with no file on its way, and is otherwise
   * refused as leaving the mount. On a mount that doesn't follow links, a
   * link on a path's way is refused, as on any such mount (followSymlinks).
   * A nested mount's root is placed where disk has it at each start, and its
   * directory is matched by spelling, so four cases fall outside this, as
   * for any nested mount, and a fifth on a direct one: on a disk that folds
   * names, a mount configured
   * through a link that spells a directory otherwise than disk does isn't
   * found nested, and this mount holds its files as its own; on such a disk,
   * a path through a link that spells a nested mount's directory otherwise
   * than that mount's configured path does, whether the link or the
   * configured path is the one spelled otherwise than disk, isn't found to
   * lead there, and this mount reads, lists, searches and writes there as
   * its own, creating files too, though a walk from its root passes over the
   * directory; on such a disk, a place in a nested mount's directory that a
   * link does lead to is judged by that mount's include, and named, in the
   * spelling the link's target gives, so a refusal can name a file disk
   * spells outside that include, or leave a covered one unnamed; and a
   * nested mount whose root moves while running, as `acceptRoot` takes,
   * stays placed where it was until the next start; and where a direct
   * mount's root is repointed between a read's parse and its open, a race
   * left to whoever writes the disk, a mount nested in it by its
   * directories alone, since its real root holds that root, can have the
   * read serve a path in its directory.
   *
   * Text the host registers for a path (`registerGeneratedTextFile`) is
   * served there whatever the include says, since it isn't one of the
   * mount's files: it's matched by the path a spelling resolves to, before
   * anything else checks the path, so every spelling that resolves to its
   * registered path reads it, and none writes it. On a disk that folds names,
   * a spelling in another case isn't its path, and reaches whatever file disk
   * has there. The framework keeps its own files (`tool-results/`, `refs/`)
   * only in a writable mount without an include, and what it kept in a mount
   * before the mount had one is outside the mount once it has one, unless the
   * include covers it.
   *
   * Left out, the mount holds everything under its path. Given, it's a list
   * of at least one pattern, and the module refuses one `ignore` would
   * refuse, so `[id].tsx` is refused and `?id].tsx` names that file.
   */
  include?: string[];
  /**
   * Whether to follow symlinks (default: false). Without it, no symlink on a
   * path is followed: not one at the path itself, and not one among the
   * directories on its way beneath the mount's root, wherever it leads. A path
   * with a symlink among its directories is refused naming the link, and for
   * a link inside the mount, its target where a tool could name it: a
   * directory, or a file the include of the mount it lies in covers, where
   * that mount has one. On a mount with an include, a link the include
   * doesn't cover is outside the mount itself, and its refusal tells nothing
   * of where it leads. A mount root that is itself a symlink is still the
   * root. With it, a symlink on a path is followed while what it reaches
   * stays inside the mount, which on a mount with an include means a
   * directory or a file the include covers. Either way, a listing or a
   * sync's walk descends
   * into no symlinked directory beneath its scope; with it, a scope named
   * through a link is listed from where the link leads.
   */
  followSymlinks?: boolean;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
  /**
   * The most entries one walk of this mount takes (default: 5000), a
   * positive integer no larger than Number.MAX_SAFE_INTEGER: files, and
   * links or other entries that aren't
   * directories, each of which the pass observes. A sync that reaches it
   * reports the rest as incomplete, and the next sync of the same scope
   * resumes after the last entry it took, wrapping to the start, so repeated
   * syncs cover a larger mount. A watched mount's catch-up scan (at start,
   * and when its watcher reattaches) takes its turn in the same rotation as
   * the mount's bare syncs, so on a mount over the cap, a change made while
   * the process was down waits for the rotation to reach it. The place is
   * kept with the mount's disk evidence, so a restart resumes there, unless
   * the machine went down before the store made the latest place durable.
   * An agent-action scan (`watch: 'on-agent-action'`) and a listing (`ls`,
   * `glob`, `grep`) take up to it from their scope's start every time:
   * `glob`'s is the directory its pattern's segments before the first
   * wildcard name beneath its `path`, and `grep`'s the deeper of its `path`
   * and its `glob` filter's directory. For a pattern or filter whose first
   * segment names the mount, either tool starts at the deeper of its `path`
   * and the directory the rest names from the mount's root, and walks
   * nothing where neither holds the other. Either way, the walk descends as
   * far as disk lists each segment with that spelling as a directory, not a
   * link. Each directory's listing
   * is read whole, so a deletion is seen wherever the walk lists, whatever
   * it took.
   *
   * It bounds what a walk observes, not the walk's own work: directories
   * don't count against it, and each one the walk visits is read whole, so
   * a tree of many directories that hold nothing is walked in full.
   */
  walkCap?: number;
  /**
   * If set, filesystem changes on this mount request inference.
   * - `true` — wake on any op (created | modified | deleted)
   * - array — wake only for the listed ops
   *
   * Self-writes through the module's own tools are already suppressed by the
   * watcher, so a mount shared between agents only wakes on external writes.
   * A change of a file's mode alone is recorded, and makes no event: it
   * brings nothing new to read.
   * The EventGate still has final say — use gate policies for path-glob
   * filtering or to disable wake temporarily via hot-reload.
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;

  /**
   * If true, writes/edits/deletes via the module's tools materialize to the
   * filesystem immediately (not just into Chronicle tree state). Required for
   * any store-backed mount shared across agents as a communication channel (a
   * direct mount's writes reach disk without it, and it's refused there) — without it,
   * another agent's watcher on the same directory sees nothing. The watcher
   * suppresses its own echoes, so this doesn't cause self-wake loops.
   */
  autoMaterialize?: boolean;
}

/**
 * Configuration for the WorkspaceModule.
 */
export interface WorkspaceConfig {
  /** Mount configurations */
  mounts: MountConfig[];
  /** Only materialize the active branch to filesystem (default: true) */
  materializeOnlyActiveBranch?: boolean;
  /** Delta snapshot frequency for tree states (default: 50) */
  deltaSnapshotEvery?: number;
  /** Full snapshot frequency for tree states (default: 10) */
  fullSnapshotEvery?: number;
  /**
   * How long the scan of `watch: 'on-agent-action'` mounts after a tool batch
   * may hold the agent's next inference, in ms (default: 20000). A scan that
   * takes longer finishes in the background; the miss is recorded on the
   * mount's status and pushed as a `workspace:agent-action-scan-incomplete`
   * event. So is a scan that finished without observing everything, with the
   * regions it couldn't (`incomplete`). While a scan that outlasted its
   * deadline still runs, later batches aren't held: their scan is queued
   * after it, and the miss is recorded at once. The framework bounds every
   * module's batch hook at 30 s, so a deadline above 29 s is lowered to 29 s,
   * with a warning, for the workspace's own miss to come first.
   */
  agentActionScanDeadlineMs?: number;
}

// ============================================================================
// Internal State
// ============================================================================

/**
 * Per-mount runtime state (not persisted — rebuilt on start). What disk last
 * agreed with lives in the module's disk-agreement journal (global chronicle
 * records), and branch-local intent in `intentTreeStateId`.
 */
export interface MountState {
  /** The mount config */
  config: MountConfig;
  /**
   * Whether the mount runs direct (`MountConfig.backend`), as the workspace
   * decides when initStore gives the store and again at each start: a mount
   * configured direct runs as 'chronicle' while the store holds changes
   * there that disk lacks.
   */
  direct: boolean;
  /** Tree state ID in Chronicle */
  treeStateId: string;
  /** Branch-local intent (tombstones, store origin, conflicts) for this mount's paths */
  intentTreeStateId: string;
  /** Sequence number of last materialization */
  lastMaterializedSeq: number;
  /** Paths currently suppressed from watcher (recently materialized) */
  suppressedPaths: Set<string>;
  /**
   * Whether a pass over the whole mount has run this session. On a mount
   * over its walkCap, that pass took the first walkCap entries.
   */
  initialSyncDone: boolean;
  /** Branch ID that was active when this mount last materialized */
  lastMaterializedBranchId: string | null;
  /**
   * The last on-agent-action scan, as of `at`: `complete` when it has
   * finished at all, `withinDeadline` when it finished before the deadline
   * released the round, `reason` for a miss or a failure, and `incomplete`
   * for the regions a finished scan couldn't observe (each also pushed as a
   * `workspace:agent-action-scan-incomplete` event).
   */
  lastAgentActionScan?: {
    at: number;
    complete: boolean;
    withinDeadline: boolean;
    reason?: string;
    incomplete?: Array<{ path: string; reason: string }>;
  };
  /**
   * The after-batch scan queued behind the mount's running work, not yet
   * started: later batches share it, since it starts after their tools ran.
   */
  agentActionScanWaiting?: AgentActionScan;
  /**
   * The mount's newest after-batch scan. Only its outcome is put on
   * `lastAgentActionScan`: one queued behind an older scan describes a later
   * batch, which the older scan's outcome mustn't speak for.
   */
  agentActionScanLatest?: AgentActionScan;
  /** A scan that outlasted a batch's deadline, while it still runs. */
  agentActionScanLate?: Promise<unknown>;
  /**
   * Wall-clock time chokidar emitted `ready` for this mount, or null if the
   * watcher hasn't finished its initial scan. null after session start =
   * watcher attach silently failed; a set value with empty tree = attached
   * to an empty directory.
   */
  watcherReadyAt: number | null;
  /** Most recent chokidar error for this mount, if any. */
  watcherError: string | null;
}

/**
 * Persisted module state (via Chronicle snapshot).
 */
export interface WorkspaceModuleState {
  /** Per-mount metadata */
  mounts: Record<string, {
    lastMaterializedSeq: number;
    lastMaterializedBranchId?: string;
    watcherReadyAt?: number | null;
    watcherError?: string | null;
  }>;
  /** Branch ID considered "active" for materialization */
  activeBranchId?: string;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface ReadInput {
  /** File path (mount-prefixed, e.g., "project/src/main.ts") */
  path: string;
  /** Starting line (1-indexed, optional) */
  offset?: number;
  /** Number of lines to read (optional) */
  limit?: number;
  /** Zero-based UTF-16 offset; selects character paging. Cannot mix with line offset/limit. */
  offsetChars?: number;
  /** Character page size in UTF-16 code units (default 2000); selects character paging.
   * May include one extra code unit to keep a surrogate pair intact. */
  limitChars?: number;
}

export interface ReadImageInput {
  /** Image file path (mount-prefixed, e.g., "project/assets/logo.png") */
  path: string;
}

export interface WriteInput {
  /** File path (mount-prefixed) */
  path: string;
  /** Content to write */
  content: string;
}

export interface EditInput {
  /** File path (mount-prefixed) */
  path: string;
  /** String to find */
  oldString: string;
  /** String to replace with */
  newString: string;
  /** Replace all occurrences (default: false) */
  replaceAll?: boolean;
}

export interface EditManyInput {
  /** The edits, each matched in its file as the call reads it, all in one mount's files. */
  edits: Array<{
    /** File path (mount-prefixed) */
    path: string;
    /** Exact text to replace */
    oldString: string;
    /** Text to replace it with */
    newString: string;
    /** How many times oldString occurs in the file (default: 1); every one is replaced. */
    occurrences?: number;
  }>;
}

export interface DeleteInput {
  /** File path (mount-prefixed) */
  path: string;
}

export interface LsInput {
  /** Directory path (mount-prefixed, optional — defaults to workspace root) */
  path?: string;
  /** List recursively (default: false) */
  recursive?: boolean;
}

export interface GlobInput {
  /** Glob pattern */
  pattern: string;
  /** Directory to search in (mount-prefixed, optional) */
  path?: string;
}

export interface GrepInput {
  /** Regex pattern */
  pattern: string;
  /** File or directory to search in (mount-prefixed, optional) */
  path?: string;
  /** Glob pattern to filter files */
  glob?: string;
  /** Context lines before match */
  contextBefore?: number;
  /** Context lines after match */
  contextAfter?: number;
}

/** One after-batch scan of a mount, shared by the batches that wait for it. */
export interface AgentActionScan {
  /** Whether some batch stopped waiting for it (its deadline passed, or an earlier scan still ran late). */
  late: boolean;
  /** Settles, never rejects, once its outcome is recorded: on status if it is the newest, as events either way. */
  settled: Promise<void>;
}

export interface StatusInput {
  /** Specific mount to check (optional — defaults to all) */
  mount?: string;
}

export interface MaterializeInput {
  /** Specific file or directory path to materialize (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all read-write mounts) */
  mount?: string;
  /**
   * Materialize even when the current branch has genuinely diverged from the
   * branch last materialized to disk, and overwrite a disk copy in conflict
   * (default: false). Not needed for linear continuations (child branches
   * forked at or after the last materialized point) — those pass the guard
   * automatically.
   */
  force?: boolean;
  /**
   * Also delete from disk the files deleted in the workspace whose disk copy
   * is still one the workspace holds (default: false). With `force`, also
   * those whose disk copy changed since.
   */
  applyDeletions?: boolean;
}

export interface SyncInput {
  /** Specific file or directory path to sync (optional — defaults to all) */
  path?: string;
  /** Specific mount (optional — defaults to all) */
  mount?: string;
  /** Take each mount's root as it is now, when it isn't the directory disk last agreed with. */
  acceptRoot?: boolean;
}

// ============================================================================
// Events
// ============================================================================

export type WorkspaceFsOp = 'created' | 'modified' | 'deleted';

/**
 * Fired when files in a mount are created. `paths` are mount-prefixed
 * (e.g. "tickets/2026-04-20-foo.md"). Conflicts are reported when Chronicle
 * sync detected divergence between the filesystem and the tree state.
 */
export interface WorkspaceCreatedEvent {
  type: 'workspace:created';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceModifiedEvent {
  type: 'workspace:modified';
  paths: string[];
  mount: string;
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceDeletedEvent {
  type: 'workspace:deleted';
  paths: string[];
  mount: string;
  /** Paths deleted on disk whose newer workspace version was kept as a conflict. */
  conflicts?: string[];
  [key: string]: unknown;
}

export interface WorkspaceMountedEvent {
  type: 'workspace:mounted';
  mount: string;
  path: string;
  [key: string]: unknown;
}

export interface WorkspaceUnmountedEvent {
  type: 'workspace:unmounted';
  mount: string;
  [key: string]: unknown;
}

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | WorkspaceModifiedEvent
  | WorkspaceDeletedEvent
  | WorkspaceMountedEvent
  | WorkspaceUnmountedEvent;

export const WORKSPACE_FS_EVENT_TYPES = [
  'workspace:created',
  'workspace:modified',
  'workspace:deleted',
] as const;

export type WorkspaceFsEventType = typeof WORKSPACE_FS_EVENT_TYPES[number];

export function opToEventType(op: WorkspaceFsOp): WorkspaceFsEventType {
  return `workspace:${op}` as WorkspaceFsEventType;
}
