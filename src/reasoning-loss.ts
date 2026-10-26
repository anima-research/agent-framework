import type { ContentBlock } from '@animalabs/membrane';
import type { MessageId, ThinkingStrip } from '@animalabs/context-manager';
import { ThinkingLossIncidents, type PlacedDrop } from './thinking-drops.js';
import {
  reasoningLossNotice,
  type ReasoningLossAnchor,
  type ReasoningLossCause,
} from './reasoning-loss-notice.js';

export interface StoredReplyReader {
  getMessage(id: MessageId): { sequence: number; content: readonly ContentBlock[] } | null;
}

export interface ReasoningLossTurn {
  start?: { branch: string; sequence: number };
}

const HEAD_CAUSES: Partial<Record<NonNullable<ThinkingStrip['changed']>[number], ReasoningLossCause>> = {
  tools: 'tools',
  system: 'system',
  model: 'model',
};

export class ReasoningLossTeller {
  private readonly told = new Map<string, Map<string, Set<MessageId>>>();
  private readonly drops = new ThinkingLossIncidents();

  forStrip(
    agentName: string,
    branch: string,
    strip: ThinkingStrip,
    turn: ReasoningLossTurn,
    store: StoredReplyReader,
  ): string | undefined {
    const told = this.toldFor(agentName, branch);
    const taken = strip.newly
      .map((id) => ({ id, sequence: store.getMessage(id)?.sequence }))
      .sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
    const replies = taken.filter((r) => !told.has(r.id));
    if (replies.length === 0) return undefined;
    const thisTurn = replies.some((r) => isThisTurn(r.sequence, branch, turn));
    if (strip.cause === 'head') {
      const causes = (strip.changed ?? [])
        .map((c) => HEAD_CAUSES[c])
        .filter((c): c is ReasoningLossCause => c !== undefined);
      const newest = taken.filter((r) => r.sequence !== undefined).at(-1);
      const through = newest ? anchorOf(store.getMessage(newest.id)?.content) : undefined;
      const amongThisTurn = taken.some((r) => isThisTurn(r.sequence, branch, turn));
      for (const r of replies) told.add(r.id);
      return reasoningLossNotice({ agentName, scope: { kind: 'all', ...(through ? { through } : {}), thisTurn: amongThisTurn }, causes });
    }
    if (strip.cause !== 'first' && !taken.some((r) => isThisTurn(r.sequence, branch, turn))) return undefined;
    const first = anchorOf(store.getMessage(replies[0]!.id)?.content);
    for (const r of replies) told.add(r.id);
    return reasoningLossNotice({
      agentName,
      scope: { kind: 'some', count: replies.length, ...(first ? { first } : {}), thisTurn },
      causes: [],
    });
  }

  forDrops(
    agentName: string,
    branch: string,
    placed: readonly PlacedDrop[],
    turn: ReasoningLossTurn,
    store: StoredReplyReader,
  ): string | undefined {
    const replies = new Map<MessageId, number>();
    const rounds = new Set<number>();
    let blocks = 0;
    for (const drop of placed) {
      if (drop.kind === 'unplaced') continue;
      blocks++;
      if (drop.kind === 'round') rounds.add(drop.round);
      else for (const body of drop.bodies) replies.set(body.messageId, body.sequence);
    }
    const unplaced = blocks < placed.length;
    const count = replies.size + rounds.size;
    const ordered = [...replies].sort((a, b) => a[1] - b[1]);
    const thisTurn = rounds.size > 0 || ordered.some(([, sequence]) => isThisTurn(sequence, branch, turn));
    const first = ordered.length > 0 && !unplaced ? anchorOf(store.getMessage(ordered[0]![0])?.content) : undefined;
    if (this.drops.observe(agentName, blocks, branch) === undefined) return undefined;
    const told = this.toldFor(agentName, branch);
    for (const id of replies.keys()) told.add(id);
    return reasoningLossNotice({
      agentName,
      scope: { kind: 'some', count, ...(first ? { first } : {}), ...(unplaced ? { unplaced: true } : {}), thisTurn },
      causes: [],
    });
  }

  forget(agentName: string): void {
    this.told.delete(agentName);
    this.drops.forget(agentName);
  }

  private toldFor(agentName: string, branch: string): Set<MessageId> {
    let branches = this.told.get(agentName);
    if (!branches) this.told.set(agentName, (branches = new Map()));
    let told = branches.get(branch);
    if (!told) branches.set(branch, (told = new Set()));
    return told;
  }
}

function isThisTurn(sequence: number | undefined, branch: string, turn: ReasoningLossTurn): boolean {
  return sequence !== undefined && turn.start?.branch === branch && sequence > turn.start.sequence;
}

function anchorOf(content: readonly ContentBlock[] | undefined): ReasoningLossAnchor | undefined {
  if (!content) return undefined;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return { text: block.text };
  }
  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name !== '') return { toolCall: block.name };
  }
  return undefined;
}
