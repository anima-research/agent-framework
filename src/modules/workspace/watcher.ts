/**
 * Filesystem watcher with debounce, ignore patterns, and suppression.
 *
 * Events are carried through with their op type (created/modified/deleted) so
 * downstream wake policies can key on creation vs. modification vs. deletion.
 */

import { watch, type FSWatcher } from 'chokidar';
import { closeSync, constants, fstatSync, mkdirSync, openSync, statSync, type Stats } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { passedOverAt } from './observe.js';
import { type MountConfig } from './types.js';

export type FsOp = 'created' | 'modified' | 'deleted';

export interface FsChange {
  path: string;
  op: FsOp;
}

export interface WatcherEvents {
  onChange(changes: FsChange[]): void;
}

/**
 * Optional lifecycle callbacks. Without these, chokidar's `ready` and `error`
 * events are silently dropped — which is how a failed attach can look
 * identical to an empty directory in the recorded state.
 */
export interface WatcherLifecycle {
  /** Fires when chokidar completes an attach's initial scan, so again after a
   *  re-attach. An attach closed before its scan completes, by a re-attach or
   *  a stop, never fires it: chokidar drops its listeners at the close. */
  onReady?: () => void;
  /** Fires on any chokidar-reported error (ENOENT, EACCES, platform faults). */
  onError?: (err: Error) => void;
  /** Fires after the watcher re-attaches to a replaced root inode. */
  onReattach?: () => void;
}

interface RootIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

const identityOf = (stat: Stats): RootIdentity => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });

/**
 * Manages filesystem watching for a single mount.
 * Handles debouncing, ignore patterns, and write suppression.
 */
export class MountWatcher {
  private watcher: FSWatcher | null = null;
  // Most recent op seen per path within the current debounce window.
  // create -> modify collapses to 'created' (single batch); a trailing delete
  // wins, and delete -> create reads as 'modified' (see mergeOp).
  private pendingChanges = new Map<string, FsOp>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rootPollTimer: ReturnType<typeof setInterval> | null = null;
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rootIdentity: RootIdentity | null = null;
  // The root as last attached, held open on Linux (see holdRoot).
  private rootFd: number | null = null;
  private detached = false;
  private attaching = false;
  private stopped = true;
  private readonly debounceMs: number;
  private readonly config: MountConfig;
  /**
   * The root as the watcher makes, holds, watches and checks it, and as each
   * event's path is read against: the configured path resolved (a link in it
   * kept), since chokidar hands back the paths it reports normalized, and
   * those of a root configured as `./m` matched none of them.
   */
  private readonly root: string;
  private readonly onChangeCallback: (changes: FsChange[]) => void;
  private readonly lifecycle: WatcherLifecycle;

  constructor(
    config: MountConfig,
    onChange: (changes: FsChange[]) => void,
    lifecycle: WatcherLifecycle = {},
    /** Other mounts' directories nested in this one, mount-relative: passed over as a walk passes over them. */
    private readonly others: readonly string[] = [],
  ) {
    this.config = config;
    this.root = resolve(config.path);
    this.debounceMs = config.watchDebounceMs ?? 300;
    this.onChangeCallback = onChange;
    this.lifecycle = lifecycle;
  }

  /**
   * Start watching the filesystem.
   */
  start(): void {
    if (this.watcher || this.rootPollTimer) return;

    this.stopped = false;
    this.attach();
    this.startRootPolling();
  }

