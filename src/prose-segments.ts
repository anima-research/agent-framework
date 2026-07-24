/**
 * Split an assistant turn's content blocks into ordered prose segments.
 *
 * A single turn can interleave prose and tool calls — "msgA → [tool] → msgB →
 * [tool] → msgC". The membrane accumulates the WHOLE turn (all tool rounds) into
 * one `response.content` array in provider order, so a left-to-right walk that
 * breaks at each tool boundary reconstructs the emission order.
 *
 * Host output routing used to join every text block into a single trailing post,
 * collapsing those distinct messages into one (item 4). This helper instead
 * yields each contiguous run of text — the segments a surface should deliver as
 * separate, ordered messages. Contiguous text blocks merge into one segment;
 * `tool_use` / `tool_result` blocks are segment boundaries; empty or
 * whitespace-only runs are dropped.
 */

import type { ContentBlock } from '@animalabs/membrane';

export function splitProseSegments(content: readonly ContentBlock[]): string[] {
  const segments: string[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    const s = buf.join('\n').trim();
    if (s) segments.push(s);
    buf = [];
  };

  for (const block of content) {
    if (block.type === 'text') {
      buf.push((block as ContentBlock & { type: 'text' }).text);
    } else if (block.type === 'tool_use' || block.type === 'tool_result') {
      flush();
    }
    // Other block types (thinking, redacted_thinking, image, …) are neither
    // prose nor boundaries: they don't reach a channel and don't separate two
    // prose messages, so they're skipped without flushing.
  }
  flush();

  return segments;
}

/**
 * The part of `spoken` not already covered by `delivered`, ignoring whitespace
 * differences — live-routed segments carry their own separators, while a voice
 * client's spoken text keeps the original stream's spacing, so the two never
 * match byte-for-byte.
 *
 * Three outcomes, keyed to what voice clients actually send as spokenText:
 * - `delivered` covers all of `spoken` → null (everything the user heard is
 *   already in the channel; posting again would duplicate it).
 * - `spoken` starts with `delivered` and extends past it → the raw suffix
 *   (a client that accumulates the whole turn's speech: post only the tail).
 * - the two do not align → `spoken` unchanged. Non-alignment means this is a
 *   NEW utterance's text, not a re-send: the relay protocol tracks spoken
 *   text per message, and the reference client (melodeus) resets its
 *   accumulator at every block_start — so an interruption mid round 2 sends
 *   only round 2's fragment, which the live path has never posted.
 */
export function undeliveredSuffix(spoken: string, delivered: string): string | null {
  const isWs = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';
  let i = 0; // index into spoken
  let j = 0; // index into delivered
  while (j < delivered.length) {
    if (isWs(delivered[j])) {
      j++;
      continue;
    }
    while (i < spoken.length && isWs(spoken[i])) i++;
    if (i >= spoken.length) return null; // spoken fully covered by delivered
    if (spoken[i] !== delivered[j]) {
      // Divergence: `spoken` is a different utterance than the posted prose
      // (per-block client), not a prefix re-send. All of it is undelivered.
      return spoken;
    }
    i++;
    j++;
  }
  const rest = spoken.slice(i).trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Whether `prefix` matches the start of `text`, ignoring whitespace
 * differences (same walk as undeliveredSuffix, answering only yes/no).
 *
 * Used to judge whether a voice client's reported spoken text belongs to the
 * utterance currently streaming in a channel: the client voices a prefix of
 * what was streamed, so a report that does not prefix-match the current
 * utterance is stale — it describes an earlier utterance and must not
 * interrupt the new one. An empty `prefix` trivially matches.
 */
export function isWhitespaceInsensitivePrefix(prefix: string, text: string): boolean {
  const isWs = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';
  let i = 0; // index into text
  let j = 0; // index into prefix
  while (j < prefix.length) {
    if (isWs(prefix[j])) {
      j++;
      continue;
    }
    while (i < text.length && isWs(text[i])) i++;
    if (i >= text.length || text[i] !== prefix[j]) return false;
    i++;
    j++;
  }
  return true;
}
