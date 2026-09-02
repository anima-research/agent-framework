/**
 * Per-agent retention of tool-result images, with provenance (issue #104).
 *
 * History keeps a compact text placeholder for every image a tool returns —
 * the bytes only ever ride the live wire copy of that one turn. That policy
 * is right (megabytes of base64 in the persisted window would be sliced,
 * compressed, and replayed forever), but it left `save_recent_image` with no
 * way to reach an image the resident had just seen: the scanner walked past
 * the byteless placeholder and quietly saved whichever OLDER attachment came
 * next, under the filename the resident chose for the new one.
 *
 * This ledger is the missing half. At ingestion every tool-result image is
 * retained here under a stable per-agent ref (`img_7`) bound to the exact
 * tool call and block it came from, with its digest. The history placeholder
 * carries the ref, so the ordered inventory `save_recent_image` walks can
 * include tool images at their true position — and when the bytes behind a
 * ref are gone (bounded eviction, or a restart: the ledger is in-memory by
 * design, so it never adds to blob growth), the save fails AT THAT INDEX with
 * a specific error instead of sliding to an older image. Silent substitution
 * of bytes from another surface is the failure this exists to end.
 */

import { createHash } from 'node:crypto';

export interface RetainedToolImage {
  /** Stable per-agent handle, minted once per (toolCallId, blockIndex). */
  ref: string;
  toolCallId: string;
  toolName: string;
  /** Position of the image block inside the tool result's content array. */
  blockIndex: number;
  mediaType: string;
  byteSize: number;
  sha256: string;
  retainedAt: number;
}

/** A retained image whose bytes are still held. */
export interface RetainedToolImageWithData extends RetainedToolImage {
  /** Base64 payload, exactly as the tool returned it. */
  data: string;
}

export type ToolImageLookup =
  | { status: 'retained'; image: RetainedToolImageWithData }
  /** The ref was issued by this ledger but its bytes were evicted (bounded budget). */
  | { status: 'evicted'; image: RetainedToolImage }
  /** Never issued by this ledger — a typo, or a ref minted before a restart. */
  | { status: 'unknown' };

export interface ToolImageLedgerOptions {
  /** Total base64 chars held across retained images (≈ bytes × 4/3). */
  maxChars?: number;
  /** Maximum number of images whose bytes are held. */
  maxEntries?: number;
}

/** 96 MB of base64 ≈ 72 MB of image bytes — a few dozen world snapshots. */
export const DEFAULT_TOOL_IMAGE_LEDGER_MAX_CHARS = 96 * 1024 * 1024;
export const DEFAULT_TOOL_IMAGE_LEDGER_MAX_ENTRIES = 64;

export class ToolImageLedger {
  private nextSeq = 1;
  /** Insertion-ordered (oldest first) — eviction pops from the front. */
  private readonly retained = new Map<string, RetainedToolImageWithData>();
  /** Provenance for every ref ever issued, bytes or not (bounded separately). */
  private readonly issued = new Map<string, RetainedToolImage>();
  private readonly refByKey = new Map<string, string>();
  private heldChars = 0;
  private readonly maxChars: number;
  private readonly maxEntries: number;

  constructor(options: ToolImageLedgerOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_TOOL_IMAGE_LEDGER_MAX_CHARS;
    this.maxEntries = options.maxEntries ?? DEFAULT_TOOL_IMAGE_LEDGER_MAX_ENTRIES;
  }

  /**
   * Retain one image block from a tool result. Idempotent per
   * (toolCallId, blockIndex): the same block always yields the same ref, so
   * a result serialized twice (or retained early, then serialized) agrees
   * with itself.
   */
  retain(source: {
    toolCallId: string;
    toolName: string;
    blockIndex: number;
    data: string;
    mediaType: string;
  }): RetainedToolImage {
    const key = `${source.toolCallId}:${source.blockIndex}`;
    const existingRef = this.refByKey.get(key);
    if (existingRef !== undefined) {
      const known = this.issued.get(existingRef);
      if (known) return known;
    }
    const ref = `img_${this.nextSeq++}`;
    const bytes = Buffer.from(source.data, 'base64');
    const image: RetainedToolImageWithData = {
      ref,
      toolCallId: source.toolCallId,
      toolName: source.toolName,
      blockIndex: source.blockIndex,
      // Tools send mime types unvalidated; the placeholder grammar is
      // lowercase, so normalize here and at format time (same rule) or an
      // `Image/PNG` would write a placeholder that never re-parses — an
      // invisible slot, i.e. a silent index slide.
      mediaType: normalizeMediaType(source.mediaType),
      byteSize: bytes.byteLength,
      sha256: sha256Hex(bytes),
      retainedAt: Date.now(),
      data: source.data,
    };
    const { data: _data, ...provenance } = image;
    this.refByKey.set(key, ref);
    this.issued.set(ref, provenance);
    // A single image over the whole budget is issued (so the placeholder is
    // honest about its provenance) but never held.
    if (source.data.length <= this.maxChars) {
      this.retained.set(ref, image);
      this.heldChars += source.data.length;
      this.evictOverBudget();
    }
    this.trimProvenance();
    return provenance;
  }

