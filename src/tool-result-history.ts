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

import { safeSlice } from './safe-slice.js';

/**
 * House-safe default inline cap (chars) for tool results, error results, and
 * background-script wake payloads (issue #89: a resident should never eat a
 * 42k blob they didn't ask for). Durable per-residence value comes from
 * `FrameworkConfig.toolResultInlineMaxChars`; a temporary per-agent lift from
 * agent_settings `tool_result_inline_max_chars`.
 */
export const DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS = 5000;

export function toolResultDataToHistoryString(data: unknown, maxChars?: number): string {
  const fromArray = tryHistoryStringFromContentArray(data);
  const str = fromArray ?? JSON.stringify(data);
  return maxChars ? truncateForHistory(str, maxChars) : str;
}

/** Bounded copy of an arbitrary string with the standard truncation notice. */
export function truncateForHistory(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return safeSlice(str, 0, maxChars)
    + '\n\n[truncated — original was ' + str.length + ' chars]';
}

/**
 * If `data` is an MCP content array whose every block has a shape we
 * recognize, return a history-safe string (images → placeholders). Otherwise
 * return `null` to defer to the caller's fallback (JSON, usually).
 */
function tryHistoryStringFromContentArray(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  const parts: string[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string') {
      // Decoded byte estimate from base64 length (3/4 ratio, rounded).
      const approxBytes = Math.floor(b.data.length * 3 / 4);
      parts.push(`[image: ${b.mimeType}, ${formatSize(approxBytes)}]`);
    } else {
      return null;
    }
  }
  return parts.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)}KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
