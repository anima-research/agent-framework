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
   * Watch mode for filesystem changes:
   * - 'always': chokidar watches continuously; each event re-observes its paths
   * - 'on-agent-action': after each completed agent tool batch, the mount is
   *   scanned before the agent's next inference
   * - 'never': no background reads; listings and lazy reads still observe
   *   the paths they show
   */
  watch?: 'always' | 'on-agent-action' | 'never';
  /** Debounce window in ms for watch: 'always' mode (default: 300) */
  watchDebounceMs?: number;
  /** Poll interval in ms for checking watched root identity changes (default: 2000) */
  watchRootPollMs?: number;
  /**
   * Simple ignore patterns (NOT full gitignore syntax). Supported forms:
   * - Exact name match: ".git", "node_modules"
   * - Directory glob: "node_modules/**" (anything under node_modules)
   * - Extension glob: "*.pyc" (any file ending in .pyc)
   */
  ignore?: string[];
  /** Whether to follow symlinks (default: false) */
  followSymlinks?: boolean;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
  /**
   * If set, filesystem changes on this mount request inference.
   * - `true` — wake on any op (created | modified | deleted)
   * - array — wake only for the listed ops
   *
   * Self-writes through the module's own tools are already suppressed by the
   * watcher, so a mount shared between agents only wakes on external writes.
   * The EventGate still has final say — use gate policies for path-glob
   * filtering or to disable wake temporarily via hot-reload.
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;

  /**
   * If true, writes/edits/deletes via the module's tools materialize to the
   * filesystem immediately (not just into Chronicle tree state). Required for
   * any mount shared across agents as a communication channel — without it,
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
   * regions it couldn't (`incomplete`).
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
  /** Tree state ID in Chronicle */
  treeStateId: string;
  /** Branch-local intent (tombstones, store origin, conflicts) for this mount's paths */
  intentTreeStateId: string;
  /** Sequence number of last materialization */
  lastMaterializedSeq: number;
  /** Paths currently suppressed from watcher (recently materialized) */
  suppressedPaths: Set<string>;
  /** Whether a full scan of the mount has completed this session */
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
    /**
     * Freshness-guard baselines as #169 persisted them at stop. Read once at
     * start, for stores that ran it, and imported as disk-agreement evidence
     * where the journal has none; never written.
     */
    materializedHashes?: Record<string, string>;
    /** Read and ignored: conflicts are now branch-local intent records. */
    refusedPaths?: string[];
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
