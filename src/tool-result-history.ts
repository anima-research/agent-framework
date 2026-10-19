/**
 * Convert an AF `ToolResult.data` value into the string form that lives in
 * the agent's conversation history.
 *
 * The live path (`toMembraneToolResult` in framework.ts) preserves MCP image
 * blocks natively so the model sees the bytes on the current turn. The
 * *persisted* copy needs to survive recompilation, compression, and
 * `/restore` — storing megabytes of base64 there gets corrupted on the next
 * `maxChars` slice and re-introduces, one turn deferred, exactly the silent
 * hallucination this feature exists to kill.
 *
 * A content array (toolResultBlocks) is shown block by block, each block as
 * both copies show it: text verbatim, an image as a short
 * `[image: mimeType, ~NKB]` placeholder, a reference as its stub, and any
 * other block as a marker saying what it was and why it isn't shown. Anything
 * else falls back to JSON, written by RFC-005's rules at every depth
 * (historyJson): a reference is shown as its stub wherever it sits in the
 * data, so its uri reaches history only as a link's line shows it where the
 * host can't fetch the link and its uri can't carry a credential
 * (shownLinkUri), and inline data that claims a uri or a disposition is
 * withheld.
 */

import {
  AUDIO_NO_DATA_TEXT,
  AUDIO_NO_MEDIA_TYPE_TEXT,
  IMAGE_NO_DATA_TEXT,
  IMAGE_NO_MEDIA_TYPE_TEXT,
  INLINE_WITHHELD_TEXT,
  buildReferenceStub,
  classifyBlock,
  contentClaims,
  referenceStubOrNull,
  referenceTypeLabel,
  resultClaims,
  type ReferenceTestimony,
  type ResultClaims,
} from './mcpl/references.js';
import { formatToolImagePlaceholder, toolResultCutAt } from './tool-image-ledger.js';

/** Where one block of a content array sits in its history text, and what
 *  kind of block it was: text, an inline image (its placeholder), an RFC-005
 *  reference (its stub), inline data withheld for a contradiction, or a
 *  marker in place of a block the lane can't show. */
export interface HistoryBlockSpan {
  kind: ToolResultBlock['kind'];
  start: number;
  end: number;
}

/**
 * Whether a tool result's live copy goes as native blocks, an image among
 * them, rather than as its stored text. It does when the result holds an
 * image and its links' blocks and markers come to no more than `maxChars`
 * together. Past that, the live copy is the stored text, cut at the cap, so
 * no number of links and markers carries a result past it. A reference's
 * stub and a withheld line go whole beside an image whatever their length,
 * and past its cut the stored copy keeps the newest 64 image slots the live
 * copy showed (#403). Text blocks don't count either: the native copy cuts
 * each at the cap on its own. Both copies decide by this, from each block's
 * kind and the length of its text.
 */
export function goesNative(
  blocks: ReadonlyArray<{ kind: ToolResultBlock['kind']; length: number }>,
  maxChars: number | undefined,
): boolean {
  if (!blocks.some((block) => block.kind === 'image')) return false;
  if (!maxChars) return true;
  let bounded = 0;
  for (const block of blocks) if (block.kind === 'link' || block.kind === 'marker') bounded += block.length;
  return bounded <= maxChars;
}

/**
 * One block of a tool result's content array as both of its copies show it
 * (toolResultBlocks): a text block's text, an inline image, which the stored
 * copy shows as its placeholder and the live copy as itself, or the text that
 * stands in its place, the same in both. That text is a reference's stub, a
 * link's stub or line (MCP's resource_link, `link`), inline data withheld for
 * a contradiction, or a marker saying what kind of block it was and why the
 * lane can't show it.
 */
export type ToolResultBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mimeType: string }
  | { kind: 'reference' | 'link' | 'withheld' | 'marker'; text: string };

/** The block types MCP defines for a tool result's content. */
const MCP_BLOCK_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);

