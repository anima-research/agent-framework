/**
 * Shared helpers for moving content between the filesystem and the Chronicle
 * tree. The rules for when content moves — the three-way rule over disk, the
 * store and disk-agreement evidence — live in reconcile.ts, and how disk is
 * observed (containment, symlinks, walks) in observe.ts.
 */

import { createHash } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';

export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Hash content to a full SHA-256 hex string.
 * Matches Chronicle's storeBlob() hash format (64-char hex).
 */
export function hashContent(content: string | Buffer): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

export type StoredBytes = { bytes: Buffer } | { missing: true } | { unreadable: string };

export function storedBytes(store: JsStore, hash: string): StoredBytes {
  try {
    const blob = store.getBlob(hash);
    return blob ? { bytes: blob } : { missing: true };
  } catch (error) {
    if (store.isClosed()) throw error;
    // Chronicle's getBlob throws, rather than answering null, for a blob file
    // it can't read whole or whose format, checksum or hash doesn't check out,
    // such as one a write cut short left truncated.
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}
