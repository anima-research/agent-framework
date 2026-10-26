import { safeSlice } from './safe-slice.js';

export type ReasoningLossCause = 'tools' | 'system' | 'model';

export type ReasoningLossAnchor = { text: string } | { toolCall: string };

export interface ReasoningLossNoticeInput {
  agentName: string;
  scope:
    | { kind: 'all'; through?: ReasoningLossAnchor; thisTurn: boolean }
    | { kind: 'some'; count: number; first?: ReasoningLossAnchor; unplaced?: boolean; thisTurn: boolean };
  causes: readonly ReasoningLossCause[];
}

const ANCHOR_CHARS = 80;

const CAUSE_WORDS: Record<ReasoningLossCause, string> = {
  tools: 'your tools changed',
  system: 'your system prompt changed',
  model: 'your model changed',
};
const CAUSE_ORDER: readonly ReasoningLossCause[] = ['tools', 'system', 'model'];

export function reasoningLossNotice(input: ReasoningLossNoticeInput): string {
  const causes = CAUSE_ORDER.filter((c) => input.causes.includes(c)).map((c) => CAUSE_WORDS[c]);
  const because = causes.length > 0 ? `, because ${joinAnd(causes)}` : '';
  const scope = input.scope;
  let lost: string;
  let reread: string;
  if (scope.kind === 'all') {
    const through = scope.through ? anchorWords(scope.through) : undefined;
    const among = scope.thisTurn ? ", this turn's earlier steps among them," : '';
    lost = through
      ? `The reasoning behind your replies up to the one ${through}${among} is no longer in your context${because}.`
      : `The reasoning behind your earlier replies${among} is no longer in your context${because}.`;
    reread = 'Re-read before relying on an earlier decision.';
  } else {
    const one = scope.count === 1 && !scope.unplaced;
    const replies = scope.unplaced
      ? `at least ${scope.count} of your replies`
      : one ? 'one of your replies' : `${scope.count} of your replies`;
    const named = scope.first && !scope.unplaced ? anchorWords(scope.first) : undefined;
    const first = named ? (one ? `, the one ${named}` : `, the first being the one ${named}`) : '';
    const among = scope.thisTurn ? (one ? ', an earlier step of this turn' : ", this turn's earlier steps among them") : '';
    lost = `Some of your earlier reasoning is no longer in your context: the reasoning behind ${replies}${first}${among}${because}.`;
    reread = named ? 'Re-read before relying on a decision made since then.' : 'Re-read before relying on an earlier decision.';
  }
  return `[reasoning] ${input.agentName}: ${lost} Their words are still here. ${reread}`;
}

function anchorWords(anchor: ReasoningLossAnchor): string | undefined {
  if ('toolCall' in anchor) return anchor.toolCall ? `that called \`${anchor.toolCall}\`` : undefined;
  const text = anchor.text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const clipped = text.length > ANCHOR_CHARS ? `${safeSlice(text, 0, ANCHOR_CHARS).trimEnd()}…` : text;
  return `beginning "${clipped}"`;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
