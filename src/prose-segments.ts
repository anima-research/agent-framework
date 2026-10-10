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
 * `tool_use` / `tool_result` blocks are segment boundaries, as are XML tool
 * mode's `tool_attempt` / `tool_notice` (a refused attempt and the harness's
 * notice end a round just as a call and its results do); empty or
 * whitespace-only runs are dropped.
 */

import type { ContentBlock } from '@animalabs/membrane';

/**
 * The runs exactly as written: contiguous text blocks joined with a newline,
 * nothing trimmed. Whitespace-only runs are dropped. Held drafts keep these,
 * so a draft's words (indentation included) are the resident's own, byte for
 * byte.
 */
export function splitProseRuns(content: readonly ContentBlock[]): string[] {
  const runs: string[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    const run = buf.join('\n');
    if (run.trim()) runs.push(run);
    buf = [];
  };

  for (const block of content) {
    const type = block.type as string;
    if (type === 'text') {
      buf.push((block as ContentBlock & { type: 'text' }).text);
    } else if (
      type === 'tool_use' ||
      type === 'tool_result' ||
      type === 'tool_attempt' ||
      type === 'tool_notice'
    ) {
      flush();
    }
    // Other block types (thinking, redacted_thinking, image, …) are neither
    // prose nor boundaries: they don't reach a channel and don't separate two
    // prose messages, so they're skipped without flushing.
  }
  flush();

  return runs;
}

/** The runs as speech is routed: each trimmed of surrounding whitespace. */
export function splitProseSegments(content: readonly ContentBlock[]): string[] {
  return splitProseRuns(content).map((run) => run.trim());
}
