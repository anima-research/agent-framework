/**
 * Branch-local intent about workspace paths: what the workspace on THIS branch
 * deliberately did or still owes, kept in a per-mount Chronicle tree state so
 * it rewinds with the workspace tree it qualifies (a branch switch that brings
 * back a deleted file brings back its missing tombstone too).
 *
 *  - tombstone: the workspace deleted the path while disk kept a copy (no
 *    autoMaterialize, or a refused unlink). The hash is the deleted entry's,
 *    so even a legacy entry with no disk evidence keeps a durable intent.
 *  - origin 'store': the entry was created through workspace tools and disk
 *    has never agreed with it.
 *  - conflict: disk and workspace diverged in a way no rule may resolve
 *    silently; kept until a path sync, a forced materialize, or convergence.
 *
 * Each record is a small JSON blob addressed from the tree, so reading one is
 * treeGet + getBlob and writing one is storeBlob + treeSet.
 */

import type { JsStore } from '@animalabs/chronicle';

export type ConflictKind =
  /** Disk, workspace and the last agreement all differ. */
  | 'both-changed'
  /** Disk deleted a file whose workspace copy differs from the last agreement. */
  | 'deleted-on-disk'
  /** Disk changed a file the workspace deleted. */
  | 'changed-after-workspace-delete'
  /** Disk holds a file at the path of a workspace-created entry, with other content. */
  | 'store-origin-collision'
  /** A legacy entry whose disk copy differs, with no evidence of which side changed. */
  | 'unknown-provenance'
  /** A module write or adoption was interrupted, and disk holds neither outcome. */
  | 'interrupted';

/** The disk side of a conflict, as observed when it was recorded. */
export interface DiskCounterpart {
  hash: string;
  size: number;
  mtimeMs: number;
  /** Blob hash of the stored copy (text within limits); absent when only referenced. */
  stored?: string;
}

export interface ConflictRecord {
  kind: ConflictKind;
  /** When the conflict was recorded (ms). */
  at: number;
  /** null when disk had no file. */
  disk: DiskCounterpart | null;
}

export interface BranchIntent {
  tombstone?: { hash: string };
  origin?: 'store';
  conflict?: ConflictRecord;
}

function isEmpty(intent: BranchIntent): boolean {
  return intent.tombstone === undefined && intent.origin === undefined && intent.conflict === undefined;
}

export class BranchIntents {
  constructor(private readonly store: JsStore, readonly treeStateId: string) {}

  get(path: string): BranchIntent | null {
    const entry = this.store.treeGet(this.treeStateId, path);
    if (!entry) return null;
    const blob = this.store.getBlob(entry.blobHash);
    if (!blob) return null;
    return JSON.parse(blob.toString('utf-8')) as BranchIntent;
  }

  /** Replace a path's intent; an empty intent removes the record. */
  put(path: string, intent: BranchIntent | null): void {
    if (!intent || isEmpty(intent)) {
      if (this.store.treeGet(this.treeStateId, path)) this.store.treeRemove(this.treeStateId, path);
      return;
    }
    const bytes = Buffer.from(JSON.stringify(intent), 'utf-8');
    const blobHash = this.store.storeBlob(bytes, 'application/json');
    this.store.treeSet(this.treeStateId, path, { blobHash, size: bytes.byteLength, mode: 0 });
  }

  /** Update one path's intent in place. */
  update(path: string, change: (current: BranchIntent) => BranchIntent): void {
    this.put(path, change({ ...(this.get(path) ?? {}) }));
  }

  /** Every recorded intent under a prefix ('' for the whole mount). */
  list(prefix = ''): Array<[string, BranchIntent]> {
    const out: Array<[string, BranchIntent]> = [];
    for (const entry of this.store.treeList(this.treeStateId, prefix ? prefix + '/' : undefined)) {
      const blob = this.store.getBlob(entry.blobHash);
      if (blob) out.push([entry.path, JSON.parse(blob.toString('utf-8')) as BranchIntent]);
    }
    if (prefix) {
      const exact = this.get(prefix);
      if (exact) out.push([prefix, exact]);
    }
    return out;
  }
}
