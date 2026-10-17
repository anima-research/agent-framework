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
 * For MCP-shaped content arrays, this helper keeps text blocks verbatim and
 * replaces image blocks with a short `[image: mimeType, ~NKB]` placeholder.
 * For anything else it falls back to JSON.
 */

import { INLINE_WITHHELD_TEXT, isInlineContradiction, referenceStubOrNull } from './mcpl/references.js';
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
  const str = fromArray ?? (JSON.stringify(data) as string | undefined) ?? '';
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
 */
export function nonErrorResultText(
  result: { data?: unknown; error?: string },
  maxChars?: number,
  options?: HistorySerializeOptions,
): string {
  const data = result.data;
  if (data === undefined || data === null) {
    const error = result.error;
    if (typeof error === 'string' && error) return maxChars ? truncateForHistory(error, maxChars) : error;
  }
  return toolResultDataToHistoryString(data, maxChars, options);
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
 * If `data` is an MCP content array whose every block has a shape we
 * recognize, return a history-safe string (images → placeholders). Otherwise
 * return `null` to defer to the caller's fallback (JSON, usually).
 */
function tryHistoryStringFromContentArray(data: unknown, options?: HistorySerializeOptions): string | null {
  if (!Array.isArray(data)) return null;
  const parts: Array<{ kind: HistoryBlockSpan['kind']; text: string }> = [];
  for (const [blockIndex, raw] of data.entries()) {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ kind: 'text', text: b.text });
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)}KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
