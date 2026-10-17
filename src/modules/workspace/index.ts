/**
 * WorkspaceModule — mountable filesystem abstraction backed by Chronicle tree state.
 *
 * Provides a unified workspace with mount-based filesystem access,
 * auto-sync between real filesystem and Chronicle, and manual materialization.
 */

import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { open, readFile, stat, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import type { JsStore } from '@animalabs/chronicle';
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
import { hashContent, DEFAULT_MAX_FILE_SIZE } from './sync.js';
import { DiskAgreement, sameRootIdentity } from './disk-agreement.js';
import { BranchIntents } from './branch-intent.js';
import { coveredByIgnore, filesystemTrustsCtime, locateRoot, readPrefix } from './observe.js';
import { TOOL_BATCH_HOOK_TIMEOUT_MS } from '../../module-registry.js';
import {
  type MountRuntime,
  type PassOptions,
  type PassResult,
  type PathReport,
  type PushOptions,
  type PushResult,
  type Scope,
  type TreeOp,
  WALK_CAP,
  pushPaths,
  reconcilePass,
  settleAdoptionBeforeMutation,
} from './reconcile.js';

/** Default for how long the after-batch scan may hold the agent's next inference. */
const AGENT_ACTION_SCAN_DEADLINE_MS = 20_000;
/** Why a call is refused once the module has stopped. */
const NOT_RUNNING = 'The workspace has stopped: it takes no more work until it starts again';
/** The workspace's own deadline must end before the framework's hook bound. */
const AGENT_ACTION_SCAN_DEADLINE_MAX_MS = TOOL_BATCH_HOOK_TIMEOUT_MS - 1_000;

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

/**
 * Why a workspace-owned filesystem read was refused. Distinguishes the cases a
 * peer needs to react to differently: a path that never resolved inside the
 * mount (`unknown_mount`, `traversal`), a mount whose root is gone
 * (`mount_unavailable`), an ordinary missing file (`not_found`), a directory
 * (`directory`), a symlink refused by the mount's `followSymlinks` policy
 * (`symlink`), a symlink whose canonical target lands outside the canonical
 * mount root (`escape`), and a file swapped underneath the read (`changed`).
 */
export type WorkspaceReadErrorCode =
  | 'unknown_mount'
  | 'traversal'
  | 'mount_unavailable'
  | 'not_found'
  | 'directory'
  | 'symlink'
  | 'escape'
  | 'changed';

/** Where in the open sequence a `WorkspaceReadError` originated (diagnostics). */
export type WorkspaceReadStage =
  | 'parse'
  | 'lstat'
  | 'realpath_root'
  | 'open'
  | 'fstat'
  | 'post_lstat'
  | 'realpath'
  | 'stat'
  | 'read';

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

function errnoOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}

