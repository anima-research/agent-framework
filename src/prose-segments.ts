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
 * mode's `tool_attempt` / `tool_notice`; empty or whitespace-only runs are
 * dropped. (Whose round a run belongs to is withoutRoundsProse's question,
 * and there a notice ends text only before a round's first call.)
 */

import type { ContentBlock } from '@animalabs/membrane';

/**
 * The runs exactly as written: contiguous text blocks joined with a newline,
 * nothing trimmed. Whitespace-only runs are dropped. Held drafts keep these,
 * so a draft's words (indentation included) are the resident's own, byte for
 * byte; speech routes each run trimmed of surrounding whitespace.
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

/**
 * A turn's content without the prose of some of its tool rounds, the turn's
 * rounds counted from 0 in order. A round's prose is its text
 * up to its results, and a round starts at the first block after the previous
 * round's `tool_result` blocks. So a round with no prose still counts, two
 * calls of one round (their `tool_use` blocks come before any result) stay
 * one round, and a round is found by its place, whatever its text holds.
 * An all-refused XML attempt (`tool_attempt`, answered by a `tool_notice`) was
 * no round, so the text before either block is no round's and stays; once a
 * round has named a call, its text up to its results stays its own, a notice
 * between them or not. A round refused in part reads by its blocks' order:
 * text before a refused attempt that comes ahead of the accepted call is no
 * round's. No membrane writes these blocks yet (membrane#101 closed), so that
 * case is left as the order says.
 * Other rounds' text, every non-text block and the text after the last round
 * stay.
 */
export function withoutRoundsProse(
  content: readonly ContentBlock[],
  rounds: ReadonlySet<number>,
): ContentBlock[] {
  const dropped = new Set<number>();
  let round = 0;
  let afterResults = false;
  // Whether this round has named a call yet: a notice inside a started round
  // doesn't end the round's text, its result does.
  let called = false;
  // The text since the last boundary: whose it is shows at what ends it.
  let unclaimed: number[] = [];
  const claim = (): void => {
    if (rounds.has(round)) for (const at of unclaimed) dropped.add(at);
    unclaimed = [];
  };
  content.forEach((block, at) => {
    const type = block.type as string;
    if (type === 'tool_result') {
      claim();
      afterResults = true;
      return;
    }
    if (afterResults) {
      round++;
      afterResults = false;
      called = false;
    }
    if (type === 'tool_attempt' || type === 'tool_notice') {
      if (!called) unclaimed = [];
    } else if (type === 'tool_use') {
      claim();
      called = true;
    } else if (type === 'text') {
      unclaimed.push(at);
    }
  });
  claim();
  return content.filter((_, at) => !dropped.has(at));
}
