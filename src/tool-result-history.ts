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
 * For MCP-shaped content arrays, this helper keeps text blocks verbatim,
 * apart from a lone UTF-16 surrogate, which becomes U+FFFD (#695), and
 * replaces image blocks with a short `[image: mimeType, ~NKB]` placeholder.
 * A string is already text and is kept as it is. For anything else it falls
 * back to JSON, written by RFC-005's rules at every depth (historyJson): a
 * reference is shown as its stub wherever it sits in the data, so its uri
 * never reaches history, and inline data that claims a uri or a disposition
 * is withheld.
 */

import { INLINE_WITHHELD_TEXT, isInlineContradiction, referenceBlockForScript, referenceStubOrNull } from './mcpl/references.js';
import { NON_STRING_TEXT_PLACEHOLDER } from './mcpl/visible-content.js';
import { formatToolImagePlaceholder, toolResultCutAt } from './tool-image-ledger.js';

/** Where one block of a content array sits in its history text, and what
 *  kind of block it was: text, an inline image (its placeholder), an RFC-005
 *  reference (its stub), or inline data withheld for a contradiction. */
export interface HistoryBlockSpan {
  kind: 'text' | 'image' | 'reference' | 'withheld';
  start: number;
  end: number;
}

export interface HistorySerializeOptions {
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
   * joined text, before any cut at `maxChars`. The framework reads from it
   * what a result's live copy showed (#403).
   */
  onBlocks?: (spans: HistoryBlockSpan[]) => void;
}

/**
 * House-safe default inline cap (chars) for tool results, error results, and
 * script wake payloads (issue #89: a resident should never eat a
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
  // A string is the text the tool means to say, kept as it is: JSON would
  // quote it and escape every newline, so a multi-line result would reach
  // the model, a script and its spill file as one escaped line. Kept well
  // formed: a lone UTF-16 surrogate, which JSON escaped, isn't text, a
  // provider can refuse a request that carries one, and UTF-8 can't store
  // it in a spill file, so it reads as U+FFFD.
  // JSON leaves out undefined, a function and a symbol: a result with no data
  // is stored as no text, as an empty content array is.
  // RFC-005 shows only objects otherwise (shownInHistory), so a string has
  // nothing for historyJson to stub or withhold.
  const str = fromArray
    ?? (typeof data === 'string' ? data.toWellFormed() : historyJson(data))
    ?? '';
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
 *
 * Each text a tool result's copies carry is made well formed where it's
 * taken from the result: a lone UTF-16 surrogate becomes U+FFFD, as the
 * context store makes it when it writes, so the copy sent to membrane and the
 * copy stored carry the same text (#695). Other data goes through JSON,
 * which escapes a lone half. toWellFormed() keeps the length,
 * so the cut, the spans and the slots are computed from the well-formed text
 * as before; a cut at a lone high half no longer steps back over it.
 */
export function nonErrorResultText(
  result: { data?: unknown; error?: string },
  maxChars?: number,
  options?: HistorySerializeOptions,
): string {
  const data = result.data;
  if (data === undefined || data === null) {
    const error = result.error;
    if (typeof error === 'string' && error) {
      const text = error.toWellFormed();
      return maxChars ? truncateForHistory(text, maxChars) : text;
    }
  }
  return toolResultDataToHistoryString(data, maxChars, options);
}

/** Bounded copy of an arbitrary string with the standard truncation notice,
 *  cut at the cap where a tool result's stored copy is cut at that cap
 *  (toolResultCutAt), so it
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
 * If `data` is an MCP content array whose every block has a shape we
 * recognize, return a history-safe string (images → placeholders). Otherwise
 * return `null` to defer to the fallback, historyJson, which shows a
 * reference anywhere in the data as its stub.
 */
function tryHistoryStringFromContentArray(data: unknown, options?: HistorySerializeOptions): string | null {
  if (!Array.isArray(data)) return null;
  const parts: Array<{ kind: HistoryBlockSpan['kind']; text: string }> = [];
  for (const [blockIndex, raw] of data.entries()) {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === 'text') {
      // A text that isn't a string shows as the converters' placeholder,
      // rather than sending the whole array to the JSON fallback.
      // Read once: a direct Agent API result is unchecked.
      const text = b.text;
      parts.push({ kind: 'text', text: typeof text === 'string' ? text.toWellFormed() : NON_STRING_TEXT_PLACEHOLDER });
    } else if (isInlineContradiction(b)) {
      // RFC-005 vector 2: checked before the data branch so inline data
      // claiming bulk disposition is withheld, not rendered.
      parts.push({ kind: 'withheld', text: INLINE_WITHHELD_TEXT });
    } else if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string') {
      // Decoded byte estimate from base64 length (3/4 ratio, rounded).
      const approxBytes = Math.floor(b.data.length * 3 / 4);
      const ref = options?.imageRef?.(blockIndex, { data: b.data, mimeType: b.mimeType }) ?? null;
      parts.push({ kind: 'image', text: formatToolImagePlaceholder(b.mimeType, formatSize(approxBytes), ref) });
    } else if (b.type === 'resource' || ((b.type === 'image' || b.type === 'audio') && typeof (b as { uri?: unknown }).uri === 'string')) {
      // RFC-005 reference block: a bounded stub, never the raw block JSON
      // (which used to inline the URI — and the whole array — into history).
      // A stub that shows an image type occupies a slot in
      // save_recent_image's inventory (a failing one — bytes live behind
      // fetch_reference), so the index never slides past an image the
      // resident saw.
      const stub = referenceStubOrNull(b, 'from tool result');
      if (stub === null) return null;
      parts.push({ kind: 'reference', text: stub });
    } else {
      return null;
    }
  }
  if (options?.onBlocks) {
    const spans: HistoryBlockSpan[] = [];
    let start = 0;
    for (const part of parts) {
      spans.push({ kind: part.kind, start, end: start + part.text.length });
      start += part.text.length + 1; // the newline that joins them
    }
    options.onBlocks(spans);
  }
  return parts.map((part) => part.text).join('\n');
}