  lookup(ref: string): ToolImageLookup {
    const held = this.retained.get(ref);
    if (held) return { status: 'retained', image: held };
    const known = this.issued.get(ref);
    if (known) return { status: 'evicted', image: known };
    return { status: 'unknown' };
  }

  /** Ref already minted for this block, if any (no retention side effect). */
  refFor(toolCallId: string, blockIndex: number): string | undefined {
    return this.refByKey.get(`${toolCallId}:${blockIndex}`);
  }

  /** Count of images whose bytes are currently held. */
  get size(): number {
    return this.retained.size;
  }

  private evictOverBudget(): void {
    for (const [ref, image] of this.retained) {
      if (this.retained.size <= this.maxEntries && this.heldChars <= this.maxChars) break;
      this.retained.delete(ref);
      this.heldChars -= image.data.length;
    }
  }

  /** Provenance for evicted refs is kept for a while so the error can name
   *  the tool call; bounded so a long-lived agent can't grow it forever. */
  private trimProvenance(): void {
    const keep = Math.max(this.maxEntries * 4, 256);
    while (this.issued.size > keep) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      const image = this.issued.get(oldest);
      this.issued.delete(oldest);
      if (image) this.refByKey.delete(`${image.toolCallId}:${image.blockIndex}`);
    }
  }
}

/** Lowercase, trimmed — the one spelling the placeholder grammar accepts. */
export function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase();
}

/** History placeholder for a retained tool image: `[image: image/png, ~691KB, ref img_7]`. */
export function formatToolImagePlaceholder(mediaType: string, sizeLabel: string, ref: string | null): string {
  const mime = normalizeMediaType(mediaType);
  return ref === null
    ? `[image: ${mime}, ${sizeLabel}]`
    : `[image: ${mime}, ${sizeLabel}, ref ${ref}]`;
}

export type ParsedImagePlaceholder =
  /** An inline tool image the serializer replaced with a placeholder. */
  | {
    kind: 'inline';
    mediaType: string;
    sizeLabel: string;
    /** null for placeholders written before retention existed (unsaveable). */
    ref: string | null;
    /** Character offset in the scanned text — for ordering within a block. */
    offset: number;
  }
  /** An RFC-005 reference stub whose testimony says image — bytes live
   *  behind fetch_reference, never in this ledger. Occupies a slot so the
   *  index cannot slide past it. */
  | {
    kind: 'reference';
    refId: string;
    /** Mime sniffed from the stub text; null when the stub names none. */
    mediaType: string | null;
    offset: number;
  };

const PLACEHOLDER_RE = /\[image: ([a-z]+\/[a-z0-9.+-]+), (~?[\d.]+(?:B|KB|MB))(?:, ref (img_\d+))?\]/g;
/** `[ref_1_ab3d] cam.png — image/png, 1.2MB claimed — from tool result — …` (one line). */
const REFERENCE_STUB_RE = /^\[(ref_[0-9a-z]+_[0-9a-z]+)\] ([^\n]*)$/gm;
const IMAGE_MIME_RE = /\bimage\/[a-z0-9.+-]+/i;

/**
 * Every image slot in a stored tool-result string, in text order: inline
 * placeholders and image-typed reference stubs. Text-derived and therefore
 * untrusted — a tool result can quote someone else's placeholder verbatim —
 * so the caller MUST cross-check a resolved ref's provenance against the
 * tool_result block it was found in before handing out bytes.
 */
export function parseImagePlaceholders(text: string): ParsedImagePlaceholder[] {
  const out: ParsedImagePlaceholder[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    out.push({ kind: 'inline', mediaType: m[1]!, sizeLabel: m[2]!, ref: m[3] ?? null, offset: m.index ?? 0 });
  }
  for (const m of text.matchAll(REFERENCE_STUB_RE)) {
    const mime = m[2]!.match(IMAGE_MIME_RE);
    out.push({ kind: 'reference', refId: m[1]!, mediaType: mime ? mime[0].toLowerCase() : null, offset: m.index ?? 0 });
  }
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
