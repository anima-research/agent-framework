/**
 * Filesystem watcher with debounce, ignore patterns, and suppression.
 *
 * Events are carried through with their op type (created/modified/deleted) so
 * downstream wake policies can key on creation vs. modification vs. deletion.
 */

import { watch, type FSWatcher } from 'chokidar';
import { mkdirSync, statSync } from 'node:fs';
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
  /** Fires once, when chokidar completes its initial scan. */
  onReady?: () => void;
  /** Fires on any chokidar-reported error (ENOENT, EACCES, platform faults). */
  onError?: (err: Error) => void;
  /** Fires after the watcher re-attaches to a replaced root inode. */
  onReattach?: () => void;
}

interface RootIdentity {
  dev: number;
  ino: number;
}

/**
 * Manages filesystem watching for a single mount.
 * Handles debouncing, ignore patterns, and write suppression.
 */
export class MountWatcher {
  private watcher: FSWatcher | null = null;
  // Most recent op seen per path within the current debounce window.
  // create -> modify collapses to 'created' (single batch); delete always wins.
  private pendingChanges = new Map<string, FsOp>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rootPollTimer: ReturnType<typeof setInterval> | null = null;
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rootIdentity: RootIdentity | null = null;
  private detached = false;
  private attaching = false;
  private stopped = true;
  private readonly debounceMs: number;
  private readonly config: MountConfig;
  private readonly onChangeCallback: (changes: FsChange[]) => void;
  private readonly lifecycle: WatcherLifecycle;

  constructor(
    config: MountConfig,
    onChange: (changes: FsChange[]) => void,
    lifecycle: WatcherLifecycle = {},
  ) {
    this.config = config;
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
        mkdirSync(this.config.path, { recursive: true });
      } catch (err) {
        this.lifecycle.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const ignored = this.config.ignore ?? [];

    this.watcher = watch(this.config.path, {
      ignored: ignored.length > 0 ? ignored : undefined,
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

  private async checkRootLiveness(): Promise<void> {
    if (this.stopped || this.attaching) return;

    let current: RootIdentity;
    try {
      current = this.readRootIdentity();
    } catch (err) {
      if (this.isErrno(err, 'ENOENT')) {
        this.detached = true;
        return;
      }
      this.reportError(err);
      return;
    }

    if (!this.rootIdentity && !this.detached) {
      this.rootIdentity = current;
      return;
    }

    if (!this.detached && this.rootIdentity && this.sameIdentity(current, this.rootIdentity)) {
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
      if (oldWatcher) {
        await oldWatcher.close();
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
      this.rootIdentity = this.readRootIdentity();
      this.detached = false;
    } catch (err) {
      if (this.isErrno(err, 'ENOENT')) {
        this.rootIdentity = null;
        this.detached = true;
        return;
      }
      this.reportError(err);
    }
  }

  private readRootIdentity(): RootIdentity {
    const stat = statSync(this.config.path);
    return { dev: stat.dev, ino: stat.ino };
  }

  private sameIdentity(a: RootIdentity, b: RootIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
  }

  private isErrno(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && 'code' in err
      && (err as NodeJS.ErrnoException).code === code;
  }

  private reportError(err: unknown): void {
    this.lifecycle.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private toRelative(absolutePath: string): string | null {
    const base = this.config.path.endsWith('/')
      ? this.config.path
      : this.config.path + '/';
    if (absolutePath.startsWith(base)) {
      return absolutePath.slice(base.length);
    }
    return null;
  }

  private isRootPath(absolutePath: string): boolean {
    const root = this.config.path.endsWith('/')
      ? this.config.path.slice(0, -1)
      : this.config.path;
    const candidate = absolutePath.endsWith('/')
      ? absolutePath.slice(0, -1)
      : absolutePath;
    return candidate === root;
  }
}