/**
 * Each element of `data` as both copies of a tool result show it, or null
 * when `data` isn't a content array, so the result is data, written as JSON.
 * An array is content when the result says so (`dataIsContent`, which the
 * framework sets on an MCPL tool's result: every element of a protocol
 * result's content is a block, of a type the host shows or not). Otherwise
 * it's content only when every element is a block of one of MCP's own types,
 * so a list of records of other types stays data. A module's array of
 * records that all carry MCP's type names, such as `[{ type: 'image', url }]`,
 * is read as content, and shows a marker for each record that isn't a block
 * the lane can show.
 */
export function toolResultBlocks(data: unknown, dataIsContent?: boolean, claims?: ResultClaims): ToolResultBlock[] | null {
  if (!isContentArray(data, dataIsContent)) return null;
  // The result's claims, read as one (ResultClaims): what any of its
  // references says of a uri (a `disposition: never`, an expiry) holds for
  // each block that names it, whatever their order.
  const read = claims ?? contentClaims(data);
  return data.map((raw) => toolResultBlock(raw, read));
}

/** Whether a tool result's data is a content array, which toolResultBlocks
 *  shows block by block. */
function isContentArray(data: unknown, dataIsContent?: boolean): data is unknown[] {
  return Array.isArray(data)
    && (dataIsContent === true || data.every((element) => isPlainRecord(element) && MCP_BLOCK_TYPES.has(element.type as string)));
}

/**
 * The claims of a tool result's data (ResultClaims), as showing it reads
 * them: a content array's from its elements (contentClaims), and any other
 * data's by the walk serialization takes (claimsInHistory). For a decision
 * made about the result outside showing it, such as which of its references
 * to fetch, or for showing part of it as the rest of it claims. Null where a
 * value stops the walk, so what the data claims is unknown (claimsInHistory).
 */
export function resultClaimsOf(data: unknown, dataIsContent?: boolean): ResultClaims | null {
  return isContentArray(data, dataIsContent) ? contentClaims(data) : claimsInHistory(data);
}

/** One element of a content array, as toolResultBlocks gives it. Only an
 *  image with data and a media type is shown as itself, as the push lane's
 *  converter shows one, and only text and images can be: this host's tool
 *  results carry nothing else, so inline audio is a marker here. */
function toolResultBlock(raw: unknown, claims: ResultClaims): ToolResultBlock {
  const c = classifyBlock(raw);
  switch (c.kind) {
    case 'text':
      return { kind: 'text', text: (raw as { text: string }).text };
    case 'reference':
      // A bounded stub, never the block's JSON, which would show its uri. A
      // stub that shows an image type occupies a slot in save_recent_image's
      // inventory (a failing one: its bytes are behind fetch_reference), so
      // the index never slides past an image the resident saw. A link the
      // host can't fetch, shown by its uri, is no slot, as no link was before
      // links were references, when the result's JSON showed it. A link's
      // block, stub or line, is `link`, counted toward the cap (goesNative).
      return {
        kind: c.testimony.fromLink ? 'link' : 'reference',
        text: buildReferenceStub(c.testimony, 'from tool result', undefined, { unfetchedLinkUri: true, claims }),
      };
    case 'invalid':
      return { kind: 'marker', text: c.shown };
    case 'inline': {
      if (c.contradiction) return { kind: 'withheld', text: INLINE_WITHHELD_TEXT };
      const b = raw as { type: 'image' | 'audio'; data: string; mimeType?: unknown };
      const image = b.type === 'image';
      if (b.data === '') return { kind: 'marker', text: image ? IMAGE_NO_DATA_TEXT : AUDIO_NO_DATA_TEXT };
      if (typeof b.mimeType !== 'string' || b.mimeType === '') {
        return { kind: 'marker', text: image ? IMAGE_NO_MEDIA_TYPE_TEXT : AUDIO_NO_MEDIA_TYPE_TEXT };
      }
      if (image) return { kind: 'image', data: b.data, mimeType: b.mimeType };
      return { kind: 'marker', text: toolResultAudioText(b.mimeType, b.data) };
    }
  }
}

/** What a tool result's inline audio shows as: its type and size, and that
 *  this host's tool results carry only text and images. */
