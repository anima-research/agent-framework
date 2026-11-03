import type { ContentBlock } from '@animalabs/membrane';

/**
 * Stamp signed thinking blocks with the tokens they will cost when replayed.
 *
 * On keep-all models (Opus >= 4.5, Sonnet >= 4.6, Fable/Mythos) every prior
 * assistant thinking block is sent back and billed as INPUT at the size of
 * the full hidden chain of thought — whatever its visible text says (empty
 * under `display: "omitted"`, a short summary under `"summarized"`). The
 * signature encodes that chain but its length is not a reliable measure
 * (2.8–8.7 chars/token measured on Opus 4.8), and the stored block carries
 * no other trace of the size. The response DOES: `usage.output_tokens` is
 * the visible blocks plus the hidden thinking. So at creation, price each
 * carrier block from the residual of this call's output tokens over its
 * visible blocks, split across carriers by signature length, and stamp it
 * as `tokenEstimate` — the field context-manager already prefers over any
 * heuristic for thinking, redacted_thinking and image blocks.
 *
 * Carriers: `thinking` with a non-empty `signature`, `redacted_thinking`
 * with `data`. Blocks that already carry a `tokenEstimate` keep it. When the
 * residual is not positive (no thinking, or the visible estimate over-
 * shoots) nothing is stamped and context-manager's own fallback applies.
 *
 * The visible-block rates mirror context-manager's estimator (prose 2.9,
 * JSON 2.3 chars/token); their precision matters little — on agentic turns
 * the hidden thinking is the bulk of the output, and this stamp is what makes
 * the compiled budget honest (see context-manager `SIGNATURE_CHARS_PER_TOKEN`).
 *
 * Wire safety: the stamp is context-manager's pricing metadata, and no field
 * a provider takes. The Messages API refuses a block that carries it
 * ("Extra inputs are not permitted"), and membrane (0.5.87 and 0.6.0) sends a
 * `redacted_thinking` block to Anthropic and Bedrock with every field it has.
 * So an agent's request builders drop the stamp from the compiled messages
 * (`withoutTokenEstimates`), and the stored block, which context-manager
 * prices, keeps it. The signature itself is copied, never edited.
 */
const PROSE_CHARS_PER_TOKEN = 2.9;
const DENSE_CHARS_PER_TOKEN = 2.3;

function carrierWeight(block: ContentBlock): number {
  if (block.type === 'thinking') {
    const sig = (block as { signature?: unknown }).signature;
    return typeof sig === 'string' ? sig.length : 0;
  }
  if (block.type === 'redacted_thinking') {
    const data = (block as { data?: unknown }).data;
    return typeof data === 'string' ? data.length : 0;
  }
  return 0;
}

function visibleTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return Math.ceil((block.text ?? '').length / PROSE_CHARS_PER_TOKEN);
    case 'tool_use': {
      let json = '';
      try { json = JSON.stringify(block.input ?? {}); } catch { json = ''; }
      return Math.ceil(json.length / DENSE_CHARS_PER_TOKEN) + 20;
    }
    case 'thinking':
      // Unsigned thinking (text-only providers, XML mode): the text is the
      // whole cost and is priced by context-manager as text.
      return carrierWeight(block) > 0 ? 0 : Math.ceil((block.thinking ?? '').length / PROSE_CHARS_PER_TOKEN);
    default:
      return 0;
  }
}

/**
 * Returns a new array; carrier blocks are shallow-copied with `tokenEstimate`
 * set, every other block is the same object.
 */
export function stampThinkingTokenEstimates(blocks: ContentBlock[], outputTokens: number): ContentBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return blocks;

  let totalWeight = 0;
  let visible = 0;
  for (const block of blocks) {
    const already = (block as { tokenEstimate?: unknown }).tokenEstimate;
    const w = typeof already === 'number' ? 0 : carrierWeight(block);
    if (w > 0) totalWeight += w;
    else visible += visibleTokens(block);
    if (typeof already === 'number') visible += already;
  }
  if (totalWeight <= 0) return blocks;
  const residual = outputTokens - visible;
  if (residual <= 0) return blocks;

  return blocks.map((block) => {
    const already = (block as { tokenEstimate?: unknown }).tokenEstimate;
    if (typeof already === 'number') return block;
    const w = carrierWeight(block);
    if (w <= 0) return block;
    const tokenEstimate = Math.max(1, Math.round((residual * w) / totalWeight));
    return { ...block, tokenEstimate } as ContentBlock;
  });
}

/**
 * A request's messages with no top-level block carrying `tokenEstimate`. Both
 * of an agent's request builders call it on the compiled messages: a
 * framework turn's (`Agent.assembleActivationRequest`) and the direct API's
 * (`Agent.runInferenceWithInjections`). A block that carries the stamp is
 * copied without it, and so is the message that holds it. Every other
 * message and block is passed on as it is, and nothing is changed in place,
 * so the stored block keeps its stamp.
 */
export function withoutTokenEstimates<T extends { content: ContentBlock[] }>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.content.some(isStamped)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (!isStamped(block)) return block;
        const { tokenEstimate: _stamp, ...unstamped } = block as ContentBlock & { tokenEstimate?: unknown };
        return unstamped as ContentBlock;
      }),
    };
  });
}

function isStamped(block: ContentBlock): boolean {
  return typeof block === 'object' && block !== null && 'tokenEstimate' in block;
}