/**
 * Whether RFC-005 governs a value of a tool result's data, wherever it sits.
 * A reference is a `resource` with a uri, at its top level or under
 * `resource` (where MCP embeds a resource's uri), or an `image` or `audio`
 * given by uri; inline data is an `image` or `audio` whose data is a string.
 * A uri that is null, absent or empty counts as none, and data that isn't a
 * string isn't inline data, so a record that only shares one of those type
 * names is data. A uri of any other value, string or not, counts, so a
 * credential fails closed.
 */
function governedByRfc005(b: Record<string, unknown>): boolean {
  if (b.type === 'resource') return hasUri(b.uri) || (isPlainRecord(b.resource) && hasUri(b.resource.uri));
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
 * uri isn't at its top level) as an unrecognized-block line, and inline data
 * that also claims a uri or a disposition as withheld, so no uri is ever
 * shown. Inline data that claims neither is itself, as is any other value:
 * a block of another type keeps its fields, a `resource_link`'s uri among
 * them, since RFC-005 governs references.
 */
function shownInHistory(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const b = value as Record<string, unknown>;
  if (!governedByRfc005(b)) return value;
  if ((b.type === 'image' || b.type === 'audio') && typeof b.data === 'string') {
    // JSON writes every field, so here inline data beside a uri of any value
    // is withheld, not only beside a string one as in the lanes, which show
    // no uri: an object can carry a credential. An empty uri carries none.
    return hasUri(b.uri) || b.disposition !== undefined ? INLINE_WITHHELD_TEXT : value;
  }
  return referenceStubOrNull(b, 'from tool result') ?? value;
}

/**
 * A value of a tool result's data as a script reads it, by history's rules
 * (shownInHistory), as a JSON replacer applies them at every depth: what
 * RFC-005 governs is shown as the script lane shows it, a reference as its
 * stub's facts without its uri and an invalid one as the notice
 * (referenceBlockForScript), and inline data that also claims a uri of any
 * value or a disposition as the withheld notice, each as a text block. Any
 * other value is itself. What it gives is either a stub or a notice, which
 * RFC-005 doesn't govern, or the value itself, which it gives again, so
 * applying it twice gives what applying it once gave.
 */
export function shownToScript(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const b = value as Record<string, unknown>;
  if (!governedByRfc005(b)) return value;
  if ((b.type === 'image' || b.type === 'audio') && typeof b.data === 'string') {
    return hasUri(b.uri) || b.disposition !== undefined ? { type: 'text', text: INLINE_WITHHELD_TEXT } : value;
  }
  return referenceBlockForScript(b);
}

/**
 * The text RFC-005 shows a value of a tool result's data as, when it shows it
 * as text rather than as its fields: a reference's stub, an invalid one's
 * unrecognized-block line, or inline data withheld. Null for any other value.
 */
export function rfc005TextOf(value: unknown): string | null {
  const shown = shownInHistory(value);
  return shown !== value && typeof shown === 'string' ? shown : null;
}

/**
 * JSON of a tool result's data with each value in it shown as history shows
 * it (shownInHistory), at any depth. Data that is itself shown as text, such
 * as a bare reference, is that text.
 */
function historyJson(data: unknown): string | undefined {
  const root = shownInHistory(data);
  if (root !== data && typeof root === 'string') return root;
  return JSON.stringify(data, (_key, value: unknown) => shownInHistory(value)) as string | undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)}KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