/** read_image's refusal of a file over the mount's size limit, wherever it's found to be. */
function imageTooLarge(maxSize: number, mountPrefixedPath: string): WorkspaceImageReadError {
  return new WorkspaceImageReadError('too_large', `Image file exceeds max size (${maxSize} bytes): ${mountPrefixedPath}`);
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
  /** Set once stop has drained and saved, cleared by start (running()). */
  private stopped = false;
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
  /** Persisted state decoded in start(), held until mounts exist to apply it
   *  to — in the Host ordering start() runs before initStore() creates the
   *  mounts, so restoration must be second-callback-safe like watcher
   *  startup already is (issue #72). Cleared after application. */
  private savedState: WorkspaceModuleState | null = null;

  constructor(config: WorkspaceConfig) {
    for (const mount of config.mounts) {
      const cap: unknown = mount.walkCap;
      if (cap !== undefined && !(Number.isSafeInteger(cap) && (cap as number) > 0)) {
        // Numbers as JavaScript writes them (JSON would say null for NaN), anything else as JSON.
        const shown = typeof cap === 'number' ? String(cap) : typeof cap === 'bigint' ? `${cap}n` : JSON.stringify(cap) ?? String(cap);
        throw new Error(
          `[workspace] Mount "${mount.name}": walkCap must be a positive integer no larger than ${Number.MAX_SAFE_INTEGER}, not ${shown}`,
        );
      }
    }
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

    // Register tree states for each mount: the workspace tree, and the
    // branch-local intent that qualifies it.
    for (const mount of this.config.mounts) {
      const treeStateId = `workspace/${mount.name}/tree`;
      const intentTreeStateId = `workspace/${mount.name}/intent`;
      for (const id of [treeStateId, intentTreeStateId]) {
        try {
          store.registerState({
            id,
            strategy: 'tree',
            deltaSnapshotEvery: this.config.deltaSnapshotEvery ?? 50,
            fullSnapshotEvery: this.config.fullSnapshotEvery ?? 10,
          });
        } catch {
          // State already registered (restart scenario)
        }
      }

      const mountState: MountState = {
        config: mount,
        treeStateId,
        intentTreeStateId,
        lastMaterializedSeq: 0,
        suppressedPaths: new Set(),
        initialSyncDone: false,
        lastMaterializedBranchId: null,
        watcherReadyAt: null,
        watcherError: null,
      };
      this.mounts.set(mount.name, mountState);
      this.intents.set(mount.name, new BranchIntents(store, intentTreeStateId));
    }

    // What disk last agreed with, per mount and path: global records, so a
    // branch switch never rewinds it.
    this.agreement = new DiskAgreement(store);
    this.agreement.open(this.config.mounts.map((m) => ({ name: m.name, root: resolve(m.path) })));

    this.applySavedState();
    this.ensureRunning();
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
      view: {
        root,
        rootIdentity: this.agreementOrThrow().rootIdentity(mount.config.name),
        followSymlinks: mount.config.followSymlinks === true,
        maxFileSize: mount.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
        ignore: mount.config.ignore ?? [],
      },
      rootReal,
      ctimeTrustedDev: trustedDev,
      treeStateId: mount.treeStateId,
      intents: this.intents.get(mount.config.name)!,
      readOnly: mount.config.mode === 'read-only',
      walkCap: mount.config.walkCap ?? WALK_CAP,
      catchUpScan: (mount.config.watch ?? 'always') === 'always',
    };
  }

  /** One disk→store pass; the caller holds the mount's turn. Emits its events. */
  private async passUnlocked(mount: MountState, scope: Scope, opts: PassOptions = {}): Promise<PassResult> {
    const result = await reconcilePass(this.getStore(), this.agreementOrThrow(), await this.runtime(mount), scope, opts);
    if (scope.kind === 'dir' && scope.dir === '' && scope.recursive) mount.initialSyncDone = true;
    this.emitFsEvents(mount.config.name, result.ops, result.newConflicts);
    return result;
  }

  /** One store→disk push; the caller holds the mount's turn. */
  private async pushUnlocked(mount: MountState, paths: string[], opts: PushOptions = {}): Promise<PushResult> {
    const watcher = this.watchers.get(mount.config.name);
    return pushPaths(this.getStore(), this.agreementOrThrow(), await this.runtime(mount), paths, {
      ...opts,
      beforeEffect: (p) => watcher?.suppress(p),
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
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
      `never had. Pass force: true to overwrite disk from the current branch if it is canonical.`
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

        // Chokidar is started with ignoreInitial:true, so changes made while
        // the session was down would be invisible. A catch-up pass takes them
        // in under the three-way rule: only real differences produce tree
        // changes and events. It takes its turn with the mount's bare syncs,
        // so on a mount over its walkCap it covers the walkCap entries after
        // where the last turn stopped, and a change elsewhere waits for the
        // rotation to reach it, or for a sync of its path.
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
    // No new watcher-driven passes, then let every pass and write finish
    // before the store goes away — including any queued behind the ones in
    // flight (a tool call, a scan continuing past its deadline): drained
    // until no new tail appears.
    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();
    for (;;) {
      const tails = [...this.mountTurns.values()];
      await Promise.all(tails);
      const now = [...this.mountTurns.values()];
      if (now.length === tails.length && now.every((tail, i) => tail === tails[i])) break;
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
    this.ctx = null;
  }

  /** Mount names + modes, for peer callers (framework spill/journal paths)
   *  that need a writable mount without reaching into private state. */
  getMounts(): Array<{ name: string; mode: 'read-write' | 'read-only' }> {
    return [...this.mounts.values()].map((m) => ({
      name: m.config.name,
      mode: m.config.mode === 'read-only' ? 'read-only' : 'read-write',
    }));
  }

  // ==========================================================================
  // Tool Definitions
  // ==========================================================================

  getTools(): ToolDefinition[] {
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
            offset: { type: 'number', description: 'Starting line number (1-indexed)' },
            limit: { type: 'number', description: 'Maximum number of lines to return (default 2000)' },
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
        description: 'Delete a file from the workspace. On a mount without autoMaterialize the disk copy stays, '
          + 'listed as workspace-deleted (no scan brings it back), until materialize with applyDeletions removes it '
          + 'or a sync of the path restores it.',
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
          + 'interrupted) — sync the path to take disk, or materialize that path with force to take the workspace; '
          + 'disk-missing-provenance-unknown; unverified (disk could not be checked). `incomplete` names regions '
          + 'the listing could not see.',
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
        description: 'Find files matching a glob pattern, checked against disk first; each match carries its state, as ls describes.',
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
        description: 'Search stored file text with a regex pattern, checked against disk first. Each result says '
          + 'which version matched: the workspace\'s (with its state); the disk version kept with a conflict '
          + '(conflicting-disk); or, once disk has changed since the conflict was recorded, that recorded version '
          + '(recorded-disk). Disk versions it could not search are listed as skipped: disk-only files (binary or '
          + 'over the size limit), and a conflict\'s disk version that is binary, oversize, or newer than the one recorded.',
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
        description: 'Write workspace files to the real filesystem. Use after writing/editing to push changes to disk. '
          + 'Never deletes disk files unless applyDeletions is given; lists workspace deletions it left on disk.',
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
          + 'reported nowhere else is counted under `passedOver`, by mount and reason: entries the mount\'s '
          + 'ignore list covers that hold nothing the workspace tracks (an ignored directory counts once). So a '
          + 'total of 0, with no conflicts and nothing under `passedOver`, `incomplete` or `skipped`, means the '
          + 'sync looked everywhere and nothing had changed. A path the mount ignores is synced when you name '
          + 'it, and listed under `ignored`: a sync without a path passes over it. Naming an ignored directory '
          + 'sets aside the patterns that cover it or a directory above it; one that covers only something '
          + 'inside it still applies, and what it covers is passed over.',
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
    const resolved = resolve(mount.path, slash < 0 ? '' : path.slice(slash + 1));
    if (!isContainedPath(mount.path, resolved)) throw new Error(`Path traversal detected: "${path}"`);
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
    try {
      const input = call.input as Record<string, unknown>;
      const generated = typeof input?.path === 'string' ? this.findGeneratedTextFile(input.path) : undefined;
      if (generated) {
        if (call.callerAgentName !== generated.agentName) return {success:false,isError:true,error:'Generated file belongs to another agent'};
        if (call.name !== 'read') return {success:false,isError:true,error:'Generated file is read-only; edit the presentation configuration instead'};
        return await this.handleRead(input as unknown as ReadInput, generated.read());
      }

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
   * resolved path escapes the mount root.
   *
   * **Lexical containment only.** The guard reasons about `..` segments in the
   * path string; it knows nothing about what is on disk. A symlink inside the
   * mount that targets an outside file passes this check, and a caller that
   * then does `fs.readFile(path)` reads the outside content. Use the returned
   * path for resolution-only purposes (write targets, nonexistent paths,
   * display); for reading file content, use {@link readFileFromDisk}, which
   * enforces the mount's `followSymlinks` policy and canonical containment.
   *
   * @deprecated for direct filesystem reads — call `readFileFromDisk()`.
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
   * A write whose tree entry is set but that then fails returns success
   * false with `data: { inChronicle: true }`: its copy on disk was refused, or
   * something after the entry (recording its intent, the event, the push)
   * threw. The workspace's tools read the file from the tree, so it is there
   * for them, on the branch that was current when the entry was set.
   */
  async writeBinary(
    mountPrefixedPath: string,
    data: Buffer,
    mimeType: string,
    options: { branch?: string } = {},
  ): Promise<ToolResult> {
    if (!this.running()) return { success: false, isError: true, error: NOT_RUNNING };
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
    return this.withMount(mount, async () => {
      await this.settleBeforeMutation(mount, relativePath);
      // Checked inside the mount's turn, after anything the write waited on:
      // commitToolChange sets the tree entry before it first yields.
      if (options.branch !== undefined && store.currentBranch().name !== options.branch) {
        return { success: false, error: 'the workspace had left the branch this file is for', isError: true, data: { branchLeft: true } };
      }
      const blobHash = store.storeBlob(data, mimeType);
      let committed = false;
      let failure: string | null;
      try {
        const materializeError = await this.commitToolChange(mount, relativePath,
          { kind: 'set', blobHash, size: data.byteLength }, () => { committed = true; });
        failure = materializeError === null ? null
          : `Wrote to Chronicle but failed to materialize "${mountPrefixedPath}" to disk: ${materializeError}.`;
      } catch (error) {
        if (!committed) throw error;
        failure = `Stored "${mountPrefixedPath}" in Chronicle, but the rest of the write failed: ${error instanceof Error ? error.message : String(error)}.`;
      }
      if (failure !== null) {
        // The file is in the Chronicle tree, where the workspace's tools read
        // it. `inChronicle` lets a caller that needs the file readable tell
        // this from a write that never happened (agent-framework #281).
        return { success: false, error: failure, isError: true, data: { inChronicle: true } };
      }
      return {
        success: true,
        data: { path: mountPrefixedPath, size: data.byteLength, mimeType },
      };
    });
  }

  /**
   * Read a file's raw bytes from a mount (through the Chronicle tree, synced
   * first like the `read` tool). Public API for the framework's synthesized
   * `read_image` tool and other peer callers that need binary content.
   */
  async readBinary(
    mountPrefixedPath: string,
  ): Promise<{ data: Buffer } | { error: string }> {
    if (!this.running()) return { error: NOT_RUNNING };
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath } = this.parsePath(mountPrefixedPath));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const store = this.getStore();
    return this.withMount(mount, async () => {
      await this.ensureSynced(mount, relativePath);
      const entry = store.treeGet(mount.treeStateId, relativePath);
      if (!entry) return { error: `File not found: ${mountPrefixedPath}` };
      const blob = store.getBlob(entry.blobHash);
      if (!blob) return { error: `Blob not found for: ${mountPrefixedPath}` };
      return { data: blob };
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
   * declared mounts, nothing above their root. Deliberately does NOT sync,
   * register, or hash anything — it reads and returns.
   */
  async readBinaryFromDisk(
    mountPrefixedPath: string,
    opts: { maxBytes?: number } = {},
  ): Promise<{ data: Buffer; absolutePath: string } | { error: string }> {
    let mount: MountState;
    let relativePath: string;
    try {
      ({ mount, relativePath } = this.parsePath(mountPrefixedPath));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const absolutePath = resolve(mount.config.path, relativePath);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) return { error: `Not a file: ${mountPrefixedPath}` };
      if (opts.maxBytes !== undefined && info.size > opts.maxBytes) {
        return { error: `File too large: ${info.size} > ${opts.maxBytes} bytes` };
      }
      return { data: await readFile(absolutePath), absolutePath };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return { error: `File not found on disk: ${mountPrefixedPath}` };
      return { error: error instanceof Error ? error.message : String(error) };
    }
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

    // Path traversal guard (CWE-22): ensure resolved path stays within mount.
    // Containment must compare with the PLATFORM separator (isContainedPath):
    // resolve() emits backslashes on Windows, so a '/'-suffixed root never
    // prefix-matches there and every in-mount path was rejected as traversal.
    const resolved = resolve(mount.config.path, relativePath);
    if (!isContainedPath(mount.config.path, resolved)) {
      throw new Error(`Path traversal detected: "${path}" resolves outside mount "${mountName}"`);
    }

    return { mount, relativePath };
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
      throw new WorkspaceImageReadError('empty', `Image file is empty: ${mountPrefixedPath}`);
    }
    if (bytes.byteLength > maxSize) throw imageTooLarge(maxSize, mountPrefixedPath);
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

  /**
   * Open a mount-relative file for reading with the mount boundary enforced on
   * the *filesystem*, not just the path string:
   *
   * 1. `lstat` the lexical path — refuse directories; refuse a final-component
   *    symlink when the mount does not `followSymlinks`.
   * 2. Open with `O_NOFOLLOW` where the platform has it (POSIX) so the refusal
   *    holds against a symlink swapped in between lstat and open; where it
   *    doesn't (Windows), re-`lstat` after opening instead.
   * 3. `realpath` both the mount root and the opened path and require canonical
   *    containment — this is what catches an *intermediate* symlinked
   *    directory escaping the mount, and a followed symlink whose target lands
   *    outside, on every platform (junctions included).
   * 4. Confirm the descriptor and the canonical path are the same inode.
   *
   * `inspect` runs right after the descriptor is stat'd and before the
   * containment work, so callers can impose size policy in the same order the
   * image reader always has. The returned handle is the caller's to close.
   */
  private async openContainedFile(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    inspect?: (fileStat: Stats) => void,
  ): Promise<{ handle: Awaited<ReturnType<typeof open>>; fileStat: Stats; realFilePath: string }> {
    const lexicalPath = resolve(mount.config.path, relativePath);
    const follow = mount.config.followSymlinks === true;
    const useNoFollow = !follow && typeof fsConstants.O_NOFOLLOW === 'number';

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

    let realMountRoot: string;
    try {
      realMountRoot = await realpath(mount.config.path);
    } catch (err) {
      throw new WorkspaceReadError('mount_unavailable', `Mount unavailable: ${mount.config.name}`, 'realpath_root', errnoOf(err));
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lexicalPath, fsConstants.O_RDONLY | (useNoFollow ? fsConstants.O_NOFOLLOW : 0));
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
        throw new WorkspaceReadError('not_found', `File not found: ${mountPrefixedPath}`, 'fstat');
      }
      inspect?.(fileStat);

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

      if (!isContainedPath(realMountRoot, realFilePath)) {
        throw new WorkspaceReadError('escape', `Symlink escape detected: ${mountPrefixedPath}`, 'realpath');
      }

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
   *
   * Throws {@link WorkspaceReadError} with a `code` distinguishing unknown
   * mount, lexical traversal, unavailable mount, missing file, directory,
   * policy-denied symlink, outside-mount target, and file-changed-during-read.
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
      ({ mount, relativePath } = this.parsePath(mountPrefixedPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: WorkspaceReadErrorCode = message.startsWith('Unknown mount') ? 'unknown_mount' : 'traversal';
      throw new WorkspaceReadError(code, message, 'parse');
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

  /** Map a core read refusal onto the image reader's historical error vocabulary and wording. */
  private imageErrorFromRead(err: WorkspaceReadError, mount: MountState, mountPrefixedPath: string): WorkspaceImageReadError {
    const p = mountPrefixedPath;
    switch (err.code) {
      case 'mount_unavailable':
        return new WorkspaceImageReadError('mount_unavailable', `Mount unavailable: ${mount.config.name}`);
      case 'directory':
        return new WorkspaceImageReadError('directory', `Path is a directory: ${p}`);
      case 'symlink':
        return new WorkspaceImageReadError('symlink', `Symlinks are not allowed: ${p}`);
      case 'escape':
        return new WorkspaceImageReadError('escape', `Symlink escape detected: ${p}`);
      case 'changed':
        return new WorkspaceImageReadError('changed', `Image file changed during read: ${p}`);
      case 'not_found':
      default:
        if (err.message.startsWith('File not found')) {
          return new WorkspaceImageReadError('not_found', `File not found: ${p}`);
        }
        if (err.stage === 'realpath') {
          return new WorkspaceImageReadError('not_found', `Unable to resolve image file: ${p}`);
        }
        if (err.stage === 'stat') {
          return new WorkspaceImageReadError('not_found', `Unable to stat image file: ${p}`);
        }
        return new WorkspaceImageReadError('not_found', `Unable to read image file: ${p}`);
    }
  }

  private async readImageFromFilesystem(
    mount: MountState,
    relativePath: string,
    mountPrefixedPath: string,
    maxSize: number,
  ): Promise<{ bytes: Buffer; mimeType: SupportedImageMimeType }> {
    let opened: Awaited<ReturnType<WorkspaceModule['openContainedFile']>>;
    try {
      opened = await this.openContainedFile(mount, relativePath, mountPrefixedPath, (fileStat) => {
        if (fileStat.size === 0) {
          throw new WorkspaceImageReadError('empty', `Image file is empty: ${mountPrefixedPath}`);
        }
        if (fileStat.size > maxSize) throw imageTooLarge(maxSize, mountPrefixedPath);
      });
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) throw err;
      if (err instanceof WorkspaceReadError) throw this.imageErrorFromRead(err, mount, mountPrefixedPath);
      if (isErrnoCode(err, 'ENOENT')) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
    }
    const { handle, fileStat } = opened;
    try {
      // No more than maxSize is loaded: a file grown past it since the fstat
      // above is refused here, as one already over it was there.
      const { bytes, more } = await readPrefix(handle, maxSize, fileStat.size);
      if (more) throw imageTooLarge(maxSize, mountPrefixedPath);
      return this.validateImageBytes(bytes, mountPrefixedPath, maxSize);
    } catch (err) {
      if (err instanceof WorkspaceImageReadError) throw err;
      if (isErrnoCode(err, 'ENOENT')) {
        throw new WorkspaceImageReadError('not_found', `File not found: ${mountPrefixedPath}`);
      }
      throw new WorkspaceImageReadError('not_found', `Unable to read image file: ${mountPrefixedPath}`);
    } finally {
      await handle.close();
    }
  }

  /**
   * Commit a tool's write or delete to the workspace tree, with the branch
   * intent it implies (store origin for a path disk never agreed with; a
   * tombstone for a deletion), and push it to disk when the mount opts in via
   * `autoMaterialize` — required for cross-agent pipelines, since another
   * agent's watcher on the same directory only sees real filesystem events.
   * The push follows materialize's rule: a disk copy that changed since it
   * last agreed is not overwritten or unlinked, and the refusal says why.
   *
   * Returns the reason when the change reached the workspace but not disk, so
   * callers surface it in the tool result: the autoMaterialize contract is
   * that disk is the source of truth for downstream agents. The caller holds
   * the mount's turn and has settled the path first (settleBeforeMutation).
   */
  private async commitToolChange(
    mount: MountState,
    relativePath: string,
    change: { kind: 'set'; blobHash: string; size: number; mode?: number } | { kind: 'remove'; previousHash: string },
    onCommitted?: () => void,
  ): Promise<string | null> {
    const store = this.getStore();
    const intents = this.intents.get(mount.config.name)!;
    // The mutation's precondition, enforced here, synchronously with the
    // commit: whatever settleBeforeMutation's pass could or couldn't settle.
    settleAdoptionBeforeMutation(store, this.agreementOrThrow(), { name: mount.config.name, treeStateId: mount.treeStateId }, relativePath);
    const known = this.agreementOrThrow().get(mount.config.name, relativePath) !== undefined;
    if (change.kind === 'set') {
      store.treeSet(mount.treeStateId, relativePath, { blobHash: change.blobHash, size: change.size, mode: change.mode ?? 0o644 });
      // A later intent update or disk push can throw; the tree entry is
      // already set, on the branch current now. If the active branch changes
      // during the push, that branch's tree has the file and the new one may
      // not.
      onCommitted?.();
      intents.update(relativePath, (cur) => {
        const next = { ...cur };
        delete next.tombstone;
        // Disk has never agreed with this path: a missing disk copy is a draft
        // not yet materialized, not a deletion.
        if (!known) next.origin = 'store';
        return next;
      });
    } else {
      store.treeRemove(mount.treeStateId, relativePath);
      intents.update(relativePath, (cur) => {
        const next = { ...cur, tombstone: { hash: change.previousHash } };
        delete next.origin;
        return next;
      });
    }
    if (!mount.config.autoMaterialize || mount.config.mode === 'read-only') return null;

    const pushed = await this.pushUnlocked(mount, [relativePath], {
      applyDeletions: change.kind === 'remove',
      branchId: store.currentBranch().id,
    });
    const refused = pushed.skipped.find((s) => s.path === relativePath);
    if (!refused) return null;
    this.ctx?.pushEvent({
      type: 'workspace:materialize-failed',
      mount: mount.config.name,
      path: relativePath,
      op: change.kind === 'set' ? 'write' : 'delete',
      error: refused.reason,
    } as ProcessEvent);
    return refused.reason;
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
   * synchronously, where the change commits (commitToolChange). The caller
   * holds the mount's turn.
   */
  private async settleBeforeMutation(mount: MountState, relativePath: string): Promise<void> {
    if (this.agreementOrThrow().get(mount.config.name, relativePath)?.kind !== 'pending') return;
    await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] });
  }

  /**
   * Before a read: a path the workspace doesn't hold is observed under the
   * three-way rule, which ingests a new disk file but never brings back a
   * workspace deletion or a file absent from this branch. The caller holds
   * the mount's turn.
   */
  private async ensureSynced(mount: MountState, relativePath: string): Promise<PathReport | undefined> {
    const store = this.getStore();
    if (store.treeGet(mount.treeStateId, relativePath)) return undefined;
    const pass = await this.passUnlocked(mount, { kind: 'paths', paths: [relativePath] });
    return pass.reports.get(relativePath);
  }

  /** Why the workspace holds no entry at a path, when disk explains it. */
  private notInWorkspace(path: string, report: PathReport | undefined): string {
    switch (report?.state) {
      case 'workspace-deleted':
        return `${path} was deleted in the workspace; disk still has a copy. Sync this path to restore it.`;
      case 'not-in-branch':
        return `${path} is not in this branch's workspace; disk has a copy. Sync this path to add it.`;
      case 'disk-only':
        return `${path} is on disk but not stored in the workspace (binary or over the size limit)` +
          (report.mimeType?.startsWith('image/') ? '; read it with read_image.' : '.');
      case 'conflict':
        return `${path} is in conflict: the workspace deleted it and disk changed it since. ` +
          'Sync this path to take the disk version.';
      case 'unverified':
        return `${path} is not in the workspace, and disk could not be checked (${report.note ?? 'not observed'}).`;
      default:
        return `File not found: ${path}`;
    }
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  private async handleRead(input: ReadInput, generatedContent?: string): Promise<ToolResult> {
    const characterPaging = input.offsetChars !== undefined || input.limitChars !== undefined;
    const offsetChars = input.offsetChars ?? 0;
    const limitChars = input.limitChars ?? 2000;
    if (characterPaging) {
      if (input.offset !== undefined || input.limit !== undefined) {
        return { success: false, isError: true, error: 'Use either offset/limit (lines) or offsetChars/limitChars (characters), not both.' };
      }
      if (!Number.isSafeInteger(offsetChars) || offsetChars < 0
          || !Number.isSafeInteger(limitChars) || limitChars < 1
          || input.offsetChars === null || input.limitChars === null) {
        return { success: false, isError: true, error: 'offsetChars must be a non-negative safe integer and limitChars a positive safe integer.' };
      }
    }
    let content = generatedContent;
    if (content === undefined) {
      const { mount, relativePath } = this.parsePath(input.path);
      const store = this.getStore();
      const found = await this.withMount(mount, async (): Promise<{ text: string } | { error: string }> => {
        const report = await this.ensureSynced(mount, relativePath);
        const entry = store.treeGet(mount.treeStateId, relativePath);
        if (!entry) return { error: this.notInWorkspace(input.path, report) };
        const blob = store.getBlob(entry.blobHash);
        if (!blob) return { error: `Blob not found for: ${input.path}` };
        return { text: blob.toString('utf-8') };
      });
      if ('error' in found) return { success: false, error: found.error, isError: true };
      content = found.text;
    }
    if (characterPaging) {
      const start = Math.min(offsetChars, content.length);
      const splitsPair = (at: number): boolean =>
        at > 0 && at < content.length
        && content.charCodeAt(at - 1) >= 0xd800 && content.charCodeAt(at - 1) <= 0xdbff
        && content.charCodeAt(at) >= 0xdc00 && content.charCodeAt(at) <= 0xdfff;
      if (splitsPair(start)) {
        return { success: false, isError: true, error: 'offsetChars splits a surrogate pair; use nextOffsetChars from the previous page.' };
      }
      let end = start + Math.min(limitChars, content.length - start);
      if (splitsPair(end)) end++;
      return {
        success: true,
        data: {
          path: input.path,
          totalChars: content.length,
          offsetChars: start,
          nextOffsetChars: end < content.length ? end : null,
          content: content.slice(start, end),
        },
      };
    }
    const lines = content.split('\n');

    // Apply offset/limit. An unlimited read of a large file would inject the
    // whole thing into the turn (a 2MB file ≈ 600k tokens → the request blows
    // past the model context and 400s), so an omitted limit falls back to a
    // default cap; the result reports total/from/to so the agent can page.
    const DEFAULT_READ_LINE_LIMIT = 2000;
    const startLine = (input.offset ?? 1) - 1; // Convert to 0-indexed
    const effectiveLimit = input.limit ?? DEFAULT_READ_LINE_LIMIT;
    const endLine = startLine + effectiveLimit;
    const slice = lines.slice(startLine, endLine);
    const truncated = endLine < lines.length;

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
        ...(truncated
          ? { note: `Truncated at ${effectiveLimit} lines (file has ${lines.length}). Use offset/limit to read more.` }
          : {}),
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
    const materializeError = await this.withMount(mount, async () => {
      await this.settleBeforeMutation(mount, relativePath);
      const blobHash = store.storeBlob(buffer, 'text/plain');
      return this.commitToolChange(mount, relativePath, { kind: 'set', blobHash, size: buffer.byteLength });
    });
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
    return this.withMount(mount, async (): Promise<ToolResult> => {
      const report = await this.ensureSynced(mount, relativePath);
      await this.settleBeforeMutation(mount, relativePath); // before the edit reads the entry

      const entry = store.treeGet(mount.treeStateId, relativePath);
      if (!entry) {
        return { success: false, error: this.notInWorkspace(input.path, report), isError: true };
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
      const materializeError = await this.commitToolChange(mount, relativePath, {
        kind: 'set',
        blobHash: newBlobHash,
        size: newBuffer.byteLength,
        mode: entry.mode,
      });
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
          size: newBuffer.byteLength,
        },
      };
    });
  }

  private async handleDelete(input: DeleteInput): Promise<ToolResult> {
    const { mount, relativePath } = this.parsePath(input.path);
    if (mount.config.mode === 'read-only') {
      return { success: false, error: `Mount "${mount.config.name}" is read-only`, isError: true };
    }

    const store = this.getStore();
    return this.withMount(mount, async (): Promise<ToolResult> => {
      const report = await this.ensureSynced(mount, relativePath);
      await this.settleBeforeMutation(mount, relativePath);
      const entry = store.treeGet(mount.treeStateId, relativePath);
      if (!entry) {
        return { success: false, error: this.notInWorkspace(input.path, report), isError: true };
      }

      const materializeError = await this.commitToolChange(mount, relativePath, { kind: 'remove', previousHash: entry.blobHash });
      if (materializeError) {
        return {
          success: false,
          error: `Removed from Chronicle but did not unlink "${input.path}" from disk: ${materializeError}. ` +
            'The disk copy stays (ls shows its state) until materialize with applyDeletions removes it.',
          isError: true,
        };
      }

      // Its whole receipt is what it changed: kept in the stub if the guard
      // withholds the result (agent-framework #277).
      return { success: true, data: { path: input.path, deleted: true }, keepWhenWithheld: ['path', 'deleted'] };
    });
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
    const recursive = input.recursive === true;

    // Every listing checks the paths it shows against disk first, under the
    // three-way rule, whatever the mount's watch mode.
    return this.withMount(mount, async (): Promise<ToolResult> => {
      const pass = await this.passUnlocked(mount, { kind: 'dir', dir: relativePath, recursive });
      const reports = [...pass.reports.values()].sort((a, b) => a.path.localeCompare(b.path));
      const incomplete = pass.incomplete.length > 0 ? { incomplete: pass.incomplete } : {};

      if (recursive) {
        return {
          success: true,
          data: {
            path: input.path,
            entries: reports.map((r) => ({ path: r.path, ...stateView(r) })),
            count: reports.length,
            ...incomplete,
          },
        };
      }

      // Non-recursive: the scope's files, and the directories beneath it that
      // disk or the workspace has.
      const prefix = relativePath ? relativePath + '/' : '';
      const dirNames = new Set(pass.dirs.map((d) => d.slice(prefix.length)));
      for (const entry of store.treeList(mount.treeStateId, prefix || undefined)) {
        const slash = entry.path.indexOf('/', prefix.length);
        if (slash >= 0) dirNames.add(entry.path.slice(prefix.length, slash));
      }
      const children: Array<Record<string, unknown>> = [
        ...[...dirNames].sort().map((name) => ({ name, type: 'directory' })),
        ...reports.map((r) => ({ name: r.path.slice(prefix.length), type: 'file', ...stateView(r) })),
      ];
      return {
        success: true,
        data: {
          path: input.path,
          entries: children,
          count: children.length,
          ...incomplete,
        },
      };
    });
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    const regex = globToRegex(input.pattern);
    const matches: Array<Record<string, unknown>> = [];
    const incomplete: Array<{ path: string; reason: string }> = [];

    // Search across mounts
    const mountsToSearch = input.path
      ? [this.parsePath(input.path)]
      : [...this.mounts.values()].map(m => ({ mount: m, relativePath: '' }));

    for (const { mount, relativePath } of mountsToSearch) {
      const pass = await this.withMount(mount, () =>
        this.passUnlocked(mount, { kind: 'dir', dir: relativePath, recursive: true }));
      for (const report of [...pass.reports.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        const testPath = relativePath ? report.path.slice(relativePath.length + 1) : report.path;
        if (regex.test(testPath)) {
          matches.push({ path: `${mount.config.name}/${report.path}`, ...stateView(report) });
        }
      }
      for (const region of pass.incomplete) {
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

    type GrepMatch = { line: number; text: string; context?: string[] };
    const results: Array<{ file: string; state: string; version: 'workspace' | 'conflicting-disk' | 'recorded-disk'; matches: GrepMatch[] }> = [];
    const skipped: Array<{ file: string; reason: string; size?: number; mimeType?: string }> = [];
    const incomplete: Array<{ path: string; reason: string }> = [];

    const search = (content: string): GrepMatch[] => {
      const lines = content.split('\n');
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
      return found;
    };

    for (const { mount, relativePath } of mountsToSearch) {
      await this.withMount(mount, async () => {
        // A `path` naming a single file greps just that file; otherwise it is a
        // directory prefix. (A file path once produced the prefix "notes.md/"
        // and silently matched nothing.)
        const fileScope = relativePath !== '' && (
          store.treeGet(mount.treeStateId, relativePath) !== null ||
          await lstat(join(mount.config.path, relativePath)).then((s) => !s.isDirectory(), () => false)
        );
        // What follows reads the tree and branch intent to go with the pass's
        // reports, synchronously. They must be the branch the pass decided
        // on: one selected in between would label its content with the other
        // branch's states. So a pass whose branch is no longer selected runs
        // again, and a branch that keeps changing leaves the scope unsearched.
        let pass: PassResult | null = null;
        for (let attempt = 0; attempt < 3 && pass === null; attempt++) {
          const next = await this.passUnlocked(mount, fileScope
            ? { kind: 'paths', paths: [relativePath] }
            : { kind: 'dir', dir: relativePath, recursive: true });
          if (next.branchId === undefined || next.branchId === store.currentBranch().id) pass = next;
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
        for (const report of [...pass.reports.values()].sort((a, b) => a.path.localeCompare(b.path))) {
          if (fileGlob && !fileGlob.test(report.path)) continue;
          const file = `${mount.config.name}/${report.path}`;
          if (report.state === 'disk-only') {
            skipped.push({
              file,
              reason: 'disk-only: binary or over the size limit, never stored',
              ...(report.size !== undefined ? { size: report.size } : {}),
              ...(report.mimeType ? { mimeType: report.mimeType } : {}),
            });
            continue;
          }
          // The workspace's version, labelled with the path's state.
          const entry = store.treeGet(mount.treeStateId, report.path);
          const blob = entry ? store.getBlob(entry.blobHash) : null;
          if (blob) {
            const found = search(blob.toString('utf-8'));
            if (found.length > 0) results.push({ file, state: report.state, version: 'workspace', matches: found });
          } else if (entry) {
            skipped.push({ file, reason: 'the workspace copy is missing from the store, so it was not searched' });
          }
          if (report.state !== 'conflict') continue;
          // A conflict's disk side. The version recorded with the conflict is
          // disk's only while disk still holds it; once disk has changed
          // since, it is labelled as recorded, and a file disk holds now
          // (never stored) is listed as not searched. A binary or oversize
          // disk version was never stored either.
          const disk = intents.get(report.path)?.conflict?.disk;
          const changed = report.conflict?.diskChangedSinceRecorded === true;
          const diskBlob = disk?.stored ? store.getBlob(disk.stored) : null;
          if (diskBlob) {
            const found = search(diskBlob.toString('utf-8'));
            if (found.length > 0) results.push({ file, state: report.state, version: changed ? 'recorded-disk' : 'conflicting-disk', matches: found });
          }
          if (disk?.stored && !diskBlob) {
            skipped.push({ file, reason: 'conflict: the disk version recorded with the conflict is missing from the store, so it was not searched' });
          }
          if (changed) {
            if (report.diskNow === 'file') {
              skipped.push({ file, reason: 'conflict: disk changed since the conflict was recorded; grep searches stored text, so the file disk holds now was not searched' });
            }
          } else if (disk && !disk.stored) {
            skipped.push({ file, reason: 'conflict: the disk version is binary or over the size limit, never stored', size: disk.size });
          }
        }
      });
    }

    return {
      success: true,
      data: {
        pattern: input.pattern,
        results,
        totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(incomplete.length > 0 ? { incomplete } : {}),
      },
    };
  }

  private async handleStatus(input: StatusInput): Promise<ToolResult> {
    const store = this.getStore();
    const status: Record<string, unknown> = {};
    if (input.mount !== undefined && !this.mounts.has(input.mount)) {
      return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
    }

    for (const [name, mount] of this.mounts) {
      if (input.mount !== undefined && name !== input.mount) continue;
      const entries = store.treeList(mount.treeStateId);
      const currentSeq = store.currentSequence();
      const intents = this.intents.get(name)!.list();
      const conflictPaths = intents.filter(([, bi]) => bi.conflict).map(([p]) => p);
      // A workspace deletion is pending until a push confirms it on disk:
      // left there without applyDeletions, or unlinked but unconfirmed.
      const deletionPaths = intents.filter(([, bi]) => bi.tombstone).map(([p]) => p);
      // Pending is what disk owes by the evidence: every entry it doesn't
      // show on disk (a refused or failed push stays owed), conflicts and
      // deletions. An entry from before the evidence isn't counted until a
      // listing or a materialize checks it: unchecked isn't unpushed.
      const pending = new Set([...conflictPaths, ...deletionPaths, ...this.entriesByEvidence(mount).owed]);

      const currentBranch = store.currentBranch();
      status[name] = {
        path: mount.config.path,
        mode: mount.config.mode,
        watch: mount.config.watch ?? 'always',
        fileCount: entries.length,
        lastMaterializedSeq: mount.lastMaterializedSeq,
        currentSeq,
        pendingChanges: pending.size,
        conflicts: conflictPaths.length,
        pendingWorkspaceDeletions: deletionPaths.length,
        initialSyncDone: mount.initialSyncDone,
        currentBranch: currentBranch.name,
        lastMaterializedBranch: mount.lastMaterializedBranchId,
        canMaterialize: this.mountMaterializeBlockReason(store, mount) === null,
        ...(mount.lastAgentActionScan ? { lastAgentActionScan: mount.lastAgentActionScan } : {}),
      };
    }

    return { success: true, data: status };
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
    const intents = new Map(this.intents.get(mount.config.name)!.list(explicitPath));
    const selected = new Set<string>();

    if (explicitPath !== '') {
      if (store.treeGet(mount.treeStateId, explicitPath)) selected.add(explicitPath);
      for (const e of store.treeList(mount.treeStateId, explicitPath + '/')) selected.add(e.path);
      for (const [p, bi] of intents) if (bi.tombstone || bi.conflict) selected.add(p);
      return { paths: [...selected], inPlace: false };
    }

    const { owed, unchecked, agreed } = this.entriesByEvidence(mount);
    for (const path of [...owed, ...unchecked]) selected.add(path);
    for (const [p, bi] of intents) if (bi.conflict || bi.tombstone) selected.add(p);
    return { paths: [...selected], inPlace: agreed > 0 };
  }

  /**
   * The workspace entries by what the evidence says of disk. `owed`: P
   * differs from the entry (a draft, or a push still pending), or there is no
   * P and the entry came from the workspace (a draft disk never had).
   * `unchecked`: no P and no workspace origin, an entry from before the
   * evidence; a push agrees it, writes it where disk lacks it, or refuses it
   * as a conflict. `agreed`: how many have P = S, so disk holds them. Status
   * counts the owed as pending; a materialize without a path takes up the
   * owed and the unchecked.
   */
  private entriesByEvidence(mount: MountState): { owed: string[]; unchecked: string[]; agreed: number } {
    const store = this.getStore();
    const agreement = this.agreementOrThrow();
    const name = mount.config.name;
    const intents = this.intents.get(name)!;
    const owed: string[] = [];
    const unchecked: string[] = [];
    let agreed = 0;
    for (const e of store.treeList(mount.treeStateId)) {
      const p = agreement.get(name, e.path);
      if (p === undefined) (intents.get(e.path)?.origin === 'store' ? owed : unchecked).push(e.path);
      else if (p.kind !== 'content' || p.hash !== e.blobHash) owed.push(e.path);
      else agreed++;
    }
    return { owed, unchecked, agreed };
  }

  private async handleMaterialize(input: MaterializeInput): Promise<ToolResult> {
    const store = this.getStore();

    const allWritten: Array<{ mount: string; path: string }> = [];
    const allDeleted: Array<{ mount: string; path: string }> = [];
    const pendingDeletions: Array<{ mount: string; path: string }> = [];

    let explicit: { mount: MountState; relativePath: string } | null = null;
    if (input.path) explicit = this.parsePath(input.path);

    let mountsToMaterialize: Array<{ name: string; mount: MountState }>;
    if (explicit) {
      mountsToMaterialize = [{ name: explicit.mount.config.name, mount: explicit.mount }];
    } else if (input.mount) {
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

    // Branch guard, scoped to the mounts actually being materialized: a
    // linear continuation (current branch descends from the pinned branch at
    // or after the pinned seq) passes; genuine divergence refuses unless
    // force. One mount's stale pin must never block another mount. It is
    // judged inside the mount's turn, on the same branch the selection is
    // made on: a materialize queued behind a pass would otherwise select on
    // whatever branch is current when its turn comes, unguarded. The push
    // then writes nothing if the branch changes after that.
    const blocked: Array<{ mount: string; reason: string }> = [];
    const guarded: string[] = [];
    let proceeded = 0;

    for (const { name, mount } of mountsToMaterialize) {
      if (mount.config.mode === 'read-only') {
        // Only a mount the caller named gets here read-only (a bare
        // materialize takes the read-write ones): say why nothing was written.
        blocked.push({ mount: name, reason: 'a read-only mount: materialize writes nothing to it' });
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
      for (const s of pushed.skipped) {
        blocked.push({ mount: name, reason: `${s.path}: ${s.reason}` });
      }

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
        error: `Cannot materialize: ${blocked.map((b) => `[${b.mount}] ${b.reason}`).join('; ')}`,
        isError: true,
      };
    }

    return {
      success: true,
      data: {
        materialized: allWritten,
        count: allWritten.length,
        ...(allDeleted.length > 0 ? { deleted: allDeleted } : {}),
        ...(pendingDeletions.length > 0
          ? {
            workspaceDeletionsLeftOnDisk: pendingDeletions,
            note: 'Files deleted in the workspace were left on disk; materialize with applyDeletions to remove them.',
          }
          : {}),
        ...(blocked.length > 0 ? { skipped: blocked } : {}),
      },
      // What disk lost, then what it was written: kept in the stub if the
      // guard withholds the result (agent-framework #277). What was left or
      // skipped, and why, is in the full result.
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
    if (!mount || mount.config.mode === 'read-only') return [];

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
      return { success: false, error: 'acceptRoot takes a whole mount\'s root: give mount, or nothing, not path', isError: true };
    }

    // A path names its own mount; otherwise the given mount, or every mount.
    let targets: Array<{ name: string; mount: MountState; relativePath: string }>;
    if (input.path) {
      const { mount, relativePath } = this.parsePath(input.path);
      targets = [{ name: mount.config.name, mount, relativePath }];
    } else if (input.mount) {
      const m = this.mounts.get(input.mount);
      if (!m) {
        return { success: false, error: `Unknown mount: ${input.mount}`, isError: true };
      }
      targets = [{ name: input.mount, mount: m, relativePath: '' }];
    } else {
      targets = [...this.mounts.entries()].map(([name, mount]) => ({ name, mount, relativePath: '' }));
    }

    for (const { name, mount, relativePath } of targets) {
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
          allSkipped.push({ mount: name, path: r.path, reason: `disk could not be checked: ${r.note ?? 'not observed'}` });
        } else if (r.state === 'disk-only') {
          allSkipped.push({ mount: name, path: r.path, reason: 'disk-only: binary or over the size limit, never stored' });
        }
      }
      for (const region of pass.incomplete) allIncomplete.push({ mount: name, ...region });
      for (const [reason, count] of pass.passedOver) allPassedOver.push({ mount: name, reason, count });
      // A path named explicitly is synced even where the mount's ignore list
      // covers it, and the result says so: a sync without a path passes
      // over it, so nothing else keeps it current (agent-framework #276).
      if (coveredByIgnore(relativePath, mount.config.ignore ?? [])) {
        allIgnored.push({
          mount: name,
          path: relativePath,
          note: 'this mount\'s ignore list covers it, so a sync without a path won\'t maintain it',
        });
      }
    }

    return {
      success: true,
      data: {
        results: allResults,
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
    if (recorded && sameRootIdentity(recorded, found.identity)) return false;
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
   */
  private async handleFsChanges(mountName: string, changes: FsChange[]): Promise<void> {
    const mount = this.mounts.get(mountName);
    if (!this.store || !this.running() || !mount) return;
    const paths = [...new Set(changes.map((c) => c.path))];
    if (paths.length === 0) return;
    await this.withMount(mount, () => this.passUnlocked(mount, { kind: 'paths', paths }));
  }

  /**
   * After an agent's completed tool batch, before anything continues its turn:
   * scan every `watch: 'on-agent-action'` mount, so what the batch's tools did
   * on disk (a shell command's files, a deletion) is in the workspace when the
   * agent next looks. On a mount over its walkCap, that holds for the first
   * walkCap entries in the walk's order, which every batch's scan takes; files
   * past them come in through syncs and the listings that reach them, while a
   * read takes in only a file the workspace doesn't hold yet. A scan that
   * outlasts the deadline stops holding the round: the miss is recorded on
   * the mount's status and pushed as a `workspace:agent-action-scan-incomplete`
   * event, and the scan continues, deciding on the branch selected when it
   * applies.
   */
  async onToolBatchComplete(_agentName?: string): Promise<void> {
    // Every agent's workspace is the store's current branch, so the agent
    // that ran the batch doesn't choose what is scanned.
    const mounts = [...this.mounts.values()].filter((m) => m.config.watch === 'on-agent-action');
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
      // From the mount's start, as a listing walks, keeping no place: on a
      // mount over its walkCap, every batch's scan takes the first walkCap
      // entries in the walk's order, and the place that syncs and catch-up
      // scans resume from stays theirs.
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
   * Push one ProcessEvent per op for a pass's tree changes and new conflicts.
   * A conflict rides the event for the disk change behind it (modified, or
   * deleted for a disk deletion of a file with newer workspace changes).
   */
  private emitFsEvents(
    mountName: string,
    ops: Array<{ path: string; op: TreeOp }>,
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
    for (const { path, op } of ops) add(op, path, false);
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
      if (closeIdx < 0) throw new Error(braceRefusal(pattern, 'has a "{" with no closing "}"'));
      const group = pattern.slice(i + 1, closeIdx);
      if (group.includes('{')) {
        throw new Error(braceRefusal(pattern, 'has a "{" group inside another; put all its alternatives in one group'));
      }
      if (!group.includes(',')) {
        throw new Error(braceRefusal(pattern, 'has a "{" group with no ","; a group needs two or more alternatives, separated by ","'));
      }
      const alternatives = group.split(',');
      regex += '(?:' + alternatives.map(a => globPartToRegex(a)).join('|') + ')';
      i = closeIdx + 1;
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

/** A glob's refusal of a brace form it can't read, with the way to match a literal "{". */
function braceRefusal(pattern: string, problem: string): string {
  return `glob pattern ${JSON.stringify(pattern)} ${problem}. To match a "{" in a name, put "?" in its place.`;
}

function globPartToRegex(part: string): string {
  return part
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
}