function toolResultAudioText(mimeType: string, data: string): string {
  const what = [referenceTypeLabel(mimeType), formatSize(Math.floor(data.length * 3 / 4))].filter(Boolean).join(', ');
  return `[Audio not shown: this host's tool results carry only text and images (${what}).]`;
}

export interface HistorySerializeOptions {
  /**
   * Whether the result's data is a protocol result's content
   * (ToolResult.dataIsContent), so an array is shown block by block whatever
   * its blocks' types (toolResultBlocks). nonErrorResultText takes it from
   * the result instead, whatever this says.
   */
  dataIsContent?: boolean;
  /**
   * Called for every image block the serializer replaces with a placeholder
   * (issue #104). Returns the retention ref to embed in the placeholder —
   * `[image: image/png, ~691KB, ref img_7]` — so the image keeps a saveable
   * handle in history; null leaves the legacy ref-less form.
   */
  imageRef?: (blockIndex: number, image: { data: string; mimeType: string }) => string | null;
  /**
   * Called once a content array has been serialized block by block, rather
   * than given up on for the fallback, with where each block sits in the
   * joined text, before any cut at `maxChars`, and the blocks themselves as
   * this text was made from them. The framework reads from it what a
   * result's live copy shows (#403), and builds that copy from these very
   * blocks, so the two copies come from one classification.
   */
  onBlocks?: (spans: HistoryBlockSpan[], blocks: ToolResultBlock[]) => void;
  /**
   * The claims to read (ResultClaims) in place of the data's own, where the
   * data shown is part of a larger result whose claims these are
   * (resultClaimsOf), such as the fields a withheld result keeps.
   */
  claims?: ResultClaims;
}

/**
 * House-safe default inline cap (chars) for tool results, error results, and
 * background-script wake payloads (issue #89: a resident should never eat a
 * 42k blob they didn't ask for). Durable per-residence value comes from
 * `FrameworkConfig.toolResultInlineMaxChars`; a per-agent value from
 * agent_settings `tool_result_inline_max_chars`.
 *
 * Raised 5000 → 24000 (2026-08-07) on production evidence rather than taste.
 * The first residence to actually run the 5000 default spilled 48 results in
 * 23h, 71% of them ordinary shell output from source review — `git diff`, test
 * runs, `sed -n '450,590p'`-style excerpts, which routinely land at 5–15k. A
 * 5000-char cap is tuned for conversation and turns every file read into a
 * spill round-trip for a resident doing code work. Measured on that corpus:
 * 20000 keeps 76% inline, 24000 keeps 88%, 32000 only reaches 90% — 24000 is
 * the elbow. Genuinely large payloads (full histories, channel registries,
 * broad greps) still spill, which is the point.
 */
export const DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS = 24000;

export function toolResultDataToHistoryString(
  data: unknown,
  maxChars?: number,
  options?: HistorySerializeOptions,
): string {
  const fromArray = tryHistoryStringFromContentArray(data, options);
  // JSON leaves out undefined, a function and a symbol: a result with no data
  // is stored as no text, as an empty content array is.
  const str = fromArray ?? historyJson(data, options?.claims) ?? '';
  return maxChars ? truncateForHistory(str, maxChars) : str;
}

/**
 * The text of a tool result that isn't an error result: its data, as history
 * stores it, or, when it has no data, its error text. A tool can answer
 * `{ success: false, error, isError: false }`, a failure it doesn't flag as
 * an error for the model, and the model still reads what failed.
 *
 * Each field is read once: the direct Agent API passes its caller's own
 * result here, unchecked, and a getter needn't answer the same way twice.
 * Whether an array is content is the result's own `dataIsContent`, read for
 * its truth as a result's flags are, whatever `options` says.
 */
export function nonErrorResultText(
  result: { data?: unknown; error?: string; dataIsContent?: boolean },
  maxChars?: number,
  options?: HistorySerializeOptions,
): string {
  const data = result.data;
  if (data === undefined || data === null) {
    const error = result.error;
    if (typeof error === 'string' && error) return maxChars ? truncateForHistory(error, maxChars) : error;
  }
  return toolResultDataToHistoryString(data, maxChars, { ...options, dataIsContent: Boolean(result.dataIsContent) });
}

