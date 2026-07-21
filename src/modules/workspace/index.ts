/**
 * WorkspaceModule — mountable filesystem abstraction backed by Chronicle tree state.
 *
 * Provides a unified workspace with mount-based filesystem access,
 * auto-sync between real filesystem and Chronicle, and manual materialization.
 */

import { constants as fsConstants } from 'node:fs';
import { open, readFile, stat, access, writeFile, unlink, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';
import type { JsStore } from '@animalabs/chronicle';
import type { Module, ModuleContext, ProcessState, EventResponse } from '../../types/module.js';
import type { ProcessEvent, ToolDefinition, ToolCall, ToolResult } from '../../types/events.js';
import type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  ReadImageInput,
  WriteInput,
  EditInput,
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
import { syncFromFs, materializeToFs, hashContent, DEFAULT_MAX_FILE_SIZE, type ConflictInfo } from './sync.js';

export type {
  WorkspaceConfig,
  MountConfig,
  MountState,
  WorkspaceModuleState,
  ReadInput,
  ReadImageInput,
  WriteInput,
  EditInput,
  DeleteInput,
  LsInput,
  GlobInput,
  GrepInput,
  StatusInput,
  MaterializeInput,
  SyncInput,
} from './types.js';

type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

class WorkspaceImageReadError extends Error {
  constructor(
    readonly code:
      | 'mount_unavailable'
      | 'not_found'
      | 'directory'
      | 'symlink'
      | 'escape'
      | 'changed'
      | 'empty'
      | 'too_large'
      | 'truncated'
      | 'invalid'
      | 'unsupported'
      | 'blob_missing',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceImageReadError';
  }
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

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code;
}

function startsWithBytes(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function matchesPartialPrefix(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length > 0 && prefix.subarray(0, buffer.length).equals(buffer);
}

function isContainedPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(normalizedRoot);
}

function invalidImage(format: string, mountPrefixedPath: string): never {
  throw new WorkspaceImageReadError('invalid', `Invalid ${format} image: ${mountPrefixedPath}`);
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
      if (!sawSof || !sawSos || offset !== bytes.length) {
        invalidImage('JPEG', mountPrefixedPath);
      }
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
    throw new WorkspaceImageReadError('truncated', `Truncated image signature: ${mountPrefixedPath}`);
  }

  if (startsWithBytes(bytes, JPEG_SIGNATURE)) {
    validateJpeg(bytes, mountPrefixedPath);
    return 'image/jpeg';
  }
  if (matchesPartialPrefix(bytes, JPEG_SIGNATURE)) {
    throw new WorkspaceImageReadError('truncated', `Truncated image signature: ${mountPrefixedPath}`);
  }

  if (startsWithBytes(bytes, GIF87A_SIGNATURE) || startsWithBytes(bytes, GIF89A_SIGNATURE)) {
    validateGif(bytes, mountPrefixedPath);
    return 'image/gif';
  }
  if (matchesPartialPrefix(bytes, GIF87A_SIGNATURE) || matchesPartialPrefix(bytes, GIF89A_SIGNATURE)) {
    throw new WorkspaceImageReadError('truncated', `Truncated image signature: ${mountPrefixedPath}`);
  }

  if (bytes.length >= 12 && startsWithBytes(bytes, RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) {
    validateWebp(bytes, mountPrefixedPath);
    return 'image/webp';
  }
  if (
    (bytes.length < RIFF_SIGNATURE.length && matchesPartialPrefix(bytes, RIFF_SIGNATURE))
    || (bytes.length >= RIFF_SIGNATURE.length && startsWithBytes(bytes, RIFF_SIGNATURE) && bytes.length < 12)
  ) {
    throw new WorkspaceImageReadError('truncated', `Truncated image signature: ${mountPrefixedPath}`);
  }

  throw new WorkspaceImageReadError('unsupported', `Unsupported image format: ${mountPrefixedPath}`);
}

export class WorkspaceModule implements Module {
  readonly name = 'workspace';

  private ctx: ModuleContext | null = null;
  private store: JsStore | null = null;
  private config: WorkspaceConfig;
  private mounts = new Map<string, MountState>();
  private watchers = new Map<string, MountWatcher>();

  constructor(config: WorkspaceConfig) {
    // Detect overlapping mount paths: if mount A contains mount B,
    // auto-add an ignore rule on A for B's path to prevent syncing
    // the sub-mount's directory through the super-mount.
    for (const outer of config.mounts) {
      for (const inner of config.mounts) {
        if (outer === inner) continue;
        const outerPath = resolve(outer.path);
        const innerPath = resolve(inner.path);
        const rel = relative(outerPath, innerPath);
        if (rel && !rel.startsWith('..') && !rel.startsWith('/')) {
          // inner is nested under outer — add ignore rule
          outer.ignore = outer.ignore ?? [];
          const pattern = rel + '/**';
          if (!outer.ignore.includes(pattern) && !outer.ignore.includes(rel)) {
            outer.ignore.push(rel);
            console.warn(
              `[workspace] Mount "${outer.name}" contains mount "${inner.name}" ` +
              `(${rel}/) — auto-ignoring to prevent overlap`,
            );
          }
        }
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
    this.store = store;

    // Register tree states for each mount
    for (const mount of this.config.mounts) {
      const treeStateId = `workspace/${mount.name}/tree`;
      try {
        store.registerState({
          id: treeStateId,
          strategy: 'tree',
          deltaSnapshotEvery: this.config.deltaSnapshotEvery ?? 50,
          fullSnapshotEvery: this.config.fullSnapshotEvery ?? 10,
        });
      } catch {
        // State already registered (restart scenario)
      }

      const mountState: MountState = {
        config: mount,
        treeStateId,
        lastMaterializedSeq: 0,
        suppressedPaths: new Set(),
        initialSyncDone: false,
        lastMaterializedBranchId: null,
        materializedHashes: new Map(),
        watcherReadyAt: null,
        watcherError: null,
      };
      this.mounts.set(mount.name, mountState);
    }

    this.ensureRunning();
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Restore persisted state if restarting
    if (ctx.isRestart) {
      const saved = ctx.getState<WorkspaceModuleState>();
      if (saved) {
        for (const [name, meta] of Object.entries(saved.mounts)) {
          const mount = this.mounts.get(name);
          if (mount) {
            mount.lastMaterializedSeq = meta.lastMaterializedSeq;
            mount.lastMaterializedBranchId = meta.lastMaterializedBranchId ?? null;
            // watcherReadyAt intentionally not restored — each session must
            // observe its own watcher attach, otherwise a stale timestamp
            // would hide a new-session attach failure.
          }
        }
      }
    }

    this.ensureRunning();
  }

  /**
   * Start chokidar watchers and emit workspace:mounted events.
   * Idempotent: safe to call from both start() and initStore(), fires once
   * per mount regardless of which runs second.
   */
  private ensureRunning(): void {
    if (!this.ctx || this.mounts.size === 0) return;

    for (const [name, mount] of this.mounts) {
      if (this.watchers.has(name)) continue;

      const watchMode = mount.config.watch ?? 'always';
      if (watchMode === 'always') {
        const watcher = new MountWatcher(
          mount.config,
          (changes) => {
            this.handleFsChanges(name, changes);
          },
          {
            onReady: () => {
              mount.watcherReadyAt = Date.now();
              mount.watcherError = null;
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
              void this.initialScan(name);
              this.ctx?.pushEvent({
                type: 'workspace:watcher-reattached',
                mount: name,
                path: mount.config.path,
              } as ProcessEvent);
            },
          },
        );
        watcher.start();
        this.watchers.set(name, watcher);

        // Chokidar is started with ignoreInitial:true, so files already on
        // disk at session start would be invisible. Trigger one syncFromFs
        // pass — syncFromFs diffs disk against the tree state, so only files
        // new-to-this-session's-tree fire workspace:created events. Fresh
        // sessions see the existing catalog; restarts only see what appeared
        // while the session was down.
        void this.initialScan(name);
      }

      this.ctx.pushEvent({
        type: 'workspace:mounted',
        mount: name,
        path: mount.config.path,
      } as ProcessEvent);
    }
  }

  private async initialScan(mountName: string): Promise<void> {
    const store = this.store;
    const mount = this.mounts.get(mountName);
    if (!store || !mount) return;

    try {
      const result = await syncFromFs(store, mount);
      mount.initialSyncDone = true;
      this.emitFsEvents(mountName, result.synced, result.conflicts);
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
    // Persist state
    if (this.ctx) {
      const activeBranchId = this.store ? this.store.currentBranch().id : undefined;
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

    // Stop watchers
    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();
    this.ctx = null;
  }

  // ==========================================================================
  // Tool Definitions
  // ==========================================================================

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description: 'Read a file from the workspace. Returns content with line numbers.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed, e.g., "project/src/main.ts")' },
            offset: { type: 'number', description: 'Starting line number (1-indexed)' },
            limit: { type: 'number', description: 'Maximum number of lines to return' },
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
        description: 'Create or overwrite a file in the workspace.',
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
        description: 'Edit a file by replacing a substring. The oldString must be unique unless replaceAll is true.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'File path (mount-prefixed)' },
            oldString: { type: 'string', description: 'String to find' },
            newString: { type: 'string', description: 'Replacement string' },
            replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
          },
          required: ['path', 'oldString', 'newString'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a file from the workspace.',
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
        description: 'List directory contents from the workspace tree.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path (mount-prefixed, optional)' },
            recursive: { type: 'boolean', description: 'List recursively (default: false)' },
          },
        },
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern in the workspace.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
            path: { type: 'string', description: 'Directory to search in (mount-prefixed, optional)' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'grep',
        description: 'Search file contents with a regex pattern.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Regular expression pattern' },
            path: { type: 'string', description: 'File or directory to search (mount-prefixed, optional)' },
            glob: { type: 'string', description: 'Glob pattern to filter files' },
            contextBefore: { type: 'number', description: 'Context lines before match' },
            contextAfter: { type: 'number', description: 'Context lines after match' },
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
        description: 'Write workspace files to the real filesystem. Use after writing/editing to push changes to disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to materialize (optional — defaults to all changed)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
          },
        },
      },
      {
        name: 'sync',
        description: 'Pull filesystem state into the workspace. Detects user changes on disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Specific path to sync (optional — defaults to all)' },
            mount: { type: 'string', description: 'Specific mount (optional)' },
          },
        },
      },
    ];
  }

  // ==========================================================================
  // Tool Dispatch
  // ==========================================================================

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      const input = call.input as Record<string, unknown>;
      switch (call.name) {
        case 'read': return await this.handleRead(input as unknown as ReadInput);
        case 'read_image': return await this.handleReadImage(input as unknown as ReadImageInput);
        case 'write': return await this.handleWrite(input as unknown as WriteInput);
        case 'edit': return await this.handleEdit(input as unknown as EditInput);
        case 'delete': return await this.handleDelete(input as unknown as DeleteInput);
        case 'ls': return await this.handleLs(input as unknown as LsInput);
        case 'glob': return await this.handleGlob(input as unknown as GlobInput);
        case 'grep': return await this.handleGrep(input as unknown as GrepInput);
        case 'status': return await this.handleStatus(input as unknown as StatusInput);
        case 'materialize': return await this.handleMaterialize(input as unknown as MaterializeInput);
        case 'sync': return await this.handleSync(input as unknown as SyncInput);
        default:
          return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
      }
    } catch (err) {
      return { success: false, error: String(err), isError: true };
    }
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
      text = `[workspace event · ${op} · ${paths[0]}]`;
    } else {
      const list = paths.map(p => `- ${p}`).join('\n');
      text = `[workspace event · ${op} · ${paths.length} files in ${mountName}/]\n${list}`;
    }
    if (conflicts && conflicts.length > 0) {
      text += `\n[conflicts: ${conflicts.join(', ')}]`;
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
   * absolute filesystem path. Returns null if the mount is unknown or the
   * resolved path escapes the mount root (path-traversal guard). Public API
   * for peer modules that need to read workspace files directly.
   */
  resolveAbsolutePath(mountPrefixedPath: string): string | null {
    try {
      const { mount, relativePath } = this.parsePath(mountPrefixedPath);
      return resolve(mount.config.path, relativePath);
    } catch {
      return null;
    }
  }

  /**
   * Write binary content (e.g. an image pulled from the agent's context) to a
   * mount, through the same Chronicle-tree + auto-materialize path as the
   * `write` tool. Public API for the framework's synthesized `save_image`
   * tool and other peer callers that hold bytes rather than text.
   */
  async writeBinary(
    mountPrefixedPath: string,
    data: Buffer,
    mimeType: string,
  ): Promise<ToolResult> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath } = this.parsePath(mountPrefixedPath));
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (data.byteLength > maxSize) {
      return { success: false, error: `Content exceeds max file size (${maxSize} bytes)`, isError: true };
    }
    const store = this.getStore();
    const blobHash = store.storeBlob(data, mimeType);
    store.treeSet(mount.treeStateId, relativePath, {
      blobHash,
      size: data.byteLength,
      mode: 0o644,
    });
    const materializeError = await this.autoMaterialize(mount, relativePath, 'write', data);
    if (materializeError) {
      return {
        success: false,
        error: `Wrote to Chronicle but failed to materialize "${mountPrefixedPath}" to disk: ${materializeError}.`,
        isError: true,
      };
    }
    return {
      success: true,
      data: { path: mountPrefixedPath, size: data.byteLength, mimeType },
    };
  }

  /**
   * Parse a mount-prefixed path into (mountName, relativePath).
   */
  private parsePath(path: string): { mount: MountState; relativePath: string } {
    const slashIdx = path.indexOf('/');
    const mountName = slashIdx >= 0 ? path.slice(0, slashIdx) : path;
    const relativePath = slashIdx >= 0 ? path.slice(slashIdx + 1) : '';

    const mount = this.mounts.get(mountName);
    if (!mount) {
      throw new Error(`Unknown mount: "${mountName}". Available: ${[...this.mounts.keys()].join(', ')}`);
    }

    // Path traversal guard (CWE-22): ensure resolved path stays within mount
    const resolved = resolve(mount.config.path, relativePath);
    const mountRoot = mount.config.path.endsWith('/') ? mount.config.path : mount.config.path + '/';
    if (resolved !== mount.config.path && !resolved.startsWith(mountRoot)) {
      throw new Error(`Path traversal detected: "${path}" resolves outside mount "${mountName}"`);
    }

    return { mount, relativePath };
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
      throw new WorkspaceImageReadError('empty', `Image file is empty: ${mountPrefixedPath}`);
    }
    if (bytes.byteLength > maxSize) {
      throw new WorkspaceImageReadError(
        'too_large',
        `Image file exceeds max size (${maxSize} bytes): ${mountPrefixedPath}`,
      );
    }
    return {
      bytes,
      mimeType: detectImageMimeType(bytes, mountPrefixedPath),
    };
  }

  private tryReadImageFromTree(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxSize: number,
  ): { bytes: Buffer; mimeType: SupportedImageMimeType } | null {
    const store = this.getStore();
    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) return null;

    const blob = store.getBlob(entry.blobHash);
    if (!blob) {
      throw new WorkspaceImageReadError('blob_missing', `Blob not found for: ${mountPrefixedPath}`);
    }

    return this.validateImageBytes(blob, mountPrefixedPath, maxSize);
  }

  private async readImageFromFilesystem(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxSize: number,
  ): Promise<{ bytes: Buffer; mimeType: SupportedImageMimeType }> {
    const lexicalPath = resolve(mount.config.path, relativePath);
    const useNoFollow = !mount.config.followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number';

    let fileInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      fileInfo = await lstat(lexicalPath);
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
    }

    if (fileInfo.isDirectory()) {
      throw new WorkspaceImageReadError('directory', `Path is a directory: ${mountPrefixedPath}`);
    }
    if (fileInfo.isSymbolicLink() && !mount.config.followSymlinks) {
      throw new WorkspaceImageReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`);
    }

    let realMountRoot: string;
    try {
      realMountRoot = await realpath(mount.config.path);
    } catch {
      throw new WorkspaceImageReadError('mount_unavailable', `Mount unavailable: ${mount.config.name}`);
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(lexicalPath, fsConstants.O_RDONLY | (useNoFollow ? fsConstants.O_NOFOLLOW : 0));
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      if (!mount.config.followSymlinks && isErrnoCode(err, 'ELOOP')) {
        throw new WorkspaceImageReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`);
      }
      throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
    }

    try {
      const fileStat = await handle.stat();
      if (fileStat.isDirectory()) {
        throw new WorkspaceImageReadError('directory', `Path is a directory: ${mountPrefixedPath}`);
      }
      if (!fileStat.isFile()) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      if (fileStat.size === 0) {
        throw new WorkspaceImageReadError('empty', `Image file is empty: ${mountPrefixedPath}`);
      }
      if (fileStat.size > maxSize) {
        throw new WorkspaceImageReadError(
          'too_large',
          `Image file exceeds max size (${maxSize} bytes): ${mountPrefixedPath}`,
        );
      }

      if (!mount.config.followSymlinks && !useNoFollow) {
        let postOpenInfo: Awaited<ReturnType<typeof lstat>>;
        try {
          postOpenInfo = await lstat(lexicalPath);
        } catch (err) {
          if (isErrnoCode(err, 'ENOENT')) {
            throw new WorkspaceImageReadError('changed', `Image file changed during read: ${mountPrefixedPath}`);
          }
          throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
        }
        if (postOpenInfo.isSymbolicLink()) {
          throw new WorkspaceImageReadError('symlink', `Symlinks are not allowed: ${mountPrefixedPath}`);
        }
      }

      let realFilePath: string;
      try {
        realFilePath = await realpath(lexicalPath);
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) {
          throw new WorkspaceImageReadError('changed', `Image file changed during read: ${mountPrefixedPath}`);
        }
        throw new WorkspaceImageReadError('not_found', `Unable to resolve image file: ${mountPrefixedPath}`);
      }

      if (!isContainedPath(realMountRoot, realFilePath)) {
        throw new WorkspaceImageReadError('escape', `Symlink escape detected: ${mountPrefixedPath}`);
      }

      let pathStat: Awaited<ReturnType<typeof stat>>;
      try {
        pathStat = await stat(realFilePath);
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) {
          throw new WorkspaceImageReadError('changed', `Image file changed during read: ${mountPrefixedPath}`);
        }
        throw new WorkspaceImageReadError('not_found', `Unable to stat image file: ${mountPrefixedPath}`);
      }
      if (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino) {
        throw new WorkspaceImageReadError('changed', `Image file changed during read: ${mountPrefixedPath}`);
      }

      const bytes = await handle.readFile();
      return this.validateImageBytes(bytes, mountPrefixedPath, maxSize);
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) throw err;
      if (isErrnoCode(err, 'ENOENT')) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
    } finally {
      await handle?.close();
    }
  }

  /**
   * Persist a single write/edit/delete to disk when the mount opts in via
   * `autoMaterialize`. Required for cross-agent pipelines — another agent's
   * chokidar watcher on the same directory only sees real filesystem events.
   * The local watcher's `suppress()` absorbs the echo so we don't self-wake.
   *
   * Returns an error string on failure so callers can surface it in the tool
   * result. The autoMaterialize contract is specifically "disk is the source
   * of truth for downstream agents", so a silent disk-write failure with a
   * Chronicle commit would defeat the whole purpose. No-op cases (flag off,
   * read-only mount) return null (success).
   */
  private async autoMaterialize(
    mount: MountState,
    relativePath: string,
    op: 'write' | 'delete',
    content?: Buffer,
  ): Promise<string | null> {
    if (!mount.config.autoMaterialize) return null;
    if (mount.config.mode === 'read-only') return null;

    const absolutePath = join(mount.config.path, relativePath);
    const watcher = this.watchers.get(mount.config.name);
    watcher?.suppress(relativePath);

    try {
      if (op === 'write' && content) {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content);
        mount.materializedHashes.set(relativePath, hashContent(content));
      } else if (op === 'delete') {
        try {
          await unlink(absolutePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        mount.materializedHashes.delete(relativePath);
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx?.pushEvent({
        type: 'workspace:materialize-failed',
        mount: mount.config.name,
        path: relativePath,
        op,
        error: msg,
      } as ProcessEvent);
      return msg;
    }
  }

  // ==========================================================================
  // Lazy Sync
  // ==========================================================================

  /**
   * Ensure a file is synced from filesystem if not yet in tree (lazy sync).
   */
  private async ensureSynced(mount: MountState, relativePath: string): Promise<void> {
    const store = this.getStore();
    const existing = store.treeGet(mount.treeStateId, relativePath);
    if (existing) return; // Already in tree

    // Try to read from filesystem
    const absolutePath = join(mount.config.path, relativePath);
    try {
      const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > maxSize) return;

      const buffer = await readFile(absolutePath);
      const content = buffer.toString('utf-8');
      const blobHash = store.storeBlob(Buffer.from(content, 'utf-8'), 'text/plain');

      store.treeSet(mount.treeStateId, relativePath, {
        blobHash,
        size: buffer.length,
        mode: 0o644,
      });
    } catch {
      // File doesn't exist on disk — that's fine
    }
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleRead(input: ReadInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    const store = this.getStore();

    await this.ensureSynced(mount, relativePath);

    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    const blob = store.getBlob(entry.blobHash);
    if (!blob) {
      return { success: false, error: `Blob not found for: ${input.path}`, isError: true };
    }

    const content = blob.toString('utf-8');
    const lines = content.split('\n');

    // Apply offset/limit
    const startLine = (input.offset ?? 1) - 1; // Convert to 0-indexed
    const endLine = input.limit ? startLine + input.limit : lines.length;
    const slice = lines.slice(startLine, endLine);

    // Format with line numbers (cat -n style)
    const formatted = slice
      .map((line, i) => `${String(startLine + i + 1).padStart(6)}\t${line}`)
      .join('\n');

    return {
      success: true,
      data: {
        path: input.path,
        totalLines: lines.length,
        fromLine: startLine + 1,
        toLine: Math.min(endLine, lines.length),
        content: formatted,
      },
    };
  }

  private async handleReadImage(input: ReadImageInput): Promise<ToolResult> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath } = this.parsePath(input.path));
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
    if (!relativePath) {
      return { success: false, error: `Path is a directory: ${input.path}`, isError: true };
    }

    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    let treeError: WorkspaceImageReadError | null = null;

    try {
      const image = this.tryReadImageFromTree(mount, relativePath, input.path, maxSize);
      if (image) {
        return {
          success: true,
          data: [
            {
              type: 'text',
              text: `Path: ${input.path}\nMIME: ${image.mimeType}\nBytes: ${image.bytes.byteLength}`,
            },
            {
              type: 'image',
              data: image.bytes.toString('base64'),
              mimeType: image.mimeType,
            },
          ],
        };
      }
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) {
        treeError = err;
      } else {
        throw err;
      }
    }

    try {
      const image = await this.readImageFromFilesystem(mount, relativePath, input.path, maxSize);
      return {
        success: true,
        data: [
          {
            type: 'text',
            text: `Path: ${input.path}\nMIME: ${image.mimeType}\nBytes: ${image.bytes.byteLength}`,
          },
          {
            type: 'image',
            data: image.bytes.toString('base64'),
            mimeType: image.mimeType,
          },
        ],
      };
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) {
        if (err.code === 'not_found' && treeError) {
          return { success: false, error: treeError.message, isError: true };
        }
        return { success: false, error: err.message, isError: true };
      }
      throw err;
    }
  }

  private async handleWrite(input: WriteInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    const maxSize = mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (Buffer.byteLength(input.content) > maxSize) {
      return { success: false, error: `Content exceeds max file size (${maxSize} bytes)`, isError: true };
    }

    const buffer = Buffer.from(input.content, 'utf-8');
    const blobHash = store.storeBlob(buffer, 'text/plain');
    store.treeSet(mount.treeStateId, relativePath, {
      blobHash,
      size: Buffer.byteLength(input.content),
      mode: 0o644,
    });
    const materializeError = await this.autoMaterialize(mount, relativePath, 'write', buffer);
    if (materializeError) {
      return {
        success: false,
        error: `Wrote to Chronicle but failed to materialize "${input.path}" to disk: ${materializeError}. Downstream agents will not see this change until the next materialize call.`,
        isError: true,
      };
    }

    return {
      success: true,
      data: {
        path: input.path,
        size: Buffer.byteLength(input.content),
        hash: hashContent(input.content),
      },
    };
  }

  private async handleEdit(input: EditInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    await this.ensureSynced(mount, relativePath);

    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    const blob = store.getBlob(entry.blobHash);
    if (!blob) {
      return { success: false, error: `Blob not found for: ${input.path}`, isError: true };
    }

    let content = blob.toString('utf-8');

    // Validate uniqueness
    if (!input.replaceAll) {
      const count = content.split(input.oldString).length - 1;
      if (count === 0) {
        return { success: false, error: `String not found in ${input.path}`, isError: true };
      }
      if (count > 1) {
        return {
          success: false,
          error: `String found ${count} times in ${input.path}. Use replaceAll: true or provide more context.`,
          isError: true,
        };
      }
    }

    content = input.replaceAll
      ? content.replaceAll(input.oldString, input.newString)
      : content.replace(input.oldString, input.newString);

    const newBuffer = Buffer.from(content, 'utf-8');
    const newBlobHash = store.storeBlob(newBuffer, 'text/plain');
    store.treeSet(mount.treeStateId, relativePath, {
      blobHash: newBlobHash,
      size: Buffer.byteLength(content),
      mode: entry.mode,
    });
    const materializeError = await this.autoMaterialize(mount, relativePath, 'write', newBuffer);
    if (materializeError) {
      return {
        success: false,
        error: `Edited Chronicle but failed to materialize "${input.path}" to disk: ${materializeError}. Downstream agents will not see this change until the next materialize call.`,
        isError: true,
      };
    }

    return {
      success: true,
      data: {
        path: input.path,
        size: Buffer.byteLength(content),
      },
    };
  }

  private async handleDelete(input: DeleteInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    const entry = store.treeGet(mount.treeStateId, relativePath);
    if (!entry) {
      return { success: false, error: `File not found: ${input.path}`, isError: true };
    }

    store.treeRemove(mount.treeStateId, relativePath);
    const materializeError = await this.autoMaterialize(mount, relativePath, 'delete');
    if (materializeError) {
      return {
        success: false,
        error: `Removed from Chronicle but failed to unlink "${input.path}" from disk: ${materializeError}. Downstream agents will still see the stale file until manual cleanup.`,
        isError: true,
      };
    }

    return { success: true, data: { path: input.path, deleted: true } };
  }

  private async handleLs(input: LsInput): Promise<ToolResult> {
    const store = this.getStore();

    if (!input.path) {
      // List all mounts
      const mounts = [...this.mounts.entries()].map(([name, m]) => ({
        name,
        path: m.config.path,
        mode: m.config.mode,
      }));
      return { success: true, data: { mounts } };
    }

    const { mount, relativePath } = this.parsePath(input.path);

    // Ensure initial sync — always sync on first access regardless of watch mode,
    // so that ls/glob/grep see filesystem contents even for unwatched mounts
    if (!mount.initialSyncDone) {
      await syncFromFs(store, mount);
      mount.initialSyncDone = true;
    }

    const prefix = relativePath ? relativePath + '/' : '';
    const entries = store.treeList(mount.treeStateId, prefix || undefined);

    if (input.recursive) {
      return {
        success: true,
        data: {
          path: input.path,
          entries: entries.map(e => ({
            path: e.path,
            size: e.size,
          })),
          count: entries.length,
        },
      };
    }

    // Non-recursive: deduplicate to show immediate children only
    const seen = new Set<string>();
    const children: Array<{ name: string; type: 'file' | 'directory' }> = [];

    for (const entry of entries) {
      const rest = entry.path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx >= 0) {
        const dirName = rest.slice(0, slashIdx);
        if (!seen.has(dirName)) {
          seen.add(dirName);
          children.push({ name: dirName, type: 'directory' });
        }
      } else {
        children.push({ name: rest, type: 'file' });
      }
    }

    return {
      success: true,
      data: {
        path: input.path,
        entries: children,
        count: children.length,
      },
    };
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    const store = this.getStore();
    const regex = globToRegex(input.pattern);
    const matches: string[] = [];

    // Search across mounts
    const mountsToSearch = input.path
      ? [this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '' }));

    for (const { mount, relativePath } of mountsToSearch) {
      if (!mount.initialSyncDone) {
        await syncFromFs(store, mount);
        mount.initialSyncDone = true;
      }

      const prefix = relativePath ? relativePath + '/' : undefined;
      const entries = store.treeList(mount.treeStateId, prefix);

      for (const entry of entries) {
        const testPath = relativePath ? entry.path.slice(relativePath.length + 1) : entry.path;
        if (regex.test(testPath)) {
          matches.push(`${mount.config.name}/${entry.path}`);
        }
      }
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        matches,
        count: matches.length,
      },
    };
  }

  private async handleGrep(input: GrepInput): Promise<ToolResult> {
    const store = this.getStore();
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (e) {
      return { success: false, error: `Invalid regex: ${input.pattern}`, isError: true };
    }

    const fileGlob = input.glob ? globToRegex(input.glob) : null;
    const contextBefore = input.contextBefore ?? 0;
    const contextAfter = input.contextAfter ?? 0;

    const mountsToSearch = input.path
      ? [this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '' }));

    const results: Array<{ file: string; matches: Array<{ line: number; text: string; context?: string[] }> }> = [];

    for (const { mount, relativePath } of mountsToSearch) {
      if (!mount.initialSyncDone) {
        await syncFromFs(store, mount);
        mount.initialSyncDone = true;
      }

      // If `path` points at a single FILE, grep just that file. Otherwise treat
      // `path` as a directory prefix (the original behaviour). Previously a file
      // path produced an empty prefix like "notes.md/" and matched nothing, so
      // grepping a specific file silently returned zero results.
      let entries: Array<{ path: string; blobHash: string }>;
      const fileNode = relativePath
        ? (store.treeGet(mount.treeStateId, relativePath) as { blobHash?: string } | null)
        : null;
      if (fileNode && fileNode.blobHash) {
        entries = [{ path: relativePath, blobHash: fileNode.blobHash }];
      } else {
        const prefix = relativePath ? relativePath + '/' : undefined;
        entries = store.treeList(mount.treeStateId, prefix);
      }

      for (const entry of entries) {
        if (fileGlob && !fileGlob.test(entry.path)) continue;

        const blob = store.getBlob(entry.blobHash);
        if (!blob) continue;

        const content = blob.toString('utf-8');
        const lines = content.split('\n');
        const fileMatches: Array<{ line: number; text: string; context?: string[] }> = [];

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const match: { line: number; text: string; context?: string[] } = {
              line: i + 1,
              text: lines[i],
            };
            if (contextBefore > 0 || contextAfter > 0) {
              const start = Math.max(0, i - contextBefore);
              const end = Math.min(lines.length, i + contextAfter + 1);
              match.context = lines.slice(start, end);
            }
            fileMatches.push(match);
          }
        }

        if (fileMatches.length > 0) {
          results.push({
            file: `${mount.config.name}/${entry.path}`,
            matches: fileMatches,
          });
        }
      }
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        results,
        totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      },
    };
  }

  private async handleStatus(_input: StatusInput): Promise<ToolResult> {
    const store = this.getStore();
    const status: Record<string, unknown> = {};

    for (const [name, mount] of this.mounts) {
      const entries = store.treeList(mount.treeStateId);
      const currentSeq = store.currentSequence();
      const changes = mount.lastMaterializedSeq > 0
        ? store.treeDiff(mount.treeStateId, mount.lastMaterializedSeq, currentSeq)
        : [];

      const currentBranch = store.currentBranch();
      status[name] = {
        path: mount.config.path,
        mode: mount.config.mode,
        watch: mount.config.watch ?? 'always',
        fileCount: entries.length,
        lastMaterializedSeq: mount.lastMaterializedSeq,
        currentSeq,
        pendingChanges: changes.length,
        initialSyncDone: mount.initialSyncDone,
        currentBranch: currentBranch.name,
        lastMaterializedBranch: mount.lastMaterializedBranchId,
        canMaterialize: !mount.lastMaterializedBranchId || mount.lastMaterializedBranchId === currentBranch.id,
      };
    }

    return { success: true, data: status };
  }

  private async handleMaterialize(input: MaterializeInput): Promise<ToolResult> {
    const store = this.getStore();

    // Guard: only materialize on the active branch
    if (this.config.materializeOnlyActiveBranch !== false) {
      const currentBranch = store.currentBranch();
      for (const mount of this.mounts.values()) {
        if (mount.lastMaterializedBranchId && mount.lastMaterializedBranchId !== currentBranch.id) {
          return {
            success: false,
            error: `Cannot materialize: current branch "${currentBranch.name}" differs from last materialized branch. Switch back or set materializeOnlyActiveBranch: false.`,
            isError: true,
          };
        }
      }
    }

    const allWritten: Array<{ mount: string; path: string }> = [];

    let mountsToMaterialize: Array<{ name: string; mount: MountState }>;
    if (input.mount) {
      const m = this.mounts.get(input.mount);
      if (!m) {
        return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
      }
      mountsToMaterialize = [{ name: input.mount, mount: m }];
    } else {
      mountsToMaterialize = [...this.mounts.entries()]
        .filter(([, m]) => m.config.mode === 'read-write')
        .map(([name, mount]) => ({ name, mount }));
    }

    for (const { name, mount } of mountsToMaterialize) {

      let paths: string[] | undefined;
      if (input.path) {
        const { relativePath } = this.parsePath(input.path);
        paths = relativePath ? [relativePath] : undefined;
      }

      // Suppress watcher for paths we're about to write
      const watcher = this.watchers.get(name);
      const written = await materializeToFs(store, mount, paths);

      for (const p of written) {
        watcher?.suppress(p);
        allWritten.push({ mount: name, path: p });
      }

      // Track which branch we materialized on
      if (written.length > 0) {
        mount.lastMaterializedBranchId = store.currentBranch().id;
      }
    }

    return {
      success: true,
      data: {
        materialized: allWritten,
        count: allWritten.length,
      },
    };
  }

  /**
   * Programmatically materialize a mount's files from Chronicle tree to filesystem.
   * Used after branch switches to refresh filesystem state.
   * Resets branch tracking to allow cross-branch materialization.
   */
  async materializeMount(mountName: string): Promise<string[]> {
    const store = this.getStore();
    const mount = this.mounts.get(mountName);
    if (!mount || mount.config.mode === 'read-only') return [];

    // Reset tracking — we're deliberately materializing on the new branch
    mount.lastMaterializedBranchId = null;
    mount.lastMaterializedSeq = 0;

    const watcher = this.watchers.get(mountName);
    const written = await materializeToFs(store, mount);
    for (const p of written) {
      watcher?.suppress(p);
    }
    if (written.length > 0) {
      mount.lastMaterializedBranchId = store.currentBranch().id;
    }
    return written;
  }

  private async handleSync(input: SyncInput): Promise<ToolResult> {
    const store = this.getStore();
    const allResults: Array<{ mount: string; synced: string[]; conflicts: ConflictInfo[] }> = [];

    let mountsToSync: Array<{ name: string; mount: MountState }>;
    if (input.mount) {
      const m = this.mounts.get(input.mount);
      if (!m) {
        return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
      }
      mountsToSync = [{ name: input.mount, mount: m }];
    } else {
      mountsToSync = [...this.mounts.entries()].map(([name, mount]) => ({ name, mount }));
    }

    for (const { name, mount } of mountsToSync) {

      let paths: string[] | undefined;
      if (input.path) {
        const { relativePath } = this.parsePath(input.path);
        // Empty relativePath means mount root — sync entire mount, not a single path
        paths = relativePath ? [relativePath] : undefined;
      }

      const result = await syncFromFs(store, mount, paths);
      mount.initialSyncDone = true;

      if (result.synced.length > 0 || result.conflicts.length > 0) {
        allResults.push({
          mount: name,
          synced: result.synced.map(s => s.path),
          conflicts: result.conflicts,
        });
        this.emitFsEvents(name, result.synced, result.conflicts);
      }
    }

    return {
      success: true,
      data: {
        results: allResults,
        totalSynced: allResults.reduce((sum, r) => sum + r.synced.length, 0),
        totalConflicts: allResults.reduce((sum, r) => sum + r.conflicts.length, 0),
      },
    };
  }

  // ==========================================================================
  // Internal: Filesystem Change Handling
  // ==========================================================================

  /**
   * Handle filesystem changes detected by watcher (watch: 'always' mode).
   *
   * The watcher carries the op per path. For created/modified we call
   * syncFromFs to pull content into the tree; for deleted we strip the tree
   * entry directly (the file is gone, nothing to read). We emit one event per
   * op type.
   */
  private async handleFsChanges(mountName: string, changes: FsChange[]): Promise<void> {
    const store = this.store;
    const mount = this.mounts.get(mountName);
    if (!store || !mount) return;

    const touchedPaths = changes.filter(c => c.op !== 'deleted').map(c => c.path);
    const deletedPaths = changes.filter(c => c.op === 'deleted').map(c => c.path);

    const syncResult = touchedPaths.length > 0
      ? await syncFromFs(store, mount, touchedPaths)
      : { synced: [], conflicts: [], skipped: [] };

    // Strip deleted entries from the tree so downstream consumers see a
    // coherent state. syncFromFs would also do this if we passed the paths in,
    // but the op from the watcher is authoritative — skip the access() probe.
    for (const p of deletedPaths) {
      const existing = store.treeGet(mount.treeStateId, p);
      if (existing) {
        store.treeRemove(mount.treeStateId, p);
        syncResult.synced.push({ path: p, op: 'deleted' });
      }
    }

    this.emitFsEvents(mountName, syncResult.synced, syncResult.conflicts);
  }

  /**
   * Group synced paths by op and push one ProcessEvent per non-empty op.
   */
  private emitFsEvents(
    mountName: string,
    synced: Array<{ path: string; op: WorkspaceFsOp }>,
    conflicts: ConflictInfo[],
  ): void {
    if (!this.ctx || synced.length === 0) return;

    const byOp = new Map<WorkspaceFsOp, string[]>();
    for (const { path, op } of synced) {
      const list = byOp.get(op) ?? [];
      list.push(`${mountName}/${path}`);
      byOp.set(op, list);
    }

    // Conflicts by definition require a prior tree entry (sync detected that
    // the agent-side version diverged from the filesystem baseline), which
    // means the path is being re-synced as a modification. Attach conflicts
    // only to the workspace:modified event, intersected with its paths — a
    // created/deleted batch can't carry a meaningful conflict.
    const conflictsByPath = new Map<string, ConflictInfo>();
    for (const c of conflicts) conflictsByPath.set(c.path, c);

    for (const [op, paths] of byOp) {
      const type = opToEventType(op);
      let eventConflicts: string[] | undefined;
      if (op === 'modified' && conflictsByPath.size > 0) {
        const matched = paths.filter(p => conflictsByPath.has(p.slice(mountName.length + 1)));
        if (matched.length > 0) eventConflicts = matched;
      }
      const event = {
        type,
        paths,
        mount: mountName,
        ...(eventConflicts ? { conflicts: eventConflicts } : {}),
      } as WorkspaceCreatedEvent | WorkspaceModifiedEvent | WorkspaceDeletedEvent;
      this.ctx.pushEvent(event as ProcessEvent);
    }
  }

}

// ==========================================================================
// Utilities
// ==========================================================================

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  // Split pattern into segments, handling {a,b,c} alternation
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '{') {
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx > i) {
        const alternatives = pattern.slice(i + 1, closeIdx).split(',');
        regex += '(?:' + alternatives.map(a => globPartToRegex(a)).join('|') + ')';
        i = closeIdx + 1;
        continue;
      }
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

function globPartToRegex(part: string): string {
  return part
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
}
