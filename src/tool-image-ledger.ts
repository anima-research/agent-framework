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
 * retained here under a stable per-agent ref (`img_k7x3q2_7`) bound to the
 * exact tool call and block it came from, with its digest. The ref carries a
 * per-ledger nonce: ledgers live and die with the process, but the persisted
 * store keeps yesterday's placeholders visible in context, so a bare sequence
 * number would let a stale `img_7` resolve to whatever this process minted
 * seventh. A stale ref must resolve `unknown`, never to other bytes.
 *
 * The history placeholder carries the ref, so the ordered inventory
 * `save_recent_image` walks can
 * include tool images at their true position — and when the bytes behind a
 * ref are gone (bounded eviction, or a restart: the ledger is in-memory by
 * design, so it never adds to blob growth), the save fails AT THAT INDEX with
 * a specific error instead of sliding to an older image. Silent substitution
 * of bytes from another surface is the failure this exists to end.
 */

import { createHash, randomBytes } from 'node:crypto';
import { REFERENCE_STUB_MAX_CHARS, referenceTypeLabel } from './mcpl/references.js';
import { safeSlice } from './safe-slice.js';

export interface RetainedToolImage {
  /** Stable per-ledger handle (`img_<nonce>_<seq>`), minted once per (toolCallId, blockIndex). */
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
  /** Namespace for every ref this ledger mints; a fresh ledger (new process,
   *  agent re-registration) never shares one with its predecessors. */
  readonly nonce: string = mintLedgerNonce();
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
   * (toolCallId, blockIndex) for as long as that block's provenance record
   * is held (bounded — see trimProvenance): within that window the same
   * block always yields the same ref, so a result serialized twice (or
   * retained early in a tool batch, then serialized at commit) agrees with
   * itself. A block re-serialized after its record aged out mints a fresh
   * ref; the old one resolves `evicted`/`unknown`, never to other bytes.
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
    const ref = `img_${this.nonce}_${this.nextSeq++}`;
    // Digest without materializing the whole decoded image: a 96MB base64
    // field would otherwise transiently allocate ~72MB more and the ledger
    // would be the one asking for it. Chunked decode keeps the peak small.
    const { byteSize, sha256 } = digestBase64(source.data);
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
      byteSize,
      sha256,
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

/** Six random base36 chars — one per ledger lifetime, embedded in every ref. */
function mintLedgerNonce(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(-6);
}

/** Grammar of a ref this module mints: `img_<ledger nonce>_<sequence>`. */
export const TOOL_IMAGE_REF_RE = /^img_[0-9a-z]+_\d+$/;

/** RFC 6838 type/subtype token characters (lowercased), each name at most
 *  127 characters (its section 4.2); no parameters. */
const MEDIA_TYPE_ESSENCE_RE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
export const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/**
 * The one spelling the placeholder grammar accepts: trimmed, lowercased, the
 * `type/subtype` essence only (parameters such as `; charset=binary` are
 * dropped), and — because `mimeType` arrives from external MCPL servers
 * unvalidated — anything that still is not a well-formed type/subtype falls
 * back to `application/octet-stream`. The invariant this buys: the
 * serializer can NEVER write a placeholder that does not re-parse, so a
 * strange mime can never produce an invisible slot (a silent index slide).
 */
export function normalizeMediaType(mediaType: string): string {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return MEDIA_TYPE_ESSENCE_RE.test(essence) ? essence : FALLBACK_MEDIA_TYPE;
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
    /** The placeholder exactly as it appears in the text. */
    text: string;
  }
  /** An RFC-005 reference stub whose text shows an image type — bytes live
   *  behind fetch_reference, never in this ledger. Occupies a slot so the
   *  index cannot slide past it. */
  | {
    kind: 'reference';
    refId: string;
    /** The image type the stub shows, as a stub shows a type (sanitized and
     *  bounded), lowercased: the first `image/` token in its text, which can
     *  come from its name. */
    mediaType: string;
    offset: number;
    /** The stub line exactly as it appears in the text. */
    text: string;
  };

/**
 * `[image: image/png, ~691KB, ref img_k7x3q2_7]`. Each part is bounded by
 * what formatToolImagePlaceholder writes, so text shaped like a placeholder
 * but longer is no slot: a type and a subtype name at RFC 6838's 127
 * characters each (normalizeMediaType writes none longer), and a size's
 * number, a ledger nonce and a sequence at 16 characters each, a safe
 * integer's digits.
 */
const PLACEHOLDER_RE = /\[image: ([a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}), (~?[\d.]{1,16}(?:B|KB|MB))(?:, ref (img_[0-9a-z]{1,16}_\d{1,16}))?\]/g;
/** `[ref_1_ab3d] cam.png — image/png, 1.2MB claimed — from tool result — …`
 *  (one line, at most REFERENCE_STUB_MAX_CHARS long: see parseImagePlaceholders). */
const REFERENCE_STUB_RE = /^\[(ref_[0-9a-z]+_[0-9a-z]+)\] ([^\n]*)$/gm;
const IMAGE_MIME_RE = /\bimage\/[a-z0-9!#$&^_.+-]+/i;

/**
 * Every image slot in a stored tool-result string, in text order: inline
 * placeholders and image-typed reference stubs. Text-derived and therefore
 * untrusted — a tool result can quote someone else's placeholder verbatim —
 * so the caller MUST cross-check a resolved ref's provenance against the
 * tool_result block it was found in before handing out bytes.
 *
 * Decided from the text alone, so a stored result counts the same however
 * long ago it was written, across restarts and registry evictions. A
 * reference stub is a slot when its text shows an image type, and a
 * non-image reference is no slot. A line shaped like a stub but longer than
 * buildReferenceStub writes (REFERENCE_STUB_MAX_CHARS) is quoted text and no
 * slot either, so a slot's text is bounded wherever it is kept.
 */
export function parseImagePlaceholders(text: string): ParsedImagePlaceholder[] {
  const out: ParsedImagePlaceholder[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    out.push({ kind: 'inline', mediaType: m[1]!, sizeLabel: m[2]!, ref: m[3] ?? null, offset: m.index ?? 0, text: m[0] });
  }
  for (const m of text.matchAll(REFERENCE_STUB_RE)) {
    if (m[0].length > REFERENCE_STUB_MAX_CHARS) continue;
    const shown = m[2]!.match(IMAGE_MIME_RE);
    if (!shown) continue;
    out.push({ kind: 'reference', refId: m[1]!, mediaType: referenceTypeLabel(shown[0]).toLowerCase(), offset: m.index ?? 0, text: m[0] });
  }
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

/**
 * The most image slots a stored copy keeps past its cut: a bound on what it
 * carries there, set at the ledger's entry limit, the most images it holds
 * bytes for. Serializing a result retains its images in order before their
 * placeholders are written, and every agent's ledger is built with the
 * defaults, so once a result is stored a save can reach bytes for at most
 * its newest DEFAULT_TOOL_IMAGE_LEDGER_MAX_ENTRIES images, fewer when the
 * ledger's limit on held characters binds first, and an inline image older
 * than those can only fail. Image stubs and quoted placeholders count toward
 * the bound too, so where they follow a result's images past the cut, the
 * newest slots kept can leave out an image whose bytes the ledger still
 * holds.
 */
export const MAX_KEPT_IMAGE_SLOTS = DEFAULT_TOOL_IMAGE_LEDGER_MAX_ENTRIES;

/** The ranges `[start, end)` of a tool result's text that its live copy
 *  showed beside its images: each text block up to where the live copy cut it
 *  at the inline cap (toolResultCutAt), and every other block whole. They
 *  come in text order and never overlap, as the blocks do, and
 *  cutStoredToolResult relies on that. */
export type ShownRanges = ReadonlyArray<readonly [number, number]>;

/** A tool result's stored copy, cut at its inline cap. */
export interface StoredCut {
  /** The text before the cut. */
  head: string;
  /** The image slots past the cut that the stored copy re-appends after its
   *  truncation notice, in text order: the newest MAX_KEPT_IMAGE_SLOTS of
   *  those the live copy showed, or under a readers' bound the newest of
   *  those that fit it, down to none (cutStoredToolResultToFit). */
  kept: string[];
  /** How many image slots past the cut the live copy showed. */
  fell: number;
}

/**
 * Where a tool result's text longer than `cap` is cut: by its stored copy
 * (cutStoredToolResult), by history's own truncation (truncateForHistory),
 * and by its live copy, for each text block beside an image
 * (tryNativeToolResultContent, framework.ts), so at one cap the stored copy
 * and the live copy cut alike. Under a readers' bound the stored copy's cut
 * can come earlier (cutStoredToolResultToFit). The text's length when it
 * isn't longer than `cap`.
 *
 * The cut is made at the cap, or before it when the cap would split a
 * surrogate pair (safeSlice's rule), and that is where the moves back are
 * measured from. It moves back to the start of a placeholder it would split,
 * and then to the start of a stub-shaped line it would split when at most
 * REFERENCE_STUB_MAX_CHARS of the line lie before it, since that part could
 * still read as a slot. So no slot straddles the cut, and the text before it
 * never ends in part of one. A longer part, which can't parse as a slot,
 * stays before the cut. Each move back lands on a `[`, so it splits no pair.
 */
export function toolResultCutAt(text: string, cap: number): number {
  if (text.length <= cap) return text.length;
  let cutAt = safeSlice(text, 0, cap).length;
  // Neither grammar crosses a newline, so only the line holding the cut can
  // be split; it is read whole, as the parser reads it.
  const lineStart = text.lastIndexOf('\n', cutAt - 1) + 1;
  const newline = text.indexOf('\n', cutAt);
  const line = text.slice(lineStart, newline === -1 ? text.length : newline);
  for (const m of line.matchAll(PLACEHOLDER_RE)) {
    const start = lineStart + (m.index ?? 0);
    if (start < cutAt && start + m[0].length > cutAt) cutAt = start;
  }
  for (const m of line.matchAll(REFERENCE_STUB_RE)) {
    const start = lineStart + (m.index ?? 0);
    if (start < cutAt && start + m[0].length > cutAt && cutAt - start <= REFERENCE_STUB_MAX_CHARS) cutAt = start;
  }
  return cutAt;
}

/**
 * Cut a tool result's text at its inline `cap` as its stored copy keeps it
 * (toolResultCutAt): the stored copy keeps what the live copy showed. A text
 * within the cap is all head, with nothing kept after it.
 *
 * `shown` is what the live copy showed beside the stored text: null when the
 * live copy was the text itself, as for every result that carried no inline
 * image. Then what the cut keeps is exactly what the resident saw, and
 * nothing past it is kept (#403). A result that carried an inline image went
 * to the model as native blocks (tryNativeToolResultContent, framework.ts),
 * every image whatever the text's length, so its stored text is the only
 * place save_recent_image's inventory finds them, and a slot dropped by the
 * cut would be an image the resident saw that the index slides past (#104).
 * The image slots past the cut that lie wholly within what the live copy
 * showed are kept, the newest MAX_KEPT_IMAGE_SLOTS of them, since the
 * inventory counts from the end.
 */
export function cutStoredToolResult(text: string, cap: number, shown: ShownRanges | null): StoredCut {
  const cutAt = toolResultCutAt(text, cap);
  const head = text.slice(0, cutAt);
  if (shown === null) return { head, kept: [], fell: 0 };
  // The slots and the ranges both come in text order, so one pass walks
  // them together: a range that ends where a slot starts, or before, holds
  // no later slot either.
  const past: ParsedImagePlaceholder[] = [];
  let r = 0;
  for (const slot of parseImagePlaceholders(text)) {
    if (slot.offset < cutAt) continue;
    while (r < shown.length && shown[r]![1] <= slot.offset) r++;
    const range = shown[r];
    if (range && slot.offset >= range[0] && slot.offset + slot.text.length <= range[1]) past.push(slot);
  }
  return { head, kept: past.slice(-MAX_KEPT_IMAGE_SLOTS).map((slot) => slot.text), fell: past.length };
}

/** What a stored copy re-appends after its truncation notice: the kept
 *  slots, each on its own line so a reference stub stays parseable, under a
 *  note saying how many fell past the cut, and how many of those were left
 *  out and aren't counted, all of them where none fit the bound
 *  (cutStoredToolResultToFit). Empty when none fell past the cut. */
export function formatKeptImageSlots(cut: StoredCut): string {
  if (cut.fell === 0) return '';
  if (cut.kept.length === 0) {
    return `\n[${cut.fell} image slot(s) fell past the cut and are left out, and save_recent_image doesn't count them.]`;
  }
  const leftOut = cut.fell - cut.kept.length;
  const note = leftOut === 0
    ? `${cut.fell} image slot(s) fell past the cut; kept here in order so save_recent_image still counts them:`
    : `${cut.fell} image slot(s) fell past the cut. The last ${cut.kept.length} are kept here in order so `
      + `save_recent_image still counts them; the ${leftOut} before them are left out, and it doesn't count them:`;
  return `\n[${note}]\n${cut.kept.join('\n')}`;
}

/** The most a stored copy's truncation notice takes (spillOrTruncate,
 *  framework.ts): the spill notice names its file twice, once in its paging
 *  advice, and fits this on a path from a mount name of up to about seventy
 *  characters. */
export const TOOL_RESULT_NOTICE_ROOM = 640;

/**
 * A result's cap and bound when its message holds `n` results. A reader's
 * strategy spends its per-message bound across the message's blocks in
 * order, so each result takes an equal share of the readers' smallest
 * bound, fixed before any result is cut, since its siblings may still be
 * running when save_recent_image counts it, and its cap is at most that
 * share. `keptCap` is where a withheld stub's kept fields are cut, leaving
 * the stub's notice its room (tool-result-guard.ts). With no bound, each
 * keeps the cap.
 *
 * Each result is then stored within its share, or at its least where its
 * notice is longer than the share: whole where it's no longer than the
 * notice (cutStoredToolResultToFit), otherwise its notice alone. So a reader's
 * cut reaches a notice only when the turn, each result at its least, passes
 * the bound. One edge: notices differ in length (by a few characters for
 * the content's digits, more where call ids differ in length), and where a
 * share falls between two of them, a result between its own notice and the
 * share stays whole above its least, by up to that difference.
 * A turn that then passes the bound by those characters loses the end of
 * its last notice to the reader's cut, under context-manager's mark (whose
 * token count is the notice's, not the result's); the notice's path and read
 * call come before that end.
 */
export function toolResultShare(cap: number, bound: number | undefined, n: number): { cap: number; bound: number | undefined; keptCap: number } {
  if (bound === undefined) return { cap, bound, keptCap: cap };
  const share = Math.floor(bound / Math.max(1, n));
  return { cap: Math.min(cap, share), bound: share, keptCap: Math.min(cap, Math.max(1, share - TOOL_RESULT_NOTICE_ROOM)) };
}

/**
 * Cut a tool result's text at `cap` as cutStoredToolResult does, unless its
 * stored copy would then pass `bound`, the most a reader's strategy keeps of
 * it (toolResultShare): the head, room for the notice after it, and the kept
 * slots after that (formatKeptImageSlots). A strategy cuts a longer message
 * from its end, and with it the notice that holds the way to the rest, so
 * there the head moves back until the copy fits. The kept slots grow as the
 * head moves back, so the cut is found again until head and slots fit or the
 * head is empty. Slots that alone pass the room keep the newest that fit,
 * the rest left out and uncounted, as past MAX_KEPT_IMAGE_SLOTS. A bound
 * under the notice's room can't hold the notice. With no bound, or where the
 * cut at the cap already fits, the cut is cutStoredToolResult's.
 *
 * `notice`, given where `bound` is a text's share of one turn's bound, is the
 * length of the notice a cut that keeps no head would carry
 * (spillNoticeLength). A text no longer than what that cut would store in
 * its place, the notice and, where it keeps no slot, the note on the slots it
 * leaves out, is kept whole: a cut would only lengthen it. Only a cut that
 * keeps no head can meet that, since one that keeps a head is cut past the
 * notice's room. A cut that keeps slots is measured by its notice alone, as
 * the slots it keeps are the text's own.
 */
export function cutStoredToolResultToFit(text: string, cap: number, shown: ShownRanges | null, bound: number | undefined, notice?: number): StoredCut {
  let cut = cutStoredToolResult(text, cap, shown);
  if (bound === undefined || text.length <= cap) return cut;
  const room = bound - TOOL_RESULT_NOTICE_ROOM;
  while (cut.head.length > 0 && cut.head.length + formatKeptImageSlots(cut).length > room) {
    cut = cutStoredToolResult(text, Math.max(0, room - formatKeptImageSlots(cut).length), shown);
  }
  while (cut.kept.length > 0 && formatKeptImageSlots(cut).length > room) cut = { ...cut, kept: cut.kept.slice(1) };
  if (notice !== undefined && cut.head.length === 0
    && text.length <= notice + (cut.kept.length === 0 ? formatKeptImageSlots(cut).length : 0)) {
    return { head: text, kept: [], fell: 0 };
  }
  return cut;
}

/**
 * The image slots a tool result's stored copy holds: its text's, or, when the
 * text is longer than `cap`, those the cut keeps, in head and after the
 * notice (cutStoredToolResultToFit, under the readers' `bound`). The notice
 * itself holds none. For counting a result before its stored copy is
 * written, as it will count after, so `notice` is the one spillOrTruncate
 * gives the cut (spillNoticeLength).
 */
export function storedImageSlots(text: string, cap: number, shown: ShownRanges | null, bound: number | undefined, notice?: number): ParsedImagePlaceholder[] {
  const cut = cutStoredToolResultToFit(text, cap, shown, bound, notice);
  return parseImagePlaceholders(cut.head + formatKeptImageSlots(cut));
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Only the base64 alphabet, with nothing but trailing `=` padding after it. */
function isCleanBase64(data: string): boolean {
  const m = /[^A-Za-z0-9+/]/.exec(data);
  if (!m) return true;
  const rest = data.length - m.index;
  return rest <= 2 && /^=+$/.test(data.slice(m.index));
}

/**
 * Byte length and SHA-256 of a base64 payload, decoded in 4-char-aligned
 * chunks so the peak allocation stays at one chunk rather than the whole
 * image. Falls back to a whole decode when the string carries whitespace
 * or embedded padding (chunk alignment would no longer be trustworthy) —
 * the digest must describe exactly the bytes a later whole decode writes.
 */
function digestBase64(data: string): { byteSize: number; sha256: string } {
  if (!isCleanBase64(data)) {
    const bytes = Buffer.from(data, 'base64');
    return { byteSize: bytes.byteLength, sha256: sha256Hex(bytes) };
  }
  const CHUNK = 1 << 20; // multiple of 4
  const hash = createHash('sha256');
  let byteSize = 0;
  for (let i = 0; i < data.length; i += CHUNK) {
    const bytes = Buffer.from(data.slice(i, i + CHUNK), 'base64');
    hash.update(bytes);
    byteSize += bytes.byteLength;
  }
  return { byteSize, sha256: hash.digest('hex') };
}
