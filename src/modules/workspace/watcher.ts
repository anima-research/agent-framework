/**
 * Filesystem watcher with debounce, ignore patterns, and suppression.
 */

import { watch, type FSWatcher } from 'chokidar';
import { type MountConfig } from './types.js';

export interface WatcherEvents {
  onChange(paths: string[]): void;
}

/**
 * Manages filesystem watching for a single mount.
 * Handles debouncing, ignore patterns, and write suppression.
 */
export class MountWatcher {
  private watcher: FSWatcher | null = null;
  private pendingChanges = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressedPaths = new Set<string>();
  private suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;
  private readonly config: MountConfig;
  private readonly onChangeCallback: (paths: string[]) => void;

  constructor(
    config: MountConfig,
    onChange: (paths: string[]) => void,
  ) {
    this.config = config;
    this.debounceMs = config.watchDebounceMs ?? 300;
    this.onChangeCallback = onChange;
  }

  /**
   * Start watching the filesystem.
   */
  start(): void {
    if (this.watcher) return;

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

    const handleEvent = (filePath: string) => {
      // Convert absolute path to mount-relative
      const relative = this.toRelative(filePath);
      if (!relative) return;

      // Skip if this path is suppressed (we just wrote it)
      if (this.suppressedPaths.has(relative)) return;

      this.pendingChanges.add(relative);
      this.scheduleFire();
    };

    this.watcher.on('add', handleEvent);
    this.watcher.on('change', handleEvent);
    this.watcher.on('unlink', handleEvent);
  }

  /**
   * Stop watching.
   */
  stop(): void {
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
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Suppress watcher events for a path temporarily.
   * Used after materializing to avoid echo events.
   * After the cooldown, the path is re-checked via the recheckCallback.
   */
  suppress(relativePath: string, cooldownMs = 500): void {
    this.suppressedPaths.add(relativePath);

    // Clear existing timer for this path
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

  private scheduleFire(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingChanges.size > 0) {
        const paths = [...this.pendingChanges];
        this.pendingChanges.clear();
        this.onChangeCallback(paths);
      }
    }, this.debounceMs);
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
}
