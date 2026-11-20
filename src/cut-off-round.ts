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
  /** Whether the round's calls were built from XML (a cut tool block, or a call carrying rawXml). */
  xml: boolean;
  /**
   * In XML tool mode, what the tag the cut came inside says of a call that
   * might have followed: `may` where the response ended in a tag that could
   * still have become `think`'s head (`<invoke name="thi`, or a name read
   * whole before its tag closed), `not` where it ended in any other unclosed
   * tag (`<invoke name="robo`, `</inv`), `none` where it ended outside one:
   * between tags, in a call's parameter text, or inside the block's own
   * opener. Native responses are always `none`.
   */
  nextCall: 'may' | 'not' | 'none';
}

/**
 * The last round of a response that ended at the output limit, when it holds
 * calls that never ran, or, in XML tool mode, a tool-call block cut off before
 * any call in it was named (`unnamed`). Membrane yields a round's calls only
 * at its tool_use stop, or in XML tool mode at its `</function_calls>` stop,
 * and the round begins after the last result that answers one of the
 * response's calls.
 */
export function cutOffRound(response: NormalizedResponse, opts: { partialOpener?: boolean } = {}): CutOffRound | undefined {
  if (response.stopReason !== 'max_tokens') return undefined;
  const callIds = new Set<string>();
  let start = 0;
  response.content.forEach((block, index) => {
    if (block.type === 'tool_use') callIds.add(block.id);
    else if (block.type === 'tool_result' && callIds.has(block.toolUseId)) start = index + 1;
  });
  const cut = response.details?.stop?.unclosedToolBlock ? cutToolBlock(response.content, start)
    : opts.partialOpener ? cutPartialOpener(response.content, start) : undefined;
  const content = cut?.content ?? response.content;
  const uses = content.slice(start).filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use');
  const calls = uses.map(({ id, name, input, unparseableInput }) => ({
    id, name, input,
    ...(unparseableInput !== undefined ? { unparseableInput } : {}),
  }));
  const unnamed = !!cut && calls.length === 0;
  const nextCall = cut?.nextCall ?? 'none';
  const xml = !!cut || uses.some((block) => (block as { rawXml?: string }).rawXml !== undefined);
  return calls.length > 0 || unnamed ? { content, start, calls, unnamed, xml, nextCall } : undefined;
}

/**
 * Membrane 0.8.0's, 0.9.0's, 0.10.0's and 0.10.1's grammar (unchanged from
 * 0.7.2) for the anthropic-xml formatter's XML tool mode. Membrane exports two of its
 * predicates, hasUnclosedToolBlock and endsWithPartialToolBlock, but not the
 * grammar itself (dist/utils/tool-parser.js, INVOKE_REGEX): a block opens
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
// The opening tags a think call can have, which a tag cut off at the output
// limit may still have been on its way to: closed by `>`, or self-closed, as
// NAME_HEAD and membrane's grammar both read it (think's thought is optional).
const THINK_HEADS = ['', 'antml:'].flatMap((ns) => ['"', "'"].flatMap((q) =>
  ['>', '/>', ' />'].map((close) => `<${ns}invoke name=${q}think${q}${close}`)));

/**
 * What the text after a block's last whole name head ends in: `none` unless
 * it ends in a tag not yet closed by `>`; then `may` where that tag's text
 * (whitespace runs read as one space) begins one of THINK_HEADS, else `not`.
 */
function nextCallOf(tail: string): 'may' | 'not' | 'none' {
  const at = tail.lastIndexOf('<');
  if (at < 0 || tail.indexOf('>', at) >= 0) return 'none';
  const tag = tail.slice(at).replace(/\s+/g, ' ').trimEnd();
  return THINK_HEADS.some((head) => head.startsWith(tag)) ? 'may' : 'not';
}

const OPENERS = ['', 'antml:'].map((ns) => `<${ns}function_calls>`);

/**
 * A response that ended inside a tool block's opener before its name was
 * whole (`<f` … `<function_calls`, or the `antml:` form from `<a`), which
 * membrane doesn't read as a tool block (endsWithPartialToolBlock needs the
 * whole name). Only for a stream already known to be on the XML path
 * (cutOffRound's partialOpener): the round's last text loses the fragment,
 * and no call was named.
 */
function cutPartialOpener(content: ContentBlock[], start: number): { content: ContentBlock[]; nextCall: 'none' } | undefined {
  let index = content.length - 1;
  while (index >= start && content[index]!.type !== 'text') index--;
  if (index < start) return undefined;
  const text = (content[index] as ContentBlock & { type: 'text' }).text;
  const at = text.lastIndexOf('<');
  const tail = text.slice(at);
  if (at < 0 || tail.length < 2 || !OPENERS.some((opener) => opener.startsWith(tail))) return undefined;
  const prose = text.slice(0, at);
  return {
    content: [...content.slice(0, index), ...(prose ? [{ type: 'text', text: prose } as ContentBlock] : []), ...content.slice(index + 1)],
    nextCall: 'none',
  };
}

function cutToolBlock(content: ContentBlock[], start: number): { content: ContentBlock[]; nextCall: 'may' | 'not' | 'none' } | undefined {
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
  const lastHead = [...blockText.matchAll(NAME_HEAD)].at(-1);
  // From past the last whole name head, or past the opener's own `<`.
  const nextCall = nextCallOf(blockText.slice(lastHead ? lastHead.index + lastHead[0].length : 1));
  return { content: [...content.slice(0, holder.index), ...prose, ...kept, ...calls], nextCall };
}