/** Bounded copy of an arbitrary string with the standard truncation notice,
 *  cut at the cap as a tool result's stored copy is (toolResultCutAt), so it
 *  never ends in part of a slot. Each of its callers' readers sees this
 *  very text, never the images behind a placeholder, so nothing past the cut
 *  is kept for save_recent_image's index (#403). The framework stores a tool
 *  result with spillOrTruncate, which keeps the slots past its cut that the
 *  result's live copy showed. */
export function truncateForHistory(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return str.slice(0, toolResultCutAt(str, maxChars)) + '\n\n[truncated — original was ' + str.length + ' chars]';
}

/**
 * A content array's history text (toolResultBlocks): each block's text, an
 * image as its placeholder, joined by newlines. Null when `data` isn't a
 * content array, for the fallback, historyJson.
 */
function tryHistoryStringFromContentArray(data: unknown, options?: HistorySerializeOptions): string | null {
  const blocks = toolResultBlocks(data, options?.dataIsContent, options?.claims);
  if (blocks === null) return null;
  const parts = blocks.map((block, blockIndex): { kind: HistoryBlockSpan['kind']; text: string } => {
    if (block.kind !== 'image') return block;
    // Decoded byte estimate from base64 length (3/4 ratio, rounded).
    const approxBytes = Math.floor(block.data.length * 3 / 4);
    const ref = options?.imageRef?.(blockIndex, { data: block.data, mimeType: block.mimeType }) ?? null;
    return { kind: 'image', text: formatToolImagePlaceholder(block.mimeType, formatSize(approxBytes), ref) };
  });
  if (options?.onBlocks) {
    const spans: HistoryBlockSpan[] = [];
    let start = 0;
    for (const part of parts) {
      spans.push({ kind: part.kind, start, end: start + part.text.length });
      start += part.text.length + 1; // the newline that joins them
    }
    options.onBlocks(spans, blocks);
  }
  return parts.map((part) => part.text).join('\n');
}

/**
 * Whether RFC-005 governs a value of a tool result's data, wherever it sits.
 * A reference is a `resource` with a uri, at its top level or under
 * `resource` (where MCP embeds a resource's uri), or an `image` or `audio`
 * given by uri; inline data is an `image` or `audio` whose data is a string.
 * There a uri that is null, absent or empty counts as none, and data that
 * isn't a string isn't inline data, so a record that only shares one of
 * those type names is data. A uri of any other value, string or not, counts,
 * so a credential fails closed. MCP's `resource_link` (RFC-005 §8.1) is
 * governed whatever its uri: one without a usable uri is its marker.
 */
function governedByRfc005(b: Record<string, unknown>): boolean {
  if (b.type === 'resource') return hasUri(b.uri) || (isPlainRecord(b.resource) && hasUri(b.resource.uri));
  // A link is governed whatever its uri, so one without a usable uri is its
  // marker here, as on the content lanes, never its fields.
  if (b.type === 'resource_link') return true;
  if (b.type === 'image' || b.type === 'audio') return typeof b.data === 'string' || hasUri(b.uri);
  return false;
}

