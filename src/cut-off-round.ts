import { randomUUID } from 'node:crypto';
import type { ContentBlock, NormalizedResponse } from '@animalabs/membrane';

export interface CutOffCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  unparseableInput?: string;
}

export interface CutOffRound {
  content: ContentBlock[];
  start: number;
  calls: CutOffCall[];
  unnamed: boolean;
  xml: boolean;
}

/**
 * The last round of a response that ended at the output limit, when it holds
 * calls that never ran, or, in XML tool mode, a tool-call block cut off before
 * any call in it was named (`unnamed`). Membrane yields a round's calls only
 * at its tool_use stop, or in XML tool mode at its `</function_calls>` stop,
 * and the round begins after the last result that answers one of the
 * response's calls.
 */
export function cutOffRound(response: NormalizedResponse): CutOffRound | undefined {
  if (response.stopReason !== 'max_tokens') return undefined;
  const callIds = new Set<string>();
  let start = 0;
  response.content.forEach((block, index) => {
    if (block.type === 'tool_use') callIds.add(block.id);
    else if (block.type === 'tool_result' && callIds.has(block.toolUseId)) start = index + 1;
  });
  const cut = response.details?.stop?.unclosedToolBlock ? cutToolBlock(response.content, start) : undefined;
  const content = cut ?? response.content;
  const uses = content.slice(start).filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use');
  const calls = uses.map(({ id, name, input, unparseableInput }) => ({
    id, name, input,
    ...(unparseableInput !== undefined ? { unparseableInput } : {}),
  }));
  const unnamed = !!cut && calls.length === 0;
  const xml = !!cut || uses.some((block) => (block as { rawXml?: string }).rawXml !== undefined);
  return calls.length > 0 || unnamed ? { content, start, calls, unnamed, xml } : undefined;
}

/**
 * Membrane 0.8.0's grammar (unchanged from 0.7.2) for the anthropic-xml
 * formatter's XML tool mode. Membrane exports two of its predicates,
 * hasUnclosedToolBlock and endsWithPartialToolBlock, but not the grammar
 * itself (dist/utils/tool-parser.js, INVOKE_REGEX): a block opens
 * with `<function_calls>` and each call with `<invoke name="…">`, either tag
 * optionally `antml:` prefixed, and a closer ends the innermost block still
 * open. Its parser takes spans out of an unclosed block's text, which leaves
 * that text in several text blocks: thinking, which stays with the round, a
 * whole inner block its stop sequence didn't end, whose calls are the round's
 * too, and results, which don't stay. Only a block's opener
 * and each call's name head are read, nothing after a name, and a name that
 * isn't a tool name's characters isn't taken as one: the formatter writes a
 * stored call's name into the next request as it is.
 */
const OPENER = /<(antml:)?function_calls(>|[^>]*$)/g;
const CLOSER = /<\/(antml:)?function_calls>/g;
const NAME_HEAD = /<(antml:)?invoke\s+name=(["'])((?:(?!\2).)+)\2\s*\/?>/g;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

function cutToolBlock(content: ContentBlock[], start: number): ContentBlock[] | undefined {
  const texts = content.map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: ContentBlock & { type: 'text' }; index: number } => entry.index >= start && entry.block.type === 'text');
  const joined = texts.map(({ block }) => block.text).join('');
  const tags = [
    ...[...joined.matchAll(OPENER)].map((match) => ({ index: match.index, opens: true })),
    ...[...joined.matchAll(CLOSER)].map((match) => ({ index: match.index, opens: false })),
  ].sort((a, b) => a.index - b.index);
  const open: number[] = [];
  for (const tag of tags) {
    if (tag.opens) open.push(tag.index);
    else open.pop();
  }
  if (open.length === 0) return undefined;
  const opener = open[0]!;
  let at = opener;
  const holder = texts.find(({ block }) => {
    if (at < block.text.length) return true;
    at -= block.text.length;
    return false;
  })!;
  const blockText = joined.slice(opener);
  const heads = [...blockText.matchAll(NAME_HEAD)].filter((head) => TOOL_NAME.test(head[3]!));
  const calls: ContentBlock[] = heads.map((head, index) => ({
    type: 'tool_use', id: `tool_${randomUUID()}`, name: head[3]!, input: {},
    unparseableInput: blockText.slice(head.index, heads[index + 1]?.index),
  }));
  const prose: ContentBlock[] = at > 0 ? [{ type: 'text', text: holder.block.text.slice(0, at) }] : [];
  const kept = content.slice(holder.index + 1)
    .filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'tool_use');
  return [...content.slice(0, holder.index), ...prose, ...kept, ...calls];
}
