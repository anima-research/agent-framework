/**
 * Shared helpers for moving content between the filesystem and the Chronicle
 * tree. The rules for when content moves — the three-way rule over disk, the
 * store and disk-agreement evidence — live in reconcile.ts.
 */

import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Resolve a relative path within a mount and verify it doesn't escape.
 * Returns the absolute path, or null if the path is outside the mount.
 */
export function safePath(mountPath: string, relativePath: string): string | null {
  // Compare with the PLATFORM separator: resolve() emits backslashes on
  // Windows, so a '/'-suffixed root never prefix-matches there and every
  // in-mount path was reported as outside the mount.
  const resolved = resolve(mountPath, relativePath);
  const root = mountPath.endsWith(sep) ? mountPath : mountPath + sep;
  if (resolved !== mountPath && !resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

/**
 * Hash content to a full SHA-256 hex string.
 * Matches Chronicle's storeBlob() hash format (64-char hex).
 */
export function hashContent(content: string | Buffer): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

/** A path a sync or materialize did not act on, with the reason. */
export interface SkippedFile {
  /** Relative path of the file */
  path: string;
  /** Why, in words the resident can act on */
  reason: string;
}

/** Null bytes in the first 8KB: content disk→store sync won't store as text. */
export function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}