function hasUri(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A value of a tool result's data as history shows it, by RFC-005's rules,
 * wherever it sits in the data. A value RFC-005 governs (governedByRfc005) is
 * shown as the reference lanes show it: a reference as its stub, an invalid
 * one (such as a uri that isn't a string, or MCP's embedded resource, whose
 * uri isn't at its top level) as the marker saying why it isn't shown, and
 * inline data that also claims a uri or a disposition as withheld. So of
 * the uris RFC-005 governs, the only one shown is a link's, in its line,
 * where the host can't fetch the link and its uri can't carry a credential
 * (shownLinkUri). Inline data that claims neither is itself, as is any other
 * value: a block of another type keeps its fields, a url among them, since
 * RFC-005 governs references.
 */
function shownInHistory(value: unknown, claims?: ResultClaims): unknown {
  return walkedInHistory(value, (b) => referenceStubOrNull(b, 'from tool result', undefined, { unfetchedLinkUri: true, claims }));
}

/**
 * The one walk of a tool result's data that showing it and reading its
 * claims both take: a value RFC-005 governs is text, from `asText`, except
 * inline data that claims no uri or disposition, which is itself, as is any
 * other value, so serialization descends into the same values each time, so
 * long as each value's toJSON and getters answer the same each time they're
 * read. `asText` gives a governed value's text, or null where it's itself.
 */
function walkedInHistory(value: unknown, asText: (b: Record<string, unknown>) => string | null): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const b = value as Record<string, unknown>;
  if (!governedByRfc005(b)) return value;
  if ((b.type === 'image' || b.type === 'audio') && typeof b.data === 'string') {
    // JSON writes every field, so here inline data beside a uri of any value
    // is withheld, not only beside a string one as in the lanes, which show
    // no uri: an object can carry a credential. An empty uri carries none.
    return hasUri(b.uri) || b.disposition !== undefined ? INLINE_WITHHELD_TEXT : value;
  }
  return asText(b) ?? value;
}

/**
 * What a tool result's data claims of each uri its references name
 * (ResultClaims), read by the walk serialization takes (walkedInHistory),
 * through toJSON, the fields of inline data and every depth it shows: so
 * every reference whose stub the result shows counts, and nothing it doesn't
 * show does. A value the walk can't read or write, such as a cycle or a
 * getter that throws, stops it, and then it's null, since what the rest of
 * the data claims is unknown. It's a walk of its own before the one that
 * shows the data, so a value's toJSON and getters run in both: one that
 * answers differently the second time can claim what the shown text doesn't
 * show.
 */
function claimsInHistory(data: unknown): ResultClaims | null {
  const testimonies: ReferenceTestimony[] = [];
  const read = (b: Record<string, unknown>): string | null => {
    const c = classifyBlock(b);
    if (c.kind === 'reference') testimonies.push(c.testimony);
    // Text where referenceStubOrNull gives text, so the walk descends where
    // showing descends. Inline data never reaches here: walkedInHistory
    // decides it first.
    return c.kind === 'text' ? null : '';
  };
  try {
    const root = walkedInHistory(data, read);
    // Its text is thrown away, so a string is written as 0, which keeps a
    // long one from being copied for nothing; the walk descends as before.
    if (root === data || typeof root !== 'string') {
      JSON.stringify(data, (_key, value: unknown) => {
        const walked = walkedInHistory(value, read);
        return typeof walked === 'string' ? 0 : walked;
      });
    }
  } catch {
    // Showing the whole result stops at the same value, for a value that
    // answers the same each time it's read. A caller that shows part of it,
    // such as a withheld result's kept fields, can't know what the rest
    // claims.
    return null;
  }
  return resultClaims(testimonies);
}

/**
 * The text RFC-005 shows a value of a tool result's data as, when it shows it
 * as text rather than as its fields: a reference's stub, an invalid one's
 * marker, or inline data withheld. Null for any other value.
 */
export function rfc005TextOf(value: unknown): string | null {
  // A single value claims only what it says itself, which its stub reads.
  const shown = shownInHistory(value);
  return shown !== value && typeof shown === 'string' ? shown : null;
}

/** The claims of data that claims nothing. */
const NO_CLAIMS: ResultClaims = new Map();

/**
 * JSON of a tool result's data with each value in it shown as history shows
 * it (shownInHistory), at any depth. Data that is itself shown as text, such
 * as a bare reference, is that text.
 */
function historyJson(data: unknown, given?: ResultClaims): string | undefined {
  // A walk that stopped claims nothing: showing stops at the same value.
  const claims = given ?? claimsInHistory(data) ?? NO_CLAIMS;
  const root = shownInHistory(data, claims);
  if (root !== data && typeof root === 'string') return root;
  return JSON.stringify(data, (_key, value: unknown) => shownInHistory(value, claims)) as string | undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)}KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
