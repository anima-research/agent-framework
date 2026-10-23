import type { ContentBlock, ToolResult as MembraneToolResult } from '@animalabs/membrane';
import type { MessageId } from '@animalabs/context-manager';
import { isDeepStrictEqual } from 'node:util';

import { withoutTokenEstimates } from './thinking-token-stamp.js';

/**
 * A row a stream's later round carried after its compiled messages, as a context manager that keeps a
 * thinking-binding record is told of it (`noteRequestSent`): the id of a stored body the next request carries as
 * the stream sent it, or the marker for one it doesn't, after which nothing keeps its thinking.
 */
export type SentRow = MessageId | { unstored: true };

const UNSTORED: SentRow = Object.freeze({ unstored: true as const });

/**
 * Whether a request carries a block: the sanitize pass leaves out an empty or whitespace text block, which the
 * Anthropic API refuses (assembleActivationRequest). The `typeof` guard is runtime defense: history loaded from
 * disk can carry a non-string `text` despite what the types claim.
 */
export function carriedBlock(block: ContentBlock): boolean {
  return !(block.type === 'text' && (typeof block.text !== 'string' || block.text.trim() === ''));
}

/**
 * A stored body's content as the agent's next request carries it: what the sanitize pass leaves of it, without
 * the framework's pricing stamp. Null when the pass leaves nothing, so the request carries no message there.
 */
export function asNextRequestCarries(content: readonly ContentBlock[]): ContentBlock[] | null {
  const kept = content.filter(carriedBlock);
  if (kept.length === 0) return null;
  return withoutTokenEstimates([{ content: kept }])[0]!.content;
}

/** Blocks equal as JSON data: as the store keeps them and a request sends them, `undefined` fields left out. */
function sameData(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

/** What membrane builds a round's results message from: each submitted result as a `tool_result` block. */
function submittedBlocks(results: readonly MembraneToolResult[]): ContentBlock[] {
  return results.map((result) => ({
    type: 'tool_result',
    toolUseId: result.toolUseId,
    content: result.content,
    isError: result.isError === true,
  }) as ContentBlock);
}

/** One stored row of a round, beside what the stream sent in its place. */
export type RoundRow =
  | { kind: 'reply'; id: MessageId | undefined; sent: readonly ContentBlock[] }
  | { kind: 'results'; id: MessageId | undefined; sent: readonly MembraneToolResult[] }
  | { kind: 'injected'; id: MessageId | undefined; participant: string; sent: readonly ContentBlock[] };

/**
 * A round's rows as noted: each stored row's id where the next request carries it as the stream sent it, the
 * marker where it doesn't. `carried` gives each id's stored body as the next compile renders it (participant and
 * content, or null where that compile won't send it), so the comparison is the one the context manager's record
 * makes, after the agent's own request passes (asNextRequestCarries). A row the store doesn't hold (no id), a reply
 * that differs from the round's content as membrane held it, results that differ from those submitted (as while the
 * tool-result guard holds a batch, storing placeholders and submitting the originals), or an injected message sent
 * otherwise than its stored body renders, is the marker. Called again over the same rows once the store has
 * changed, as when the guard's batch settles to the originals, it gives each row's verdict as of then.
 */
export function roundRows(
  rows: readonly RoundRow[],
  carried: (id: MessageId) => { participant: string; content: ContentBlock[] } | null,
): SentRow[] {
  return rows.map((row): SentRow => {
    if (row.id === undefined) return UNSTORED;
    const body = carried(row.id);
    const content = body ? asNextRequestCarries(body.content) : null;
    if (!body || !content) return UNSTORED;
    // An empty or whitespace text block never reached the provider in the stream either: the API refuses one, and
    // membrane's native formatter leaves it out, so it's left out of what was sent as of what the next request carries.
    const sent = row.kind === 'results' ? submittedBlocks(row.sent) : row.sent.filter(carriedBlock);
    const sameParticipant = row.kind !== 'injected' || body.participant === row.participant;
    const sameContent = row.kind === 'results'
      ? sameData(content.map(normalizedResult), sent.map(normalizedResult))
      : sameData(content, sent);
    return sameParticipant && sameContent ? row.id : UNSTORED;
  });
}

/**
 * A results block as compared: what a request sends of it, its id, content and error flag, with `isError` as a
 * boolean, where a stored block may leave a false one out. A stream's envelope sends a submitted result's
 * `is_error: false` and the next request, from the stored block, sends none; the provider's thinking binding takes
 * the two alike (read from the provider on 2026-10-23: Haiku 5.5 with the drop control, on an enforcing API-key
 * organization and on a subscription account, reported no drop for either, and dropped both replies' blocks when an
 * earlier user message changed). The store's own fields beside them, such as
 * `toolName`, don't reach the provider on membrane's native path, the only one noted (membrane 0.7.1's XML
 * formatter reads `toolName`, and an XML stream is never noted).
 */
function normalizedResult(block: ContentBlock): unknown {
  if (block.type !== 'tool_result') return block;
  const { toolUseId, content, isError } = block as { toolUseId?: unknown; content?: unknown; isError?: unknown };
  return { type: 'tool_result', toolUseId, content, isError: isError === true };
}