  private attach(): void {
    // Read-write mounts: ensure the path exists before chokidar attaches.
    // chokidar 4's fs.watch-based backend silently fails to fire events when
    // the watched path OR any of its parent directories don't exist at
    // subscribe time (see case C in the WSL/Linux repro). `ready` still fires,
    // so the failure is indistinguishable from an empty directory without
    // this defensive mkdir. Read-only mounts are left alone — creating
    // directories a user asked us only to read would be surprising.
    if (this.config.mode === 'read-write') {
      try {
        mkdirSync(this.root, { recursive: true });
      } catch (err) {
        this.lifecycle.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const ignore = this.config.ignore ?? [];

    this.watcher = watch(this.root, {
      // What a walk passes over by design, by the path relative to the mount:
      // another mount's directory, the mount's ignore list and editors' swap
      // and backup files. chokidar 4
      // compares a string given here with the whole absolute path, so the
      // list itself would match nothing.
      ignored: (path: string) => {
        const relative = this.toRelative(path);
        return relative !== null && passedOverAt(relative, ignore, this.others) !== undefined;
      },
      // Its filter for editors' files tested the whole path, so a directory
      // with a dot in its name hid every `*.swp` beneath it, and the walk
      // didn't agree. An editor's save by rename then arrives as an unlink at
      // once, and an add once `awaitWriteFinish` finds the new copy settled.
      // A pass reads disk, not the ops, after the debounce's quiet spell
      // following the last event: a copy on disk by then is taken in as a
      // change, one still being written is read as it stands and taken in
      // again when its add comes, and a re-add after a longer spell is a
      // deletion and then a creation.
      atomic: false,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: this.config.followSymlinks ?? false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    const handleEvent = (op: FsOp) => (filePath: string) => {
      const relative = this.toRelative(filePath);
      if (!relative) return;

      // Skip if this path is suppressed (we just wrote it).
      // Suppression covers all ops — a materialize-then-delete by the module
      // should not echo either the add or the unlink.
      if (this.suppressedPaths.has(relative)) return;

      this.mergeOp(relative, op);
      this.scheduleFire();
    };

    this.watcher.on('add', handleEvent('created'));
    this.watcher.on('change', handleEvent('modified'));
    this.watcher.on('unlink', handleEvent('deleted'));
    this.watcher.on('unlinkDir', (dirPath) => {
      if (this.isRootPath(dirPath)) {
        this.detached = true;
      }
    });

    if (this.lifecycle.onReady) {
      this.watcher.once('ready', this.lifecycle.onReady);
    }
    this.watcher.on('error', (err) => {
      this.reportError(err);
    });
    this.watcher.on('raw', (event: string, rawPath: string | null) => {
      // libuv reports the root's own move as a rename under the root's name,
      // and its removal too once nothing holds it open. An entry beneath the
      // root with that name comes the same way, as does, on macOS, an
      // FSEvents event for the root that carries no modification flags, such
      // as its making just before the watch. A held root tells these apart
      // (checkRootLiveness), so the rename runs the check at once. A root
      // that isn't held can be made again with the removed one's identity,
      // so there the rename forces a re-attach. A rename without a name, as
      // libuv gives for a file whose path it can't read, is passed over.
      if (event !== 'rename' || typeof rawPath !== 'string') return;
      if (basename(rawPath) !== basename(this.root)) return;
      void this.checkRootLiveness({ force: this.rootFd === null });
    });

    this.captureRootIdentity();
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.rootPollTimer) {
      clearInterval(this.rootPollTimer);
      this.rootPollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const timer of this.suppressionTimers.values()) {
      clearTimeout(timer);
    }
    this.suppressionTimers.clear();
    this.suppressedPaths.clear();
    this.pendingChanges.clear();
    // Before the close, so a close that fails still lets go of the root.
    this.releaseRoot();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.rootIdentity = null;
    this.detached = false;
    this.attaching = false;
  }

  /**
   * Suppress watcher events for a path temporarily.
   * Used after materializing to avoid echo events.
   */
  suppress(relativePath: string, cooldownMs = 500): void {
    this.suppressedPaths.add(relativePath);

    const existing = this.suppressionTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.suppressedPaths.delete(relativePath);
      this.suppressionTimers.delete(relativePath);
    }, cooldownMs);

    this.suppressionTimers.set(relativePath, timer);
  }

  /**
   * Check if a path is currently suppressed.
   */
  isSuppressed(relativePath: string): boolean {
    return this.suppressedPaths.has(relativePath);
  }

  /**
   * Merge a new op for a path into the pending batch. Chokidar can fire
   * multiple events per path inside one debounce window; collapse them to the
   * single op that reflects the net effect at end-of-window.
   *
   * Transitions (prev → op → result):
   *   ∅          → *         → op
   *   *          → deleted   → deleted        (trailing delete wins)
   *   deleted    → created   → modified       (atomic save: unlink+rename;
   *                                            file exists with new contents)
   *   created    → modified  → created        (still net-new this window)
   *   created    → created   → created
   *   modified   → created   → created        (shouldn't happen, but keep
   *                                            created to avoid a false
   *                                            delete->recreate signal)
   *   modified   → modified  → modified
   */
  private mergeOp(path: string, op: FsOp): void {
    const prev = this.pendingChanges.get(path);
    if (!prev) {
      this.pendingChanges.set(path, op);
      return;
    }
    if (op === 'deleted') {
      this.pendingChanges.set(path, 'deleted');
      return;
    }
    if (prev === 'deleted' && op === 'created') {
      this.pendingChanges.set(path, 'modified');
      return;
    }
    if (prev === 'created') {
      this.pendingChanges.set(path, 'created');
      return;
    }
    this.pendingChanges.set(path, op);
  }

  private scheduleFire(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingChanges.size > 0) {
        const changes: FsChange[] = [...this.pendingChanges].map(([path, op]) => ({ path, op }));
        this.pendingChanges.clear();
        this.onChangeCallback(changes);
      }
    }, this.debounceMs);
  }

  private startRootPolling(): void {
    const pollMs = this.config.watchRootPollMs ?? 2000;
    this.rootPollTimer = setInterval(() => {
      void this.checkRootLiveness();
    }, pollMs);
    this.rootPollTimer.unref();
  }

  /**
   * Whether the root is still the directory the watcher attached to, checked
   * every `watchRootPollMs` and at a rename under the root's name. A root
   * replaced at its path, or whose held directory has been removed, is
   * attached to again, and with `force` so is one that looks unchanged. A
   * root that's gone is let go of: a read-write mount makes it again and
   * attaches to it, and a read-only one waits, detached, until a check finds
   * it back.
   */
  private async checkRootLiveness(opts: { force?: boolean } = {}): Promise<void> {
    if (this.stopped || this.attaching) return;

    let current: RootIdentity;
    try {
      current = this.readRootIdentity();
    } catch (err) {
      // A held root that has been removed is gone, whatever the path's error.
      if (this.isErrno(err, 'ENOENT') || this.heldRootRemoved()) {
        this.detached = true;
        this.releaseRoot();
        if (this.config.mode === 'read-write') {
          await this.reattach();
        }
        return;
      }
      this.reportError(err);
      if (opts.force) {
        this.detached = true;
        await this.reattach();
      }
      return;
    }

    if (!this.rootIdentity && !this.detached) {
      await this.reattach();
      return;
    }

    if (!opts.force && !this.detached && this.rootIdentity
      && this.sameIdentity(current, this.rootIdentity) && !this.heldRootRemoved()) {
      return;
    }

    await this.reattach();
  }

  private async reattach(): Promise<void> {
    if (this.attaching || this.stopped) return;

    this.attaching = true;
    try {
      const oldWatcher = this.watcher;
      this.watcher = null;
      this.releaseRoot();
      if (oldWatcher) {
        try {
          await oldWatcher.close();
        } catch (err) {
          // chokidar removes its listeners before it closes, so the old
          // instance reports nothing more, and the root is attached to again.
          this.reportError(err);
        }
      }
      if (this.stopped) return;

      this.attach();
      if (!this.detached && this.rootIdentity) {
        this.lifecycle.onReattach?.();
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.attaching = false;
    }
  }

  private captureRootIdentity(): void {
    try {
      this.rootIdentity = this.holdRoot();
      this.detached = false;
    } catch (err) {
      // What holdRoot opened before it failed isn't held.
      this.releaseRoot();
      if (this.isErrno(err, 'ENOENT')) {
        this.rootIdentity = null;
        this.detached = true;
        return;
      }
      this.rootIdentity = null;
      this.detached = false;
      this.reportError(err);
    }
  }

  /**
   * The root's identity, with the root held open on Linux until the watcher
   * lets go of it: at a re-attach, when the root is found gone, or at the
   * stop. The held directory then says itself whether it has been removed
   * (heldRootRemoved). A removed directory's inode number can otherwise go
   * to the next directory made, as ext4 gives it, and one held open isn't
   * given out. Elsewhere, or where the root can't be opened as a directory,
   * as without read permission, at the process's file limit or when the
   * path isn't a directory, it isn't held, and its identity is read from its
   * path. So too where the root's link count reads 0 as it's opened: if
   * that's the file system's count for a directory in place, a later check
   * would take the root for removed and re-attach at every poll.
   */
  private holdRoot(): RootIdentity {
    if (process.platform !== 'linux') return this.readRootIdentity();
    let fd: number;
    try {
      // A directory only, so a FIFO at the path fails at once rather than
      // blocking until a writer opens it.
      fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch {
      return this.readRootIdentity();
    }
    this.rootFd = fd;
    const stats = fstatSync(fd);
    if (stats.nlink === 0) {
      this.releaseRoot();
      return this.readRootIdentity();
    }
    return identityOf(stats);
  }

  /**
   * Whether the directory the watcher holds has been removed, which its link
   * count says whatever has since been made at its path. On a file system
   * whose inode numbers a server gives out, the hold can't keep a root made
   * again from taking the removed one's number, and a removal by another
   * client shows once this one revalidates the directory's cached
   * attributes. A held directory that can't be read, as a stale one on a
   * network file system, counts as removed.
   */
  private heldRootRemoved(): boolean {
    if (this.rootFd === null) return false;
    try {
      return fstatSync(this.rootFd).nlink === 0;
    } catch {
      return true;
    }
  }

  private releaseRoot(): void {
    if (this.rootFd === null) return;
    const fd = this.rootFd;
    this.rootFd = null;
    try {
      closeSync(fd);
    } catch (err) {
      // Linux frees the descriptor whatever close returns, so the error is
      // reported and what called this goes on.
      this.reportError(err);
    }
  }

  private readRootIdentity(): RootIdentity {
    return identityOf(statSync(this.root));
  }

  private sameIdentity(a: RootIdentity, b: RootIdentity): boolean {
    // birthtimeMs tells a root made again from a removed one whose inode
    // number it took, unless both were made within one tick of the clock or
    // the file system keeps no birth time. A held root's removal shows in its
    // link count instead, and where the root isn't held the rename's force
    // covers those.
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  }

  private isErrno(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
      && (err as NodeJS.ErrnoException).code === code;
  }

  private reportError(err: unknown): void {
    this.lifecycle.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private toRelative(absolutePath: string): string | null {
    // Chokidar hands back platform-separated absolute paths; compare with
    // the platform separator and normalize the result to the '/'-separated
    // logical form the rest of the workspace uses. No-op on POSIX.
    const base = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (absolutePath.startsWith(base)) {
      return absolutePath.slice(base.length).split(sep).join('/');
    }
    return null;
  }

  private isRootPath(absolutePath: string): boolean {
    const root = this.root.endsWith(sep) ? this.root.slice(0, -1) : this.root;
    const candidate = absolutePath.endsWith(sep)
      ? absolutePath.slice(0, -1)
      : absolutePath;
    return candidate === root;
  }
}
