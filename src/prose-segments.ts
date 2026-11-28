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
 * before its calls, and a round starts at the first block after the previous
 * round's `tool_result` blocks. So a round with no prose still counts, two
 * calls of one round (their `tool_use` blocks come before any result) stay
 * one round, and a round is found by its place, whatever its text holds.
 * Other rounds' text, every non-text block and the text after the last round
 * stay.
 */
export function withoutRoundsProse(
  content: readonly ContentBlock[],
  rounds: ReadonlySet<number>,
): ContentBlock[] {
  let round = 0;
  let afterResults = false;
  return content.filter((block) => {
    if (block.type === 'tool_result') {
      afterResults = true;
      return true;
    }
    if (afterResults) {
      round++;
      afterResults = false;
    }
    return !(block.type === 'text' && rounds.has(round));
  });
}

/** The `tool_use` blocks of the given rounds, the rounds counted as withoutRoundsProse counts them. */
export function toolUsesOfRounds(
  content: readonly ContentBlock[],
  rounds: ReadonlySet<number>,
): Set<ContentBlock> {
  const found = new Set<ContentBlock>();
  let round = 0;
  let afterResults = false;
  for (const block of content) {
    if (block.type === 'tool_result') {
      afterResults = true;
      continue;
    }
    if (afterResults) {
      round++;
      afterResults = false;
    }
    if (block.type === 'tool_use' && rounds.has(round)) found.add(block);
  }
  return found;
}

/**
 * A turn's prose runs (splitProseRuns) in order, in groups whose rounds are
 * all in `held` or all outside it, the rounds counted as withoutRoundsProse
 * counts them. The text of a round in `dropped` and not in `held` is left
 * out, as withoutRoundsProse leaves it. Groups with no run are left out.
 */
export function proseRunGroups(
  content: readonly ContentBlock[],
  held: ReadonlySet<number>,
  dropped: ReadonlySet<number>,
): Array<{ held: boolean; runs: string[] }> {
  const groups: Array<{ held: boolean; blocks: ContentBlock[] }> = [];
  let round = 0;
  let afterResults = false;
  for (const block of content) {
    if (block.type === 'tool_result') {
      afterResults = true;
    } else if (afterResults) {
      round++;
      afterResults = false;
    }
    const inHeld = held.has(round);
    if (block.type === 'text' && !inHeld && dropped.has(round)) continue;
    const last = groups.at(-1);
    if (last && last.held === inHeld) last.blocks.push(block);
    else groups.push({ held: inHeld, blocks: [block] });
  }
  return groups
    .map((group) => ({ held: group.held, runs: splitProseRuns(group.blocks) }))
    .filter((group) => group.runs.length > 0);
}
